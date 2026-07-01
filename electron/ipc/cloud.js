const { getDb } = require('../db')
const { saveSettings } = require('../settings')
const { getOrCreateUUID, getProjectName } = require('../settings')
const { doCloudSync } = require('../sync')

// Track active auth servers so we can cancel them
let _activeAuthServer = null
function setActiveAuthServer(server) { _activeAuthServer = server }

function parseFolderLink(provider, link) {
  if (provider === 'googledrive') {
    // Formats:
    // https://drive.google.com/drive/folders/FOLDER_ID
    // https://drive.google.com/drive/folders/FOLDER_ID?usp=sharing
    // https://drive.google.com/open?id=FOLDER_ID
    const folderMatch = link.match(/\/folders\/([a-zA-Z0-9_-]+)/)
    if (folderMatch) return folderMatch[1]
    const idMatch = link.match(/[?&]id=([a-zA-Z0-9_-]+)/)
    if (idMatch) return idMatch[1]
    // Raw folder ID (no URL)
    if (/^[a-zA-Z0-9_-]{25,}$/.test(link.trim())) return link.trim()
  }
  if (provider === 'onedrive') {
    const idMatch = link.match(/[?&]id=([^&]+)/)
    if (idMatch) return decodeURIComponent(idMatch[1])
    if (/^[A-Z0-9!]+$/i.test(link.trim())) return link.trim()
  }
  return null
}

