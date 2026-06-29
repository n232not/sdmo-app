const fs = require('fs')
const path = require('path')
const { app, net } = require('electron')
const crypto = require('crypto')
const { getDb, backupDb } = require('./db')
const { getSettings, getProjectName, getOrCreateUUID } = require('./settings')
const { localizeWorkspaceSnapshot, parseJson } = require('./services/snapshots')

const SYNC_PROTOCOL_VERSION = 3
const PROJECT_STATE_FILENAME = 'project-state.json'
const REVIEWS_DIR = 'reviews'
const FORM_VERSIONS_DIR = 'form-versions'
const MEDIA_TYPE_VERSIONS_DIR = 'media-type-versions'
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000

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
let periodicAutoSyncTimer = null

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

// Track projects currently in offline (no-internet) mode so we only notify on transitions.
const offlineProjects = new Set()

function emitSyncOffline(projectId) {
  if (!_mainWindow || _mainWindow.isDestroyed?.()) return
  try { _mainWindow.webContents.send('sync:offline', { projectId }) } catch (_) {}
}

function emitSyncOnline(projectId) {
  if (!_mainWindow || _mainWindow.isDestroyed?.()) return
  try { _mainWindow.webContents.send('sync:online', { projectId }) } catch (_) {}
}

// ─── Debounced auto-sync ──────────────────────────────────────────────────────

