const { app, BrowserWindow, ipcMain, protocol } = require('electron')
const path = require('path')

app.setName('SDMo')

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

let mainWindow
const workspaceWindows = {} // reviewId string → BrowserWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
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
  protocol.registerFileProtocol('localfile', (request, callback) => {
    const filePath = decodeURIComponent(request.url.replace('localfile://', ''))
    callback({ path: filePath })
  })

  createWindow()

  const { setMainWindow } = require('./sync')
  setMainWindow(mainWindow)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

ipcMain.handle('window:setFullscreen', (_, flag) => mainWindow.setFullScreen(flag))
ipcMain.handle('window:isFullscreen', () => mainWindow.isFullScreen())

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
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
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
