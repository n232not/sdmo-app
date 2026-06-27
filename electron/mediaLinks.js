const path = require('path')
const fs = require('fs')
const { getSettings, saveSettings } = require('./settings')

function getBaseFolder(projectId) {
  const s = getSettings()
  return s.media_base_folders?.[String(projectId)] || null
}

function setBaseFolder(projectId, folderPath) {
  const s = getSettings()
  const media_base_folders = { ...(s.media_base_folders || {}), [String(projectId)]: folderPath }
  saveSettings({ media_base_folders })
}

function resolveLink(db, mediaFileId, projectId) {
  const link = db.prepare('SELECT * FROM media_file_links WHERE media_file_id=?').get(mediaFileId)
  if (!link) return { status: 'not_linked', resolved_path: null }
  if (link.not_applicable) return { status: 'not_applicable', resolved_path: null }

  let fullPath = link.local_path
  if (link.is_relative) {
    const baseFolder = getBaseFolder(projectId)
    if (!baseFolder) return { status: 'missing', resolved_path: null }
    fullPath = path.join(baseFolder, link.local_path)
  }

  if (!fullPath) return { status: 'not_linked', resolved_path: null }
  if (fs.existsSync(fullPath)) return { status: 'linked', resolved_path: fullPath }
  return { status: 'missing', resolved_path: fullPath }
}

function upsertLink(db, mediaFileId, localPath, isRelative) {
  db.prepare(`
    INSERT INTO media_file_links (media_file_id, local_path, is_relative, not_applicable)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(media_file_id) DO UPDATE SET
      local_path = excluded.local_path,
      is_relative = excluded.is_relative,
      not_applicable = 0,
      linked_at = datetime('now')
  `).run(mediaFileId, localPath, isRelative ? 1 : 0)
}

module.exports = { getBaseFolder, setBaseFolder, resolveLink, upsertLink }
