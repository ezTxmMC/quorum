import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type { ChatHostManager } from './manager';

type Disposition = 'keep' | 'stop';
interface Options {
  manager: ChatHostManager;
  windows: () => BrowserWindow[];
  save: () => boolean;
  acknowledge: () => Promise<void>;
  cleanup: (keepChats: boolean) => Promise<void>;
  setQuitting: (value: boolean) => void;
}

export class ChatLifecycle {
  private readonly options: Options;
  private readonly approved = new Set<number>();
  private readonly pending = new Set<number>();
  private readonly handshakes = new Map<string, { owner: number; resolve: (error?: string) => void }>();
  private disposition?: Disposition;
  private shuttingDown = false;
  private complete = false;

  constructor(options: Options) {
    this.options = options;
    ipcMain.handle('chat:ready-close', ({ sender }, token: string, error?: string) => {
      const pending = this.handshakes.get(token);
      if (pending?.owner === sender.id) { pending.resolve(error); }
    });
    app.on('before-quit', (event) => {
      if (this.complete) { return; }
      event.preventDefault();
      if (this.shuttingDown) { return; }
      this.shuttingDown = true;
      void this.quit().catch((error) => this.failure(error));
    });
  }

  private async choose(owner?: BrowserWindow): Promise<Disposition | undefined> {
    const active = await this.options.manager.active();
    if (!active.length) { return 'stop'; }
    const options: Electron.MessageBoxOptions = {
      type: 'question', buttons: ['Abbrechen', 'Bis zum Ende weiterlaufen lassen', 'Alle Chat-Prozesse stoppen'], defaultId: 0, cancelId: 0,
      title: 'Laufende Chats', message: `${active.length} Chat-Prozess${active.length === 1 ? '' : 'e'} ${active.length === 1 ? 'ist' : 'sind'} noch aktiv.`,
      detail: 'Weiterlaufende Chats arbeiten ohne geöffnetes Quorum weiter. Beim nächsten Start werden laufende Chats und fertige Ergebnisse wieder eingehängt. „Alle stoppen“ beendet auch die zugehörigen Provider-Unterprozesse.',
    };
    const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
    if (result.response === 1) { return 'keep'; }
    if (result.response === 2) { return 'stop'; }
    return undefined;
  }

  private prepare(window: BrowserWindow): Promise<void> {
    if (window.isDestroyed() || window.webContents.isDestroyed()) { return Promise.resolve(); }
    const token = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish('Fenster reagiert nicht. Änderungen konnten nicht vor dem Schließen gespeichert werden.'), 5000);
      const finish = (error?: string) => {
        clearTimeout(timer);
        this.handshakes.delete(token);
        if (error) { reject(new Error(error)); return; }
        resolve();
      };
      this.handshakes.set(token, { owner: window.webContents.id, resolve: finish });
      window.webContents.send('chat:prepare-close', token);
    });
  }

  guard(window: BrowserWindow): void {
    window.on('close', (event) => {
      if (this.approved.has(window.id) || this.complete) { return; }
      event.preventDefault();
      if (this.pending.has(window.id) || this.shuttingDown) { return; }
      this.pending.add(window.id);
      void (async () => {
        const choice = await this.choose(window);
        if (!choice || window.isDestroyed()) { this.options.setQuitting(false); return; }
        if (this.options.windows().length <= 1) {
          this.disposition = choice;
          app.quit();
          return;
        }
        await this.prepare(window);
        if (!this.options.save()) { throw new Error('Chat-Verlauf konnte nicht gespeichert werden.'); }
        await this.options.acknowledge();
        if (choice === 'stop') { await this.options.manager.stopAll(); }
        this.approved.add(window.id);
        window.close();
      })().catch((error) => this.failure(error)).finally(() => this.pending.delete(window.id));
    });
    window.on('closed', () => { this.approved.delete(window.id); this.pending.delete(window.id); });
  }

  cancelled(windowId: number): void {
    this.options.manager.resumeStarts();
    this.approved.delete(windowId);
    this.disposition = undefined;
    this.shuttingDown = false;
    this.complete = false;
    this.options.setQuitting(false);
  }

  private async quit(): Promise<void> {
    const windows = this.options.windows();
    const choice = this.disposition ?? await this.choose(windows[0]);
    if (!choice) { this.shuttingDown = false; this.options.setQuitting(false); return; }
    this.options.manager.pauseStarts();
    await Promise.all(windows.map((window) => this.prepare(window)));
    if (!this.options.save()) { throw new Error('Chat-Verlauf konnte nicht gespeichert werden.'); }
    await this.options.acknowledge();
    if (choice === 'stop') { await this.options.manager.stopAll(); }
    if (choice === 'keep') { await this.options.manager.prepareDetach(); }
    this.options.setQuitting(true);
    await this.options.cleanup(choice === 'keep');
    for (const window of windows) { this.approved.add(window.id); }
    this.complete = true;
    app.quit();
  }

  private failure(error: unknown): void {
    this.options.manager.resumeStarts();
    this.shuttingDown = false;
    this.complete = false;
    this.disposition = undefined;
    this.options.setQuitting(false);
    dialog.showErrorBox('Quorum bleibt geöffnet', error instanceof Error ? error.message : String(error));
  }
}