function scheduleSync(projectId) {
  if (timers[projectId]) clearTimeout(timers[projectId])
  timers[projectId] = setTimeout(async () => {
    try {
      await syncProjectIfConfigured(projectId)
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

async function syncProjectIfConfigured(projectId) {
  const db = getDb()
  const project = db.prepare('SELECT sync_folder, cloud_provider, cloud_folder_id FROM projects WHERE id=?').get(projectId)
  if (!project) return false

  const uuid = getOrCreateUUID()
  const name = getProjectName(projectId) || uuid

  if (project.sync_folder) {
    await doLocalSync(db, projectId, project.sync_folder, uuid, name)
    return true
  }

  if (project.cloud_provider && project.cloud_folder_id) {
    await doCloudSync(db, projectId, project.cloud_provider, project.cloud_folder_id, uuid, name)
    return true
  }

  return false
}

async function runPeriodicAutoSyncPass() {
  const db = getDb()
  const projects = db.prepare(`
    SELECT id
    FROM projects
    WHERE (sync_folder IS NOT NULL AND sync_folder != '')
       OR (cloud_provider IS NOT NULL AND cloud_provider != '' AND cloud_folder_id IS NOT NULL AND cloud_folder_id != '')
  `).all()

  for (const project of projects) {
    try {
      await syncProjectIfConfigured(project.id)
    } catch (e) {
      console.error(`[sync] periodic auto-sync failed for project ${project.id}:`, e.message)
    }
  }
}

function startPeriodicAutoSync() {
  if (periodicAutoSyncTimer) return

  // Run one light startup pass shortly after launch so projects pick up remote
  // changes even if the user never presses "Sync Now".
  setTimeout(() => {
    runPeriodicAutoSyncPass().catch((e) => {
      console.error('[sync] initial periodic auto-sync failed:', e.message)
    })
  }, 15000)

  periodicAutoSyncTimer = setInterval(() => {
    runPeriodicAutoSyncPass().catch((e) => {
      console.error('[sync] periodic auto-sync failed:', e.message)
    })
  }, AUTO_SYNC_INTERVAL_MS)
}

function stopPeriodicAutoSync() {
  if (!periodicAutoSyncTimer) return
  clearInterval(periodicAutoSyncTimer)
  periodicAutoSyncTimer = null
}

// ─── Split-file builders ──────────────────────────────────────────────────────

function buildConfigExport(db, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)
  const keybinds = safeJsonParse(project.keybinds, [])

  const forms = db.prepare('SELECT * FROM forms WHERE project_id=?').all(projectId).map(f => ({
    sync_id: f.sync_id,
    updated_at: f.updated_at || f.created_at,
    name: f.name,
    schema_version: f.schema_version || 1,
    archived_at: f.archived_at || null,
    schema: JSON.parse(f.schema || '{"sections":[]}'),
  }))

  const formVersions = db.prepare('SELECT * FROM form_versions WHERE project_id=? ORDER BY form_sync_id, version').all(projectId).map(v => ({
    form_sync_id: v.form_sync_id,
    version: v.version,
    name: v.name,
    schema: safeJsonParse(v.schema, { sections: [] }),
    source_updated_at: v.source_updated_at || null,
    created_at: v.created_at || null,
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
      config_version: mt.config_version || 1,
      archived_at: mt.archived_at || null,
      reviews_required: mt.reviews_required,
      allow_custom_tags: mt.allow_custom_tags,
      color: mt.color,
      tags: tags.map(t => ({ label: t.label, color: t.color, description: t.description })),
      workspace_tabs: tabs,
    }
  })

  const mediaTypeVersions = db.prepare('SELECT * FROM media_type_versions WHERE project_id=? ORDER BY media_type_sync_id, version').all(projectId).map(v => ({
    media_type_sync_id: v.media_type_sync_id,
    version: v.version,
    name: v.name,
    config: safeJsonParse(v.config, {}),
    source_updated_at: v.source_updated_at || null,
    created_at: v.created_at || null,
  }))

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
    form_versions: formVersions,
    instructions,
    media_types: mediaTypes,
    media_type_versions: mediaTypeVersions,
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
          'SELECT fr.*, f.name as form_name, f.sync_id as current_form_sync_id FROM form_responses fr JOIN forms f ON fr.form_id = f.id WHERE fr.review_id=?'
        ).all(rev.id).map(fr => ({
          form_name: fr.form_name,
          form_sync_id: fr.form_sync_id || fr.current_form_sync_id || null,
          form_version: fr.form_version || null,
          form_snapshot: fr.form_snapshot ? safeJsonParse(fr.form_snapshot, null) : null,
          responses: fr.responses,
        }))

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
          media_type_sync_id: rev.media_type_sync_id || null,
          media_type_version: rev.media_type_version || null,
          workspace_snapshot: rev.workspace_snapshot ? safeJsonParse(rev.workspace_snapshot, null) : null,
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
function localClock(row) { return normalizeClockValue(row.updated_at || row.created_at) || '' }
function incomingClock(entity, configData) { return normalizeClockValue(entity.updated_at || configData.exported_at) || '' }

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
        db.prepare("INSERT INTO forms (project_id, name, schema, sync_id, schema_version, archived_at, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, f.name, schema, f.sync_id || crypto.randomUUID(), f.schema_version || 1, f.archived_at || null, f.updated_at || null)
        continue
      }
      let write = true
      if (merge) {
        const d = decideWrite(hashOf({ name: local.name, schema: local.schema }), hashOf({ name: f.name, schema }), localClock(local), incomingClock(f, configData))
        write = d.write
        if (d.conflict) conflicts.push({ kind: 'form', name: f.name })
      }
      if (write) {
        db.prepare("UPDATE forms SET name=?, schema=?, sync_id=COALESCE(sync_id,?), schema_version=?, archived_at=?, updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(f.name, schema, f.sync_id || null, f.schema_version || local.schema_version || 1, f.archived_at || null, f.updated_at || null, local.id)
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
        db.prepare("UPDATE media_types SET name=?, reviews_required=?, allow_custom_tags=?, color=?, sync_id=COALESCE(sync_id,?), config_version=?, archived_at=?, updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(mt.name, mt.reviews_required, mt.allow_custom_tags ? 1 : 0, mt.color, mt.sync_id || null, mt.config_version || local.config_version || 1, mt.archived_at || null, mt.updated_at || null, local.id)
        mtId = local.id
      } else {
        const r = db.prepare("INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color, sync_id, config_version, archived_at, updated_at) VALUES (?,?,?,?,?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, mt.name, mt.reviews_required || 1, mt.allow_custom_tags ? 1 : 0, mt.color || '#6366f1', mt.sync_id || crypto.randomUUID(), mt.config_version || 1, mt.archived_at || null, mt.updated_at || null)
        mtId = r.lastInsertRowid
      }
      _writeMediaTypeChildren(db, projectId, mtId, mt)
    }

    for (const v of (configData.form_versions || [])) {
      if (!v.form_sync_id || tombstoned.form.has(v.form_sync_id)) continue
      const schema = typeof v.schema === 'string' ? v.schema : JSON.stringify(v.schema || { sections: [] })
      db.prepare(`
        INSERT OR IGNORE INTO form_versions (project_id, form_sync_id, version, name, schema, source_updated_at, created_at)
        VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))
      `).run(projectId, v.form_sync_id, v.version || 1, v.name || '', schema, v.source_updated_at || null, v.created_at || null)
    }

    for (const v of (configData.media_type_versions || [])) {
      if (!v.media_type_sync_id || tombstoned.media_type.has(v.media_type_sync_id)) continue
      const config = typeof v.config === 'string' ? v.config : JSON.stringify(v.config || {})
      db.prepare(`
        INSERT OR IGNORE INTO media_type_versions (project_id, media_type_sync_id, version, name, config, source_updated_at, created_at)
        VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))
      `).run(projectId, v.media_type_sync_id, v.version || 1, v.name || '', config, v.source_updated_at || null, v.created_at || null)
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
      const localizedWorkspaceSnapshot = localizeWorkspaceSnapshot(db, projectId, rev.workspace_snapshot)
      const workspaceSnapshotJson = localizedWorkspaceSnapshot ? JSON.stringify(localizedWorkspaceSnapshot) : null

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
          let form = fr.form_sync_id ? db.prepare('SELECT id FROM forms WHERE project_id=? AND sync_id=?').get(projectId, fr.form_sync_id) : null
          if (!form) form = fr.form_name ? db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, fr.form_name) : null
          if (!form) continue
          const formSnapshot = fr.form_snapshot ? JSON.stringify(fr.form_snapshot) : null
          db.prepare('INSERT INTO form_responses (review_id, form_id, responses, form_sync_id, form_version, form_snapshot) VALUES (?,?,?,?,?,?)')
            .run(reviewId, form.id, fr.responses, fr.form_sync_id || null, fr.form_version || null, formSnapshot)
        }
      }

      if (existing) {
        // The file is the single authoritative source for this UUID's reviews — always replace
        db.prepare("UPDATE reviews SET status=?, notes=?, reviewer_uuid=?, submitted_at=?, media_type_sync_id=?, media_type_version=?, workspace_snapshot=? WHERE id=?")
          .run(
            rev.status, rev.notes || '', reviewData.reviewer_uuid || null, rev.submitted_at,
            rev.media_type_sync_id || localizedWorkspaceSnapshot?.media_type?.sync_id || null,
            rev.media_type_version || localizedWorkspaceSnapshot?.media_type?.version || null,
            workspaceSnapshotJson,
            existing.id
          )
        db.prepare('DELETE FROM timestamps WHERE review_id=?').run(existing.id)
        db.prepare('DELETE FROM form_responses WHERE review_id=?').run(existing.id)
        insertTimestamps(existing.id)
        insertFormResponses(existing.id)
        continue
      }

      const r = db.prepare('INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id, status, notes, created_at, submitted_at, media_type_sync_id, media_type_version, workspace_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          localMedia.id, reviewData.reviewer_name, reviewData.reviewer_uuid || null, rev.review_sync_id || crypto.randomUUID(),
          rev.status, rev.notes || '', rev.created_at, rev.submitted_at,
          rev.media_type_sync_id || localizedWorkspaceSnapshot?.media_type?.sync_id || null,
          rev.media_type_version || localizedWorkspaceSnapshot?.media_type?.version || null,
          workspaceSnapshotJson
        )
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
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = new Date(normalized)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return normalized
}

function maxClock(...values) {
  return values
    .map(normalizeClockValue)
    .filter(Boolean)
    .sort()
    .pop() || null
}

function syncFileName(id, suffix = '.json') {
  return `${encodeURIComponent(String(id || 'unknown'))}${suffix}`
}

function formVersionKey(formSyncId, version) {
  return `${formSyncId || ''}@${version || 1}`
}

function mediaTypeVersionKey(mediaTypeSyncId, version) {
  return `${mediaTypeSyncId || ''}@${version || 1}`
}

function compactFormSnapshot(formSnapshot, formVersionCatalog) {
  if (!formSnapshot) return null
  const key = formVersionKey(formSnapshot.sync_id, formSnapshot.version)
  if (!formVersionCatalog?.has(key)) return formSnapshot
  const { schema, ...rest } = formSnapshot
  return { ...rest, schema_ref: { form_sync_id: formSnapshot.sync_id || null, version: formSnapshot.version || 1 } }
}

function expandFormSnapshot(formSnapshot, formVersionCatalog) {
  if (!formSnapshot) return null
  if (formSnapshot.schema) return formSnapshot
  const ref = formSnapshot.schema_ref || { form_sync_id: formSnapshot.sync_id, version: formSnapshot.version }
  const version = ref?.form_sync_id ? formVersionCatalog?.get(formVersionKey(ref.form_sync_id, ref.version)) : null
  if (!version) return formSnapshot
  const { schema_ref, ...rest } = formSnapshot
  return { ...rest, sync_id: rest.sync_id || ref.form_sync_id, version: rest.version || ref.version || 1, schema: version.schema || { sections: [] } }
}

function compactWorkspaceSnapshot(snapshot, formVersionCatalog) {
  if (!snapshot) return null
  const next = JSON.parse(JSON.stringify(snapshot))
  for (const [key, formSnap] of Object.entries(next.forms || {})) {
    next.forms[key] = compactFormSnapshot(formSnap, formVersionCatalog)
  }
  return next
}

function expandWorkspaceSnapshot(snapshot, formVersionCatalog) {
  if (!snapshot) return null
  const next = JSON.parse(JSON.stringify(snapshot))
  for (const [key, formSnap] of Object.entries(next.forms || {})) {
    next.forms[key] = expandFormSnapshot(formSnap, formVersionCatalog)
  }
  return next
}

function buildFormVersionPayloads(db, projectId, config = buildConfigExport(db, projectId)) {
  const payloads = []
  for (const f of (config.forms || [])) {
    if (!f.sync_id) continue
    payloads.push({
      form_sync_id: f.sync_id,
      version: f.schema_version || 1,
      name: f.name,
      schema: f.schema || { sections: [] },
      source_updated_at: f.updated_at || null,
      created_at: f.updated_at || null,
      current: true,
    })
  }
  for (const v of (config.form_versions || [])) payloads.push({ ...v, current: false })
  return payloads
}

function buildMediaTypeVersionPayloads(db, projectId, config = buildConfigExport(db, projectId)) {
  const payloads = []
  for (const mt of (config.media_types || [])) {
    if (!mt.sync_id) continue
    payloads.push({
      media_type_sync_id: mt.sync_id,
      version: mt.config_version || 1,
      name: mt.name,
      config: {
        name: mt.name,
        reviews_required: mt.reviews_required,
        allow_custom_tags: mt.allow_custom_tags ? 1 : 0,
        color: mt.color,
        tags: mt.tags || [],
        workspace_tabs: mt.workspace_tabs || [],
      },
      source_updated_at: mt.updated_at || null,
      created_at: mt.updated_at || null,
      current: true,
    })
  }
  for (const v of (config.media_type_versions || [])) payloads.push({ ...v, current: false })
  return payloads
}

function formVersionCatalogFromState(state) {
  const catalog = new Map()
  for (const f of (state.forms || [])) {
    if (!f.sync_id) continue
    catalog.set(formVersionKey(f.sync_id, f.schema_version || 1), {
      form_sync_id: f.sync_id,
      version: f.schema_version || 1,
      name: f.name,
      schema: f.schema || { sections: [] },
    })
  }
  for (const v of (state.form_versions || [])) {
    if (v.form_sync_id) catalog.set(formVersionKey(v.form_sync_id, v.version || 1), v)
  }
  return catalog
}

function compactReviewForSync(review, formVersionCatalog) {
  return {
    ...review,
    workspace_snapshot: compactWorkspaceSnapshot(review.workspace_snapshot, formVersionCatalog),
    form_responses: (review.form_responses || []).map(fr => ({
      ...fr,
      form_snapshot: compactFormSnapshot(fr.form_snapshot, formVersionCatalog),
    })),
  }
}

function expandReviewFromSync(review, formVersionCatalog) {
  return {
    ...review,
    workspace_snapshot: expandWorkspaceSnapshot(review.workspace_snapshot, formVersionCatalog),
    form_responses: (review.form_responses || []).map(fr => ({
      ...fr,
      form_snapshot: expandFormSnapshot(fr.form_snapshot, formVersionCatalog),
    })),
  }
}

function reviewIndexEntry(review) {
  return {
    review_sync_id: review.review_sync_id,
    media_sync_id: review.media_sync_id || null,
    encounter_sync_id: review.encounter_sync_id || null,
    reviewer_name: review.reviewer_name,
    reviewer_uuid: review.reviewer_uuid || null,
    updated_at: review.updated_at || review.created_at || null,
    deleted_at: review.deleted_at || null,
    hash: buildReviewHash(review),
    path: `${REVIEWS_DIR}/${syncFileName(review.review_sync_id || buildReviewHash(review))}`,
  }
}

function indexByPathHash(entries = []) {
  const out = new Map()
  for (const entry of entries || []) {
    if (entry?.path && entry?.hash) out.set(entry.path, entry.hash)
  }
  return out
}

function sameIndexedPayload(previousEntries, entry) {
  if (!entry?.path || !entry?.hash) return false
  return indexByPathHash(previousEntries).get(entry.path) === entry.hash
}

function reviewIndexBySyncId(indexState) {
  const out = new Map()
  for (const review of (indexState?.reviews || [])) {
    if (review?.review_sync_id) out.set(review.review_sync_id, review)
  }
  return out
}

function remoteReviewsNeedingHydration(remoteIndex, localIndex) {
  if (remoteIndex?.layout !== 'split-v1' || !localIndex) return remoteIndex?.reviews || []
  const localReviews = reviewIndexBySyncId(localIndex)
  return (remoteIndex.reviews || []).filter(remote => {
    const local = remote.review_sync_id ? localReviews.get(remote.review_sync_id) : null
    return !local || local.hash !== remote.hash
  })
}

function buildReviewStateExport(db, projectId) {
  const reviews = db.prepare(`
      SELECT r.*, mf.sync_id as media_sync_id, mf.name as media_name, e.sync_id as encounter_sync_id, e.name as encounter_name
      FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE e.project_id=?
      ORDER BY r.created_at, r.id
    `).all(projectId)
  if (!reviews.length) return []

  const timestampsByReview = new Map()
  for (const ts of db.prepare(`
      SELECT ts.*, r.id as review_id
      FROM timestamps ts
      JOIN reviews r ON ts.review_id = r.id
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE e.project_id=?
      ORDER BY ts.review_id, ts.time_seconds, ts.created_at, ts.id
    `).all(projectId)) {
    if (!timestampsByReview.has(ts.review_id)) timestampsByReview.set(ts.review_id, [])
    timestampsByReview.get(ts.review_id).push({
      time_seconds: ts.time_seconds,
      tag_label: ts.tag_label || null,
      tag_color: ts.tag_color || null,
      notes: ts.notes || '',
      created_at: ts.created_at,
    })
  }

  const responsesByReview = new Map()
  for (const fr of db.prepare(`
      SELECT fr.review_id, fr.responses, fr.updated_at, fr.form_sync_id, fr.form_version, fr.form_snapshot,
             f.name as form_name, f.sync_id as current_form_sync_id
      FROM form_responses fr
      JOIN reviews r ON fr.review_id = r.id
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      JOIN forms f ON fr.form_id = f.id
      WHERE e.project_id=?
      ORDER BY fr.review_id, f.name
    `).all(projectId)) {
    if (!responsesByReview.has(fr.review_id)) responsesByReview.set(fr.review_id, [])
    responsesByReview.get(fr.review_id).push({
      form_name: fr.form_name,
      form_sync_id: fr.form_sync_id || fr.current_form_sync_id || null,
      form_version: fr.form_version || null,
      form_snapshot: fr.form_snapshot ? safeJsonParse(fr.form_snapshot, null) : null,
      responses: fr.responses,
      updated_at: fr.updated_at,
    })
  }

  return reviews.map(rev => {
    const timestamps = timestampsByReview.get(rev.id) || []
    const formResponses = responsesByReview.get(rev.id) || []
    const workspaceSnapshot = rev.workspace_snapshot ? safeJsonParse(rev.workspace_snapshot, null) : null
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
      media_type_sync_id: rev.media_type_sync_id || null,
      media_type_version: rev.media_type_version || null,
      workspace_snapshot: workspaceSnapshot,
      updated_at: maxClock(
        rev.created_at,
        rev.submitted_at,
        rev.deleted_at,
        rev.restored_at,
        workspaceSnapshot?.captured_at,
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
    form_versions: config.form_versions || [],
    instructions: config.instructions || [],
    media_types: config.media_types || [],
    media_type_versions: config.media_type_versions || [],
    encounters: config.encounters || [],
    reviews: buildReviewStateExport(db, projectId),
    deleted_structure: buildStructureTombstones(db, projectId),
  }
}

function buildProjectStateIndexExport(db, projectId) {
  const config = buildConfigExport(db, projectId)
  const formPayloads = buildFormVersionPayloads(db, projectId, config)
  const mediaTypePayloads = buildMediaTypeVersionPayloads(db, projectId, config)
  const formCatalog = new Map(formPayloads.map(v => [formVersionKey(v.form_sync_id, v.version), v]))
  const reviews = buildReviewStateExport(db, projectId).map(r => compactReviewForSync(r, formCatalog))
  return {
    sdmo_sync: true,
    protocol_version: SYNC_PROTOCOL_VERSION,
    layout: 'split-v1',
    version: 1,
    config_version: config.config_version || 1,
    exported_at: new Date().toISOString(),
    project: config.project,
    forms: config.forms || [],
    form_versions: formPayloads.map(v => ({
      form_sync_id: v.form_sync_id,
      version: v.version || 1,
      name: v.name || '',
      source_updated_at: v.source_updated_at || null,
      created_at: v.created_at || null,
      current: !!v.current,
      hash: hashOf({ name: v.name || '', schema: v.schema || { sections: [] } }),
      path: `${FORM_VERSIONS_DIR}/${syncFileName(`${v.form_sync_id}-v${v.version || 1}`)}`,
    })),
    instructions: config.instructions || [],
    media_types: config.media_types || [],
    media_type_versions: mediaTypePayloads.map(v => ({
      media_type_sync_id: v.media_type_sync_id,
      version: v.version || 1,
      name: v.name || '',
      source_updated_at: v.source_updated_at || null,
      created_at: v.created_at || null,
      current: !!v.current,
      hash: hashOf({ name: v.name || '', config: v.config || {} }),
      path: `${MEDIA_TYPE_VERSIONS_DIR}/${syncFileName(`${v.media_type_sync_id}-v${v.version || 1}`)}`,
    })),
    encounters: config.encounters || [],
    reviews: reviews.map(reviewIndexEntry),
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
    form_versions: sortBy(state.form_versions, 'form_sync_id').map(v => ({
      form_sync_id: v.form_sync_id,
      version: v.version || 1,
      name: v.name || '',
      schema: v.schema || null,
      hash: v.hash || null,
    })),
    instructions: sortBy(state.instructions, 'sync_id').map(stripClock),
    media_types: sortBy(state.media_types, 'sync_id').map(mt => ({
      ...stripClock(mt),
      tags: [...(mt.tags || [])].sort((a, b) => (a.label || '') > (b.label || '') ? 1 : -1),
      workspace_tabs: [...(mt.workspace_tabs || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)),
    })),
    media_type_versions: sortBy(state.media_type_versions, 'media_type_sync_id').map(v => ({
      media_type_sync_id: v.media_type_sync_id,
      version: v.version || 1,
      name: v.name || '',
      config: v.config || null,
      hash: v.hash || null,
    })),
    encounters: sortBy(state.encounters, 'sync_id').map(enc => ({
      sync_id: enc.sync_id,
      name: enc.name,
      media: sortBy(enc.media, 'sync_id').map(stripClock),
    })),
    reviews: sortBy(state.reviews, 'review_sync_id').map(rev => ({
      review_sync_id: rev.review_sync_id,
      hash: rev.hash || null,
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
      media_type_sync_id: rev.media_type_sync_id || null,
      media_type_version: rev.media_type_version || null,
      workspace_snapshot: rev.workspace_snapshot || null,
      timestamps: [...(rev.timestamps || [])].sort((a, b) => {
        if (a.time_seconds !== b.time_seconds) return a.time_seconds - b.time_seconds
        return (a.created_at || '') > (b.created_at || '') ? 1 : -1
      }),
      form_responses: [...(rev.form_responses || [])].sort((a, b) => (a.form_name || '') > (b.form_name || '') ? 1 : -1).map(fr => ({
        form_name: fr.form_name,
        form_sync_id: fr.form_sync_id || null,
        form_version: fr.form_version || null,
        form_snapshot: fr.form_snapshot || null,
        responses: fr.responses,
      })),
    })),
    deleted_structure: [...(state.deleted_structure || [])]
      .map(t => ({ kind: t.kind, sync_id: t.sync_id }))
      .sort((a, b) => `${a.kind}:${a.sync_id}` > `${b.kind}:${b.sync_id}` ? 1 : -1),
  }
}

function projectStateFingerprint(db, projectId) {
  return hashOf(canonicalizeProjectState(buildProjectStateIndexExport(db, projectId)))
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
    media_type_sync_id: review.media_type_sync_id || null,
    media_type_version: review.media_type_version || null,
    workspace_snapshot: review.workspace_snapshot || null,
    timestamps: review.timestamps || [],
    form_responses: (review.form_responses || []).map(fr => ({
      form_name: fr.form_name,
      form_sync_id: fr.form_sync_id || null,
      form_version: fr.form_version || null,
      form_snapshot: fr.form_snapshot || null,
      responses: fr.responses,
    })),
  })
}

function reviewStateLookupKeys(review) {
  const keys = []
  if (review?.review_sync_id) keys.push(`sync:${review.review_sync_id}`)
  keys.push(`legacy:${review?.media_sync_id || ''}:${review?.reviewer_name || ''}:${review?.created_at || ''}`)
  return keys
}

function buildReviewStateLookup(reviewStates) {
  const lookup = new Map()
  for (const state of (reviewStates || [])) {
    for (const key of reviewStateLookupKeys(state)) {
      if (!lookup.has(key)) lookup.set(key, state)
    }
  }
  return lookup
}

function applyReviewState(db, projectId, review, { merge = false, localReviewLookup = null } = {}) {
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
  const localizedWorkspaceSnapshot = localizeWorkspaceSnapshot(db, projectId, review.workspace_snapshot)
  const workspaceSnapshotJson = localizedWorkspaceSnapshot ? JSON.stringify(localizedWorkspaceSnapshot) : null

  let local = review.review_sync_id
    ? db.prepare('SELECT * FROM reviews WHERE review_sync_id=?').get(review.review_sync_id)
    : null
  if (!local) {
    local = db.prepare('SELECT * FROM reviews WHERE media_file_id=? AND reviewer_name=? AND created_at=?').get(localMedia.id, review.reviewer_name, review.created_at)
  }

  const incomingClock = normalizeClockValue(review.updated_at || review.created_at) || ''
  if (local) {
    let localState = null
    if (localReviewLookup) {
      for (const key of reviewStateLookupKeys({ ...review, review_sync_id: local.review_sync_id || review.review_sync_id })) {
        localState = localReviewLookup.get(key)
        if (localState) break
      }
    } else {
      localState = buildReviewStateExport(db, projectId).find(r => r.review_sync_id === local.review_sync_id || (!r.review_sync_id && r.reviewer_name === local.reviewer_name && r.created_at === local.created_at && r.media_sync_id === review.media_sync_id))
    }
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
          status=?, notes=?, created_at=?, submitted_at=?, deleted_at=?, restored_at=?,
          media_type_sync_id=?, media_type_version=?, workspace_snapshot=?
      WHERE id=?
    `).run(
      localMedia.id, review.reviewer_name, review.reviewer_uuid || null, review.review_sync_id || null,
      review.status, review.notes || '', review.created_at, review.submitted_at || null,
      review.deleted_at || null, review.restored_at || null,
      review.media_type_sync_id || localizedWorkspaceSnapshot?.media_type?.sync_id || null,
      review.media_type_version || localizedWorkspaceSnapshot?.media_type?.version || null,
      workspaceSnapshotJson,
      local.id
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
      let form = fr.form_sync_id ? db.prepare('SELECT id FROM forms WHERE project_id=? AND sync_id=?').get(projectId, fr.form_sync_id) : null
      if (!form) form = fr.form_name ? db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, fr.form_name) : null
      if (!form) continue
      const formSnapshot = fr.form_snapshot ? JSON.stringify(fr.form_snapshot) : null
      db.prepare('INSERT INTO form_responses (review_id, form_id, responses, form_sync_id, form_version, form_snapshot, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime(\'now\')))')
        .run(local.id, form.id, fr.responses, fr.form_sync_id || null, fr.form_version || null, formSnapshot, fr.updated_at || null)
    }
    return { conflict }
  }

  const r = db.prepare(`
    INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id, status, notes, created_at, submitted_at, deleted_at, restored_at, media_type_sync_id, media_type_version, workspace_snapshot)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    localMedia.id, review.reviewer_name, review.reviewer_uuid || null, review.review_sync_id || crypto.randomUUID(),
    review.status, review.notes || '', review.created_at, review.submitted_at || null,
    review.deleted_at || null, review.restored_at || null,
    review.media_type_sync_id || localizedWorkspaceSnapshot?.media_type?.sync_id || null,
    review.media_type_version || localizedWorkspaceSnapshot?.media_type?.version || null,
    workspaceSnapshotJson
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
    let form = fr.form_sync_id ? db.prepare('SELECT id FROM forms WHERE project_id=? AND sync_id=?').get(projectId, fr.form_sync_id) : null
    if (!form) form = fr.form_name ? db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, fr.form_name) : null
    if (!form) continue
    const formSnapshot = fr.form_snapshot ? JSON.stringify(fr.form_snapshot) : null
    db.prepare('INSERT INTO form_responses (review_id, form_id, responses, form_sync_id, form_version, form_snapshot, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime(\'now\')))')
      .run(r.lastInsertRowid, form.id, fr.responses, fr.form_sync_id || null, fr.form_version || null, formSnapshot, fr.updated_at || null)
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
      form_versions: stateData.form_versions || [],
      instructions: stateData.instructions || [],
      media_types: stateData.media_types || [],
      media_type_versions: stateData.media_type_versions || [],
      encounters: stateData.encounters || [],
    }, { merge })
    const conflicts = []
    const localReviewLookup = merge ? buildReviewStateLookup(buildReviewStateExport(db, projectId)) : null
    for (const review of (stateData.reviews || [])) {
      const result = applyReviewState(db, projectId, review, { merge, localReviewLookup })
      if (result.conflict) conflicts.push(result.conflict)
    }
    return conflicts
  })
  return { conflicts: tx() || [] }
}

