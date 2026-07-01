const { contextBridge, ipcRenderer } = require('electron')

// Supports multiple independent subscribers per event channel.
// on(cb) returns a numeric id; pass that id to off(id) to remove the specific listener.
function makeEventBridge(channel) {
  const listeners = new Map()
  let nextId = 0
  let ipcWrapper = null

  return {
    on(cb) {
      const id = ++nextId
      listeners.set(id, cb)
      if (!ipcWrapper) {
        ipcWrapper = (_, ...args) => listeners.forEach(fn => fn(...args))
        ipcRenderer.on(channel, ipcWrapper)
      }
      return id
    },
    off(id) {
      listeners.delete(id)
      if (listeners.size === 0 && ipcWrapper) {
        ipcRenderer.removeListener(channel, ipcWrapper)
        ipcWrapper = null
      }
    },
  }
}

const configUpdateBridge = makeEventBridge('sync:configUpdateAvailable')
const reviewUpdatedBridge = makeEventBridge('review:updated')
const workspaceClosedBridge = makeEventBridge('workspace:closed')
const syncConflictBridge = makeEventBridge('sync:conflict')
const syncOfflineBridge = makeEventBridge('sync:offline')
const syncOnlineBridge = makeEventBridge('sync:online')
const syncGoogleDriveAccessBridge = makeEventBridge('sync:googleDriveAccessRequired')
const syncGoogleDriveMetadataBridge = makeEventBridge('sync:googleDriveMetadataMissing')
const appUpdateBridge = makeEventBridge('app:updateStatus')

