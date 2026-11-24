// IPC für 3D-Projekte: Verwalten, Modellierungslauf mit einem wählbaren Modell, Verlauf, Blender-Status.
import { ipcMain } from 'electron';
import type { ProviderId } from '../../shared/types';
import { openThreeDRoutes } from './routes';

type Send = (channel: string, payload: unknown) => void;

export { pythonDir } from './blender';

export function register3dIpc(send: Send, binaries: () => Partial<Record<ProviderId, string>>): void {
  const routes = openThreeDRoutes(send, binaries);
  for (const [channel, handler] of Object.entries(routes)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => (handler as (...values: unknown[]) => unknown)(...args));
  }
}
