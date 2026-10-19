import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ApiConnection } from '../../shared/connections';
import { apiBaseUrl, apiModelId, resolveApiModel } from '../../shared/connections.ts';
import type { HubEvent, ProviderStatus, RunRequest } from '../../shared/types';
import { responseError, responseLines } from './http-stream.ts';

let connections = (): ApiConnection[] => [];
let keyFor = (_id: string): Promise<string | undefined> => Promise.resolve(undefined);
export function configureApi(getConnections: () => ApiConnection[], getKey: typeof keyFor) { connections = getConnections; keyFor = getKey; }
const aborts = new Map<string, AbortController>();
const headers = async (id: string) => { const key = await keyFor(id); return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }; };

export async function inspectApi(connection: ApiConnection): Promise<string[]> {
  const response = await fetch(`${apiBaseUrl(connection.baseUrl)}/models`, { headers: await headers(connection.id), signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string' && !!id);
}
export async function apiStatus(): Promise<ProviderStatus> {
  const enabled = connections().filter((c) => c.enabled);
  const results = await Promise.all(enabled.map(async (connection) => {
    let ids = connection.models;
    let error: string | undefined;
    try { ids = [...ids, ...await inspectApi(connection)]; } catch (e) { error = `${connection.name}: ${(e as Error).message}`; }
    return { error, models: [...new Set(ids)].map((id) => ({ id: apiModelId(connection.id, id), label: id, group: connection.name })) };
  }));
  const models = results.flatMap((r) => r.models);
  return { id: 'api', installed: models.length > 0, models, error: results.map((r) => r.error).filter(Boolean).join('\n') || undefined };
}
export function cancelAllApi(): void { for (const controller of aborts.values()) controller.abort(); }
export function cancelApi(id: string): boolean { const controller = aborts.get(id); if (!controller) return false; controller.abort(); return true; }
export async function runApi(req: RunRequest, emit: (event: HubEvent) => void): Promise<{ ok: boolean; text: string }> {
  const controller = new AbortController();
  aborts.set(req.runId, controller);
  let text = '';
  try {
    if (!req.options.model) throw new Error('Bitte ein API-Modell auswählen.');
    const { connection, model } = resolveApiModel(req.options.model, connections());
    const messages: { role: string; content: unknown }[] = [];
    if (req.options.systemPrompt) messages.push({ role: 'system', content: req.options.systemPrompt });
    messages.push(...req.history ?? []);
    const images = (req.attachments ?? []).filter((a) => a.mime.startsWith('image/'));
    for (const path of req.images ?? []) {
      const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' } as Record<string, string>)[extname(path).toLowerCase()];
      if (!mime) throw new Error('Nicht unterstütztes Bildformat.');
      images.push({ id: '', name: '', mime, data: (await readFile(path)).toString('base64') });
    }
    const content = images.length ? [{ type: 'text', text: req.prompt }, ...images.map((a) => ({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } }))] : req.prompt;
    messages.push({ role: 'user', content });
    const response = await fetch(`${apiBaseUrl(connection.baseUrl)}/chat/completions`, { method: 'POST', headers: await headers(connection.id), redirect: 'error', signal: controller.signal, body: JSON.stringify({ model, messages, stream: true }) });
    if (!response.ok) throw await responseError(response);
    let received = false;
    const handle = (payload: string) => {
      if (payload === '[DONE]') return true;
      if (!payload) return false;
      const data = JSON.parse(payload) as { error?: { message?: string }; choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string }; message?: { content?: string; reasoning_content?: string; reasoning?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (data.error) throw new Error(data.error.message ?? 'API-Fehler');
      received = true;
      const delta = data.choices?.[0]?.delta ?? data.choices?.[0]?.message;
      const thinking = delta?.reasoning_content ?? delta?.reasoning;
      if (thinking) emit({ type: 'thinking', delta: thinking });
      if (delta?.content) { text += delta.content; emit({ type: 'text', delta: delta.content }); }
      if (data.usage) emit({ type: 'usage', inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens });
      return false;
    };
    if (response.headers.get('content-type')?.includes('application/json')) handle(JSON.stringify(await response.json()));
    else {
      let event: string[] = [];
      for await (const line of responseLines(response)) {
        if (!line) { const done = handle(event.join('\n')); event = []; if (done) break; }
        else if (line.startsWith('data:')) event.push(line.slice(5).trimStart());
      }
      if (event.length) handle(event.join('\n'));
    }
    if (!received) throw new Error('Die API hat keine Chat-Antwort geliefert.');
    if (controller.signal.aborted) throw new Error('Abgebrochen');
    emit({ type: 'done', ok: true }); return { ok: true, text };
  } catch (e) { emit({ type: 'done', ok: false, error: controller.signal.aborted ? 'Abgebrochen' : (e as Error).message }); return { ok: false, text }; }
  finally { aborts.delete(req.runId); }
}
