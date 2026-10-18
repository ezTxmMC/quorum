// Modell-Manager: Downloads (Fortschritt, Pause, Abbruch, Wiederaufnahme), Import lokaler Modelle und Registrierung.
// Schreibt nur unter `<datenordner>/models/`. Entfernt werden nur Dateien dort – vom Nutzer importierte Ordner bleiben unangetastet.
import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ModelRecord } from '../../shared/models';
import { describeModel, inspectLocal } from './inspect';
import { loadablePath } from '../../shared/selection';
import { downloadFile, modelInfo, resolveUrl, searchModels, type HfModelInfo } from './hf';
import { dataDir } from '../store';

export const modelsDir = () => join(dataDir(), 'models');

export type DownloadStatus = 'running' | 'paused' | 'done' | 'error';

export interface DownloadState {
  id: string;
  repo: string;
  status: DownloadStatus;
  files: { path: string; size: number; received: number }[];
  received: number;
  total: number;
  error?: string;
}

interface Active {
  state: DownloadState;
  ctl?: AbortController;
}

const active = new Map<string, Active>();

/** Stabile ID eines Modells aus Repo und Hauptdatei. */
export function modelId(repo: string, primary: string): string {
  return `${repo}::${primary}`;
}

/**
 * Kennzeichnende Datei einer Auswahl: bei GGUF die Datei selbst, bei Ordnermodellen ein fester Platzhalter.
 * So bleibt die ID eines Repos unabhängig von der Reihenfolge der gewählten Dateien.
 */
export function primaryOf(paths: string[]): string {
  return paths.find((p) => p.endsWith('.gguf')) ?? '(ordner)';
}

/** Nur Pfade innerhalb des Modellordners dürfen gelöscht werden. */
export function isManaged(path: string): boolean {
  const root = resolve(modelsDir());
  const p = resolve(path);
  return p === root || p.startsWith(root + sep);
}

export async function search(query: string, filter?: string) {
  return searchModels(query, { filter });
}

export async function repoInfo(repo: string): Promise<HfModelInfo> {
  return modelInfo(repo);
}

export function downloads(): DownloadState[] {
  return [...active.values()].map((a) => ({ ...a.state, files: a.state.files.map((f) => ({ ...f })) }));
}

type Emit = (s: DownloadState) => void;

/**
 * Startet (oder setzt fort) einen Download der gewählten Dateien. Bereits vollständig geladene Dateien
 * werden übersprungen, Teil-Dateien (`.part`) ab ihrer Größe weitergeladen.
 * Liefert den neuen Registry-Eintrag, sobald alle Dateien da sind.
 */
export async function startDownload(info: HfModelInfo, paths: string[], emit: Emit): Promise<ModelRecord | undefined> {
  if (!paths.length) throw new Error('Keine Datei ausgewählt');
  const id = modelId(info.repo, primaryOf(paths));
  const existing = active.get(id);
  if (existing?.state.status === 'running') throw new Error('Download läuft bereits');

  const base = join(modelsDir(), info.repo.replace('/', '__'));
  const sizes = new Map(info.files.map((f) => [f.path, f.size]));
  const state: DownloadState = {
    id, repo: info.repo, status: 'running', error: undefined,
    files: paths.map((p) => ({ path: p, size: sizes.get(p) ?? 0, received: 0 })),
    received: 0, total: paths.reduce((s, p) => s + (sizes.get(p) ?? 0), 0),
  };
  const ctl = new AbortController();
  active.set(id, { state, ctl });
  const push = () => {
    state.received = state.files.reduce((s, f) => s + f.received, 0);
    emit({ ...state, files: state.files.map((f) => ({ ...f })) });
  };
  push();
  try {
    for (const f of state.files) {
      await downloadFile(resolveUrl(info.repo, f.path, info.revision), join(base, f.path), (p) => {
        f.received = p.received;
        f.size = f.size || p.total;
        push();
      }, ctl.signal, f.size);
      f.received = f.size || f.received;
      push();
    }
    state.status = 'done';
    push();
    active.delete(id);
    return toRecord(info, paths, base, state.total);
  } catch (e) {
    const aborted = ctl.signal.aborted;
    state.status = aborted ? 'paused' : 'error';
    state.error = aborted ? undefined : (e as Error).message;
    push();
    if (!aborted) active.delete(id);
    return undefined;
  }
}

