const { getDb, backupDb } = require('../db')
const { dialog } = require('electron')
const fs = require('fs')
const crypto = require('crypto')
const { bumpAndSync } = require('../sync')
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
    bumpAndSync(db, projectId)
    return { id: r.lastInsertRowid }
  })

  ipcMain.handle('encounters:rename', (_, projectId, encounterId, name) => {
    const db = getDb()
    // Clear folder_path — the old folder name no longer matches. Scan will re-link by name.
    db.prepare('UPDATE encounters SET name=?, folder_path=? WHERE id=?').run(name.trim(), '', encounterId)
    bumpAndSync(db, projectId)
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
    // FK cascade: encounter → media_files → reviews → timestamps/form_responses
    backupDb('pre-delete-encounter')
    db.prepare('DELETE FROM encounters WHERE id=?').run(encounterId)
    bumpAndSync(db, projectId)
    return true
  })

  // names: string[]  slots: { name, mediaTypeId }[]  (slots repeated for every encounter)
  ipcMain.handle('encounters:batchCreate', (_, projectId, names, slots) => {
    const db = getDb()
    db.transaction(() => {
      for (const name of names) {
        const enc = db.prepare(
          'INSERT INTO encounters (project_id, name, folder_path, sync_id) VALUES (?,?,?,?)'
        ).run(projectId, name.trim(), '', crypto.randomUUID())
        for (const slot of slots) {
          db.prepare(
            'INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id) VALUES (?,?,?,?,?,?)'
          ).run(enc.lastInsertRowid, slot.name, '', 'other', slot.mediaTypeId || null, crypto.randomUUID())
        }
      }
    })()
    bumpAndSync(db, projectId)
    return { created: names.length }
  })

  ipcMain.handle('encounters:exportStructure', async (_, projectId) => {
    const XLSX = require('xlsx')
    const db = getDb()
    const pid = Number(projectId)
    const project = db.prepare('SELECT name FROM projects WHERE id=?').get(pid)
    const safeName = (project?.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_')

    const { filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeName}-structure.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    })
    if (!filePath) return null

    const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=? ORDER BY name').all(pid)
    const rows = [['Encounter', 'File Name', 'Media Type', 'Reviews Required', 'Reviews Submitted', 'Link Status']]
    for (const enc of encounters) {
      const media = db.prepare(`
        SELECT mf.*, mt.name as media_type_name, mt.reviews_required
        FROM media_files mf LEFT JOIN media_types mt ON mf.media_type_id = mt.id
        WHERE mf.encounter_id=? ORDER BY mf.name
      `).all(enc.id)
      if (media.length === 0) {
        rows.push([enc.name, '', '', '', '', ''])
      } else {
        for (const m of media) {
          const submitted = db.prepare(
            'SELECT COUNT(*) as n FROM reviews WHERE media_file_id=? AND status=? AND deleted_at IS NULL'
          ).get(m.id, 'submitted').n
          const { status } = resolveLink(db, m.id, pid)
          rows.push([enc.name, m.name, m.media_type_name || '', m.reviews_required || '', submitted, status || 'not_linked'])
        }
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Structure')
    XLSX.writeFile(wb, filePath)
    return filePath
  })

  // Returns a diff of what the file describes vs what already exists in the DB.
  // Caller shows this as a preview; nothing is written until encounters:applyImport.
  ipcMain.handle('encounters:previewImport', async (_, projectId) => {
    const XLSX = require('xlsx')
    const { filePaths } = await dialog.showOpenDialog({
      filters: [{ name: 'Spreadsheet', extensions: ['xlsx', 'xls', 'csv'] }],
      properties: ['openFile'],
    })
    if (!filePaths || !filePaths[0]) return null

    const wb = XLSX.readFile(filePaths[0])
    const ws = wb.Sheets[wb.SheetNames[0]]
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

    // Group rows by encounter name — one row per media file, encounter name repeats
    const encMap = new Map() // lcName -> { displayName, files: [{fileName, mediaTypeName}] }
    for (const row of data) {
      const encName = String(row[0] || '').trim()
      if (!encName || encName.toLowerCase() === 'encounter') continue
      const fileName = String(row[1] || '').trim()
      const mediaTypeName = String(row[2] || '').trim()
      const lc = encName.toLowerCase()
      if (!encMap.has(lc)) encMap.set(lc, { displayName: encName, files: [] })
      if (fileName) encMap.get(lc).files.push({ fileName, mediaTypeName })
    }

    const db = getDb()
    const pid = Number(projectId)
    const existingEncs = db.prepare('SELECT id, name FROM encounters WHERE project_id=?').all(pid)
    const existingEncMap = new Map(existingEncs.map(e => [e.name.toLowerCase(), e]))

    const mediaTypes = db.prepare('SELECT id, name FROM media_types WHERE project_id=?').all(pid)
    const mediaTypeMap = new Map(mediaTypes.map(t => [t.name.toLowerCase(), t.id]))

    const toCreate = []  // { encName, files: [{fileName, mediaTypeName, mediaTypeId}] }
    const toAddFiles = [] // { encId, encName, files: [{fileName, mediaTypeName, mediaTypeId}] }

    for (const [lc, { displayName, files }] of encMap) {
      const enriched = files.map(f => ({
        fileName: f.fileName,
        mediaTypeName: f.mediaTypeName,
        mediaTypeId: mediaTypeMap.get(f.mediaTypeName.toLowerCase()) || null,
      }))
      const existing = existingEncMap.get(lc)
      if (!existing) {
        toCreate.push({ encName: displayName, files: enriched })
      } else {
        const existingFileNames = new Set(
          db.prepare('SELECT name FROM media_files WHERE encounter_id=?').all(existing.id).map(f => f.name.toLowerCase())
        )
        const missing = enriched.filter(f => !existingFileNames.has(f.fileName.toLowerCase()))
        if (missing.length > 0) toAddFiles.push({ encId: existing.id, encName: displayName, files: missing })
      }
    }

    return { toCreate, toAddFiles }
  })

  // Applies a previously previewed import — creates encounters and media files as described.
  ipcMain.handle('encounters:applyImport', (_, projectId, toCreate, toAddFiles) => {
    const db = getDb()
    const pid = Number(projectId)
    db.transaction(() => {
      for (const { encName, files } of toCreate) {
        const enc = db.prepare(
          'INSERT INTO encounters (project_id, name, folder_path, sync_id) VALUES (?,?,?,?)'
        ).run(pid, encName, '', crypto.randomUUID())
        for (const f of files) {
          db.prepare(
            'INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id) VALUES (?,?,?,?,?,?)'
          ).run(enc.lastInsertRowid, f.fileName, '', 'other', f.mediaTypeId || null, crypto.randomUUID())
        }
      }
      for (const { encId, files } of toAddFiles) {
        for (const f of files) {
          db.prepare(
            'INSERT INTO media_files (encounter_id, name, file_path, file_type, media_type_id, sync_id) VALUES (?,?,?,?,?,?)'
          ).run(Number(encId), f.fileName, '', 'other', f.mediaTypeId || null, crypto.randomUUID())
        }
      }
    })()
    bumpAndSync(db, pid)
    return {
      encountersCreated: toCreate.length,
      filesAdded: toCreate.reduce((s, e) => s + e.files.length, 0) + toAddFiles.reduce((s, e) => s + e.files.length, 0),
    }
  })
}
