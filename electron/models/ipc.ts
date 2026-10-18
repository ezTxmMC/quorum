// IPC-Kanäle für Modellverwaltung, Runtimes und Chat mit lokalen Modellen.
import { app, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import type { ChatMessage, ModelRecord } from '../../shared/models';
import type { ImageParams } from '../runtimes/adapter';
import { pyStatus, setupPyEnv } from '../runtimes/pyenv';
import { diffusersAdapter, setPyDataRoot, setPythonRoot, transformersAdapter } from '../runtimes/pyworker';
import { llamaCppAdapter, setRuntimePidFile } from '../runtimes/llamacpp';
import { dataDir } from '../store';
import { join } from 'node:path';
import { registerRuntime } from '../runtimes/adapter';
import { scheduler } from '../runtimes/scheduler';
import { runLocalChat, runLocalImage } from './chat';
import { snapshot } from '../runtimes/resources';
import { cancelDownload, deleteFiles, downloads, importLocal, modelId, pauseDownload, primaryOf, repoInfo, search, startDownload } from './manager';
import { getModel, listModels, patchModel, putModel, removeModel } from './registry';

type Send = (channel: string, payload: unknown) => void;

/** Python-Ordner der App: neben dem Build (Entwicklung) bzw. in den Zusatzressourcen (installiert). */
function pythonDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python') : fileURLToPath(new URL('../python/', import.meta.url));
}

export function registerModelIpc(send: Send): void {
  registerRuntime(llamaCppAdapter);
  registerRuntime(transformersAdapter);
  registerRuntime(diffusersAdapter);
  setRuntimePidFile(join(dataDir(), 'runtimes.json'));
  setPythonRoot(pythonDir());
  setPyDataRoot(() => dataDir());
  scheduler.setListener((e) => send('models:event', e));

  ipcMain.handle('models:list', () => listModels());
  ipcMain.handle('models:search', (_e, q: string, filter?: string) => search(q, filter));
  ipcMain.handle('models:info', (_e, repo: string) => repoInfo(repo));
  ipcMain.handle('models:downloads', () => downloads());
  ipcMain.handle('models:runtime', () => llamaCppAdapter.detect());
  ipcMain.handle('models:loaded', () => scheduler.list());
  ipcMain.handle('models:resources', () => snapshot());

  ipcMain.handle('models:download', async (_e, repo: string, files: string[]) => {
    const id = modelId(repo, primaryOf(files));
    if (downloads().some((d) => d.id === id && d.status === 'running')) throw new Error('Download läuft bereits');
    const info = await repoInfo(repo);
    // Läuft im Hintergrund; Fortschritt kommt als Ereignis, das fertige Modell wird registriert.
    void startDownload(info, files, (state) => send('models:download', state))
      .then((record) => { if (record) { putModel(record); send('models:registry', null); } })
      .catch((err: Error) => send('models:download', { id, status: 'error', error: err.message }));
    return id;
  });
  ipcMain.handle('models:pause', (_e, id: string) => pauseDownload(id));
  ipcMain.handle('models:cancel', (_e, id: string) => cancelDownload(id));

  ipcMain.handle('models:import', async (_e, path: string) => {
    const record = await importLocal(path);
    putModel(record);
    return record;
  });

  ipcMain.handle('models:remove', async (_e, id: string) => {
    await scheduler.unload(id);
    const record = removeModel(id);
    if (record) deleteFiles(record);
    return !!record;
  });

  ipcMain.handle('models:config', (_e, id: string, load: ModelRecord['load']) => patchModel(id, { load }));

  ipcMain.handle('models:load', async (_e, id: string, priority = 0) => {
    const record = getModel(id);
    if (!record) throw new Error(`Modell nicht gefunden: ${id}`);
    const lease = await scheduler.acquire(record, priority);
    lease.release();
    return true;
  });
  ipcMain.handle('models:unload', (_e, id: string) => scheduler.unload(id));

  // Chat mit einem lokalen Modell: Antwort kommt als Textereignisse auf `models:chat-event`.
  // Python-Umgebung für Transformers und Diffusers.
  const requirements = () => join(pythonDir(), 'requirements.txt');
  ipcMain.handle('py:status', () => pyStatus(dataDir(), requirements()));
  ipcMain.handle('py:setup', async () => {
    try {
      return { ok: true, status: await setupPyEnv(dataDir(), requirements(), (line) => send('py:log', line)) };
    } catch (err) {
      send('py:log', (err as Error).message);
      return { ok: false, error: (err as Error).message };
    }
  });

  // Bild mit einem Diffusers-Modell erzeugen. Ergebnis: Pfad der PNG im Bilderordner.
  ipcMain.handle('models:image', (_e, runId: string, id: string, params: ImageParams) => runLocalImage({ runId, modelId: id, params }));

  ipcMain.handle('models:chat', (_e, runId: string, id: string, messages: ChatMessage[]) => {
    const out = (event: unknown) => send('models:chat-event', { runId, event });
    void runLocalChat({ runId, modelId: id, messages, onDelta: (delta) => out({ type: 'text', delta }) })
      .then((r) => out({ type: 'done', ok: r.ok, code: r.ok ? 0 : undefined, error: r.error }));
  });
}
