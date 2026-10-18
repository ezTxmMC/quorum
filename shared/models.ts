// Gemeinsames Modell-Vokabular für Main-Prozess und Renderer.
// Trennt bewusst: Quelle, Dateiformat, Architektur, Runtime, Provider und Fähigkeiten.
// Ein Safetensors-Modell ist nicht automatisch mit jeder Pipeline kompatibel – das entscheidet compatibleRuntimes().

/** Woher das Modell stammt. */
export type ModelSource = 'huggingface' | 'local' | 'ollama' | 'openai-compatible' | 'cloud';

/** Dateiformat der Gewichte. */
export type ModelFormat = 'gguf' | 'safetensors' | 'pytorch-bin' | 'ollama-blob' | 'api' | 'unknown';

/**
 * Modellarchitektur – die Familie, die bestimmt, welche Runtime das Modell laden kann.
 * `transformer-lm`: Sprach-/Multimodal-LLMs · `diffusers-pipeline`: Bild-/Video-Diffusion · `mesh-generator`: 3D-Generierung.
 */
export type ModelArchitecture =
  | 'transformer-lm'
  | 'diffusers-pipeline'
  | 'mesh-generator'
  | 'speech'
  | 'embedding'
  | 'unknown';

/** Ausführungsumgebung, die ein Runtime-Adapter bereitstellt. Weitere Backends werden hier ergänzt. */
export type RuntimeId = 'llama.cpp' | 'ollama' | 'transformers' | 'diffusers' | 'openai-compatible' | 'mesh-adapter';

/** Hardware-Backend. `cpu` ist immer der Fallback. */
export type Backend = 'rocm' | 'cuda' | 'vulkan' | 'metal' | 'cpu';

/** Was ein Modell kann. Ein Modell hat eine oder mehrere dieser Fähigkeiten. */
export type Capability =
  | 'chat'
  | 'coding'
  | 'reasoning'
  | 'agent'
  | 'vision'
  | 'text-to-image'
  | 'image-to-image'
  | 'inpainting'
  | 'text-to-3d'
  | 'image-to-3d'
  | 'texturing'
  | 'audio'
  | 'speech-to-text'
  | 'text-to-speech'
  | 'video-understanding'
  | 'video-generation'
  | 'embedding'
  | 'rerank';

export const CAPABILITY_LABELS: Record<Capability, string> = {
  chat: 'Chat',
  coding: 'Coding',
  reasoning: 'Reasoning',
  agent: 'Agent',
  vision: 'Bildverständnis',
  'text-to-image': 'Text → Bild',
  'image-to-image': 'Bild → Bild',
  inpainting: 'Inpainting',
  'text-to-3d': 'Text → 3D',
  'image-to-3d': 'Bild → 3D',
  texturing: '3D-Texturierung',
  audio: 'Audio',
  'speech-to-text': 'Sprache → Text',
  'text-to-speech': 'Text → Sprache',
  'video-understanding': 'Videoanalyse',
  'video-generation': 'Videogenerierung',
  embedding: 'Embeddings',
  rerank: 'Reranking',
};

/** Ausgabe-Art eines Modells – steuert, wie die UI das Ergebnis darstellt. */
export type OutputKind = 'text' | 'image' | 'mesh' | 'audio' | 'video' | 'vector';

/** Eingaben, die ein Modell annehmen kann – steuert die Eingabefelder der UI. */
export type InputKind = 'text' | 'image' | 'mesh' | 'audio' | 'video';

export interface CapabilityIO {
  inputs: InputKind[];
  outputs: OutputKind[];
}

/** Ergebnis der Kompatibilitätsprüfung für eine Runtime. */
export type CompatLevel =
  /** Format und Architektur passen laut Adapter-Regeln – das Laden kann trotzdem an der konkreten Modellklasse scheitern. */
  | 'likely'
  /** Nur mit explizitem Vertrauen (`trust_remote_code`) oder über Umwege lauffähig. */
  | 'requires-trust'
  /** Nicht kompatibel. */
  | 'incompatible';

export interface RuntimeCompat {
  runtime: RuntimeId;
  level: CompatLevel;
  /** Kurze Begründung für die UI und das Log. */
  reason: string;
}

/** Beschreibt ein Modell so weit, dass die Kompatibilität bestimmt werden kann. */
export interface ModelDescriptor {
  source: ModelSource;
  format: ModelFormat;
  architecture: ModelArchitecture;
  capabilities: Capability[];
  /** Modell-Code (custom modeling files) muss ausgeführt werden. Erfordert explizites Vertrauen. */
  needsRemoteCode?: boolean;
}

/** Ergebnis der Runtime-Erkennung auf diesem Rechner. */
export interface RuntimeDetection {
  runtime: RuntimeId;
  available: boolean;
  version?: string;
  backends: Backend[];
  /** Warum eine Runtime nicht verfügbar ist (z. B. fehlendes Python-Paket). */
  error?: string;
}

/** Ein Modell in der lokalen Registry (persistiert in hub.json). */
export interface ModelRecord {
  id: string;
  name: string;
  source: ModelSource;
  /** Hugging-Face-Repo, z. B. "ggml-org/gemma-3-270m-GGUF". */
  repo?: string;
  revision?: string;
  license?: string;
  /** Hauptdatei (GGUF) bzw. Modellordner (Safetensors-Pipelines), absolut. */
  path: string;
  /** Alle Dateien des Modells, relativ zu `path` (bei Einzeldateien nur die Datei). */
  files: string[];
  format: ModelFormat;
  architecture: ModelArchitecture;
  capabilities: Capability[];
  quantization?: string;
  sizeBytes: number;
  needsRemoteCode?: boolean;
  /** Vom Nutzer freigegebene Runtime (sonst wird die bevorzugte gewählt). */
  runtime?: RuntimeId;
  /** Lokale Einstellungen für das Laden. */
  load?: { gpuLayers?: number; contextSize?: number; backend?: Backend; trustRemoteCode?: boolean; /** Diffusers: Gewichtsvariante, z. B. "fp16". */ variant?: string; /** Diffusers: Modellteile auf die CPU auslagern, wenn der VRAM nicht reicht. */ offload?: 'none' | 'model' };
  addedAt: number;
}

/** Nachricht für Chat mit lokalen Modellen (Verlauf wird vom Renderer mitgeschickt). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
