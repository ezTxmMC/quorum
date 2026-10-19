import { chatMode, textOptions } from '../../shared/chat-modes';
import { cancelAllApi, cancelApi, runApi } from './api';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment, HubEvent, ProviderId, RunRequest } from '../../shared/types';
import { buildClaude, ClaudeParser } from './claude';
import { buildCodex, CodexParser } from './codex';
import { buildAntigravity, AntigravityParser } from './antigravity';
import { detectedModel, resolveBinary } from './detect';
import { cancelAllOllama, cancelOllama, runOllama } from './ollama';
import { buildOpenCode, OpenCodeParser } from './opencode';
import { IMAGE_ENGINES } from '../../shared/catalog';
import { ImageCollector, collectsImages, imagePrompt } from '../images';
import { cancelLocalChat, runLocalChat } from '../models/chat';
import { runOllamaImage } from './ollama';

export interface LineParser {
  push(line: string): HubEvent[];
  end(): HubEvent[];
  /** Anzahl abgeschlossener Turns (nur Claude im Live-Modus). */
  results?: number;
}

export interface Built {
  args: string[];
  stdin?: string;
  parser: LineParser;
  /** stdin bleibt offen, damit weitere Nachrichten zugestellt werden können. */
  live?: boolean;
}

/** Laufende Live-Prozesse: erlauben das Zustellen weiterer Nachrichten mitten im Lauf. */
const lives = new Map<string, ChildProcess>();

/** Stellt eine weitere Nachricht in einen laufenden Live-Lauf zu (Claude). false = nicht möglich. */
export function injectMessage(runId: string, text: string, attachments: Attachment[] = []): boolean {
  const c = lives.get(runId);
  if (!c || !c.stdin || c.stdin.destroyed || !c.stdin.writable) return false;
  const content = attachments.length
    ? [...attachments.map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } })), { type: 'text', text }]
    : text;
  c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  return true;
}

function build(req: RunRequest): Built {
  switch (req.provider) {
    case 'api':
    case 'ollama': throw new Error(`${req.provider} läuft ohne CLI`);
    case 'local': throw new Error('Lokale Modelle laufen ohne CLI');
    case 'opencode': return { ...buildOpenCode(req), parser: new OpenCodeParser() };
    case 'claude': return { ...buildClaude(req), parser: new ClaudeParser() };
    case 'codex': return { ...buildCodex(req), parser: new CodexParser() };
    case 'antigravity': return { ...buildAntigravity(req), parser: new AntigravityParser() };
  }
}

const procs = new Map<string, ChildProcess>();

/** Startet eine CLI und streamt normalisierte Events. Resolved, wenn der Prozess endet. */
export function runCli(
  req: RunRequest,
  emit: (e: HubEvent) => void,
  binaries: Partial<Record<ProviderId, string>>,
): Promise<{ ok: boolean; sessionId?: string; text: string }> {
  if (chatMode(req.options) === 'text') req = { ...req, options: textOptions(req.provider, req.options), review: undefined };
  if (req.imageGen) return runImage(req, emit, binaries);
  if (req.provider === 'api') return runApi(req, emit);
  if (req.provider === 'ollama') return runOllama(req, emit);
  if (req.provider === 'local') return runLocalText(req, emit);
  if (req.provider === 'antigravity' && req.options.model) {
    const model = detectedModel('antigravity', req.options.model);
    const variants = model?.effortModels;
    if (variants) {
      const effort = req.options.effort ?? (variants.medium ? 'medium' : model?.efforts?.[0]);
      const variant = effort ? variants[effort] : undefined;
      if (variant) req = { ...req, options: { ...req.options, model: variant, effort: undefined } };
    }
  }
  return new Promise((resolve) => {
    const bin = resolveBinary(req.provider, binaries);
    if (!bin) {
      emit({ type: 'done', ok: false, error: `CLI für ${req.provider} nicht gefunden.` });
      resolve({ ok: false, text: '' });
      return;
    }
    // Anhänge aus dem Speicher: Claude (Live-Modus) bekommt Bilder direkt als Base64 im Nachrichtenstrom – ohne Datei.
    // Alle anderen CLIs können nur Dateien lesen: dafür kurzlebige Temp-Dateien, die nach dem Lauf sofort wieder gelöscht werden.
    let tmpDir: string | undefined;
    const atts = req.attachments ?? [];
    const inline = req.provider === 'claude' && !!req.live && req.options.liveInput !== false;
    if (atts.length && !inline) {
      tmpDir = mkdtempSync(join(tmpdir(), 'quorum-att-'));
      const paths = atts.map((a, i) => {
        const p = join(tmpDir!, `${i + 1}-${a.name.replace(/[^\w.\- ]/g, '_')}`);
        writeFileSync(p, Buffer.from(a.data, 'base64'));
        return p;
      });
      req = { ...req, images: [...(req.images ?? []), ...paths] };
    }
    const cleanup = () => { if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* egal */ } tmpDir = undefined; } };
    const built = build(req);
    let sessionId: string | undefined;
    let text = '';
    let finished = false;
    // Codex/Antigravity: erzeugte Bilder aus ihren Ordnern einsammeln (auch in normalen Chats).
    const images = collectsImages(req.provider) ? new ImageCollector(req.provider, emit) : null;
    const wrapped = (e: HubEvent) => {
      if (e.type === 'session') { sessionId = e.sessionId; images?.setSession(e.sessionId); }
      if (e.type === 'text') text += e.delta;
      if (e.type === 'text_full') text = e.text;
      if (e.type === 'done') {
        if (finished) return;
        finished = true;
        cleanup();
        // Erst die letzten Bilder melden, dann „fertig“.
        if (images) { void images.finish().then(() => emit(e)); return; }
      }
      emit(e);
    };

    const child = spawn(bin, built.args, {
      cwd: req.cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    procs.set(req.runId, child);
    if (built.live) lives.set(req.runId, child);

    let buf = '';
    let stderr = '';
    let lastEventAt = 0;
    let seenResults = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) { lastEventAt = Date.now(); for (const e of built.parser.push(line)) wrapped(e); }
      }
      // Live-Modus: Nach einem abgeschlossenen Turn kurz warten; kommt nichts Neues (z. B. eine zugestellte Nachricht), stdin schließen -> Prozess endet.
      if (built.live && (built.parser.results ?? 0) > seenResults) {
        seenResults = built.parser.results ?? 0;
        const at = Date.now();
        setTimeout(() => { if (lastEventAt <= at && child.stdin && !child.stdin.destroyed) { lives.delete(req.runId); child.stdin.end(); } }, 2500);
      }
    });
    child.stderr.on('data', (c: string) => { stderr += c; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (err) => {
      procs.delete(req.runId);
      wrapped({ type: 'done', ok: false, error: err.message });
      resolve({ ok: false, sessionId, text });
    });
    child.on('close', (code, signal) => {
      procs.delete(req.runId);
      lives.delete(req.runId);
      if (buf.trim()) for (const e of built.parser.push(buf.trim())) wrapped(e);
      for (const e of built.parser.end()) wrapped(e);
      const ok = code === 0;
      if (!ok && stderr.trim() && !signal) wrapped({ type: 'notice', level: 'error', text: tail(stderr) });
      wrapped({ type: 'done', ok, code, error: ok ? undefined : signal ? `Abgebrochen (${signal})` : `Beendet mit Code ${code}` });
      resolve({ ok, sessionId, text });
    });

    if (built.stdin !== undefined) child.stdin.write(built.live ? built.stdin + '\n' : built.stdin);
    if (!built.live) child.stdin.end();
  });
}

