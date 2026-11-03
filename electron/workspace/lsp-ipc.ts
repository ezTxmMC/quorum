import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { LspManager } from '../../core/ide/lsp/manager';
import { installedServer } from '../../core/ide/lsp/servers';
import { workspaceRoot } from '../../core/ide/paths';
import type { LspDocument, LspLanguage, LspRequest } from '../../shared/ide/lsp';

export function registerLspIpc(): () => Promise<void> {
  const managers = new Map<number, LspManager>();
  const trusted = new Map<number, Set<string>>();
  const prompts = new Map<string, Promise<boolean>>();
  let shuttingDown = false;
  let generation = 0;
  const manager = (sender: WebContents): LspManager => {
    if (shuttingDown || sender.isDestroyed()) { throw new Error('Workspace connection is closed'); }
    const existing = managers.get(sender.id);
    if (existing) { return existing; }
    const service = new LspManager((event) => {
      if (!sender.isDestroyed()) { sender.send('lsp:event', event); }
    }, (language) => installedServer(language, process.resourcesPath));
    managers.set(sender.id, service);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) { return; }
      cleaned = true;
      sender.removeListener('destroyed', cleanup);
      sender.removeListener('did-start-navigation', navigation);
      sender.removeListener('render-process-gone', cleanup);
      if (managers.get(sender.id) === service) {
        managers.delete(sender.id);
        trusted.delete(sender.id);
      }
      void service.dispose();
    };
    const navigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame && !isInPlace) { cleanup(); }
    };
    sender.once('destroyed', cleanup);
    sender.once('render-process-gone', cleanup);
    sender.on('did-start-navigation', navigation);
    return service;
  };
  const ensureTrust = async (sender: WebContents, root: string): Promise<boolean> => {
    const canonical = workspaceRoot(root);
    if (trusted.get(sender.id)?.has(canonical)) { return true; }
    const key = `${sender.id}\0${canonical}`;
    const existing = prompts.get(key);
    if (existing) { return existing; }
    const requestGeneration = generation;
    const prompt = (async () => {
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) { return false; }
      const result = await dialog.showMessageBox(owner, {
        type: 'question', buttons: ['Abbrechen', 'Workspace vertrauen und LSP starten'], defaultId: 0, cancelId: 0,
        title: 'Language Server starten', message: 'Diesem Workspace für die Codeanalyse vertrauen?',
        detail: `${canonical}\n\nLanguage Server sind lokale Programme. Sie lesen Projektdateien und Konfiguration und können weitere Analyseprozesse starten. Nur für vertrauenswürdige Projekte aktivieren. Es werden keine Server heruntergeladen.`,
      });
      if (result.response !== 1 || sender.isDestroyed() || shuttingDown || requestGeneration !== generation) { return false; }
      const roots = trusted.get(sender.id) ?? new Set<string>();
      roots.add(canonical);
      trusted.set(sender.id, roots);
      return true;
    })().finally(() => prompts.delete(key));
    prompts.set(key, prompt);
    return prompt;
  };
  const authorized = (sender: WebContents, root: string): LspManager => {
    if (!trusted.get(sender.id)?.has(workspaceRoot(root))) { throw new Error('Workspace has not been trusted for LSP'); }
    return manager(sender);
  };
  ipcMain.handle('lsp:start', async ({ sender }, root: string, language: LspLanguage) => {
    if (!['typescript', 'python'].includes(language)) { throw new Error('Unsupported language server'); }
    if (!await ensureTrust(sender, root)) { return { root: workspaceRoot(root), language, state: 'stopped' }; }
    return manager(sender).start(root, language);
  });
  ipcMain.handle('lsp:stop', ({ sender }, root: string, language: LspLanguage) => managers.get(sender.id)?.stop(root, language));
  ipcMain.handle('lsp:sync', ({ sender }, document: LspDocument) => authorized(sender, document.root).sync(document));
  ipcMain.handle('lsp:saved', ({ sender }, root: string, language: LspLanguage, path: string) => authorized(sender, root).saved(root, language, path));
  ipcMain.handle('lsp:close', ({ sender }, root: string, language: LspLanguage, path: string) => managers.get(sender.id)?.closeDocument(root, language, path));
  ipcMain.handle('lsp:request', ({ sender }, input: LspRequest) => authorized(sender, input.root).request(input));
  return async () => {
    shuttingDown = true;
    generation++;
    trusted.clear();
    const services = [...managers.values()];
    managers.clear();
    try { await Promise.all(services.map((service) => service.dispose())); }
    finally { shuttingDown = false; }
  };
}
