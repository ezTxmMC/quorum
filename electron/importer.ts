import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Block, ImportEntry, ImportedSession, Message, ProviderId } from '../shared/types';

const HEAD_BYTES = 256 * 1024;
/** Gibt dem Event-Loop des Hauptprozesses Luft zwischen zwei Dateien, damit Fenster und Streaming nicht ruckeln. */
const tick = () => new Promise<void>((r) => setImmediate(r));

function readHead(file: string): string[] {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, statSync(file).size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8').split('\n').slice(0, -1);
  } finally { closeSync(fd); }
}

const safe = (l: string): Record<string, any> | null => { try { return JSON.parse(l); } catch { return null; } };
/** Prompts, die der Multi-Agent-Orchestrator selbst an die CLIs schickt – keine echten Chats. */
const isHubPrompt = (t: string) => /^(Frage\/Aufgabe:|Du bist Schiedsrichter|Gesamtziel:|Ziel:\s|Aufgabe:\s|Frage:\s|Du arbeitest als)/.test(t.trim());
const clip = (s: string, n = 70) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

function walk(dir: string, match: (n: string) => boolean, out: string[] = [], depth = 0): string[] {
  if (!existsSync(dir) || depth > 5) return out;
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) walk(p, match, out, depth + 1);
    else if (match(n.name)) out.push(p);
  }
  return out;
}

// ---- Claude Code ---------------------------------------------------------------------------------

const claudeRoot = () => join(homedir(), '.claude', 'projects');

function claudeUserText(m: Record<string, any>): string | null {
  if (m.isMeta || m.isSidechain) return null;
  const c = m.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: any) => b.type === 'tool_result')) return null;
    text = c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  }
  text = text.trim();
  if (!text || /^<(command-|local-command|system-reminder|bash-)/.test(text) || text.startsWith('Caveat:')) return null;
  return text;
}

async function listClaude(): Promise<ImportEntry[]> {
  const out: ImportEntry[] = [];
  for (const file of walk(claudeRoot(), (n) => n.endsWith('.jsonl'), [], 3)) {
    await tick();
    if (file.includes('/subagents/')) continue;
    let title = ''; let cwd = ''; let custom = '';
    for (const l of readHead(file)) {
      const m = safe(l);
      if (!m) continue;
      if (!cwd && typeof m.cwd === 'string') cwd = m.cwd;
      if (m.type === 'custom-title' && typeof m.customTitle === 'string') custom = m.customTitle;
      if (!title && m.type === 'user') { const t = claudeUserText(m); if (t) title = clip(t); }
    }
    if ((!title && !custom) || isHubPrompt(title)) continue;
    const st = statSync(file);
    out.push({ provider: 'claude', sessionId: file.split('/').pop()!.replace('.jsonl', ''), cwd: cwd || homedir(), title: custom || title, updatedAt: st.mtimeMs, file });
  }
  return out;
}

function loadClaude(file: string): Message[] {
  const msgs: Message[] = [];
  let cur: Message | null = null;
  const toolIdx = new Map<string, Block & { kind: 'tool' }>();
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const m = safe(l);
    if (!m || m.isSidechain) continue;
    const ts = m.timestamp ? Date.parse(m.timestamp) : Date.now();
    if (m.type === 'user') {
      const c = m.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result' && toolIdx.has(b.tool_use_id)) {
            const t = toolIdx.get(b.tool_use_id)!;
            t.running = false; t.isError = !!b.is_error;
            t.output = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? '').join('\n') : '';
          }
        }
      }
      const text = claudeUserText(m);
      if (text) { cur = null; msgs.push({ id: randomUUID(), role: 'user', blocks: [{ kind: 'text', text }], createdAt: ts }); }
    } else if (m.type === 'assistant') {
      const c = m.message?.content;
      if (!Array.isArray(c)) continue;
      if (!cur) { cur = { id: randomUUID(), role: 'assistant', provider: 'claude', blocks: [], createdAt: ts }; msgs.push(cur); }
      for (const b of c) {
        if (b.type === 'text' && b.text?.trim()) cur.blocks.push({ kind: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking) cur.blocks.push({ kind: 'thinking', text: b.thinking });
        else if (b.type === 'tool_use') {
          const blk: Block & { kind: 'tool' } = { kind: 'tool', id: b.id, name: b.name, input: b.input, running: false };
          cur.blocks.push(blk); toolIdx.set(b.id, blk);
        }
      }
    }
  }
  return msgs.filter((x) => x.blocks.length);
}

// ---- Codex ---------------------------------------------------------------------------------------

const codexRoot = () => join(homedir(), '.codex', 'sessions');

