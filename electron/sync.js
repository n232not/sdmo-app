const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const crypto = require('crypto')
const { getDb, backupDb } = require('./db')
const { getSettings, getProjectName, getOrCreateUUID } = require('./settings')

// Bump when the split-config file format changes in a backward-incompatible way.
// buildConfigExport stamps this; readers refuse configs newer than they understand.
const CONFIG_FORMAT_VERSION = 4

function assertConfigCompatible(configData) {
  const fmt = configData?.version || 1
  if (fmt > CONFIG_FORMAT_VERSION) {
    throw new Error(`This project was created by a newer version of SDMo (config format v${fmt}, this app supports v${CONFIG_FORMAT_VERSION}). Please update the app.`)
  }
}

const timers = {}
const lastSyncAt = {}

// ─── Per-project sync mutex ─────────────────────────────────────────────────────
// Prevents two syncs for the same project from interleaving (which could drop
// tombstones or double-write config). If a sync is requested while one is running,
// the latest request is queued and run once after the current finishes, so the
// newest local state still gets flushed.
const syncing = {}     // projectId -> in-flight Promise
const syncQueued = {}  // projectId -> thunk to run after the current one

function runExclusiveSync(projectId, thunk) {
  if (syncing[projectId]) {
    syncQueued[projectId] = thunk // keep only the latest queued request
    return syncing[projectId]
  }
  const p = (async () => {
    try {
      await thunk()
    } finally {
      syncing[projectId] = null
      const next = syncQueued[projectId]
      if (next) {
        syncQueued[projectId] = null
        await runExclusiveSync(projectId, next)
      }
    }
  })()
  syncing[projectId] = p
  return p
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str) } catch { return fallback }
}

// ─── Main window reference (set by main.js so we can push events to renderer) ─
let _mainWindow = null
function setMainWindow(win) { _mainWindow = win }

// ─── Debounced auto-sync ──────────────────────────────────────────────────────

function scheduleSync(projectId) {
  if (timers[projectId]) clearTimeout(timers[projectId])
  timers[projectId] = setTimeout(async () => {
    const db = getDb()
    const project = db.prepare('SELECT sync_folder, cloud_provider, cloud_folder_id FROM projects WHERE id=?').get(projectId)
    const uuid = getOrCreateUUID()
    const name = getProjectName(projectId) || uuid

    try {
      if (project?.sync_folder) {
        await doLocalSync(db, projectId, project.sync_folder, uuid, name)
      } else if (project?.cloud_provider && project?.cloud_folder_id) {
        await doCloudSync(db, projectId, project.cloud_provider, project.cloud_folder_id, uuid, name)
      }
    } catch (e) {
      console.error('[sync] auto-sync failed:', e.message)
    }
  }, 2000)
}

function scheduleSyncForReview(reviewId) {
  const db = getDb()
  try {
    const rev = db.prepare('SELECT media_file_id FROM reviews WHERE id=?').get(reviewId)
    if (!rev) return
    const mf = db.prepare('SELECT encounter_id FROM media_files WHERE id=?').get(rev.media_file_id)
    if (!mf) return
    const enc = db.prepare('SELECT project_id FROM encounters WHERE id=?').get(mf.encounter_id)
    if (enc?.project_id) scheduleSync(enc.project_id)
  } catch (e) {
    console.error('[sync] scheduleSyncForReview failed:', e.message)
  }
}

// ─── Config version ───────────────────────────────────────────────────────────

function bumpConfigVersion(db, projectId) {
  db.prepare("UPDATE projects SET config_version = config_version + 1, updated_at = datetime('now') WHERE id=?").run(projectId)
}

function bumpAndSync(db, projectId) {
  bumpConfigVersion(db, projectId)
  scheduleSync(projectId)
}

// ─── Split-file builders ──────────────────────────────────────────────────────

function buildConfigExport(db, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)
  const keybinds = safeJsonParse(project.keybinds, [])

  const forms = db.prepare('SELECT * FROM forms WHERE project_id=?').all(projectId).map(f => ({
    name: f.name,
    schema: JSON.parse(f.schema || '{"sections":[]}'),
  }))

  const instructions = db.prepare('SELECT * FROM instructions WHERE project_id=?').all(projectId).map(i => {
    let pdf_data = null
    if (i.content_type === 'pdf' && i.file_path) {
      try { pdf_data = fs.readFileSync(i.file_path).toString('base64') } catch (_) {}
    }
    return { name: i.name, content_type: i.content_type || 'markdown', content: i.content || '', pdf_data }
  })

  const formNames = Object.fromEntries(
    db.prepare('SELECT id, name FROM forms WHERE project_id=?').all(projectId).map(f => [f.id, f.name])
  )
  const instructionNames = Object.fromEntries(
    db.prepare('SELECT id, name FROM instructions WHERE project_id=?').all(projectId).map(i => [i.id, i.name])
  )

  const mediaTypes = db.prepare('SELECT * FROM media_types WHERE project_id=?').all(projectId).map(mt => {
    const tags = db.prepare('SELECT * FROM timestamp_tags WHERE media_type_id=?').all(mt.id)
    const rawTabs = db.prepare('SELECT * FROM workspace_tabs WHERE media_type_id=? ORDER BY sort_order').all(mt.id)
    const tabs = rawTabs.map(tab => {
      let refName = null
      if (tab.tab_type === 'form') refName = formNames[tab.ref_id] || null
      else if (tab.tab_type === 'instruction') refName = instructionNames[tab.ref_id] || null
      return { tab_type: tab.tab_type, ref_name: refName, label: tab.label, sort_order: tab.sort_order }
    })
    return {
      name: mt.name,
      reviews_required: mt.reviews_required,
      allow_custom_tags: mt.allow_custom_tags,
      color: mt.color,
      tags: tags.map(t => ({ label: t.label, color: t.color, description: t.description })),
      workspace_tabs: tabs,
    }
  })

  // Encounters included as schema only (no reviews)
  const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=?').all(projectId).map(enc => {
    const mediaFiles = db.prepare(`
      SELECT mf.*, mt.name as media_type_name
      FROM media_files mf
      LEFT JOIN media_types mt ON mf.media_type_id = mt.id
      WHERE mf.encounter_id=?
    `).all(enc.id)
    return {
      sync_id: enc.sync_id,
      name: enc.name,
      media: mediaFiles.map(m => ({ sync_id: m.sync_id, name: m.name, file_type: m.file_type, media_type_name: m.media_type_name || null })),
    }
  })

  return {
    sdmo: true,
    version: CONFIG_FORMAT_VERSION,
    config_version: project.config_version || 1,
    exported_at: new Date().toISOString(),
    project: {
      name: project.name,
      description: project.description,
      owner_password_hash: project.owner_password_hash || null,
      keybinds,
    },
    forms,
    instructions,
    media_types: mediaTypes,
    encounters,
  }
}

