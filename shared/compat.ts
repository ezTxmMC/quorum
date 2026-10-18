// Kompatibilitätsregeln: welche Runtime kann ein Modell laden und ausführen?
// Reine Funktion ohne I/O – läuft im Main-Prozess (Auswahl, Routing) und im Renderer (Anzeige).
import type { CompatLevel, ModelDescriptor, RuntimeCompat, RuntimeId } from './models';

/** Alle Runtimes, in der Reihenfolge ihrer Präferenz für ein Modell. */
const RUNTIME_ORDER: RuntimeId[] = ['llama.cpp', 'transformers', 'diffusers', 'mesh-adapter', 'ollama', 'openai-compatible'];

export function compatibleRuntimes(m: ModelDescriptor): RuntimeCompat[] {
  const out = RUNTIME_ORDER.map((runtime) => check(runtime, m));
  return out.filter((c) => c.level !== 'incompatible');
}

/** Die bevorzugte, sofort nutzbare Runtime (ohne Vertrauensfreigabe). */
export function preferredRuntime(m: ModelDescriptor): RuntimeCompat | undefined {
  return compatibleRuntimes(m).find((c) => c.level === 'likely');
}

function result(runtime: RuntimeId, level: CompatLevel, reason: string): RuntimeCompat {
  return { runtime, level, reason };
}

/** Eine Runtime gegen ein Modell prüfen. Regeln sind konservativ: im Zweifel „incompatible“. */
export function check(runtime: RuntimeId, m: ModelDescriptor): RuntimeCompat {
  // Cloud- und HTTP-Quellen laufen nie über lokale Gewichte.
  if (m.source === 'cloud') return result(runtime, 'incompatible', 'Cloud-Modell – keine lokale Runtime nötig');

  switch (runtime) {
    case 'ollama':
      if (m.source === 'ollama' && m.format === 'ollama-blob') return result(runtime, 'likely', 'Von Ollama verwaltetes Modell');
      return result(runtime, 'incompatible', 'Ollama lädt nur eigene Modelle (ollama pull)');

    case 'openai-compatible':
      if (m.source === 'openai-compatible' || m.format === 'api') return result(runtime, 'likely', 'HTTP-API mit OpenAI-kompatiblem Protokoll');
      return result(runtime, 'incompatible', 'Keine externe API-Adresse');

    case 'llama.cpp':
      if (m.format !== 'gguf') return result(runtime, 'incompatible', 'llama.cpp braucht GGUF');
      if (m.architecture !== 'transformer-lm') return result(runtime, 'incompatible', 'GGUF-Bild- und 3D-Modelle sind hier nicht ausführbar');
      return result(runtime, 'likely', 'GGUF-Sprachmodell');

    case 'transformers':
      if (m.architecture !== 'transformer-lm' && m.architecture !== 'embedding' && m.architecture !== 'speech') {
        return result(runtime, 'incompatible', 'Architektur ist keine Transformer-Architektur');
      }
      if (m.format !== 'safetensors' && m.format !== 'pytorch-bin') return result(runtime, 'incompatible', 'Transformers braucht Safetensors oder PyTorch-Gewichte');
      // PyTorch-.bin wird mit pickle geladen – nur mit Vertrauen, sofern nicht zusätzlich safetensors vorliegt.
      if (m.format === 'pytorch-bin') return result(runtime, 'requires-trust', 'PyTorch-.bin (pickle) – nur aus vertrauenswürdiger Quelle');
      if (m.needsRemoteCode) return result(runtime, 'requires-trust', 'Benötigt trust_remote_code (eigener Modellcode)');
      return result(runtime, 'likely', 'Safetensors-Transformer');

    case 'diffusers':
      if (m.architecture !== 'diffusers-pipeline') return result(runtime, 'incompatible', 'Keine Diffusers-Pipeline');
      if (m.format !== 'safetensors' && m.format !== 'pytorch-bin') return result(runtime, 'incompatible', 'Diffusers braucht Safetensors oder PyTorch-Gewichte');
      if (m.format === 'pytorch-bin') return result(runtime, 'requires-trust', 'PyTorch-.bin (pickle) – nur aus vertrauenswürdiger Quelle');
      if (m.needsRemoteCode) return result(runtime, 'requires-trust', 'Benötigt trust_remote_code (eigene Pipeline)');
      return result(runtime, 'likely', 'Diffusers-Pipeline mit Safetensors');

    case 'mesh-adapter':
      if (m.architecture !== 'mesh-generator') return result(runtime, 'incompatible', 'Kein 3D-Generator');
      // 3D-Modelle sind meist eigene Repos mit Modellcode – ohne Vertrauen nicht ausführen.
      if (m.needsRemoteCode || m.format === 'pytorch-bin') return result(runtime, 'requires-trust', '3D-Generator mit eigenem Modellcode');
      if (m.format !== 'safetensors') return result(runtime, 'incompatible', '3D-Generator braucht Safetensors');
      return result(runtime, 'likely', 'Spezialisierter 3D-Adapter');
  }
}
