// Persistenz für Workflows (mit Versionen) und Ausführungsprotokolle. Dateien im Datenordner, atomar geschrieben.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowDef, WorkflowNode } from '../../shared/workflow';
import { dataDir } from '../store';
import type { RunRecord } from './engine';

const HISTORY_LIMIT = 20;
const RUNS_LIMIT = 50;

const file = (name: string) => join(dataDir(), name);

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

const pendingWrites = new Map<string, unknown>();
const writingFiles = new Set<string>();

async function flushFile(path: string): Promise<void> {
  if (writingFiles.has(path)) return;
  writingFiles.add(path);
  try {
    while (pendingWrites.has(path)) {
      const val = pendingWrites.get(path);
      pendingWrites.delete(path);
      await fsp.mkdir(dataDir(), { recursive: true });
      const tmp = path + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(val, null, 2));
      await fsp.rename(tmp, path);
    }
  } catch {
    /* nächster Versuch beim nächsten Speichern */
  } finally {
    writingFiles.delete(path);
  }
}

function writeJson(path: string, value: unknown): void {
  pendingWrites.set(path, value);
  void flushFile(path);
}

let workflows: WorkflowDef[] | null = null;
const all = (): WorkflowDef[] => (workflows ??= readJson<WorkflowDef[]>(file('workflows.json'), []));
const persist = () => writeJson(file('workflows.json'), all());

export function listWorkflows(): WorkflowDef[] {
  return all();
}

export function getWorkflow(id: string): WorkflowDef | undefined {
  return all().find((w) => w.id === id);
}

/** Workflow anlegen oder ändern. Eine geänderte Knotenliste erzeugt eine neue Version (alte bleibt im Verlauf). */
export function saveWorkflow(input: { id?: string; name: string; nodes: WorkflowNode[] }): WorkflowDef {
  // Entwürfe dürfen unvollständig gespeichert werden; ausgeführt wird nur ein gültiger Stand (siehe Ausführung).
  const now = Date.now();
  const list = all();
  const existing = input.id ? list.find((w) => w.id === input.id) : undefined;
  if (!existing) {
    const created: WorkflowDef = { id: input.id ?? randomUUID(), name: input.name.trim() || 'Workflow', version: 1, nodes: input.nodes, history: [], createdAt: now, updatedAt: now };
    list.push(created);
    persist();
    return created;
  }
  const changed = JSON.stringify(existing.nodes) !== JSON.stringify(input.nodes);
  if (changed) {
    existing.history = [{ version: existing.version, at: existing.updatedAt, nodes: existing.nodes }, ...existing.history].slice(0, HISTORY_LIMIT);
    existing.version += 1;
    existing.nodes = input.nodes;
  }
  existing.name = input.name.trim() || existing.name;
  existing.updatedAt = now;
  persist();
  return existing;
}

/** Eine frühere Fassung als neue Version wiederherstellen. */
export function restoreVersion(id: string, version: number): WorkflowDef | undefined {
  const w = getWorkflow(id);
  const past = w?.history.find((h) => h.version === version);
  if (!w || !past) return undefined;
  return saveWorkflow({ id, name: w.name, nodes: past.nodes });
}

export function deleteWorkflow(id: string): boolean {
  const list = all();
  const i = list.findIndex((w) => w.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  persist();
  return true;
}

/** Export als JSON-Datei in den Datenordner; liefert den Pfad. */
export async function exportWorkflow(id: string): Promise<string | undefined> {
  const w = getWorkflow(id);
  if (!w) return undefined;
  const dir = join(dataDir(), 'exports');
  await fsp.mkdir(dir, { recursive: true });
  const safe = w.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'workflow';
  const path = join(dir, `${safe}-v${w.version}.json`);
  writeJson(path, { format: 'quorum-workflow', version: 1, workflow: { name: w.name, version: w.version, nodes: w.nodes } });
  return path;
}

/** Import einer exportierten Datei als neuer Workflow. */
export async function importWorkflow(path: string): Promise<WorkflowDef> {
  const text = await fsp.readFile(path, 'utf8');
  const data = JSON.parse(text) as { format?: string; workflow?: { name?: string; nodes?: WorkflowNode[] } };
  if (data.format !== 'quorum-workflow' || !Array.isArray(data.workflow?.nodes)) throw new Error('Keine gültige Workflow-Datei');
  return saveWorkflow({ name: data.workflow.name ?? 'Importiert', nodes: data.workflow.nodes });
}

// ---- Ausführungsprotokolle -------------------------------------------------------------------------------

let runs: RunRecord[] | null = null;
const allRuns = (): RunRecord[] => (runs ??= readJson<RunRecord[]>(file('workflow-runs.json'), []));

export function listRuns(workflowId?: string): RunRecord[] {
  return allRuns().filter((r) => !workflowId || r.workflowId === workflowId);
}

export function getRun(id: string): RunRecord | undefined {
  return allRuns().find((r) => r.id === id);
}

export function saveRun(record: RunRecord): void {
  const list = allRuns();
  const i = list.findIndex((r) => r.id === record.id);
  if (i >= 0) list[i] = record;
  else list.unshift(record);
  runs = list.slice(0, RUNS_LIMIT);
  writeJson(file('workflow-runs.json'), runs);
}