function buildReviewExport(db, projectId, reviewerUuid, reviewerName) {
  const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=?').all(projectId)
  const reviews = []

  for (const enc of encounters) {
    const mediaFiles = db.prepare('SELECT * FROM media_files WHERE encounter_id=?').all(enc.id)
    for (const m of mediaFiles) {
      const revRows = db.prepare(
        'SELECT * FROM reviews WHERE media_file_id=? AND (reviewer_uuid=? OR (reviewer_uuid IS NULL AND reviewer_name=?)) AND deleted_at IS NULL'
      ).all(m.id, reviewerUuid, reviewerName)

      for (const rev of revRows) {
        const timestamps = db.prepare('SELECT * FROM timestamps WHERE review_id=? ORDER BY time_seconds').all(rev.id)
          .map(ts => ({
            time_seconds: ts.time_seconds,
            tag_label: ts.tag_label || null,
            tag_color: ts.tag_color || null,
            notes: ts.notes,
            created_at: ts.created_at,
          }))

        const formResponses = db.prepare(
          'SELECT fr.*, f.name as form_name FROM form_responses fr JOIN forms f ON fr.form_id = f.id WHERE fr.review_id=?'
        ).all(rev.id).map(fr => ({ form_name: fr.form_name, responses: fr.responses }))

        reviews.push({
          review_sync_id: rev.review_sync_id || null,
          encounter_sync_id: enc.sync_id || null,
          encounter_name: enc.name,
          media_sync_id: m.sync_id || null,
          media_name: m.name,
          status: rev.status,
          notes: rev.notes,
          created_at: rev.created_at,
          submitted_at: rev.submitted_at,
          timestamps,
          form_responses: formResponses,
        })
      }
    }
  }

  return {
    sdmo_reviews: true,
    version: 1,
    reviewer_uuid: reviewerUuid,
    reviewer_name: reviewerName,
    exported_at: new Date().toISOString(),
    reviews,
  }
}

// ─── Shared config apply transaction ─────────────────────────────────────────
// Single authoritative implementation used by mergeConfigImport and replaceStructureFromConfig.
// Adding a new synced entity means updating this one function only.

