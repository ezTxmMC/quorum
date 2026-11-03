import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OPTIONS, defaultDock, defaultTerminal } from '../shared/catalog.ts';
import type { Persisted } from '../shared/types';

/** Datenordner: QUORUM_DATA_DIR, sonst derselbe Ordner wie in der App (~/.config/ai-hub bzw. Application Support / APPDATA). Kein Electron nötig. */
function defaultDataDir(): string {
  if (process.env.QUORUM_DATA_DIR) return process.env.QUORUM_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'ai-hub');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'ai-hub');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'ai-hub');
}
let resolver: () => string = defaultDataDir;
/** Der Hauptprozess setzt hier app.getPath('userData') (berücksichtigt --user-data-dir). */
export const setDataDirResolver = (fn: () => string) => { resolver = fn; };
export const dataDir = () => {
  const d = resolver();
  mkdirSync(d, { recursive: true });
  return d;
};
const file = () => join(dataDir(), 'hub.json');

export function defaults(): Persisted {
  return {
    version: 1,
    settings: {
      theme: 'dark',
      language: /^de/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale) ? 'de' : 'en',
      sidebarPinned: true,
      quickHotkey: 'CommandOrControl+Shift+Space',
      dock: defaultDock(),
      terminal: defaultTerminal(),
      autoImport: true,
      accent: '#7c8cff',
      defaultProvider: 'claude',
      defaultCwd: homedir(),
      binaries: {},
      providerDefaults: { claude: { ...DEFAULT_OPTIONS.claude }, codex: { ...DEFAULT_OPTIONS.codex }, antigravity: { ...DEFAULT_OPTIONS.antigravity }, opencode: {}, ollama: {}, local: {}, api: {}, acp: { ...DEFAULT_OPTIONS.acp } },
      updateChannel: 'release',
      autoCheckUpdate: true,
      chatList: { groupBy: 'project', sortBy: 'updated', sortOrder: 'desc' },
    },
    recentProjects: [],
    projects: [],
    hidden: [],
    dismissed: [],
    sessions: [],
    multiRuns: [],
    presets: [],
  };
}

export function load(): Persisted {
  const base = defaults();
  try {
    if (!existsSync(file())) return base;
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Persisted>;
    return { ...base, ...raw, settings: { ...base.settings, ...raw.settings, providerDefaults: { ...base.settings.providerDefaults, ...raw.settings?.providerDefaults } } };
  } catch {
    // Unlesbare hub.json: Kopie sichern, bevor der nächste Speichervorgang sie durch Standardwerte ersetzt.
    try { copyFileSync(file(), join(dataDir(), `hub.corrupt-${Date.now()}.json`)); } catch { /* nichts zu sichern */ }
    return base;
  }
}

// Speichern läuft asynchron und fasst schnelle Folgeaufrufe zusammen – der Hauptprozess wird dadurch nicht blockiert.
let pending: Persisted | null = null;
let writing = false;
let lastSaveError: unknown;
const saveWaiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];

async function flushSave(): Promise<void> {
  writing = true;
  while (pending) {
    const d = pending;
    pending = null;
    try {
      const tmp = file() + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(d));
      await fsp.rename(tmp, file());
      lastSaveError = undefined;
      notifySaved(d);
    } catch (error) { lastSaveError = error; }
  }
  writing = false;
  for (const waiter of saveWaiters.splice(0)) {
    if (lastSaveError) { waiter.reject(lastSaveError); continue; }
    waiter.resolve();
  }
}

const savedListeners = new Set<(data: Persisted) => void>();
export function onSaved(listener: (data: Persisted) => void): () => void {
  savedListeners.add(listener);
  return () => savedListeners.delete(listener);
}
function notifySaved(data: Persisted): void {
  for (const listener of savedListeners) { listener(data); }
}

export function waitForSave(): Promise<void> {
  if (!writing && !pending) { return lastSaveError ? Promise.reject(lastSaveError) : Promise.resolve(); }
  return new Promise((resolve, reject) => saveWaiters.push({ resolve, reject }));
}

export function save(data: Persisted): void {
  pending = data;
  if (!writing) void flushSave();
}

/** Beim Beenden: den neuesten Stand synchron schreiben, damit nichts aus der Warteschlange verloren geht. */
export function flushSaveSync(latest?: Persisted): boolean {
  const d = latest ?? pending;
  pending = null;
  if (!d) return true;
  try {
    const tmp = file() + '.sync.tmp';
    writeFileSync(tmp, JSON.stringify(d));
    renameSync(tmp, file());
    notifySaved(d);
    return true;
  } catch { return false; }
}
