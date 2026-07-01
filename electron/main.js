const { app, BrowserWindow, ipcMain, protocol, dialog, Menu } = require('electron')
const path = require('path')
const fs = require('fs')
const { validateIpcArgs } = require('./ipc/contracts')

app.setName('SDMo')

protocol.registerSchemesAsPrivileged([
  { scheme: 'localfile', privileges: { standard: true, secure: true, stream: true } },
])

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow
const workspaceWindows = {} // reviewId string → BrowserWindow

function getWindowIconPath() {
  return path.join(__dirname, '../build/icon.png')
}

// Wrap ipcMain.handle so every handler across all IPC modules gets a try/catch.
// Errors are logged in the main process (for debuggability) and re-thrown so the
// renderer's awaited promise rejects with the original message instead of a generic
// "Error invoking remote method" string. Applied once, before modules register.
function wrapIpcMain(target) {
  const origHandle = target.handle.bind(target)
  target.handle = (channel, fn) => {
    origHandle(channel, async (...args) => {
      try {
        validateIpcArgs(channel, args.slice(1))
        return await fn(...args)
      } catch (e) {
        console.error(`[ipc] ${channel} failed:`, e?.stack || e?.message || e)
        throw e
      }
    })
  }
  return target
}
wrapIpcMain(ipcMain)

function normalizePath(filePath) {
  try {
    return path.resolve(filePath)
  } catch {
    return null
  }
}

function isKnownLocalFile(filePath) {
  const requested = normalizePath(filePath)
  if (!requested || !fs.existsSync(requested)) return false

  try {
    const { getDb } = require('./db')
    const { getBaseFolder } = require('./mediaLinks')
    const db = getDb()

    const direct = db.prepare(`
      SELECT file_path FROM media_files WHERE file_path IS NOT NULL AND file_path != ''
      UNION
      SELECT file_path FROM instructions WHERE file_path IS NOT NULL AND file_path != ''
    `).all()
    if (direct.some(row => normalizePath(row.file_path) === requested)) return true

    const links = db.prepare(`
      SELECT l.local_path, l.is_relative, e.project_id
      FROM media_file_links l
      JOIN media_files mf ON l.media_file_id = mf.id
      JOIN encounters e ON mf.encounter_id = e.id
      WHERE l.not_applicable=0 AND l.local_path IS NOT NULL AND l.local_path != ''
    `).all()
    for (const link of links) {
      const fullPath = link.is_relative
        ? path.join(getBaseFolder(link.project_id) || '', link.local_path)
        : link.local_path
      if (normalizePath(fullPath) === requested) return true
    }
  } catch (e) {
    console.error('[main] localfile allowlist check failed:', e?.message || e)
  }

  return false
}

// Last-resort process guards so a stray async error (timers, cloud callbacks, etc.)
// logs instead of silently killing the app.
process.on('uncaughtException', (e) => {
  console.error('[main] uncaughtException:', e?.stack || e?.message || e)
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason?.stack || reason?.message || reason)
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// Register IPC handlers before app is ready so they're available immediately
try {
  require('./ipc/projects')(ipcMain)
  require('./ipc/encounters')(ipcMain)
  require('./ipc/reviews')(ipcMain)
  require('./ipc/media')(ipcMain)
  require('./ipc/cloud')(ipcMain)
  console.log('[main] IPC handlers registered')
} catch (e) {
  console.error('[main] Failed to register IPC handlers:', e)
}

app.whenReady().then(() => {
  try { require('./diagnostics').setupFileLogging() } catch (_) {}
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  protocol.registerFileProtocol('localfile', (request, callback) => {
    const filePath = decodeURIComponent(request.url.replace('localfile://', ''))
    if (isKnownLocalFile(filePath)) callback({ path: filePath })
    else callback({ error: -6 })
  })

  createWindow()

  // Safety-net snapshot of the database (throttled to once per 12h) so any later
  // corruption or accidental destructive action is recoverable.
  try { require('./db').backupDb('startup') } catch (e) { console.error('[main] startup backup failed:', e.message) }

  try { require('./updater').initUpdater() } catch (e) { console.error('[main] updater init failed:', e.message) }

  const { setMainWindow, startPeriodicAutoSync } = require('./sync')
  setMainWindow(mainWindow)
  startPeriodicAutoSync()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

ipcMain.handle('window:setFullscreen', (_, flag) => mainWindow.setFullScreen(flag))
ipcMain.handle('window:isFullscreen', () => mainWindow.isFullScreen())

ipcMain.handle('app:getInfo', () => ({
  name: app.getName(),
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
}))

ipcMain.handle('app:exportDiagnostics', async () => {
  const diagnostics = require('./diagnostics').buildDiagnostics()
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export SDMo diagnostics',
    defaultPath: `sdmo-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (canceled || !filePath) return null
  fs.writeFileSync(filePath, JSON.stringify(diagnostics, null, 2))
  return filePath
})

ipcMain.handle('app:updateStatus', () => require('./updater').getUpdateStatus())
ipcMain.handle('app:checkForUpdates', () => require('./updater').checkForUpdates())
ipcMain.handle('app:downloadUpdate', () => require('./updater').downloadUpdate())
ipcMain.handle('app:installUpdate', () => {
  require('./updater').quitAndInstall()
  return true
})

ipcMain.handle('window:openWorkspace', (_, url) => {
  // Extract reviewId from URL hash: #/workspace/<id>
  const reviewId = (url.match(/#\/workspace\/([^/?#]+)/) || [])[1] || 'unknown'

  // If already open, just focus it
  if (workspaceWindows[reviewId] && !workspaceWindows[reviewId].isDestroyed()) {
    workspaceWindows[reviewId].focus()
    return true
  }

  const win = new BrowserWindow({
    width: 860,
    height: 920,
    minWidth: 560,
    minHeight: 500,
    title: 'SDMo — Workspace',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  workspaceWindows[reviewId] = win
  win.loadURL(url)
  if (isDev) win.webContents.openDevTools()

  win.on('closed', () => {
    delete workspaceWindows[reviewId]
    if (mainWindow && !mainWindow.isDestroyed()) {
      // review:updated triggers a data refresh in ReviewPage via the normal event path
      mainWindow.webContents.send('review:updated', reviewId)
      mainWindow.webContents.send('workspace:closed', reviewId)
    }
  })

  return true
})

ipcMain.handle('window:closeWorkspace', (_, reviewId) => {
  const key = String(reviewId)
  if (workspaceWindows[key] && !workspaceWindows[key].isDestroyed()) {
    workspaceWindows[key].close()
  }
  return true
})

// Broadcast review-updated to all other windows (popup ↔ main window, bidirectional)
ipcMain.handle('review:notifyUpdate', (event, reviewId) => {
  const senderContents = event.sender
  const all = BrowserWindow.getAllWindows()
  for (const win of all) {
    if (!win.isDestroyed() && win.webContents !== senderContents) {
      win.webContents.send('review:updated', reviewId)
    }
  }
  return true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  try { require('./sync').stopPeriodicAutoSync() } catch (_) {}
  try { require('./mediaServer').stopMediaServer() } catch (_) {}
})
