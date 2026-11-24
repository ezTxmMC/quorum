import { workflowDatabase } from './database';
// Persistenz für Workflows (mit Versionen) und Ausführungsprotokolle. Dateien im Datenordner, atomar geschrieben.
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowDef, WorkflowNode } from '../../shared/workflow';
import { dataDir } from '../store';
import type { RunRecord } from './engine';

const HISTORY_LIMIT = 20;
const RUNS_LIMIT = 50;

export function listWorkflows(): WorkflowDef[] {
  return workflowDatabase().prepare('SELECT document FROM workflows ORDER BY rowid').all().map((row) => JSON.parse(String(row.document)));
}

export function getWorkflow(id: string): WorkflowDef | undefined {
  const row = workflowDatabase().prepare('SELECT document FROM workflows WHERE id=?').get(id);
  return row ? JSON.parse(String(row.document)) : undefined;
}

/** Workflow anlegen oder ändern. Eine geänderte Knotenliste erzeugt eine neue Version (alte bleibt im Verlauf). */
export function saveWorkflow(input: { id?: string; name: string; nodes: WorkflowNode[] }): WorkflowDef {
  const db = workflowDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = Date.now();
    const existing = input.id ? getWorkflow(input.id) : undefined;
    const workflow = existing ?? { id: input.id ?? randomUUID(), version: 1, createdAt: now, nodes: input.nodes, history: [], name: 'Workflow', updatedAt: now };
    if (existing && JSON.stringify(existing.nodes) !== JSON.stringify(input.nodes)) {
      workflow.history = [{ version: existing.version, at: existing.updatedAt, nodes: existing.nodes }, ...existing.history].slice(0, HISTORY_LIMIT);
      workflow.version++;
    }
    workflow.name = input.name.trim() || workflow.name;
    workflow.nodes = input.nodes;
    workflow.updatedAt = now;
    db.prepare('INSERT INTO workflows VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(workflow.id, JSON.stringify(workflow));
    db.exec('COMMIT');
    return workflow;
  } catch (error) { db.exec('ROLLBACK'); throw error; }

}

/** Eine frühere Fassung als neue Version wiederherstellen. */
export function restoreVersion(id: string, version: number): WorkflowDef | undefined {
  const w = getWorkflow(id);
  const past = w?.history.find((h) => h.version === version);
  if (!w || !past) return undefined;
  return saveWorkflow({ id, name: w.name, nodes: past.nodes });
}

export function deleteWorkflow(id: string): boolean {
  return workflowDatabase().prepare('DELETE FROM workflows WHERE id=?').run(id).changes !== 0;
}

/** Export als JSON-Datei in den Datenordner; liefert den Pfad. */
export async function exportWorkflow(id: string): Promise<string | undefined> {
  const w = getWorkflow(id);
  if (!w) return undefined;
  const dir = join(dataDir(), 'exports');
  await fsp.mkdir(dir, { recursive: true });
  const safe = w.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'workflow';
  const path = join(dir, `${safe}-v${w.version}.json`);
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await fsp.writeFile(temp, JSON.stringify({ format: 'quorum-workflow', version: 1, workflow: { name: w.name, version: w.version, nodes: w.nodes } }), { flag: 'wx' });
    await fsp.rename(temp, path);
  } finally { await fsp.rm(temp, { force: true }); }
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

export function listRuns(workflowId?: string): RunRecord[] {
  const db = workflowDatabase();
  const rows = workflowId ? db.prepare('SELECT document FROM workflow_runs WHERE workflow_id=? ORDER BY started DESC').all(workflowId)
    : db.prepare('SELECT document FROM workflow_runs ORDER BY started DESC').all();
  return rows.map((row) => JSON.parse(String(row.document)));
}

export function getRun(id: string): RunRecord | undefined {
  const row = workflowDatabase().prepare('SELECT document FROM workflow_runs WHERE id=?').get(id);
  return row ? JSON.parse(String(row.document)) : undefined;
}

export function saveRun(record: RunRecord): void {
  const db = workflowDatabase();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO workflow_runs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document')
      .run(record.id, record.workflowId, record.startedAt, JSON.stringify(record));
    db.prepare("DELETE FROM workflow_runs WHERE id IN (SELECT id FROM workflow_runs WHERE json_extract(document,'$.status') <> 'running' ORDER BY started DESC LIMIT -1 OFFSET ?)").run(RUNS_LIMIT);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
