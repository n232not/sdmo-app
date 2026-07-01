const { app, BrowserWindow } = require('electron')
const { autoUpdater } = require('electron-updater')
const fetch = require('node-fetch')
const { backupDb } = require('./db')
const { getSettings, saveSettings } = require('./settings')
const pkg = require('../package.json')

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
  error: app.isPackaged ? null : 'Development builds cannot install updates in-app. Use Check for Updates to compare against the latest GitHub release.',
  downloaded: false,
  checking: false,
}

function canInstallInApp() {
  return process.platform !== 'darwin' || process.env.SDMO_ENABLE_MAC_AUTO_UPDATE === '1'
}

function shouldUseManualReleaseCheck() {
  return !app.isPackaged || !canInstallInApp()
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
    releaseUrl: info.releaseUrl || null,
  }
}

function parseVersion(value) {
  const match = `${value || ''}`.match(/(\d+)\.(\d+)\.(\d+)(?:[-+].*)?/)
  if (!match) return null
  return match.slice(1, 4).map(n => Number(n))
}

function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  }
  return 0
}

function getPublishConfig() {
  const publish = Array.isArray(pkg.build?.publish) ? pkg.build.publish[0] : pkg.build?.publish
  return publish?.provider === 'github' ? publish : null
}

async function checkGitHubRelease() {
  const publish = getPublishConfig()
  if (!publish?.owner || !publish?.repo) {
    setStatus({ state: 'unavailable', checking: false, error: 'GitHub release updates are not configured for this build.' })
    return getUpdateStatus()
  }

  setStatus({ state: 'checking', checking: true, error: null })
  try {
    const url = `https://api.github.com/repos/${publish.owner}/${publish.repo}/releases/latest`
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${app.getName()}/${app.getVersion()}`,
      },
    })
    if (response.status === 404) {
      setStatus({ state: 'not-available', checking: false, updateInfo: null, required: false, downloaded: false, error: null })
      return getUpdateStatus()
    }
    if (!response.ok) {
      throw new Error(`GitHub release check failed (${response.status})`)
    }

    const release = await response.json()
    const version = `${release.tag_name || release.name || ''}`.replace(/^v/i, '')
    if (!version || compareVersions(version, app.getVersion()) <= 0) {
      setStatus({ state: 'not-available', checking: false, updateInfo: null, required: false, downloaded: false, error: null })
      return getUpdateStatus()
    }

    const info = {
      version,
      releaseName: release.name || release.tag_name || version,
      releaseDate: release.published_at || release.created_at || null,
      releaseNotes: release.body || '',
      releaseUrl: release.html_url || `https://github.com/${publish.owner}/${publish.repo}/releases/latest`,
    }
    const required = isRequiredRelease(info)
    if (required) rememberRequiredUpdate(info)
    setStatus({ state: 'available', checking: false, updateInfo: info, required, downloaded: false, error: null })
    return getUpdateStatus()
  } catch (error) {
    setStatus({ state: 'error', checking: false, error: error?.message || String(error) })
    return getUpdateStatus()
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
    manualInstallOnly: shouldUseManualReleaseCheck(),
  }
}

function initUpdater() {
  clearSatisfiedRequiredUpdate()

  if (!app.isPackaged) {
    setStatus({ state: 'unavailable', error: 'Updates are only available in packaged builds.' })
    return
  }

  if (!canInstallInApp()) {
    setTimeout(() => checkGitHubRelease(), 5000)
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

function waitForUpdateCheckResult() {
  return new Promise((resolve) => {
    let done = false
    let timeoutId = null

    function finish(patch) {
      if (done) return
      done = true
      clearTimeout(timeoutId)
      autoUpdater.removeListener('update-available', onAvailable)
      autoUpdater.removeListener('update-not-available', onNotAvailable)
      autoUpdater.removeListener('error', onError)
      if (patch) setStatus(patch)
      resolve(getUpdateStatus())
    }

    function onAvailable() { finish() }
    function onNotAvailable() { finish() }
    function onError(error) {
      finish({ state: 'error', checking: false, error: error?.message || String(error) })
    }

    autoUpdater.once('update-available', onAvailable)
    autoUpdater.once('update-not-available', onNotAvailable)
    autoUpdater.once('error', onError)
    timeoutId = setTimeout(() => {
      finish({ state: 'error', checking: false, error: 'Update check timed out. Please try again.' })
    }, 30000)
  })
}

async function checkForUpdates() {
  if (status.checking) return getUpdateStatus()
  if (shouldUseManualReleaseCheck()) return checkGitHubRelease()
  const result = waitForUpdateCheckResult()
  setStatus({ state: 'checking', checking: true, error: null })
  try {
    await autoUpdater.checkForUpdates()
    return await result
  } catch (error) {
    setStatus({ state: 'error', checking: false, error: error?.message || String(error) })
    return getUpdateStatus()
  }
}

async function downloadUpdate() {
  if (!app.isPackaged) return getUpdateStatus()
  if (!canInstallInApp()) {
    setStatus({
      error: 'Mac in-app updates require a Developer ID signed build. Install the latest DMG manually.',
    })
    return getUpdateStatus()
  }
  if (!status.updateInfo) {
    await checkForUpdates()
    if (!status.updateInfo || status.state !== 'available') return getUpdateStatus()
  }
  setStatus({ state: 'downloading', error: null })
  await autoUpdater.downloadUpdate()
  return getUpdateStatus()
}

function quitAndInstall() {
  if (!canInstallInApp()) return
  backupDb('pre-app-update')
  autoUpdater.quitAndInstall(false, true)
}

module.exports = { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall, getUpdateStatus }
