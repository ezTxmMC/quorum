// Modellierungsaktionen: Ausgabe eines Sprach- oder Coding-Modells in geprüfte Änderungen am Blockbench-Modell umsetzen.
// Das Modell liefert JSON; unbekannte Aktionen, falsche Typen oder zu viele Schritte werden abgelehnt, nicht ausgeführt.
import { FACES, HEX, addAnimation, addCube, addGroup, addKeyframe, cubesOf, findGroup, removeCube, removeGroup, validate, type BbFace, type BbKeyframe, type BbModel } from './bbmodel.ts';

export type Vec3 = [number, number, number];

export type ModelAction =
  | { action: 'add_cube'; name: string; from: Vec3; to: Vec3; group?: string }
  | { action: 'add_group'; name: string; origin?: Vec3; parent?: string }
  | { action: 'remove_cube'; name: string }
  | { action: 'remove_group'; name: string }
  | { action: 'remove_animation'; name: string }
  /** Farbe/Textur: Würfel oder Gruppe (alle Würfel darin), optional nur eine Seite. */
  | { action: 'paint'; name: string; color: string; face?: BbFace; pattern?: 'checker' | 'stripes' | 'noise'; detailColor?: string }
  | { action: 'material'; name: string; roughness: number; metalness: number }
  /** Würfel oder Gruppe drehen (Grad), optional mit Drehpunkt. */
  | { action: 'rotate'; name: string; rotation: Vec3; origin?: Vec3 }
  | { action: 'add_animation'; name: string; length: number; loop?: 'once' | 'loop' | 'hold' }
  | { action: 'add_keyframe'; name: string; group: string; channel: BbKeyframe['channel']; time: number; value: Vec3 };

export interface ParsedPlan {
  actions: ModelAction[];
  done: boolean;
  errors: string[];
}

export const MAX_ACTIONS = 48;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,39}$/;

