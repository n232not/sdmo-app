const { getDb } = require('../db')
const crypto = require('crypto')
const { bumpConfigVersion, scheduleSync } = require('../sync')
const { resolveLink } = require('../mediaLinks')

module.exports = function (ipcMain) {
  ipcMain.handle('encounters:list', (_, projectId) => {
    const db = getDb()
    const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=? ORDER BY name').all(projectId)

    for (const enc of encounters) {
      const media = db.prepare('SELECT mf.*, mt.name as media_type_name, mt.reviews_required, mt.color as media_type_color FROM media_files mf LEFT JOIN media_types mt ON mf.media_type_id = mt.id WHERE mf.encounter_id=? ORDER BY mf.name').all(enc.id)
      for (const m of media) {
        const reviews = db.prepare('SELECT id, reviewer_name, status, created_at, submitted_at FROM reviews WHERE media_file_id=? AND deleted_at IS NULL').all(m.id)
        m.reviews = reviews
        m.reviews_completed = reviews.filter(r => r.status === 'submitted').length
        const { status, resolved_path } = resolveLink(db, m.id, enc.project_id)
        m.link_status = status
        m.resolved_path = resolved_path
      }
      enc.media = media
      enc.completed = media.length > 0 && media.every(m =>
        m.reviews_required && m.reviews_completed >= m.reviews_required
      )
    }
    return encounters
  })

  ipcMain.handle('encounters:get', (_, id) => {
    const db = getDb()
    return db.prepare('SELECT * FROM encounters WHERE id=?').get(id)
  })

  ipcMain.handle('encounters:create', (_, projectId, name) => {
    const db = getDb()
    const r = db.prepare('INSERT INTO encounters (project_id, name, folder_path, sync_id) VALUES (?,?,?,?)').run(projectId, name.trim(), '', crypto.randomUUID())
    bumpConfigVersion(db, projectId)
    scheduleSync(projectId)
    return { id: r.lastInsertRowid }
  })

  ipcMain.handle('encounters:rename', (_, projectId, encounterId, name) => {
    const db = getDb()
    // Clear folder_path — the old folder name no longer matches. Scan will re-link by name.
    db.prepare('UPDATE encounters SET name=?, folder_path=? WHERE id=?').run(name.trim(), '', encounterId)
    bumpConfigVersion(db, projectId)
    scheduleSync(projectId)
    return true
  })

  ipcMain.handle('encounters:countReviews', (_, encounterId) => {
    const db = getDb()
    return db.prepare(`
      SELECT COUNT(*) as n FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      WHERE mf.encounter_id=? AND r.deleted_at IS NULL
    `).get(encounterId).n
  })

  ipcMain.handle('encounters:delete', (_, projectId, encounterId) => {
    const db = getDb()
    const tx = db.transaction(() => {
      const files = db.prepare('SELECT id FROM media_files WHERE encounter_id=?').all(encounterId)
      for (const f of files) {
        db.prepare('DELETE FROM timestamps WHERE review_id IN (SELECT id FROM reviews WHERE media_file_id=?)').run(f.id)
        db.prepare('DELETE FROM form_responses WHERE review_id IN (SELECT id FROM reviews WHERE media_file_id=?)').run(f.id)
        db.prepare('DELETE FROM reviews WHERE media_file_id=?').run(f.id)
      }
      db.prepare('DELETE FROM media_files WHERE encounter_id=?').run(encounterId)
      db.prepare('DELETE FROM encounters WHERE id=?').run(encounterId)
    })
    tx()
    bumpConfigVersion(db, projectId)
    scheduleSync(projectId)
    return true
  })
}