/** Download anhalten. Teil-Dateien bleiben liegen und werden beim nächsten Start fortgesetzt. */
export function pauseDownload(id: string): boolean {
  const a = active.get(id);
  if (!a?.ctl || a.state.status !== 'running') return false;
  a.ctl.abort();
  return true;
}

/** Download abbrechen und Teil-Dateien verwerfen. */
export function cancelDownload(id: string): void {
  const a = active.get(id);
  if (a?.ctl && a.state.status === 'running') a.ctl.abort();
  active.delete(id);
  const base = a ? join(modelsDir(), a.state.repo.replace('/', '__')) : undefined;
  if (base) for (const f of a?.state.files ?? []) rmSync(join(base, f.path + '.part'), { force: true });
}

/** Registry-Eintrag aus Hugging-Face-Metadaten und den heruntergeladenen Dateien. */
function toRecord(info: HfModelInfo, paths: string[], base: string, sizeBytes: number): ModelRecord {
  const desc = describeModel({ source: 'huggingface', name: info.repo, files: paths, pipelineTag: info.pipelineTag, tags: info.tags });
  const primary = paths[0];
  const isGguf = desc.format === 'gguf';
  return {
    id: modelId(info.repo, primaryOf(paths)),
    name: info.repo.split('/').pop() ?? info.repo,
    source: 'huggingface',
    repo: info.repo,
    revision: info.revision,
    license: info.license,
    // GGUF: die Datei selbst (bei geteilten Dateien der erste Teil). Ordnerbasierte Modelle (Safetensors-Pipelines): der Ordner.
    path: isGguf ? join(base, loadablePath(primary)) : base,
    files: paths,
    format: desc.format,
    architecture: desc.architecture,
    capabilities: desc.capabilities,
    quantization: desc.quantization,
    sizeBytes,
    needsRemoteCode: desc.needsRemoteCode,
    // Diffusers-Gewichte in fp16: beim Laden die passende Variante angeben.
    load: paths.some((p) => /\.fp16\.safetensors$/.test(p)) ? { variant: 'fp16' } : undefined,
    addedAt: Date.now(),
  };
}

/** Lokale Datei oder lokalen Ordner registrieren (keine Kopie). */
export function importLocal(path: string): ModelRecord {
  if (!existsSync(path)) throw new Error(`Pfad nicht gefunden: ${path}`);
  const ins = inspectLocal(path);
  const desc = describeModel({ source: 'local', name: path.split(/[\\/]/).pop() ?? path, files: ins.files, configJson: ins.configJson });
  const name = path.split(/[\\/]/).pop() ?? path;
  // Geteilte GGUF: immer den ersten Teil registrieren, llama.cpp findet die übrigen im selben Ordner.
  const dir = path.replace(/[\\/][^\\/]*$/, '');
  const loadable = join(dir, loadablePath(name));
  return {
    id: `local::${loadable}`,
    name,
    source: 'local',
    path: loadable,
    files: ins.files,
    format: desc.format,
    architecture: desc.architecture,
    capabilities: desc.capabilities,
    quantization: desc.quantization,
    sizeBytes: ins.sizeBytes,
    needsRemoteCode: desc.needsRemoteCode,
    addedAt: Date.now(),
  };
}

/** Entfernt die Dateien eines Modells, sofern sie im Modellordner liegen. Liefert false bei Fremdpfaden (dann nur Registry-Eintrag entfernen). */
export function deleteFiles(record: ModelRecord): boolean {
  if (!isManaged(record.path)) return false;
  rmSync(record.path, { recursive: true, force: true });
  return true;
}