function _applyConfigTransaction(db, projectId, configData) {
  const incomingVersion = configData.config_version || 1

  const tx = db.transaction(() => {
    if (configData.project) {
      const kbJson = JSON.stringify(configData.project.keybinds || [])
      const incomingHash = configData.project.owner_password_hash || null
      // Never silently clear an existing password with a null from a stale config file
      const localHash = db.prepare('SELECT owner_password_hash FROM projects WHERE id=?').get(projectId)?.owner_password_hash || null
      const hashToUse = incomingHash || localHash
      db.prepare("UPDATE projects SET name=?, description=?, owner_password_hash=?, keybinds=?, config_version=?, updated_at=datetime('now') WHERE id=?")
        .run(configData.project.name || '', configData.project.description || '', hashToUse, kbJson, incomingVersion, projectId)
    }

    for (const f of (configData.forms || [])) {
      const schema = typeof f.schema === 'string' ? f.schema : JSON.stringify(f.schema)
      const existing = db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, f.name)
      if (existing) {
        db.prepare("UPDATE forms SET schema=?, updated_at=datetime('now') WHERE id=?").run(schema, existing.id)
      } else {
        db.prepare('INSERT INTO forms (project_id, name, schema) VALUES (?,?,?)').run(projectId, f.name, schema)
      }
    }

    for (const i of (configData.instructions || [])) {
      let filePath = null
      if (i.content_type === 'pdf' && i.pdf_data) {
        const destDir = path.join(app.getPath('userData'), 'projects', String(projectId))
        fs.mkdirSync(destDir, { recursive: true })
        const existingFile = db.prepare('SELECT file_path FROM instructions WHERE project_id=? AND name=?').get(projectId, i.name)
        filePath = existingFile?.file_path || path.join(destDir, `${Date.now()}-${i.name}.pdf`)
        fs.writeFileSync(filePath, Buffer.from(i.pdf_data, 'base64'))
      }
      const existing = db.prepare('SELECT id FROM instructions WHERE project_id=? AND name=?').get(projectId, i.name)
      if (existing) {
        db.prepare('UPDATE instructions SET content=?, content_type=?, file_path=? WHERE id=?')
          .run(i.content || '', i.content_type || 'markdown', filePath, existing.id)
      } else {
        db.prepare('INSERT INTO instructions (project_id, name, content, content_type, file_path) VALUES (?,?,?,?,?)')
          .run(projectId, i.name, i.content || '', i.content_type || 'markdown', filePath)
      }
    }

    for (const mt of (configData.media_types || [])) {
      let mtId
      const existing = db.prepare('SELECT id FROM media_types WHERE project_id=? AND name=?').get(projectId, mt.name)
      if (existing) {
        db.prepare('UPDATE media_types SET reviews_required=?, allow_custom_tags=?, color=? WHERE id=?')
          .run(mt.reviews_required, mt.allow_custom_tags ? 1 : 0, mt.color, existing.id)
        mtId = existing.id
      } else {
        const r = db.prepare('INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color) VALUES (?,?,?,?,?)')
          .run(projectId, mt.name, mt.reviews_required || 1, mt.allow_custom_tags ? 1 : 0, mt.color || '#6366f1')
        mtId = r.lastInsertRowid
      }
      db.prepare('DELETE FROM timestamp_tags WHERE media_type_id=?').run(mtId)
      for (const tag of (mt.tags || [])) {
        db.prepare('INSERT INTO timestamp_tags (media_type_id, label, color, description) VALUES (?,?,?,?)').run(mtId, tag.label, tag.color || '#6366f1', tag.description || '')
      }
      db.prepare('DELETE FROM workspace_tabs WHERE media_type_id=?').run(mtId)
      for (let i = 0; i < (mt.workspace_tabs || []).length; i++) {
        const tab = mt.workspace_tabs[i]
        let refId = null
        if (tab.tab_type === 'form' && tab.ref_name) {
          refId = db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, tab.ref_name)?.id || null
        } else if (tab.tab_type === 'instruction' && tab.ref_name) {
          refId = db.prepare('SELECT id FROM instructions WHERE project_id=? AND name=?').get(projectId, tab.ref_name)?.id || null
        }
        if (refId != null) {
          db.prepare('INSERT INTO workspace_tabs (media_type_id, tab_type, ref_id, label, sort_order) VALUES (?,?,?,?,?)').run(mtId, tab.tab_type, refId, tab.label, i)
        }
      }
    }

    // Ensure encounter/media stubs exist (config is authoritative source for structure)
    for (const enc of (configData.encounters || [])) {
      let localEnc = enc.sync_id
        ? db.prepare('SELECT id FROM encounters WHERE project_id=? AND sync_id=?').get(projectId, enc.sync_id)
        : null
      if (!localEnc) {
        localEnc = db.prepare('SELECT id FROM encounters WHERE project_id=? AND name=?').get(projectId, enc.name)
      }
      if (localEnc) {
        db.prepare('UPDATE encounters SET name=?, sync_id=COALESCE(?,sync_id) WHERE id=?')
          .run(enc.name, enc.sync_id || null, localEnc.id)
      } else {
        const r = db.prepare("INSERT INTO encounters (project_id, name, folder_path, sync_id) VALUES (?,?,?,?)")
          .run(projectId, enc.name, '', enc.sync_id || crypto.randomUUID())
        localEnc = { id: r.lastInsertRowid }
      }
      for (const media of (enc.media || [])) {
        // Search globally by sync_id (handles moves — file may be under different encounter locally)
        let localMedia = media.sync_id
          ? db.prepare('SELECT id FROM media_files WHERE sync_id=?').get(media.sync_id)
          : null
        if (!localMedia) {
          localMedia = db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND name=?').get(localEnc.id, media.name)
        }
        const mt = media.media_type_name
          ? db.prepare('SELECT id FROM media_types WHERE project_id=? AND name=?').get(projectId, media.media_type_name)
          : null
        if (!localMedia) {
          db.prepare("INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id) VALUES (?,?,?,?,?,?)")
            .run(localEnc.id, media.name, '', media.file_type || 'video', mt?.id || null, media.sync_id || crypto.randomUUID())
        } else {
          // Update handles: moves (encounter_id), renames (name), media type, sync_id backfill
          db.prepare('UPDATE media_files SET encounter_id=?, name=?, media_type_id=?, sync_id=COALESCE(?,sync_id) WHERE id=?')
            .run(localEnc.id, media.name, mt?.id || null, media.sync_id || null, localMedia.id)
        }
      }
    }

    // Config is authoritative for structure — remove local encounters/files not in the config.
    // FK cascade (encounters → media_files → reviews → timestamps/form_responses) handles cleanup.
    const configSyncIds = (configData.encounters || []).map(e => e.sync_id).filter(Boolean)
    const configNames = (configData.encounters || []).map(e => e.name)
    const localEncs = db.prepare('SELECT id, sync_id, name FROM encounters WHERE project_id=?').all(projectId)
    for (const localEnc of localEncs) {
      const inConfig = localEnc.sync_id
        ? configSyncIds.includes(localEnc.sync_id)
        : configNames.includes(localEnc.name)
      if (!inConfig) {
        // Never let an authoritative-config prune cascade-delete reviewer work.
        // If any review (even soft-deleted) exists under this encounter, keep it.
        const reviewCount = db.prepare(`
          SELECT COUNT(*) AS n FROM reviews r
          JOIN media_files mf ON r.media_file_id = mf.id
          WHERE mf.encounter_id = ?
        `).get(localEnc.id).n
        if (reviewCount > 0) {
          console.warn(`[sync] keeping encounter "${localEnc.name}" (#${localEnc.id}) absent from config — has ${reviewCount} review(s); refusing to destroy data`)
          continue
        }
        db.prepare('DELETE FROM encounters WHERE id=?').run(localEnc.id)
      }
    }

    const configMediaSyncIds = (configData.encounters || []).flatMap(e => (e.media || []).map(m => m.sync_id)).filter(Boolean)
    const remainingFiles = db.prepare(`
      SELECT mf.id, mf.sync_id, mf.name, e.name as enc_name FROM media_files mf
      JOIN encounters e ON mf.encounter_id = e.id WHERE e.project_id=?
    `).all(projectId)
    for (const f of remainingFiles) {
      const encInConfig = (configData.encounters || []).find(e => e.name === f.enc_name || configSyncIds.includes(f.sync_id))
      if (!encInConfig) continue
      const mediaInConfig = f.sync_id
        ? configMediaSyncIds.includes(f.sync_id)
        : (encInConfig.media || []).some(m => m.name === f.name)
      if (!mediaInConfig) {
        const reviewCount = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE media_file_id=?').get(f.id).n
        if (reviewCount > 0) {
          console.warn(`[sync] keeping media "${f.name}" (#${f.id}) absent from config — has ${reviewCount} review(s); refusing to destroy data`)
          continue
        }
        db.prepare('DELETE FROM media_files WHERE id=?').run(f.id)
      }
    }
  })
  tx()
}

