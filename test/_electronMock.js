// Must be required BEFORE any project code. Intercepts require('electron') so the
// main-process modules (which do `const { app } = require('electron')` at load time)
// resolve against a stub with a temp userData dir instead of the real Electron runtime.
const Module = require('module')
const os = require('os')
const path = require('path')
const fs = require('fs')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sdmo-test-'))

const electronMock = {
  app: {
    getPath: () => userData,
    getName: () => 'SDMo',
    setName() {},
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on() {},
    quit() {},
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  ipcMain: { handle() {}, on() {} },
  shell: { openExternal() {} },
  BrowserWindow: class { constructor() {} },
  protocol: { registerFileProtocol() {}, registerSchemesAsPrivileged() {} },
  contextBridge: { exposeInMainWorld() {} },
  ipcRenderer: { invoke() {}, on() {}, removeListener() {} },
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') return electronMock
  return origLoad.apply(this, arguments)
}

module.exports = { userData }
