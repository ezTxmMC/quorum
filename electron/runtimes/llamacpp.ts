// llama.cpp-Adapter: startet `llama-server` als isolierten Kindprozess und spricht dessen OpenAI-kompatible API.
// Ein Absturz des Servers betrifft nur dieses Modell – die Electron-App läuft weiter.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { Backend, Capability, ModelDescriptor, RuntimeDetection } from '../../shared/models';
import type { ChatHandle, LoadedHandle, LoadOptions, Memory, RuntimeAdapter } from './adapter';

const BIN = 'llama-server';

// Laufende Server-Prozesse werden in einer Datei geführt. Stürzt die App hart ab, beendet der nächste Start
// verwaiste Server – sonst bliebe deren VRAM belegt.
let pidFile: string | undefined;
const SIGNATURE = '--no-webui';

function readPids(): number[] {
  if (!pidFile || !existsSync(pidFile)) return [];
  try { return JSON.parse(readFileSync(pidFile, 'utf8')) as number[]; } catch { return []; }
}
function writePids(list: number[]): void {
  if (pidFile) writeFileSync(pidFile, JSON.stringify(list));
}
function trackPid(pid: number): void { writePids([...new Set([...readPids(), pid])]); }
function untrackPid(pid: number): void { writePids(readPids().filter((p) => p !== pid)); }

/** Verwaiste Server aus einem früheren Lauf beenden (nur Prozesse mit unserer Kennung in der Kommandozeile). */
export function reapOrphans(): number {
  let killed = 0;
  for (const pid of readPids()) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes('llama-server') || !cmd.includes(SIGNATURE)) continue;
      process.kill(pid, 'SIGTERM');
      killed++;
      setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* schon beendet */ } }, 3000).unref();
    } catch { /* Prozess existiert nicht mehr */ }
  }
  writePids([]);
  return killed;
}

/** Legt fest, wo die Prozessliste liegt, und beendet Reste eines früheren Laufs. */
export function setRuntimePidFile(path: string): number {
  pidFile = path;
  return reapOrphans();
}

/** Backends aus `llama-server --list-devices` ableiten (z. B. "Vulkan0: AMD Radeon …"). */
export function backendsFromDevices(output: string): Backend[] {
  const out = new Set<Backend>(['cpu']);
  if (/^\s*Vulkan\d+:/m.test(output)) out.add('vulkan');
  if (/^\s*(ROCm|HIP)\d+:/m.test(output)) out.add('rocm');
  if (/^\s*CUDA\d+:/m.test(output)) out.add('cuda');
  if (/^\s*MTL\d+:|Metal/m.test(output)) out.add('metal');
  return [...out];
}