// ─── Split-file mergers ───────────────────────────────────────────────────────

function mergeConfigImport(db, projectId, configData, { force } = {}) {
  if (!configData?.sdmo) throw new Error('Not a valid SDMo config file')
  assertConfigCompatible(configData)

  const local = db.prepare('SELECT config_version FROM projects WHERE id=?').get(projectId)
  const incomingVersion = configData.config_version || 1

  if (incomingVersion > (local?.config_version || 1) && !force) {
    return { needsConfigPrompt: true, configData, incomingVersion }
  }

  _applyConfigTransaction(db, projectId, configData)
  return { applied: true }
}

function mergeReviewFile(db, projectId, reviewData, ownUuid) {
  if (!reviewData?.sdmo_reviews) return
  // Never overwrite our own reviews from a stale file in the sync folder
  if (ownUuid && reviewData.reviewer_uuid === ownUuid) return

  const tx = db.transaction(() => {
    for (const rev of (reviewData.reviews || [])) {
      // Prefer sync_id lookup (survives renames/moves), fall back to name
      let localEnc = rev.encounter_sync_id
        ? db.prepare('SELECT id FROM encounters WHERE project_id=? AND sync_id=?').get(projectId, rev.encounter_sync_id)
        : null
      if (!localEnc) localEnc = db.prepare('SELECT id FROM encounters WHERE project_id=? AND name=?').get(projectId, rev.encounter_name)
      if (!localEnc) continue

      let localMedia = rev.media_sync_id
        ? db.prepare('SELECT id FROM media_files WHERE sync_id=?').get(rev.media_sync_id)
        : null
      if (!localMedia) localMedia = db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND name=?').get(localEnc.id, rev.media_name)
      if (!localMedia) continue

      // Match by review_sync_id (most precise), then fall back to uuid+created_at, then name+created_at
      let existing = rev.review_sync_id
        ? db.prepare('SELECT id, status FROM reviews WHERE review_sync_id=?').get(rev.review_sync_id)
        : null
      if (!existing && reviewData.reviewer_uuid) {
        existing = db.prepare('SELECT id, status FROM reviews WHERE media_file_id=? AND reviewer_uuid=? AND created_at=?').get(localMedia.id, reviewData.reviewer_uuid, rev.created_at)
      }
      if (!existing) {
        existing = db.prepare('SELECT id, status FROM reviews WHERE media_file_id=? AND reviewer_name=? AND created_at=? AND deleted_at IS NULL').get(localMedia.id, reviewData.reviewer_name, rev.created_at)
      }

      const mediaFile = db.prepare('SELECT media_type_id FROM media_files WHERE id=?').get(localMedia.id)
      const localTags = mediaFile?.media_type_id
        ? db.prepare('SELECT * FROM timestamp_tags WHERE media_type_id=?').all(mediaFile.media_type_id)
        : []

      const insertTimestamps = (reviewId) => {
        for (const ts of (rev.timestamps || [])) {
          const tag = ts.tag_label ? localTags.find(t => t.label === ts.tag_label) : null
          db.prepare('INSERT INTO timestamps (review_id, time_seconds, tag_id, tag_label, notes, tag_color, created_at) VALUES (?,?,?,?,?,?,?)')
            .run(reviewId, ts.time_seconds, tag?.id || null, ts.tag_label || null, ts.notes || '', ts.tag_color || tag?.color || null, ts.created_at)
        }
      }

      const insertFormResponses = (reviewId) => {
        for (const fr of (rev.form_responses || [])) {
          const form = fr.form_name ? db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, fr.form_name) : null
          if (!form) continue
          db.prepare('INSERT INTO form_responses (review_id, form_id, responses) VALUES (?,?,?)').run(reviewId, form.id, fr.responses)
        }
      }

      if (existing) {
        // The file is the single authoritative source for this UUID's reviews — always replace
        db.prepare("UPDATE reviews SET status=?, notes=?, reviewer_uuid=?, submitted_at=? WHERE id=?")
          .run(rev.status, rev.notes || '', reviewData.reviewer_uuid || null, rev.submitted_at, existing.id)
        db.prepare('DELETE FROM timestamps WHERE review_id=?').run(existing.id)
        db.prepare('DELETE FROM form_responses WHERE review_id=?').run(existing.id)
        insertTimestamps(existing.id)
        insertFormResponses(existing.id)
        continue
      }

      const r = db.prepare('INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id, status, notes, created_at, submitted_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(localMedia.id, reviewData.reviewer_name, reviewData.reviewer_uuid || null, rev.review_sync_id || crypto.randomUUID(), rev.status, rev.notes || '', rev.created_at, rev.submitted_at)
      insertTimestamps(r.lastInsertRowid)
      insertFormResponses(r.lastInsertRowid)
    }
  })
  tx()
}

// ─── Tombstone helpers ────────────────────────────────────────────────────────

function readTombstoneFile(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(data.tombstones) ? data.tombstones : []
  } catch { return [] }
}

function applyTombstones(db, projectId, tombstones) {
  for (const del of tombstones) {
    let rev
    if (del.review_sync_id) {
      // Precise: target the exact review by its own UUID
      rev = db.prepare('SELECT id FROM reviews WHERE review_sync_id=? AND deleted_at IS NULL').get(del.review_sync_id)
    } else {
      // Legacy fallback: match by name
      const localEnc = db.prepare('SELECT id FROM encounters WHERE project_id=? AND name=?').get(projectId, del.encounter_name)
      if (!localEnc) continue
      const localMedia = db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND name=?').get(localEnc.id, del.media_name)
      if (!localMedia) continue
      rev = db.prepare('SELECT id FROM reviews WHERE media_file_id=? AND reviewer_name=? AND deleted_at IS NULL').get(localMedia.id, del.reviewer_name)
    }
    if (rev) db.prepare("UPDATE reviews SET deleted_at=datetime('now') WHERE id=?").run(rev.id)
    db.prepare('INSERT OR IGNORE INTO deleted_reviews (project_id, encounter_name, media_name, reviewer_name, review_sync_id) VALUES (?,?,?,?,?)')
      .run(projectId, del.encounter_name, del.media_name, del.reviewer_name, del.review_sync_id || null)
  }
}

