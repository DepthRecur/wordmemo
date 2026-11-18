import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordmemo-test-'))

export const app = {
  getPath: (_name?: string) => dir,
  getVersion: () => '0.1.0-test',
  getAppPath: () => process.cwd(),
  isPackaged: false,
  setLoginItemSettings: () => undefined,
  whenReady: async () => undefined,
  on: () => undefined,
  quit: () => undefined
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8')
}

export class Notification {
  static isSupported() {
    return false
  }
  on() {
    return this
  }
  show() {
    return undefined
  }
}

export const ipcMain = { handle: () => undefined }
export const dialog = {}
export const shell = {}
export const BrowserWindow = class {}
export const Tray = class {}
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined }
export const nativeImage = { createFromDataURL: () => ({}) }
export const webUtils = { getPathForFile: () => '' }
export const contextBridge = { exposeInMainWorld: () => undefined }
export const ipcRenderer = { invoke: async () => undefined, on: () => undefined, removeListener: () => undefined }

export default {
  app,
  safeStorage,
  Notification,
  ipcMain,
  dialog,
  shell,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  webUtils,
  contextBridge,
  ipcRenderer
}
