// Modellierungsaktionen: Ausgabe eines Sprach- oder Coding-Modells in geprüfte Änderungen am Blockbench-Modell umsetzen.
// Das Modell liefert JSON; unbekannte Aktionen, falsche Typen oder zu viele Schritte werden abgelehnt, nicht ausgeführt.
import { addCube, addGroup, findGroup, removeCube, validate, type BbModel } from './bbmodel';

export type Vec3 = [number, number, number];

export type ModelAction =
  | { action: 'add_cube'; name: string; from: Vec3; to: Vec3; group?: string }
  | { action: 'add_group'; name: string; origin?: Vec3; parent?: string }
  | { action: 'remove_cube'; name: string };

export interface ParsedPlan {
  actions: ModelAction[];
  done: boolean;
  errors: string[];
}

export const MAX_ACTIONS = 24;
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
    }
    applied++;
  }
  const issues = validate(model).filter((i) => i.level === 'error');
  for (const i of issues) errors.push(i.message);
  return { applied, errors };
}
