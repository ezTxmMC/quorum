import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ACP_PRESETS, type AcpAgent } from '../../shared/acp';
import type { HubEvent, ModelInfo, RunRequest } from '../../shared/types';

// ACP-Client (Protokollversion 1): startet einen Agenten als Kindprozess und spricht JSON-RPC 2.0 zeilenweise über stdio.
// Ausgabe der Session-Updates wird auf HubEvents abgebildet. Dateisystem- und Terminal-Methoden des Clients werden nicht angeboten,
// der Agent arbeitet selbst im Projektordner. Rückfragen (session/request_permission) beantwortet der Berechtigungsmodus.

let custom: () => AcpAgent[] = () => [];
export const configureAcp = (fn: () => AcpAgent[]) => { custom = fn; };
export const acpAgents = (): AcpAgent[] => {
  const extra = custom().filter((a) => a?.id && a.command);
  return [...extra, ...ACP_PRESETS.filter((p) => !extra.some((e) => e.id === p.id))];
};

const EXTRA_DIRS = [join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'), join(homedir(), '.bun', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
export function findOnPath(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) return existsSync(command) ? command : undefined;
  const name = command + (process.platform === 'win32' ? '.cmd' : '');
  for (const d of [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_DIRS]) {
    if (d && existsSync(join(d, name))) return join(d, name);
  }
  return undefined;
}

/** Installierte Agenten als „Modelle“ des Anbieters (Modell-ID = Agent-ID). */
export function acpModels(): ModelInfo[] {
  return acpAgents().filter((a) => findOnPath(a.command)).map((a) => ({ id: a.id, label: a.name }));
}

interface Live { child: ChildProcess; cancel: () => void }
const live = new Map<string, Live>();

export function cancelAcp(runId: string): boolean {
  const l = live.get(runId);
  if (!l) return false;
  l.cancel();
  return true;
}
export function cancelAllAcp(): void { for (const id of [...live.keys()]) cancelAcp(id); }

const killTree = (c: ChildProcess, sig: NodeJS.Signals) => {
  try { if (process.platform !== 'win32' && c.pid) process.kill(-c.pid, sig); else c.kill(sig); } catch { try { c.kill(sig); } catch { /* beendet */ } }
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Wählt die Antwort auf eine Rückfrage des Agenten anhand des Berechtigungsmodus. */
export function permissionOutcome(options: { optionId: string; kind?: string }[], allow: boolean): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  const prefer = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const k of prefer) { const o = options.find((x) => x.kind === k); if (o) return { outcome: 'selected', optionId: o.optionId }; }
  return { outcome: 'cancelled' };
}

const textOfContent = (c: unknown): string => {
  const arr = Array.isArray(c) ? c : c ? [c] : [];
  return arr.map((x: Json) => (x?.type === 'content' ? x.content?.text : x?.type === 'text' ? x.text : x?.type === 'diff' ? `${x.path ?? ''}` : '') ?? '').filter(Boolean).join('\n');
};