const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Erstes JSON-Objekt im Text suchen (Modelle packen es oft in Fließtext oder Codeblöcke). */
export function extractJson(text: string): unknown | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Einzelne Aktion prüfen. Gibt die bereinigte Aktion oder einen Fehlergrund zurück. */
function checkAction(raw: unknown): { ok: ModelAction } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'Aktion ist kein Objekt' };
  const a = raw as Record<string, unknown>;
  if (typeof a.name !== 'string' || !NAME.test(a.name)) return { error: `Ungültiger Name: ${String(a.name)}` };
  switch (a.action) {
    case 'add_cube':
      if (!isVec(a.from) || !isVec(a.to)) return { error: `${a.name}: from/to brauchen drei Zahlen` };
      if (a.group !== undefined && (typeof a.group !== 'string' || !NAME.test(a.group))) return { error: `${a.name}: ungültige Gruppe` };
      {
        // Kleine Modelle vertauschen oft Anfang/Ende oder liefern flache Würfel: korrigieren statt verwerfen.
        const from = a.from.map((v, i) => Math.min(v, (a.to as Vec3)[i])) as Vec3;
        const to = a.to.map((v, i) => { const hi = Math.max(v, (a.from as Vec3)[i]); return hi <= from[i] ? from[i] + 1 : hi; }) as Vec3;
        return { ok: { action: 'add_cube', name: a.name, from, to, group: a.group as string | undefined } };
      }
    case 'add_group':
      if (a.origin !== undefined && !isVec(a.origin)) return { error: `${a.name}: origin braucht drei Zahlen` };
      if (a.parent !== undefined && (typeof a.parent !== 'string' || !NAME.test(a.parent))) return { error: `${a.name}: ungültiger Elternknoten` };
      return { ok: { action: 'add_group', name: a.name, origin: a.origin as Vec3 | undefined, parent: a.parent as string | undefined } };
    case 'remove_cube':
      return { ok: { action: 'remove_cube', name: a.name } };
    case 'remove_group':
      return { ok: { action: 'remove_group', name: a.name } };
    case 'remove_animation':
      return { ok: { action: 'remove_animation', name: a.name } };
    case 'paint':
      if (typeof a.color !== 'string' || !HEX.test(a.color)) return { error: `${a.name}: color muss wie #aa8855 aussehen` };
      if (a.face !== undefined && !(FACES as readonly string[]).includes(a.face as string)) return { error: `${a.name}: face muss north, east, south, west, up oder down sein` };
      if (a.pattern !== undefined && !['checker', 'stripes', 'noise'].includes(a.pattern as string)) return { error: `${a.name}: ungültiges Texturmuster` };
      if (a.pattern !== undefined && (typeof a.detailColor !== 'string' || !HEX.test(a.detailColor))) return { error: `${a.name}: detailColor braucht eine Hex-Farbe` };
      if (a.pattern !== undefined && a.face !== undefined) return { error: `${a.name}: Muster gilt für den ganzen Würfel, nicht eine einzelne Seite` };
      return { ok: { action: 'paint', name: a.name, color: a.color, face: a.face as BbFace | undefined, pattern: a.pattern as 'checker' | 'stripes' | 'noise' | undefined, detailColor: a.detailColor as string | undefined } };
    case 'material':
      if (![a.roughness, a.metalness].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return { error: `${a.name}: roughness/metalness müssen zwischen 0 und 1 liegen` };
      return { ok: { action: 'material', name: a.name, roughness: a.roughness as number, metalness: a.metalness as number } };
    case 'rotate':
      if (!isVec(a.rotation)) return { error: `${a.name}: rotation braucht drei Zahlen` };
      if (a.origin !== undefined && !isVec(a.origin)) return { error: `${a.name}: origin braucht drei Zahlen` };
      return { ok: { action: 'rotate', name: a.name, rotation: a.rotation, origin: a.origin as Vec3 | undefined } };
    case 'add_animation':
      if (typeof a.length !== 'number' || !Number.isFinite(a.length) || !(a.length > 0) || a.length > 120) return { error: `${a.name}: length muss zwischen 0 und 120 Sekunden liegen` };
      if (a.loop !== undefined && !['once', 'loop', 'hold'].includes(a.loop as string)) return { error: `${a.name}: loop muss once, loop oder hold sein` };
      return { ok: { action: 'add_animation', name: a.name, length: a.length, loop: a.loop as 'once' | 'loop' | 'hold' | undefined } };
    case 'add_keyframe':
      if (typeof a.group !== 'string' || !NAME.test(a.group)) return { error: `${a.name}: ungültige Gruppe` };
      if (!['rotation', 'position', 'scale'].includes(a.channel as string)) return { error: `${a.name}: channel muss rotation, position oder scale sein` };
      if (typeof a.time !== 'number' || !Number.isFinite(a.time) || !(a.time >= 0)) return { error: `${a.name}: time muss eine Zahl ≥ 0 sein` };
      if (!isVec(a.value)) return { error: `${a.name}: value braucht drei Zahlen` };
      return { ok: { action: 'add_keyframe', name: a.name, group: a.group, channel: a.channel as BbKeyframe['channel'], time: a.time, value: a.value } };
    default:
      return { error: `Unbekannte Aktion: ${String(a.action)}` };
  }
}

/** Ausgabe des Modells in einen Plan umwandeln. Fehlerhafte Einzelaktionen werden gemeldet und übersprungen. */
export function parsePlan(text: string): ParsedPlan {
  const json = extractJson(text) as { actions?: unknown; done?: unknown } | undefined;
  if (!json || !Array.isArray(json.actions)) return { actions: [], done: false, errors: ['Kein JSON mit „actions“ gefunden'] };
  const errors: string[] = [];
  const actions: ModelAction[] = [];
  for (const raw of json.actions.slice(0, MAX_ACTIONS)) {
    const r = checkAction(raw);
    if ('ok' in r) actions.push(r.ok);
    else errors.push(r.error);
  }
  if (json.actions.length > MAX_ACTIONS) errors.push(`Mehr als ${MAX_ACTIONS} Aktionen – der Rest wurde verworfen`);
  return { actions, done: json.done === true, errors };
}