function run(args: string[], timeout = 15000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(BIN, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}\n${stderr}` });
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Erkennt, ob ein Ladefehler auf zu wenig Speicher zurückgeht (GPU-OOM). */
export function isOomError(text: string): boolean {
  return /out of memory|OOM|cudaErrorMemoryAllocation|hipErrorOutOfMemory|vk::.*OutOfDeviceMemory|failed to allocate/i.test(text);
}

export class LlamaModel implements ChatHandle {
  readonly runtime = 'llama.cpp' as const;
  readonly memory: Memory;
  private proc: ChildProcess | null = null;
  private port = 0;
  private stderr = '';
  private dead = false;
  constructor(readonly modelRef: string, memory: Memory) {
    this.memory = memory;
  }

  async start(args: string[], timeoutMs: number): Promise<void> {
    this.port = await freePort();
    const full = [...args, '--host', '127.0.0.1', '--port', String(this.port), '--no-webui'];
    this.proc = spawn(BIN, full, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.proc.stderr?.setEncoding('utf8');
    this.proc.stderr?.on('data', (c: string) => { this.stderr = (this.stderr + c).slice(-8000); });
    this.proc.stdout?.resume();
    const pid = this.proc.pid;
    if (pid) trackPid(pid);
    this.proc.on('exit', () => { this.dead = true; if (pid) untrackPid(pid); });
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.dead) throw new Error(this.stderr.trim().split('\n').slice(-5).join('\n') || 'llama-server beendet');
      try {
        const r = await fetch(`${this.url()}/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) return;
      } catch { /* noch nicht bereit */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    await this.unload();
    throw new Error('llama-server wurde nicht rechtzeitig bereit');
  }

  get errorLog(): string { return this.stderr; }
  get alive(): boolean { return !this.dead; }
  url(): string { return `http://127.0.0.1:${this.port}`; }

  /** Streamt eine Chat-Antwort. Liefert den vollständigen Text. */
  async chat(messages: { role: string; content: string }[], onDelta: (d: string) => void, signal: AbortSignal): Promise<string> {
    const res = await fetch(`${this.url()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      // Der Server nennt die Ursache im Body (z. B. Kontext zu klein) – die gehört in die Meldung.
      const detail = await res.text().catch(() => '');
      throw new Error(`llama-server HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
          const d = j.choices?.[0]?.delta?.content;
          if (d) { text += d; onDelta(d); }
        } catch { /* unvollständiger Block */ }
      }
    }
    return text;
  }

  async unload(): Promise<void> {
    const p = this.proc;
    this.proc = null;
    if (!p || this.dead) return;
    if (p.pid) untrackPid(p.pid);
    try {
      if (process.platform === 'win32') p.kill();
      else if (p.pid) process.kill(-p.pid, 'SIGTERM');
    } catch { p.kill('SIGTERM'); }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* bereits beendet */ } resolve(); }, 4000);
      p.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

/** Ein Ladeauftrag. Hält die Instanz, damit der Scheduler sie beenden kann. */
export async function startLlama(modelPath: string, opts: LoadOptions & { memory: Memory }): Promise<LlamaModel> {
  const args = ['-m', modelPath];
  if (opts.gpuLayers !== undefined) args.push('-ngl', String(opts.gpuLayers));
  if (opts.contextSize) args.push('-c', String(opts.contextSize));
  const m = new LlamaModel(modelPath, opts.memory);
  // Ladedauer abhängig von der Modellgröße: große GGUFs brauchen mehr Zeit.
  const timeoutMs = 60000 + Math.round(statSync(modelPath).size / (50 * 1024 * 1024)) * 1000;
  await m.start(args, timeoutMs);
  return m;
}

/** Grobe Schätzung: Gewichte plus KV-Cache-Puffer. Bei Offloading anteilig auf RAM. */
export function estimateGguf(sizeBytes: number, gpuLayers: number | undefined, totalLayers = 40): Memory {
  const overhead = 0.6 * 1024 ** 3;
  const share = gpuLayers === undefined ? 1 : Math.min(1, gpuLayers / Math.max(1, totalLayers));
  return { vram: Math.round(sizeBytes * share + overhead * share), ram: Math.round(sizeBytes * (1 - share) + overhead * (1 - share)) };
}

const CAPS: Capability[] = ['chat', 'coding', 'reasoning', 'agent'];

export const llamaCppAdapter: RuntimeAdapter = {
  id: 'llama.cpp',
  capabilities: CAPS,

  async detect(): Promise<RuntimeDetection> {
    const v = await run(['--version']);
    if (!v.ok) return { runtime: 'llama.cpp', available: false, backends: [], error: `${BIN} nicht im PATH` };
    const dev = await run(['--list-devices'], 30000);
    const version = /version:\s*(\S+)/.exec(v.out)?.[1];
    return { runtime: 'llama.cpp', available: true, version, backends: backendsFromDevices(dev.out) };
  },

  supports(m: ModelDescriptor): boolean {
    return m.format === 'gguf' && m.architecture === 'transformer-lm' && m.source !== 'cloud';
  },

  async estimateMemory(modelRef, opts) {
    return estimateGguf(statSync(modelRef).size, opts.gpuLayers);
  },

  async load(modelRef, opts): Promise<LoadedHandle> {
    const memory = estimateGguf(statSync(modelRef).size, opts.gpuLayers);
    return startLlama(modelRef, { ...opts, memory });
  },
};
