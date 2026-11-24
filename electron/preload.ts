import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createHub } from '../shared/bridge';

contextBridge.exposeInMainWorld('hub', createHub({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  sub(channel, callback) {
    const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform,
}));
