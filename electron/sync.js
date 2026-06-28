const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const crypto = require('crypto')
const { getDb, backupDb } = require('./db')
const { getSettings, getProjectName, getOrCreateUUID } = require('./settings')

const SYNC_PROTOCOL_VERSION = 2
const PROJECT_STATE_FILENAME = 'project-state.json'

// Bump when the split-config file format changes in a backward-incompatible way.
// buildConfigExport stamps this; readers refuse configs newer than they understand.
// v5: every structural entity carries a stable sync_id + an updated_at clock so
// sync merges per-entity (last-writer-wins) instead of replacing the whole config.
const CONFIG_FORMAT_VERSION = 5

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

// Push a concurrent-edit toast to the renderer. A "conflict" is a genuine
// same-entity edit on two machines at once; LWW already resolved it deterministically,
// this just lets the user know their version may have been superseded.
function emitConflicts(conflicts) {
  if (!conflicts || !conflicts.length || !_mainWindow || _mainWindow.isDestroyed?.()) return
  const first = conflicts[0]
  const more = conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : ''
  const message = `Edit conflict on ${first.kind} "${first.name}"${more}: another machine's change was newer, so the most recent version was kept.`
  try { _mainWindow.webContents.send('sync:conflict', { message, conflicts }) } catch (_) {}
}

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
    sync_id: f.sync_id,
    updated_at: f.updated_at || f.created_at,
    name: f.name,
    schema: JSON.parse(f.schema || '{"sections":[]}'),
  }))

  const instructions = db.prepare('SELECT * FROM instructions WHERE project_id=?').all(projectId).map(i => {
    let pdf_data = null
    if (i.content_type === 'pdf' && i.file_path) {
      try { pdf_data = fs.readFileSync(i.file_path).toString('base64') } catch (_) {}
    }
    return { sync_id: i.sync_id, updated_at: i.updated_at || i.created_at, name: i.name, content_type: i.content_type || 'markdown', content: i.content || '', pdf_data }
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
      sync_id: mt.sync_id,
      updated_at: mt.updated_at || mt.created_at,
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
      updated_at: enc.updated_at || enc.created_at,
      name: enc.name,
      media: mediaFiles.map(m => ({ sync_id: m.sync_id, updated_at: m.updated_at || m.created_at, name: m.name, file_type: m.file_type, media_type_name: m.media_type_name || null })),
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
      updated_at: project.updated_at,
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

// ─── Per-entity structure apply / merge ──────────────────────────────────────
// Single code path applies a config to the DB. Two modes:
//   • authoritative (default) — incoming always wins, entity by entity. Used by
//     manual Import File, join-from-folder, and the "accept update" prompt.
//   • merge — each entity is kept or replaced by last-writer-wins on its updated_at
//     clock. Used by auto-sync, so two machines that both edited never silently
//     clobber: only the genuinely older edit is replaced.
// NEITHER mode prunes. Deletions propagate solely via structure tombstones, so a
// stale or partial config can never destroy local work. Adding a new synced entity
// means updating this one function (and structureFingerprint / tombstones).

function hashOf(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16)
}

// LWW clock. Falls back to created_at (local rows whose updated_at is still NULL)
// and exported_at (pre-v5 incoming configs with no per-entity clock) so the value
// is always a comparable string in the DB's 'YYYY-MM-DD HH:MM:SS' format.
function localClock(row) { return row.updated_at || row.created_at || '' }
function incomingClock(entity, configData) { return entity.updated_at || configData.exported_at || '' }

// Decide whether an incoming entity should overwrite the local one (merge mode).
// Equal clocks with differing content is a real concurrent edit: a deterministic
// content-hash tiebreak keeps both machines convergent, and we flag a conflict so
// the UI can surface a toast.
function decideWrite(localHash, incomingHash, lClock, iClock) {
  if (iClock > lClock) return { write: true, conflict: false }
  if (iClock < lClock) return { write: false, conflict: false }
  if (localHash === incomingHash) return { write: false, conflict: false }
  return { write: incomingHash > localHash, conflict: true }
}

// Replaces a media type's tags + workspace tabs from a config entry (full replace —
// these children have no independent identity). Tabs reference forms/instructions by
// name, resolved into this DB's ids.
function _writeMediaTypeChildren(db, projectId, mtId, mt) {
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

// Content shapes for tie-break hashing — only the synced fields that define an entity.
function _localMediaTypeContent(db, row) {
  const tags = db.prepare('SELECT label, color, description FROM timestamp_tags WHERE media_type_id=? ORDER BY label').all(row.id)
  const tabs = db.prepare("SELECT tab_type, label, sort_order, ref_id FROM workspace_tabs WHERE media_type_id=? ORDER BY sort_order").all(row.id)
    .map(t => ({ tab_type: t.tab_type, label: t.label, sort_order: t.sort_order }))
  return { name: row.name, reviews_required: row.reviews_required, allow_custom_tags: row.allow_custom_tags ? 1 : 0, color: row.color, tags, tabs: tabs.length }
}
function _incomingMediaTypeContent(mt) {
  const tags = (mt.tags || []).map(t => ({ label: t.label, color: t.color, description: t.description })).sort((a, b) => (a.label > b.label ? 1 : -1))
  return { name: mt.name, reviews_required: mt.reviews_required, allow_custom_tags: mt.allow_custom_tags ? 1 : 0, color: mt.color, tags, tabs: (mt.workspace_tabs || []).length }
}

function applyStructure(db, projectId, configData, { merge = false } = {}) {
  const incomingVersion = configData.config_version || 1
  const conflicts = []
  const tombstoned = tombstonedSyncIds(db, projectId)

  const tx = db.transaction(() => {
    // ── Project meta (a single record, not a set) ──
    if (configData.project) {
      const proj = configData.project
      const local = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)
      const kbJson = JSON.stringify(proj.keybinds || [])
      // Never silently clear an existing password with a null from a stale config file
      const hashToUse = (proj.owner_password_hash || null) || (local?.owner_password_hash || null)
      let write = true
      if (merge && local) {
        const lHash = hashOf({ name: local.name, description: local.description, owner_password_hash: local.owner_password_hash || null, keybinds: safeJsonParse(local.keybinds, []) })
        const iHash = hashOf({ name: proj.name || '', description: proj.description || '', owner_password_hash: hashToUse, keybinds: proj.keybinds || [] })
        const d = decideWrite(lHash, iHash, localClock(local), incomingClock(proj, configData))
        write = d.write
        if (d.conflict) conflicts.push({ kind: 'project', name: proj.name || local.name })
      }
      // Always absorb the higher config_version counter so the legacy "update available"
      // badge clears even when our per-entity content already won.
      const newVersion = merge ? Math.max(local?.config_version || 1, incomingVersion) : incomingVersion
      if (write) {
        db.prepare("UPDATE projects SET name=?, description=?, owner_password_hash=?, keybinds=?, config_version=?, updated_at=COALESCE(?, datetime('now')) WHERE id=?")
          .run(proj.name || '', proj.description || '', hashToUse, kbJson, newVersion, proj.updated_at || null, projectId)
      } else {
        db.prepare('UPDATE projects SET config_version=? WHERE id=?').run(newVersion, projectId)
      }
    }

    // ── Forms ──
    for (const f of (configData.forms || [])) {
      if (f.sync_id && tombstoned.form.has(f.sync_id)) continue
      const schema = typeof f.schema === 'string' ? f.schema : JSON.stringify(f.schema)
      let local = f.sync_id ? db.prepare('SELECT * FROM forms WHERE project_id=? AND sync_id=?').get(projectId, f.sync_id) : null
      if (!local) local = db.prepare('SELECT * FROM forms WHERE project_id=? AND name=?').get(projectId, f.name)
      if (!local) {
        db.prepare("INSERT INTO forms (project_id, name, schema, sync_id, updated_at) VALUES (?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, f.name, schema, f.sync_id || crypto.randomUUID(), f.updated_at || null)
        continue
      }
      let write = true
      if (merge) {
        const d = decideWrite(hashOf({ name: local.name, schema: local.schema }), hashOf({ name: f.name, schema }), localClock(local), incomingClock(f, configData))
        write = d.write
        if (d.conflict) conflicts.push({ kind: 'form', name: f.name })
      }
      if (write) {
        db.prepare("UPDATE forms SET name=?, schema=?, sync_id=COALESCE(sync_id,?), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(f.name, schema, f.sync_id || null, f.updated_at || null, local.id)
      }
    }

    // ── Instructions ──
    for (const i of (configData.instructions || [])) {
      if (i.sync_id && tombstoned.instruction.has(i.sync_id)) continue
      let local = i.sync_id ? db.prepare('SELECT * FROM instructions WHERE project_id=? AND sync_id=?').get(projectId, i.sync_id) : null
      if (!local) local = db.prepare('SELECT * FROM instructions WHERE project_id=? AND name=?').get(projectId, i.name)

      let write = true
      if (merge && local) {
        const d = decideWrite(
          hashOf({ name: local.name, content_type: local.content_type, content: local.content }),
          hashOf({ name: i.name, content_type: i.content_type || 'markdown', content: i.content || '' }),
          localClock(local), incomingClock(i, configData))
        write = d.write
        if (d.conflict) conflicts.push({ kind: 'instruction', name: i.name })
      }
      if (local && !write) continue

      // Only materialize the (potentially large) PDF when we're actually writing it.
      let filePath = local?.file_path || null
      if (i.content_type === 'pdf' && i.pdf_data) {
        const destDir = path.join(app.getPath('userData'), 'projects', String(projectId))
        fs.mkdirSync(destDir, { recursive: true })
        filePath = local?.file_path || path.join(destDir, `${Date.now()}-${i.name}.pdf`)
        fs.writeFileSync(filePath, Buffer.from(i.pdf_data, 'base64'))
      }
      if (local) {
        db.prepare("UPDATE instructions SET name=?, content=?, content_type=?, file_path=?, sync_id=COALESCE(sync_id,?), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(i.name, i.content || '', i.content_type || 'markdown', filePath, i.sync_id || null, i.updated_at || null, local.id)
      } else {
        db.prepare("INSERT INTO instructions (project_id, name, content, content_type, file_path, sync_id, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, i.name, i.content || '', i.content_type || 'markdown', filePath, i.sync_id || crypto.randomUUID(), i.updated_at || null)
      }
    }

    // ── Media types (+ tags + workspace tabs) ──
    for (const mt of (configData.media_types || [])) {
      if (mt.sync_id && tombstoned.media_type.has(mt.sync_id)) continue
      let local = mt.sync_id ? db.prepare('SELECT * FROM media_types WHERE project_id=? AND sync_id=?').get(projectId, mt.sync_id) : null
      if (!local) local = db.prepare('SELECT * FROM media_types WHERE project_id=? AND name=?').get(projectId, mt.name)

      let write = true
      if (merge && local) {
        const d = decideWrite(hashOf(_localMediaTypeContent(db, local)), hashOf(_incomingMediaTypeContent(mt)), localClock(local), incomingClock(mt, configData))
        write = d.write
        if (d.conflict) conflicts.push({ kind: 'media type', name: mt.name })
      }
      if (local && !write) continue

      let mtId
      if (local) {
        db.prepare("UPDATE media_types SET name=?, reviews_required=?, allow_custom_tags=?, color=?, sync_id=COALESCE(sync_id,?), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(mt.name, mt.reviews_required, mt.allow_custom_tags ? 1 : 0, mt.color, mt.sync_id || null, mt.updated_at || null, local.id)
        mtId = local.id
      } else {
        const r = db.prepare("INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color, sync_id, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, mt.name, mt.reviews_required || 1, mt.allow_custom_tags ? 1 : 0, mt.color || '#6366f1', mt.sync_id || crypto.randomUUID(), mt.updated_at || null)
        mtId = r.lastInsertRowid
      }
      _writeMediaTypeChildren(db, projectId, mtId, mt)
    }

    // ── Encounters + media files ──
    // Tombstoned items are skipped so a peer's stale config can't resurrect a deletion.
    for (const enc of (configData.encounters || [])) {
      if (enc.sync_id && tombstoned.enc.has(enc.sync_id)) continue
      let localEnc = enc.sync_id
        ? db.prepare('SELECT * FROM encounters WHERE project_id=? AND sync_id=?').get(projectId, enc.sync_id)
        : null
      if (!localEnc) localEnc = db.prepare('SELECT * FROM encounters WHERE project_id=? AND name=?').get(projectId, enc.name)

      if (!localEnc) {
        const r = db.prepare("INSERT INTO encounters (project_id, name, folder_path, sync_id, updated_at) VALUES (?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, enc.name, '', enc.sync_id || crypto.randomUUID(), enc.updated_at || null)
        localEnc = { id: r.lastInsertRowid }
      } else {
        let write = true
        if (merge) {
          const d = decideWrite(hashOf({ name: localEnc.name }), hashOf({ name: enc.name }), localClock(localEnc), incomingClock(enc, configData))
          write = d.write
          if (d.conflict) conflicts.push({ kind: 'encounter', name: enc.name })
        }
        if (write) {
          db.prepare("UPDATE encounters SET name=?, sync_id=COALESCE(sync_id,?), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
            .run(enc.name, enc.sync_id || null, enc.updated_at || null, localEnc.id)
        }
      }

      for (const media of (enc.media || [])) {
        if (media.sync_id && tombstoned.media.has(media.sync_id)) continue
        // Search globally by sync_id (handles moves — file may be under a different encounter locally)
        let localMedia = media.sync_id ? db.prepare('SELECT * FROM media_files WHERE sync_id=?').get(media.sync_id) : null
        if (!localMedia) localMedia = db.prepare('SELECT * FROM media_files WHERE encounter_id=? AND name=?').get(localEnc.id, media.name)
        const mt = media.media_type_name
          ? db.prepare('SELECT id FROM media_types WHERE project_id=? AND name=?').get(projectId, media.media_type_name)
          : null

        if (!localMedia) {
          db.prepare("INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))")
            .run(localEnc.id, media.name, '', media.file_type || 'video', mt?.id || null, media.sync_id || crypto.randomUUID(), media.updated_at || null)
          continue
        }
        let write = true
        if (merge) {
          const localMtName = localMedia.media_type_id ? db.prepare('SELECT name FROM media_types WHERE id=?').get(localMedia.media_type_id)?.name || null : null
          const d = decideWrite(
            hashOf({ name: localMedia.name, file_type: localMedia.file_type, media_type_name: localMtName }),
            hashOf({ name: media.name, file_type: media.file_type || 'video', media_type_name: media.media_type_name || null }),
            localClock(localMedia), incomingClock(media, configData))
          write = d.write
          if (d.conflict) conflicts.push({ kind: 'file', name: media.name })
        }
        if (write) {
          // Update handles: moves (encounter_id), renames (name), media type, sync_id backfill
          db.prepare("UPDATE media_files SET encounter_id=?, name=?, media_type_id=?, sync_id=COALESCE(sync_id,?), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
            .run(localEnc.id, media.name, mt?.id || null, media.sync_id || null, media.updated_at || null, localMedia.id)
        }
      }
    }
  })
  tx()
  return { conflicts }
}

// Authoritative apply (incoming wins). Back-compat wrapper for manual import / join.
function _applyConfigTransaction(db, projectId, configData) {
  applyStructure(db, projectId, configData, { merge: false })
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

// ─── Structure tombstones (explicit encounter/media deletions) ─────────────────
// Unlike "absent from config" pruning — which deliberately spares anything with
// reviews so a stale/buggy config can't wipe data — an explicit tombstone records
// a deliberate user deletion (the delete UI warns that reviews are destroyed). It
// therefore overrides the review-protection guard and propagates to every machine.

function recordEncounterTombstone(db, projectId, encounterId) {
  const enc = db.prepare('SELECT sync_id FROM encounters WHERE id=?').get(encounterId)
  if (enc?.sync_id) {
    db.prepare('INSERT OR IGNORE INTO deleted_structure (project_id, kind, sync_id) VALUES (?,?,?)')
      .run(projectId, 'encounter', enc.sync_id)
  }
  // Tombstone child media too, so a stale peer config can't resurrect them.
  const media = db.prepare('SELECT sync_id FROM media_files WHERE encounter_id=? AND sync_id IS NOT NULL').all(encounterId)
  for (const m of media) {
    db.prepare('INSERT OR IGNORE INTO deleted_structure (project_id, kind, sync_id) VALUES (?,?,?)')
      .run(projectId, 'media', m.sync_id)
  }
}

function recordMediaTombstone(db, projectId, mediaFileId) {
  const m = db.prepare('SELECT sync_id FROM media_files WHERE id=?').get(mediaFileId)
  if (m?.sync_id) {
    db.prepare('INSERT OR IGNORE INTO deleted_structure (project_id, kind, sync_id) VALUES (?,?,?)')
      .run(projectId, 'media', m.sync_id)
  }
}

// Generic recorder for the by-id structural entities (form / instruction / media_type).
// Call it BEFORE deleting the row, so the deletion propagates to peers as a tombstone
// instead of being silently re-published by anyone whose config still lists the item.
const TOMBSTONE_TABLE = { form: 'forms', instruction: 'instructions', media_type: 'media_types' }
function recordStructureTombstone(db, projectId, kind, id) {
  const table = TOMBSTONE_TABLE[kind]
  if (!table) return
  const row = db.prepare(`SELECT sync_id FROM ${table} WHERE id=?`).get(id)
  if (row?.sync_id) {
    db.prepare('INSERT OR IGNORE INTO deleted_structure (project_id, kind, sync_id) VALUES (?,?,?)')
      .run(projectId, kind, row.sync_id)
  }
}

function readStructureTombstoneFile(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(data.tombstones) ? data.tombstones : []
  } catch { return [] }
}

function applyStructureTombstones(db, projectId, tombstones) {
  for (const del of tombstones) {
    if (!del || !del.sync_id || !del.kind) continue
    db.prepare('INSERT OR IGNORE INTO deleted_structure (project_id, kind, sync_id, deleted_at) VALUES (?,?,?,?)')
      .run(projectId, del.kind, del.sync_id, del.deleted_at || new Date().toISOString())
    if (del.kind === 'encounter') {
      db.prepare('DELETE FROM encounters WHERE project_id=? AND sync_id=?').run(projectId, del.sync_id)
    } else if (del.kind === 'media') {
      db.prepare(`DELETE FROM media_files WHERE sync_id=? AND encounter_id IN (SELECT id FROM encounters WHERE project_id=?)`)
        .run(del.sync_id, projectId)
    } else if (TOMBSTONE_TABLE[del.kind]) {
      // form / instruction / media_type — FK cascade cleans up children (form_responses,
      // timestamp_tags, workspace_tabs).
      db.prepare(`DELETE FROM ${TOMBSTONE_TABLE[del.kind]} WHERE project_id=? AND sync_id=?`).run(projectId, del.sync_id)
    }
  }
}

function buildStructureTombstones(db, projectId) {
  return db.prepare('SELECT kind, sync_id, deleted_at FROM deleted_structure WHERE project_id=?').all(projectId)
}

function mergeStructureTombstones(...lists) {
  const seen = new Set()
  const out = []
  for (const t of [].concat(...lists)) {
    if (!t || !t.sync_id || !t.kind) continue
    const key = `${t.kind}:${t.sync_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: t.kind, sync_id: t.sync_id, deleted_at: t.deleted_at || new Date().toISOString() })
  }
  return out
}

function tombstonedSyncIds(db, projectId) {
  const sets = { enc: new Set(), media: new Set(), form: new Set(), instruction: new Set(), media_type: new Set() }
  for (const row of db.prepare('SELECT kind, sync_id FROM deleted_structure WHERE project_id=?').all(projectId)) {
    if (row.kind === 'encounter') sets.enc.add(row.sync_id)
    else if (row.kind === 'media') sets.media.add(row.sync_id)
    else if (sets[row.kind]) sets[row.kind].add(row.sync_id)
  }
  return sets
}

// ─── Structure fingerprint (content identity, drives merge + cheap polling) ───
// A hash of the canonical structure (sorted by sync_id, clocks stripped) plus the
// tombstone set. Two machines with identical content produce the same fingerprint
// regardless of row order or per-entity timestamps, so "fingerprints match" ⇒
// nothing to sync, and "fingerprints differ" ⇒ run a per-entity merge.

function canonicalizeConfig(cfg) {
  const sortBySync = (arr) => [...(arr || [])].sort((a, b) => ((a.sync_id || a.name || '') > (b.sync_id || b.name || '') ? 1 : -1))
  const stripClock = ({ updated_at, ...rest }) => rest
  return {
    project: cfg.project ? { name: cfg.project.name || '', description: cfg.project.description || '', owner_password_hash: cfg.project.owner_password_hash || null, keybinds: cfg.project.keybinds || [] } : null,
    forms: sortBySync(cfg.forms).map(stripClock),
    instructions: sortBySync(cfg.instructions).map(stripClock),
    media_types: sortBySync(cfg.media_types).map(stripClock),
    encounters: sortBySync(cfg.encounters).map(e => ({ sync_id: e.sync_id, name: e.name, media: sortBySync(e.media).map(stripClock) })),
  }
}

function structureFingerprint(db, projectId) {
  const tombs = db.prepare('SELECT kind, sync_id FROM deleted_structure WHERE project_id=?').all(projectId)
    .map(t => `${t.kind}:${t.sync_id}`).sort()
  return hashOf({ structure: canonicalizeConfig(buildConfigExport(db, projectId)), tombstones: tombs })
}

// ─── Manifest helpers (tiny file for cheap polling) ───────────────────────────

function buildManifest(db, projectId, fingerprint) {
  const project = db.prepare('SELECT config_version FROM projects WHERE id=?').get(projectId)
  return {
    protocol_version: SYNC_PROTOCOL_VERSION,
    config_version: project?.config_version || 1,
    fingerprint: fingerprint || projectStateFingerprint(db, projectId),
    updated_at: new Date().toISOString(),
  }
}

function readLocalManifest(syncFolder) {
  try { return JSON.parse(fs.readFileSync(path.join(syncFolder, 'manifest.json'), 'utf8')) } catch { return null }
}

function isProtocolV2Manifest(manifest) {
  return (manifest?.protocol_version || 1) >= SYNC_PROTOCOL_VERSION
}

function normalizeClockValue(value) {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return `${value.replace(' ', 'T')}Z`
  return value
}

function maxClock(...values) {
  return values
    .map(normalizeClockValue)
    .filter(Boolean)
    .sort()
    .pop() || null
}

function buildReviewStateExport(db, projectId) {
  return db.prepare(`
      SELECT r.*, mf.sync_id as media_sync_id, mf.name as media_name, e.sync_id as encounter_sync_id, e.name as encounter_name
      FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE e.project_id=?
      ORDER BY r.created_at, r.id
    `).all(projectId).map(rev => {
    const timestamps = db.prepare('SELECT * FROM timestamps WHERE review_id=? ORDER BY time_seconds, created_at, id').all(rev.id)
      .map(ts => ({
        time_seconds: ts.time_seconds,
        tag_label: ts.tag_label || null,
        tag_color: ts.tag_color || null,
        notes: ts.notes || '',
        created_at: ts.created_at,
      }))
    const formResponses = db.prepare(`
        SELECT fr.responses, fr.updated_at, f.name as form_name
        FROM form_responses fr
        JOIN forms f ON fr.form_id = f.id
        WHERE fr.review_id=?
        ORDER BY f.name
      `).all(rev.id).map(fr => ({
      form_name: fr.form_name,
      responses: fr.responses,
      updated_at: fr.updated_at,
    }))
    return {
      review_sync_id: rev.review_sync_id || null,
      media_sync_id: rev.media_sync_id || null,
      media_name: rev.media_name,
      encounter_sync_id: rev.encounter_sync_id || null,
      encounter_name: rev.encounter_name,
      reviewer_name: rev.reviewer_name,
      reviewer_uuid: rev.reviewer_uuid || null,
      status: rev.status,
      notes: rev.notes || '',
      created_at: rev.created_at,
      submitted_at: rev.submitted_at || null,
      deleted_at: rev.deleted_at || null,
      restored_at: rev.restored_at || null,
      updated_at: maxClock(
        rev.created_at,
        rev.submitted_at,
        rev.deleted_at,
        rev.restored_at,
        ...timestamps.map(ts => ts.created_at),
        ...formResponses.map(fr => fr.updated_at)
      ),
      timestamps,
      form_responses: formResponses,
    }
  })
}

function buildProjectStateExport(db, projectId) {
  const config = buildConfigExport(db, projectId)
  return {
    sdmo_sync: true,
    protocol_version: SYNC_PROTOCOL_VERSION,
    version: 1,
    config_version: config.config_version || 1,
    exported_at: new Date().toISOString(),
    project: config.project,
    forms: config.forms || [],
    instructions: config.instructions || [],
    media_types: config.media_types || [],
    encounters: config.encounters || [],
    reviews: buildReviewStateExport(db, projectId),
    deleted_structure: buildStructureTombstones(db, projectId),
  }
}

function canonicalizeProjectState(state) {
  const sortBy = (arr, key) => [...(arr || [])].sort((a, b) => {
    const av = a?.[key] || a?.name || ''
    const bv = b?.[key] || b?.name || ''
    return av > bv ? 1 : av < bv ? -1 : 0
  })
  const stripClock = ({ updated_at, exported_at, ...rest }) => rest
  return {
    project: state.project ? {
      name: state.project.name || '',
      description: state.project.description || '',
      owner_password_hash: state.project.owner_password_hash || null,
      keybinds: state.project.keybinds || [],
    } : null,
    forms: sortBy(state.forms, 'sync_id').map(stripClock),
    instructions: sortBy(state.instructions, 'sync_id').map(stripClock),
    media_types: sortBy(state.media_types, 'sync_id').map(mt => ({
      ...stripClock(mt),
      tags: [...(mt.tags || [])].sort((a, b) => (a.label || '') > (b.label || '') ? 1 : -1),
      workspace_tabs: [...(mt.workspace_tabs || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
    })),
    encounters: sortBy(state.encounters, 'sync_id').map(enc => ({
      sync_id: enc.sync_id,
      name: enc.name,
      media: sortBy(enc.media, 'sync_id').map(stripClock),
    })),
    reviews: sortBy(state.reviews, 'review_sync_id').map(rev => ({
      review_sync_id: rev.review_sync_id,
      media_sync_id: rev.media_sync_id || null,
      media_name: rev.media_name,
      encounter_sync_id: rev.encounter_sync_id || null,
      encounter_name: rev.encounter_name,
      reviewer_name: rev.reviewer_name,
      reviewer_uuid: rev.reviewer_uuid || null,
      status: rev.status,
      notes: rev.notes || '',
      created_at: rev.created_at,
      submitted_at: rev.submitted_at || null,
      deleted_at: rev.deleted_at || null,
      restored_at: rev.restored_at || null,
      timestamps: [...(rev.timestamps || [])].sort((a, b) => {
        if (a.time_seconds !== b.time_seconds) return a.time_seconds - b.time_seconds
        return (a.created_at || '') > (b.created_at || '') ? 1 : -1
      }),
      form_responses: [...(rev.form_responses || [])].sort((a, b) => (a.form_name || '') > (b.form_name || '') ? 1 : -1).map(fr => ({
        form_name: fr.form_name,
        responses: fr.responses,
      })),
    })),
    deleted_structure: [...(state.deleted_structure || [])]
      .map(t => ({ kind: t.kind, sync_id: t.sync_id }))
      .sort((a, b) => `${a.kind}:${a.sync_id}` > `${b.kind}:${b.sync_id}` ? 1 : -1),
  }
}

function projectStateFingerprint(db, projectId) {
  return hashOf(canonicalizeProjectState(buildProjectStateExport(db, projectId)))
}

function buildReviewHash(review) {
  return hashOf({
    review_sync_id: review.review_sync_id,
    media_sync_id: review.media_sync_id || null,
    reviewer_name: review.reviewer_name,
    reviewer_uuid: review.reviewer_uuid || null,
    status: review.status,
    notes: review.notes || '',
    created_at: review.created_at,
    submitted_at: review.submitted_at || null,
    deleted_at: review.deleted_at || null,
    restored_at: review.restored_at || null,
    timestamps: review.timestamps || [],
    form_responses: (review.form_responses || []).map(fr => ({ form_name: fr.form_name, responses: fr.responses })),
  })
}

function applyReviewState(db, projectId, review, { merge = false } = {}) {
  let localMedia = review.media_sync_id
    ? db.prepare('SELECT id FROM media_files WHERE sync_id=?').get(review.media_sync_id)
    : null
  if (!localMedia && review.encounter_sync_id) {
    const localEnc = db.prepare('SELECT id FROM encounters WHERE project_id=? AND sync_id=?').get(projectId, review.encounter_sync_id)
    if (localEnc) {
      localMedia = db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND name=?').get(localEnc.id, review.media_name)
    }
  }
  if (!localMedia) {
    const localEnc = db.prepare('SELECT id FROM encounters WHERE project_id=? AND name=?').get(projectId, review.encounter_name)
    if (localEnc) localMedia = db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND name=?').get(localEnc.id, review.media_name)
  }
  if (!localMedia) return { conflict: null }

  let local = review.review_sync_id
    ? db.prepare('SELECT * FROM reviews WHERE review_sync_id=?').get(review.review_sync_id)
    : null
  if (!local) {
    local = db.prepare('SELECT * FROM reviews WHERE media_file_id=? AND reviewer_name=? AND created_at=?').get(localMedia.id, review.reviewer_name, review.created_at)
  }

  const incomingClock = normalizeClockValue(review.updated_at || review.created_at) || ''
  if (local) {
    const localState = buildReviewStateExport(db, projectId).find(r => r.review_sync_id === local.review_sync_id || (!r.review_sync_id && r.reviewer_name === local.reviewer_name && r.created_at === local.created_at && r.media_sync_id === review.media_sync_id))
    let write = true
    let conflict = null
    if (merge && localState) {
      const d = decideWrite(
        buildReviewHash(localState),
        buildReviewHash(review),
        normalizeClockValue(localState.updated_at || localState.created_at) || '',
        incomingClock
      )
      write = d.write
      if (d.conflict) conflict = { kind: 'review', name: `${review.reviewer_name} / ${review.media_name}` }
    }
    if (!write) return { conflict }

    db.prepare(`
      UPDATE reviews
      SET media_file_id=?, reviewer_name=?, reviewer_uuid=?, review_sync_id=COALESCE(review_sync_id, ?),
          status=?, notes=?, created_at=?, submitted_at=?, deleted_at=?, restored_at=?
      WHERE id=?
    `).run(
      localMedia.id, review.reviewer_name, review.reviewer_uuid || null, review.review_sync_id || null,
      review.status, review.notes || '', review.created_at, review.submitted_at || null,
      review.deleted_at || null, review.restored_at || null, local.id
    )
    db.prepare('DELETE FROM timestamps WHERE review_id=?').run(local.id)
    db.prepare('DELETE FROM form_responses WHERE review_id=?').run(local.id)
    for (const ts of (review.timestamps || [])) {
      const tag = ts.tag_label
        ? db.prepare(`
            SELECT tt.id
            FROM timestamp_tags tt
            JOIN media_files mf ON mf.media_type_id = tt.media_type_id
            WHERE mf.id=? AND tt.label=?
          `).get(localMedia.id, ts.tag_label)
        : null
      db.prepare('INSERT INTO timestamps (review_id, time_seconds, tag_id, tag_label, notes, tag_color, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(local.id, ts.time_seconds, tag?.id || null, ts.tag_label || null, ts.notes || '', ts.tag_color || null, ts.created_at)
    }
    for (const fr of (review.form_responses || [])) {
      const form = fr.form_name ? db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, fr.form_name) : null
      if (!form) continue
      db.prepare('INSERT INTO form_responses (review_id, form_id, responses, updated_at) VALUES (?,?,?,COALESCE(?,datetime(\'now\')))')
        .run(local.id, form.id, fr.responses, fr.updated_at || null)
    }
    return { conflict }
  }

  const r = db.prepare(`
    INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id, status, notes, created_at, submitted_at, deleted_at, restored_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    localMedia.id, review.reviewer_name, review.reviewer_uuid || null, review.review_sync_id || crypto.randomUUID(),
    review.status, review.notes || '', review.created_at, review.submitted_at || null,
    review.deleted_at || null, review.restored_at || null
  )
  for (const ts of (review.timestamps || [])) {
    const tag = ts.tag_label
      ? db.prepare(`
          SELECT tt.id
          FROM timestamp_tags tt
          JOIN media_files mf ON mf.media_type_id = tt.media_type_id
          WHERE mf.id=? AND tt.label=?
        `).get(localMedia.id, ts.tag_label)
      : null
    db.prepare('INSERT INTO timestamps (review_id, time_seconds, tag_id, tag_label, notes, tag_color, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(r.lastInsertRowid, ts.time_seconds, tag?.id || null, ts.tag_label || null, ts.notes || '', ts.tag_color || null, ts.created_at)
  }
  for (const fr of (review.form_responses || [])) {
    const form = fr.form_name ? db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, fr.form_name) : null
    if (!form) continue
    db.prepare('INSERT INTO form_responses (review_id, form_id, responses, updated_at) VALUES (?,?,?,COALESCE(?,datetime(\'now\')))')
      .run(r.lastInsertRowid, form.id, fr.responses, fr.updated_at || null)
  }
  return { conflict: null }
}

function assertProjectStateCompatible(stateData) {
  if (!stateData?.sdmo_sync) throw new Error('Not a valid SDMo sync state file')
  const proto = stateData.protocol_version || 1
  if (proto > SYNC_PROTOCOL_VERSION) {
    throw new Error(`This project uses sync protocol v${proto}, but this app supports v${SYNC_PROTOCOL_VERSION}. Please update the app.`)
  }
}

function mergeProjectStateImport(db, projectId, stateData, { merge = true } = {}) {
  assertProjectStateCompatible(stateData)
  const tx = db.transaction(() => {
    applyStructureTombstones(db, projectId, mergeStructureTombstones(stateData.deleted_structure || [], buildStructureTombstones(db, projectId)))
    applyStructure(db, projectId, {
      sdmo: true,
      version: CONFIG_FORMAT_VERSION,
      config_version: stateData.config_version || 1,
      exported_at: stateData.exported_at,
      project: stateData.project,
      forms: stateData.forms || [],
      instructions: stateData.instructions || [],
      media_types: stateData.media_types || [],
      encounters: stateData.encounters || [],
    }, { merge })
    const conflicts = []
    for (const review of (stateData.reviews || [])) {
      const result = applyReviewState(db, projectId, review, { merge })
      if (result.conflict) conflicts.push(result.conflict)
    }
    return conflicts
  })
  return { conflicts: tx() || [] }
}

// ─── Structure apply entry points ─────────────────────────────────────────────

// Authoritative apply (incoming wins). Kept for callers that want "make my DB match
// this config" semantics; deletions still come only from tombstones (no prune).
function replaceStructureFromConfig(db, projectId, configData) {
  if (!configData?.sdmo) throw new Error('Not a valid SDMo config file')
  assertConfigCompatible(configData)
  backupDb('pre-config-apply')
  _applyConfigTransaction(db, projectId, configData)
}

// Per-entity merge (last-writer-wins). The auto-sync path. Returns { conflicts }.
function mergeStructureFromConfig(db, projectId, configData) {
  if (!configData?.sdmo) throw new Error('Not a valid SDMo config file')
  assertConfigCompatible(configData)
  return applyStructure(db, projectId, configData, { merge: true })
}

// ─── Config sync helpers (used by both do*Sync and fetchStructure) ────────────
// Fingerprint-driven, bidirectional. No "who's newer" gate: read the folder config,
// merge it per-entity (older edits lose, never silently — concurrent same-entity
// edits surface as conflicts), then publish if our content still differs (we hold
// newer/extra entities). Returns { conflicts } for the caller to toast.

function syncConfigLocal(db, projectId, syncFolder) {
  const configPath = path.join(syncFolder, 'project-config.json')
  const manifest = readLocalManifest(syncFolder)
  const folderFingerprint = manifest?.fingerprint || null
  const localFingerprint = structureFingerprint(db, projectId)
  // Cheap path: folder content already equals ours.
  if (folderFingerprint && folderFingerprint === localFingerprint) return { conflicts: [] }

  let conflicts = []
  if (fs.existsSync(configPath)) {
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (configData?.sdmo) {
        // Snapshot before pulling genuinely newer remote state (parallel to the old pull backup).
        const localVersion = db.prepare('SELECT config_version FROM projects WHERE id=?').get(projectId)?.config_version || 0
        if ((manifest?.config_version || 0) > localVersion) backupDb('pre-config-merge')
        conflicts = mergeStructureFromConfig(db, projectId, configData).conflicts
      }
    } catch (e) {
      console.error('[sync] reading folder config failed:', e.message)
    }
  }
  // Publish if our post-merge content differs from the folder's.
  const postFingerprint = structureFingerprint(db, projectId)
  if (postFingerprint !== folderFingerprint) {
    fs.writeFileSync(configPath, JSON.stringify(buildConfigExport(db, projectId), null, 2))
    fs.writeFileSync(path.join(syncFolder, 'manifest.json'), JSON.stringify(buildManifest(db, projectId, postFingerprint)))
  }
  return { conflicts }
}

async function syncConfigCloud(db, projectId, adapter, folderId, allFiles) {
  const manifestFile = allFiles.find(f => f.name === 'manifest.json')
  let manifest = null
  if (manifestFile) {
    try { manifest = JSON.parse(await adapter.readFile(manifestFile.id)) } catch {}
  }
  const cloudFingerprint = manifest?.fingerprint || null
  const localFingerprint = structureFingerprint(db, projectId)
  if (cloudFingerprint && cloudFingerprint === localFingerprint) return { conflicts: [] }

  let conflicts = []
  const configFile = allFiles.find(f => f.name === 'project-config.json')
  if (configFile) {
    try {
      const configData = JSON.parse(await adapter.readFile(configFile.id))
      if (configData?.sdmo) {
        const localVersion = db.prepare('SELECT config_version FROM projects WHERE id=?').get(projectId)?.config_version || 0
        if ((manifest?.config_version || 0) > localVersion) backupDb('pre-config-merge')
        conflicts = mergeStructureFromConfig(db, projectId, configData).conflicts
      }
    } catch (e) {
      console.error('[sync] reading cloud config failed:', e.message)
    }
  }
  const postFingerprint = structureFingerprint(db, projectId)
  if (postFingerprint !== cloudFingerprint) {
    await adapter.writeFile(folderId, 'project-config.json', JSON.stringify(buildConfigExport(db, projectId), null, 2))
    await adapter.writeFile(folderId, 'manifest.json', JSON.stringify(buildManifest(db, projectId, postFingerprint)))
  }
  return { conflicts }
}

function migrateLegacyLocalFolderIntoDb(db, projectId, syncFolder) {
  const configPath = path.join(syncFolder, 'project-config.json')
  if (!fs.existsSync(configPath)) return false

  const tombstonePath = path.join(syncFolder, 'deleted-reviews.json')
  const fileTombstones = readTombstoneFile(tombstonePath)
  applyTombstones(db, projectId, fileTombstones)

  const structTombPath = path.join(syncFolder, 'deleted-structure.json')
  const fileStructTombs = readStructureTombstoneFile(structTombPath)
  applyStructureTombstones(db, projectId, fileStructTombs)

  const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  if (configData?.sdmo) mergeStructureFromConfig(db, projectId, configData)

  const reviewsDir = path.join(syncFolder, 'reviews')
  if (fs.existsSync(reviewsDir)) {
    for (const file of fs.readdirSync(reviewsDir).filter(f => f.endsWith('.json'))) {
      try {
        const reviewData = JSON.parse(fs.readFileSync(path.join(reviewsDir, file), 'utf8'))
        mergeReviewFile(db, projectId, reviewData, null)
      } catch (e) {
        console.error(`[sync] failed to migrate legacy review file ${file}:`, e.message)
      }
    }
  }
  return true
}

async function migrateLegacyCloudFolderIntoDb(db, projectId, adapter, folderId, allFiles) {
  const configFile = allFiles.find(f => f.name === 'project-config.json')
  if (!configFile) return false

  const tombstoneFile = allFiles.find(f => f.name === 'deleted-reviews.json')
  if (tombstoneFile) {
    try {
      const data = JSON.parse(await adapter.readFile(tombstoneFile.id))
      applyTombstones(db, projectId, Array.isArray(data.tombstones) ? data.tombstones : [])
    } catch {}
  }

  const structTombFile = allFiles.find(f => f.name === 'deleted-structure.json')
  if (structTombFile) {
    try {
      const data = JSON.parse(await adapter.readFile(structTombFile.id))
      applyStructureTombstones(db, projectId, Array.isArray(data.tombstones) ? data.tombstones : [])
    } catch {}
  }

  const configData = JSON.parse(await adapter.readFile(configFile.id))
  if (configData?.sdmo) mergeStructureFromConfig(db, projectId, configData)

  const reviewsFolder = allFiles.find(f => f.name === 'reviews' && f.isFolder)
  if (reviewsFolder) {
    const reviewFiles = await adapter.listFiles(reviewsFolder.id)
    for (const file of reviewFiles) {
      if (!file.name.endsWith('.json')) continue
      try {
        const reviewData = JSON.parse(await adapter.readFile(file.id))
        mergeReviewFile(db, projectId, reviewData, null)
      } catch (e) {
        console.error(`[sync] failed to migrate cloud review file ${file.name}:`, e.message)
      }
    }
  }
  return true
}

function syncProjectStateLocal(db, projectId, syncFolder) {
  const manifest = readLocalManifest(syncFolder)
  const folderFingerprint = manifest?.fingerprint || null
  const localFingerprint = projectStateFingerprint(db, projectId)
  if (folderFingerprint && folderFingerprint === localFingerprint) return { conflicts: [] }

  const statePath = path.join(syncFolder, PROJECT_STATE_FILENAME)
  let conflicts = []

  if (fs.existsSync(statePath)) {
    const stateData = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    conflicts = mergeProjectStateImport(db, projectId, stateData, { merge: true }).conflicts
  } else {
    migrateLegacyLocalFolderIntoDb(db, projectId, syncFolder)
  }

  const postFingerprint = projectStateFingerprint(db, projectId)
  if (postFingerprint !== folderFingerprint || !fs.existsSync(statePath) || !isProtocolV2Manifest(manifest)) {
    fs.writeFileSync(statePath, JSON.stringify(buildProjectStateExport(db, projectId), null, 2))
    fs.writeFileSync(path.join(syncFolder, 'manifest.json'), JSON.stringify(buildManifest(db, projectId, postFingerprint)))
  }
  return { conflicts }
}

async function syncProjectStateCloud(db, projectId, adapter, folderId, allFiles) {
  const manifestFile = allFiles.find(f => f.name === 'manifest.json')
  let manifest = null
  if (manifestFile) {
    try { manifest = JSON.parse(await adapter.readFile(manifestFile.id)) } catch {}
  }
  const cloudFingerprint = manifest?.fingerprint || null
  const localFingerprint = projectStateFingerprint(db, projectId)
  if (cloudFingerprint && cloudFingerprint === localFingerprint) return { conflicts: [] }

  const stateFile = allFiles.find(f => f.name === PROJECT_STATE_FILENAME)
  let conflicts = []

  if (stateFile) {
    const stateData = JSON.parse(await adapter.readFile(stateFile.id))
    conflicts = mergeProjectStateImport(db, projectId, stateData, { merge: true }).conflicts
  } else {
    await migrateLegacyCloudFolderIntoDb(db, projectId, adapter, folderId, allFiles)
  }

  const postFingerprint = projectStateFingerprint(db, projectId)
  if (postFingerprint !== cloudFingerprint || !stateFile || !isProtocolV2Manifest(manifest)) {
    await adapter.writeFile(folderId, PROJECT_STATE_FILENAME, JSON.stringify(buildProjectStateExport(db, projectId), null, 2))
    await adapter.writeFile(folderId, 'manifest.json', JSON.stringify(buildManifest(db, projectId, postFingerprint)))
  }
  return { conflicts }
}

// ─── Local folder sync ────────────────────────────────────────────────────────

function doLocalSync(db, projectId, syncFolder, uuid, name) {
  return runExclusiveSync(projectId, () => _doLocalSync(db, projectId, syncFolder, uuid, name))
}

async function _doLocalSync(db, projectId, syncFolder, uuid, name) {
  fs.mkdirSync(syncFolder, { recursive: true })

  try {
    const { conflicts } = syncProjectStateLocal(db, projectId, syncFolder)
    emitConflicts(conflicts)
  } catch (e) {
    console.error('[sync] project state sync failed:', e.message)
  }

  // Write the auto-updated reviews report (.xlsx of all merged reviews)
  try {
    const wb = buildReviewsWorkbook(db, projectId)
    if (wb) require('xlsx').writeFile(wb, path.join(syncFolder, REVIEWS_REPORT_FILENAME))
  } catch (e) {
    console.error('[sync] reviews report write failed:', e.message)
  }

  markSynced(projectId)
}

// ─── Cloud sync ───────────────────────────────────────────────────────────────

function doCloudSync(db, projectId, provider, folderId, uuid, name) {
  return runExclusiveSync(projectId, () => _doCloudSync(db, projectId, provider, folderId, uuid, name))
}

async function _doCloudSync(db, projectId, provider, folderId, uuid, name) {
  const { getAdapter } = require('./cloud/cloudSync')
  const adapter = getAdapter(provider)

  const allFiles = await adapter.listFiles(folderId)

  try {
    const { conflicts } = await syncProjectStateCloud(db, projectId, adapter, folderId, allFiles)
    emitConflicts(conflicts)
  } catch (e) {
    console.error('[sync] cloud project state sync failed:', e.message)
  }

  // Write the auto-updated reviews report (.xlsx of all merged reviews)
  try {
    const wb = buildReviewsWorkbook(db, projectId)
    if (wb) {
      const buf = require('xlsx').write(wb, { type: 'buffer', bookType: 'xlsx' })
      await adapter.writeFile(folderId, REVIEWS_REPORT_FILENAME, buf,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    }
  } catch (e) {
    console.error('[sync] cloud reviews report write failed:', e.message)
  }

  markSynced(projectId)
}

// ─── Reviews report (auto-uploaded .xlsx of all reviews) ─────────────────────

// Builds the multi-sheet Excel workbook of every review + timestamp in the DB
// (one "<Media Type> Reviews"/"<Media Type> Timestamps" sheet pair per media
// type), mirroring the manual `export:excel` flow. After a sync merges all peer
// review files into the DB, this captures exactly the union of the cloud reviews.
// Returns an XLSX workbook, or null when there are no reviews to report (an
// empty workbook can't be written).
function buildReviewsWorkbook(db, projectId) {
  const XLSX = require('xlsx')
  const wb = XLSX.utils.book_new()
  const FIXED = ['Encounter', 'Media File', 'Reviewer', 'Status', 'Created At', 'Submitted At', 'Review Notes']

  function sheetName(base, suffix) {
    const s = `${base} ${suffix}`
    return s.length > 31 ? s.slice(0, 28) + '...' : s
  }
  function fmtTime(sec) {
    const m = Math.floor(sec / 60)
    const s = String(Math.floor(sec % 60)).padStart(2, '0')
    return `${m}:${s}`
  }

  const allForms = {}
  for (const f of db.prepare('SELECT * FROM forms WHERE project_id=?').all(projectId)) {
    const schema = safeJsonParse(f.schema, { sections: [] })
    const elements = []
    for (const sec of (schema.sections || [])) {
      for (const el of (sec.elements || [])) {
        if (el.type !== 'text_block') elements.push(el)
      }
    }
    allForms[f.id] = { name: f.name, elements }
  }

  function getResponses(reviewId) {
    const rows = db.prepare('SELECT form_id, responses FROM form_responses WHERE review_id=?').all(reviewId)
    const out = {}
    for (const row of rows) out[row.form_id] = safeJsonParse(row.responses, {})
    return out
  }

  const mediaTypes = db.prepare('SELECT * FROM media_types WHERE project_id=?').all(projectId)
  const buckets = [...mediaTypes, { id: null, name: '(Untyped)' }]
  const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=? ORDER BY name').all(projectId)

  let appended = 0
  for (const mt of buckets) {
    const tabForms = mt.id
      ? db.prepare(`
          SELECT DISTINCT f.id, f.name FROM workspace_tabs wt
          JOIN forms f ON wt.ref_id = f.id
          WHERE wt.media_type_id=? AND wt.tab_type='form'
        `).all(mt.id)
      : []

    const qCols = []
    for (const tf of tabForms) {
      const form = allForms[tf.id]
      if (!form) continue
      for (const el of form.elements) {
        qCols.push({ formId: tf.id, formName: form.name, elId: el.id, label: el.label || el.id })
      }
    }

    const reviewRows = []
    const tsRows = []
    const qHeaders = qCols.map(c => `[${c.formName}] ${c.label}`)
    const allCols = [...FIXED, ...qHeaders]

    for (const enc of encounters) {
      const condition = mt.id === null ? 'mf.media_type_id IS NULL' : 'mf.media_type_id = ?'
      const params = mt.id === null ? [enc.id] : [enc.id, mt.id]
      const mediaFiles = db.prepare(
        `SELECT mf.* FROM media_files mf WHERE mf.encounter_id=? AND ${condition} ORDER BY mf.name`
      ).all(...params)

      for (const mf of mediaFiles) {
        const reviews = db.prepare('SELECT * FROM reviews WHERE media_file_id=? AND deleted_at IS NULL').all(mf.id)
        for (const rev of reviews) {
          const responses = getResponses(rev.id)
          const row = {
            'Encounter': enc.name, 'Media File': mf.name, 'Reviewer': rev.reviewer_name,
            'Status': rev.status, 'Created At': rev.created_at, 'Submitted At': rev.submitted_at || '',
            'Review Notes': rev.notes || '',
          }
          for (const qc of qCols) {
            const val = (responses[qc.formId] || {})[qc.elId]
            row[`[${qc.formName}] ${qc.label}`] = val == null ? '' : Array.isArray(val) ? val.join('; ') : String(val)
          }
          reviewRows.push(row)
          for (const ts of db.prepare('SELECT * FROM timestamps WHERE review_id=? ORDER BY time_seconds').all(rev.id)) {
            tsRows.push({
              'Encounter': enc.name, 'Media File': mf.name, 'Reviewer': rev.reviewer_name,
              'Time': fmtTime(ts.time_seconds), 'Time (seconds)': ts.time_seconds,
              'Tag': ts.tag_label || '', 'Notes': ts.notes || '',
            })
          }
        }
      }
    }

    if (reviewRows.length === 0 && tsRows.length === 0) continue
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reviewRows, { header: allCols }), sheetName(mt.name, 'Reviews'))
    if (tsRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tsRows), sheetName(mt.name, 'Timestamps'))
    appended++
  }

  return appended > 0 ? wb : null
}

// Filename of the auto-uploaded reviews report in the sync folder/cloud.
const REVIEWS_REPORT_FILENAME = 'reviews-export.xlsx'

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
        db.prepare("UPDATE forms SET schema=?, sync_id=COALESCE(?,sync_id), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(schema, f.sync_id || null, f.updated_at || null, existing.id)
      } else {
        db.prepare("INSERT INTO forms (project_id, name, schema, sync_id, updated_at) VALUES (?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, f.name, schema, f.sync_id || crypto.randomUUID(), f.updated_at || null)
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
        db.prepare("UPDATE instructions SET content=?, content_type=?, file_path=?, sync_id=COALESCE(?,sync_id), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(i.content || '', i.content_type || 'markdown', filePath, i.sync_id || null, i.updated_at || null, existing.id)
      } else {
        db.prepare("INSERT INTO instructions (project_id, name, content, content_type, file_path, sync_id, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, i.name, i.content || '', i.content_type || 'markdown', filePath, i.sync_id || crypto.randomUUID(), i.updated_at || null)
        instrAdded++
      }
    }

    for (const mt of (data.media_types || [])) {
      let mtId
      const existing = db.prepare('SELECT id FROM media_types WHERE project_id=? AND name=?').get(projectId, mt.name)
      if (existing) {
        db.prepare("UPDATE media_types SET reviews_required=?, allow_custom_tags=?, color=?, sync_id=COALESCE(?,sync_id), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(mt.reviews_required, mt.allow_custom_tags ? 1 : 0, mt.color, mt.sync_id || null, mt.updated_at || null, existing.id)
        mtId = existing.id
      } else {
        const r = db.prepare("INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color, sync_id, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, mt.name, mt.reviews_required || 1, mt.allow_custom_tags ? 1 : 0, mt.color || '#6366f1', mt.sync_id || crypto.randomUUID(), mt.updated_at || null)
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
        db.prepare("UPDATE encounters SET name=?, sync_id=COALESCE(?,sync_id), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(enc.name, enc.sync_id || null, enc.updated_at || null, localEnc.id)
      } else {
        const r = db.prepare("INSERT INTO encounters (project_id, name, folder_path, sync_id, updated_at) VALUES (?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, enc.name, '', enc.sync_id || crypto.randomUUID(), enc.updated_at || null)
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
          const r = db.prepare("INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))").run(localEnc.id, media.name, '', media.file_type || 'video', mt?.id || null, media.sync_id || crypto.randomUUID(), media.updated_at || null)
          localMedia = { id: r.lastInsertRowid }
        } else {
          db.prepare("UPDATE media_files SET encounter_id=?, name=?, media_type_id=?, sync_id=COALESCE(?,sync_id), updated_at=COALESCE(?,datetime('now')) WHERE id=?")
            .run(localEnc.id, media.name, mt?.id || null, media.sync_id || null, media.updated_at || null, localMedia.id)
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
  buildReviewsWorkbook, REVIEWS_REPORT_FILENAME,
  buildConfigExport, buildReviewExport,
  buildProjectStateExport, projectStateFingerprint,
  mergeConfigImport, mergeReviewFile,
  mergeProjectStateImport, assertProjectStateCompatible,
  applyStructure, replaceStructureFromConfig, mergeStructureFromConfig,
  syncConfigLocal, syncConfigCloud,
  syncProjectStateLocal, syncProjectStateCloud,
  structureFingerprint,
  buildManifest, readLocalManifest,
  doLocalSync, doCloudSync,
  applyTombstones, buildTombstones,
  recordEncounterTombstone, recordMediaTombstone, recordStructureTombstone,
  applyStructureTombstones, buildStructureTombstones,
  getLastSyncAt, markSynced, cancelSync,
  setMainWindow,
  PROJECT_STATE_FILENAME, SYNC_PROTOCOL_VERSION,
}