function readJsonFileIfExists(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}

function localPayloadPath(syncFolder, relPath) {
  if (!relPath) return null
  const base = path.resolve(syncFolder)
  const full = path.resolve(syncFolder, relPath)
  return full === base || full.startsWith(`${base}${path.sep}`) ? full : null
}

function hydrateSplitProjectStateLocal(stateData, syncFolder, { localIndex = null } = {}) {
  if (stateData?.layout !== 'split-v1') return stateData
  const readPayload = (entry) => {
    const payloadPath = localPayloadPath(syncFolder, entry.path)
    return payloadPath ? readJsonFileIfExists(payloadPath) : null
  }
  const state = { ...stateData }
  state.form_versions = (stateData.form_versions || [])
    .map(entry => {
      const payload = readPayload(entry)
      return payload ? { ...payload, current: !!entry.current } : null
    })
    .filter(v => v && !v.current)
  state.media_type_versions = (stateData.media_type_versions || [])
    .map(entry => {
      const payload = readPayload(entry)
      return payload ? { ...payload, current: !!entry.current } : null
    })
    .filter(v => v && !v.current)
  const formCatalog = formVersionCatalogFromState({
    ...stateData,
    form_versions: (stateData.form_versions || [])
      .map(readPayload)
      .filter(Boolean),
  })
  state.reviews = remoteReviewsNeedingHydration(stateData, localIndex)
    .map(readPayload)
    .filter(Boolean)
    .map(review => expandReviewFromSync(review, formCatalog))
  return state
}

