// Iterative Modellierung: Plan erzeugen → prüfen → anwenden → speichern → rendern → Rückmeldung an das Modell.
// Chat und Rendering kommen als Parameter; so bleibt die Schleife ohne Electron testbar.
import type { ChatMessage } from '../../shared/models';
import { describe, validate, type BbModel } from '../../shared/bbmodel.ts';
import { applyActions, parsePlan } from '../../shared/modeling-actions.ts';

export interface RenderOutcome {
  ok: boolean;
  /** Pfad des Vorschaubildes, falls gerendert. */
  png?: string;
  error?: string;
}

export interface LoopDeps {
  chat: (messages: ChatMessage[]) => Promise<string>;
  /** Modell speichern und ein Vorschaubild erzeugen. */
  render: (model: BbModel, iteration: number) => Promise<RenderOutcome>;
  emit: (e: LoopEvent) => void;
  signal?: AbortSignal;
}

export type LoopEvent =
  | { type: 'iteration'; n: number }
  | { type: 'plan'; n: number; actions: number; errors: string[] }
  | { type: 'render'; n: number; ok: boolean; png?: string; error?: string }
  | { type: 'done'; ok: boolean; iterations: number; reason: string };

export interface LoopResult {
  model: BbModel;
  iterations: number;
  ok: boolean;
  reason: string;
}

const SYSTEM = [
  'Du bist ein 3D-Modellierer für Blockbench (Würfelmodelle, Koordinaten in Pixeln, 16 Pixel = 1 Block, y ist oben).',
  'Du modellierst, färbst (Textur), drehst und animierst. Antworte NUR mit JSON: {"actions":[...],"done":false}.',
  'Aktionen (höchstens 48 pro Runde):',
  '- {"action":"add_group","name":"bein_vl","origin":[2,6,2]}  Gruppe/Knochen (Drehpunkt origin). Optional "parent".',
  '- {"action":"add_cube","name":"kopf","from":[-4,24,-4],"to":[4,32,4],"group":"kopf_gruppe"}  "to" > "from" in jeder Achse.',
  '- {"action":"remove_cube","name":"alt"}, {"action":"remove_group","name":"alt"} und {"action":"remove_animation","name":"alt"}',
  '- {"action":"paint","name":"kopf","color":"#d98c5f"}  Textur-Farbe für Würfel ODER Gruppe; optional "face":"up|down|north|south|east|west".',
  '- {"action":"material","name":"kopf","roughness":0.8,"metalness":0}  Werte von 0 bis 1, für Würfel oder Gruppe.',
  '- {"action":"rotate","name":"ohr_l","rotation":[0,0,20],"origin":[3,30,0]}  Grad, für Würfel oder Gruppe.',
  '- {"action":"add_animation","name":"walk","length":1,"loop":"loop"}  loop: once | loop | hold.',
  '- {"action":"add_keyframe","name":"walk","group":"bein_vl","channel":"rotation","time":0.5,"value":[30,0,0]}  name = Animation; channel: rotation | position | scale; time in Sekunden. Nur Gruppen lassen sich animieren.',
  'paint kann optional \"pattern\":\"checker|stripes|noise\" und \"detailColor\":\"#445566\" für eine echte gemusterte Textur enthalten. Muster ohne face verwenden.',
  'Höchstens 8 Animationen; Keyframes zwischen 0 und length. Gruppen werden zu beweglichen Knoten im GLB. Animationen nicht leer lassen.',
  'Vorgehen: erst Gruppen und Würfel, dann Farben für alle Teile, dann Animationen, wenn sie gewünscht sind. Gruppiere bewegliche Teile (Beine, Arme, Kopf).',
  'Setze "done":true, sobald Form, Farben und gewünschte Animationen stehen und keine Fehler mehr gemeldet werden.',
  'Namen: Buchstaben, Ziffern, _ . - Leerzeichen. Keine anderen Aktionen verwenden.',
].join('\n');

/**
 * Schleife über höchstens `maxIterations` Runden. Gibt das letzte gültige Modell zurück.
 * Abbruch über das Signal beendet die Schleife nach der aktuellen Runde.
 */
export async function runModelingLoop(start: BbModel, goal: string, deps: LoopDeps, maxIterations = 3): Promise<LoopResult> {
  let model = structuredClone(start);
  let feedback = '';
  for (let n = 1; n <= maxIterations; n++) {
    if (deps.signal?.aborted) return { model, iterations: n - 1, ok: false, reason: 'Abgebrochen' };
    deps.emit({ type: 'iteration', n });
    const user = [
      `Ziel: ${goal}`,
      'Aktueller Stand:',
      describe(model),
      feedback ? `Rückmeldung aus der letzten Runde:\n${feedback}` : '',
      'Gib jetzt die nächsten Änderungen als JSON aus.',
    ].filter(Boolean).join('\n\n');
    const reply = await deps.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }]);
    if (deps.signal?.aborted) return { model, iterations: n - 1, ok: false, reason: 'Abgebrochen' };
    const plan = parsePlan(reply);
    const candidate = structuredClone(model);
    const applied = applyActions(candidate, plan.actions);
    const errors = [...plan.errors, ...applied.errors];
    for (const animation of candidate.animations ?? []) {
      if (!Object.values(animation.animators).some((animator) => animator.keyframes.length > 0)) errors.push(`Animation ${animation.name} hat noch keine Keyframes.`);
    }
    deps.emit({ type: 'plan', n, actions: plan.actions.length, errors });
    // Nur ein fehlerfreier Stand wird übernommen; sonst bleibt der letzte gültige und die Fehler gehen als Rückmeldung zurück.
    const hard = validate(candidate).filter((i) => i.level === 'error');
    if (hard.length === 0 && applied.applied > 0) model = candidate;
    const render = await deps.render(model, n);
    deps.emit({ type: 'render', n, ok: render.ok, png: render.png, error: render.error });
    feedback = [
      errors.length ? `Fehler: ${errors.join('; ')}` : 'Keine Fehler bei den Änderungen.',
      render.ok ? 'Vorschau erzeugt.' : `Vorschau fehlgeschlagen: ${render.error ?? 'unbekannt'}`,
    ].join('\n');
    if (plan.done && render.ok && hard.length === 0 && errors.length === 0) {
      deps.emit({ type: 'done', ok: true, iterations: n, reason: 'Modell fertig' });
      return { model, iterations: n, ok: true, reason: 'Modell fertig' };
    }
  }
  deps.emit({ type: 'done', ok: false, iterations: maxIterations, reason: 'Maximale Runden erreicht' });
  return { model, iterations: maxIterations, ok: false, reason: 'Maximale Runden erreicht' };
}