function buildTombstones(db, projectId) {
  return db.prepare('SELECT encounter_name, media_name, reviewer_name, review_sync_id, deleted_at FROM deleted_reviews WHERE project_id=?').all(projectId)
}

// ─── Manifest helpers (tiny file for cheap polling) ───────────────────────────

function buildManifest(db, projectId) {
  const project = db.prepare('SELECT config_version FROM projects WHERE id=?').get(projectId)
  return { config_version: project?.config_version || 1, updated_at: new Date().toISOString() }
}

function readLocalManifest(syncFolder) {
  try { return JSON.parse(fs.readFileSync(path.join(syncFolder, 'manifest.json'), 'utf8')) } catch { return null }
}

// ─── Cloud-authoritative structure replacement ────────────────────────────────

function replaceStructureFromConfig(db, projectId, configData) {
  if (!configData?.sdmo) throw new Error('Not a valid SDMo config file')
  assertConfigCompatible(configData)
  // This is the authoritative-prune path (can remove structure). Snapshot first.
  backupDb('pre-config-apply')
  _applyConfigTransaction(db, projectId, configData)
}

// ─── Config sync helpers (used by both do*Sync and fetchStructure) ────────────

function syncConfigLocal(db, projectId, syncFolder) {
  const localVersion = db.prepare('SELECT config_version FROM projects WHERE id=?').get(projectId)?.config_version || 0
  const manifest = readLocalManifest(syncFolder)
  const folderVersion = manifest?.config_version || 0
  const configPath = path.join(syncFolder, 'project-config.json')

  if (folderVersion > localVersion) {
    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if ((configData.config_version || 0) > localVersion) {
        replaceStructureFromConfig(db, projectId, configData)
      }
    }
  } else if (localVersion > folderVersion) {
    const configData = buildConfigExport(db, projectId)
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2))
    fs.writeFileSync(path.join(syncFolder, 'manifest.json'), JSON.stringify(buildManifest(db, projectId)))
  }
}

async function syncConfigCloud(db, projectId, adapter, folderId, allFiles) {
  const localVersion = db.prepare('SELECT config_version FROM projects WHERE id=?').get(projectId)?.config_version || 0
  const manifestFile = allFiles.find(f => f.name === 'manifest.json')
  let cloudVersion = 0
  if (manifestFile) {
    try { cloudVersion = JSON.parse(await adapter.readFile(manifestFile.id)).config_version || 0 } catch {}
  }

  if (cloudVersion > localVersion) {
    const configFile = allFiles.find(f => f.name === 'project-config.json')
    if (configFile) {
      const configData = JSON.parse(await adapter.readFile(configFile.id))
      if ((configData.config_version || 0) > localVersion) {
        replaceStructureFromConfig(db, projectId, configData)
      }
    }
  } else if (localVersion > cloudVersion) {
    const configData = buildConfigExport(db, projectId)
    await adapter.writeFile(folderId, 'project-config.json', JSON.stringify(configData, null, 2))
    await adapter.writeFile(folderId, 'manifest.json', JSON.stringify(buildManifest(db, projectId)))
  }
}

// ─── Local folder sync ────────────────────────────────────────────────────────

function doLocalSync(db, projectId, syncFolder, uuid, name) {
  return runExclusiveSync(projectId, () => _doLocalSync(db, projectId, syncFolder, uuid, name))
}

async function _doLocalSync(db, projectId, syncFolder, uuid, name) {
  fs.mkdirSync(path.join(syncFolder, 'reviews'), { recursive: true })

  // 1. Tombstones
  const tombstonePath = path.join(syncFolder, 'deleted-reviews.json')
  const fileTombstones = readTombstoneFile(tombstonePath)
  applyTombstones(db, projectId, fileTombstones)
  const allTombstones = buildTombstones(db, projectId)
  const mergedTombstones = [...fileTombstones]
  for (const t of allTombstones) {
    if (!mergedTombstones.find(x => x.encounter_name === t.encounter_name && x.media_name === t.media_name && x.reviewer_name === t.reviewer_name)) {
      mergedTombstones.push(t)
    }
  }

  // 2. Config
  try {
    syncConfigLocal(db, projectId, syncFolder)
  } catch (e) {
    console.error('[sync] config sync failed:', e.message)
  }

  // 3. Peer reviews
  const reviewsDir = path.join(syncFolder, 'reviews')
  const reviewFiles = fs.readdirSync(reviewsDir).filter(f => f.endsWith('.json') && f !== `${uuid}.json`)
  for (const file of reviewFiles) {
    try {
      const reviewData = JSON.parse(fs.readFileSync(path.join(reviewsDir, file), 'utf8'))
      mergeReviewFile(db, projectId, reviewData, uuid)
    } catch (e) {
      console.error(`[sync] failed to merge review file ${file}:`, e.message)
    }
  }

  // 4. Write own review file
  const ownReviews = buildReviewExport(db, projectId, uuid, name)
  fs.writeFileSync(path.join(reviewsDir, `${uuid}.json`), JSON.stringify(ownReviews, null, 2))

  // 5. Write merged tombstones
  fs.writeFileSync(tombstonePath, JSON.stringify({ tombstones: mergedTombstones }, null, 2))

  markSynced(projectId)
}

// ─── Cloud sync ───────────────────────────────────────────────────────────────

function doCloudSync(db, projectId, provider, folderId, uuid, name) {
  return runExclusiveSync(projectId, () => _doCloudSync(db, projectId, provider, folderId, uuid, name))
}

