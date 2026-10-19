import type { HubEvent, ProviderId, RunRequest } from '../../shared/types';
import { cancelProjectRun, createProject, readModel, runProject } from './service';
import { blenderScript, findBlender } from './blender';
import type { LoopEvent } from './loop';
import { pythonDir } from './ipc';

const runs = new Map<string, { projectId?: string; cancelled: boolean }>();

export function cancelChatModeling(runId: string): boolean {
  const run = runs.get(runId);
  if (!run) return false;
  run.cancelled = true;
  if (run.projectId) cancelProjectRun(run.projectId);
  return true;
}

export function cancelAllChatModeling(): void { for (const id of runs.keys()) cancelChatModeling(id); }

/** A chat keeps its project across prompts, mode changes and app restarts. */
export async function runChatModeling(req: RunRequest, emit: (event: HubEvent) => void, binaries: Partial<Record<ProviderId, string>>, onProgress?: (projectId: string, event: LoopEvent | { type: 'log'; text: string }) => void): Promise<void> {
  const state: { projectId?: string; cancelled: boolean } = { cancelled: false };
  runs.set(req.runId, state);
  const say = (text: string) => emit({ type: 'text', delta: text + '\n' });
  try {
    const blender = findBlender();
    if (!blender) throw new Error('Blender fehlt. Installiere es unter „3D-Werkzeuge“ neben dem Chat.');
    let projectId = req.modelProjectId;
    if (projectId) await readModel(projectId);
    else projectId = (await createProject(req.prompt.trim().slice(0, 40))).id;
    state.projectId = projectId;
    if (state.cancelled) throw new Error('Abgebrochen');
    emit({ type: 'model_project', projectId });
    say('Ich erstelle oder überarbeite das Modell mit Texturen, Materialien und gewünschten Animationen.');
    const result = await runProject({
      projectId, goal: req.prompt.trim(), engine: { type: 'provider', provider: req.provider, options: req.options }, binaries,
      blender, script: blenderScript(pythonDir()), maxIterations: 6,
      emit: (event) => {
        onProgress?.(projectId, event);
        if (event.type === 'iteration') emit({ type: 'tool_start', id: `model:${req.runId}`, name: 'Modellgenerierung', input: { description: `Runde ${event.n}` } });
        else if (event.type === 'plan' && event.errors.length) say(event.errors.join('; '));
        else if (event.type === 'render') {
          if (event.png) emit({ type: 'image', path: event.png, engine: '3D' });
          if (!event.ok) say(`Vorschau: ${event.error ?? 'fehlgeschlagen'}`);
        }
      },
    });
    emit({ type: 'tool_end', id: `model:${req.runId}`, output: result.reason, isError: !result.ok });
    say(result.ok ? 'Modell, Texturen und Animationen gespeichert. Vorschau und Export findest du neben dem Chat.' : result.reason);
    emit({ type: 'done', ok: result.ok, code: result.ok ? 0 : 1, error: result.ok ? undefined : result.reason });
  } catch (error) {
    const message = (error as Error).message;
    emit({ type: 'done', ok: false, error: message });
  } finally { runs.delete(req.runId); }
}
