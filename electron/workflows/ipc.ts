import { ipcMain } from 'electron';
import { openWorkflowRoutes } from './routes';

export function registerWorkflowIpc(...args: Parameters<typeof openWorkflowRoutes>) {
  for (const [channel, handle] of Object.entries(openWorkflowRoutes(...args))) {
    ipcMain.handle(channel, (_event, ...values) => Reflect.apply(handle, undefined, values));
  }
}
