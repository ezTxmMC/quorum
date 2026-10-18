// IPC-Kanäle für Workflows: Verwalten, Versionen, Export/Import, Start, Abbruch und Protokolle.
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { ProviderId } from '../../shared/types';
import { validateWorkflow, type WorkflowNode } from '../../shared/workflow';
import { cancelWorkflowRun, runWorkflow, type RunEvent } from './engine';
import { deleteWorkflow, exportWorkflow, getRun, getWorkflow, importWorkflow, listRuns, listWorkflows, restoreVersion, saveRun, saveWorkflow } from './store';

type Send = (channel: string, payload: unknown) => void;

export function registerWorkflowIpc(send: Send, binaries: () => Partial<Record<ProviderId, string>>): void {
  ipcMain.handle('wf:list', () => listWorkflows());
  ipcMain.handle('wf:get', (_e, id: string) => getWorkflow(id));
  ipcMain.handle('wf:save', (_e, input: { id?: string; name: string; nodes: WorkflowNode[] }) => saveWorkflow(input));
  ipcMain.handle('wf:restore', (_e, id: string, version: number) => restoreVersion(id, version));
  ipcMain.handle('wf:delete', (_e, id: string) => deleteWorkflow(id));
  ipcMain.handle('wf:export', (_e, id: string) => exportWorkflow(id));
  ipcMain.handle('wf:import', (_e, path: string) => importWorkflow(path));
  ipcMain.handle('wf:runs', (_e, workflowId?: string) => listRuns(workflowId));
  ipcMain.handle('wf:run-get', (_e, runId: string) => getRun(runId));

  // Einen Workflow starten. Ungültige Workflows werden nicht ausgeführt; die Meldung nennt die Probleme.
  ipcMain.handle('wf:run', (_e, id: string, inputs?: Record<string, string>) => {
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
  });
  ipcMain.handle('wf:cancel', (_e, runId: string) => cancelWorkflowRun(runId));
}
