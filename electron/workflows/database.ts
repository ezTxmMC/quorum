import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../store.ts';

let current: { path: string; database: DatabaseSync } | undefined;

/** The marker and both imports commit together, even if two desktops start at once. */
export function workflowDatabase(): DatabaseSync {
  const directory = dataDir();
  const path = join(directory, 'quorum.sqlite');
  if (current?.path === path) return current.database;
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS workflow_import (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, started INTEGER NOT NULL, document TEXT NOT NULL);`);
    if (!db.prepare('SELECT 1 FROM workflow_import WHERE version=1').get()) {
      for (const [file, runs] of [['workflows.json', false], ['workflow-runs.json', true]] as const) {
        if (!existsSync(join(directory, file))) continue;
        const rows: unknown = JSON.parse(readFileSync(join(directory, file), 'utf8'));
        if (!Array.isArray(rows)) throw new Error('Ungültige Workflow-Datei: ' + file);
        for (const item of rows) {
          if (!item || typeof item.id !== 'string') throw new Error('Workflow-ID fehlt: ' + file);
          if (runs) db.prepare('INSERT INTO workflow_runs VALUES (?, ?, ?, ?)').run(item.id, item.workflowId, item.startedAt, JSON.stringify(item));
          else db.prepare('INSERT INTO workflows VALUES (?, ?)').run(item.id, JSON.stringify(item));
        }
      }
      db.exec('INSERT INTO workflow_import VALUES (1)');
    }
    db.exec('COMMIT');
    current?.database.close();
    current = { path, database: db };
    return db;
  } catch (error) { db.close(); throw error; }
}
