// Hugging-Face-Hub-Client: Suche, Modell-Metadaten und Downloads mit Fortschritt, Abbruch und Wiederaufnahme.
// Downloads landen zuerst als `<datei>.part` und werden erst nach vollständigem Empfang umbenannt.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export { defaultSelection } from '../../shared/selection';

const HUB = 'https://huggingface.co';

export interface HfSearchHit {
  repo: string;
  downloads: number;
  likes: number;
  pipelineTag?: string;
  tags: string[];
  license?: string;
  lastModified?: string;
}

export interface HfFile {
  path: string;
  size: number;
}

export interface HfModelInfo {
  repo: string;
  revision: string;
  pipelineTag?: string;
  tags: string[];
  license?: string;
  files: HfFile[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'User-Agent': 'Quorum/0.1' };
  const token = process.env.HF_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function license(tags: string[]): string | undefined {
  return tags.find((t) => t.startsWith('license:'))?.slice('license:'.length);
}

/** Suche nach Modellen. `filter` z. B. "gguf" oder "text-to-image". */
export async function searchModels(query: string, opts: { filter?: string; limit?: number } = {}): Promise<HfSearchHit[]> {
  const p = new URLSearchParams({ sort: 'downloads', direction: '-1', limit: String(opts.limit ?? 30) });
  if (query.trim()) p.set('search', query.trim());
  if (opts.filter) p.set('filter', opts.filter);
  const res = await fetch(`${HUB}/api/models?${p}`, { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Hugging Face: HTTP ${res.status}`);
  const rows = (await res.json()) as { id: string; downloads?: number; likes?: number; pipeline_tag?: string; tags?: string[]; lastModified?: string }[];
  return rows.map((r) => ({
    repo: r.id,
    downloads: r.downloads ?? 0,
    likes: r.likes ?? 0,
    pipelineTag: r.pipeline_tag,
    tags: r.tags ?? [],
    license: license(r.tags ?? []),
    lastModified: r.lastModified,
  }));
}

/** Metadaten und Dateiliste (mit Größen) eines Repos. */
export async function modelInfo(repo: string): Promise<HfModelInfo> {
  const res = await fetch(`${HUB}/api/models/${repo}?blobs=true`, { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Hugging Face: ${repo} → HTTP ${res.status}`);
  const j = (await res.json()) as { sha?: string; pipeline_tag?: string; tags?: string[]; siblings?: { rfilename: string; size?: number }[] };
  const tags = j.tags ?? [];
  return {
    repo,
    revision: j.sha ?? 'main',
    pipelineTag: j.pipeline_tag,
    tags,
    license: license(tags),
    files: (j.siblings ?? []).map((s) => ({ path: s.rfilename, size: s.size ?? 0 })),
  };
}

/** Sichere Datei-URL: Repo und Pfad werden auf erlaubte Zeichen geprüft (kein Pfad-Traversal). */
export function resolveUrl(repo: string, file: string, revision = 'main'): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Ungültiges Repo: ${repo}`);
  if (file.split('/').some((seg) => seg === '..' || seg === '')) throw new Error(`Ungültiger Dateipfad: ${file}`);
  return `${HUB}/${repo}/resolve/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

export interface DownloadProgress { received: number; total: number }

/**
 * Lädt eine Datei nach `dest`. Ist `<dest>.part` vorhanden, wird ab dieser Größe per HTTP-Range fortgesetzt.
 * Wirft bei Abbruch `AbortError`. Der Teil-Download bleibt erhalten, damit er später fortgesetzt werden kann.
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress: (p: DownloadProgress) => void,
  signal: AbortSignal,
  expectedSize = 0,
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + '.part';
  const have = existsSync(part) ? statSync(part).size : 0;
  if (have > 0 && expectedSize > 0 && have >= expectedSize) {
    renameSync(part, dest);
    onProgress({ received: have, total: have });
    return;
  }
  const res = await fetch(url, {
    headers: { ...headers(), ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
    redirect: 'follow',
    signal,
  });
  if (!res.ok && res.status !== 206) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
  if (!res.body) throw new Error('Download ohne Inhalt');
  // 200 trotz Range-Anfrage: Server liefert alles neu – Teil-Datei verwerfen.
  const resumed = res.status === 206;
  const start = resumed ? have : 0;
  const length = Number(res.headers.get('content-length') ?? 0);
  const total = expectedSize || (resumed ? start + length : length);
  let received = start;
  const counter = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const chunk of src) {
      received += chunk.byteLength;
      onProgress({ received, total });
      yield chunk;
    }
  };
  await pipeline(
    Readable.from(counter(Readable.fromWeb(res.body as never))),
    createWriteStream(part, { flags: resumed ? 'a' : 'w' }),
    { signal },
  );
  renameSync(part, dest);
}
