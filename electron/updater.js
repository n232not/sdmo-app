const { app, BrowserWindow } = require('electron')
const { autoUpdater } = require('electron-updater')
const { backupDb } = require('./db')
const { getSettings, saveSettings } = require('./settings')

const REQUIRED_MARKERS = [
  '[sdmo-update:required]',
  'sdmo_update_required=true',
  'required_update: true',
]

let status = {
  state: app.isPackaged ? 'idle' : 'unavailable',
  currentVersion: app.getVersion(),
  updateInfo: null,
  required: false,
  error: null,
  downloaded: false,
  checking: false,
}

function normalizeReleaseNotes(notes) {
  if (Array.isArray(notes)) {
    return notes.map(n => `${n?.note || n || ''}`).join('\n')
  }
  return `${notes || ''}`
}

function isRequiredRelease(info) {
  const notes = normalizeReleaseNotes(info?.releaseNotes).toLowerCase()
  return REQUIRED_MARKERS.some(marker => notes.includes(marker))
}

function publicInfo(info) {
  if (!info) return null
  return {
    version: info.version || null,
    releaseName: info.releaseName || null,
    releaseDate: info.releaseDate || null,
    releaseNotes: info.releaseNotes || null,
  }
}

function setStatus(patch) {
  status = { ...status, ...patch, currentVersion: app.getVersion() }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('app:updateStatus', getUpdateStatus())
  }
}

function rememberRequiredUpdate(info) {
  if (!info?.version) return
  saveSettings({
    required_update: {
      version: info.version,
      releaseName: info.releaseName || null,
      releaseDate: info.releaseDate || null,
      discoveredAt: new Date().toISOString(),
    },
  })
}

function clearSatisfiedRequiredUpdate() {
  const remembered = getSettings().required_update
  if (remembered?.version && remembered.version === app.getVersion()) {
    saveSettings({ required_update: null })
  }
}

function getUpdateStatus() {
  const remembered = getSettings().required_update
  const rememberedRequired = !!remembered?.version && remembered.version !== app.getVersion()
  return {
    ...status,
    required: status.required || rememberedRequired,
    requiredVersion: status.updateInfo?.version || remembered?.version || null,
    updateInfo: publicInfo(status.updateInfo),
    rememberedRequiredUpdate: rememberedRequired ? remembered : null,
  }
}

function initUpdater() {
  clearSatisfiedRequiredUpdate()

  if (!app.isPackaged) {
    setStatus({ state: 'unavailable', error: 'Updates are only available in packaged builds.' })
    return
  }

  if (process.platform === 'darwin' && process.env.SDMO_ENABLE_MAC_AUTO_UPDATE !== '1') {
    setStatus({
      state: 'unavailable',
      error: 'Mac in-app updates require a Developer ID signed build. Install the latest DMG manually.',
    })
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    setStatus({ state: 'checking', checking: true, error: null })
  })

  autoUpdater.on('update-available', (info) => {
    const required = isRequiredRelease(info)
    if (required) rememberRequiredUpdate(info)
    setStatus({
      state: 'available',
      checking: false,
      updateInfo: info,
      required,
      downloaded: false,
      error: null,
    })
  })

  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'not-available', checking: false, updateInfo: null, required: false, downloaded: false, error: null })
  })

  autoUpdater.on('download-progress', (progress) => {
    setStatus({ state: 'downloading', progress, error: null })
  })

  autoUpdater.on('update-downloaded', (info) => {
    const required = status.required || isRequiredRelease(info)
    if (required) rememberRequiredUpdate(info)
    setStatus({ state: 'downloaded', updateInfo: info, required, downloaded: true, error: null })
  })

  autoUpdater.on('error', (error) => {
    setStatus({ state: 'error', checking: false, error: error?.message || String(error) })
  })

  setTimeout(() => checkForUpdates(), 5000)
}

async function checkForUpdates() {
  if (!app.isPackaged) return getUpdateStatus()
  await autoUpdater.checkForUpdates()
  return getUpdateStatus()
}

async function downloadUpdate() {
  if (!app.isPackaged) return getUpdateStatus()
  if (!status.updateInfo) {
    await autoUpdater.checkForUpdates()
    if (!status.updateInfo || status.state !== 'available') return getUpdateStatus()
  }
  setStatus({ state: 'downloading', error: null })
  await autoUpdater.downloadUpdate()
  return getUpdateStatus()
}

function quitAndInstall() {
  backupDb('pre-app-update')
  autoUpdater.quitAndInstall(false, true)
}

module.exports = { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall, getUpdateStatus }
