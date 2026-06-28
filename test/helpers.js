const path = require('path')
const crypto = require('crypto')
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'))
const { initSchema, migrate, runDataMigrations } = require('../electron/db')

// Fresh isolated in-memory DB with the full schema + migrations applied.
function makeDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  migrate(db)
  runDataMigrations(db)
  return db
}

function createProject(db, name = 'Project', extra = {}) {
  return db.prepare('INSERT INTO projects (name, description) VALUES (?,?)')
    .run(name, extra.description || '').lastInsertRowid
}

function addForm(db, projectId, name, schema = { sections: [] }) {
  return db.prepare('INSERT INTO forms (project_id, name, schema) VALUES (?,?,?)')
    .run(projectId, name, JSON.stringify(schema)).lastInsertRowid
}

function addMediaType(db, projectId, name, opts = {}) {
  const id = db.prepare('INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color) VALUES (?,?,?,?,?)')
    .run(projectId, name, opts.reviews_required ?? 1, opts.allow_custom_tags ? 1 : 0, opts.color || '#6366f1').lastInsertRowid
  for (const t of (opts.tags || [])) {
    db.prepare('INSERT INTO timestamp_tags (media_type_id, label, color, description) VALUES (?,?,?,?)')
      .run(id, t.label, t.color || '#000000', t.description || '')
  }
  return id
}

function addWorkspaceTab(db, mediaTypeId, { tab_type, ref_id, label, sort_order = 0 }) {
  return db.prepare('INSERT INTO workspace_tabs (media_type_id, tab_type, ref_id, label, sort_order) VALUES (?,?,?,?,?)')
    .run(mediaTypeId, tab_type, ref_id, label, sort_order).lastInsertRowid
}

function addEncounter(db, projectId, name, syncId = crypto.randomUUID()) {
  const id = db.prepare('INSERT INTO encounters (project_id, name, folder_path, sync_id) VALUES (?,?,?,?)')
    .run(projectId, name, '', syncId).lastInsertRowid
  return { id, sync_id: syncId }
}

function addMedia(db, encounterId, name, opts = {}) {
  const syncId = opts.sync_id || crypto.randomUUID()
  const id = db.prepare('INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id) VALUES (?,?,?,?,?,?)')
    .run(encounterId, name, '', opts.file_type || 'video', opts.media_type_id || null, syncId).lastInsertRowid
  return { id, sync_id: syncId }
}

function addReview(db, mediaFileId, reviewerName, opts = {}) {
  const syncId = opts.review_sync_id || crypto.randomUUID()
  const id = db.prepare('INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id, status, notes, created_at, submitted_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(
      mediaFileId, reviewerName, opts.reviewer_uuid || null, syncId,
      opts.status || 'in_progress', opts.notes || '',
      opts.created_at || new Date().toISOString(), opts.submitted_at || null
    ).lastInsertRowid
  return { id, review_sync_id: syncId }
}

module.exports = {
  makeDb, createProject, addForm, addMediaType, addWorkspaceTab,
  addEncounter, addMedia, addReview,
}
