const { getDb, backupDb } = require('../db')
const { dialog } = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { bumpAndSync } = require('../sync')
const { getBaseFolder, setBaseFolder, resolveLink, upsertLink } = require('../mediaLinks')

const VIDEO_EXTS = ['.mp4', '.mp3', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wav', '.ogg']
const DOC_EXTS = ['.pdf', '.txt', '.md', '.docx']
const ALL_EXTS = [...VIDEO_EXTS, ...DOC_EXTS]

function getFileType(ext) {
  if (VIDEO_EXTS.includes(ext)) return 'video'
  if (DOC_EXTS.includes(ext)) return 'document'
  return 'other'
}

function augmentWithLink(db, file, projectId) {
  const { status, resolved_path } = resolveLink(db, file.id, projectId)
  file.link_status = status
  file.resolved_path = resolved_path
  return file
}

// Recursively collect all media files under a directory.
// Returns [{ name, relativePath }] where relativePath is relative to root.
function collectMediaFiles(dir, root) {
  const result = []
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs)
      if (entry.isDirectory()) {
        result.push(...collectMediaFiles(abs, root))
      } else if (ALL_EXTS.includes(path.extname(entry.name).toLowerCase())) {
        result.push({ name: entry.name, relativePath: rel })
      }
    }
  } catch (_) {}
  return result
}

