import { EventEmitter } from 'node:events';

export const answers: number[] = [];
export const calls: string[] = [];
export const windows: FakeWindow[] = [];
export const handlers = new Map<string, (...args: unknown[]) => unknown>();
export const ipcMain = { handle: (name: string, callback: (...args: unknown[]) => unknown) => handlers.set(name, callback) };
export const dialog = {
  showMessageBox: async () => { calls.push('question'); return { response: answers.shift() ?? 0 }; },
  showErrorBox: (_title: string, message: string) => calls.push(`error:${message}`),
};
export const app = new class extends EventEmitter {
  exited = false;
  quit() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    this.emit('before-quit', event);
    if (event.prevented) { return; }
    this.exited = true;
    for (const window of windows) { window.close(); }
  }
}();
export class FakeWindow extends EventEmitter {
  id: number;
  destroyed = false;
  prepareError?: string;
  webContents: { id: number; isDestroyed: () => boolean; send: (channel: string, token: string) => void };
  constructor(id: number) {
    super(); this.id = id;
    this.webContents = { id, isDestroyed: () => this.destroyed, send: (_channel, token) => {
      calls.push(`prepare:${id}`);
      void handlers.get('chat:ready-close')?.({ sender: this.webContents }, token, this.prepareError);
    } };
    windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  close() {
    if (this.destroyed) { return; }
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    this.emit('close', event);
    if (!event.prevented) { this.destroyed = true; this.emit('closed'); }
  }
}
export function reset() { app.removeAllListeners(); app.exited = false; answers.length = 0; calls.length = 0; windows.length = 0; handlers.clear(); }
