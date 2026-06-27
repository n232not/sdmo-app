const { contextBridge, ipcRenderer } = require('electron')

// Store wrapper functions so we can pass the exact reference to removeListener.
// Anonymous wrappers created in .on() calls can't be removed with the original cb.
let _configUpdateWrapper = null
let _reviewUpdatedWrapper = null
let _workspaceClosedWrapper = null

contextBridge.exposeInMainWorld('api', {
  // Projects
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (data) => ipcRenderer.invoke('projects:create', data),
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

  // Media
  listMediaFiles: (encounterId) => ipcRenderer.invoke('media:list', encounterId),
  getMediaFile: (id) => ipcRenderer.invoke('media:get', id),
  updateMediaType: (id, mediaTypeId) => ipcRenderer.invoke('media:updateType', id, mediaTypeId),
  countMediaReviews: (mediaFileId) => ipcRenderer.invoke('media:countReviews', mediaFileId),
  moveMediaFile: (projectId, mediaFileId, newEncounterId) => ipcRenderer.invoke('media:move', projectId, mediaFileId, newEncounterId),
  renameMediaFile: (projectId, mediaFileId, name) => ipcRenderer.invoke('media:rename', projectId, mediaFileId, name),
  deleteMediaFile: (projectId, mediaFileId) => ipcRenderer.invoke('media:deleteFile', projectId, mediaFileId),
  getVideoUrl: (filePath) => ipcRenderer.invoke('media:getUrl', filePath),

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
  saveInstruction: (projectId, data) => ipcRenderer.invoke('setup:saveInstruction', projectId, data),
  listInstructions: (projectId) => ipcRenderer.invoke('setup:listInstructions', projectId),
  deleteInstruction: (projectId, id) => ipcRenderer.invoke('setup:deleteInstruction', projectId, id),
  uploadPdf: (projectId) => ipcRenderer.invoke('setup:uploadPdf', projectId),

  // App settings
  getAppSettings: () => ipcRenderer.invoke('app:getSettings'),
  setAppSettings: (data) => ipcRenderer.invoke('app:setSettings', data),
  getProjectName: (projectId) => ipcRenderer.invoke('app:getProjectName', projectId),
  setProjectName: (projectId, name) => ipcRenderer.invoke('app:setProjectName', projectId, name),
  setCloudFolderName: (projectId, name) => ipcRenderer.invoke('app:setCloudFolderName', projectId, name),
  getCloudFolderName: (projectId) => ipcRenderer.invoke('app:getCloudFolderName', projectId),
  fetchProjectStructure: (projectId) => ipcRenderer.invoke('project:fetchStructure', projectId),
  checkManifest: (projectId) => ipcRenderer.invoke('project:checkManifest', projectId),
  // Owner password
  setOwnerPassword: (projectId, password) => ipcRenderer.invoke('project:setPassword', projectId, password),
  verifyOwnerPassword: (projectId, password) => ipcRenderer.invoke('project:verifyPassword', projectId, password),
  lockProject: (projectId) => ipcRenderer.invoke('project:lock', projectId),

  // Sync
  syncNow: (projectId) => ipcRenderer.invoke('sync:now', projectId),
  getSyncStatus: (projectId) => ipcRenderer.invoke('sync:getStatus', projectId),
  selectSyncFolder: () => ipcRenderer.invoke('sync:selectFolder'),
  saveProjectFile: (projectId) => ipcRenderer.invoke('sync:saveFile', projectId),
  loadProjectFile: (projectId) => ipcRenderer.invoke('sync:loadFile', projectId),
  importProjectAsNew: () => ipcRenderer.invoke('sync:importAsNew'),
  joinFromLocalFolder: (folderPath) => ipcRenderer.invoke('sync:joinFromLocalFolder', folderPath),
  joinFromCloudFolder: (provider, folderId, folderName) => ipcRenderer.invoke('sync:joinFromCloudFolder', provider, folderId, folderName),
  exportExcel: (projectId) => ipcRenderer.invoke('export:excel', projectId),
  syncAcceptConfigUpdate: (projectId, configData) => ipcRenderer.invoke('sync:acceptConfigUpdate', projectId, configData),
  onConfigUpdateAvailable: (cb) => {
    if (_configUpdateWrapper) ipcRenderer.removeListener('sync:configUpdateAvailable', _configUpdateWrapper)
    _configUpdateWrapper = (_, d) => cb(d)
    ipcRenderer.on('sync:configUpdateAvailable', _configUpdateWrapper)
  },
  offConfigUpdateAvailable: () => {
    if (_configUpdateWrapper) {
      ipcRenderer.removeListener('sync:configUpdateAvailable', _configUpdateWrapper)
      _configUpdateWrapper = null
    }
  },

  // Cloud sync
  cloudConnectOneDrive: () => ipcRenderer.invoke('cloud:connectOneDrive'),
  cloudConnectGoogleDrive: () => ipcRenderer.invoke('cloud:connectGoogleDrive'),
  cloudDisconnect: (projectId) => ipcRenderer.invoke('cloud:disconnect', projectId),
  cloudStatus: (projectId) => ipcRenderer.invoke('cloud:status', projectId),
  cloudListFolders: (provider, parentId) => ipcRenderer.invoke('cloud:listFolders', provider, parentId),
  cloudSelectFolder: (projectId, provider, folderId) => ipcRenderer.invoke('cloud:selectFolder', projectId, provider, folderId),
  cloudSyncNow: (projectId) => ipcRenderer.invoke('cloud:syncNow', projectId),
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
  onReviewUpdated: (cb) => {
    if (_reviewUpdatedWrapper) ipcRenderer.removeListener('review:updated', _reviewUpdatedWrapper)
    _reviewUpdatedWrapper = (_, id) => cb(id)
    ipcRenderer.on('review:updated', _reviewUpdatedWrapper)
  },
  offReviewUpdated: () => {
    if (_reviewUpdatedWrapper) {
      ipcRenderer.removeListener('review:updated', _reviewUpdatedWrapper)
      _reviewUpdatedWrapper = null
    }
  },
  onWorkspaceClosed: (cb) => {
    if (_workspaceClosedWrapper) ipcRenderer.removeListener('workspace:closed', _workspaceClosedWrapper)
    _workspaceClosedWrapper = (_, id) => cb(id)
    ipcRenderer.on('workspace:closed', _workspaceClosedWrapper)
  },
  offWorkspaceClosed: () => {
    if (_workspaceClosedWrapper) {
      ipcRenderer.removeListener('workspace:closed', _workspaceClosedWrapper)
      _workspaceClosedWrapper = null
    }
  },

})