async function _doCloudSync(db, projectId, provider, folderId, uuid, name) {
  const { getAdapter } = require('./cloud/cloudSync')
  const adapter = getAdapter(provider)

  // Ensure reviews subfolder exists; list root folder files once for all lookups
  const [reviewsFolderId, allFiles] = await Promise.all([
    adapter.ensureFolder(folderId, 'reviews'),
    adapter.listFiles(folderId),
  ])

  // 1. Tombstones
  const tombstoneFile = allFiles.find(f => f.name === 'deleted-reviews.json')
  let fileTombstones = []
  if (tombstoneFile) {
    try {
      const data = JSON.parse(await adapter.readFile(tombstoneFile.id))
      fileTombstones = Array.isArray(data.tombstones) ? data.tombstones : []
    } catch {}
  }
  applyTombstones(db, projectId, fileTombstones)
  const allTombstones = buildTombstones(db, projectId)
  const mergedTombstones = [...fileTombstones]
  for (const t of allTombstones) {
    if (!mergedTombstones.find(x => x.encounter_name === t.encounter_name && x.media_name === t.media_name && x.reviewer_name === t.reviewer_name)) {
      mergedTombstones.push(t)
    }
  }

  // 2. Config
  try {
    await syncConfigCloud(db, projectId, adapter, folderId, allFiles)
  } catch (e) {
    console.error('[sync] cloud config sync failed:', e.message)
  }

  // 3. Peer reviews
  const reviewFileList = await adapter.listFiles(reviewsFolderId)
  for (const file of reviewFileList) {
    if (!file.name.endsWith('.json') || file.name === `${uuid}.json`) continue
    try {
      const reviewData = JSON.parse(await adapter.readFile(file.id))
      mergeReviewFile(db, projectId, reviewData, uuid)
    } catch (e) {
      console.error(`[sync] failed to merge cloud review file ${file.name}:`, e.message)
    }
  }

  // 4. Write own review file
  const ownReviews = buildReviewExport(db, projectId, uuid, name)
  await adapter.writeFile(reviewsFolderId, `${uuid}.json`, JSON.stringify(ownReviews, null, 2))

  // 5. Write tombstones
  await adapter.writeFile(folderId, 'deleted-reviews.json', JSON.stringify({ tombstones: mergedTombstones }, null, 2))

  markSynced(projectId)
}

// ─── Legacy monolithic export/import (kept for Export/Import file flow) ───────

function buildExport(db, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)
  const keybinds = safeJsonParse(project.keybinds, [])

  const forms = db.prepare('SELECT * FROM forms WHERE project_id=?').all(projectId).map(f => ({
    name: f.name,
    schema: JSON.parse(f.schema || '{"sections":[]}'),
  }))

  const instructions = db.prepare('SELECT * FROM instructions WHERE project_id=?').all(projectId).map(i => {
    let pdf_data = null
    if (i.content_type === 'pdf' && i.file_path) {
      try { pdf_data = fs.readFileSync(i.file_path).toString('base64') } catch (_) {}
    }
    return { name: i.name, content_type: i.content_type || 'markdown', content: i.content || '', pdf_data }
  })

  const mediaTypes = db.prepare('SELECT * FROM media_types WHERE project_id=?').all(projectId).map(mt => {
    const tags = db.prepare('SELECT * FROM timestamp_tags WHERE media_type_id=?').all(mt.id)
    const rawTabs = db.prepare('SELECT * FROM workspace_tabs WHERE media_type_id=? ORDER BY sort_order').all(mt.id)
    const tabs = rawTabs.map(tab => {
      let refName = null
      if (tab.tab_type === 'form') refName = db.prepare('SELECT name FROM forms WHERE id=?').get(tab.ref_id)?.name || null
      else if (tab.tab_type === 'instruction') refName = db.prepare('SELECT name FROM instructions WHERE id=?').get(tab.ref_id)?.name || null
      return { tab_type: tab.tab_type, ref_name: refName, label: tab.label, sort_order: tab.sort_order }
    })
    return {
      name: mt.name, reviews_required: mt.reviews_required, allow_custom_tags: mt.allow_custom_tags, color: mt.color,
      tags: tags.map(t => ({ label: t.label, color: t.color, description: t.description })),
      workspace_tabs: tabs,
    }
  })

  const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=?').all(projectId).map(enc => {
    const mediaFiles = db.prepare(`
      SELECT mf.*, mt.name as media_type_name FROM media_files mf
      LEFT JOIN media_types mt ON mf.media_type_id = mt.id WHERE mf.encounter_id=?
    `).all(enc.id)
    return {
      sync_id: enc.sync_id,
      name: enc.name,
      media: mediaFiles.map(m => {
        const reviews = db.prepare('SELECT * FROM reviews WHERE media_file_id=? AND deleted_at IS NULL').all(m.id).map(rev => {
          const timestamps = db.prepare('SELECT * FROM timestamps WHERE review_id=? ORDER BY time_seconds').all(rev.id)
            .map(ts => ({ time_seconds: ts.time_seconds, tag_label: ts.tag_label || null, tag_color: ts.tag_color || null, notes: ts.notes, created_at: ts.created_at }))
          const formResponses = db.prepare('SELECT fr.*, f.name as form_name FROM form_responses fr JOIN forms f ON fr.form_id = f.id WHERE fr.review_id=?').all(rev.id)
            .map(fr => ({ form_name: fr.form_name, responses: fr.responses }))
          return { reviewer_name: rev.reviewer_name, reviewer_uuid: rev.reviewer_uuid || null, status: rev.status, notes: rev.notes, created_at: rev.created_at, submitted_at: rev.submitted_at, timestamps, form_responses: formResponses }
        })
        return { sync_id: m.sync_id, name: m.name, file_type: m.file_type, media_type_name: m.media_type_name || null, reviews }
      }),
    }
  })

  const deletedReviews = db.prepare('SELECT encounter_name, media_name, reviewer_name FROM deleted_reviews WHERE project_id=?').all(projectId)

  const syncMode = project.cloud_provider ? 'cloud' : project.sync_folder ? 'local' : 'none'
  const syncHint = { mode: syncMode, provider: project.cloud_provider || null }

  return {
    sdmo: true,
    version: 3,
    exported_by_name: getProjectName(projectId) || null,
    exported_at: new Date().toISOString(),
    sync_hint: syncHint,
    project: { name: project.name, description: project.description, owner_password_hash: project.owner_password_hash || null, keybinds },
    forms, instructions, media_types: mediaTypes, encounters,
    deleted_reviews: deletedReviews,
  }
}