export async function runAcp(req: RunRequest, emit: (e: HubEvent) => void): Promise<{ ok: boolean; sessionId?: string; text: string }> {
  const agent = acpAgents().find((a) => a.id === req.options.model);
  if (!agent) { emit({ type: 'done', ok: false, error: 'Kein ACP-Agent gewählt (Modell = Agent).' }); return { ok: false, text: '' }; }
  const bin = findOnPath(agent.command);
  if (!bin) { emit({ type: 'done', ok: false, error: `${agent.name}: Programm „${agent.command}“ nicht gefunden.` }); return { ok: false, text: '' }; }
  const allow = !!req.options.fullAccess || req.options.permission === 'allow';

  return new Promise((resolve) => {
    const child = spawn(bin, agent.args, { cwd: req.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' }, detached: process.platform !== 'win32' && process.env.QUORUM_CHAT_WORKER !== '1' });
    let nextId = 1;
    const pending = new Map<number, { res: (v: Json) => void; rej: (e: Error) => void }>();
    let sessionId: string | undefined;
    let text = '';
    let replaying = false;
    let finished = false;
    let stderr = '';
    const tools = new Map<string, boolean>();

    const send = (o: Json) => { if (child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n'); };
    const request = (method: string, params: Json) => new Promise<Json>((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); send({ id, method, params }); });
    const finish = (ok: boolean, error?: string) => {
      if (finished) return;
      finished = true;
      live.delete(req.runId);
      for (const p of pending.values()) p.rej(new Error('beendet'));
      pending.clear();
      emit({ type: 'done', ok, code: ok ? 0 : 1, error });
      resolve({ ok, sessionId, text });
      setTimeout(() => killTree(child, 'SIGTERM'), 300).unref();
      setTimeout(() => killTree(child, 'SIGKILL'), 4000).unref();
    };

    live.set(req.runId, {
      child,
      cancel: () => {
        if (sessionId) send({ method: 'session/cancel', params: { sessionId } });
        setTimeout(() => { if (!finished) finish(false, 'Abgebrochen'); }, 3000).unref();
      },
    });

    child.stdin.on('error', () => { /* Agent hat sich beendet */ });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { stderr = (stderr + c).slice(-4000); });
    child.on('error', (e) => finish(false, e.message));
    child.on('close', (code) => finish(false, `${agent.name} beendet (Code ${code})${stderr.trim() ? ': ' + stderr.trim().split('\n').slice(-3).join(' | ') : ''}`));

    const onUpdate = (u: Json) => {
      if (replaying) return;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': if (u.content?.type === 'text' && u.content.text) { text += u.content.text; emit({ type: 'text', delta: u.content.text }); } break;
        case 'agent_thought_chunk': if (u.content?.type === 'text' && u.content.text) emit({ type: 'thinking', delta: u.content.text }); break;
        case 'tool_call':
        case 'tool_call_update': {
          const id = String(u.toolCallId ?? '');
          if (!id) break;
          if (!tools.has(id)) { tools.set(id, false); emit({ type: 'tool_start', id, name: String(u.title ?? u.kind ?? 'Tool'), input: u.rawInput ?? { kind: u.kind } }); }
          if ((u.status === 'completed' || u.status === 'failed') && !tools.get(id)) {
            tools.set(id, true);
            emit({ type: 'tool_end', id, output: textOfContent(u.content) || (u.rawOutput ? JSON.stringify(u.rawOutput).slice(0, 4000) : ''), isError: u.status === 'failed' });
          }
          break;
        }
        default: break;
      }
    };

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let m: Json;
        try { m = JSON.parse(line) as Json; } catch { continue; }
        if (m.method && m.id !== undefined) { // Anfrage des Agenten
          if (m.method === 'session/request_permission') {
            const opts = (m.params?.options ?? []) as { optionId: string; kind?: string }[];
            const outcome = permissionOutcome(opts, allow);
            if (!allow) emit({ type: 'notice', level: 'info', text: `Aktion abgelehnt (Modus „Nur lesen“): ${m.params?.toolCall?.title ?? ''}`.trim() });
            send({ id: m.id, result: { outcome } });
          } else send({ id: m.id, error: { code: -32601, message: `Methode nicht unterstützt: ${m.method}` } });
        } else if (m.method) { // Benachrichtigung
          if (m.method === 'session/update' && m.params?.update) onUpdate(m.params.update as Json);
        } else if (m.id !== undefined && pending.has(m.id)) { // Antwort
          const p = pending.get(m.id)!;
          pending.delete(m.id);
          if (m.error) p.rej(new Error(`${m.error.message ?? 'Fehler'}${m.error.code === -32000 ? ` – bitte zuerst „${agent.command}“ im Terminal anmelden` : ''}`));
          else p.res((m.result ?? {}) as Json);
        }
      }
    });

    void (async () => {
      try {
        const init = await Promise.race([
          request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'quorum', title: 'Quorum', version: '1' } }),
          new Promise<Json>((_r, rej) => setTimeout(() => rej(new Error(`${agent.name} antwortet nicht (initialize)`)), 30_000).unref()),
        ]);
        const resume = req.resume?.sessionId;
        if (resume && init.agentCapabilities?.loadSession) {
          replaying = true; // der Agent spielt den bisherigen Verlauf als Updates ab – nicht erneut anzeigen
          try { await request('session/load', { sessionId: resume, cwd: req.cwd, mcpServers: [] }); sessionId = resume; } catch { sessionId = undefined; }
          replaying = false;
        }
        if (!sessionId) sessionId = String((await request('session/new', { cwd: req.cwd, mcpServers: [] })).sessionId);
        emit({ type: 'session', sessionId });
        const r = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: req.prompt }] });
        if (r.stopReason === 'cancelled') finish(false, 'Abgebrochen');
        else if (r.stopReason === 'refusal') finish(false, 'Der Agent hat die Anfrage abgelehnt.');
        else finish(true);
      } catch (e) {
        finish(false, (e as Error).message);
      }
    })();
  });
}