/** Bildmodus: Anfrage an die gewählte Bild-Engine – unabhängig vom Anbieter des Chats. */
async function runImage(req: RunRequest, emit: (e: HubEvent) => void, binaries: Partial<Record<ProviderId, string>>): Promise<{ ok: boolean; sessionId?: string; text: string }> {
  const engine = req.imageGen!;
  if (engine.startsWith('ollama:')) return runOllamaImage({ ...req, options: { ...req.options, model: engine.slice('ollama:'.length) } }, emit);
  const eng = IMAGE_ENGINES.find((x) => x.id === engine);
  if (!eng) { emit({ type: 'done', ok: false, error: `Unbekannte Bild-Engine: ${engine}` }); return { ok: false, text: '' }; }
  // Eigener leerer Arbeitsordner: die Engine soll nur ein Bild erzeugen und keine Projektdateien anfassen.
  const cwd = mkdtempSync(join(tmpdir(), 'quorum-img-'));
  const refs = (req.images ?? []).length + (req.attachments ?? []).length;
  // Die Session der Engine gehört nicht zum Chat (sonst würde z. B. ein Claude-Chat mit einer Codex-ID fortgesetzt).
  const filtered = (e: HubEvent) => { if (e.type !== 'session') emit(e.type === 'image' ? { ...e, engine } : e); };
  try {
    return await runCli({
      runId: req.runId, provider: eng.provider, cwd, prompt: imagePrompt(engine, req.prompt, refs),
      options: eng.provider === 'codex' ? { ephemeral: true, sandbox: 'read-only' } : {},
      images: req.images, attachments: req.attachments,
    }, filtered, binaries);
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* egal */ }
  }
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > 2000 ? '…' + t.slice(-2000) : t;
}

export function cancelRun(runId: string): void {
  if (cancelApi(runId) || cancelOllama(runId) || cancelLocalChat(runId)) return;
  const p = procs.get(runId);
  if (!p || p.pid === undefined) return;
  try {
    if (process.platform === 'win32') p.kill();
    else process.kill(-p.pid, 'SIGTERM');
  } catch { p.kill('SIGTERM'); }
  const pid = p.pid;
  const timer = setTimeout(() => {
    try {
      if (process.platform === 'win32') { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); }
      else process.kill(-pid, 'SIGKILL');
    } catch {
      if (p.exitCode === null && p.signalCode === null) { try { p.kill('SIGKILL'); } catch { /* already exited */ } }
    }
  }, 4000);
  timer.unref();
}

export function cancelAll(): void {
  cancelAllApi();
  cancelAllOllama();
  for (const id of [...procs.keys()]) cancelRun(id);
}

/** Chat mit einem lokalen Modell aus der Registry: nur Text, Verlauf kommt aus dem Hub. */
async function runLocalText(req: RunRequest, emit: (e: HubEvent) => void): Promise<{ ok: boolean; text: string }> {
  const modelId = req.options.model;
  if (!modelId) {
    emit({ type: 'done', ok: false, error: 'Kein lokales Modell gewählt' });
    return { ok: false, text: '' };
  }
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  if (req.options.systemPrompt) messages.push({ role: 'system', content: req.options.systemPrompt });
  for (const m of req.history ?? []) messages.push(m);
  messages.push({ role: 'user', content: req.prompt });
  const r = await runLocalChat({ runId: req.runId, modelId, messages, priority: 1, onDelta: (delta) => emit({ type: 'text', delta }) });
  if (!r.ok) {
    emit({ type: 'done', ok: false, error: r.error });
    return { ok: false, text: r.text };
  }
  emit({ type: 'done', ok: true, code: 0 });
  return { ok: true, text: r.text };
}
