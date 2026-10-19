// Python-Worker-Client: pro geladenem Transformers-/Diffusers-Modell ein eigener Prozess (quorum_worker.py).
// Ein Absturz oder OOM betrifft nur dieses Modell. Entladen = Prozess beenden; das gibt den VRAM sicher frei.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, ModelRecord, RuntimeId } from '../../shared/models';
import type { ChatHandle, ImageHandle, ImageParams, LoadedHandle, LoadOptions, Memory, RuntimeAdapter } from './adapter';
import { venvPython } from './pyenv';

export interface WorkerEvent {
  event: 'text' | 'image' | 'status' | 'error' | 'done';
  id: string;
  [key: string]: unknown;
}

export interface WorkerResult {
  ok: boolean;
  error?: string;
  code?: string;
  events: WorkerEvent[];
}

interface Pending {
  events: WorkerEvent[];
  onEvent?: (e: WorkerEvent) => void;
  resolve: (r: WorkerResult) => void;
}

/** Wurzel des Python-Ordners der App (Worker-Skript und requirements.txt). */
let pythonRoot = '';
export function setPythonRoot(dir: string): void {
  pythonRoot = dir;
}
export const workerScript = () => join(pythonRoot, 'quorum_worker.py');

export class PyWorker {
  private child: ChildProcess | null = null;
  private pending = new Map<string, Pending>();
  private buf = '';
  private stderr = '';
  private dead = false;

  static start(python: string, script: string): PyWorker {
    const w = new PyWorker();
    w.child = spawn(python, ['-I', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' } });
    w.child.stdout?.setEncoding('utf8');
    w.child.stdout?.on('data', (c: string) => w.onData(c));
    w.child.stderr?.setEncoding('utf8');
    w.child.stderr?.on('data', (c: string) => { w.stderr = (w.stderr + c).slice(-6000); });
    w.child.on('error', () => w.onExit());
    w.child.on('exit', () => w.onExit());
    return w;
  }

  get alive(): boolean {
    return !this.dead && !!this.child;
  }

  get errorLog(): string {
    return this.stderr.trim().split('\n').slice(-6).join('\n');
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev: WorkerEvent;
      try { ev = JSON.parse(line) as WorkerEvent; } catch { continue; }
      this.dispatch(ev);
    }
  }

  private dispatch(ev: WorkerEvent): void {
    const p = this.pending.get(ev.id);
    if (!p) return;
    p.events.push(ev);
    p.onEvent?.(ev);
    if (ev.event === 'done') {
      this.pending.delete(ev.id);
      const err = p.events.find((e) => e.event === 'error');
      p.resolve({
        ok: !!ev.ok,
        error: err ? String(err.message ?? 'Fehler') : undefined,
        code: err ? String(err.code ?? 'error') : undefined,
        events: p.events,
      });
    }
  }

  private onExit(): void {
    if (this.dead) return;
    this.dead = true;
    const tail = this.errorLog;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({ ok: false, error: `Runtime beendet${tail ? `: ${tail.slice(-300)}` : ''}`, code: 'crashed', events: p.events });
    }
  }

  /** Eine Anfrage senden. Resolved mit dem Endergebnis, wenn der Worker `done` meldet oder abstürzt. */
  request(payload: Record<string, unknown>, onEvent?: (e: WorkerEvent) => void): Promise<WorkerResult> {
    const id = randomUUID();
    return new Promise((resolve) => {
      if (!this.alive || !this.child?.stdin) {
        resolve({ ok: false, error: 'Runtime läuft nicht', code: 'crashed', events: [] });
        return;
      }
      this.pending.set(id, { events: [], onEvent, resolve });
      this.child.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    });
  }

  /** Prozess beenden. Gibt den VRAM frei, auch wenn der Worker hängt (nach Frist hart beenden). */
  async stop(): Promise<void> {
    const c = this.child;
    if (!c || this.dead) return;
    try { this.child?.stdin?.write(JSON.stringify({ id: randomUUID(), op: 'shutdown' }) + '\n'); } catch { /* schon zu */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* beendet */ } resolve(); }, 5000);
      c.once('exit', () => { clearTimeout(t); resolve(); });
    });
    this.child = null;
  }
}

/** Ein geladenes Modell im Python-Worker. Kann Text (Transformers) oder Bilder (Diffusers) erzeugen. */
export class PyModel implements ChatHandle, ImageHandle {
  readonly memory: Memory;
  constructor(
    readonly runtime: Extract<RuntimeId, 'transformers' | 'diffusers'>,
    private readonly worker: PyWorker,
    memory: Memory,
  ) {
    this.memory = memory;
  }

  get alive(): boolean {
    return this.worker.alive;
  }

  async unload(): Promise<void> {
    await this.worker.stop();
  }