function createFromImport(db, data) {
  if (!data?.sdmo) throw new Error('Not a valid SDMo project file')
  const r = db.prepare('INSERT INTO projects (name, description, owner_password_hash) VALUES (?,?,?)')
    .run(data.project?.name || 'Imported Project', data.project?.description || '', data.project?.owner_password_hash || null)
  const projectId = r.lastInsertRowid
  if (data.project?.keybinds) {
    db.prepare('UPDATE projects SET keybinds=? WHERE id=?').run(JSON.stringify(data.project.keybinds), projectId)
  }
  mergeImport(db, projectId, data)
  return projectId
}

function mergeImport(db, projectId, data) {
  if (!data?.sdmo) throw new Error('Not a valid SDMo project file')

  let formsAdded = 0, instrAdded = 0, typesAdded = 0, reviewsImported = 0, reviewsUpdated = 0

  const tx = db.transaction(() => {
    if (data.project) {
      const kbJson = JSON.stringify(data.project.keybinds || [])
      const incomingHash = data.project.owner_password_hash || null
      db.prepare("UPDATE projects SET owner_password_hash=?, keybinds=?, updated_at=datetime('now') WHERE id=?")
        .run(incomingHash, kbJson, projectId)
    }

    for (const f of (data.forms || [])) {
      const schema = typeof f.schema === 'string' ? f.schema : JSON.stringify(f.schema)
      const existing = db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, f.name)
      if (existing) {
        db.prepare("UPDATE forms SET schema=?, updated_at=datetime('now') WHERE id=?").run(schema, existing.id)
      } else {
        db.prepare('INSERT INTO forms (project_id, name, schema) VALUES (?,?,?)').run(projectId, f.name, schema)
        formsAdded++
      }
    }

    for (const i of (data.instructions || [])) {
      let filePath = null
      if (i.content_type === 'pdf' && i.pdf_data) {
        const destDir = path.join(app.getPath('userData'), 'projects', String(projectId))
        fs.mkdirSync(destDir, { recursive: true })
        const existingFile = db.prepare('SELECT file_path FROM instructions WHERE project_id=? AND name=?').get(projectId, i.name)
        filePath = existingFile?.file_path || path.join(destDir, `${Date.now()}-${i.name}.pdf`)
        fs.writeFileSync(filePath, Buffer.from(i.pdf_data, 'base64'))
      }
      const existing = db.prepare('SELECT id FROM instructions WHERE project_id=? AND name=?').get(projectId, i.name)
      if (existing) {
        db.prepare('UPDATE instructions SET content=?, content_type=?, file_path=? WHERE id=?')
          .run(i.content || '', i.content_type || 'markdown', filePath, existing.id)
      } else {
        db.prepare('INSERT INTO instructions (project_id, name, content, content_type, file_path) VALUES (?,?,?,?,?)')
          .run(projectId, i.name, i.content || '', i.content_type || 'markdown', filePath)
        instrAdded++
      }
    }

    for (const mt of (data.media_types || [])) {
      let mtId
      const existing = db.prepare('SELECT id FROM media_types WHERE project_id=? AND name=?').get(projectId, mt.name)
      if (existing) {
        db.prepare('UPDATE media_types SET reviews_required=?, allow_custom_tags=?, color=? WHERE id=?')
          .run(mt.reviews_required, mt.allow_custom_tags ? 1 : 0, mt.color, existing.id)
        mtId = existing.id
      } else {
        const r = db.prepare('INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color) VALUES (?,?,?,?,?)')
          .run(projectId, mt.name, mt.reviews_required || 1, mt.allow_custom_tags ? 1 : 0, mt.color || '#6366f1')
        mtId = r.lastInsertRowid
        typesAdded++
      }
      db.prepare('DELETE FROM timestamp_tags WHERE media_type_id=?').run(mtId)
      for (const tag of (mt.tags || [])) {
        db.prepare('INSERT INTO timestamp_tags (media_type_id, label, color, description) VALUES (?,?,?,?)').run(mtId, tag.label, tag.color || '#6366f1', tag.description || '')
      }
      db.prepare('DELETE FROM workspace_tabs WHERE media_type_id=?').run(mtId)
      for (let i = 0; i < (mt.workspace_tabs || []).length; i++) {
        const tab = mt.workspace_tabs[i]
        let refId = null
        if (tab.tab_type === 'form' && tab.ref_name) refId = db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, tab.ref_name)?.id || null
        else if (tab.tab_type === 'instruction' && tab.ref_name) refId = db.prepare('SELECT id FROM instructions WHERE project_id=? AND name=?').get(projectId, tab.ref_name)?.id || null
        if (refId != null) db.prepare('INSERT INTO workspace_tabs (media_type_id, tab_type, ref_id, label, sort_order) VALUES (?,?,?,?,?)').run(mtId, tab.tab_type, refId, tab.label, i)
      }
    }

    for (const del of (data.deleted_reviews || [])) {
      const localEnc = db.prepare('SELECT id FROM encounters WHERE project_id=? AND name=?').get(projectId, del.encounter_name)
      if (!localEnc) continue
      const localMedia = db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND name=?').get(localEnc.id, del.media_name)
      if (!localMedia) continue
      const rev = db.prepare('SELECT id FROM reviews WHERE media_file_id=? AND reviewer_name=? AND deleted_at IS NULL AND restored_at IS NULL').get(localMedia.id, del.reviewer_name)
      if (rev) db.prepare("UPDATE reviews SET deleted_at=datetime('now') WHERE id=?").run(rev.id)
      db.prepare('INSERT OR IGNORE INTO deleted_reviews (project_id, encounter_name, media_name, reviewer_name) VALUES (?,?,?,?)')
        .run(projectId, del.encounter_name, del.media_name, del.reviewer_name)
    }

    for (const enc of (data.encounters || [])) {
      let localEnc = enc.sync_id
        ? db.prepare('SELECT id FROM encounters WHERE project_id=? AND sync_id=?').get(projectId, enc.sync_id)
        : null
      if (!localEnc) {
        localEnc = db.prepare('SELECT id FROM encounters WHERE project_id=? AND name=?').get(projectId, enc.name)
      }
      if (localEnc) {
        db.prepare('UPDATE encounters SET name=?, sync_id=COALESCE(?,sync_id) WHERE id=?')
          .run(enc.name, enc.sync_id || null, localEnc.id)
      } else {
        const r = db.prepare("INSERT INTO encounters (project_id, name, folder_path, sync_id) VALUES (?,?,?,?)")
          .run(projectId, enc.name, '', enc.sync_id || crypto.randomUUID())
        localEnc = { id: r.lastInsertRowid }
      }
      for (const media of (enc.media || [])) {
        let localMedia = media.sync_id
          ? db.prepare('SELECT id FROM media_files WHERE sync_id=?').get(media.sync_id)
          : null
        if (!localMedia) {
          localMedia = db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND name=?').get(localEnc.id, media.name)
        }
        const mt = media.media_type_name ? db.prepare('SELECT id FROM media_types WHERE project_id=? AND name=?').get(projectId, media.media_type_name) : null
        if (!localMedia) {
          const r = db.prepare("INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id) VALUES (?,?,?,?,?,?)").run(localEnc.id, media.name, '', media.file_type || 'video', mt?.id || null, media.sync_id || crypto.randomUUID())
          localMedia = { id: r.lastInsertRowid }
        } else {
          db.prepare('UPDATE media_files SET encounter_id=?, name=?, media_type_id=?, sync_id=COALESCE(?,sync_id) WHERE id=?')
            .run(localEnc.id, media.name, mt?.id || null, media.sync_id || null, localMedia.id)
        }
        const mediaFile = db.prepare('SELECT media_type_id FROM media_files WHERE id=?').get(localMedia.id)
        const localTags = mediaFile?.media_type_id ? db.prepare('SELECT * FROM timestamp_tags WHERE media_type_id=?').all(mediaFile.media_type_id) : []

        for (const rev of (media.reviews || [])) {
          const existing = db.prepare('SELECT id, status FROM reviews WHERE media_file_id=? AND reviewer_name=?').get(localMedia.id, rev.reviewer_name)

          const insertTimestamps = (reviewId) => {
            for (const ts of (rev.timestamps || [])) {
              const tag = ts.tag_label ? localTags.find(t => t.label === ts.tag_label) : null
              db.prepare('INSERT INTO timestamps (review_id, time_seconds, tag_id, tag_label, notes, tag_color, created_at) VALUES (?,?,?,?,?,?,?)')
                .run(reviewId, ts.time_seconds, tag?.id || null, ts.tag_label || null, ts.notes || '', ts.tag_color || tag?.color || null, ts.created_at)
            }
          }
          const insertFormResponses = (reviewId) => {
            for (const fr of (rev.form_responses || [])) {
              const form = fr.form_name ? db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, fr.form_name) : null
              if (!form) continue
              db.prepare('INSERT INTO form_responses (review_id, form_id, responses) VALUES (?,?,?)').run(reviewId, form.id, fr.responses)
            }
          }

          if (existing) {
            if (rev.status === 'submitted' && existing.status === 'in_progress') {
              db.prepare("UPDATE reviews SET status=?, notes=?, reviewer_uuid=?, submitted_at=? WHERE id=?")
                .run(rev.status, rev.notes || '', rev.reviewer_uuid || null, rev.submitted_at, existing.id)
              db.prepare('DELETE FROM timestamps WHERE review_id=?').run(existing.id)
              db.prepare('DELETE FROM form_responses WHERE review_id=?').run(existing.id)
              insertTimestamps(existing.id)
              insertFormResponses(existing.id)
              reviewsUpdated++
            }
            continue
          }

          const r = db.prepare('INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id, status, notes, created_at, submitted_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(localMedia.id, rev.reviewer_name, rev.reviewer_uuid || null, rev.review_sync_id || crypto.randomUUID(), rev.status, rev.notes || '', rev.created_at, rev.submitted_at)
          insertTimestamps(r.lastInsertRowid)
          insertFormResponses(r.lastInsertRowid)
          reviewsImported++
        }
      }
    }
  })
  tx()
  return { formsAdded, instrAdded, typesAdded, reviewsImported, reviewsUpdated }
}

function getLastSyncAt(projectId) { return lastSyncAt[projectId] || null }
function markSynced(projectId) { lastSyncAt[projectId] = Date.now() }

// Cancel any pending debounce + queued rerun for a project (e.g. on delete) so we
// don't write sync files for a project that no longer exists.
function cancelSync(projectId) {
  if (timers[projectId]) { clearTimeout(timers[projectId]); delete timers[projectId] }
  delete syncQueued[projectId]
  delete syncing[projectId]
  delete lastSyncAt[projectId]
}

module.exports = {
  safeJsonParse,
  scheduleSync, scheduleSyncForReview,
  bumpConfigVersion, bumpAndSync,
  buildExport, mergeImport, createFromImport,
  buildConfigExport, buildReviewExport,
  mergeConfigImport, mergeReviewFile,
  replaceStructureFromConfig,
  syncConfigLocal, syncConfigCloud,
  buildManifest, readLocalManifest,
  doLocalSync, doCloudSync,
  getLastSyncAt, markSynced, cancelSync,
  setMainWindow,
}
