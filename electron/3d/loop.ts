// Iterative Modellierung: Plan erzeugen → prüfen → anwenden → speichern → rendern → Rückmeldung an das Modell.
// Chat und Rendering kommen als Parameter; so bleibt die Schleife ohne Electron testbar.
import type { ChatMessage } from '../../shared/models';
import { describe, validate, type BbModel } from '../../shared/bbmodel';
import { applyActions, parsePlan } from '../../shared/modeling-actions';

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
  'Du bist ein 3D-Modellierer für Blockbench (Würfelmodelle, Koordinaten in Pixeln, 16 Pixel = 1 Block).',
  'Antworte NUR mit JSON in dieser Form:',
  '{"actions":[{"action":"add_cube","name":"kopf","from":[-4,24,-4],"to":[4,32,4],"group":"oberkoerper"},',
  '{"action":"add_group","name":"oberkoerper","origin":[0,12,0]},{"action":"remove_cube","name":"alt"}],"done":false}',
  'Setze "done":true, sobald das Modell das Ziel erfüllt und keine Fehler mehr gemeldet werden.',
  'Erlaubt sind nur add_cube, add_group und remove_cube. Namen: Buchstaben, Ziffern, _ . - Leerzeichen.',
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
    const plan = parsePlan(reply);
    deps.emit({ type: 'plan', n, actions: plan.actions.length, errors: plan.errors });
    const candidate = structuredClone(model);
    const applied = applyActions(candidate, plan.actions);
    const errors = [...plan.errors, ...applied.errors];
    // Nur ein fehlerfreier Stand wird übernommen; sonst bleibt der letzte gültige und die Fehler gehen als Rückmeldung zurück.
    const hard = validate(candidate).filter((i) => i.level === 'error');
    if (hard.length === 0 && applied.applied > 0) model = candidate;
    const render = await deps.render(model, n);
    deps.emit({ type: 'render', n, ok: render.ok, png: render.png, error: render.error });
    feedback = [
      errors.length ? `Fehler: ${errors.join('; ')}` : 'Keine Fehler bei den Änderungen.',
      render.ok ? 'Vorschau erzeugt.' : `Vorschau fehlgeschlagen: ${render.error ?? 'unbekannt'}`,
    ].join('\n');
    if (plan.done && hard.length === 0 && errors.length === 0) {
      deps.emit({ type: 'done', ok: true, iterations: n, reason: 'Modell fertig' });
      return { model, iterations: n, ok: true, reason: 'Modell fertig' };
    }
  }
  deps.emit({ type: 'done', ok: false, iterations: maxIterations, reason: 'Maximale Runden erreicht' });
  return { model, iterations: maxIterations, ok: false, reason: 'Maximale Runden erreicht' };
}
