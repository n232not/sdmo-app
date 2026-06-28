const { getDb } = require('../db')
const { scheduleSyncForReview } = require('../sync')
const { getOrCreateUUID } = require('../settings')

module.exports = function (ipcMain) {
  ipcMain.handle('reviews:list', (_, mediaFileId) => {
    const db = getDb()
    return db.prepare('SELECT * FROM reviews WHERE media_file_id=? AND deleted_at IS NULL ORDER BY created_at').all(mediaFileId)
  })

  ipcMain.handle('reviews:create', (_, data) => {
    const db = getDb()
    const crypto = require('crypto')
    const uuid = getOrCreateUUID()
    const r = db.prepare('INSERT INTO reviews (media_file_id, reviewer_name, reviewer_uuid, review_sync_id) VALUES (?,?,?,?)').run(data.media_file_id, data.reviewer_name, uuid, crypto.randomUUID())
    const review = db.prepare('SELECT * FROM reviews WHERE id=?').get(r.lastInsertRowid)
    scheduleSyncForReview(r.lastInsertRowid)
    return review
  })

  ipcMain.handle('reviews:get', (_, id) => {
    const db = getDb()
    const review = db.prepare('SELECT * FROM reviews WHERE id=?').get(id)
    if (!review) return null
    review.timestamps = db.prepare('SELECT * FROM timestamps WHERE review_id=? ORDER BY time_seconds').all(id)
    review.form_responses = db.prepare('SELECT * FROM form_responses WHERE review_id=?').all(id)
    for (const fr of review.form_responses) {
      fr.responses = JSON.parse(fr.responses)
    }
    return review
  })

  ipcMain.handle('reviews:submit', (_, id, data) => {
    const db = getDb()
    db.prepare("UPDATE reviews SET status='submitted', notes=?, submitted_at=datetime('now') WHERE id=?").run(data.notes || '', id)
    scheduleSyncForReview(id)
    return true
  })

  ipcMain.handle('reviews:delete', (_, id) => {
    const db = getDb()
    const row = db.prepare(`
      SELECT r.reviewer_name, r.review_sync_id, mf.name as media_name, e.name as encounter_name, e.project_id
      FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE r.id=?
    `).get(id)
    db.prepare("UPDATE reviews SET deleted_at=datetime('now') WHERE id=?").run(id)
    if (row) {
      db.prepare('INSERT OR IGNORE INTO deleted_reviews (project_id, encounter_name, media_name, reviewer_name, review_sync_id) VALUES (?,?,?,?,?)')
        .run(row.project_id, row.encounter_name, row.media_name, row.reviewer_name, row.review_sync_id || null)
      const { scheduleSync } = require('../sync')
      scheduleSync(row.project_id)
    }
    return true
  })

  ipcMain.handle('reviews:restore', (_, id) => {
    const db = getDb()
    const row = db.prepare(`
      SELECT r.reviewer_name, r.review_sync_id, mf.name as media_name, e.name as encounter_name, e.project_id
      FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE r.id=?
    `).get(id)
    db.prepare("UPDATE reviews SET deleted_at=NULL, restored_at=datetime('now') WHERE id=?").run(id)
    if (row) {
      if (row.review_sync_id) {
        db.prepare('DELETE FROM deleted_reviews WHERE project_id=? AND review_sync_id=?').run(row.project_id, row.review_sync_id)
      } else {
        db.prepare('DELETE FROM deleted_reviews WHERE project_id=? AND encounter_name=? AND media_name=? AND reviewer_name=?')
          .run(row.project_id, row.encounter_name, row.media_name, row.reviewer_name)
      }
      const { scheduleSync } = require('../sync')
      scheduleSync(row.project_id)
    }
    return true
  })

  ipcMain.handle('reviews:listDeleted', (_, projectId) => {
    const db = getDb()
    return db.prepare(`
      SELECT r.id, r.reviewer_name, r.status, r.created_at, r.deleted_at,
             mf.name as media_name, e.name as encounter_name
      FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE e.project_id=? AND r.deleted_at IS NOT NULL
      ORDER BY r.deleted_at DESC
    `).all(projectId)
  })

  // Return distinct reviewer names that this machine's UUID has used for a project
  ipcMain.handle('reviews:getMachineReviewNames', (_, projectId) => {
    const db = getDb()
    const uuid = getOrCreateUUID()
    return db.prepare(`
      SELECT DISTINCT r.reviewer_name FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE e.project_id = ? AND r.reviewer_uuid = ? AND r.deleted_at IS NULL
    `).all(projectId, uuid).map(r => r.reviewer_name)
  })

  ipcMain.handle('reviews:unsubmit', (_, id) => {
    const db = getDb()
    db.prepare("UPDATE reviews SET status='in_progress', submitted_at=NULL WHERE id=?").run(id)
    scheduleSyncForReview(id)
    return true
  })

  ipcMain.handle('reviews:saveTimestamp', (_, reviewId, data) => {
    const db = getDb()
    let resultId
    if (data.id) {
      db.prepare('UPDATE timestamps SET time_seconds=?, tag_id=?, tag_label=?, notes=? WHERE id=?')
        .run(data.time_seconds, data.tag_id || null, data.tag_label || null, data.notes || '', data.id)
      resultId = data.id
    } else {
      const r = db.prepare('INSERT INTO timestamps (review_id, time_seconds, tag_id, tag_label, notes) VALUES (?,?,?,?,?)')
        .run(reviewId, data.time_seconds, data.tag_id || null, data.tag_label || null, data.notes || '')
      resultId = r.lastInsertRowid
    }
    scheduleSyncForReview(reviewId)
    return resultId
  })

  ipcMain.handle('reviews:updateTimestamp', (_, id, data) => {
    const db = getDb()
    db.prepare('UPDATE timestamps SET tag_id=?, tag_label=?, notes=? WHERE id=?')
      .run(data.tag_id || null, data.tag_label || null, data.notes || '', id)
    const ts = db.prepare('SELECT review_id FROM timestamps WHERE id=?').get(id)
    if (ts) scheduleSyncForReview(ts.review_id)
    return true
  })

  ipcMain.handle('reviews:deleteTimestamp', (_, id) => {
    const db = getDb()
    const ts = db.prepare('SELECT review_id FROM timestamps WHERE id=?').get(id)
    db.prepare('DELETE FROM timestamps WHERE id=?').run(id)
    if (ts) scheduleSyncForReview(ts.review_id)
    return true
  })

  ipcMain.handle('reviews:saveFormResponse', (_, reviewId, data) => {
    const db = getDb()
    const responses = typeof data.responses === 'string' ? data.responses : JSON.stringify(data.responses)
    const existing = db.prepare('SELECT id FROM form_responses WHERE review_id=? AND form_id=?').get(reviewId, data.form_id)
    if (existing) {
      db.prepare("UPDATE form_responses SET responses=?, updated_at=datetime('now') WHERE id=?").run(responses, existing.id)
    } else {
      db.prepare('INSERT INTO form_responses (review_id, form_id, responses) VALUES (?,?,?)').run(reviewId, data.form_id, responses)
    }
    scheduleSyncForReview(reviewId)
    return true
  })

}
