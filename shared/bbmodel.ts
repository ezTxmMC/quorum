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
  /** Farbe des Würfels (#rrggbb). Beim Speichern wird daraus eine Paletten-Textur mit UVs gebacken. */
  paint?: string;
  pattern?: { type: 'checker' | 'stripes' | 'noise'; color: string };
  material?: { roughness: number; metalness: number };
  /** Abweichende Farben einzelner Seiten. */
  facePaint?: Partial<Record<BbFace, string>>;
  /** Von der Textur-Bäckerei erzeugt: Seiten mit UV-Ausschnitt in der Palette. */
  faces?: Record<string, { uv: [number, number, number, number]; texture: number }>;
}

export const FACES = ['north', 'east', 'south', 'west', 'up', 'down'] as const;
export type BbFace = (typeof FACES)[number];

export interface BbKeyframe {
  channel: 'rotation' | 'position' | 'scale';
  time: number;
  data_points: { x: number; y: number; z: number }[];
  interpolation?: 'linear' | 'catmullrom';
}

export interface BbAnimation {
  uuid: string;
  name: string;
  loop: 'once' | 'loop' | 'hold';
  override: boolean;
  length: number;
  animators: Record<string, { name: string; type: 'bone'; keyframes: BbKeyframe[] }>;
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
  textures: { uuid: string; name: string; source: string; width: number; height: number; [key: string]: unknown }[];
  animations: BbAnimation[];
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
  /** Anzahl verschiedener Farben (Textur-Palette). */
  colors?: number;
  animations?: { name: string; length: number }[];
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
  for (const a of model.animations ?? []) {
    if (!Number.isFinite(a.length) || !(a.length > 0)) err(`Animation ${a.name}: Länge muss größer als 0 sein`);
    for (const an of Object.values(a.animators)) for (const k of an.keyframes) if (!Number.isFinite(k.time) || k.time < 0 || k.time > a.length) err(`Animation ${a.name}: Keyframe bei ${k.time}s liegt außerhalb der Länge`);
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
  const painted = new Set([...model.elements.flatMap((c) => [c.paint, c.pattern?.color, ...Object.values(c.facePaint ?? {})])].filter(Boolean)).size;
  return { name: model.name, format: model.meta.model_format, cubes: model.elements.length, groups, bbox, issues, colors: painted, animations: (model.animations ?? []).map((a) => ({ name: a.name, length: a.length })) };
}

/** Textbeschreibung für den Agenten-Kontext (kurz und stabil). */
export function describe(model: BbModel): string {
  const s = summarize(model);
  const lines = [
    `Modell „${s.name}“ (${s.format}), ${s.cubes} Würfel, ${s.groups} Gruppen.`,
    ...model.elements.map((c) => `- ${c.name}: from [${c.from.join(', ')}] to [${c.to.join(', ')}]${c.rotation ? ` rotation [${c.rotation.join(', ')}]` : ''}${c.paint ? ` farbe ${c.paint}` : ''}${c.pattern ? ` Muster ${c.pattern.type}/${c.pattern.color}` : ''}${c.material ? ` Material ${JSON.stringify(c.material)}` : ''}`),
  ];
  const groups: string[] = [];
  const walk = (nodes: (BbGroup | string)[]) => nodes.forEach((n) => { if (typeof n !== 'string') { groups.push(`${n.name} origin [${n.origin.join(', ')}]${n.rotation ? ` rotation [${n.rotation.join(', ')}]` : ''}`); walk(n.children); } });
  walk(model.outliner);
  if (groups.length) lines.push(`Gruppen: ${groups.join(', ')}`);
  for (const a of model.animations ?? []) {
    const keys = Object.values(a.animators).reduce((n, an) => n + an.keyframes.length, 0);
    lines.push(`Animation „${a.name}“ (${a.length}s, ${a.loop}, ${keys} Keyframes): ${JSON.stringify(a.animators)}`);
  }
  if (s.issues.length) lines.push(...s.issues.map((i) => `${i.level === 'error' ? 'Fehler' : 'Hinweis'}: ${i.message}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------------
// Texturen und Animationen

export const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#b4b4b4';
const hexRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Alle Würfel unterhalb eines Gruppen-Knotens (rekursiv). */
export function cubesOf(model: BbModel, node: BbGroup): BbCube[] {
  const out: BbCube[] = [];
  const walk = (n: BbGroup | string) => {
    if (typeof n === 'string') { const c = model.elements.find((e) => e.uuid === n); if (c) out.push(c); }
    else n.children.forEach(walk);
  };
  walk(node);
  return out;
}

/** Gruppe samt Inhalt entfernen. */
export function removeGroup(model: BbModel, name: string): boolean {
  const g = findGroup(model, name);
  if (!g) return false;
  const gone = new Set(cubesOf(model, g).map((c) => c.uuid));
  const bones = new Set<string>();
  const collect = (node: BbGroup) => { bones.add(node.uuid); for (const child of node.children) if (typeof child !== 'string') collect(child); };
  collect(g);
  model.elements = model.elements.filter((e) => !gone.has(e.uuid));
  const strip = (nodes: (BbGroup | string)[]): (BbGroup | string)[] =>
    nodes.filter((n) => n !== g && !(typeof n === 'string' && gone.has(n))).map((n) => (typeof n === 'string' ? n : { ...n, children: strip(n.children) }));
  model.outliner = strip(model.outliner);
  for (const a of model.animations ?? []) for (const id of bones) delete a.animators[id];
  return true;
}

/**
 * Backt aus den Farben der Würfel eine Paletten-Textur (je Farbe ein Feld) und setzt UVs auf jede Seite.
 * Ergebnis ist eine normale Blockbench-Textur (eingebettetes PNG): in Blockbench sichtbar und dort weiter bemalbar.
 */
export function bakeTexture(model: BbModel, encode: (w: number, h: number, rgba: Uint8Array) => string): void {
  if (!model.elements.length) { model.textures = []; return; }
  const tiles = new Map<string, { color: string; pattern?: BbCube['pattern'] }>();
  const tile = (cube: BbCube, face: BbFace) => {
    const color = (cube.facePaint?.[face] ?? cube.paint ?? DEFAULT_COLOR).toLowerCase();
    const pattern = cube.facePaint?.[face] ? undefined : cube.pattern;
    const key = [color, pattern?.type, pattern?.color.toLowerCase()].join(':');
    if (!tiles.has(key)) tiles.set(key, { color, pattern });
    return key;
  };
  for (const cube of model.elements) for (const face of FACES) tile(cube, face);
  const cell = 8;
  let size = 16;
  while ((size / cell) ** 2 < tiles.size) size *= 2;
  const per = size / cell;
  const rgba = new Uint8Array(size * size * 4);
  const keys = [...tiles.keys()];
  keys.forEach((key, i) => {
    const { color, pattern } = tiles.get(key)!;
    const base = hexRgb(color), detail = hexRgb(pattern?.color ?? color);
    const ox = (i % per) * cell, oy = Math.floor(i / per) * cell;
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
      const alternate = pattern?.type === 'checker' ? (Math.floor(x / 2) + Math.floor(y / 2)) % 2
        : pattern?.type === 'stripes' ? Math.floor(x / 2) % 2
        : pattern?.type === 'noise' ? ((x * 31 + y * 17 + x * y * 13) % 11) < 4 : false;
      rgba.set([...(alternate ? detail : base), 255], ((oy + y) * size + ox + x) * 4);
    }
  });
  for (const cube of model.elements) {
    cube.faces = Object.fromEntries(FACES.map((face) => {
      const i = keys.indexOf(tile(cube, face));
      const x = (i % per) * cell, y = Math.floor(i / per) * cell;
      return [face, { uv: [x, y, x + cell, y + cell], texture: 0 }];
    }));
  }
  model.meta.box_uv = false;
  model.resolution = { width: size, height: size };
  model.textures = [{
    path: '', name: 'palette.png', folder: '', namespace: '', id: '0', particle: false, render_mode: 'default', render_sides: 'auto',
    frame_time: 1, frame_order_type: 'loop', frame_order: '', frame_interpolate: false, visible: true, internal: true, saved: true,
    uuid: model.textures[0]?.uuid ?? uid(), width: size, height: size, uv_width: size, uv_height: size, source: `data:image/png;base64,${encode(size, size, rgba)}`,
  }];
}

/** Animation anlegen (oder Länge/Schleife einer vorhandenen ändern). */
export function addAnimation(model: BbModel, spec: { name: string; length: number; loop?: BbAnimation['loop'] }): BbAnimation {
  model.animations ??= [];
  const existing = model.animations.find((a) => a.name === spec.name);
  if (existing) { existing.length = spec.length; if (spec.loop) existing.loop = spec.loop; return existing; }
  const anim: BbAnimation = { uuid: uid(), name: spec.name, loop: spec.loop ?? 'loop', override: false, length: spec.length, animators: {} };
  model.animations.push(anim);
  return anim;
}

/** Keyframe für eine Gruppe setzen (gleicher Kanal und Zeitpunkt wird ersetzt). */
export function addKeyframe(model: BbModel, spec: { animation: string; group: string; channel: BbKeyframe['channel']; time: number; value: [number, number, number] }): string | undefined {
  const anim = (model.animations ?? []).find((a) => a.name === spec.animation);
  if (!anim) return `Animation ${spec.animation} existiert nicht`;
  if (!Number.isFinite(spec.time) || spec.time < 0 || spec.time > anim.length) return `Keyframe muss innerhalb von 0 bis ${anim.length}s liegen`;
  const group = findGroup(model, spec.group);
  if (!group) return `Gruppe ${spec.group} existiert nicht`;
  const animator = (anim.animators[group.uuid] ??= { name: group.name, type: 'bone', keyframes: [] });
  animator.keyframes = animator.keyframes.filter((k) => !(k.channel === spec.channel && k.time === spec.time));
  animator.keyframes.push({ channel: spec.channel, time: spec.time, data_points: [{ x: spec.value[0], y: spec.value[1], z: spec.value[2] }], interpolation: 'linear' });
  animator.keyframes.sort((a, b) => a.time - b.time);
  return undefined;
}
