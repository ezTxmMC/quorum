// Einheitliche Schnittstelle für Runtime-Adapter (llama.cpp, Transformers, Diffusers, Ollama, OpenAI-kompatibel …).
// Adapter laufen im Main-Prozess und sprechen mit ihrem Backend (Prozess, Python-Worker oder HTTP).
// Geladene Modelle deklarieren ihre Fähigkeiten über ChatHandle und ImageHandle.
import type { Backend, Capability, ModelDescriptor, RuntimeDetection, RuntimeId } from '../../shared/models';
import type { ChatMessage } from '../../shared/models';

export interface LoadOptions {
  /** Ausführung auf dieser Hardware; `cpu` ist immer möglich. */
  backend?: Backend;
  /** Anzahl der Schichten, die auf die GPU ausgelagert werden (llama.cpp). */
  gpuLayers?: number;
  contextSize?: number;
  /** Explizite Vertrauensfreigabe für eigenen Modellcode. Ohne sie wird nichts ausgeführt. */
  trustRemoteCode?: boolean;
}

export interface Memory {
  vram: number;
  ram: number;
}

/** Ein geladenes Modell innerhalb einer Runtime. */
export interface LoadedHandle {
  readonly runtime: RuntimeId;
  /** Läuft die Runtime noch? Fällt auf false, wenn der Prozess abgestürzt ist. */
  readonly alive: boolean;
  readonly memory: Memory;
  /** Gibt Speicher frei. Muss idempotent sein. */
  unload(): Promise<void>;
}

/** Kann Text erzeugen und streamen. */
export interface ChatHandle extends LoadedHandle {
  chat(messages: ChatMessage[], onDelta: (delta: string) => void, signal: AbortSignal): Promise<string>;
}

export interface ImageParams {
  prompt: string;
  negative?: string;
  steps?: number;
  guidance?: number;
  width?: number;
  height?: number;
  seed?: number;
}

/** Kann Bilder erzeugen. Liefert den Pfad der gespeicherten PNG-Datei. */
export interface ImageHandle extends LoadedHandle {
  image(params: ImageParams, out: string, signal: AbortSignal): Promise<string>;
}

export function isChat(h: LoadedHandle): h is ChatHandle {
  return typeof (h as Partial<ChatHandle>).chat === 'function';
}

export function isImage(h: LoadedHandle): h is ImageHandle {
  return typeof (h as Partial<ImageHandle>).image === 'function';
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly capabilities: Capability[];

  /** Prüft, ob die Runtime auf diesem Rechner verfügbar ist (Binary, Python-Paket, Dienst). Darf nie werfen. */
  detect(): Promise<RuntimeDetection>;

  /** Kann diese Runtime das Modell prinzipiell laden? Muss rein sein (keine I/O). */
  supports(model: ModelDescriptor): boolean;

  /** Schätzt den Speicherbedarf vor dem Laden. */
  estimateMemory(modelRef: string, options: LoadOptions): Promise<Memory>;

  load(modelRef: string, options: LoadOptions): Promise<LoadedHandle>;
}

const registry = new Map<RuntimeId, RuntimeAdapter>();

export function registerRuntime(adapter: RuntimeAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getRuntime(id: RuntimeId): RuntimeAdapter | undefined {
  return registry.get(id);
}

export function listRuntimes(): RuntimeAdapter[] {
  return [...registry.values()];
}
