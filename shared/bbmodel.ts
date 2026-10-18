// Blockbench-Modelle (.bbmodel, JSON): anlegen, Würfel und Gruppen ändern, prüfen, zusammenfassen.
// Reine Funktionen ohne I/O – laufen im Main-Prozess (Agent, Werkzeuge) und in der Oberfläche.
// Koordinaten in Pixeln (16 Pixel = 1 Block), wie Blockbench sie speichert.

export type BbFormat = 'free' | 'java_block';

export interface BbCube {
  uuid: string;
  type: 'cube';
  name: string;
  from: [number, number, number];
  to: [number, number, number];
  origin: [number, number, number];
  rotation?: [number, number, number];
  uv_offset?: [number, number];
  color?: number;
}

export interface BbGroup {
  uuid: string;
  name: string;
  origin: [number, number, number];
  rotation?: [number, number, number];
  children: (BbGroup | string)[];
}

export interface BbModel {
  meta: { format_version: string; model_format: BbFormat; box_uv: boolean };
  name: string;
  resolution: { width: number; height: number };
  elements: BbCube[];
  outliner: (BbGroup | string)[];
  textures: unknown[];
  animations: unknown[];
}

export interface BbIssue {
  level: 'error' | 'warn';
  message: string;
  uuid?: string;
}

export interface BbSummary {
  name: string;
  format: BbFormat;
  cubes: number;
  groups: number;
  bbox?: { min: [number, number, number]; max: [number, number, number] };
  issues: BbIssue[];
}

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function newModel(name: string, format: BbFormat = 'free'): BbModel {
  return {
    meta: { format_version: '4.10', model_format: format, box_uv: format === 'java_block' },
    name,
    resolution: { width: 16, height: 16 },
    elements: [],
    outliner: [],
    textures: [],
    animations: [],
  };
}

/** Würfel anlegen; ohne Gruppe landet er auf oberster Ebene der Gliederung. */
export function addCube(
  model: BbModel,
  spec: { name: string; from: [number, number, number]; to: [number, number, number]; group?: string; uvOffset?: [number, number] },
): BbCube {
  const cube: BbCube = {
    uuid: uid(),
    type: 'cube',
    name: spec.name,
    from: spec.from,
    to: spec.to,
    origin: [0, 0, 0],
    uv_offset: spec.uvOffset ?? [0, 0],
  };
  model.elements.push(cube);
  const parent = spec.group ? findGroup(model, spec.group) : undefined;
  if (parent) parent.children.push(cube.uuid);
  else model.outliner.push(cube.uuid);
  return cube;
}

/** Gruppe (Knochen/Bone für GeckoLib, Teil eines Blocks) anlegen. */
export function addGroup(model: BbModel, spec: { name: string; origin?: [number, number, number]; parent?: string }): BbGroup {
  const group: BbGroup = { uuid: uid(), name: spec.name, origin: spec.origin ?? [0, 0, 0], children: [] };
  const parent = spec.parent ? findGroup(model, spec.parent) : undefined;
  if (parent) parent.children.push(group);
  else model.outliner.push(group);
  return group;
}

