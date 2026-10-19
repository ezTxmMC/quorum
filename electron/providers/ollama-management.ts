import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { OllamaManagement, OllamaPull } from '../../shared/connections';
import { apiBaseUrl } from '../../shared/connections.ts';
import { host, ollamaSettings } from './ollama.ts';
import { responseError, responseLines } from './http-stream.ts';

let server: ChildProcess | undefined;
let serverHost = '';
const pulls = new Map<string, { controller: AbortController; state: OllamaPull }>();
const json = async (url: string, method = 'GET', body?: unknown, signal = AbortSignal.timeout(15000)) => {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error' });
  if (!response.ok) throw await responseError(response);
  return response;
};
export async function ollamaManagement(): Promise<OllamaManagement> {
  const base = host();
  const [tags, ps] = await Promise.all([json(`${base}/api/tags`).then((r) => r.json()), json(`${base}/api/ps`).then((r) => r.json())]) as [{ models?: { name: string; size: number }[] }, { models?: { name: string; size_vram?: number }[] }];
  return { host: base, owned: !!server && serverHost === base, models: (tags.models ?? []).map((m) => { const loaded = ps.models?.find((p) => p.name === m.name); return { name: m.name, size: m.size, loaded: !!loaded, vram: loaded?.size_vram }; }) };
}
export async function ollamaModelAction(action: 'load' | 'unload' | 'delete', model: string): Promise<void> {
  if (!model.trim()) throw new Error('Kein Modell angegeben.');
  if (action === 'delete') { await json(`${host()}/api/delete`, 'DELETE', { model }); return; }
  const response = await json(`${host()}/api/generate`, 'POST', { model, prompt: '', stream: false, keep_alive: action === 'unload' ? 0 : '10m' }, AbortSignal.timeout(120000));
  const body = await response.json() as { error?: string };
  if (body.error) throw new Error(body.error);
}
export function ollamaPullList() { return [...pulls.values()].map((v) => v.state); }
export function cancelOllamaPull(id: string) { const entry = pulls.get(id); if (entry?.state.status === 'running') entry.controller.abort(); }
export function pullOllama(model: string, emit: (state: OllamaPull) => void): string {
  if (!model.trim()) throw new Error('Kein Modell angegeben.');
  const id = randomUUID();
  const controller = new AbortController();
  const entry = { controller, state: { id, model, status: 'running', detail: 'Starte Download …' } as OllamaPull };
  if ([...pulls.values()].some((v) => v.state.model === model && v.state.status === 'running')) throw new Error('Download läuft bereits.');
  for (const [key, value] of pulls) if (value.state.status !== 'running') pulls.delete(key);
  pulls.set(id, entry);
  const base = host();
  const update = (patch: Partial<OllamaPull>) => { entry.state = { ...entry.state, ...patch }; emit(entry.state); };
  update({});
  void (async () => {
    try {
      const response = await json(`${base}/api/pull`, 'POST', { model, stream: true }, controller.signal);
      for await (const line of responseLines(response)) {
        if (!line.trim()) continue;
        const progress = JSON.parse(line) as { error?: string; status?: string; completed?: number; total?: number };
        if (progress.error) throw new Error(progress.error);
        update({ detail: progress.status ?? entry.state.detail, completed: progress.completed, total: progress.total });
      }
      if (controller.signal.aborted) throw new Error('Abgebrochen');
      update({ status: 'done', detail: 'Download abgeschlossen' });
    } catch (e) { update({ status: controller.signal.aborted ? 'cancelled' : 'error', detail: controller.signal.aborted ? 'Abgebrochen' : (e as Error).message }); }
  })();
  return id;
}
export async function startOllama(): Promise<void> {
  if (ollamaSettings().mode === 'api') throw new Error('Im API-Modus wird kein lokaler Prozess gestartet.');
  const base = apiBaseUrl(host());
  const url = new URL(base);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.pathname !== '/') throw new Error('Lokales Ollama nur über eine lokale HTTP-Adresse starten.');
  if (server) { if (serverHost !== base) throw new Error('Zuerst den bisherigen Quorum-Server stoppen.'); return; }
  try { if ((await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(800) })).ok) return; } catch { /* launch below */ }
  const child = spawn(ollamaSettings().binary || 'ollama', ['serve'], { env: { ...process.env, OLLAMA_HOST: url.host }, stdio: ['ignore', 'ignore', 'pipe'] });
  server = child;
  serverHost = base;
  let failure = '';
  child.stderr?.on('data', (value: Buffer) => { failure = (failure + String(value)).slice(-2000); });
  child.on('error', (error) => { failure = error.message; if (server === child) server = undefined; });
  child.on('close', () => { if (server === child) server = undefined; });
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (server !== child) throw new Error(failure || 'Ollama konnte nicht gestartet werden.');
    try { if ((await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(300) })).ok) return; } catch { /* retry readiness */ }
  }
  child.kill();
  throw new Error(failure || 'Ollama wurde nicht rechtzeitig bereit.');
}
export async function stopOllama(): Promise<void> {
  const child = server;
  if (!child) throw new Error('Dieser Server wurde nicht von Quorum gestartet.');
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => { clearTimeout(timer); if (server === child) server = undefined; resolve(); };
    child.once('close', finish);
    timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
    child.kill('SIGTERM');
  });
}
export async function shutdownOllama(): Promise<void> { for (const entry of pulls.values()) entry.controller.abort(); if (server) await stopOllama().catch(() => {}); }
