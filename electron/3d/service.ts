// 3D-Projekte: je Projekt ein Ordner im Datenordner mit model.bbmodel, Verlauf früherer Stände, Renderings und Exporten.
// Schreibt nur innerhalb dieses Ordners. Vor jedem Speichern wird der alte Stand im Verlauf abgelegt.
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { ChatEngine } from './llm';
import { chatFor } from './llm';
import { findBlender, blenderScript, pythonDir, runBlenderOps, type BlenderOp, type BlenderResult } from './blender';
import { bakeTexture, newModel, summarize, type BbModel } from '../../shared/bbmodel';
import { encodePng, toBase64 } from '../../shared/png';
import { runModelingLoop, type LoopEvent, type LoopResult } from './loop';
import type { AnimationPreview } from '../../shared/threed';
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
  bakeTexture(model, (w, h, rgba) => toBase64(encodePng(w, h, rgba)));
  await fsp.writeFile(current, JSON.stringify(model, null, 2));
  if (model.textures?.[0]?.source?.startsWith('data:image/')) {
    try {
      const b64 = model.textures[0].source.replace(/^data:image\/\w+;base64,/, '');
      await fsp.writeFile(join(dir, 'palette.png'), Buffer.from(b64, 'base64'));
    } catch { /* texturdatei optional */ }
  }
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
  await fsp.rm(join(projectDir(id), 'animations.json'), { force: true });
  await fsp.rm(join(projectDir(id), 'exports', 'model.glb'), { force: true });
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

export async function animationPreviews(id: string): Promise<AnimationPreview[]> {
  try { return JSON.parse(await fsp.readFile(join(projectDir(id), 'animations.json'), 'utf8')) as AnimationPreview[]; }
  catch { return []; }
}

export async function exportFile(id: string): Promise<string | undefined> {
  const file = join(projectDir(id), 'exports', 'model.glb');
  try { await fsp.access(file); return file; } catch { return undefined; }
}

export interface WorkfileItem {
  id: string;
  name: string;
  path: string;
  type: 'bbmodel' | 'blend' | 'texture' | 'animation' | 'export';
  format?: string;
  size: number;
  updatedAt: number;
}

export async function getWorkfiles(id: string): Promise<WorkfileItem[]> {
  const dir = projectDir(id);
  const items: WorkfileItem[] = [];

  const checkFile = async (name: string, file: string, type: WorkfileItem['type'], format?: string) => {
    try {
      const st = await fsp.stat(file);
      items.push({ id: `${type}-${name}`, name, path: file, type, format, size: st.size, updatedAt: st.mtimeMs });
    } catch { /* Datei existiert nicht */ }
  };

  await checkFile('model.bbmodel', join(dir, 'model.bbmodel'), 'bbmodel', 'bbmodel');
  await checkFile('model.blend', join(dir, 'model.blend'), 'blend', 'blend');
  await checkFile('palette.png', join(dir, 'palette.png'), 'texture', 'png');
  await checkFile('animations.json', join(dir, 'animations.json'), 'animation', 'json');

  const expDir = join(dir, 'exports');
  try {
    const entries = await fsp.readdir(expDir);
    for (const file of entries) {
      const ext = file.split('.').pop() || '';
      await checkFile(file, join(expDir, file), 'export', ext);
    }
  } catch { /* exports noch leer */ }

  return items;
}

