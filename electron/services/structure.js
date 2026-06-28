const { randomUUID } = require('crypto')
const { backupDb } = require('../db')
const { bumpAndSync, recordStructureTombstone } = require('../sync')

function saveMediaType(db, projectId, data) {
  let mediaTypeId = data.id || null
  db.transaction(() => {
    if (mediaTypeId) {
      db.prepare("UPDATE media_types SET name=?, reviews_required=?, allow_custom_tags=?, color=?, updated_at=datetime('now') WHERE id=?")
        .run(data.name, data.reviews_required, data.allow_custom_tags ? 1 : 0, data.color, mediaTypeId)
      db.prepare('DELETE FROM timestamp_tags WHERE media_type_id=?').run(mediaTypeId)
      db.prepare('DELETE FROM workspace_tabs WHERE media_type_id=?').run(mediaTypeId)
    } else {
      const r = db.prepare("INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color, sync_id, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))")
        .run(projectId, data.name, data.reviews_required || 1, data.allow_custom_tags ? 1 : 0, data.color || '#6366f1', randomUUID())
      mediaTypeId = r.lastInsertRowid
    }

    const insertTag = db.prepare('INSERT INTO timestamp_tags (media_type_id, label, color, description) VALUES (?,?,?,?)')
    for (const tag of (data.tags || [])) {
      insertTag.run(mediaTypeId, tag.label, tag.color || '#6366f1', tag.description || '')
    }

    const insertTab = db.prepare('INSERT INTO workspace_tabs (media_type_id, tab_type, ref_id, label, sort_order) VALUES (?,?,?,?,?)')
    for (let i = 0; i < (data.workspace_tabs || []).length; i++) {
      const tab = data.workspace_tabs[i]
      insertTab.run(mediaTypeId, tab.tab_type, tab.ref_id, tab.label, i)
    }
  })()
  bumpAndSync(db, projectId)
  return mediaTypeId
}

function deleteMediaType(db, projectId, id) {
  backupDb('pre-delete-mediatype')
  recordStructureTombstone(db, projectId, 'media_type', id)
  db.prepare('DELETE FROM media_types WHERE id=?').run(id)
  bumpAndSync(db, projectId)
  return true
}

function saveForm(db, projectId, data) {
  const schema = typeof data.schema === 'string' ? data.schema : JSON.stringify(data.schema)
  if (data.id) {
    db.prepare("UPDATE forms SET name=?, schema=?, updated_at=datetime('now') WHERE id=?").run(data.name, schema, data.id)
    bumpAndSync(db, projectId)
    return data.id
  }
  const r = db.prepare("INSERT INTO forms (project_id, name, schema, sync_id, updated_at) VALUES (?,?,?,?,datetime('now'))")
    .run(projectId, data.name, schema, randomUUID())
  bumpAndSync(db, projectId)
  return r.lastInsertRowid
}

function deleteForm(db, projectId, id) {
  backupDb('pre-delete-form')
  recordStructureTombstone(db, projectId, 'form', id)
  db.prepare('DELETE FROM forms WHERE id=?').run(id)
  bumpAndSync(db, projectId)
  return true
}

function saveInstruction(db, projectId, data) {
  if (data.id) {
    db.prepare("UPDATE instructions SET name=?, content=?, content_type=?, file_path=?, updated_at=datetime('now') WHERE id=?")
      .run(data.name, data.content || '', data.content_type || 'markdown', data.file_path || null, data.id)
    bumpAndSync(db, projectId)
    return data.id
  }
  const r = db.prepare("INSERT INTO instructions (project_id, name, content, content_type, file_path, sync_id, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))")
    .run(projectId, data.name, data.content || '', data.content_type || 'markdown', data.file_path || null, randomUUID())
  bumpAndSync(db, projectId)
  return r.lastInsertRowid
}

function deleteInstruction(db, projectId, id) {
  backupDb('pre-delete-instruction')
  recordStructureTombstone(db, projectId, 'instruction', id)
  db.prepare('DELETE FROM instructions WHERE id=?').run(id)
  bumpAndSync(db, projectId)
  return true
}

module.exports = {
  saveMediaType,
  deleteMediaType,
  saveForm,
  deleteForm,
  saveInstruction,
  deleteInstruction,
}
