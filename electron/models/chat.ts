// Chat mit einem lokalen Modell über den Scheduler. Wird vom Modell-Testchat und von Multi-Agent-Läufen genutzt.
// Lokale Modelle haben keine Tools – sie erzeugen nur Text (Planung, Review, Analyse).
import type { ChatMessage, ModelRecord } from '../../shared/models';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { imagesDir } from '../images';
import { isChat, isImage, type ImageParams } from '../runtimes/adapter';
import { scheduler } from '../runtimes/scheduler';
import { getModel } from './registry';

const running = new Map<string, AbortController>();

/** Bricht einen laufenden lokalen Lauf ab. false, wenn die Kennung unbekannt ist. */
export function cancelLocalChat(runId: string): boolean {
  const c = running.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

export interface LocalChatResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Lädt das Modell bei Bedarf (über den Scheduler) und streamt die Antwort.
 * `onDelta` erhält jeden Textblock. Fehler werden zurückgegeben, nicht geworfen.
 */
export async function runLocalChat(opts: {
  runId: string;
  modelId: string;
  messages: ChatMessage[];
  priority?: number;
  onDelta: (delta: string) => void;
}): Promise<LocalChatResult> {
  const ctl = new AbortController();
  running.set(opts.runId, ctl);
  let text = '';
  try {
    const record: ModelRecord | undefined = getModel(opts.modelId);
    if (!record) throw new Error(`Modell nicht gefunden: ${opts.modelId}`);
    const lease = await scheduler.acquire(record, opts.priority ?? 1, ctl.signal);
    try {
      if (!isChat(lease.model)) throw new Error('Dieses Modell kann keinen Text erzeugen');
      await lease.model.chat(opts.messages, (d) => {
        text += d;
        scheduler.countDelta(opts.modelId);
        opts.onDelta(d);
      }, ctl.signal);
      return { ok: true, text };
    } finally {
      lease.release();
    }
  } catch (err) {
    const error = ctl.signal.aborted ? 'Abgebrochen' : (err as Error).message;
    return { ok: false, text, error };
  } finally {
    running.delete(opts.runId);
  }
}

export interface LocalImageResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Bild mit einem lokalen Diffusers-Modell erzeugen. Die PNG landet im Bilderordner der App (wird dort angezeigt). */
export async function runLocalImage(opts: {
  runId: string;
  modelId: string;
  params: ImageParams;
  priority?: number;
}): Promise<LocalImageResult> {
  const ctl = new AbortController();
  running.set(opts.runId, ctl);
  try {
    const record = getModel(opts.modelId);
    if (!record) throw new Error(`Modell nicht gefunden: ${opts.modelId}`);
    const lease = await scheduler.acquire(record, opts.priority ?? 1, ctl.signal);
    try {
      if (!isImage(lease.model)) throw new Error('Dieses Modell kann keine Bilder erzeugen');
      const out = join(imagesDir(), `${randomUUID()}.png`);
      const path = await lease.model.image(opts.params, out, ctl.signal);
      return { ok: true, path };
    } finally {
      lease.release();
    }
  } catch (err) {
    return { ok: false, error: ctl.signal.aborted ? 'Abgebrochen' : (err as Error).message };
  } finally {
    running.delete(opts.runId);
  }
}
