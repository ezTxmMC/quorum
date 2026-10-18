// 3D-Projekte: je Projekt ein Ordner im Datenordner mit model.bbmodel, Verlauf früherer Stände, Renderings und Exporten.
// Schreibt nur innerhalb dieses Ordners. Vor jedem Speichern wird der alte Stand im Verlauf abgelegt.
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { ChatEngine } from './llm';
import { chatFor } from './llm';
import { runBlenderOps, type BlenderOp, type BlenderResult } from './blender';
import { newModel, summarize, type BbModel } from '../../shared/bbmodel';
import { runModelingLoop, type LoopEvent, type LoopResult } from './loop';
import type { ProviderId } from '../../shared/types';
import { imagesDir } from '../images';
import { dataDir } from '../store';

const HISTORY_LIMIT = 30;
/** Perspektiven für die Prüfung: Vorder-, Rück-, Seiten- und Draufsicht sowie Isometrie. */
export const VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top'] as const;

export interface ProjectInfo {
  id: string;
  name: string;
  updatedAt: number;
}

const root = () => join(dataDir(), '3d');
export const projectDir = (id: string) => {
  if (!/^[\w-]{6,64}$/.test(id)) throw new Error('Ungültige Projekt-ID');
  return join(root(), id);
};

export async function listProjects(): Promise<ProjectInfo[]> {
  try {
    const entries = await fsp.readdir(root());
    const list: ProjectInfo[] = [];
    for (const id of entries) {
      const modelFile = join(root(), id, 'model.bbmodel');
      try {
        const st = await fsp.stat(modelFile);
        const model = await readModel(id);
        list.push({ id, name: model.name, updatedAt: st.mtimeMs });
      } catch {
        /* kein model.bbmodel oder ungültig */
      }
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function createProject(name: string): Promise<ProjectInfo> {
  const id = randomUUID().slice(0, 12);
  const dir = projectDir(id);
  await Promise.all([
    fsp.mkdir(join(dir, 'history'), { recursive: true }),
    fsp.mkdir(join(dir, 'renders'), { recursive: true }),
    fsp.mkdir(join(dir, 'exports'), { recursive: true }),
  ]);
  const model = newModel(name.trim() || 'Neues Modell');
  await fsp.writeFile(join(dir, 'model.bbmodel'), JSON.stringify(model, null, 2));
  return { id, name: model.name, updatedAt: Date.now() };
}

export async function deleteProject(id: string): Promise<void> {
  try {
    await fsp.rm(projectDir(id), { recursive: true, force: true });
  } catch { /* ignore */ }
}

export async function readModel(id: string): Promise<BbModel> {
  const text = await fsp.readFile(join(projectDir(id), 'model.bbmodel'), 'utf8');
  return JSON.parse(text) as BbModel;
}

/** Modell speichern. Der bisherige Stand wird vorher im Verlauf abgelegt (begrenzt auf die letzten Stände). */
export async function writeModel(id: string, model: BbModel): Promise<void> {
  const dir = projectDir(id);
  const current = join(dir, 'model.bbmodel');
  try {
    await fsp.access(current);
    const hist = join(dir, 'history');
    await fsp.mkdir(hist, { recursive: true });
    await fsp.copyFile(current, join(hist, `${Date.now()}-${randomUUID().slice(0, 6)}.bbmodel`));
    const files = (await fsp.readdir(hist)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - HISTORY_LIMIT))) {
      await fsp.rm(join(hist, f), { force: true });
    }
  } catch {
    /* Datei existiert noch nicht */
  }
  await fsp.writeFile(current, JSON.stringify(model, null, 2));
}

export async function history(id: string): Promise<{ file: string; at: number }[]> {
  const hist = join(projectDir(id), 'history');
  try {
    const entries = await fsp.readdir(hist);
    return entries.sort().reverse().map((file) => ({ file, at: Number(file.split('-')[0]) }));
  } catch {
    return [];
  }
}

/** Frühen Stand wiederherstellen (der aktuelle Stand wird dabei selbst im Verlauf gesichert). */
export async function restoreVersion(id: string, file: string): Promise<BbModel> {
  if (!/^[\w.-]+\.bbmodel$/.test(file)) throw new Error('Ungültige Versionsdatei');
  const text = await fsp.readFile(join(projectDir(id), 'history', file), 'utf8');
  const model = JSON.parse(text) as BbModel;
  await writeModel(id, model);
  return model;
}

export async function renders(id: string): Promise<string[]> {
  const p = join(projectDir(id), 'renders.json');
  try {
    const text = await fsp.readFile(p, 'utf8');
    return JSON.parse(text) as string[];
  } catch {
    return [];
  }
}

const active = new Map<string, AbortController>();
export function cancelProjectRun(id: string): boolean {
  const c = active.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

export interface RunOptions {
  projectId: string;
  goal: string;
  engine: ChatEngine;
  binaries: Partial<Record<ProviderId, string>>;
  blender: string;
  script: string;
  maxIterations: number;
  emit: (e: LoopEvent | { type: 'log'; text: string }) => void;
  /** Nach jeder Runde mit dem Pfad des aktuellen Modells (für die Live-Ansicht). */
  onIteration?: (file: string) => void;
}

/** Modellierungsschleife für ein Projekt: Chat mit dem gewählten Modell, Blender für Geometrie und Renderings. */
export async function runProject(opts: RunOptions): Promise<LoopResult> {
  const dir = projectDir(opts.projectId);
  const ctl = new AbortController();
  active.set(opts.projectId, ctl);
  const work = join(dir, 'work');
  const collected: string[] = [];
  try {
    const start = await readModel(opts.projectId);
    const result = await runModelingLoop(start, opts.goal, {
      chat: chatFor(opts.engine, opts.binaries),
      emit: opts.emit,
      signal: ctl.signal,
      render: async (model, n) => {
        await fsp.mkdir(join(work, 'renders'), { recursive: true });
        await fsp.writeFile(join(work, 'model.bbmodel'), JSON.stringify(model));
        opts.onIteration?.(join(work, 'model.bbmodel'));
        const ops: BlenderOp[] = [{ op: 'bbmodel_to_scene', file: join(work, 'model.bbmodel') }];
        for (const view of VIEWS) ops.push({ op: 'render', file: join(work, 'renders', `iter-${n}-${view}.png`), size: 512, view });
        // Export im Arbeitsordner (Blender darf nur dort schreiben); erst danach ins Projekt kopieren.
        ops.push({ op: 'export', format: 'glb', file: join(work, 'exports', 'model.glb') });
        const r: BlenderResult = await runBlenderOps({ bin: opts.blender, script: opts.script, workdir: work, ops, signal: ctl.signal });
        if (!r.ok) return { ok: false, error: r.error };
        await fsp.mkdir(join(dir, 'exports'), { recursive: true });
        await fsp.copyFile(join(work, 'exports', 'model.glb'), join(dir, 'exports', 'model.glb'));
        // Renderings in den Bilderordner kopieren, damit die Oberfläche sie zeigen kann.
        const shown: string[] = [];
        for (const view of VIEWS) {
          const src = join(work, 'renders', `iter-${n}-${view}.png`);
          try {
            await fsp.access(src);
            const dst = join(imagesDir(), `3d-${opts.projectId}-${n}-${view}.png`);
            await fsp.copyFile(src, dst);
            shown.push(dst);
          } catch {
            /* Datei existiert noch nicht */
          }
        }
        collected.push(...shown);
        await fsp.writeFile(join(dir, 'renders.json'), JSON.stringify(collected.slice(-60)));
        return { ok: true, png: shown[0] };
      },
    }, opts.maxIterations);
    await writeModel(opts.projectId, result.model);
    opts.emit({ type: 'log', text: summarize(result.model).cubes + ' Würfel gespeichert' });
    return result;
  } finally {
    active.delete(opts.projectId);
  }
}
