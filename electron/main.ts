import { configureApi, inspectApi } from './providers/api';
import { apiKey, setApiKey } from './api-keys';
import { setOllamaSettings } from './providers/ollama';
import { ollamaManagement, ollamaModelAction, ollamaPullList, pullOllama, cancelOllamaPull, startOllama, stopOllama, shutdownOllama } from './providers/ollama-management';
import { setLlamaBinary } from './runtimes/llamacpp';
import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray, type WebContents } from 'electron';
import { existsSync, mkdirSync, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from '../shared/catalog';
import { rasterize } from '../shared/brand';
import type { UsageReport, Attachment, FsEntry, MultiStart, Persisted, ProviderId, RunRequest } from '../shared/types';
import { gitDiff, gitStatus } from './git';
import { handleImageScheme, imagesDir, registerImageScheme } from './images';
import { listImportable, loadImportable } from './importer';
import { startMulti, stopMulti, stopMultiTurn } from './orchestrator';
import { Worker } from 'node:worker_threads';
import { execCli, providerStatus, resolveBinary } from './providers/detect';
import { cancelAll, cancelRun, injectMessage, runCli } from './providers/runner';
import { registerModelIpc } from './models/ipc';
import { registerWorkflowIpc } from './workflows/ipc';
import { register3dIpc } from './3d/ipc';
import { isModelingIntent, runChatModeling } from './3d/chat-model';
import { scheduler } from './runtimes/scheduler';
import { dataDir, load, save } from './store';
import { createTerminal, killTerminal, killTerminalsOf, resizeTerminal, writeTerminal } from './terminal';
import { checkUpdate, downloadUpdate, getUpdateState, installUpdate, setUpdaterEmitter } from './updater';
import type { UpdateChannel } from '../shared/types';

const here = fileURLToPath(new URL('.', import.meta.url));
let data: Persisted;
const isMac = process.platform === 'darwin';

const binaries = () => data.settings.binaries;
const sendTo = (wc: WebContents, channel: string, payload: unknown) => { if (!wc.isDestroyed()) wc.send(channel, payload); };
let quickWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pendingQuick: unknown = null;
/** Normale Fenster (ohne das versteckte Schnell-Prompt-Fenster). */
const allWindows = () => BrowserWindow.getAllWindows().filter((w) => w !== quickWin && !w.isDestroyed());
const mainWindow = () => allWindows().find((w) => w.id === primaryId) ?? allWindows()[0];
/** Das älteste noch offene Fenster führt periodische Hintergrundjobs (Auto-Import) aus. */
let primaryId = -1;

/** Marken-Icons zur Laufzeit aus der Geometrie gerastert (Fenster-Icon unter Linux/Windows, Tray). */
const iconCache = new Map<string, Electron.NativeImage>();
function brandImage(size: number, background: boolean) {
  const key = `${size}:${background}`;
  let img = iconCache.get(key);
  if (!img) {
    img = nativeImage.createFromBitmap(Buffer.from(rasterize(size, { background, order: 'bgra' })), { width: size, height: size });
    iconCache.set(key, img);
  }
  return img;
}
// Fenster-/Taskleisten-Icon: wie im Tray nur die Marke auf transparentem Grund (kein dunkles Quadrat).
const appIcon = () => brandImage(256, false);

function createWindow(hash = '') {
  const w = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: data?.settings.theme === 'light' ? '#fafaf9' : '#0e1013',
    title: 'Quorum',
    icon: appIcon(),
    frame: isMac, // eigene Titelleiste mit eigenen Fensterbuttons (macOS: native Ampel in eingelassener Leiste)
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 14, y: 13 } : undefined,
    webPreferences: { preload: join(here, 'preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  if (primaryId < 0 || !BrowserWindow.fromId(primaryId)) primaryId = w.id;
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  const state = () => { if (!w.isDestroyed()) sendTo(w.webContents, 'win:state', { maximized: w.isMaximized(), fullscreen: w.isFullScreen() }); };
  w.on('maximize', state); w.on('unmaximize', state); w.on('enter-full-screen', state); w.on('leave-full-screen', state);
  // Nach 'closed' sind window/webContents zerstört – Werte vorher festhalten.
  const wc = w.webContents, wid = w.id;
  w.on('closed', () => {
    killTerminalsOf(wc);
    if (wid === primaryId) primaryId = allWindows().find((x) => !x.isDestroyed())?.id ?? -1;
  });
  if (process.env.VITE_DEV_SERVER_URL) w.loadURL(process.env.VITE_DEV_SERVER_URL + (hash ? '#' + hash : ''));
  else w.loadFile(join(here, '../dist/index.html'), hash ? { hash } : undefined);
  return w;
}


// ---- Schnell-Prompt (Spotlight-artig), Tray und globaler Hotkey --------------------------------------

function createQuickWindow() {
  quickWin = new BrowserWindow({
    width: 720, height: 460, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    fullscreenable: false, minimizable: false, maximizable: false, title: 'Quorum Quick',
    vibrancy: isMac ? 'under-window' : undefined,
    webPreferences: { preload: join(here, 'preload.mjs'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  quickWin.setAlwaysOnTop(true, 'pop-up-menu');
  quickWin.on('blur', () => { if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) quickWin.hide(); });
  quickWin.on('close', (e) => { if (!quitting) { e.preventDefault(); quickWin?.hide(); } });
  if (process.env.VITE_DEV_SERVER_URL) quickWin.loadURL(process.env.VITE_DEV_SERVER_URL + '#/quick');
  else quickWin.loadFile(join(here, '../dist/index.html'), { hash: '/quick' });
}

function toggleQuick() {
  if (!quickWin || quickWin.isDestroyed()) createQuickWindow();
  const w = quickWin!;
  if (w.isVisible()) { w.hide(); return; }
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = disp.workArea;
  w.setPosition(Math.round(x + (width - 720) / 2), Math.round(y + height * 0.18));
  w.show(); w.focus();
  sendTo(w.webContents, 'quick:show', null);
}

/** Tray: nur die Marke (transparent), mit der kleinsten sinnvollen Rastergröße für scharfe Kanten. */
const trayImage = () => brandImage(64, false);

function showMain() {
  let w = mainWindow();
  if (!w) w = createWindow();
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
  return w;
}

function setupTray() {
  try {
    tray = new Tray(trayImage().resize({ width: 22, height: 22, quality: 'best' }));
    tray.setToolTip('Quorum');
    const menu = () => Menu.buildFromTemplate([
      { label: 'Quorum öffnen / Open', click: () => showMain() },
      { label: 'Schnell-Prompt / Quick prompt', accelerator: data.settings.quickHotkey, click: () => toggleQuick() },
      { label: 'Neues Fenster / New window', click: () => createWindow() },
      { type: 'separator' },
      { label: 'Beenden / Quit', click: () => { quitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu());
    tray.on('click', () => showMain());
  } catch { /* Tray nicht verfügbar (z. B. GNOME ohne AppIndicator) */ }
}

let registeredHotkey = '';
function registerHotkey() {
  const key = data.settings.quickHotkey;
  if (key === registeredHotkey) return;
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
  registeredHotkey = '';
  if (!key) return;
  try { if (globalShortcut.register(key, toggleQuick)) registeredHotkey = key; } catch { /* ungültiger Accelerator */ }
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'build', 'target', '.next', '__pycache__', '.venv', 'release']);

async function listFiles(root: string, query: string, limit = 40): Promise<string[]> {
  const out: string[] = [];
  const q = query.toLowerCase();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 6) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= limit) return;
      const name = ent.name;
      if (name.startsWith('.') && name !== '.github') continue;
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const rel = relative(root, full);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (!q || rel.toLowerCase().includes(q)) {
        out.push(rel);
      }
    }
  };
  await walk(root, 0);
  return out;
}

async function slashCommands(cwd: string): Promise<{ name: string; source: string }[]> {
  const res: { name: string; source: string }[] = [];
  const scan = async (dir: string, source: string, skills: boolean) => {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (skills && ent.isDirectory()) {
          try {
            await fsp.access(join(dir, ent.name, 'SKILL.md'));
            res.push({ name: ent.name, source });
          } catch { /* kein SKILL.md */ }
        } else if (!skills && ent.isFile() && ent.name.endsWith('.md')) {
          res.push({ name: ent.name.slice(0, -3), source });
        }
      }
    } catch { /* Ordner existiert nicht */ }
  };
  await Promise.all([
    scan(join(homedir(), '.claude', 'commands'), 'Benutzer-Befehl', false),
    scan(join(homedir(), '.claude', 'skills'), 'Benutzer-Skill', true),
    scan(join(cwd, '.claude', 'commands'), 'Projekt-Befehl', false),
    scan(join(cwd, '.claude', 'skills'), 'Projekt-Skill', true),
  ]);
  return res;
}

// ---- Nutzung: Auswertung im Worker-Thread, Ergebnis wird zwischengespeichert und an alle Fenster gepusht ----------------
let usageWorker: Worker | null = null;
let usageReport: UsageReport | null = null;
let usageAt = 0;
let usageRunning: Promise<UsageReport> | null = null;
function refreshUsage(): Promise<UsageReport> {
  if (usageRunning) return usageRunning;
  usageRunning = new Promise<UsageReport>((resolve, reject) => {
    if (!usageWorker) {
      usageWorker = new Worker(join(here, 'usage-worker.js'));
      usageWorker.unref();
      usageWorker.on('error', () => { usageWorker = null; });
    }
    const w = usageWorker;
    const onMsg = (m: { report?: UsageReport; error?: string }) => {
      w.off('message', onMsg);
      if (!m.report) { reject(new Error(m.error ?? 'Nutzung konnte nicht gelesen werden')); return; }
      usageReport = m.report; usageAt = Date.now();
      for (const win of allWindows()) sendTo(win.webContents, 'usage:report', m.report);
      resolve(m.report);
    };
    w.on('message', onMsg);
    w.postMessage(Date.now());
  }).finally(() => { usageRunning = null; });
  return usageRunning;
}

function registerIpc() {
  configureApi(() => data.settings.apiConnections ?? [], apiKey);
  setOllamaSettings(() => data.settings.ollama ?? {});
  ipcMain.handle('api:key', (_e, id: string, key: string) => setApiKey(id, key));
  ipcMain.handle('api:has-key', async (_e, id: string) => !!await apiKey(id));
  ipcMain.handle('api:inspect', (_e, connection: import('../shared/connections').ApiConnection) => inspectApi(connection));
  ipcMain.handle('ollama:manage', () => ollamaManagement());
  ipcMain.handle('ollama:action', (_e, action: 'load' | 'unload' | 'delete', model: string) => {
    if (!['load', 'unload', 'delete'].includes(action)) throw new Error('Unbekannte Ollama-Aktion');
    return ollamaModelAction(action, model);
  });
  ipcMain.handle('ollama:pull', (_e, model: string) => pullOllama(model, (state) => { for (const w of allWindows()) sendTo(w.webContents, 'ollama:progress', state); }));
  ipcMain.handle('ollama:pulls', () => ollamaPullList());
  ipcMain.handle('ollama:cancel-pull', (_e, id: string) => cancelOllamaPull(id));
  ipcMain.handle('ollama:start', () => startOllama());
  ipcMain.handle('ollama:stop', () => stopOllama());
  setLlamaBinary(() => data.settings.llamaBinary);
  scheduler.configure(data.settings.localRuntime);
  ipcMain.handle('store:load', () => data);
  ipcMain.handle('store:save', (e, d: Persisted) => {
    data = d; save(d);
    scheduler.configure(data.settings.localRuntime);
    registerHotkey();
    // Andere Fenster bekommen den neuen Stand (gleiche Daten in allen Fenstern).
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents !== e.sender) sendTo(w.webContents, 'store:sync', d);
  });
  ipcMain.handle('app:isPrimary', (e) => BrowserWindow.fromWebContents(e.sender)?.id === primaryId);

  ipcMain.handle('hub:run', async (e, req: RunRequest) => {
    const wc = e.sender;
    // Ohne gewählten Ordner läuft die CLI in einem leeren Arbeitsverzeichnis – kein Zugriff auf echte Projektdateien.
    if (!req.cwd || !existsSync(req.cwd)) {
      req = { ...req, cwd: join(dataDir(), 'scratch') };
      mkdirSync(req.cwd, { recursive: true });
    }
    // Modellier-Absicht im Satz: die 3D-Schleife läuft im Chat, das Ergebnis erscheint daneben.
    if (isModelingIntent(req.prompt) && (req.provider === 'local' || req.provider === 'claude') && !req.imageGen) {
      const { projectId } = await runChatModeling(req, (event) => sendTo(wc, 'hub:event', { runId: req.runId, event }), binaries());
      if (projectId) sendTo(wc, 'chat:project', { runId: req.runId, projectId });
      return;
    }
    await runCli(req, (event) => sendTo(wc, 'hub:event', { runId: req.runId, event }), binaries());
  });
  ipcMain.handle('hub:cancel', (_e, runId: string) => cancelRun(runId));
  // Lokale Modelle: Fortschritt und Status gehen an alle Fenster.
  registerModelIpc((channel, payload) => { for (const w of allWindows()) sendTo(w.webContents, channel, payload); });
  registerWorkflowIpc((channel, payload) => { for (const w of allWindows()) sendTo(w.webContents, channel, payload); }, binaries);
  register3dIpc((channel, payload) => { for (const w of allWindows()) sendTo(w.webContents, channel, payload); }, binaries);
  ipcMain.handle('hub:inject', (_e, runId: string, text: string, atts?: Attachment[]) => injectMessage(runId, text, atts));

  ipcMain.handle('multi:start', (e, m: MultiStart) => {
    const wc = e.sender;
    void startMulti(m.multiId, m.config, (event) => sendTo(wc, 'multi:event', { multiId: m.multiId, event }), binaries(), dataDir());
  });
  ipcMain.handle('multi:stop', (_e, id: string) => stopMulti(id));
  ipcMain.handle('multi:stop-turn', (_e, id: string, turnId: string) => stopMultiTurn(id, turnId));

  ipcMain.handle('provider:status', (_e, id: ProviderId, refresh?: boolean) => providerStatus(id, binaries(), refresh));
  ipcMain.handle('cli:exec', async (_e, id: ProviderId, args: string[], cwd?: string) => {
    const bin = resolveBinary(id, binaries());
    if (!bin) return { ok: false, code: null, stdout: '', stderr: `${PROVIDERS[id].bin} nicht gefunden` };
    return execCli(bin, args, cwd && existsSync(cwd) ? cwd : undefined, 120000);
  });

  ipcMain.handle('import:list', () => listImportable());
  ipcMain.handle('import:load', (_e, entries: import('../shared/types').ImportEntry[]) => loadImportable(entries));

  ipcMain.handle('git:status', (_e, cwd: string) => gitStatus(cwd));
  ipcMain.handle('git:diff', (_e, cwd: string, file?: string) => gitDiff(cwd, file));

  ipcMain.handle('dialog:folder', async (e) => {
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:files', async (e, kind: 'image' | 'json' | 'any') => {
    const filters = kind === 'image' ? [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] : kind === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [];
    const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, { properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('fs:files', (_e, root: string, q: string) => listFiles(root, q));
  ipcMain.handle('fs:slash', (_e, cwd: string) => slashCommands(cwd));
  ipcMain.handle('fs:basename', (_e, p: string) => basename(p));
  ipcMain.handle('shell:open', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p));
  // Erzeugte Bilder: nur Dateien aus dem Bilderordner der App.
  const ownImage = (p: string) => p.startsWith(imagesDir()) && existsSync(p);
  ipcMain.handle('image:copy', async (_e, p: string) => {
    if (!ownImage(p)) return;
    const png = nativeImage.createFromPath(p).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
  });
  ipcMain.handle('image:saveAs', async (e, p: string) => {
    if (!ownImage(p)) return false;
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const r = await (win ? dialog.showSaveDialog(win, { defaultPath: join(app.getPath('pictures'), basename(p)) }) : dialog.showSaveDialog({ defaultPath: basename(p) }));
    if (r.canceled || !r.filePath) return false;
    await fsp.copyFile(p, r.filePath);
    return true;
  });
  ipcMain.handle('shell:external', (_e, url: string) => { if (/^https?:\/\//.test(url)) return shell.openExternal(url); });
  ipcMain.handle('app:home', () => homedir());
  // Sofort mit dem letzten Stand antworten; ist er älter als 30 s, im Hintergrund neu auswerten (Ergebnis kommt per „usage:report“).
  ipcMain.handle('usage:scan', (_e, force?: boolean) => {
    if (usageReport && !force) { if (Date.now() - usageAt > 30_000) void refreshUsage().catch(() => {}); return usageReport; }
    return refreshUsage();
  });
  ipcMain.handle('quick:submit', (_e, q: unknown) => { pendingQuick = q; quickWin?.hide(); const w = showMain(); sendTo(w.webContents, 'quick:wake', null); });
  ipcMain.handle('quick:take', () => { const q = pendingQuick; pendingQuick = null; return q; });
  ipcMain.handle('quick:open', (_e, id: string) => { quickWin?.hide(); const w = showMain(); sendTo(w.webContents, 'app:open-chat', id); });
  ipcMain.handle('quick:hide', () => quickWin?.hide());
  ipcMain.handle('win:theme', (e, bg: string) => { BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(bg); });
  const winOf = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('win:minimize', (e) => winOf(e)?.minimize());
  ipcMain.handle('win:maximize', (e) => { const w = winOf(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
  ipcMain.handle('win:close', (e) => winOf(e)?.close());
  ipcMain.handle('win:state', (e) => ({ maximized: !!winOf(e)?.isMaximized(), fullscreen: !!winOf(e)?.isFullScreen() }));
  ipcMain.handle('win:new', (_e, hash?: string) => { createWindow(hash); });

  // Terminal (PTY über Python-Helfer) und Dateibaum für die Dock-Panels
  // Optional startet das Terminal direkt eine CLI (für die /usage-Abfrage im Hintergrund) statt der Shell.
  ipcMain.handle('term:create', (e, id: string, cwd: string, cols: number, rows: number, provider?: ProviderId) => {
    const bin = provider ? resolveBinary(provider, binaries()) : undefined;
    if (provider && !bin) return { mode: 'missing' as const };
    return createTerminal(e.sender, id, cwd, cols, rows, dataDir(), bin ? { bin, args: [] } : undefined);
  });
  ipcMain.handle('term:write', (_e, id: string, d: string) => writeTerminal(id, d));
  ipcMain.handle('term:resize', (_e, id: string, c: number, r: number) => resizeTerminal(id, c, r));
  ipcMain.handle('term:kill', (_e, id: string) => killTerminal(id));
  ipcMain.handle('fs:list', async (_e, dir: string): Promise<FsEntry[]> => {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries
        .filter((d) => d.name !== '.git')
        .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    } catch { return []; }
  });
  ipcMain.handle('fs:read', async (_e, file: string) => {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return { text: '', binary: false, truncated: false };
      const toRead = Math.min(st.size, 200_000);
      const fh = await fsp.open(file, 'r');
      try {
        const buf = Buffer.alloc(toRead);
        await fh.read(buf, 0, toRead, 0);
        const binary = buf.includes(0);
        return { text: binary ? '' : buf.toString('utf8'), binary, truncated: st.size > 200_000 };
      } finally {
        await fh.close();
      }
    } catch { return { text: '', binary: false, truncated: false }; }
  });

  // GitHub Updater IPC
  setUpdaterEmitter((channel, payload) => {
    for (const w of allWindows()) sendTo(w.webContents, channel, payload);
  });
  ipcMain.handle('updater:check', (_e, channel?: UpdateChannel) => checkUpdate(channel ?? data?.settings.updateChannel));
  ipcMain.handle('updater:download', () => downloadUpdate());
  ipcMain.handle('updater:install', () => installUpdate());
  ipcMain.handle('updater:state', () => getUpdateState());
}

// AppImage kann das SUID-chrome-sandbox nicht setzen; ohne Schalter startet Electron dort oft nicht.
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');

// Beim Umbenennen zu "Quorum" bleiben Chats und Einstellungen erhalten: der Datenordner bleibt ~/.config/ai-hub
// (außer er wird per --user-data-dir überschrieben).
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'ai-hub'));
app.setName('Quorum');
// Linux: Taskleiste/Dock ordnen das Fenster über den Namen der .desktop-Datei zu (passt zu `desktopName` in package.json).
if (process.platform === 'linux') app.setDesktopName('quorum.desktop');

registerImageScheme();
app.whenReady().then(() => {
  handleImageScheme();
  data = load();
  // Neustart: angedockte Panels (Terminal, Ordner, Agenten & Aufgaben, Änderungen) starten geschlossen.
  if (data.settings.dock?.panels) for (const p of Object.values(data.settings.dock.panels)) p.visible = false;
  registerIpc();
  createWindow();
  createQuickWindow();
  setupTray();
  registerHotkey();
  // Nach dem Start im Hintergrund prüfen (wenn aktiviert)
  setTimeout(() => {
    if (data?.settings.autoCheckUpdate !== false) void checkUpdate(data?.settings.updateChannel).catch(() => {});
  }, 4000);
  app.on('activate', () => { if (allWindows().length === 0) createWindow(); });
});
let shutdownStarted = false;
let shutdownComplete = false;
app.on('before-quit', (event) => {
  quitting = true;
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  cancelAll();
  void Promise.allSettled([shutdownOllama(), scheduler.shutdown()]).then(() => { shutdownComplete = true; app.quit(); });
});
// Signals use the same cleanup path as a normal quit, including owned local servers.
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => app.quit());
// Kontextmenü (Kopieren/Einfügen …) – randlose Fenster haben standardmäßig keines.
app.on('web-contents-created', (_e, wc) => {
  wc.on('context-menu', (_ev, p) => {
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (p.isEditable) {
      items.push(
        { role: 'cut', label: 'Ausschneiden / Cut', enabled: p.editFlags.canCut },
        { role: 'copy', label: 'Kopieren / Copy', enabled: p.editFlags.canCopy },
        { role: 'paste', label: 'Einfügen / Paste', enabled: p.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: 'Alles auswählen / Select all' },
      );
    } else if (p.selectionText) items.push({ role: 'copy', label: 'Kopieren / Copy' }, { role: 'selectAll', label: 'Alles auswählen / Select all' });
    else if (p.linkURL) items.push({ label: 'Link kopieren / Copy link', click: () => clipboard.writeText(p.linkURL) });
    else items.push({ role: 'selectAll', label: 'Alles auswählen / Select all' });
    Menu.buildFromTemplate(items).popup();
  });
});
app.on('will-quit', () => globalShortcut.unregisterAll());
// Der Hub läuft im Tray weiter (Hotkey bleibt aktiv); beendet wird über das Tray-Menü bzw. Strg+Q.
app.on('window-all-closed', () => { if (!tray) app.quit(); });