export async function exportProject(id: string, format: 'glb' | 'gltf' | 'obj' | 'fbx'): Promise<string> {
  const dir = projectDir(id);
  const blender = findBlender();
  if (!blender) throw new Error('Blender ist nicht installiert (unter 3D → Werkzeuge installieren).');
  const work = join(dir, 'work');
  await fsp.mkdir(join(work, 'exports'), { recursive: true });
  const modelFile = join(dir, 'model.bbmodel');
  const ext = format === 'gltf' ? 'gltf' : format;
  const targetFile = join(work, 'exports', `model.${ext}`);
  const ops: BlenderOp[] = [
    { op: 'bbmodel_to_scene', file: modelFile },
    { op: 'export', format, file: targetFile },
    { op: 'save_blend', file: join(work, 'model.blend') },
  ];
  const r = await runBlenderOps({ bin: blender, script: blenderScript(pythonDir()), workdir: work, ops });
  if (!r.ok) throw new Error(r.error || 'Export fehlgeschlagen');
  await fsp.mkdir(join(dir, 'exports'), { recursive: true });
  const dst = join(dir, 'exports', `model.${ext}`);
  await fsp.copyFile(targetFile, dst);
  try {
    await fsp.copyFile(join(work, 'model.blend'), join(dir, 'model.blend'));
  } catch { /* ignore */ }
  return dst;
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
  if (active.has(opts.projectId)) throw new Error('Für dieses Projekt läuft bereits ein Auftrag.');
  const dir = projectDir(opts.projectId);
  const ctl = new AbortController();
  active.set(opts.projectId, ctl);
  const work = join(dir, 'work');
  const collected: string[] = [];
  const runId = randomUUID().slice(0, 8);
  let completion: Extract<LoopEvent, { type: 'done' }> | undefined;
  let renderedSignature = '';
  try {
    const start = await readModel(opts.projectId);
    const result = await runModelingLoop(start, opts.goal, {
      chat: chatFor(opts.engine, opts.binaries, ctl.signal),
      emit: (event) => { if (event.type === 'done') completion = event; else opts.emit(event); },
      signal: ctl.signal,
      render: async (model, n) => {
        await fsp.mkdir(join(work, 'renders'), { recursive: true });
        bakeTexture(model, (w, h, rgba) => toBase64(encodePng(w, h, rgba)));
        await fsp.writeFile(join(work, 'model.bbmodel'), JSON.stringify(model));
        opts.onIteration?.(join(work, 'model.bbmodel'));
        const ops: BlenderOp[] = [{ op: 'bbmodel_to_scene', file: join(work, 'model.bbmodel') }];
        ops.push({ op: 'pose' });
        for (const view of VIEWS) ops.push({ op: 'render', file: join(work, 'renders', `iter-${n}-${view}.png`), size: 512, view });
        const previews: AnimationPreview[] = [];
        for (const [index, animation] of (model.animations ?? []).entries()) {
          const preview: AnimationPreview = { name: animation.name, length: animation.length, loop: animation.loop, frames: [] };
          for (let frame = 0; frame < 8; frame++) {
            ops.push({ op: 'pose', animation: animation.name, time: animation.length * frame / 7 });
            ops.push({ op: 'render', file: join(work, 'renders', `anim-${n}-${index}-${frame}.png`), size: 256, view: 'iso' });
          }
          previews.push(preview);
        }
        ops.push({ op: 'save_blend', file: join(work, 'model.blend') });
        ops.push({ op: 'export', format: 'glb', file: join(work, 'exports', 'model.glb') });
        const r: BlenderResult = await runBlenderOps({ bin: opts.blender, script: opts.script, workdir: work, ops, signal: ctl.signal });
        if (!r.ok) return { ok: false, error: r.error };
        await fsp.mkdir(join(dir, 'exports'), { recursive: true });
        await fsp.copyFile(join(work, 'exports', 'model.glb'), join(dir, 'exports', 'model.glb'));
        try { await fsp.copyFile(join(work, 'model.blend'), join(dir, 'model.blend')); } catch { /* blend optional */ }
        // Renderings in den Bilderordner kopieren, damit die Oberfläche sie zeigen kann.
        const shown: string[] = [];
        for (const view of VIEWS) {
          const src = join(work, 'renders', `iter-${n}-${view}.png`);
          try {
            await fsp.access(src);
            const dst = join(imagesDir(), `3d-${opts.projectId}-${runId}-${n}-${view}.png`);
            await fsp.copyFile(src, dst);
            shown.push(dst);
          } catch {
            /* Datei existiert noch nicht */
          }
        }
        for (const [index, preview] of previews.entries()) {
          for (let frame = 0; frame < 8; frame++) {
            const dst = join(imagesDir(), `3d-${opts.projectId}-${runId}-${n}-anim-${index}-${frame}.png`);
            await fsp.copyFile(join(work, 'renders', `anim-${n}-${index}-${frame}.png`), dst);
            preview.frames.push(dst);
          }
        }
        await fsp.writeFile(join(dir, 'animations.json'), JSON.stringify(previews));
        collected.push(...shown);
        await fsp.writeFile(join(dir, 'renders.json'), JSON.stringify(collected.slice(-60)));
        renderedSignature = JSON.stringify(model);
        return { ok: true, png: shown[0] };
      },
    }, opts.maxIterations);
    await writeModel(opts.projectId, result.model);
    if (renderedSignature !== JSON.stringify(result.model)) {
      await Promise.all([
        fsp.rm(join(dir, 'animations.json'), { force: true }),
        fsp.rm(join(dir, 'exports', 'model.glb'), { force: true }),
      ]);
    }
    const summary = summarize(result.model);
    opts.emit({ type: 'log', text: `${summary.cubes} Würfel, ${summary.colors ?? 0} Farben und ${summary.animations?.length ?? 0} Animationen gespeichert` });
    opts.emit(completion ?? { type: 'done', ok: result.ok, iterations: result.iterations, reason: result.reason });
    return result;
  } finally {
    active.delete(opts.projectId);
  }
}
