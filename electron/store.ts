import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_OPTIONS, defaultDock, defaultTerminal } from '../shared/catalog';
import type { Persisted } from '../shared/types';

export const dataDir = () => {
  const d = app.getPath('userData');
  mkdirSync(d, { recursive: true });
  return d;
};
const file = () => join(dataDir(), 'hub.json');

export function defaults(): Persisted {
  return {
    version: 1,
    settings: {
      theme: 'dark',
      language: 'de',
      sidebarPinned: true,
      quickHotkey: 'CommandOrControl+Shift+Space',
      dock: defaultDock(),
      terminal: defaultTerminal(),
      autoImport: true,
      accent: '#7c8cff',
      defaultProvider: 'claude',
      defaultCwd: homedir(),
      binaries: {},
      providerDefaults: { claude: { ...DEFAULT_OPTIONS.claude }, codex: { ...DEFAULT_OPTIONS.codex }, antigravity: { ...DEFAULT_OPTIONS.antigravity }, opencode: {}, ollama: {}, local: {}, api: {} },
      updateChannel: 'release',
      autoCheckUpdate: true,
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
    return base;
  }
}

// Speichern läuft asynchron und fasst schnelle Folgeaufrufe zusammen – der Hauptprozess wird dadurch nicht blockiert.
let pending: Persisted | null = null;
let writing = false;

async function flushSave(): Promise<void> {
  writing = true;
  while (pending) {
    const d = pending;
    pending = null;
    try {
      const tmp = file() + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(d));
      await fsp.rename(tmp, file());
    } catch { /* nächster Versuch beim nächsten Speichern */ }
  }
  writing = false;
}

export function save(data: Persisted): void {
  pending = data;
  if (!writing) void flushSave();
}
