const { getDb, backupDb } = require('../db')
const { dialog, app } = require('electron')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { getSettings, saveSettings, getProjectName, getOrCreateUUID, setProjectName } = require('../settings')
const {
  buildExport, mergeImport, createFromImport,
  doLocalSync, doCloudSync,
  syncConfigLocal, syncConfigCloud,
  mergeConfigImport, bumpConfigVersion, bumpAndSync,
  markSynced, getLastSyncAt,
  safeJsonParse,
} = require('../sync')

// In-memory unlock sessions — cleared on app restart
const unlockedProjects = new Set()

// PI for a project means either: unlocked this session, or owns it persistently via settings.
// Use this instead of unlockedProjects.has() for any PI-gated logic.
function isOwner(projectId) {
  if (unlockedProjects.has(Number(projectId))) return true
  const s = getSettings()
  return (s.owner_projects || []).includes(String(projectId))
}

function hashPassword(pw) {
  return createHash('sha256').update(pw).digest('hex')
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
    project.is_unlocked = !project.owner_password_hash || unlockedProjects.has(id)
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
      unlockedProjects.add(projectId)
      // Persist ownership so PI status survives app restarts
      const s = getSettings()
      const owned = new Set(s.owner_projects || [])
      owned.add(String(projectId))
      saveSettings({ owner_projects: [...owned] })
    } else {
      unlockedProjects.delete(projectId)
      const s = getSettings()
      const owned = new Set(s.owner_projects || [])
      owned.delete(String(projectId))
      saveSettings({ owner_projects: [...owned] })
    }
    return true
  })

  ipcMain.handle('project:verifyPassword', (_, projectId, password) => {
    const db = getDb()
    const project = db.prepare('SELECT owner_password_hash FROM projects WHERE id=?').get(projectId)
    if (!project?.owner_password_hash) { unlockedProjects.add(projectId); return true }
    const match = hashPassword(password) === project.owner_password_hash
    if (match) unlockedProjects.add(projectId)
    return match
  })

  ipcMain.handle('project:lock', (_, projectId) => {
    unlockedProjects.delete(projectId)
    return true
  })

  ipcMain.handle('project:isUnlocked', (_, projectId) => {
    const db = getDb()
    const project = db.prepare('SELECT owner_password_hash FROM projects WHERE id=?').get(projectId)
    return !project?.owner_password_hash || unlockedProjects.has(projectId)
  })

  ipcMain.handle('projects:create', (_, data) => {
    const db = getDb()
    const result = db.prepare('INSERT INTO projects (name, description) VALUES (?,?)').run(data.name, data.description || '')
    const projectId = result.lastInsertRowid
    if (data.reviewer_name) setProjectName(projectId, data.reviewer_name)
    return { id: projectId, ...data }
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
      isUnlocked: !project?.owner_password_hash || unlockedProjects.has(projectId),
    }
  })

  ipcMain.handle('sync:selectFolder', async () => {
    const { filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return filePaths?.[0] || null
  })

  ipcMain.handle('sync:acceptConfigUpdate', (_, projectId, configData) => {
    const db = getDb()
    try {
      mergeConfigImport(db, projectId, configData, { force: true })
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
    const XLSX = require('xlsx')
    const db = getDb()
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)
    const safeName = (project?.name || 'project').replace(/[^a-zA-Z0-9_-]/g, '_')

    const { filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeName}-export.xlsx`,
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    })
    if (!filePath) return null

    const wb = require('xlsx').utils.book_new()
    const FIXED = ['Encounter', 'Media File', 'Reviewer', 'Status', 'Created At', 'Submitted At', 'Review Notes']

    function sheetName(base, suffix) {
      const s = `${base} ${suffix}`
      return s.length > 31 ? s.slice(0, 28) + '...' : s
    }

    function fmtTime(sec) {
      const m = Math.floor(sec / 60)
      const s = String(Math.floor(sec % 60)).padStart(2, '0')
      return `${m}:${s}`
    }

    const allForms = {}
    for (const f of db.prepare('SELECT * FROM forms WHERE project_id=?').all(projectId)) {
      const schema = JSON.parse(f.schema || '{"sections":[]}')
      const elements = []
      for (const sec of (schema.sections || [])) {
        for (const el of (sec.elements || [])) {
          if (el.type !== 'text_block') elements.push(el)
        }
      }
      allForms[f.id] = { name: f.name, elements }
    }

    function getResponses(reviewId) {
      const rows = db.prepare('SELECT form_id, responses FROM form_responses WHERE review_id=?').all(reviewId)
      const out = {}
      for (const row of rows) {
        let parsed = {}
        try { parsed = JSON.parse(row.responses) } catch {}
        out[row.form_id] = parsed
      }
      return out
    }

    const mediaTypes = db.prepare('SELECT * FROM media_types WHERE project_id=?').all(projectId)
    const buckets = [...mediaTypes, { id: null, name: '(Untyped)' }]
    const encounters = db.prepare('SELECT * FROM encounters WHERE project_id=? ORDER BY name').all(projectId)

    for (const mt of buckets) {
      const tabForms = mt.id
        ? db.prepare(`
            SELECT DISTINCT f.id, f.name FROM workspace_tabs wt
            JOIN forms f ON wt.ref_id = f.id
            WHERE wt.media_type_id=? AND wt.tab_type='form'
          `).all(mt.id)
        : []

      const qCols = []
      for (const tf of tabForms) {
        const form = allForms[tf.id]
        if (!form) continue
        for (const el of form.elements) {
          qCols.push({ formId: tf.id, formName: form.name, elId: el.id, label: el.label || el.id })
        }
      }

      const reviewRows = []
      const tsRows = []
      const qHeaders = qCols.map(c => `[${c.formName}] ${c.label}`)
      const allCols = [...FIXED, ...qHeaders]

      for (const enc of encounters) {
        const condition = mt.id === null ? 'mf.media_type_id IS NULL' : 'mf.media_type_id = ?'
        const params = mt.id === null ? [enc.id] : [enc.id, mt.id]
        const mediaFiles = db.prepare(
          `SELECT mf.* FROM media_files mf WHERE mf.encounter_id=? AND ${condition} ORDER BY mf.name`
        ).all(...params)

        for (const mf of mediaFiles) {
          const reviews = db.prepare('SELECT * FROM reviews WHERE media_file_id=? AND deleted_at IS NULL').all(mf.id)
          for (const rev of reviews) {
            const responses = getResponses(rev.id)
            const row = {
              'Encounter': enc.name, 'Media File': mf.name, 'Reviewer': rev.reviewer_name,
              'Status': rev.status, 'Created At': rev.created_at, 'Submitted At': rev.submitted_at || '',
              'Review Notes': rev.notes || '',
            }
            for (const qc of qCols) {
              const val = (responses[qc.formId] || {})[qc.elId]
              row[`[${qc.formName}] ${qc.label}`] = val == null ? '' : Array.isArray(val) ? val.join('; ') : String(val)
            }
            reviewRows.push(row)
            for (const ts of db.prepare('SELECT * FROM timestamps WHERE review_id=? ORDER BY time_seconds').all(rev.id)) {
              tsRows.push({
                'Encounter': enc.name, 'Media File': mf.name, 'Reviewer': rev.reviewer_name,
                'Time': fmtTime(ts.time_seconds), 'Time (seconds)': ts.time_seconds,
                'Tag': ts.tag_label || '', 'Notes': ts.notes || '',
              })
            }
          }
        }
      }

      if (reviewRows.length === 0 && tsRows.length === 0) continue
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reviewRows, { header: allCols }), sheetName(mt.name, 'Reviews'))
      if (tsRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tsRows), sheetName(mt.name, 'Timestamps'))
    }

    XLSX.writeFile(wb, filePath)
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
    if (data.id) {
      db.prepare('UPDATE media_types SET name=?, reviews_required=?, allow_custom_tags=?, color=? WHERE id=?')
        .run(data.name, data.reviews_required, data.allow_custom_tags ? 1 : 0, data.color, data.id)
      db.prepare('DELETE FROM timestamp_tags WHERE media_type_id=?').run(data.id)
      const insertTag = db.prepare('INSERT INTO timestamp_tags (media_type_id, label, color, description) VALUES (?,?,?,?)')
      for (const tag of (data.tags || [])) insertTag.run(data.id, tag.label, tag.color || '#6366f1', tag.description || '')
      db.prepare('DELETE FROM workspace_tabs WHERE media_type_id=?').run(data.id)
      const insertTab = db.prepare('INSERT INTO workspace_tabs (media_type_id, tab_type, ref_id, label, sort_order) VALUES (?,?,?,?,?)')
      for (let i = 0; i < (data.workspace_tabs || []).length; i++) {
        const tab = data.workspace_tabs[i]
        insertTab.run(data.id, tab.tab_type, tab.ref_id, tab.label, i)
      }
      bumpAndSync(db, projectId)
      return data.id
    } else {
      const r = db.prepare('INSERT INTO media_types (project_id, name, reviews_required, allow_custom_tags, color) VALUES (?,?,?,?,?)')
        .run(projectId, data.name, data.reviews_required || 1, data.allow_custom_tags ? 1 : 0, data.color || '#6366f1')
      const mediaTypeId = r.lastInsertRowid
      const insertTag = db.prepare('INSERT INTO timestamp_tags (media_type_id, label, color, description) VALUES (?,?,?,?)')
      for (const tag of (data.tags || [])) insertTag.run(mediaTypeId, tag.label, tag.color || '#6366f1', tag.description || '')
      const insertTab = db.prepare('INSERT INTO workspace_tabs (media_type_id, tab_type, ref_id, label, sort_order) VALUES (?,?,?,?,?)')
      for (let i = 0; i < (data.workspace_tabs || []).length; i++) {
        const tab = data.workspace_tabs[i]
        insertTab.run(mediaTypeId, tab.tab_type, tab.ref_id, tab.label, i)
      }
      bumpAndSync(db, projectId)
      return mediaTypeId
    }
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
    backupDb('pre-delete-mediatype')
    db.prepare('DELETE FROM media_types WHERE id=?').run(id)
    bumpAndSync(db, projectId)
    return true
  })

  ipcMain.handle('setup:listMediaTypes', (_, projectId) => {
    const db = getDb()
    const types = db.prepare('SELECT * FROM media_types WHERE project_id=?').all(projectId)
    for (const t of types) {
      t.tags = db.prepare('SELECT * FROM timestamp_tags WHERE media_type_id=?').all(t.id)
      t.workspace_tabs = db.prepare('SELECT * FROM workspace_tabs WHERE media_type_id=? ORDER BY sort_order').all(t.id)
    }
    return types
  })

  // Setup: forms
  ipcMain.handle('setup:saveForm', (_, projectId, data) => {
    const db = getDb()
    const schema = typeof data.schema === 'string' ? data.schema : JSON.stringify(data.schema)
    if (data.id) {
      db.prepare("UPDATE forms SET name=?, schema=?, updated_at=datetime('now') WHERE id=?").run(data.name, schema, data.id)
      bumpAndSync(db, projectId)
      return data.id
    } else {
      const r = db.prepare('INSERT INTO forms (project_id, name, schema) VALUES (?,?,?)').run(projectId, data.name, schema)
      bumpAndSync(db, projectId)
      return r.lastInsertRowid
    }
  })

  // Count form responses for a form before deleting
  ipcMain.handle('setup:countFormResponses', (_, id) => {
    const db = getDb()
    return db.prepare('SELECT COUNT(*) as n FROM form_responses WHERE form_id=?').get(id).n
  })

  ipcMain.handle('setup:deleteForm', (_, projectId, id) => {
    const db = getDb()
    // Deleting a form cascades to all reviewers' form_responses — snapshot first.
    backupDb('pre-delete-form')
    db.prepare('DELETE FROM forms WHERE id=?').run(id)
    bumpAndSync(db, projectId)
    return true
  })

  ipcMain.handle('setup:listForms', (_, projectId) => {
    const db = getDb()
    return db.prepare('SELECT id, name, created_at FROM forms WHERE project_id=?').all(projectId)
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
    if (data.id) {
      db.prepare('UPDATE instructions SET name=?, content=?, content_type=?, file_path=? WHERE id=?')
        .run(data.name, data.content || '', data.content_type || 'markdown', data.file_path || null, data.id)
      bumpAndSync(db, projectId)
      return data.id
    } else {
      const r = db.prepare('INSERT INTO instructions (project_id, name, content, content_type, file_path) VALUES (?,?,?,?,?)')
        .run(projectId, data.name, data.content || '', data.content_type || 'markdown', data.file_path || null)
      bumpAndSync(db, projectId)
      return r.lastInsertRowid
    }
  })

  ipcMain.handle('setup:deleteInstruction', (_, projectId, id) => {
    const db = getDb()
    db.prepare('DELETE FROM instructions WHERE id=?').run(id)
    bumpAndSync(db, projectId)
    return true
  })

  ipcMain.handle('setup:listInstructions', (_, projectId) => {
    const db = getDb()
    return db.prepare('SELECT * FROM instructions WHERE project_id=?').all(projectId)
  })

  ipcMain.handle('setup:uploadPdf', async (_, projectId) => {
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
    const configPath = path.join(folderPath, 'project-config.json')
    if (!fs.existsSync(configPath)) {
      return { error: 'No project-config.json found here. Make sure you select the sync folder, not the media folder.' }
    }
    const db = getDb()
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (!data?.sdmo) return { error: 'Not a valid SDMo sync folder' }
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
      mergeConfigImport(db, projectId, data, { force: true })
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
      const configFile = files.find(f => f.name === 'project-config.json')
      if (!configFile) {
        return { error: "No project-config.json found in this folder. Select the project's sync folder." }
      }
      const content = await adapter.readFile(configFile.id)
      const data = JSON.parse(content)
      if (!data?.sdmo) return { error: 'Not a valid SDMo sync folder' }
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
      mergeConfigImport(db, projectId, data, { force: true })
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
        syncConfigLocal(db, projectId, project.sync_folder)
      } else if (project.cloud_provider && project.cloud_folder_id) {
        const { getAdapter } = require('../cloud/cloudSync')
        const adapter = getAdapter(project.cloud_provider)
        const files = await adapter.listFiles(project.cloud_folder_id)
        await syncConfigCloud(db, projectId, adapter, project.cloud_folder_id, files)
      }
      return { ok: true }
    } catch (e) {
      console.error('[fetchStructure] failed:', e.message)
      return { ok: false, error: e.message }
    }
  })

  module.exports.unlockedProjects = unlockedProjects
  module.exports.isOwner = isOwner
}
