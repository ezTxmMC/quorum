// IPC-Kanäle für Workflows: Verwalten, Versionen, Export/Import, Start, Abbruch und Protokolle.
import { randomUUID } from 'node:crypto';
import type { ProviderId } from '../../shared/types';
import { validateWorkflow, type WorkflowNode } from '../../shared/workflow';
import { cancelWorkflowRun, runWorkflow, type RunEvent } from './engine';
import { deleteWorkflow, exportWorkflow, getRun, getWorkflow, importWorkflow, listRuns, listWorkflows, restoreVersion, saveRun, saveWorkflow } from './store';

type Send = (channel: string, payload: unknown) => void;

export function openWorkflowRoutes(send: Send, binaries: () => Partial<Record<ProviderId, string>>) {
  return {
  'wf:list': () => listWorkflows(),
  'wf:get': (id: string) => getWorkflow(id),
  'wf:save': (input: { id?: string; name: string; nodes: WorkflowNode[] }) => saveWorkflow(input),
  'wf:restore': (id: string, version: number) => restoreVersion(id, version),
  'wf:delete': (id: string) => deleteWorkflow(id),
  'wf:export': (id: string) => exportWorkflow(id),
  'wf:import': (path: string) => importWorkflow(path),
  'wf:runs': (workflowId?: string) => listRuns(workflowId),
  'wf:run-get': (runId: string) => getRun(runId),

  // Einen Workflow starten. Ungültige Workflows werden nicht ausgeführt; die Meldung nennt die Probleme.
  'wf:run': (id: string, inputs?: Record<string, string>) => {
    const wf = getWorkflow(id);
    if (!wf) throw new Error('Workflow nicht gefunden');
    const issues = validateWorkflow(wf.nodes);
    if (issues.length) throw new Error(issues.map((i) => i.message).join(' '));
    const runId = randomUUID();
    const emit = (e: RunEvent) => {
      if (e.type === 'run') saveRun(e.record);
      send('wf:event', e);
    };
    // Läuft im Hintergrund; Fortschritt kommt als Ereignisse, das Ergebnis wird protokolliert.
    void runWorkflow(wf, { runId, inputs, emit, binaries: binaries(), resolve: getWorkflow }).catch((err: Error) => {
      emit({ type: 'run', runId, status: 'failed', record: { id: runId, workflowId: wf.id, workflowName: wf.name, workflowVersion: wf.version, status: 'failed', startedAt: Date.now(), endedAt: Date.now(), nodes: {}, artifacts: [{ nodeId: '', label: err.message }] } });
    });
    return runId;
  },
  'wf:cancel': (runId: string) => cancelWorkflowRun(runId),
  };
}