module.exports = function (ipcMain) {
  ipcMain.handle('media:list', (_, encounterId) => {
    const db = getDb()
    const enc = db.prepare('SELECT project_id FROM encounters WHERE id=?').get(encounterId)
    const projectId = enc?.project_id

    const files = db.prepare(`
      SELECT mf.*, mt.name as media_type_name, mt.reviews_required, mt.color as media_type_color
      FROM media_files mf
      LEFT JOIN media_types mt ON mf.media_type_id = mt.id
      WHERE mf.encounter_id=?
      ORDER BY mf.name
    `).all(encounterId)

    for (const f of files) {
      f.reviews = db.prepare('SELECT id, reviewer_name, status, created_at, submitted_at FROM reviews WHERE media_file_id=? AND deleted_at IS NULL').all(f.id)
      f.reviews_completed = f.reviews.filter(r => r.status === 'submitted').length
      augmentWithLink(db, f, projectId)
    }
    return files
  })

  ipcMain.handle('media:get', (_, id) => {
    const db = getDb()
    const file = db.prepare(`
      SELECT mf.*, mt.name as media_type_name, mt.reviews_required, mt.color as media_type_color
      FROM media_files mf
      LEFT JOIN media_types mt ON mf.media_type_id = mt.id
      WHERE mf.id=?
    `).get(id)
    if (file) {
      file.reviews = db.prepare('SELECT * FROM reviews WHERE media_file_id=? AND deleted_at IS NULL').all(file.id)
      const enc = db.prepare('SELECT project_id FROM encounters WHERE id=?').get(file.encounter_id)
      augmentWithLink(db, file, enc?.project_id)
    }
    return file
  })

  ipcMain.handle('media:updateType', (_, id, mediaTypeId) => {
    const db = getDb()
    db.prepare('UPDATE media_files SET media_type_id=? WHERE id=?').run(mediaTypeId || null, id)
    const mf = db.prepare('SELECT encounter_id FROM media_files WHERE id=?').get(id)
    const enc = mf ? db.prepare('SELECT project_id FROM encounters WHERE id=?').get(mf.encounter_id) : null
    if (enc?.project_id) {
      bumpAndSync(db, enc.project_id)
    }
    return true
  })

  ipcMain.handle('media:create', (_, projectId, encounterId, name) => {
    const db = getDb()
    const result = db.prepare(
      'INSERT INTO media_files (encounter_id, name, file_path, file_type, sync_id) VALUES (?, ?, ?, ?, ?)'
    ).run(encounterId, name.trim(), '', 'other', crypto.randomUUID())
    bumpAndSync(db, projectId)
    return { id: result.lastInsertRowid }
  })

  ipcMain.handle('media:getUrl', (_, filePath) => {
    return `localfile://${filePath}`
  })

  ipcMain.handle('fs:selectFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  ipcMain.handle('fs:scanMediaFolder', (_, folderPath, projectId) => {
    const db = getDb()
    if (!fs.existsSync(folderPath)) return { error: 'Folder not found' }

    const encounterDirs = fs.readdirSync(folderPath, { withFileTypes: true }).filter(d => d.isDirectory())

    let encountersAdded = 0
    let encountersLinked = 0
    let filesAdded = 0
    let filesLinked = 0

    const tx = db.transaction(() => {
      for (const dir of encounterDirs) {
        const encounterPath = path.join(folderPath, dir.name)
        let enc = db.prepare('SELECT * FROM encounters WHERE project_id=? AND folder_path=?').get(projectId, encounterPath)
        if (!enc) {
          const byName = db.prepare('SELECT * FROM encounters WHERE project_id=? AND name=?').get(projectId, dir.name)
          if (byName) {
            db.prepare('UPDATE encounters SET folder_path=? WHERE id=?').run(encounterPath, byName.id)
            enc = byName
            encountersLinked++
          } else {
            const r = db.prepare('INSERT INTO encounters (project_id, name, folder_path, sync_id) VALUES (?,?,?,?)').run(projectId, dir.name, encounterPath, crypto.randomUUID())
            enc = { id: r.lastInsertRowid }
            encountersAdded++
          }
        }

        const files = fs.readdirSync(encounterPath, { withFileTypes: true }).filter(f => f.isFile())
        for (const file of files) {
          const ext = path.extname(file.name).toLowerCase()
          const fileType = getFileType(ext)
          const filePath = path.join(encounterPath, file.name)
          const existing = db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND file_path=?').get(enc.id, filePath)
            || db.prepare('SELECT id FROM media_files WHERE encounter_id=? AND name=?').get(enc.id, file.name)
          if (existing) {
            db.prepare('UPDATE media_files SET file_path=?, file_type=? WHERE id=?').run(filePath, fileType, existing.id)
            upsertLink(db, existing.id, filePath, false)
            filesLinked++
          } else {
            const r = db.prepare('INSERT INTO media_files (encounter_id, name, file_path, file_type, sync_id) VALUES (?,?,?,?,?)').run(enc.id, file.name, filePath, fileType, crypto.randomUUID())
            upsertLink(db, r.lastInsertRowid, filePath, false)
            filesAdded++
          }
        }
      }
    })
    tx()

    if (encountersAdded > 0 || filesAdded > 0) {
      bumpAndSync(db, projectId)
    }

    const stillUnlinked = db.prepare(`
      SELECT COUNT(*) as n FROM media_files mf
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE e.project_id=? AND NOT EXISTS (SELECT 1 FROM media_file_links l WHERE l.media_file_id=mf.id AND l.not_applicable=0 AND l.local_path IS NOT NULL)
    `).get(projectId).n

    const allLinked = db.prepare(`
      SELECT mf.id, l.local_path, l.is_relative FROM media_files mf
      JOIN encounters e ON mf.encounter_id = e.id
      JOIN media_file_links l ON l.media_file_id = mf.id
      WHERE e.project_id=? AND l.not_applicable=0 AND l.local_path IS NOT NULL
    `).all(projectId)
    const stillBroken = allLinked.filter(f => {
      const fullPath = f.is_relative ? path.join(getBaseFolder(projectId) || '', f.local_path) : f.local_path
      return !fs.existsSync(fullPath)
    }).length

    const directMediaFiles = fs.readdirSync(folderPath, { withFileTypes: true })
      .filter(f => f.isFile() && ALL_EXTS.includes(path.extname(f.name).toLowerCase()))
      .length

    return { encountersAdded, encountersLinked, filesAdded, filesLinked, directMediaFiles, totalSubfolders: encounterDirs.length, stillUnlinked, stillBroken }
  })

  ipcMain.handle('media:countReviews', (_, mediaFileId) => {
    const db = getDb()
    return db.prepare('SELECT COUNT(*) as n FROM reviews WHERE media_file_id=? AND deleted_at IS NULL').get(mediaFileId).n
  })

  ipcMain.handle('media:move', (_, projectId, mediaFileId, newEncounterId) => {
    const db = getDb()
    db.prepare('UPDATE media_files SET encounter_id=? WHERE id=?').run(newEncounterId, mediaFileId)
    bumpAndSync(db, projectId)
    return true
  })

  ipcMain.handle('media:rename', (_, projectId, mediaFileId, name) => {
    const db = getDb()
    db.prepare('UPDATE media_files SET name=? WHERE id=?').run(name.trim(), mediaFileId)
    bumpAndSync(db, projectId)
    return true
  })

  ipcMain.handle('media:healthCheck', (_, projectId) => {
    const db = getDb()
    const encounters = db.prepare('SELECT id, name FROM encounters WHERE project_id=?').all(projectId)
    let unlinked = 0, broken = 0, ok = 0, notApplicable = 0
    const issues = []
    for (const enc of encounters) {
      const files = db.prepare('SELECT id, name FROM media_files WHERE encounter_id=?').all(enc.id)
      for (const f of files) {
        const { status } = resolveLink(db, f.id, projectId)
        if (status === 'linked') ok++
        else if (status === 'not_applicable') notApplicable++
        else if (status === 'missing') { broken++; issues.push({ encounter: enc.name, file: f.name, reason: 'missing' }) }
        else { unlinked++; issues.push({ encounter: enc.name, file: f.name, reason: 'unlinked' }) }
      }
    }
    const baseFolder = getBaseFolder(projectId)
    return { unlinked, broken, ok, notApplicable, total: unlinked + broken + ok + notApplicable, hasBaseFolder: !!baseFolder, issues }
  })

  ipcMain.handle('media:deleteFile', (_, projectId, mediaFileId) => {
    const db = getDb()
    // FK cascade: media_file → reviews → timestamps/form_responses
    backupDb('pre-delete-media')
    db.prepare('DELETE FROM media_files WHERE id=?').run(mediaFileId)
    bumpAndSync(db, projectId)
    return true
  })

  // ── File Linking ─────────────────────────────────────────────────────────────

  ipcMain.handle('media:getBaseFolder', (_, projectId) => getBaseFolder(projectId))

  ipcMain.handle('media:setBaseFolder', (_, projectId, folderPath) => {
    setBaseFolder(projectId, folderPath)
    return true
  })

  ipcMain.handle('media:autolink', (_, projectId) => {
    const db = getDb()
    const baseFolder = getBaseFolder(projectId)
    if (!baseFolder || !fs.existsSync(baseFolder)) return { error: 'Base folder not set or not found' }

    const allFoundFiles = collectMediaFiles(baseFolder, baseFolder)

    const projectFiles = db.prepare(`
      SELECT mf.id, mf.name, e.name as encounter_name FROM media_files mf
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE e.project_id = ?
    `).all(projectId)

    let linked = 0, skipped = 0, ambiguous = 0, notFound = 0

    const tx = db.transaction(() => {
      for (const mf of projectFiles) {
        const { status } = resolveLink(db, mf.id, projectId)
        if (status === 'linked' || status === 'not_applicable') { skipped++; continue }

        const mfNameNoExt = path.basename(mf.name, path.extname(mf.name)).toLowerCase()
        const mfNameFull = mf.name.toLowerCase()
        const encNameLower = mf.encounter_name.toLowerCase()

        function nameMatches(f) {
          const fNoExt = path.basename(f.name, path.extname(f.name)).toLowerCase()
          const fFull = f.name.toLowerCase()
          return fFull === mfNameFull || fNoExt === mfNameNoExt || fNoExt === mfNameFull || fFull === mfNameNoExt
        }

        // Pass 1: prefer files inside a subfolder whose name matches the encounter name
        const inEncounterFolder = allFoundFiles.filter(f => {
          const parts = f.relativePath.split(path.sep)
          return parts.length >= 2 && parts[0].toLowerCase() === encNameLower && nameMatches(f)
        })
        if (inEncounterFolder.length === 1) {
          upsertLink(db, mf.id, inEncounterFolder[0].relativePath, true)
          linked++
          continue
        }

        // Pass 2: flat filename match across all found files
        const anywhere = allFoundFiles.filter(nameMatches)
        if (anywhere.length === 1) {
          upsertLink(db, mf.id, anywhere[0].relativePath, true)
          linked++
        } else if (inEncounterFolder.length > 1 || anywhere.length > 1) {
          ambiguous++
        } else {
          notFound++
        }
      }
    })
    tx()

    return { linked, skipped, ambiguous, notFound }
  })

  ipcMain.handle('media:setLink', (_, mediaFileId, projectId, localPath) => {
    const db = getDb()
    const baseFolder = getBaseFolder(projectId)

    let storedPath = localPath
    let isRelative = false

    if (baseFolder) {
      const normalBase = baseFolder.endsWith(path.sep) ? baseFolder : baseFolder + path.sep
      if (localPath.startsWith(normalBase)) {
        storedPath = path.relative(baseFolder, localPath)
        isRelative = true
      }
    }

    upsertLink(db, mediaFileId, storedPath, isRelative)
    return true
  })

  ipcMain.handle('media:markNotApplicable', (_, mediaFileId) => {
    const db = getDb()
    db.prepare(`
      INSERT INTO media_file_links (media_file_id, local_path, is_relative, not_applicable)
      VALUES (?, NULL, 0, 1)
      ON CONFLICT(media_file_id) DO UPDATE SET not_applicable=1, linked_at=datetime('now')
    `).run(mediaFileId)
    return true
  })

  ipcMain.handle('media:clearLink', (_, mediaFileId) => {
    const db = getDb()
    db.prepare('DELETE FROM media_file_links WHERE media_file_id=?').run(mediaFileId)
    return true
  })

  ipcMain.handle('media:browseFile', async (_, mediaFileId) => {
    const db = getDb()
    const mf = db.prepare('SELECT name FROM media_files WHERE id=?').get(mediaFileId)
    const result = await dialog.showOpenDialog({
      title: `Locate: ${mf?.name || 'media file'}`,
      properties: ['openFile'],
      filters: [
        { name: 'Media Files', extensions: ALL_EXTS.map(e => e.slice(1)) },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })
}