/** Gruppe nach Name suchen (rekursiv). */
export function findGroup(model: BbModel, name: string): BbGroup | undefined {
  const walk = (nodes: (BbGroup | string)[]): BbGroup | undefined => {
    for (const n of nodes) {
      if (typeof n === 'string') continue;
      if (n.name === name) return n;
      const hit = walk(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(model.outliner);
}

/** Würfel nach Name entfernen, samt Verweis in der Gliederung. Liefert false, wenn nichts gefunden wurde. */
export function removeCube(model: BbModel, name: string): boolean {
  const cube = model.elements.find((e) => e.name === name);
  if (!cube) return false;
  model.elements = model.elements.filter((e) => e.uuid !== cube.uuid);
  const strip = (nodes: (BbGroup | string)[]): (BbGroup | string)[] =>
    nodes.filter((n) => n !== cube.uuid).map((n) => (typeof n === 'string' ? n : { ...n, children: strip(n.children) }));
  model.outliner = strip(model.outliner);
  return true;
}

/** Prüfung: Geometrie, Namen, Gliederung und Formatgrenzen. */
export function validate(model: BbModel): BbIssue[] {
  const issues: BbIssue[] = [];
  const err = (message: string, uuid?: string) => issues.push({ level: 'error', message, uuid });
  const warn = (message: string, uuid?: string) => issues.push({ level: 'warn', message, uuid });
  const seen = new Set<string>();
  const java = model.meta.model_format === 'java_block';
  for (const c of model.elements) {
    if (seen.has(c.uuid)) err(`Doppelte UUID bei ${c.name}`, c.uuid);
    seen.add(c.uuid);
    if (!c.name.trim()) err('Würfel ohne Namen', c.uuid);
    const nums = [...c.from, ...c.to];
    if (nums.some((v) => !Number.isFinite(v))) { err(`Ungültige Koordinate bei ${c.name}`, c.uuid); continue; }
    for (let i = 0; i < 3; i++) {
      if (c.to[i] <= c.from[i]) err(`${c.name}: Ende muss größer als Anfang sein (Achse ${'xyz'[i]})`, c.uuid);
      if (java && (c.from[i] < -16 || c.to[i] > 32)) err(`${c.name}: Java-Blöcke erlauben Koordinaten von -16 bis 32`, c.uuid);
    }
    const size = c.to.map((v, i) => v - c.from[i]);
    if (size.some((s) => s > 0 && s < 0.01)) warn(`${c.name}: sehr dünner Würfel`, c.uuid);
  }
  const names = new Set<string>();
  const groupNames = new Set<string>();
  const walk = (nodes: (BbGroup | string)[]) => {
    for (const n of nodes) {
      if (typeof n === 'string') {
        if (!model.elements.some((e) => e.uuid === n)) err(`Gliederung verweist auf fehlenden Würfel ${n}`);
        continue;
      }
      if (groupNames.has(n.name)) err(`Doppelter Gruppenname: ${n.name}`, n.uuid);
      groupNames.add(n.name);
      walk(n.children);
    }
  };
  walk(model.outliner);
  for (const c of model.elements) {
    if (names.has(c.name)) warn(`Doppelter Würfelname: ${c.name}`, c.uuid);
    names.add(c.name);
  }
  if (model.elements.length === 0) warn('Modell hat keine Würfel');
  return issues;
}

/** Zusammenfassung für Oberfläche und Agenten-Kontext. */
export function summarize(model: BbModel): BbSummary {
  const issues = validate(model);
  let bbox: BbSummary['bbox'];
  for (const c of model.elements) {
    if (!bbox) bbox = { min: [...c.from], max: [...c.to] };
    else for (let i = 0; i < 3; i++) {
      bbox.min[i] = Math.min(bbox.min[i], c.from[i]);
      bbox.max[i] = Math.max(bbox.max[i], c.to[i]);
    }
  }
  let groups = 0;
  const count = (nodes: (BbGroup | string)[]) => nodes.forEach((n) => { if (typeof n !== 'string') { groups++; count(n.children); } });
  count(model.outliner);
  return { name: model.name, format: model.meta.model_format, cubes: model.elements.length, groups, bbox, issues };
}

/** Textbeschreibung für den Agenten-Kontext (kurz und stabil). */
export function describe(model: BbModel): string {
  const s = summarize(model);
  const lines = [
    `Modell „${s.name}“ (${s.format}), ${s.cubes} Würfel, ${s.groups} Gruppen.`,
    ...model.elements.map((c) => `- ${c.name}: from [${c.from.join(', ')}] to [${c.to.join(', ')}]`),
  ];
  if (s.issues.length) lines.push(...s.issues.map((i) => `${i.level === 'error' ? 'Fehler' : 'Hinweis'}: ${i.message}`));
  return lines.join('\n');
}