module.exports = function (ipcMain) {
  ipcMain.handle('cloud:connectOneDrive', async () => {
    try {
      const onedrive = require('../cloud/onedrive')
      const result = await onedrive.startAuth((server) => setActiveAuthServer(server))
      setActiveAuthServer(null)
      return { ok: true, email: result.email }
    } catch (e) {
      setActiveAuthServer(null)
      return { error: e.message }
    }
  })

  ipcMain.handle('cloud:connectGoogleDrive', async () => {
    try {
      const googledrive = require('../cloud/googledrive')
      const result = await googledrive.startAuth((server) => setActiveAuthServer(server))
      setActiveAuthServer(null)
      return { ok: true, email: result.email }
    } catch (e) {
      setActiveAuthServer(null)
      return { error: e.message }
    }
  })

  ipcMain.handle('cloud:pickGoogleDriveFolder', async () => {
    try {
      const googledrive = require('../cloud/googledrive')
      const result = await googledrive.pickFolder((server) => setActiveAuthServer(server))
      setActiveAuthServer(null)
      return { ok: true, email: result.email || '', folder: result.folder }
    } catch (e) {
      setActiveAuthServer(null)
      return { error: e.message }
    }
  })

  ipcMain.handle('cloud:pickGoogleDriveFiles', async (_, fileIds) => {
    try {
      const googledrive = require('../cloud/googledrive')
      const result = await googledrive.pickFiles((server) => setActiveAuthServer(server), {
        fileIds: Array.isArray(fileIds) ? fileIds : [],
        allowMultiple: true,
        mimeTypes: 'application/json',
      })
      setActiveAuthServer(null)
      return { ok: true, files: result.files }
    } catch (e) {
      setActiveAuthServer(null)
      return { error: e.message }
    }
  })

  ipcMain.handle('cloud:cancelAuth', () => {
    if (_activeAuthServer) {
      try {
        // Force-destroy all open sockets so the port releases immediately
        _activeAuthServer.closeAllConnections?.()
        _activeAuthServer.close()
      } catch {}
      _activeAuthServer = null
    }
    return { ok: true }
  })

  ipcMain.handle('cloud:disconnect', (_, projectId) => {
    try {
      const db = getDb()
      const project = db.prepare('SELECT cloud_provider FROM projects WHERE id=?').get(projectId)
      if (project?.cloud_provider) {
        const { getAdapter } = require('../cloud/cloudSync')
        try { getAdapter(project.cloud_provider).disconnect() } catch {}
      }
      db.prepare("UPDATE projects SET cloud_provider=NULL, cloud_folder_id=NULL WHERE id=?").run(projectId)
      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('cloud:status', (_, projectId) => {
    try {
      const db = getDb()
      const project = db.prepare('SELECT cloud_provider, cloud_folder_id FROM projects WHERE id=?').get(projectId)
      const provider = project?.cloud_provider || null
      if (!provider) return { provider: null, connected: false }

      const { getAdapter } = require('../cloud/cloudSync')
      const adapterStatus = getAdapter(provider).getStatus()
      return {
        provider,
        cloudFolderId: project?.cloud_folder_id || null,
        ...adapterStatus,
      }
    } catch (e) {
      return { provider: null, connected: false, error: e.message }
    }
  })

  ipcMain.handle('cloud:listFolders', async (_, provider, parentId) => {
    try {
      const { getAdapter } = require('../cloud/cloudSync')
      const folders = await getAdapter(provider).listFolders(parentId || null)
      return { ok: true, folders }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('cloud:selectFolder', (_, projectId, provider, folderId, folderName) => {
    try {
      const db = getDb()
      db.prepare("UPDATE projects SET cloud_provider=?, cloud_folder_id=?, sync_folder=NULL WHERE id=?")
        .run(provider, folderId, projectId)
      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('cloud:resolveFolderLink', async (_, provider, link) => {
    try {
      let folderId = parseFolderLink(provider, link)
      let folderName = ''
      let extractedFromOneDriveShare = false
      if (!folderId && provider === 'onedrive') {
        const onedrive = require('../cloud/onedrive')
        folderId = await onedrive.extractFolderIdFromSharingLink(link)
        extractedFromOneDriveShare = !!folderId
        if (!folderId) {
          const resolved = await onedrive.resolveFolderLink(link)
          folderId = resolved.id
          folderName = resolved.name || ''
        }
      }
      if (!folderId) return { error: 'Could not extract folder ID from that link. Make sure you copied the full sharing URL.' }
      // Verify the folder is accessible
      const { getAdapter } = require('../cloud/cloudSync')
      const adapter = getAdapter(provider)
      try {
        await adapter.listFiles(folderId) // throws if not accessible
      } catch (verifyError) {
        if (provider === 'onedrive' && extractedFromOneDriveShare) {
          try {
            const onedrive = require('../cloud/onedrive')
            const resolved = await onedrive.resolveFolderLink(link)
            folderId = resolved.id
            folderName = resolved.name || folderName
            await adapter.listFiles(folderId)
          } catch (sharedError) {
            throw new Error(
              'OneDrive found a folder ID in that shared link, but Microsoft Graph cannot list it with SDMo\'s non-admin OneDrive permission. ' +
              'Open the link in OneDrive with the same account, choose "Add shortcut to My files", then select that shortcut folder from SDMo\'s OneDrive folder picker. ' +
              'You can also use Local Folder sync with the OneDrive desktop-synced folder. ' +
              `Details: ${sharedError.message || verifyError.message}`
            )
          }
        } else {
          throw verifyError
        }
      }
      return { ok: true, folderId, folderName }
    } catch (e) {
      return { error: `Could not access folder: ${e.message}` }
    }
  })

  ipcMain.handle('cloud:syncNow', async (_, projectId, options = {}) => {
    try {
      const db = getDb()
      const project = db.prepare('SELECT cloud_provider, cloud_folder_id FROM projects WHERE id=?').get(projectId)
      if (!project?.cloud_provider || !project?.cloud_folder_id) return { error: 'Cloud sync not configured' }
      const uuid = getOrCreateUUID()
      const name = getProjectName(projectId) || uuid
      await doCloudSync(db, projectId, project.cloud_provider, project.cloud_folder_id, uuid, name, options || {})
      return { ok: true }
    } catch (e) {
      console.error('[cloud:syncNow] error:', e.message, e.stack)
      return { error: e.message }
    }
  })
}