function writeSplitProjectStateLocal(db, projectId, syncFolder, indexState = buildProjectStateIndexExport(db, projectId), previousIndex = null) {
  const formDir = path.join(syncFolder, FORM_VERSIONS_DIR)
  const mediaTypeDir = path.join(syncFolder, MEDIA_TYPE_VERSIONS_DIR)
  const reviewsDir = path.join(syncFolder, REVIEWS_DIR)
  fs.mkdirSync(formDir, { recursive: true })
  fs.mkdirSync(mediaTypeDir, { recursive: true })
  fs.mkdirSync(reviewsDir, { recursive: true })

  const config = buildConfigExport(db, projectId)
  const formPayloads = buildFormVersionPayloads(db, projectId, config)
  const mediaTypePayloads = buildMediaTypeVersionPayloads(db, projectId, config)
  const formCatalog = new Map(formPayloads.map(v => [formVersionKey(v.form_sync_id, v.version), v]))
  const previousFormHashes = indexByPathHash(previousIndex?.form_versions)
  const previousMediaTypeHashes = indexByPathHash(previousIndex?.media_type_versions)
  const previousReviewHashes = indexByPathHash(previousIndex?.reviews)
  const writePayload = (dir, entry, previousHashes, payload) => {
    const fullPath = path.join(dir, path.basename(entry.path))
    if (previousHashes.get(entry.path) === entry.hash && fs.existsSync(fullPath)) return
    fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2))
  }
  const formEntries = new Map((indexState.form_versions || []).map(e => [formVersionKey(e.form_sync_id, e.version), e]))
  const mediaTypeEntries = new Map((indexState.media_type_versions || []).map(e => [mediaTypeVersionKey(e.media_type_sync_id, e.version), e]))
  for (const payload of formPayloads) {
    const entry = formEntries.get(formVersionKey(payload.form_sync_id, payload.version))
    if (entry) writePayload(formDir, entry, previousFormHashes, payload)
  }
  for (const payload of mediaTypePayloads) {
    const entry = mediaTypeEntries.get(mediaTypeVersionKey(payload.media_type_sync_id, payload.version))
    if (entry) writePayload(mediaTypeDir, entry, previousMediaTypeHashes, payload)
  }
  for (const review of buildReviewStateExport(db, projectId).map(r => compactReviewForSync(r, formCatalog))) {
    const entry = reviewIndexEntry(review)
    writePayload(reviewsDir, entry, previousReviewHashes, review)
  }
  fs.writeFileSync(path.join(syncFolder, PROJECT_STATE_FILENAME), JSON.stringify(indexState, null, 2))
  fs.writeFileSync(path.join(syncFolder, 'manifest.json'), JSON.stringify(buildManifest(db, projectId, hashOf(canonicalizeProjectState(indexState)))))
}

async function readCloudFolderFiles(adapter, parentId, name) {
  const children = await adapter.listFiles(parentId)
  const folder = children.find(f => f.name === name && f.isFolder)
  if (!folder) return { folder: null, files: [] }
  return { folder, files: await adapter.listFiles(folder.id) }
}

async function runLimited(items, limit, worker) {
  const executing = new Set()
  for (const item of items) {
    const p = Promise.resolve().then(() => worker(item))
    executing.add(p)
    p.finally(() => executing.delete(p))
    if (executing.size >= limit) await Promise.race(executing)
  }
  await Promise.all(executing)
}

async function hydrateSplitProjectStateCloud(stateData, adapter, folderId, { localIndex = null } = {}) {
  if (stateData?.layout !== 'split-v1') return stateData
  const [formFolder, mediaTypeFolder, reviewsFolder] = await Promise.all([
    readCloudFolderFiles(adapter, folderId, FORM_VERSIONS_DIR),
    readCloudFolderFiles(adapter, folderId, MEDIA_TYPE_VERSIONS_DIR),
    readCloudFolderFiles(adapter, folderId, REVIEWS_DIR),
  ])
  const fileByPath = new Map()
  for (const file of formFolder.files) fileByPath.set(`${FORM_VERSIONS_DIR}/${file.name}`, file.id)
  for (const file of mediaTypeFolder.files) fileByPath.set(`${MEDIA_TYPE_VERSIONS_DIR}/${file.name}`, file.id)
  for (const file of reviewsFolder.files) fileByPath.set(`${REVIEWS_DIR}/${file.name}`, file.id)
  const readPath = async (p) => {
    const id = fileByPath.get(p || '')
    if (!id) return null
    try { return JSON.parse(await adapter.readFile(id)) } catch { return null }
  }

  const state = { ...stateData }
  const formEntries = stateData.form_versions || []
  const formPayloadPairs = await Promise.all(formEntries.map(async entry => ({ entry, payload: await readPath(entry.path) })))
  const allFormPayloads = formPayloadPairs.map(p => p.payload).filter(Boolean)
  state.form_versions = formPayloadPairs.filter(p => p.payload && !p.entry.current).map(p => p.payload)
  const mediaTypeEntries = stateData.media_type_versions || []
  const mediaTypePayloadPairs = await Promise.all(mediaTypeEntries.map(async entry => ({ entry, payload: await readPath(entry.path) })))
  const allMediaTypePayloads = mediaTypePayloadPairs.map(p => p.payload).filter(Boolean)
  state.media_type_versions = mediaTypePayloadPairs.filter(p => p.payload && !p.entry.current).map(p => p.payload)
  const formCatalog = formVersionCatalogFromState({ ...stateData, form_versions: allFormPayloads })
  state.reviews = (await Promise.all(remoteReviewsNeedingHydration(stateData, localIndex).map(entry => readPath(entry.path))))
    .filter(Boolean)
    .map(review => expandReviewFromSync(review, formCatalog))
  return state
}

