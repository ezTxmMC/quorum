// Persistente Modell-Registry (`models.json` im Datenordner). Gehört nur dem Main-Prozess, damit der Renderer
// beim Speichern von hub.json keine veralteten Modelleinträge zurückschreibt.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRecord } from '../../shared/models';
import { dataDir } from '../store';

const file = () => join(dataDir(), 'models.json');

let records: ModelRecord[] | null = null;

function all(): ModelRecord[] {
  if (records) return records;
  try {
    records = existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as ModelRecord[]) : [];
  } catch {
    records = [];
  }
  return records;
}

function persist(): void {
  // Atomar schreiben: erst Temp-Datei, dann umbenennen – ein Absturz hinterlässt keine halbe Datei.
  const tmp = file() + '.tmp';
  writeFileSync(tmp, JSON.stringify(all(), null, 2));
  renameSync(tmp, file());
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
