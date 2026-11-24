import { create } from 'zustand';
import type { LoopEvent } from '@shared/contracts/threed';
import { hub } from './api';

export type RunEntryKind = 'prompt' | 'round' | 'step' | 'warning' | 'success' | 'failure';

export interface RunEntry {
  id: number;
  kind: RunEntryKind;
  text: string;
  /** Erläuterung zum Eintrag, z. B. die erste Fehlermeldung einer Runde. */
  detail?: string;
  /** Nur bei `round`: Nummer der Runde, Zahl der Änderungen und der gemeldeten Fehler. */
  round?: { n: number; actions: number; errors: number };
}

export interface ProjectRun {
  running: boolean;
  stopping: boolean;
  iteration: number;
  maxIterations: number;
  entries: RunEntry[];
  /** Zählt hoch, sobald sich das Modell geändert haben kann; Ansichten laden daraufhin neu. */
  revision: number;
}

type ThreeDEvent = LoopEvent | { type: 'log'; text: string };

interface ThreeDRuns {
  projects: Record<string, ProjectRun>;
  begin: (projectId: string, prompt: string, maxIterations: number) => void;
  fail: (projectId: string, reason: string) => void;
  stopping: (projectId: string) => void;
  adopt: (projectId: string, running: boolean) => void;
  apply: (projectId: string, event: ThreeDEvent) => void;
}

const MAX_ENTRIES = 80;
const EMPTY: ProjectRun = { running: false, stopping: false, iteration: 0, maxIterations: 0, entries: [], revision: 0 };
let nextEntryId = 1;

function withEntry(run: ProjectRun, kind: RunEntryKind, text: string, detail?: string, round?: RunEntry['round']): RunEntry[] {
  return [...run.entries, { id: nextEntryId++, kind, text, detail, round }].slice(-MAX_ENTRIES);
}

function reduce(run: ProjectRun, event: ThreeDEvent): ProjectRun {
  if (event.type === 'iteration') {
    return { ...run, running: true, iteration: event.n };
  }
  if (event.type === 'plan') {
    const round = { n: event.n, actions: event.actions, errors: event.errors.length };
    return { ...run, entries: withEntry(run, 'round', '', event.errors[0], round) };
  }
  if (event.type === 'render') {
    const entries = event.ok ? run.entries : withEntry(run, 'warning', 'Vorschau fehlgeschlagen', event.error);
    return { ...run, entries, revision: run.revision + 1 };
  }
  if (event.type === 'log') {
    return { ...run, entries: withEntry(run, 'step', event.text) };
  }
  return {
    ...run,
    running: false,
    stopping: false,
    entries: withEntry(run, event.ok ? 'success' : 'failure', event.reason || (event.ok ? 'Fertig' : 'Abgebrochen')),
    revision: run.revision + 1,
  };
}

/**
 * Läufe der 3D-Generierung je Projekt. Der Stand liegt außerhalb der Seite, damit ein Lauf weiter verfolgt wird,
 * während ein anderes Projekt oder ein anderer Arbeitsbereich offen ist.
 */
export const useThreeDRuns = create<ThreeDRuns>((set) => {
  const patch = (projectId: string, change: (run: ProjectRun) => ProjectRun) =>
    set((state) => ({ projects: { ...state.projects, [projectId]: change(state.projects[projectId] ?? EMPTY) } }));
  return {
    projects: {},
    begin(projectId, prompt, maxIterations) {
      patch(projectId, (run) => ({ ...run, running: true, stopping: false, iteration: 0, maxIterations, entries: withEntry(run, 'prompt', prompt) }));
    },
    fail(projectId, reason) {
      patch(projectId, (run) => ({ ...run, running: false, stopping: false, entries: withEntry(run, 'failure', reason) }));
    },
    stopping(projectId) {
      patch(projectId, (run) => ({ ...run, stopping: true }));
    },
    adopt(projectId, running) {
      patch(projectId, (run) => (run.running === running ? run : { ...run, running, stopping: false }));
    },
    apply(projectId, event) {
      patch(projectId, (run) => reduce(run, event));
    },
  };
});

export const idleRun = EMPTY;

hub.onThreedEvent((envelope) => useThreeDRuns.getState().apply(envelope.projectId, envelope.event));