async function writeSplitProjectStateCloud(db, projectId, adapter, folderId, indexState = buildProjectStateIndexExport(db, projectId), previousIndex = null) {
  const [formDirId, mediaTypeDirId, reviewsDirId] = await Promise.all([
    adapter.ensureFolder(folderId, FORM_VERSIONS_DIR),
    adapter.ensureFolder(folderId, MEDIA_TYPE_VERSIONS_DIR),
    adapter.ensureFolder(folderId, REVIEWS_DIR),
  ])
  const [formFiles, mediaTypeFiles, reviewFiles] = await Promise.all([
    adapter.listFiles(formDirId),
    adapter.listFiles(mediaTypeDirId),
    adapter.listFiles(reviewsDirId),
  ])
  const existing = {
    [FORM_VERSIONS_DIR]: new Set(formFiles.map(f => f.name)),
    [MEDIA_TYPE_VERSIONS_DIR]: new Set(mediaTypeFiles.map(f => f.name)),
    [REVIEWS_DIR]: new Set(reviewFiles.map(f => f.name)),
  }
  const config = buildConfigExport(db, projectId)
  const formPayloads = buildFormVersionPayloads(db, projectId, config)
  const mediaTypePayloads = buildMediaTypeVersionPayloads(db, projectId, config)
  const formCatalog = new Map(formPayloads.map(v => [formVersionKey(v.form_sync_id, v.version), v]))
  const previousFormHashes = indexByPathHash(previousIndex?.form_versions)
  const previousMediaTypeHashes = indexByPathHash(previousIndex?.media_type_versions)
  const previousReviewHashes = indexByPathHash(previousIndex?.reviews)
  const formEntries = new Map((indexState.form_versions || []).map(e => [formVersionKey(e.form_sync_id, e.version), e]))
  const mediaTypeEntries = new Map((indexState.media_type_versions || []).map(e => [mediaTypeVersionKey(e.media_type_sync_id, e.version), e]))
  const jobs = []
  const addJob = (folderName, folderIdToWrite, entry, previousHashes, payload) => {
    if (!entry) return
    const fileName = path.basename(entry.path)
    if (previousHashes.get(entry.path) === entry.hash && existing[folderName]?.has(fileName)) return
    jobs.push({ folderId: folderIdToWrite, fileName, payload })
  }
  for (const payload of formPayloads) {
    addJob(FORM_VERSIONS_DIR, formDirId, formEntries.get(formVersionKey(payload.form_sync_id, payload.version)), previousFormHashes, payload)
  }
  for (const payload of mediaTypePayloads) {
    addJob(MEDIA_TYPE_VERSIONS_DIR, mediaTypeDirId, mediaTypeEntries.get(mediaTypeVersionKey(payload.media_type_sync_id, payload.version)), previousMediaTypeHashes, payload)
  }
  for (const review of buildReviewStateExport(db, projectId).map(r => compactReviewForSync(r, formCatalog))) {
    addJob(REVIEWS_DIR, reviewsDirId, reviewIndexEntry(review), previousReviewHashes, review)
  }
  await runLimited(jobs, 4, job => adapter.writeFile(job.folderId, job.fileName, JSON.stringify(job.payload, null, 2)))
  await adapter.writeFile(folderId, PROJECT_STATE_FILENAME, JSON.stringify(indexState, null, 2))
  await adapter.writeFile(folderId, 'manifest.json', JSON.stringify(buildManifest(db, projectId, hashOf(canonicalizeProjectState(indexState)))))
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
  const localIndex = buildProjectStateIndexExport(db, projectId)
  const localFingerprint = hashOf(canonicalizeProjectState(localIndex))
  if (folderFingerprint && folderFingerprint === localFingerprint) return { conflicts: [] }

  const statePath = path.join(syncFolder, PROJECT_STATE_FILENAME)
  let conflicts = []

  if (fs.existsSync(statePath)) {
    const stateData = hydrateSplitProjectStateLocal(JSON.parse(fs.readFileSync(statePath, 'utf8')), syncFolder, { localIndex })
    conflicts = mergeProjectStateImport(db, projectId, stateData, { merge: true }).conflicts
  } else {
    migrateLegacyLocalFolderIntoDb(db, projectId, syncFolder)
  }

  const postIndex = buildProjectStateIndexExport(db, projectId)
  const postFingerprint = hashOf(canonicalizeProjectState(postIndex))
  if (postFingerprint !== folderFingerprint || !fs.existsSync(statePath) || !isProtocolV2Manifest(manifest)) {
    writeSplitProjectStateLocal(db, projectId, syncFolder, postIndex, fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null)
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
  const localIndex = buildProjectStateIndexExport(db, projectId)
  const localFingerprint = hashOf(canonicalizeProjectState(localIndex))
  if (cloudFingerprint && cloudFingerprint === localFingerprint) return { conflicts: [] }

  const stateFile = allFiles.find(f => f.name === PROJECT_STATE_FILENAME)
  let conflicts = []
  let remoteIndex = null

  if (stateFile) {
    remoteIndex = JSON.parse(await adapter.readFile(stateFile.id))
    const stateData = await hydrateSplitProjectStateCloud(remoteIndex, adapter, folderId, { localIndex })
    conflicts = mergeProjectStateImport(db, projectId, stateData, { merge: true }).conflicts
  } else {
    await migrateLegacyCloudFolderIntoDb(db, projectId, adapter, folderId, allFiles)
  }

  const postIndex = buildProjectStateIndexExport(db, projectId)
  const postFingerprint = hashOf(canonicalizeProjectState(postIndex))
  if (postFingerprint !== cloudFingerprint || !stateFile || !isProtocolV2Manifest(manifest)) {
    await writeSplitProjectStateCloud(db, projectId, adapter, folderId, postIndex, remoteIndex)
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

  // The Excel report is no longer written on every sync — it slowed sync and was
  // redundant with the on-demand "Export Excel" button. Users export when needed.

  markSynced(projectId)
}

// ─── Cloud sync ───────────────────────────────────────────────────────────────

function doCloudSync(db, projectId, provider, folderId, uuid, name) {
  return runExclusiveSync(projectId, () => _doCloudSync(db, projectId, provider, folderId, uuid, name))
}

async function _doCloudSync(db, projectId, provider, folderId, uuid, name) {
  if (!net.isOnline()) {
    if (!offlineProjects.has(projectId)) {
      offlineProjects.add(projectId)
      emitSyncOffline(projectId)
    }
    return
  }

  const wasOffline = offlineProjects.has(projectId)
  offlineProjects.delete(projectId)

  const { getAdapter } = require('./cloud/cloudSync')
  const adapter = getAdapter(provider)

  const allFiles = await adapter.listFiles(folderId)

  try {
    const { conflicts } = await syncProjectStateCloud(db, projectId, adapter, folderId, allFiles)
    emitConflicts(conflicts)
  } catch (e) {
    console.error('[sync] cloud project state sync failed:', e.message)
  }

  // The Excel report is no longer uploaded on every cloud sync — the per-pass
  // upload was the slowest part of cloud sync and duplicated the on-demand
  // "Export Excel" button. Users export locally when they need a report.

  markSynced(projectId)

  if (wasOffline) emitSyncOnline(projectId)
}

// ─── Reviews report (auto-uploaded .xlsx of all reviews) ─────────────────────

// Builds the multi-sheet Excel workbook of every review + timestamp in the DB.
// Sheet structure: README + Codebook + normalized research sheets + one
// "<Media Type> Reviews" / "<Media Type> Timestamps" pair per media type.
// Returns an XLSX workbook, or null when there are no reviews to report.
function buildReviewsWorkbook(db, projectId) {
  const XLSX = require('xlsx')
  const wb = XLSX.utils.book_new()
  const FIXED = ['Review ID', 'Encounter', 'Media File', 'Reviewer', 'Status', 'Created At', 'Submitted At', 'Review Notes']

  function sheetName(base, suffix) {
    // Excel sheet name limit: 31 chars. Reserve space for suffix so pairs never collide.
    const maxBase = 31 - 1 - suffix.length
    const truncBase = base.length > maxBase ? base.slice(0, maxBase - 3) + '...' : base
    return `${truncBase} ${suffix}`
  }

  function fmtTime(sec) {
    if (sec == null || isNaN(Number(sec))) return ''
    const m = Math.floor(sec / 60)
    const s = String(Math.floor(sec % 60)).padStart(2, '0')
    return `${m}:${s}`
  }

  function valueCells(value) {
    const out = {
      'Value': '',
      'Value Label': '',
      'Value Number': '',
      'Value Time (seconds)': '',
      'Value Time': '',
      'Value JSON': '',
    }
    if (value == null) return out
    if (typeof value === 'object') out['Value JSON'] = JSON.stringify(value)
    if (typeof value === 'number') {
      out['Value'] = value
      out['Value Number'] = value
      return out
    }
    if (typeof value === 'boolean') {
      out['Value'] = value ? 'Yes' : 'No'
      out['Value Label'] = out['Value']
      return out
    }
    if (Array.isArray(value)) {
      out['Value'] = value.join('; ')
      out['Value Label'] = out['Value']
      return out
    }
    if (typeof value === 'object') {
      if (value.time_seconds != null) {
        out['Value Time (seconds)'] = value.time_seconds
        out['Value Time'] = fmtTime(value.time_seconds)
      }
      if (value.tag_label != null) out['Value Label'] = value.tag_label
      out['Value'] = out['Value Label'] || out['Value Time'] || out['Value JSON']
      return out
    }
    out['Value'] = String(value)
    out['Value Label'] = String(value)
    if (!isNaN(Number(value)) && String(value).trim() !== '') out['Value Number'] = Number(value)
    return out
  }

  function optionText(options) {
    return (options || []).join(', ')
  }

  function validValuesForElement(el) {
    if (el.type === 'multiple_choice' || el.type === 'multiselect') return optionText(el.options)
    if (el.type === 'rating') return `1-${el.max || 5}`
    if (el.type === 'likert') return `1-${el.scale || 5}${el.has_na ? ', N/A' : ''}`
    if (el.type === 'likert_group') return `1-${el.scale || 5}${el.has_na ? ', N/A' : ''}`
    if (el.type === 'slider') return `${el.min ?? 0}-${el.max ?? 100}`
    if (el.type === 'checkbox') return 'Yes, No'
    if (el.type === 'timestamp_select') return 'Time in seconds plus optional tag label'
    if (el.type === 'short_answer' || el.type === 'paragraph') return 'Free text'
    return ''
  }

  function validValuesForTableColumn(col) {
    if (col.type === 'select') return optionText(col.options)
    if (col.type === 'number') return 'Number'
    if (col.type === 'timestamp_select') return 'Time in seconds plus optional tag label'
    return 'Free text'
  }

  // Auto-size columns from header + sampled cell lengths and add a header filter
  // dropdown, so every sheet is readable/sortable without manual fiddling in Excel.
  function styleDataSheet(ws, headers, rows) {
    if (!ws['!ref']) return
    const cols = (headers && headers.length)
      ? headers
      : (rows[0] ? Object.keys(rows[0]) : [])
    if (cols.length) {
      ws['!cols'] = cols.map(h => {
        let max = String(h).length
        for (let i = 0; i < rows.length && i < 200; i++) {
          const v = rows[i] ? rows[i][h] : ''
          if (v != null) max = Math.max(max, String(v).length)
        }
        return { wch: Math.min(Math.max(max + 2, 10), 60) }
      })
    }
    ws['!autofilter'] = { ref: ws['!ref'] }
  }

  function appendSheet(name, rows, headers) {
    const ws = XLSX.utils.json_to_sheet(rows, headers ? { header: headers } : undefined)
    styleDataSheet(ws, headers, rows)
    XLSX.utils.book_append_sheet(wb, ws, name)
  }

  function appendAoaSheet(name, rows) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  }

  // Build allForms: keyed by form id, preserving section/question ids for analysis.
  const allForms = {}
  for (const f of db.prepare('SELECT * FROM forms WHERE project_id=?').all(projectId)) {
    const schema = safeJsonParse(f.schema, { sections: [] })
    const sections = (schema.sections || []).map(sec => ({
      id: sec.id || '',
      title: sec.title || '',
      elements: (sec.elements || []).filter(el => el.type !== 'text_block'),
    }))
    allForms[f.id] = { id: f.id, syncId: f.sync_id || '', name: f.name, version: f.schema_version || 1, sections }
  }

  // Version history: a review captures the exact form schema it was filled against
  // (form_snapshot). Forms get edited over time, so a question answered in an older
  // version may no longer exist in the current schema. To keep ALL answered data in
  // the wide sheets + codebook (not just Responses_Long), pre-scan every review's
  // snapshot and raw response keys, building per-form the set of questions that were
  // answered but are absent from the current schema.
  //   historicalElsByForm: formId -> Map<elementId, { el, section }>  (defs from snapshots)
  //   seenKeysByForm:      formId -> Set<elementId>                    (raw answered keys)
  const historicalElsByForm = new Map()
  const seenKeysByForm = new Map()
  for (const fr of db.prepare(`
    SELECT fr.form_id, fr.responses, fr.form_snapshot
    FROM form_responses fr
    JOIN reviews r ON fr.review_id = r.id
    JOIN media_files mf ON r.media_file_id = mf.id
    JOIN encounters e ON mf.encounter_id = e.id
    WHERE e.project_id=? AND r.deleted_at IS NULL
  `).all(projectId)) {
    const resp = safeJsonParse(fr.responses, {})
    if (!seenKeysByForm.has(fr.form_id)) seenKeysByForm.set(fr.form_id, new Set())
    const keys = seenKeysByForm.get(fr.form_id)
    for (const k of Object.keys(resp)) keys.add(k)

    const snap = fr.form_snapshot ? safeJsonParse(fr.form_snapshot, null) : null
    if (snap?.schema?.sections) {
      if (!historicalElsByForm.has(fr.form_id)) historicalElsByForm.set(fr.form_id, new Map())
      const m = historicalElsByForm.get(fr.form_id)
      for (const sec of snap.schema.sections) {
        for (const el of (sec.elements || [])) {
          if (el.type === 'text_block') continue
          if (!m.has(el.id)) m.set(el.id, { el, section: sec })
        }
      }
    }
  }

  function getResponses(reviewId) {
    const rows = db.prepare(`
      SELECT fr.form_id, fr.responses, fr.form_sync_id, fr.form_version, fr.form_snapshot, f.name as form_name
      FROM form_responses fr
      LEFT JOIN forms f ON fr.form_id = f.id
      WHERE fr.review_id=?
    `).all(reviewId)
    const out = {}
    for (const row of rows) {
      out[row.form_id] = {
        responses: safeJsonParse(row.responses, {}),
        form_sync_id: row.form_sync_id || null,
        form_version: row.form_version || null,
        form_snapshot: row.form_snapshot ? safeJsonParse(row.form_snapshot, null) : null,
        form_name: row.form_name || null,
      }
    }
    return out
  }

  const mediaTypes = db.prepare('SELECT * FROM media_types WHERE project_id=?').all(projectId)
  const buckets = [...mediaTypes, { id: null, name: '(Untyped)' }]
  const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=? ORDER BY name').all(projectId)
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) || {}

  let appended = 0
  const allCbRows = []
  const normalizedReviewRows = []
  const normalizedResponseRows = []
  const normalizedTimestampRows = []
  const mediaFileRows = []
  const seenMediaFiles = new Set()

  function codebookRow(mediaTypeName, form, section, el, component) {
    return {
      'Media Type': mediaTypeName,
      'Form ID': form?.syncId || form?.id || '',
      'Form': form?.name || '',
      'Current Form Version': form?.version || '',
      'In Current Form': component?.historical ? 'No' : 'Yes',
      'Section ID': section?.id || '',
      'Section': section?.title || '',
      'Question ID': el?.id || '',
      'Question Label': el?.label || '',
      'Question Type': component?.qType || el?.type || '',
      'Component ID': component?.id || el?.id || '',
      'Component Label': component?.label || el?.label || '',
      'Column Header': component?.header || '',
      'Valid Values': component?.validValues || validValuesForElement(el || {}),
      'Required': el?.required ? 'Yes' : 'No',
    }
  }

  function pushResponseRow(base, form, section, el, component, value) {
    normalizedResponseRows.push({
      ...base,
      'Form ID': form?.syncId || form?.id || '',
      'Form Name': form?.name || '',
      'Section ID': section?.id || '',
      'Section Title': section?.title || '',
      'Question ID': el?.id || '',
      'Question Label': el?.label || '',
      'Question Type': el?.type || '',
      'Component ID': component?.id || el?.id || '',
      'Component Label': component?.label || el?.label || '',
      ...valueCells(value),
    })
  }

  function responseEntriesFromFormSnapshot(formSnapshot, formId) {
    if (!formSnapshot?.schema?.sections) return []
    const form = {
      id: formId,
      syncId: formSnapshot.sync_id || '',
      name: formSnapshot.name || '',
    }
    const entries = []
    for (const section of formSnapshot.schema.sections || []) {
      for (const el of (section.elements || [])) {
        if (el.type === 'text_block') continue
        if (el.type === 'likert_group') {
          for (const item of (el.items || [])) {
            entries.push({
              form,
              section,
              el,
              component: { id: `${el.id}.${item.id}`, label: item.label || item.id },
              getValue: (resp) => {
                const g = resp[el.id]
                return g && typeof g === 'object' ? g[item.id] : undefined
              },
            })
          }
        } else if (el.type === 'table') {
          for (let ri = 0; ri < (el.rows || []).length; ri++) {
            for (const col of (el.columns || [])) {
              entries.push({
                form,
                section,
                el,
                component: { id: `${el.id}.${ri}.${col.id}`, label: `${el.rows[ri]} / ${col.label || col.id}` },
                getValue: (resp) => {
                  const tbl = resp[el.id]
                  const rowObj = (tbl && typeof tbl === 'object' && !Array.isArray(tbl)) ? (tbl[String(ri)] || {}) : {}
                  return rowObj[col.id]
                },
              })
            }
          }
        } else {
          entries.push({
            form,
            section,
            el,
            component: { id: el.id, label: el.label || el.id },
            getValue: (resp) => resp[el.id],
          })
        }
      }
    }
    return entries
  }

  for (const mt of buckets) {
    const tabForms = mt.id
      ? db.prepare(`
          SELECT DISTINCT f.id, f.name FROM workspace_tabs wt
          JOIN forms f ON wt.ref_id = f.id
          WHERE wt.media_type_id=? AND wt.tab_type='form'
          ORDER BY wt.sort_order
        `).all(mt.id)
      : []

    // qCols: one entry per output column beyond FIXED.
    // Each entry: { formId, header, getValue(formResp) -> cell value }
    // cbRows: parallel codebook entry for each qCol.
    const qCols = []
    const cbRows = []
    const schemaEntriesByForm = new Map()
    const seenCbKeys = new Set()
    // Set while emitting columns for questions that no longer exist in the current
    // form schema (answered under an older version). Their headers get a "(removed)"
    // suffix so they never collide with a live question and the codebook flags them.
    let historicalPass = false

    function pushCol(form, section, el, component, header, getValue, qType, validValues) {
      if (historicalPass) header = `${header} (removed)`
      qCols.push({ formId: form.id, header, getValue })
      const key = `${form.id}:${component.id}:${header}`
      if (!seenCbKeys.has(key)) {
        seenCbKeys.add(key)
        cbRows.push(codebookRow(mt.name, form, section, el, { ...component, header, validValues, qType, historical: historicalPass }))
      }
    }

    function addSchemaEntry(form, section, el, component, getValue) {
      if (!schemaEntriesByForm.has(form.id)) schemaEntriesByForm.set(form.id, [])
      schemaEntriesByForm.get(form.id).push({ form, section, el, component, getValue })
    }

    function pushQCols(form, section, el) {
      const prefix = `[${form.name}] ${el.label || el.id}`

      if (el.type === 'table') {
        const rows = el.rows || []
        const columns = el.columns || []
        for (let ri = 0; ri < rows.length; ri++) {
          for (const col of columns) {
            const cellBase = `[${form.name}] ${el.label || el.id} (${rows[ri]} / ${col.label})`
            const componentBase = {
              id: `${el.id}.${ri}.${col.id}`,
              label: `${rows[ri]} / ${col.label || col.id}`,
              validValues: validValuesForTableColumn(col),
            }
            const getCell = (resp) => {
              const tbl = resp[el.id]
              const rowObj = (tbl && typeof tbl === 'object' && !Array.isArray(tbl)) ? (tbl[String(ri)] || {}) : {}
              return rowObj[col.id]
            }
            if (col.type === 'timestamp_select') {
              // Split timestamp into Time + Tag columns so each is independently analyzable
              pushCol(form, section, el, { ...componentBase, id: `${componentBase.id}.time`, label: `${componentBase.label}: Time` }, `${cellBase}: Time`, (resp) => {
                const v = getCell(resp)
                return (v && typeof v === 'object' && v.time_seconds != null) ? fmtTime(v.time_seconds) : ''
              }, 'table / timestamp', 'M:SS')
              pushCol(form, section, el, { ...componentBase, id: `${componentBase.id}.tag`, label: `${componentBase.label}: Tag` }, `${cellBase}: Tag`, (resp) => {
                const v = getCell(resp)
                return (v && typeof v === 'object') ? (v.tag_label || '') : ''
              }, 'table / timestamp', 'Tag label')
            } else {
              pushCol(form, section, el, componentBase, cellBase, (resp) => {
                const v = getCell(resp)
                if (v == null) return ''
                if (Array.isArray(v)) return v.join('; ')
                if (col.type === 'number') return typeof v === 'number' ? v : (isNaN(Number(v)) ? '' : Number(v))
                return String(v)
              }, `table / ${col.type}`, componentBase.validValues)
            }
            addSchemaEntry(form, section, el, componentBase, getCell)
          }
        }

      } else if (el.type === 'likert_group') {
        // Expand to one column per item — the raw JSON exported by the old code was unreadable
        for (const item of (el.items || [])) {
          const component = { id: `${el.id}.${item.id}`, label: item.label || item.id, validValues: validValuesForElement(el) }
          const getItem = (resp) => {
            const g = resp[el.id]
            if (!g || typeof g !== 'object') return ''
            return g[item.id]
          }
          pushCol(form, section, el, component, `${prefix}: ${item.label}`, (resp) => {
            const v = getItem(resp)
            return v == null ? '' : v
          }, 'likert_group', component.validValues)
          addSchemaEntry(form, section, el, component, getItem)
        }

      } else if (el.type === 'timestamp_select') {
        pushCol(form, section, el, { id: `${el.id}.time`, label: 'Time', validValues: 'M:SS' }, `${prefix}: Time`, (resp) => {
          const v = resp[el.id]
          return (v && typeof v === 'object' && v.time_seconds != null) ? fmtTime(v.time_seconds) : ''
        }, 'timestamp_select', 'M:SS')
        pushCol(form, section, el, { id: `${el.id}.tag`, label: 'Tag', validValues: 'Tag label' }, `${prefix}: Tag`, (resp) => {
          const v = resp[el.id]
          return (v && typeof v === 'object') ? (v.tag_label || '') : ''
        }, 'timestamp_select', 'Tag label')
        addSchemaEntry(form, section, el, { id: el.id, label: el.label || el.id, validValues: validValuesForElement(el) }, (resp) => resp[el.id])

      } else if (el.type === 'checkbox') {
        const component = { id: el.id, label: el.label || el.id, validValues: validValuesForElement(el) }
        pushCol(form, section, el, component, prefix, (resp) => {
          const v = resp[el.id]
          return v === true ? 'Yes' : v === false ? 'No' : ''
        }, 'checkbox', 'Yes, No')
        addSchemaEntry(form, section, el, component, (resp) => resp[el.id])

      } else if (el.type === 'rating' || el.type === 'likert' || el.type === 'slider') {
        const validValues = validValuesForElement(el)
        const component = { id: el.id, label: el.label || el.id, validValues }
        pushCol(form, section, el, component, prefix, (resp) => {
          const v = resp[el.id]
          if (v == null) return ''
          return typeof v === 'number' ? v : (isNaN(Number(v)) ? '' : Number(v))
        }, el.type, validValues)
        addSchemaEntry(form, section, el, component, (resp) => resp[el.id])

      } else if (el.type === 'multiselect') {
        const component = { id: el.id, label: el.label || el.id, validValues: validValuesForElement(el) }
        pushCol(form, section, el, component, prefix, (resp) => {
          const v = resp[el.id]
          if (v == null) return ''
          return Array.isArray(v) ? v.join('; ') : String(v)
        }, 'multiselect', component.validValues)
        addSchemaEntry(form, section, el, component, (resp) => resp[el.id])

      } else {
        // multiple_choice, short_answer, paragraph, and any future types
        const validValues = validValuesForElement(el)
        const component = { id: el.id, label: el.label || el.id, validValues }
        pushCol(form, section, el, component, prefix, (resp) => {
          const v = resp[el.id]
          if (v == null) return ''
          if (Array.isArray(v)) return v.join('; ')
          if (typeof v === 'object') return JSON.stringify(v)
          return String(v)
        }, el.type, validValues)
        addSchemaEntry(form, section, el, component, (resp) => resp[el.id])
      }
    }

    // Emit columns for questions answered under an older form version but no longer
    // in the current schema, so no answered data is invisible in the wide sheets.
    function pushHistoricalCols(form) {
      const currentIds = new Set()
      for (const sec of form.sections) for (const el of sec.elements) currentIds.add(el.id)
      const histMap = historicalElsByForm.get(form.id) || new Map()
      const seenKeys = seenKeysByForm.get(form.id) || new Set()
      const removedIds = new Set()
      for (const id of histMap.keys()) if (!currentIds.has(id)) removedIds.add(id)
      for (const id of seenKeys) if (!currentIds.has(id)) removedIds.add(id)
      if (removedIds.size === 0) return
      historicalPass = true
      for (const id of removedIds) {
        const info = histMap.get(id)
        const el = info?.el || { id, label: '(Removed question)', type: 'short_answer' }
        const section = info?.section || { id: '', title: '(Historical)' }
        pushQCols(form, section, el)
      }
      historicalPass = false
    }

    // Workspace-tab forms first (in tab order), then any remaining project forms
    const tabFormIdSet = new Set(tabForms.map(tf => tf.id))
    for (const tf of tabForms) {
      const form = allForms[tf.id]
      if (!form) continue
      for (const sec of form.sections) {
        for (const el of sec.elements) pushQCols(form, sec, el)
      }
    }
    for (const [idStr, form] of Object.entries(allForms)) {
      const fid = Number(idStr)
      if (tabFormIdSet.has(fid)) continue
      for (const sec of form.sections) {
        for (const el of sec.elements) pushQCols(form, sec, el)
      }
    }
    // Removed-question columns come after every live column (tab forms first).
    for (const tf of tabForms) {
      const form = allForms[tf.id]
      if (form) pushHistoricalCols(form)
    }
    for (const [idStr, form] of Object.entries(allForms)) {
      if (!tabFormIdSet.has(Number(idStr))) pushHistoricalCols(form)
    }

    const reviewRows = []
    const tsRows = []
    const allCols = [...FIXED, ...qCols.map(c => c.header)]

    for (const enc of encounters) {
      const condition = mt.id === null ? 'mf.media_type_id IS NULL' : 'mf.media_type_id = ?'
      const params = mt.id === null ? [enc.id] : [enc.id, mt.id]
      const mediaFiles = db.prepare(
        `SELECT mf.* FROM media_files mf WHERE mf.encounter_id=? AND ${condition} ORDER BY mf.name`
      ).all(...params)

      for (const mf of mediaFiles) {
        if (!seenMediaFiles.has(mf.id)) {
          seenMediaFiles.add(mf.id)
          mediaFileRows.push({
            'Media File ID': mf.sync_id || '',
            'Encounter ID': enc.sync_id || '',
            'Encounter': enc.name,
            'Media Type ID': mt.sync_id || '',
            'Media Type': mt.name,
            'Media File': mf.name,
            'File Type': mf.file_type || '',
            'Created At': mf.created_at || '',
          })
        }
        const reviews = db.prepare('SELECT * FROM reviews WHERE media_file_id=? AND deleted_at IS NULL').all(mf.id)
        for (const rev of reviews) {
          const responses = getResponses(rev.id)
          const base = {
            'Review ID': rev.review_sync_id || '',
            'Encounter ID': enc.sync_id || '',
            'Encounter': enc.name,
            'Media File ID': mf.sync_id || '',
            'Media File': mf.name,
            'Media Type ID': mt.sync_id || '',
            'Media Type': mt.name,
            'Reviewer': rev.reviewer_name,
          }
          const row = {
            'Review ID': rev.review_sync_id || '',
            'Encounter': enc.name,
            'Media File': mf.name,
            'Reviewer': rev.reviewer_name,
            'Status': rev.status === 'submitted' ? 'Submitted' : 'Draft',
            'Created At': rev.created_at,
            'Submitted At': rev.submitted_at || '',
            'Review Notes': rev.notes || '',
          }
          for (const qc of qCols) {
            row[qc.header] = qc.getValue(responses[qc.formId]?.responses || {})
          }
          reviewRows.push(row)
          normalizedReviewRows.push({
            ...base,
            'Status': rev.status === 'submitted' ? 'Submitted' : 'Draft',
            'Created At': rev.created_at,
            'Submitted At': rev.submitted_at || '',
            'Review Notes': rev.notes || '',
          })

          for (const [formIdStr, resp] of Object.entries(responses)) {
            const formId = Number(formIdStr)
            const responseValues = resp?.responses || {}
            const formSnapshot = resp?.form_snapshot
            const entries = formSnapshot ? responseEntriesFromFormSnapshot(formSnapshot, formId) : (schemaEntriesByForm.get(formId) || [])
            const consumedQuestionIds = new Set()
            for (const entry of entries) {
              const value = entry.getValue(responseValues)
              if (value == null || value === '') continue
              consumedQuestionIds.add(entry.el.id)
              pushResponseRow(base, entry.form, entry.section, entry.el, entry.component, value)
            }
            const form = formSnapshot ? {
              id: formId,
              syncId: formSnapshot.sync_id || resp.form_sync_id || '',
              name: formSnapshot.name || resp.form_name || '',
            } : allForms[formId]
            const snapshotElements = {}
            for (const sec of (formSnapshot?.schema?.sections || [])) {
              for (const el of (sec.elements || [])) snapshotElements[el.id] = { section: sec, el }
            }
            for (const [questionId, value] of Object.entries(responseValues)) {
              if (consumedQuestionIds.has(questionId)) continue
              const snap = snapshotElements[questionId]
              pushResponseRow(base, form, {}, {
                id: questionId,
                label: snap?.el?.label || '(Question no longer in current form)',
                type: snap?.el?.type || 'unknown',
              }, {
                id: questionId,
                label: snap?.el?.label || '(Unmapped response)',
              }, value)
            }
          }

          for (const ts of db.prepare('SELECT * FROM timestamps WHERE review_id=? ORDER BY time_seconds').all(rev.id)) {
            tsRows.push({
              'Review ID': rev.review_sync_id || '',
              'Encounter': enc.name,
              'Media File': mf.name,
              'Reviewer': rev.reviewer_name,
              'Time': fmtTime(ts.time_seconds),
              'Time (seconds)': ts.time_seconds,
              'Tag': ts.tag_label || '',
              'Notes': ts.notes || '',
            })
            normalizedTimestampRows.push({
              ...base,
              'Time (seconds)': ts.time_seconds,
              'Time': fmtTime(ts.time_seconds),
              'Tag': ts.tag_label || '',
              'Notes': ts.notes || '',
              'Created At': ts.created_at || '',
            })
          }
        }
      }
    }

    if (reviewRows.length === 0 && tsRows.length === 0) continue
    const reviewWs = XLSX.utils.json_to_sheet(reviewRows, { header: allCols })
    styleDataSheet(reviewWs, allCols, reviewRows)
    XLSX.utils.book_append_sheet(wb, reviewWs, sheetName(mt.name, 'Reviews'))
    if (tsRows.length > 0) {
      const tsWs = XLSX.utils.json_to_sheet(tsRows)
      styleDataSheet(tsWs, Object.keys(tsRows[0]), tsRows)
      XLSX.utils.book_append_sheet(wb, tsWs, sheetName(mt.name, 'Timestamps'))
    }
    if (cbRows.length > 0) allCbRows.push(...cbRows.map(r => ({ 'Media Type': mt.name, ...r })))
    appended++
  }

  if (appended === 0) return null

  appendAoaSheet('README', [
    ['SDMo Reviews Export'],
    ['Project', project.name || ''],
    ['Exported At', new Date().toISOString()],
    ['Export Format Version', '3'],
    [],
    ['Sheet', 'Description'],
    ['Reviews', 'One row per non-deleted review. Stable IDs are included for joins.'],
    ['Responses_Long', 'Canonical analysis sheet: one row per answer/component. This is the safest sheet for R, Python, SPSS, and future question types. Each answer is recorded against the form version the review was actually filled with, so old labels are preserved after a form is edited.'],
    ['Media_Files', 'One row per media file included in the export.'],
    ['Timestamps', 'One row per timestamp logged during review.'],
    ['Codebook', 'One row per exported question/component: stable IDs, labels, type, valid values, the matching wide column header, the current form version, and "In Current Form" (No = the question was answered under an older form version and has since been removed).'],
    ['<Media Type> Reviews', 'Readable wide convenience sheets: one row per review and one column per question/component. Columns ending in "(removed)" hold answers to questions that no longer exist in the current form — no answered data is dropped when forms or media types are edited.'],
    ['<Media Type> Timestamps', 'Readable per-media timestamp convenience sheets.'],
    [],
    ['Form versioning', 'Forms and media types can be edited and have version history. Reviews keep a snapshot of the exact form they were filled with, so this export never loses or relabels older answers.'],
  ])

  appendSheet('Codebook', allCbRows, [
    'Media Type', 'Form ID', 'Form', 'Current Form Version', 'In Current Form',
    'Section ID', 'Section', 'Question ID',
    'Question Label', 'Question Type', 'Component ID', 'Component Label',
    'Column Header', 'Valid Values', 'Required',
  ])
  appendSheet('Reviews', normalizedReviewRows, [
    'Review ID', 'Encounter ID', 'Encounter', 'Media File ID', 'Media File',
    'Media Type ID', 'Media Type', 'Reviewer', 'Status', 'Created At',
    'Submitted At', 'Review Notes',
  ])
  appendSheet('Responses_Long', normalizedResponseRows, [
    'Review ID', 'Encounter ID', 'Encounter', 'Media File ID', 'Media File',
    'Media Type ID', 'Media Type', 'Reviewer', 'Form ID', 'Form Name',
    'Section ID', 'Section Title', 'Question ID', 'Question Label',
    'Question Type', 'Component ID', 'Component Label', 'Value', 'Value Label',
    'Value Number', 'Value Time (seconds)', 'Value Time', 'Value JSON',
  ])
  appendSheet('Media_Files', mediaFileRows, [
    'Media File ID', 'Encounter ID', 'Encounter', 'Media Type ID', 'Media Type',
    'Media File', 'File Type', 'Created At',
  ])
  appendSheet('Timestamps', normalizedTimestampRows, [
    'Review ID', 'Encounter ID', 'Encounter', 'Media File ID', 'Media File',
    'Media Type ID', 'Media Type', 'Reviewer', 'Time (seconds)', 'Time',
    'Tag', 'Notes', 'Created At',
  ])
  wb.SheetNames = [
    'README', 'Codebook', 'Reviews', 'Responses_Long', 'Media_Files', 'Timestamps',
    ...wb.SheetNames.filter(n => !['README', 'Codebook', 'Reviews', 'Responses_Long', 'Media_Files', 'Timestamps'].includes(n)),
  ]

  return wb
}

