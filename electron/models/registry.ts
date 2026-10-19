// Persistente Modell-Registry (`models.json` im Datenordner). Gehört nur dem Main-Prozess, damit der Renderer
// beim Speichern von hub.json keine veralteten Modelleinträge zurückschreibt.
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { ModelRecord } from '../../shared/models';
import { dataDir } from '../store';
import { defaultTextCapabilities } from './inspect';

const file = () => join(dataDir(), 'models.json');

let records: ModelRecord[] | null = null;

function all(): ModelRecord[] {
  if (records) return records;
  try {
    records = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as ModelRecord[]) : [];
    // Ältere Einträge ohne Fähigkeiten (GGUF ohne Pipeline-Tag) bekommen Text-Fähigkeiten nachgetragen.
    for (const m of records) if (!m.capabilities?.length && m.format === 'gguf' && m.architecture === 'transformer-lm') m.capabilities = defaultTextCapabilities(m.name, m.files);
  } catch {
    records = [];
  }
  return records;
}

let writing = false;
let pendingData: string | null = null;

async function flushPersist(): Promise<void> {
  writing = true;
  while (pendingData) {
    const content = pendingData;
    pendingData = null;
    const target = file();
    const tmp = `${target}.${Date.now()}.tmp`;
    try {
      await fsp.writeFile(tmp, content, 'utf8');
      await fsp.rename(tmp, target);
    } catch {
      try { await fsp.unlink(tmp); } catch { /* ignore */ }
    }
  }
  writing = false;
}

function persist(): void {
  pendingData = JSON.stringify(all(), null, 2);
  if (!writing) void flushPersist();
}

export function listModels(): ModelRecord[] {
  return all();
}

export function getModel(id: string): ModelRecord | undefined {
  return all().find((m) => m.id === id);
}

/** Legt einen Eintrag an oder ersetzt ihn (gleiche ID). */
export function putModel(record: ModelRecord): void {
  const list = all();
  const i = list.findIndex((m) => m.id === record.id);
  if (i >= 0) list[i] = record;
  else list.push(record);
  persist();
}

export function patchModel(id: string, patch: Partial<ModelRecord>): ModelRecord | undefined {
  const m = getModel(id);
  if (!m) return undefined;
  Object.assign(m, patch);
  persist();
  return m;
}

export function removeModel(id: string): ModelRecord | undefined {
  const list = all();
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) return undefined;
  const [gone] = list.splice(i, 1);
  persist();
  return gone;
}
