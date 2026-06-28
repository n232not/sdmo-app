const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')

const SETTINGS_PATH = path.join(app.getPath('userData'), 'app-settings.json')

const BACKUP_PATH = SETTINGS_PATH + '.bak'

function getSettings() {
  // Try the live file first, then the last-known-good backup. A truncated/corrupt
  // file (e.g. from a crash mid-write) must not silently wipe user_uuid,
  // owner_projects, cloud tokens, and media_base_folders.
  for (const p of [SETTINGS_PATH, BACKUP_PATH]) {
    try {
      const raw = fs.readFileSync(p, 'utf8')
      if (raw.trim()) return JSON.parse(raw)
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[settings] failed to read ${p}:`, e.message)
    }
  }
  return {}
}

function saveSettings(data) {
  const current = getSettings()
  const merged = { ...current, ...data }
  const tmp = SETTINGS_PATH + '.tmp'
  // Atomic write: write to a temp file, keep the prior good copy as .bak, then rename.
  // rename() is atomic on the same filesystem, so a crash can never leave a half-written file.
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2))
  try { if (fs.existsSync(SETTINGS_PATH)) fs.copyFileSync(SETTINGS_PATH, BACKUP_PATH) } catch (_) {}
  fs.renameSync(tmp, SETTINGS_PATH)
  return merged
}

// Returns the stable UUID for this installation, generating one if needed
function getOrCreateUUID() {
  const s = getSettings()
  if (s.user_uuid) return s.user_uuid
  const uuid = randomUUID()
  saveSettings({ user_uuid: uuid })
  return uuid
}

// Per-project display name: stored as project_names[projectId] in settings
function getProjectName(projectId) {
  const s = getSettings()
  return s.project_names?.[String(projectId)] || s.reviewer_name || null
}

function setProjectName(projectId, name) {
  const s = getSettings()
  const project_names = { ...(s.project_names || {}), [String(projectId)]: name }
  saveSettings({ project_names })
}

module.exports = { getSettings, saveSettings, getOrCreateUUID, getProjectName, setProjectName }