// ─── Legacy monolithic export/import (kept for Export/Import file flow) ───────

function buildExport(db, projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)
  const keybinds = safeJsonParse(project.keybinds, [])

  const forms = db.prepare('SELECT * FROM forms WHERE project_id=?').all(projectId).map(f => ({
    name: f.name,
    sync_id: f.sync_id || null,
    schema_version: f.schema_version || 1,
    archived_at: f.archived_at || null,
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
      name: mt.name, sync_id: mt.sync_id || null, config_version: mt.config_version || 1, archived_at: mt.archived_at || null,
      reviews_required: mt.reviews_required, allow_custom_tags: mt.allow_custom_tags, color: mt.color,
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
          const formResponses = db.prepare('SELECT fr.*, f.name as form_name, f.sync_id as current_form_sync_id FROM form_responses fr JOIN forms f ON fr.form_id = f.id WHERE fr.review_id=?').all(rev.id)
            .map(fr => ({
              form_name: fr.form_name,
              form_sync_id: fr.form_sync_id || fr.current_form_sync_id || null,
              form_version: fr.form_version || null,
              form_snapshot: fr.form_snapshot ? safeJsonParse(fr.form_snapshot, null) : null,
              responses: fr.responses,
            }))
          return {
            reviewer_name: rev.reviewer_name,
            reviewer_uuid: rev.reviewer_uuid || null,
            review_sync_id: rev.review_sync_id || null,
            status: rev.status,
            notes: rev.notes,
            created_at: rev.created_at,
            submitted_at: rev.submitted_at,
            media_type_sync_id: rev.media_type_sync_id || null,
            media_type_version: rev.media_type_version || null,
            workspace_snapshot: rev.workspace_snapshot ? safeJsonParse(rev.workspace_snapshot, null) : null,
            timestamps,
            form_responses: formResponses,
          }
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
        db.prepare("UPDATE forms SET schema=?, sync_id=COALESCE(?,sync_id), schema_version=?, archived_at=?, updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(schema, f.sync_id || null, f.schema_version || 1, f.archived_at || null, f.updated_at || null, existing.id)
      } else {
        db.prepare("INSERT INTO forms (project_id, name, schema, sync_id, schema_version, archived_at, updated_at) VALUES (?,?,?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, f.name, schema, f.sync_id || crypto.randomUUID(), f.schema_version || 1, f.archived_at || null, f.updated_at || null)
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
        db.prepare("UPDATE media_types SET reviews_required=?, allow_custom_tags=?, color=?, sync_id=COALESCE(?,sync_id), config_version=?, archived_at=?, updated_at=COALESCE(?,datetime('now')) WHERE id=?")
          .run(mt.reviews_required, mt.allow_custom_tags ? 1 : 0, mt.color, mt.sync_id || null, mt.config_version || 1, mt.archived_at || null, mt.updated_at || null, existing.id)
        mtId = existing.id
      } else {
        const r = db.prepare("INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color, sync_id, config_version, archived_at, updated_at) VALUES (?,?,?,?,?,?,?,?,COALESCE(?,datetime('now')))")
          .run(projectId, mt.name, mt.reviews_required || 1, mt.allow_custom_tags ? 1 : 0, mt.color || '#6366f1', mt.sync_id || crypto.randomUUID(), mt.config_version || 1, mt.archived_at || null, mt.updated_at || null)
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
              let form = fr.form_sync_id ? db.prepare('SELECT id FROM forms WHERE project_id=? AND sync_id=?').get(projectId, fr.form_sync_id) : null
              if (!form) form = fr.form_name ? db.prepare('SELECT id FROM forms WHERE project_id=? AND name=?').get(projectId, fr.form_name) : null
              if (!form) continue
              const formSnapshot = fr.form_snapshot ? JSON.stringify(fr.form_snapshot) : null
              db.prepare('INSERT INTO form_responses (review_id, form_id, responses, form_sync_id, form_version, form_snapshot) VALUES (?,?,?,?,?,?)')
                .run(reviewId, form.id, fr.responses, fr.form_sync_id || null, fr.form_version || null, formSnapshot)
            }
          }
          const localizedWorkspaceSnapshot = localizeWorkspaceSnapshot(db, projectId, rev.workspace_snapshot)
          const workspaceSnapshotJson = localizedWorkspaceSnapshot ? JSON.stringify(localizedWorkspaceSnapshot) : null

          if (existing) {
            if (rev.status === 'submitted' && existing.status === 'in_progress') {
              db.prepare("UPDATE reviews SET status=?, notes=?, reviewer_uuid=?, submitted_at=?, media_type_sync_id=?, media_type_version=?, workspace_snapshot=? WHERE id=?")
                .run(
                  rev.status, rev.notes || '', rev.reviewer_uuid || null, rev.submitted_at,
                  rev.media_type_sync_id || localizedWorkspaceSnapshot?.media_type?.sync_id || null,
                  rev.media_type_version || localizedWorkspaceSnapshot?.media_type?.version || null,
                  workspaceSnapshotJson,
                  existing.id
                )
              db.prepare('DELETE FROM timestamps WHERE review_id=?').run(existing.id)
              db.prepare('DELETE FROM form_responses WHERE review_id=?').run(existing.id)
              insertTimestamps(existing.id)
              insertFormResponses(existing.id)
              reviewsUpdated++
            }
            continue
          }

          const r = db.prepare('INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id, status, notes, created_at, submitted_at, media_type_sync_id, media_type_version, workspace_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(
              localMedia.id, rev.reviewer_name, rev.reviewer_uuid || null, rev.review_sync_id || crypto.randomUUID(),
              rev.status, rev.notes || '', rev.created_at, rev.submitted_at,
              rev.media_type_sync_id || localizedWorkspaceSnapshot?.media_type?.sync_id || null,
              rev.media_type_version || localizedWorkspaceSnapshot?.media_type?.version || null,
              workspaceSnapshotJson
            )
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
  buildReviewsWorkbook,
  buildConfigExport, buildReviewExport,
  buildProjectStateExport, buildProjectStateIndexExport, projectStateFingerprint,
  mergeConfigImport, mergeReviewFile,
  mergeProjectStateImport, assertProjectStateCompatible,
  hydrateSplitProjectStateLocal, hydrateSplitProjectStateCloud,
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
  startPeriodicAutoSync, stopPeriodicAutoSync,
  setMainWindow,
  PROJECT_STATE_FILENAME, SYNC_PROTOCOL_VERSION,
}