/** Aktionen nacheinander auf das Modell anwenden. Fehler (z. B. unbekannte Gruppe) brechen nicht ab. */
export function applyActions(model: BbModel, actions: ModelAction[]): { applied: number; errors: string[] } {
  const errors: string[] = [];
  let applied = 0;
  for (const a of actions) {
    if (a.action === 'add_cube') {
      if (a.group && !findGroup(model, a.group)) { errors.push(`${a.name}: Gruppe ${a.group} existiert nicht`); continue; }
      const cube = addCube(model, { name: a.name, from: a.from, to: a.to, group: a.group });
      // Nur der fehlerhafte Würfel wird verworfen (z. B. außerhalb der Java-Grenzen), nicht der ganze Plan.
      const bad = validate(model).filter((i) => i.level === 'error' && i.uuid === cube.uuid);
      if (bad.length) { removeCube(model, cube.name); errors.push(...bad.map((i) => i.message)); continue; }
    } else if (a.action === 'add_group') {
      if (a.parent && !findGroup(model, a.parent)) { errors.push(`${a.name}: Elternknoten ${a.parent} existiert nicht`); continue; }
      addGroup(model, { name: a.name, origin: a.origin, parent: a.parent });
    } else if (a.action === 'remove_cube') {
      if (!removeCube(model, a.name)) { errors.push(`${a.name}: nichts zu entfernen`); continue; }
    } else if (a.action === 'remove_group') {
      if (!removeGroup(model, a.name)) { errors.push(`${a.name}: Gruppe existiert nicht`); continue; }
    } else if (a.action === 'remove_animation') {
      const animations = model.animations ?? [];
      if (!animations.some((animation) => animation.name === a.name)) { errors.push(`${a.name}: Animation existiert nicht`); continue; }
      model.animations = animations.filter((animation) => animation.name !== a.name);
    } else if (a.action === 'paint') {
      const group = findGroup(model, a.name);
      const targets = group ? cubesOf(model, group) : model.elements.filter((c) => c.name === a.name);
      if (!targets.length) { errors.push(`${a.name}: weder Würfel noch Gruppe mit Inhalt gefunden`); continue; }
      for (const c of targets) { if (a.face) c.facePaint = { ...c.facePaint, [a.face]: a.color }; else { c.paint = a.color; c.facePaint = undefined; c.pattern = a.pattern ? { type: a.pattern, color: a.detailColor! } : undefined; } }
    } else if (a.action === 'material') {
      const group = findGroup(model, a.name);
      const targets = group ? cubesOf(model, group) : model.elements.filter((c) => c.name === a.name);
      if (!targets.length) { errors.push(`${a.name}: Material-Ziel existiert nicht`); continue; }
      for (const cube of targets) cube.material = { roughness: a.roughness, metalness: a.metalness };
    } else if (a.action === 'rotate') {
      const group = findGroup(model, a.name);
      const cube = model.elements.find((c) => c.name === a.name);
      if (group) { group.rotation = a.rotation; if (a.origin) group.origin = a.origin; }
      else if (cube) { cube.rotation = a.rotation; if (a.origin) cube.origin = a.origin; }
      else { errors.push(`${a.name}: weder Würfel noch Gruppe gefunden`); continue; }
    } else if (a.action === 'add_animation') {
      if ((model.animations ?? []).length >= 8 && !model.animations.some((animation) => animation.name === a.name)) { errors.push('Höchstens 8 Animationen pro Modell'); continue; }
      addAnimation(model, { name: a.name, length: a.length, loop: a.loop });
    } else if (a.action === 'add_keyframe') {
      const err = addKeyframe(model, { animation: a.name, group: a.group, channel: a.channel, time: a.time, value: a.value });
      if (err) { errors.push(err); continue; }
    }
    applied++;
  }
  const issues = validate(model).filter((i) => i.level === 'error');
  for (const i of issues) errors.push(i.message);
  return { applied, errors };
}