contextBridge.exposeInMainWorld('api', {
  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (data) => ipcRenderer.invoke('projects:create', data),
  createSampleProject: () => ipcRenderer.invoke('projects:createSample'),
  getProject: (id) => ipcRenderer.invoke('projects:get', id),
  updateProject: (id, data) => ipcRenderer.invoke('projects:update', id, data),
  deleteProject: (id) => ipcRenderer.invoke('projects:delete', id),

  // Encounters
  listEncounters: (projectId) => ipcRenderer.invoke('encounters:list', projectId),
  getEncounter: (id) => ipcRenderer.invoke('encounters:get', id),
  createEncounter: (projectId, name) => ipcRenderer.invoke('encounters:create', projectId, name),
  renameEncounter: (projectId, encounterId, name) => ipcRenderer.invoke('encounters:rename', projectId, encounterId, name),
  countEncounterReviews: (encounterId) => ipcRenderer.invoke('encounters:countReviews', encounterId),
  deleteEncounter: (projectId, encounterId) => ipcRenderer.invoke('encounters:delete', projectId, encounterId),
  bulkDeleteEncounters: (projectId, ids) => ipcRenderer.invoke('encounters:bulkDelete', projectId, ids),
  batchCreateEncounters: (projectId, names, slots) => ipcRenderer.invoke('encounters:batchCreate', projectId, names, slots),
  exportStructure: (projectId) => ipcRenderer.invoke('encounters:exportStructure', projectId),
  previewImport: (projectId) => ipcRenderer.invoke('encounters:previewImport', projectId),
  applyImport: (projectId, toCreate, toAddFiles) => ipcRenderer.invoke('encounters:applyImport', projectId, toCreate, toAddFiles),

  // Media
  listMediaFiles: (encounterId) => ipcRenderer.invoke('media:list', encounterId),
  getMediaFile: (id) => ipcRenderer.invoke('media:get', id),
  updateMediaType: (id, mediaTypeId) => ipcRenderer.invoke('media:updateType', id, mediaTypeId),
  countMediaReviews: (mediaFileId) => ipcRenderer.invoke('media:countReviews', mediaFileId),
  moveMediaFile: (projectId, mediaFileId, newEncounterId) => ipcRenderer.invoke('media:move', projectId, mediaFileId, newEncounterId),
  renameMediaFile: (projectId, mediaFileId, name) => ipcRenderer.invoke('media:rename', projectId, mediaFileId, name),
  createMediaFile: (projectId, encounterId, name) => ipcRenderer.invoke('media:create', projectId, encounterId, name),
  deleteMediaFile: (projectId, mediaFileId) => ipcRenderer.invoke('media:deleteFile', projectId, mediaFileId),
  bulkDeleteMediaFiles: (projectId, ids) => ipcRenderer.invoke('media:bulkDelete', projectId, ids),
  bulkUpdateMediaType: (projectId, ids, mediaTypeId) => ipcRenderer.invoke('media:bulkUpdateType', projectId, ids, mediaTypeId),
  getVideoUrl: (filePath) => ipcRenderer.invoke('media:getUrl', filePath),
  getMediaPlaybackInfo: (mediaFileId) => ipcRenderer.invoke('media:getPlaybackInfo', mediaFileId),

  // Reviews
  listReviews: (mediaFileId) => ipcRenderer.invoke('reviews:list', mediaFileId),
  createReview: (data) => ipcRenderer.invoke('reviews:create', data),
  getReview: (id) => ipcRenderer.invoke('reviews:get', id),
  submitReview: (id, data) => ipcRenderer.invoke('reviews:submit', id, data),
  unsubmitReview: (id) => ipcRenderer.invoke('reviews:unsubmit', id),
  getMachineReviewNames: (projectId) => ipcRenderer.invoke('reviews:getMachineReviewNames', projectId),
  deleteReview: (id) => ipcRenderer.invoke('reviews:delete', id),
  restoreReview: (id) => ipcRenderer.invoke('reviews:restore', id),
  listDeletedReviews: (projectId) => ipcRenderer.invoke('reviews:listDeleted', projectId),
  saveTimestamp: (reviewId, data) => ipcRenderer.invoke('reviews:saveTimestamp', reviewId, data),
  deleteTimestamp: (id) => ipcRenderer.invoke('reviews:deleteTimestamp', id),
  updateTimestamp: (id, data) => ipcRenderer.invoke('reviews:updateTimestamp', id, data),
  saveFormResponse: (reviewId, data) => ipcRenderer.invoke('reviews:saveFormResponse', reviewId, data),

  // Setup
  saveMediaType: (projectId, data) => ipcRenderer.invoke('setup:saveMediaType', projectId, data),
  listMediaTypes: (projectId) => ipcRenderer.invoke('setup:listMediaTypes', projectId),
  countMediaTypeReviews: (id) => ipcRenderer.invoke('setup:countMediaTypeReviews', id),
  deleteMediaType: (projectId, id) => ipcRenderer.invoke('setup:deleteMediaType', projectId, id),
  saveForm: (projectId, data) => ipcRenderer.invoke('setup:saveForm', projectId, data),
  listForms: (projectId) => ipcRenderer.invoke('setup:listForms', projectId),
  getForm: (id) => ipcRenderer.invoke('setup:getForm', id),
  countFormResponses: (id) => ipcRenderer.invoke('setup:countFormResponses', id),
  deleteForm: (projectId, id) => ipcRenderer.invoke('setup:deleteForm', projectId, id),
  previewStructureMigration: (projectId, data) => ipcRenderer.invoke('setup:previewStructureMigration', projectId, data),
  migrateStructureReviews: (projectId, data) => ipcRenderer.invoke('setup:migrateStructureReviews', projectId, data),
  listVersionHistory: (projectId, data) => ipcRenderer.invoke('setup:listVersionHistory', projectId, data),
  restoreVersion: (projectId, data) => ipcRenderer.invoke('setup:restoreVersion', projectId, data),
  saveInstruction: (projectId, data) => ipcRenderer.invoke('setup:saveInstruction', projectId, data),
  listInstructions: (projectId) => ipcRenderer.invoke('setup:listInstructions', projectId),
  deleteInstruction: (projectId, id) => ipcRenderer.invoke('setup:deleteInstruction', projectId, id),
  uploadPdf: (projectId) => ipcRenderer.invoke('setup:uploadPdf', projectId),

  // App settings
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  exportDiagnostics: () => ipcRenderer.invoke('app:exportDiagnostics'),
  getUpdateStatus: () => ipcRenderer.invoke('app:updateStatus'),
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  downloadUpdate: () => ipcRenderer.invoke('app:downloadUpdate'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  onUpdateStatus: (cb) => appUpdateBridge.on(cb),
  offUpdateStatus: (id) => appUpdateBridge.off(id),
  getAppSettings: () => ipcRenderer.invoke('app:getSettings'),
  setAppSettings: (data) => ipcRenderer.invoke('app:setSettings', data),
  getProjectName: (projectId) => ipcRenderer.invoke('app:getProjectName', projectId),
  setProjectName: (projectId, name) => ipcRenderer.invoke('app:setProjectName', projectId, name),
  setCloudFolderName: (projectId, name) => ipcRenderer.invoke('app:setCloudFolderName', projectId, name),
  getCloudFolderName: (projectId) => ipcRenderer.invoke('app:getCloudFolderName', projectId),
  fetchProjectStructure: (projectId, options) => ipcRenderer.invoke('project:fetchStructure', projectId, options),
  checkManifest: (projectId) => ipcRenderer.invoke('project:checkManifest', projectId),

  // Owner password
  setOwnerPassword: (projectId, password) => ipcRenderer.invoke('project:setPassword', projectId, password),
  verifyOwnerPassword: (projectId, password) => ipcRenderer.invoke('project:verifyPassword', projectId, password),
  isProjectUnlocked: (projectId) => ipcRenderer.invoke('project:isUnlocked', projectId),
  lockProject: (projectId) => ipcRenderer.invoke('project:lock', projectId),

  // Sync
  syncNow: (projectId) => ipcRenderer.invoke('sync:now', projectId),
  getSyncStatus: (projectId) => ipcRenderer.invoke('sync:getStatus', projectId),
  selectSyncFolder: () => ipcRenderer.invoke('sync:selectFolder'),
  saveProjectFile: (projectId) => ipcRenderer.invoke('sync:saveFile', projectId),
  loadProjectFile: (projectId) => ipcRenderer.invoke('sync:loadFile', projectId),
  importProjectAsNew: () => ipcRenderer.invoke('sync:importAsNew'),
  joinFromLocalFolder: (folderPath) => ipcRenderer.invoke('sync:joinFromLocalFolder', folderPath),
  joinFromCloudFolder: (provider, folderId, folderName, stateFileId) => ipcRenderer.invoke('sync:joinFromCloudFolder', provider, folderId, folderName, stateFileId),
  exportExcel: (projectId) => ipcRenderer.invoke('export:excel', projectId),
  syncAcceptConfigUpdate: (projectId, configData) => ipcRenderer.invoke('sync:acceptConfigUpdate', projectId, configData),

  // Event: project config updated by owner on another machine (returns subscription id)
  onConfigUpdateAvailable: (cb) => configUpdateBridge.on(cb),
  offConfigUpdateAvailable: (id) => configUpdateBridge.off(id),

  // Event: a structural edit conflicted with another machine's during sync (LWW-resolved)
  onSyncConflict: (cb) => syncConflictBridge.on(cb),
  offSyncConflict: (id) => syncConflictBridge.off(id),

  // Events: cloud sync lost/regained internet connectivity
  onSyncOffline: (cb) => syncOfflineBridge.on(cb),
  offSyncOffline: (id) => syncOfflineBridge.off(id),
  onSyncOnline: (cb) => syncOnlineBridge.on(cb),
  offSyncOnline: (id) => syncOnlineBridge.off(id),
  onGoogleDriveAccessRequired: (cb) => syncGoogleDriveAccessBridge.on(cb),
  offGoogleDriveAccessRequired: (id) => syncGoogleDriveAccessBridge.off(id),
  onGoogleDriveMetadataMissing: (cb) => syncGoogleDriveMetadataBridge.on(cb),
  offGoogleDriveMetadataMissing: (id) => syncGoogleDriveMetadataBridge.off(id),

  // Cloud sync
  cloudConnectOneDrive: () => ipcRenderer.invoke('cloud:connectOneDrive'),
  cloudConnectGoogleDrive: () => ipcRenderer.invoke('cloud:connectGoogleDrive'),
  cloudPickGoogleDriveFolder: () => ipcRenderer.invoke('cloud:pickGoogleDriveFolder'),
  cloudPickGoogleDriveFiles: (fileIds) => ipcRenderer.invoke('cloud:pickGoogleDriveFiles', fileIds),
  cloudDisconnect: (projectId) => ipcRenderer.invoke('cloud:disconnect', projectId),
  cloudStatus: (projectId) => ipcRenderer.invoke('cloud:status', projectId),
  cloudListFolders: (provider, parentId) => ipcRenderer.invoke('cloud:listFolders', provider, parentId),
  cloudSelectFolder: (projectId, provider, folderId) => ipcRenderer.invoke('cloud:selectFolder', projectId, provider, folderId),
  cloudSyncNow: (projectId, options) => ipcRenderer.invoke('cloud:syncNow', projectId, options),
  cloudCancelAuth: () => ipcRenderer.invoke('cloud:cancelAuth'),
  cloudResolveFolderLink: (provider, link) => ipcRenderer.invoke('cloud:resolveFolderLink', provider, link),

  // File system
  selectFolder: () => ipcRenderer.invoke('fs:selectFolder'),
  scanMediaFolder: (folderPath, projectId) => ipcRenderer.invoke('fs:scanMediaFolder', folderPath, projectId),
  mediaHealthCheck: (projectId) => ipcRenderer.invoke('media:healthCheck', projectId),

  // File linking
  getBaseFolder: (projectId) => ipcRenderer.invoke('media:getBaseFolder', projectId),
  setBaseFolder: (projectId, folderPath) => ipcRenderer.invoke('media:setBaseFolder', projectId, folderPath),
  autolink: (projectId) => ipcRenderer.invoke('media:autolink', projectId),
  setMediaLink: (mediaFileId, projectId, localPath) => ipcRenderer.invoke('media:setLink', mediaFileId, projectId, localPath),
  markMediaNotApplicable: (mediaFileId) => ipcRenderer.invoke('media:markNotApplicable', mediaFileId),
  clearMediaLink: (mediaFileId) => ipcRenderer.invoke('media:clearLink', mediaFileId),
  browseMediaFile: (mediaFileId) => ipcRenderer.invoke('media:browseFile', mediaFileId),

  // Window
  setFullscreen: (flag) => ipcRenderer.invoke('window:setFullscreen', flag),
  isFullscreen: () => ipcRenderer.invoke('window:isFullscreen'),
  openWorkspaceWindow: (url) => ipcRenderer.invoke('window:openWorkspace', url),
  closeWorkspaceWindow: (reviewId) => ipcRenderer.invoke('window:closeWorkspace', reviewId),
  notifyReviewUpdate: (reviewId) => ipcRenderer.invoke('review:notifyUpdate', reviewId),

  // Event: review data changed in another window (returns subscription id)
  onReviewUpdated: (cb) => reviewUpdatedBridge.on(cb),
  offReviewUpdated: (id) => reviewUpdatedBridge.off(id),

  // Event: pop-out workspace window closed (returns subscription id)
  onWorkspaceClosed: (cb) => workspaceClosedBridge.on(cb),
  offWorkspaceClosed: (id) => workspaceClosedBridge.off(id),
})
