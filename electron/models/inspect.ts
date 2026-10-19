import { promises as fsp } from 'node:fs';
import { join, extname } from 'node:path';
import type { Capability, ModelArchitecture, ModelDescriptor, ModelFormat } from '../../shared/models';

/** Dateiformat anhand der Magic-Bytes bzw. Endung. */
export async function detectFileFormat(file: string): Promise<ModelFormat> {
  const ext = extname(file).toLowerCase();
  if (ext === '.gguf') return (await readMagic(file)) === 'GGUF' ? 'gguf' : 'unknown';
  if (ext === '.safetensors') return 'safetensors';
  if (ext === '.bin') return 'pytorch-bin';
  return 'unknown';
}

async function readMagic(file: string): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.toString('latin1');
  } finally {
    await fh.close();
  }
}

/** GGUF-Versionsnummer (Little-Endian uint32 nach der Magic). Gibt undefined zurück, wenn die Datei keine GGUF ist. */
export async function ggufVersion(file: string): Promise<number | undefined> {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(8);
      await fh.read(buf, 0, 8, 0);
      return buf.toString('latin1', 0, 4) === 'GGUF' ? buf.readUInt32LE(4) : undefined;
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

/** Safetensors-Header prüfen: 8 Byte Länge (LE) + JSON. Gibt false zurück, wenn die Datei kaputt ist. */
export async function isValidSafetensors(file: string): Promise<boolean> {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const len = Buffer.alloc(8);
      await fh.read(len, 0, 8, 0);
      const n = Number(len.readBigUInt64LE(0));
      if (n <= 0 || n > 100 * 1024 * 1024) return false;
      const head = Buffer.alloc(n);
      await fh.read(head, 0, n, 8);
      JSON.parse(head.toString('utf8'));
      return true;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** Quantisierung aus dem GGUF-Dateinamen (z. B. Q4_K_M, IQ3_XS, F16, BF16). */
export function quantizationFromName(name: string): string | undefined {
  const m = /\b(I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP8)\b/i.exec(name);
  return m ? m[1].toUpperCase() : undefined;
}

/** Fähigkeiten aus dem Hugging-Face-Pipeline-Tag (und Namenshinweisen). */
export function capabilitiesFromPipeline(pipelineTag: string | undefined, tags: string[] = [], name = ''): Capability[] {
  const caps = new Set<Capability>();
  switch (pipelineTag) {
    case 'text-generation': caps.add('chat'); break;
    case 'image-text-to-text': caps.add('chat'); caps.add('vision'); break;
    case 'text-to-image': caps.add('text-to-image'); break;
    case 'image-to-image': caps.add('image-to-image'); break;
    case 'image-to-3d': caps.add('image-to-3d'); break;
    case 'text-to-3d': caps.add('text-to-3d'); break;
    case 'automatic-speech-recognition': caps.add('speech-to-text'); break;
    case 'text-to-speech': caps.add('text-to-speech'); break;
    case 'feature-extraction': caps.add('embedding'); break;
    case 'text-ranking': caps.add('rerank'); break;
    case 'video-text-to-text': caps.add('video-understanding'); caps.add('chat'); break;
    case 'text-to-video': caps.add('video-generation'); break;
    case 'image-feature-extraction': caps.add('embedding'); break;
  }
  const hint = `${name} ${tags.join(' ')}`.toLowerCase();
  if (caps.has('chat') && /coder|code/.test(hint)) caps.add('coding');
  if (caps.has('chat') && /reason|thinking|r1|gpt-oss/.test(hint)) caps.add('reasoning');
  if (caps.has('chat') && /tool|agent/.test(hint)) caps.add('agent');
  if (/inpaint/.test(hint) && caps.has('text-to-image')) caps.add('inpainting');
  if (/texture|texturing/.test(hint)) caps.add('texturing');
  return [...caps];
}

/** Standard-Fähigkeiten eines Sprachmodells ohne Pipeline-Tag (Namenshinweise für Coding/Reasoning). */
export function defaultTextCapabilities(name: string, files: string[] = []): Capability[] {
  const hint = `${name} ${files.join(' ')}`.toLowerCase();
  const caps: Capability[] = ['chat'];
  if (/coder|code/.test(hint)) caps.push('coding');
  if (/reason|thinking|r1|gpt-oss/.test(hint)) caps.push('reasoning');
  if (/tool|agent/.test(hint)) caps.push('agent');
  return caps;
}

/** Architektur grob aus Dateiliste und config.json ableiten. */
export function architectureFor(files: string[], configJson?: Record<string, unknown>, pipelineTag?: string): ModelArchitecture {
  if (files.includes('model_index.json') || pipelineTag?.startsWith('text-to-image') || pipelineTag === 'image-to-image') return 'diffusers-pipeline';
  if (pipelineTag === 'image-to-3d' || pipelineTag === 'text-to-3d') return 'mesh-generator';
  if (pipelineTag === 'automatic-speech-recognition' || pipelineTag === 'text-to-speech') return 'speech';
  if (pipelineTag === 'text-generation' || pipelineTag === 'image-text-to-text' || pipelineTag === 'video-text-to-text') return 'transformer-lm';
  if (pipelineTag === 'feature-extraction' || pipelineTag === 'text-ranking') return 'embedding';
  if (configJson && typeof configJson.model_type === 'string') return 'transformer-lm';
  if (configJson && Array.isArray(configJson.architectures)) return 'transformer-lm';
  if (files.some((f) => f.endsWith('.gguf'))) return 'transformer-lm';
  return 'unknown';
}

/** Remote-Code-Bedarf: auto_map in config.json oder eigene Modelldatei im Repo. */
export function needsRemoteCode(files: string[], configJson?: Record<string, unknown>): boolean {
  if (configJson && configJson.auto_map) return true;
  return files.some((f) => /^modeling_.*\.py$/.test(f) || /^pipeline\.py$/.test(f) || /custom_pipeline/.test(f));
}

/** Format eines Modellordners (Repo-Dateiliste oder lokaler Ordner) bestimmen. */
export function formatFor(files: string[]): ModelFormat {
  if (files.some((f) => f.endsWith('.gguf'))) return 'gguf';
  if (files.some((f) => f.endsWith('.safetensors'))) return 'safetensors';
  if (files.some((f) => f.endsWith('.bin') && /pytorch|model/.test(f))) return 'pytorch-bin';
  return 'unknown';
}

/** Descriptor aus Dateiliste, Pipeline-Tag und Tags zusammensetzen. Grundlage für `compatibleRuntimes()`. */
export function describeModel(args: {
  source: ModelDescriptor['source'];
  name: string;
  files: string[];
  pipelineTag?: string;
  tags?: string[];
  configJson?: Record<string, unknown>;
}): ModelDescriptor & { quantization?: string } {
  const format = formatFor(args.files);
  const architecture = architectureFor(args.files, args.configJson, args.pipelineTag);
  let capabilities = capabilitiesFromPipeline(args.pipelineTag, args.tags, args.name);
  // Viele GGUF-Repos haben keinen Pipeline-Tag: ein Sprachmodell kann dann trotzdem chatten.
  if (!capabilities.length && format === 'gguf' && architecture === 'transformer-lm') capabilities = defaultTextCapabilities(args.name, args.files);
  return {
    source: args.source,
    format,
    architecture,
    capabilities,
    needsRemoteCode: needsRemoteCode(args.files, args.configJson),
    quantization: format === 'gguf' ? quantizationFromName(args.files.find((f) => f.endsWith('.gguf')) ?? args.name) : undefined,
  };
}

/** Lokalen Ordner oder eine Datei inspizieren. Ergibt Dateiliste (relativ), Format und config.json. */
export async function inspectLocal(path: string): Promise<{ files: string[]; configJson?: Record<string, unknown>; sizeBytes: number }> {
  let st;
  try {
    st = await fsp.stat(path);
  } catch {
    throw new Error(`Pfad nicht gefunden: ${path}`);
  }
  if (!st.isDirectory()) {
    return { files: [pathBase(path)], sizeBytes: st.size };
  }
  const files: string[] = [];
  let sizeBytes = 0;
  const walk = async (dir: string, rel: string, depth: number) => {
    if (depth > 4) return;
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(full, r, depth + 1);
      } else if (e.isFile()) {
        files.push(r);
        try {
          const s = await fsp.stat(full);
          sizeBytes += s.size;
        } catch { /* ignore */ }
      }
    }
  };
  await walk(path, '', 0);
  const cfg = files.find((f) => f === 'config.json');
  let configJson: Record<string, unknown> | undefined;
  if (cfg) {
    try {
      configJson = JSON.parse(await fsp.readFile(join(path, cfg), 'utf8')) as Record<string, unknown>;
    } catch { /* ignore */ }
  }
  return { files, configJson, sizeBytes };
}

function pathBase(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