  async chat(messages: ChatMessage[], onDelta: (delta: string) => void, signal: AbortSignal): Promise<string> {
    if (this.runtime !== 'transformers') throw new Error('Dieses Modell kann keinen Text erzeugen');
    let text = '';
    const onAbort = () => { void this.worker.stop(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await this.worker.request({ op: 'chat', messages, maxNewTokens: 1024 }, (e) => {
        if (e.event === 'text' && typeof e.delta === 'string') { text += e.delta; onDelta(e.delta); }
      });
      if (signal.aborted) throw new Error('Abgebrochen');
      if (!r.ok) throw new Error(r.error ?? 'Chat fehlgeschlagen');
      return text;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async image(params: ImageParams, out: string, signal: AbortSignal): Promise<string> {
    if (this.runtime !== 'diffusers') throw new Error('Dieses Modell kann keine Bilder erzeugen');
    const onAbort = () => { void this.worker.stop(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await this.worker.request({ op: 'image', out, ...params });
      if (signal.aborted) throw new Error('Abgebrochen');
      if (!r.ok) throw new Error(r.error ?? 'Bild fehlgeschlagen');
      const img = r.events.find((e) => e.event === 'image');
      if (!img || typeof img.path !== 'string') throw new Error('Kein Bild erzeugt');
      return img.path;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Speicherschätzung für Transformers/Diffusers: Gewichte (Dateigröße) plus Puffer für Aktivierungen. */
export function estimatePy(sizeBytes: number): Memory {
  return { vram: Math.round(sizeBytes * 1.1 + 768 * 1024 ** 2), ram: 1024 ** 3 };
}

/** Lädt ein Modell in einen eigenen Worker-Prozess. Scheitert das Laden, wird der Prozess sofort beendet. */
export async function loadPy(
  kind: 'transformers' | 'diffusers',
  record: ModelRecord,
  opts: { trustRemoteCode: boolean; offload?: 'none' | 'model' },
): Promise<PyModel> {
  const py = venvPython(pythonDataRoot());
  if (!existsSync(py)) throw new Error('Python-Umgebung fehlt – bitte unter Modelle → Python einrichten.');
  if (!existsSync(workerScript())) throw new Error(`Worker-Skript fehlt: ${workerScript()}`);
  const worker = PyWorker.start(py, workerScript());
  const r = await worker.request(
    { op: 'load', kind, path: record.path, trustRemoteCode: opts.trustRemoteCode, variant: record.load?.variant, offload: opts.offload ?? 'none' },
  );
  if (!r.ok) {
    await worker.stop();
    const err = new Error(r.error ?? 'Laden fehlgeschlagen');
    (err as Error & { code?: string }).code = r.code;
    throw err;
  }
  return new PyModel(kind, worker, estimatePy(record.sizeBytes));
}

/** Gesamtgröße eines Modells (Datei oder Ordner) in Byte. */
export async function sizeOf(path: string): Promise<number> {
  let st;
  try {
    st = await fsp.stat(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  try {
    const entries = await fsp.readdir(path, { withFileTypes: true });
    for (const e of entries) total += await sizeOf(join(path, e.name));
  } catch {
    return total;
  }
  return total;
}

function adapter(id: 'transformers' | 'diffusers', caps: RuntimeAdapter['capabilities']): RuntimeAdapter {
  return {
    id,
    capabilities: caps,
    async detect() {
      const ok = existsSync(venvPython(pythonDataRoot()));
      return { runtime: id, available: ok, backends: ok ? ['rocm', 'cpu'] : ['cpu'], error: ok ? undefined : 'Python-Umgebung nicht eingerichtet' };
    },
    supports(m) {
      return m.format === 'safetensors' && (id === 'transformers' ? m.architecture === 'transformer-lm' : m.architecture === 'diffusers-pipeline');
    },
    async estimateMemory(modelRef) {
      return estimatePy(await sizeOf(modelRef));
    },
    async load(modelRef, o: LoadOptions): Promise<LoadedHandle> {
      const record = { path: modelRef, sizeBytes: await sizeOf(modelRef) } as ModelRecord;
      return loadPy(id, record, { trustRemoteCode: !!o.trustRemoteCode });
    },
  };
}

let dataRootFn: () => string = () => '';
/** Datenordner, in dem die Python-Umgebung liegt (wird beim Start gesetzt). */
export function setPyDataRoot(fn: () => string): void {
  dataRootFn = fn;
}
function pythonDataRoot(): string {
  return dataRootFn();
}

export const transformersAdapter = adapter('transformers', ['chat', 'coding', 'reasoning', 'agent', 'vision']);
export const diffusersAdapter = adapter('diffusers', ['text-to-image', 'image-to-image', 'inpainting']);
