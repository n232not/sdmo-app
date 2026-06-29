const { getDb, backupDb } = require('../db')
const { dialog, app } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { getSettings, saveSettings, getProjectName, getOrCreateUUID, setProjectName } = require('../settings')
const {
  buildExport, mergeImport, createFromImport,
  buildReviewsWorkbook,
  doLocalSync, doCloudSync,
  syncProjectStateLocal, syncProjectStateCloud,
  mergeConfigImport, bumpConfigVersion, bumpAndSync,
  markSynced, getLastSyncAt,
  mergeProjectStateImport, assertProjectStateCompatible, hydrateSplitProjectStateLocal, hydrateSplitProjectStateCloud, PROJECT_STATE_FILENAME,
  safeJsonParse,
} = require('../sync')
const structureService = require('../services/structure')
const snapshotService = require('../services/snapshots')
const { seedSampleProject } = require('../services/sampleProject')

// In-memory unlock sessions — cleared on app restart. A project is "unlocked"
// when its password has been entered this session (or it has no password).
// This is the only access gate: anyone who can edit settings knew the password.
const unlockedProjects = new Set()

function hashPassword(pw) {
  return createHash('sha256').update(pw).digest('hex')
}

function requireUnlocked(db, projectId) {
  const pid = Number(projectId)
  const project = db.prepare('SELECT owner_password_hash FROM projects WHERE id=?').get(projectId)
  if (project?.owner_password_hash && !unlockedProjects.has(pid)) {
    throw new Error('Project is locked')
  }
}

