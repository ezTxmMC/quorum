import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxEntry } from '../shared/inbox';
import { dataDir } from './store';

// Posteingang für Turns aus der Kommandozeile (ohne Electron nutzbar).
export const inboxDir = () => join(dataDir(), 'inbox');

export function writeInbox(e: InboxEntry): void {
  const dir = inboxDir();
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${e.chat.id}.json`;
  const tmp = join(dir, '.' + name);
  writeFileSync(tmp, JSON.stringify(e));
  renameSync(tmp, join(dir, name));
}

/** Liest und entfernt alle Einträge (älteste zuerst). Unlesbare Dateien werden zur Seite gelegt. */
export function drainInbox(): InboxEntry[] {
  const dir = inboxDir();
  if (!existsSync(dir)) return [];
  const out: InboxEntry[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    const p = join(dir, f);
    try {
      const e = JSON.parse(readFileSync(p, 'utf8')) as InboxEntry;
      if (e?.v === 1 && e.chat?.id && Array.isArray(e.messages)) out.push(e);
      unlinkSync(p);
    } catch { try { renameSync(p, p + '.bad'); } catch { /* weg */ } }
  }
  return out;
}

/** Meldet neue Einträge (Dateiereignis plus Sicherheits-Abfrage alle 10 s). */
export function watchInbox(cb: () => void): () => void {
  mkdirSync(inboxDir(), { recursive: true });
  let t: ReturnType<typeof setTimeout> | undefined;
  const kick = () => { clearTimeout(t); t = setTimeout(cb, 250); };
  let w: ReturnType<typeof watch> | undefined;
  try { w = watch(inboxDir(), { persistent: false }, kick); } catch { /* Abfrage genügt */ }
  const poll = setInterval(cb, 10_000);
  poll.unref();
  return () => { clearTimeout(t); clearInterval(poll); w?.close(); };
}
