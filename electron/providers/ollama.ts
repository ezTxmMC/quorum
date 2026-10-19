import type { HubEvent, ModelInfo, RunRequest } from '../../shared/types';

// Ollama: lokale Modelle über die HTTP-API (Standard http://127.0.0.1:11434, überschreibbar mit OLLAMA_HOST).
// Reiner Textchat – der Verlauf kommt aus dem Hub, es gibt keine Tools.
function host(): string {
  const h = (process.env.OLLAMA_HOST ?? '').trim();
  if (!h) return 'http://127.0.0.1:11434';
  const withScheme = /^https?:\/\//.test(h) ? h : `http://${h}`;
  return withScheme.replace(/\/+$/, '').replace('://0.0.0.0', '://127.0.0.1');
}

const aborts = new Map<string, AbortController>();
export function cancelOllama(runId: string): boolean {
  const a = aborts.get(runId);
  if (!a) return false;
  a.abort();
  return true;
}

/** Erreichbarkeit + installierte Modelle. */
export async function ollamaStatus(): Promise<{ up: boolean; models: ModelInfo[]; version?: string }> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 2500);
    const [tags, ver] = await Promise.all([
      fetch(`${host()}/api/tags`, { signal: ctl.signal }),
      fetch(`${host()}/api/version`, { signal: ctl.signal }).catch(() => null),
    ]);
    clearTimeout(to);
    if (!tags.ok) return { up: false, models: [] };
    const j = (await tags.json()) as { models?: { name: string; details?: { parameter_size?: string } }[] };
    const version = ver && ver.ok ? ((await ver.json()) as { version?: string }).version : undefined;
    const models = (j.models ?? []).map((m) => ({ id: m.name, label: m.details?.parameter_size ? `${m.name} · ${m.details.parameter_size}` : m.name } as ModelInfo));
    // Bildmodelle (z. B. Z-Image, FLUX) haben die Fähigkeit „image“.
    await Promise.all(models.map(async (m) => {
      try {
        const r = await fetch(`${host()}/api/show`, { method: 'POST', body: JSON.stringify({ model: m.id }), signal: AbortSignal.timeout(2500) });
        const caps = ((await r.json()) as { capabilities?: string[] }).capabilities ?? [];
        if (caps.includes('image')) m.image = true;
      } catch { /* egal */ }
    }));
    return { up: true, version, models };
  } catch { return { up: false, models: [] }; }
}

export async function runOllama(req: RunRequest, emit: (e: HubEvent) => void): Promise<{ ok: boolean; text: string }> {
  const model = req.options.model ?? (await ollamaStatus()).models[0]?.id;
  if (!model) {
    emit({ type: 'notice', level: 'error', text: 'Kein Ollama-Modell verfügbar. Ist Ollama gestartet (ollama serve) und ein Modell geladen (ollama pull …)?' });
    emit({ type: 'done', ok: false, error: 'Kein Modell' });
    return { ok: false, text: '' };
  }
  const ctl = new AbortController();
  aborts.set(req.runId, ctl);
  const messages: { role: string; content: string; images?: string[] }[] = [];
  if (req.options.systemPrompt) messages.push({ role: 'system', content: req.options.systemPrompt });
  for (const m of req.history ?? []) messages.push(m);
  // Bilder (Vision-Modelle) gehen direkt als Base64 in die Nachricht – ohne Datei.
  const images = (req.attachments ?? []).filter((a) => a.mime.startsWith('image/')).map((a) => a.data);
  messages.push(images.length ? { role: 'user', content: req.prompt, images } : { role: 'user', content: req.prompt });
  let text = '';
  try {
    const res = await fetch(`${host()}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, stream: true }), signal: ctl.signal });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* kein JSON */ }
      emit({ type: 'notice', level: 'error', text: msg });
      emit({ type: 'done', ok: false, error: msg });
      return { ok: false, text };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line) as { message?: { content?: string; thinking?: string }; done?: boolean; error?: string; prompt_eval_count?: number; eval_count?: number; total_duration?: number };
          if (j.error) emit({ type: 'notice', level: 'error', text: j.error });
          if (j.message?.thinking) emit({ type: 'thinking', delta: j.message.thinking });
          if (j.message?.content) { text += j.message.content; emit({ type: 'text', delta: j.message.content }); }
          if (j.done) emit({ type: 'usage', inputTokens: j.prompt_eval_count, outputTokens: j.eval_count, durationMs: j.total_duration ? Math.round(j.total_duration / 1e6) : undefined });
        } catch { /* unvollständige Zeile */ }
      }
    }
    emit({ type: 'done', ok: true, code: 0 });
    return { ok: true, text };
  } catch (e) {
    const aborted = ctl.signal.aborted;
    emit({ type: 'done', ok: false, error: aborted ? 'Abgebrochen' : `Ollama nicht erreichbar (${(e as Error).message})` });
    return { ok: false, text };
  } finally {
    aborts.delete(req.runId);
  }
}

/** Bild mit einem lokalen Ollama-Bildmodell erzeugen (/api/generate liefert das Bild als Base64). */
export async function runOllamaImage(req: RunRequest, emit: (e: HubEvent) => void): Promise<{ ok: boolean; text: string }> {
  const model = req.options.model!;
  const ctl = new AbortController();
  aborts.set(req.runId, ctl);
  const t0 = Date.now();
  try {
    const { storeImage } = await import('../images');
    const res = await fetch(`${host()}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: req.prompt, stream: true }), signal: ctl.signal });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* kein JSON */ }
      emit({ type: 'done', ok: false, error: msg });
      return { ok: false, text: '' };
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let got = 0;
    const handle = async (line: string) => {
      const j = JSON.parse(line) as { image?: string; images?: string[]; error?: string; response?: string };
      if (j.error) emit({ type: 'notice', level: 'error', text: j.error });
      for (const b64 of [j.image, ...(j.images ?? [])].filter((x): x is string => !!x)) { got++; emit({ type: 'image', path: await storeImage(b64), engine: `ollama:${model}` }); }
      if (j.response) emit({ type: 'text', delta: j.response });
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) try { await handle(line); } catch { /* unvollständige Zeile */ }
      }
    }
    if (buf.trim()) try { await handle(buf.trim()); } catch { /* egal */ }
    emit({ type: 'usage', durationMs: Date.now() - t0 });
    if (!got) { emit({ type: 'done', ok: false, error: 'Das Modell hat kein Bild geliefert.' }); return { ok: false, text: '' }; }
    emit({ type: 'done', ok: true, code: 0 });
    return { ok: true, text: '' };
  } catch (e) {
    emit({ type: 'done', ok: false, error: ctl.signal.aborted ? 'Abgebrochen' : `Ollama nicht erreichbar (${(e as Error).message})` });
    return { ok: false, text: '' };
  } finally {
    aborts.delete(req.runId);
  }
}
