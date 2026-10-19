// Model-Manager: lädt und entlädt lokale Modelle, koordiniert Anfragen über eine Prioritätswarteschlange
// und schützt vor Speichermangel (Schätzung vor dem Laden, LRU-Entladung, CPU-Fallback bei GPU-OOM).
// Die Runtime wird aus den Kompatibilitätsregeln (shared/compat.ts) gewählt, sofern das Modell sie nicht festlegt.
import { freemem } from 'node:os';
import type { Backend, ModelDescriptor, ModelRecord, RuntimeId } from '../../shared/models';
import { compatibleRuntimes } from '../../shared/compat';
import type { LoadedHandle, Memory } from './adapter';
import { isOomError, startLlama, estimateGguf } from './llamacpp';
import { loadPy, estimatePy } from './pyworker';
import { ggufVersion } from '../models/inspect';
import { snapshot } from './resources';

export interface Lease<T extends LoadedHandle = LoadedHandle> {
  model: T;
  /** Gibt die Ausleihe zurück. Danach darf das Modell nach Inaktivität entladen werden. */
  release(): void;
}

export interface ModelStats {
  loads: number;
  requests: number;
  deltas: number;
  lastLoadMs?: number;
  lastUsed?: number;
}

export interface LoadedInfo {
  modelId: string;
  runtime: RuntimeId;
  backend: Backend;
  gpuLayers?: number;
  memory: Memory;
  inUse: number;
  lastUsed: number;
  stats: ModelStats;
}

interface Entry {
  modelId: string;
  model: LoadedHandle;
  gpuLayers?: number;
  backend: Backend;
  memory: Memory;
  inUse: number;
  lastUsed: number;
  stats: ModelStats;
}

interface Task {
  modelId: string;
  priority: number;
  seq: number;
  resolve: (l: Lease) => void;
  reject: (e: Error) => void;
  record: ModelRecord;
  signal?: AbortSignal;
}

export interface SchedulerOptions {
  /** Modelle ohne Nutzung nach dieser Zeit entladen. */
  idleMs: number;
  /** Bei zu wenig VRAM oder GPU-OOM Schichten auf die CPU auslagern. */
  cpuFallback: boolean;
  /** Reserve, die beim VRAM-Check frei bleiben soll. */
  vramReserve: number;
  /** Ereignis für die Oberfläche (Laden, Entladen, Fehler). */
  onEvent?: (e: { type: 'loaded' | 'unloaded' | 'error' | 'queued'; modelId: string; text?: string }) => void;
}

const DEFAULTS: SchedulerOptions = { idleMs: 10 * 60 * 1000, cpuFallback: true, vramReserve: 512 * 1024 * 1024 };

/** Beschreibung eines Registry-Eintrags für die Kompatibilitätsprüfung. */
export function descriptorOf(record: ModelRecord): ModelDescriptor {
  return {
    source: record.source,
    format: record.format,
    architecture: record.architecture,
    capabilities: record.capabilities,
    needsRemoteCode: record.needsRemoteCode,
  };
}

/**
 * Wählt die Runtime für ein Modell. Festgelegt ist sie durch `record.runtime`, sonst die bevorzugte („likely“).
 * Verlangt das Modell eigenen Code (requires-trust), braucht es die ausdrückliche Freigabe im Modell.
 */
export function resolveRuntime(record: ModelRecord): { runtime: RuntimeId; trust: boolean } {
  const options = compatibleRuntimes(descriptorOf(record));
  const pick = record.runtime ? options.find((c) => c.runtime === record.runtime) : options.find((c) => c.level === 'likely');
  if (pick?.level === 'likely') return { runtime: pick.runtime, trust: false };
  if (pick?.level === 'requires-trust') {
    if (record.load?.trustRemoteCode) return { runtime: pick.runtime, trust: true };
    throw new Error(`${pick.reason}. Vertrauen für dieses Modell freigeben, um es zu laden.`);
  }
  if (record.runtime) throw new Error(`Runtime ${record.runtime} passt nicht zu diesem Modell`);
  throw new Error('Keine passende Runtime für dieses Modell gefunden');
}

export class ModelScheduler {
  private opts: SchedulerOptions;
  private loaded = new Map<string, Entry>();
  private queue: Task[] = [];
  private busy = false;
  private loadingModel: string | undefined;
  private seq = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor(opts: Partial<SchedulerOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.timer = setInterval(() => void this.reapIdle(), 30000);
    this.timer.unref();
  }

