// Modellieren direkt aus dem Chat: erkennt eine Modellier-Absicht im normalen Satz und startet die 3D-Schleife.
// Fortschritt läuft als Text in den Chat, das Ergebnis als Projekt, das die Ansicht rechts daneben zeigt.
import type { HubEvent, ProviderId, RunRequest } from '../../shared/types';
import { createProject, runProject } from './service';
import { blenderScript, findBlender } from './blender';
import type { ChatEngine } from './llm';
import { pythonDir } from './ipc';

// Absicht: ausdrücklich Blender/Blockbench/3D genannt, oder „modell(ier)…“ zusammen mit einer Aufforderung.
const INTENT = /\b(blockbench|blender|3d-?modell\w*)\b|\b(modell(ier\w*)?\s+(mir|mal|das|den|die|einen|eine|ein)|mach\w*\s+mir\s+(mal\s+)?(das|den|die|einen|eine|ein)\s+\w*\s*(modell|würfel|stuhl|tisch))/i;

export function isModelingIntent(text: string): boolean {
  return INTENT.test(text);
}

/** Startet die Modellierung für eine Chat-Anfrage. Fortschritt und Ergebnis gehen als Chat-Text zurück. */
export async function runChatModeling(req: RunRequest, emit: (e: HubEvent) => void, binaries: Partial<Record<ProviderId, string>>): Promise<{ projectId?: string }> {
  const say = (text: string) => emit({ type: 'text', delta: text + '\n' });
  let engine: ChatEngine | undefined;
  if (req.provider === 'local' && req.options.model) engine = { type: 'local', modelId: req.options.model };
  else if (req.provider === 'claude') engine = { type: 'cli', provider: 'claude' };
  if (!engine) {
    say('Zum Modellieren brauche ich ein lokales Modell oder Claude als Anbieter dieses Chats.');
    emit({ type: 'done', ok: false, error: 'Kein passender Anbieter' });
    return {};
  }
  const blender = findBlender();
  if (!blender) {
    say('Blender ist nicht installiert. Setze QUORUM_BLENDER oder installiere Blender.');
    emit({ type: 'done', ok: false, error: 'Blender fehlt' });
    return {};
  }
  const goal = req.prompt.trim();
  const project = await createProject(goal.slice(0, 40));
  say(`Ich modelliere das – Projekt „${project.name}“. Ich melde mich mit jedem Schritt.`);
  let cubes = 0;
  await runProject({
    projectId: project.id,
    goal,
    engine,
    binaries,
    blender,
    script: blenderScript(pythonDir()),
    maxIterations: 3,
    emit: (e) => {
      if (e.type === 'iteration') say(`Runde ${e.n} …`);
      else if (e.type === 'plan') say(`Plan: ${e.actions} Änderungen${e.errors.length ? ` (Hinweis: ${e.errors[0]})` : ''}`);
      else if (e.type === 'render') say(e.ok ? 'Vorschau aktualisiert.' : `Vorschau nicht möglich: ${e.error ?? ''}`);
      else if (e.type === 'done') say(e.ok ? 'Fertig.' : `Stopp: ${e.reason}.`);
      else if (e.type === 'log') { const m = /^(\d+) Würfel/.exec(e.text); if (m) cubes = Number(m[1]); }
    },
  });
  say(`Modell gespeichert: ${cubes} Würfel. Rechts siehst du es; mit „In Blockbench öffnen“ kannst du es dort weiterbearbeiten.`);
  emit({ type: 'done', ok: true, code: 0 });
  return { projectId: project.id };
}