module.exports = function (ipcMain) {
  ipcMain.handle('projects:list', () => {
    const db = getDb()
    return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
  })

  ipcMain.handle('projects:get', (_, id) => {
    const db = getDb()
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
    if (!project) return null
    project.keybinds = safeJsonParse(project.keybinds, [])
    project.has_password = !!project.owner_password_hash
    project.is_unlocked = !project.owner_password_hash || unlockedProjects.has(Number(id))
    delete project.owner_password_hash
    const mediaTypes = db.prepare('SELECT * FROM media_types WHERE project_id = ?').all(id)
    const forms = db.prepare('SELECT id, name, created_at FROM forms WHERE project_id = ?').all(id)
    const instructions = db.prepare('SELECT id, name, created_at FROM instructions WHERE project_id = ?').all(id)
    return { ...project, mediaTypes, forms, instructions }
  })

  // Password management
  ipcMain.handle('project:setPassword', (_, projectId, password) => {
    const db = getDb()
    const hash = password ? hashPassword(password) : null
    db.prepare('UPDATE projects SET owner_password_hash=? WHERE id=?').run(hash, projectId)
    bumpAndSync(db, projectId)
    if (hash) {
      unlockedProjects.add(Number(projectId))
    } else {
      unlockedProjects.delete(Number(projectId))
    }
    return true
  })

  ipcMain.handle('project:verifyPassword', (_, projectId, password) => {
    const db = getDb()
    const project = db.prepare('SELECT owner_password_hash FROM projects WHERE id=?').get(projectId)
    if (!project?.owner_password_hash) { unlockedProjects.add(Number(projectId)); return true }
    const match = hashPassword(password) === project.owner_password_hash
    if (match) unlockedProjects.add(Number(projectId))
    return match
  })

  ipcMain.handle('project:lock', (_, projectId) => {
    unlockedProjects.delete(Number(projectId))
    return true
  })

  ipcMain.handle('project:isUnlocked', (_, projectId) => {
    const db = getDb()
    const project = db.prepare('SELECT owner_password_hash FROM projects WHERE id=?').get(projectId)
    return !project?.owner_password_hash || unlockedProjects.has(Number(projectId))
  })

  ipcMain.handle('projects:create', (_, data) => {
    const db = getDb()
    const result = db.prepare('INSERT INTO projects (name, description) VALUES (?,?)').run(data.name, data.description || '')
    const projectId = result.lastInsertRowid
    if (data.reviewer_name) setProjectName(projectId, data.reviewer_name)
    return { id: projectId, ...data }
  })

  ipcMain.handle('projects:createSample', () => {
    return seedSampleProject(getDb())
  })

  ipcMain.handle('projects:update', (_, id, data) => {
    const db = getDb()
    const keybinds = typeof data.keybinds === 'string' ? data.keybinds : JSON.stringify(data.keybinds || [])
    db.prepare(
      "UPDATE projects SET name=?, description=?, media_folder=?, keybinds=?, sync_folder=?, owner_name=?, updated_at=datetime('now') WHERE id=?"
    ).run(data.name, data.description, data.media_folder, keybinds, data.sync_folder || null, data.owner_name || null, id)
    bumpAndSync(db, id)
    return true
  })

  // App-wide settings
  ipcMain.handle('app:getSettings', () => getSettings())
  ipcMain.handle('app:setSettings', (_, data) => saveSettings(data))

  // Per-project reviewer name
  ipcMain.handle('app:getProjectName', (_, projectId) => getProjectName(projectId))
  ipcMain.handle('app:setProjectName', (_, projectId, name) => { setProjectName(projectId, name); return true })

  // ─── Sync ──────────────────────────────────────────────────────────────────

  ipcMain.handle('sync:now', async (_, projectId) => {
    const db = getDb()
    const project = db.prepare('SELECT sync_folder, cloud_provider, cloud_folder_id FROM projects WHERE id=?').get(projectId)
    const uuid = getOrCreateUUID()
    const name = getProjectName(projectId) || uuid
    try {
      if (project?.sync_folder) {
        await doLocalSync(db, projectId, project.sync_folder, uuid, name)
        return { ok: true }
      } else if (project?.cloud_provider && project?.cloud_folder_id) {
        await doCloudSync(db, projectId, project.cloud_provider, project.cloud_folder_id, uuid, name)
        return { ok: true }
      }
      return { error: 'No sync configured' }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('sync:getStatus', (_, projectId) => {
    const db = getDb()
    const project = db.prepare('SELECT sync_folder, cloud_provider, cloud_folder_id, owner_password_hash FROM projects WHERE id=?').get(projectId)
    const syncFolder = project?.sync_folder || null
    const cloudProvider = project?.cloud_provider || null
    const syncMode = cloudProvider ? 'cloud' : syncFolder ? 'local' : 'none'
    const syncFolderExists = syncFolder ? fs.existsSync(syncFolder) : false

    // Check if cloud token is expired
    let tokenExpired = false
    if (cloudProvider) {
      try {
        const { getAdapter } = require('../cloud/cloudSync')
        const status = getAdapter(cloudProvider).getStatus()
        tokenExpired = status.tokenExpired || false
      } catch {}
    }

    return {
      syncFolder,
      cloudProvider,
      cloudFolderId: project?.cloud_folder_id || null,
      syncMode,
      syncFolderExists,
      tokenExpired,
      lastSyncAt: getLastSyncAt(projectId),
      hasPassword: !!project?.owner_password_hash,
      isUnlocked: !project?.owner_password_hash || unlockedProjects.has(Number(projectId)),
    }
  })

  ipcMain.handle('sync:selectFolder', async () => {
    const { filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return filePaths?.[0] || null
  })

  ipcMain.handle('sync:acceptConfigUpdate', (_, projectId, configData) => {
    const db = getDb()
    try {
      if (configData?.sdmo_sync) mergeProjectStateImport(db, projectId, configData, { merge: true })
      else mergeConfigImport(db, projectId, configData, { force: true })
      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
  })

  // Save project file (export for email/sharing)
  ipcMain.handle('sync:saveFile', async (_, projectId) => {
    const db = getDb()
    const project = db.prepare('SELECT name FROM projects WHERE id=?').get(projectId)
    const safeName = (project?.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_')
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: `sdmo-${safeName}.json`,
      filters: [{ name: 'SDMo Project', extensions: ['json'] }],
    })
    if (!filePath) return null
    const data = buildExport(db, projectId)
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    return filePath
  })

  ipcMain.handle('sync:importAsNew', async () => {
    const { filePaths } = await dialog.showOpenDialog({
      filters: [{ name: 'SDMo Project', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (!filePaths?.[0]) return null
    const db = getDb()
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
    const projectId = createFromImport(db, data)
    return { ok: true, projectId, syncHint: data.sync_hint || { mode: 'none', provider: null } }
  })

  ipcMain.handle('sync:loadFile', async (_, projectId) => {
    const { filePaths } = await dialog.showOpenDialog({
      filters: [{ name: 'SDMo Project', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (!filePaths?.[0]) return null
    const db = getDb()
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'))
    const result = mergeImport(db, projectId, data)
    return { ok: true, ...result }
  })

  ipcMain.handle('export:excel', async (_, projectId) => {
    const db = getDb()
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)
    const safeName = (project?.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_')

    const { filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeName}-export.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    })
    if (!filePath) return null

    const wb = buildReviewsWorkbook(db, projectId)
    if (!wb) return null // no reviews to export

    require('xlsx').writeFile(wb, filePath)
    return filePath
  })

  ipcMain.handle('projects:delete', (_, id) => {
    const db = getDb()
    backupDb('pre-delete-project')
    const { cancelSync } = require('../sync')
    cancelSync(id) // stop any pending/in-flight sync writing files for a deleted project
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return true
  })

  // Setup: media types
  ipcMain.handle('setup:saveMediaType', (_, projectId, data) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    return structureService.saveMediaType(db, projectId, data)
  })

  // Count reviews affected by deleting a media type
  ipcMain.handle('setup:countMediaTypeReviews', (_, id) => {
    const db = getDb()
    return db.prepare(`
      SELECT COUNT(*) as n FROM reviews r
      JOIN media_files mf ON r.media_file_id = mf.id
      WHERE mf.media_type_id = ? AND r.deleted_at IS NULL
    `).get(id).n
  })

  ipcMain.handle('setup:deleteMediaType', (_, projectId, id) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    return structureService.deleteMediaType(db, projectId, id)
  })

  ipcMain.handle('setup:listMediaTypes', (_, projectId) => {
    const db = getDb()
    const types = db.prepare('SELECT * FROM media_types WHERE project_id=? AND archived_at IS NULL').all(projectId)
    for (const t of types) {
      t.tags = db.prepare('SELECT * FROM timestamp_tags WHERE media_type_id=?').all(t.id)
      t.workspace_tabs = db.prepare('SELECT * FROM workspace_tabs WHERE media_type_id=? ORDER BY sort_order').all(t.id)
    }
    return types
  })

  // Setup: forms
  ipcMain.handle('setup:saveForm', (_, projectId, data) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    return structureService.saveForm(db, projectId, data)
  })

  // Count form responses for a form before deleting
  ipcMain.handle('setup:countFormResponses', (_, id) => {
    const db = getDb()
    return db.prepare('SELECT COUNT(*) as n FROM form_responses WHERE form_id=?').get(id).n
  })

  ipcMain.handle('setup:deleteForm', (_, projectId, id) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    return structureService.deleteForm(db, projectId, id)
  })

  ipcMain.handle('setup:previewStructureMigration', (_, projectId, data) => {
    const db = getDb()
    return snapshotService.previewStructureMigration(db, projectId, data.kind, data.id, data.scope || 'drafts')
  })

  ipcMain.handle('setup:migrateStructureReviews', (_, projectId, data) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    const result = snapshotService.migrateStructureReviews(db, projectId, data.kind, data.id, data.scope || 'drafts')
    const { scheduleSync } = require('../sync')
    scheduleSync(projectId)
    return result
  })

  ipcMain.handle('setup:listVersionHistory', (_, projectId, data) => {
    const db = getDb()
    return structureService.listVersionHistory(db, projectId, data.kind, data.id)
  })

  ipcMain.handle('setup:restoreVersion', (_, projectId, data) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    return structureService.restoreVersion(db, projectId, data.kind, data.id, data.version)
  })

  ipcMain.handle('setup:listForms', (_, projectId) => {
    const db = getDb()
    return db.prepare('SELECT id, name, created_at, schema_version FROM forms WHERE project_id=? AND archived_at IS NULL').all(projectId)
  })

  ipcMain.handle('setup:getForm', (_, id) => {
    const db = getDb()
    const form = db.prepare('SELECT * FROM forms WHERE id=?').get(id)
    if (form) form.schema = JSON.parse(form.schema)
    return form
  })

  // Setup: instructions
  ipcMain.handle('setup:saveInstruction', (_, projectId, data) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    return structureService.saveInstruction(db, projectId, data)
  })

  ipcMain.handle('setup:deleteInstruction', (_, projectId, id) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    return structureService.deleteInstruction(db, projectId, id)
  })

  ipcMain.handle('setup:listInstructions', (_, projectId) => {
    const db = getDb()
    return db.prepare('SELECT * FROM instructions WHERE project_id=?').all(projectId)
  })

  ipcMain.handle('setup:uploadPdf', async (_, projectId) => {
    const db = getDb()
    requireUnlocked(db, projectId)
    const { filePaths } = await dialog.showOpenDialog({
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    })
    if (!filePaths || !filePaths[0]) return null
    const srcPath = filePaths[0]
    const destDir = path.join(app.getPath('userData'), 'projects', String(projectId))
    fs.mkdirSync(destDir, { recursive: true })
    const destName = `${Date.now()}-${path.basename(srcPath)}`
    const destPath = path.join(destDir, destName)
    fs.copyFileSync(srcPath, destPath)
    return destPath
  })

  // Cloud folder name (persisted in app-settings for display)
  ipcMain.handle('app:setCloudFolderName', (_, projectId, name) => {
    const s = getSettings()
    const names = { ...(s.cloud_folder_names || {}), [String(projectId)]: name }
    saveSettings({ cloud_folder_names: names })
    return true
  })

  ipcMain.handle('app:getCloudFolderName', (_, projectId) => {
    const s = getSettings()
    return s.cloud_folder_names?.[String(projectId)] || null
  })

  // Join project by pointing to an existing local sync folder
  ipcMain.handle('sync:joinFromLocalFolder', async (_, folderPath) => {
    if (!fs.existsSync(folderPath)) return { error: 'Folder does not exist' }
    const statePath = path.join(folderPath, PROJECT_STATE_FILENAME)
    const legacyConfigPath = path.join(folderPath, 'project-config.json')
    if (!fs.existsSync(statePath) && !fs.existsSync(legacyConfigPath)) {
      return { error: `No ${PROJECT_STATE_FILENAME} or project-config.json found here. Make sure you select the sync folder, not the media folder.` }
    }
    const db = getDb()
    try {
      let data = JSON.parse(fs.readFileSync(fs.existsSync(statePath) ? statePath : legacyConfigPath, 'utf8'))
      if (!data?.sdmo_sync && !data?.sdmo) return { error: 'Not a valid SDMo sync folder' }
      const r = db.prepare(
        'INSERT INTO projects (name, description, sync_folder, owner_password_hash) VALUES (?,?,?,?)'
      ).run(
        data.project?.name || 'Imported Project',
        data.project?.description || '',
        folderPath,
        data.project?.owner_password_hash || null
      )
      const projectId = r.lastInsertRowid
      if (data.project?.keybinds) {
        db.prepare('UPDATE projects SET keybinds=? WHERE id=?').run(JSON.stringify(data.project.keybinds), projectId)
      }
      if (data.sdmo_sync) {
        assertProjectStateCompatible(data)
        data = hydrateSplitProjectStateLocal(data, folderPath)
        mergeProjectStateImport(db, projectId, data, { merge: true })
      } else {
        mergeConfigImport(db, projectId, data, { force: true })
      }
      return { ok: true, projectId, projectName: data.project?.name || 'Project' }
    } catch (e) {
      return { error: e.message }
    }
  })

  // Join project by connecting to an existing cloud sync folder
  ipcMain.handle('sync:joinFromCloudFolder', async (_, provider, folderId, folderName) => {
    const db = getDb()
    try {
      const { getAdapter } = require('../cloud/cloudSync')
      const adapter = getAdapter(provider)
      const files = await adapter.listFiles(folderId)
      const stateFile = files.find(f => f.name === PROJECT_STATE_FILENAME)
      const configFile = files.find(f => f.name === 'project-config.json')
      if (!stateFile && !configFile) {
        return { error: `No ${PROJECT_STATE_FILENAME} or project-config.json found in this folder. Select the project's sync folder.` }
      }
      const content = await adapter.readFile((stateFile || configFile).id)
      let data = JSON.parse(content)
      if (!data?.sdmo_sync && !data?.sdmo) return { error: 'Not a valid SDMo sync folder' }
      const r = db.prepare(
        'INSERT INTO projects (name, description, cloud_provider, cloud_folder_id, owner_password_hash) VALUES (?,?,?,?,?)'
      ).run(
        data.project?.name || 'Imported Project',
        data.project?.description || '',
        provider,
        folderId,
        data.project?.owner_password_hash || null
      )
      const projectId = r.lastInsertRowid
      if (data.project?.keybinds) {
        db.prepare('UPDATE projects SET keybinds=? WHERE id=?').run(JSON.stringify(data.project.keybinds), projectId)
      }
      if (data.sdmo_sync) {
        assertProjectStateCompatible(data)
        data = await hydrateSplitProjectStateCloud(data, adapter, folderId)
        mergeProjectStateImport(db, projectId, data, { merge: true })
      } else {
        mergeConfigImport(db, projectId, data, { force: true })
      }
      const s = getSettings()
      const names = { ...(s.cloud_folder_names || {}), [String(projectId)]: folderName }
      saveSettings({ cloud_folder_names: names })
      return { ok: true, projectId, projectName: data.project?.name || 'Project' }
    } catch (e) {
      return { error: e.message }
    }
  })

  // Lightweight manifest check — reads only the tiny manifest.json, no full config download
  ipcMain.handle('project:checkManifest', async (_, projectId) => {
    const db = getDb()
    const project = db.prepare('SELECT sync_folder, cloud_provider, cloud_folder_id, config_version FROM projects WHERE id=?').get(projectId)
    if (!project) return null
    const localVersion = project.config_version || 0
    try {
      if (project.sync_folder) {
        const { readLocalManifest } = require('../sync')
        const manifest = readLocalManifest(project.sync_folder)
        return { config_version: manifest?.config_version || 0, local_version: localVersion }
      } else if (project.cloud_provider && project.cloud_folder_id) {
        const { getAdapter } = require('../cloud/cloudSync')
        const adapter = getAdapter(project.cloud_provider)
        const files = await adapter.listFiles(project.cloud_folder_id)
        const mf = files.find(f => f.name === 'manifest.json')
        if (!mf) return { config_version: 0, local_version: localVersion }
        const data = JSON.parse(await adapter.readFile(mf.id))
        return { config_version: data.config_version || 0, local_version: localVersion }
      }
    } catch {}
    return null
  })

  ipcMain.handle('project:fetchStructure', async (_, projectId) => {
    const db = getDb()
    const project = db.prepare('SELECT sync_folder, cloud_provider, cloud_folder_id FROM projects WHERE id=?').get(projectId)
    if (!project) return { ok: false, error: 'Project not found' }

    try {
      if (project.sync_folder) {
        syncProjectStateLocal(db, projectId, project.sync_folder)
      } else if (project.cloud_provider && project.cloud_folder_id) {
        const { getAdapter } = require('../cloud/cloudSync')
        const adapter = getAdapter(project.cloud_provider)
        const files = await adapter.listFiles(project.cloud_folder_id)
        await syncProjectStateCloud(db, projectId, adapter, project.cloud_folder_id, files)
      }
      return { ok: true }
    } catch (e) {
      console.error('[fetchStructure] failed:', e.message)
      return { ok: false, error: e.message }
    }
  })

  module.exports.unlockedProjects = unlockedProjects
}