  configure(options?: { idleMinutes?: number; cpuFallback?: boolean; vramReserveMb?: number }): void {
    const number = (value: number | undefined, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    this.opts.idleMs = number(options?.idleMinutes, 10, 1, 1440) * 60000;
    this.opts.cpuFallback = options?.cpuFallback !== false;
    this.opts.vramReserve = number(options?.vramReserveMb, 512, 0, 65536) * 1024 ** 2;
  }

  /** Modell ausleihen (lädt bei Bedarf). Höhere Priorität kommt in der Warteschlange zuerst. */
  acquire<T extends LoadedHandle = LoadedHandle>(record: ModelRecord, priority = 0, signal?: AbortSignal): Promise<Lease<T>> {
    return new Promise<Lease<T>>((resolve, reject) => {
      const existing = this.loaded.get(record.id);
      if (existing && existing.model.alive) return resolve(this.lease(existing) as Lease<T>);
      const task: Task = { modelId: record.id, priority, seq: this.seq++, resolve: resolve as Task['resolve'], reject, record, signal };
      this.queue.push(task);
      this.opts.onEvent?.({ type: 'queued', modelId: record.id });
      signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(task);
        if (i >= 0) { this.queue.splice(i, 1); reject(new Error('Abgebrochen')); }
      }, { once: true });
      void this.pump();
    });
  }

  /** Verwendungszähler erhöhen, Statistik führen. Gibt den Lease zurück. */
  private lease(e: Entry): Lease {
    e.inUse++;
    e.lastUsed = Date.now();
    e.stats.requests++;
    e.stats.lastUsed = e.lastUsed;
    let done = false;
    return {
      model: e.model,
      release: () => {
        if (done) return;
        done = true;
        e.inUse = Math.max(0, e.inUse - 1);
        e.lastUsed = Date.now();
      },
    };
  }

  /** Statistik für Textausgaben (grob: Textblöcke zählen). */
  countDelta(modelId: string): void {
    const e = this.loaded.get(modelId);
    if (e) e.stats.deltas++;
  }

  list(): LoadedInfo[] {
    return [...this.loaded.values()].map((e) => ({
      modelId: e.modelId, runtime: e.model.runtime, backend: e.backend, gpuLayers: e.gpuLayers,
      memory: e.memory, inUse: e.inUse, lastUsed: e.lastUsed, stats: { ...e.stats },
    }));
  }

  /** Ereignisse (Laden, Entladen, Warteschlange, Fehler) an die Oberfläche weiterreichen. */
  setListener(fn: SchedulerOptions['onEvent']): void {
    this.opts.onEvent = fn;
  }

  isBusy(modelId: string): boolean {
    return !!this.loaded.get(modelId)?.inUse || this.loadingModel === modelId || this.queue.some((task) => task.modelId === modelId);
  }

  async unload(modelId: string): Promise<boolean> {
    const e = this.loaded.get(modelId);
    if (!e || e.inUse > 0) return false;
    this.loaded.delete(modelId);
    await e.model.unload();
    this.opts.onEvent?.({ type: 'unloaded', modelId });
    return true;
  }

  /** Entlädt alle Modelle ohne aktive Nutzung, die länger als `idleMs` inaktiv sind. */
  async reapIdle(now = Date.now()): Promise<string[]> {
    const gone: string[] = [];
    for (const e of [...this.loaded.values()]) {
      if (e.inUse === 0 && (now - e.lastUsed > this.opts.idleMs || !e.model.alive)) {
        if (await this.unload(e.modelId)) gone.push(e.modelId);
      }
    }
    return gone;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    for (const task of this.queue.splice(0)) task.reject(new Error('Beendet'));
    await Promise.all([...this.loaded.values()].map((e) => e.model.unload()));
    this.loaded.clear();
  }

  /** Eine Ladeaufgabe nach der anderen, jeweils die mit der höchsten Priorität (bei Gleichstand die älteste). */
  private async pump(): Promise<void> {
    if (this.busy) return;
    const next = this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq).shift();
    if (!next) return;
    this.busy = true;
    this.loadingModel = next.modelId;
    try {
      // Während der Wartezeit kann dasselbe Modell schon geladen worden sein.
      const ready = this.loaded.get(next.modelId);
      const entry = ready?.model.alive ? ready : await this.loadEntry(next.record, next.signal);
      next.resolve(this.lease(entry));
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.opts.onEvent?.({ type: 'error', modelId: next.modelId, text: err.message });
      next.reject(err);
    } finally {
      this.busy = false;
      this.loadingModel = undefined;
      void this.pump();
    }
  }

  private async loadEntry(record: ModelRecord, signal?: AbortSignal): Promise<Entry> {
    const { runtime, trust } = resolveRuntime(record);
    const backend: Backend = record.load?.backend ?? (runtime === 'llama.cpp' ? 'vulkan' : 'rocm');
    const started = Date.now();
    if (runtime === 'llama.cpp') return this.loadLlama(record, backend, started, signal);
    if (runtime === 'transformers' || runtime === 'diffusers') return this.loadPython(record, runtime, trust, backend, started, signal);
    throw new Error(`Runtime ${runtime} ist nicht implementiert`);
  }

  private async loadLlama(record: ModelRecord, backend: Backend, started: number, signal?: AbortSignal): Promise<Entry> {
    // GGUF-Version 1 ist veraltet und wird von aktuellem llama.cpp nicht mehr gelesen – klare Meldung statt kryptischem Serverfehler.
    const version = ggufVersion(record.path);
    if (version !== undefined && version < 2) throw new Error(`GGUF-Version ${version} wird nicht unterstützt – bitte ein aktuelleres Modell (GGUF v2 oder v3) verwenden.`);
    if (/-\d{5}-of-\d{5}\.gguf$/.test(record.path) && !/-00001-of-/.test(record.path)) {
      throw new Error('Geteilte GGUF-Datei: der erste Teil (-00001-of-…) muss geladen werden. Modell neu importieren oder herunterladen.');
    }
    const sizeBytes = record.sizeBytes;
    // 1) Speicher vorab prüfen und ggf. ungenutzte Modelle entladen (kann die GPU-Schichten reduzieren).
    let gpuLayers = await this.makeRoom((layers) => estimateGguf(sizeBytes, layers), record.load?.gpuLayers, record.id, true);
    // 2) Laden; bei GPU-OOM mit weniger GPU-Schichten erneut versuchen (CPU-Fallback).
    for (;;) {
      if (signal?.aborted) throw new Error('Abgebrochen');
      const memory = estimateGguf(sizeBytes, gpuLayers);
      try {
        const model = await startLlama(record.path, { backend: record.load?.backend, gpuLayers, contextSize: record.load?.contextSize, trustRemoteCode: false, memory });
        return this.register(record.id, model, gpuLayers, backend, memory, started);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!this.opts.cpuFallback || !isOomError(msg) || gpuLayers === 0) throw new Error(msg);
        gpuLayers = gpuLayers === undefined ? 20 : Math.floor(gpuLayers / 2);
        this.opts.onEvent?.({ type: 'error', modelId: record.id, text: `GPU-Speicher knapp – lagere ${gpuLayers} Schichten auf die GPU` });
      }
    }
  }

  private async loadPython(record: ModelRecord, runtime: 'transformers' | 'diffusers', trust: boolean, backend: Backend, started: number, signal?: AbortSignal): Promise<Entry> {
    await this.makeRoom(() => estimatePy(record.sizeBytes), undefined, record.id, false);
    if (signal?.aborted) throw new Error('Abgebrochen');
    // Diffusers: bei GPU-Speichermangel Modellteile auf die CPU auslagern und erneut versuchen.
    const offloads: ('none' | 'model')[] = runtime === 'diffusers' && this.opts.cpuFallback ? ['none', 'model'] : ['none'];
    let lastError: Error = new Error('Laden fehlgeschlagen');
    for (const offload of offloads) {
      try {
        const model = await loadPy(runtime, record, { trustRemoteCode: trust, offload });
        return this.register(record.id, model, undefined, backend, estimatePy(record.sizeBytes), started);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if ((lastError as Error & { code?: string }).code !== 'oom') break;
        this.opts.onEvent?.({ type: 'error', modelId: record.id, text: 'GPU-Speicher knapp – lagere Modellteile auf die CPU aus' });
      }
    }
    throw lastError;
  }

  private register(modelId: string, model: LoadedHandle, gpuLayers: number | undefined, backend: Backend, memory: Memory, started: number): Entry {
    const entry: Entry = {
      modelId, model, gpuLayers, backend, memory,
      inUse: 0, lastUsed: Date.now(), stats: { loads: 1, requests: 0, deltas: 0, lastLoadMs: Date.now() - started },
    };
    this.loaded.set(modelId, entry);
    this.opts.onEvent?.({ type: 'loaded', modelId });
    return entry;
  }

  /**
   * Vor dem Laden: genug VRAM und RAM frei machen. Ungenutzte Modelle werden entladen.
   * Bei `canOffload` (llama.cpp) werden notfalls GPU-Schichten reduziert (CPU-Fallback). Liefert die finalen Schichten.
   */
  private async makeRoom(need: (gpuLayers?: number) => Memory, gpuLayers: number | undefined, forModel: string, canOffload: boolean): Promise<number | undefined> {
    for (;;) {
      const snap = await snapshot();
      const vramFree = snap.gpu ? snap.gpu.vramTotal - snap.gpu.vramUsed : Infinity;
      const m = need(gpuLayers);
      if (m.vram + this.opts.vramReserve <= vramFree && m.ram <= freemem()) return gpuLayers;
      // Ungenutzte Modelle, älteste zuerst, entladen.
      const idle = [...this.loaded.values()].filter((e) => e.inUse === 0 && e.modelId !== forModel).sort((a, b) => a.lastUsed - b.lastUsed);
      if (idle.length) { await this.unload(idle[0].modelId); continue; }
      if (canOffload && this.opts.cpuFallback && gpuLayers !== 0) {
        gpuLayers = gpuLayers === undefined ? 0 : Math.floor(gpuLayers / 2);
        this.opts.onEvent?.({ type: 'error', modelId: forModel, text: `Zu wenig VRAM – lagere auf ${gpuLayers} GPU-Schichten` });
        continue;
      }
      return gpuLayers; // keine Ausweichmöglichkeit mehr – der Ladeversuch meldet den Fehler
    }
  }
}

export const scheduler = new ModelScheduler();
