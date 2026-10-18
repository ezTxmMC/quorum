// IPC für 3D-Projekte: Verwalten, Modellierungslauf mit einem wählbaren Modell, Verlauf, Blender-Status.
import { app, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ProviderId } from '../../shared/types';
import { describe, summarize } from '../../shared/bbmodel';
import type { ChatEngine } from './llm';
import { blenderScript, blenderVersion, findBlender } from './blender';
import { cancelProjectRun, createProject, deleteProject, history, listProjects, projectDir, readModel, renders, restoreVersion, runProject } from './service';
import { closeViewer, findBlockbench, hasViewer, openViewer, openWindow } from './viewer';
import { dataDir } from '../store';
import { join as joinPath } from 'node:path';

type Send = (channel: string, payload: unknown) => void;

export function pythonDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python') : fileURLToPath(new URL('../python/', import.meta.url));
}

export function register3dIpc(send: Send, binaries: () => Partial<Record<ProviderId, string>>): void {
  ipcMain.handle('3d:list', () => listProjects());
  ipcMain.handle('3d:create', (_e, name: string) => createProject(name));
  ipcMain.handle('3d:delete', (_e, id: string) => { cancelProjectRun(id); deleteProject(id); return true; });
  ipcMain.handle('3d:get', (_e, id: string) => {
    const model = readModel(id);
    return { model, summary: summarize(model), description: describe(model), renders: renders(id), history: history(id) };
  });
  ipcMain.handle('3d:restore', (_e, id: string, file: string) => restoreVersion(id, file));
  ipcMain.handle('3d:cancel', (_e, id: string) => cancelProjectRun(id));

  // Live-Ansicht: Blockbench headless, Bildstrom an die Oberfläche.
  const profile = (id: string) => joinPath(dataDir(), 'blockbench-profile', id);
  const viewerOn = async (id: string, file: string) => {
    const bin = findBlockbench();
    if (!bin) throw new Error('Blockbench nicht gefunden (QUORUM_BLOCKBENCH setzen).');
    await openViewer({
      projectId: id,
      file,
      profileDir: profile(id),
      bin,
      onFrame: (jpeg) => send('3d:frame', { projectId: id, jpeg }),
      onError: (message) => send('3d:frame', { projectId: id, error: message }),
    });
  };
  ipcMain.handle('3d:viewer-open', (_e, id: string) => viewerOn(id, joinPath(projectDir(id), 'model.bbmodel')).then(() => true));
  ipcMain.handle('3d:viewer-close', (_e, id: string) => closeViewer(id));
  ipcMain.handle('3d:viewer-status', (_e, id: string) => hasViewer(id));
  ipcMain.handle('3d:open-window', (_e, id: string) => {
    const bin = findBlockbench();
    if (!bin) throw new Error('Blockbench nicht gefunden (QUORUM_BLOCKBENCH setzen).');
    openWindow(bin, joinPath(projectDir(id), 'model.bbmodel'), joinPath(dataDir(), 'blockbench-window'));
    return true;
  });
  ipcMain.handle('3d:blender', () => {
    const bin = findBlender();
    return { bin, version: bin ? blenderVersion(bin) : undefined, script: blenderScript(pythonDir()) };
  });

  // Modellierungslauf im Hintergrund; Fortschritt kommt als `3d:event`. Ergebnis wird gespeichert, wenn der Lauf endet.
  ipcMain.handle('3d:run', (_e, id: string, goal: string, engine: ChatEngine, maxIterations = 3) => {
    const blender = findBlender();
    if (!blender) throw new Error('Blender nicht gefunden (QUORUM_BLENDER setzen oder Blender installieren).');
    const emit = (event: unknown) => send('3d:event', { projectId: id, event });
    // Läuft eine Live-Ansicht, zeigt sie nach jeder Runde den neuen Stand.
    const onIteration = (file: string) => { if (hasViewer(id)) void viewerOn(id, file).catch((err: Error) => emit({ type: 'log', text: `Live-Ansicht: ${err.message}` })); };
    void runProject({ projectId: id, goal, engine, binaries: binaries(), blender, script: blenderScript(pythonDir()), maxIterations: Math.min(Math.max(1, maxIterations), 6), emit: emit as never, onIteration })
      .catch((err: Error) => emit({ type: 'log', text: `Fehler: ${err.message}` }));
    return true;
  });
}