function codexUserText(it: Record<string, any>): string {
  const t = (it.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  const req = /## My request:\s*([\s\S]*)$/.exec(t);
  return (req ? req[1] : t).trim();
}

async function listCodex(): Promise<ImportEntry[]> {
  const out: ImportEntry[] = [];
  for (const file of walk(codexRoot(), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
    await tick();
    let id = ''; let cwd = ''; let title = '';
    for (const l of readHead(file)) {
      const m = safe(l);
      if (!m) continue;
      if (m.type === 'session_meta') { id = m.payload?.id ?? ''; cwd = m.payload?.cwd ?? ''; }
      if (!title && m.type === 'event_msg' && m.payload?.type === 'item_completed' && m.payload.item?.type === 'UserMessage') title = clip(codexUserText(m.payload.item));
      if (id && title) break;
    }
    if (!id || !title || isHubPrompt(title)) continue; // Multi-Agent-Läufe des Hubs selbst überspringen
    out.push({ provider: 'codex', sessionId: id, cwd: cwd || homedir(), title, updatedAt: statSync(file).mtimeMs, file });
  }
  return out;
}

function loadCodex(file: string): Message[] {
  const msgs: Message[] = [];
  let cur: Message | null = null;
  const ensure = (ts: number) => cur ?? (cur = (msgs[msgs.push({ id: randomUUID(), role: 'assistant', provider: 'codex', blocks: [], createdAt: ts }) - 1]));
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    const m = safe(l);
    if (!m || m.type !== 'event_msg' || m.payload?.type !== 'item_completed') continue;
    const it = m.payload.item as Record<string, any>;
    const ts = m.timestamp ? Date.parse(m.timestamp) : Date.now();
    const id = String(it.id ?? randomUUID());
    switch (it.type) {
      case 'UserMessage': {
        const text = codexUserText(it);
        if (text) { cur = null; msgs.push({ id: randomUUID(), role: 'user', blocks: [{ kind: 'text', text }], createdAt: ts }); }
        break;
      }
      case 'AgentMessage': {
        const text = (it.content ?? []).map((b: any) => b.text ?? '').join('').trim();
        if (text) ensure(ts).blocks.push({ kind: 'text', text });
        break;
      }
      case 'Reasoning': {
        const text = (it.summary_text ?? []).map((x: any) => (typeof x === 'string' ? x : x.text ?? '')).join('\n').trim();
        if (text) ensure(ts).blocks.push({ kind: 'thinking', text });
        break;
      }
      case 'CommandExecution': {
        const cmd = Array.isArray(it.command) ? it.command[it.command.length - 1] : String(it.command ?? '');
        ensure(ts).blocks.push({ kind: 'tool', id, name: 'Shell', input: { command: cmd }, output: String(it.aggregated_output ?? ''), isError: it.exit_code != null && it.exit_code !== 0, running: false });
        break;
      }
      case 'FileChange': {
        const files = Object.entries((it.changes ?? {}) as Record<string, { type: string }>).map(([p, c]) => `${c.type} ${p}`);
        ensure(ts).blocks.push({ kind: 'tool', id, name: 'Dateiänderung', input: { files }, output: files.join('\n'), running: false });
        break;
      }
      case 'McpToolCall':
        ensure(ts).blocks.push({ kind: 'tool', id, name: `${it.server ?? 'mcp'}:${it.tool ?? ''}`, input: it.arguments, output: typeof it.result === 'string' ? it.result : JSON.stringify(it.result?.content?.[0]?.text ?? '').slice(0, 4000), isError: it.status === 'failed', running: false });
        break;
      case 'Extension':
        if (it.kind === 'web.search') ensure(ts).blocks.push({ kind: 'tool', id, name: 'Websuche', input: { query: it.query }, output: '', running: false });
        break;
    }
  }
  return msgs.filter((x) => x.blocks.length);
}

// ---- API -----------------------------------------------------------------------------------------

export async function listImportable(): Promise<ImportEntry[]> {
  let all: ImportEntry[] = [];
  try { all = all.concat(await listClaude()); } catch { /* ignorieren */ }
  try { all = all.concat(await listCodex()); } catch { /* ignorieren */ }
  return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 600);
}

export async function loadImportable(entries: ImportEntry[]): Promise<ImportedSession[]> {
  const out: ImportedSession[] = [];
  for (const e of entries) {
    await tick();
    try {
      const messages = (e.provider as ProviderId) === 'claude' ? loadClaude(e.file) : loadCodex(e.file);
      if (messages.length) out.push({ entry: e, messages });
    } catch { /* defekte Datei überspringen */ }
  }
  return out;
}
