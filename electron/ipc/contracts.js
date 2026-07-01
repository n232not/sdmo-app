function isIntLike(value) {
  return Number.isInteger(value) || (typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value)))
}

function isOptionalIntLike(value) {
  return value == null || value === '' || isIntLike(value)
}

function isString(value) {
  return typeof value === 'string'
}

function isOptionalString(value) {
  return value == null || isString(value)
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalObject(value) {
  return value == null || isObject(value)
}

function isIdArray(value) {
  return Array.isArray(value) && value.every(isIntLike)
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isString)
}

function assertArgs(channel, args, rules) {
  if (!rules) return
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!rule(args[i])) {
      throw new Error(`Invalid IPC arguments for ${channel}: argument ${i + 1}`)
    }
  }
}

const contracts = {
  'projects:get': [isIntLike],
  'projects:createSample': [],
  'projects:update': [isIntLike, isObject],
  'projects:delete': [isIntLike],
  'project:setPassword': [isIntLike, isOptionalString],
  'project:verifyPassword': [isIntLike, isString],
  'project:lock': [isIntLike],
  'project:isUnlocked': [isIntLike],

  'encounters:list': [isIntLike],
  'encounters:get': [isIntLike],
  'encounters:create': [isIntLike, isString],
  'encounters:rename': [isIntLike, isIntLike, isString],
  'encounters:countReviews': [isIntLike],
  'encounters:delete': [isIntLike, isIntLike],
  'encounters:bulkDelete': [isIntLike, isIdArray],
  'encounters:batchCreate': [isIntLike, isStringArray, Array.isArray],
  'encounters:applyImport': [isIntLike, Array.isArray, Array.isArray],

  'media:list': [isIntLike],
  'media:get': [isIntLike],
  'media:updateType': [isIntLike, isOptionalIntLike],
  'media:countReviews': [isIntLike],
  'media:move': [isIntLike, isIntLike, isIntLike],
  'media:rename': [isIntLike, isIntLike, isString],
  'media:create': [isIntLike, isIntLike, isString],
  'media:deleteFile': [isIntLike, isIntLike],
  'media:bulkDelete': [isIntLike, isIdArray],
  'media:bulkUpdateType': [isIntLike, isIdArray, isOptionalIntLike],
  'media:getUrl': [isString],
  'media:getPlaybackInfo': [isIntLike],
  'media:getBaseFolder': [isIntLike],
  'media:setBaseFolder': [isIntLike, isOptionalString],
  'media:autolink': [isIntLike],
  'media:setLink': [isIntLike, isIntLike, isString],
  'media:markNotApplicable': [isIntLike],
  'media:clearLink': [isIntLike],
  'media:browseFile': [isIntLike],
  'media:healthCheck': [isIntLike],

  'reviews:list': [isIntLike],
  'reviews:create': [isObject],
  'reviews:get': [isIntLike],
  'reviews:submit': [isIntLike, isObject],
  'reviews:unsubmit': [isIntLike],
  'reviews:getMachineReviewNames': [isIntLike],
  'reviews:delete': [isIntLike],
  'reviews:restore': [isIntLike],
  'reviews:listDeleted': [isIntLike],
  'reviews:saveTimestamp': [isIntLike, isObject],
  'reviews:deleteTimestamp': [isIntLike],
  'reviews:updateTimestamp': [isIntLike, isObject],
  'reviews:saveFormResponse': [isIntLike, isObject],

  'setup:saveMediaType': [isIntLike, isObject],
  'setup:listMediaTypes': [isIntLike],
  'setup:countMediaTypeReviews': [isIntLike],
  'setup:deleteMediaType': [isIntLike, isIntLike],
  'setup:saveForm': [isIntLike, isObject],
  'setup:listForms': [isIntLike],
  'setup:getForm': [isIntLike],
  'setup:countFormResponses': [isIntLike],
  'setup:deleteForm': [isIntLike, isIntLike],
  'setup:previewStructureMigration': [isIntLike, isObject],
  'setup:migrateStructureReviews': [isIntLike, isObject],
  'setup:listVersionHistory': [isIntLike, isObject],
  'setup:restoreVersion': [isIntLike, isObject],
  'setup:saveInstruction': [isIntLike, isObject],
  'setup:listInstructions': [isIntLike],
  'setup:deleteInstruction': [isIntLike, isIntLike],
  'setup:uploadPdf': [isIntLike],

  'app:getInfo': [],
  'app:exportDiagnostics': [],
  'app:updateStatus': [],
  'app:checkForUpdates': [],
  'app:downloadUpdate': [],
  'app:installUpdate': [],
  'app:getProjectName': [isIntLike],
  'app:setProjectName': [isIntLike, isString],
  'app:setCloudFolderName': [isIntLike, isString],
  'app:getCloudFolderName': [isIntLike],
  'project:fetchStructure': [isIntLike, isOptionalObject],
  'project:checkManifest': [isIntLike],

  'sync:now': [isIntLike],
  'sync:getStatus': [isIntLike],
  'sync:saveFile': [isIntLike],
  'sync:loadFile': [isIntLike],
  'sync:acceptConfigUpdate': [isIntLike, isObject],
  'sync:joinFromLocalFolder': [isString],
  'sync:joinFromCloudFolder': [isString, isString, isOptionalString, isOptionalString],
  'export:excel': [isIntLike],

  'cloud:disconnect': [isIntLike],
  'cloud:status': [isIntLike],
  'cloud:listFolders': [isString, isOptionalString],
  'cloud:selectFolder': [isIntLike, isString, isString],
  'cloud:syncNow': [isIntLike, isOptionalObject],
  'cloud:resolveFolderLink': [isString, isString],

  'fs:scanMediaFolder': [isString, isIntLike],
  'window:setFullscreen': [(value) => typeof value === 'boolean'],
  'window:openWorkspace': [isString],
  'window:closeWorkspace': [isIntLike],
  'review:notifyUpdate': [isIntLike],
}

function validateIpcArgs(channel, args) {
  assertArgs(channel, args, contracts[channel])
}

module.exports = { validateIpcArgs, contracts }
