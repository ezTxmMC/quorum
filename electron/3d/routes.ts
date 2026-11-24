import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { describe, summarize } from '../../shared/bbmodel';
import type { ToolId } from '../../shared/threed';
import type { ProviderId } from '../../shared/types';
import { dataDir } from '../store';
import { blenderScript, blenderVersion, findBlender, pythonDir } from './blender';
import type { ChatEngine } from './llm';
import {
  animationPreviews,
  cancelProjectRun,
  createProject,
  deleteProject,
  exportFile,
  exportProject,
  getWorkfiles,
  history,
  listProjects,
  projectDir,
  readModel,
  renders,
  restoreVersion,
  runProject,
} from './service';
import { cancelInstall, installTool, setMcp, toolStatus, uninstallTool } from './tools';
import { closeViewer, findBlockbench, hasViewer, openBlenderWindow, openViewer, openWindow } from './viewer';

type Send = (channel: string, payload: unknown) => void;

export function openThreeDRoutes(send: Send, binaries: () => Partial<Record<ProviderId, string>>) {
  const profile = (id: string) => joinPath(dataDir(), 'blockbench-profile', id);
  const viewerOn = async (id: string, file: string) => {
    const bin = findBlockbench();
    if (!bin) {
      throw new Error('Blockbench nicht gefunden (unter 3D installieren oder QUORUM_BLOCKBENCH setzen).');
    }
    await openViewer({
      projectId: id,
      file,
      profileDir: profile(id),
      bin,
      onFrame: (jpeg) => send('3d:frame', { projectId: id, jpeg }),
      onError: (message) => send('3d:frame', { projectId: id, error: message }),
    });
  };
  const toolEmit = (payload: unknown) => send('3d:tool-progress', payload);

  return {
    '3d:list': () => listProjects(),
    '3d:create': (name: string) => createProject(name),
    '3d:delete': async (id: string) => {
      cancelProjectRun(id);
      await deleteProject(id);
      return true;
    },
    '3d:get': async (id: string) => {
      const [model, projectRenders, projectHistory, animations, exported] = await Promise.all([
        readModel(id),
        renders(id),
        history(id),
        animationPreviews(id),
        exportFile(id),
      ]);
      return {
        model,
        summary: summarize(model),
        description: describe(model),
        renders: projectRenders,
        history: projectHistory,
        animationPreviews: animations,
        exportFile: exported,
      };
    },
    '3d:restore': (id: string, file: string) => restoreVersion(id, file),
    '3d:cancel': (id: string) => cancelProjectRun(id),
    '3d:viewer-open': (id: string) => viewerOn(id, joinPath(projectDir(id), 'model.bbmodel')).then(() => true),
    '3d:viewer-close': (id: string) => closeViewer(id),
    '3d:viewer-status': (id: string) => hasViewer(id),
    '3d:open-window': async (id: string) => {
      const bin = findBlockbench();
      if (!bin) {
        throw new Error('Blockbench nicht gefunden (unter 3D installieren oder QUORUM_BLOCKBENCH setzen).');
      }
      await openWindow(bin, joinPath(projectDir(id), 'model.bbmodel'), joinPath(dataDir(), 'blockbench-window'));
      return true;
    },
    '3d:open-blender': async (id?: string) => {
      const bin = findBlender();
      if (!bin) {
        throw new Error('Blender nicht gefunden – unter 3D → Werkzeuge installieren (oder QUORUM_BLENDER setzen).');
      }
      const blendFile = id ? joinPath(projectDir(id), 'model.blend') : undefined;
      const glbFile = id ? joinPath(projectDir(id), 'exports', 'model.glb') : undefined;
      const file = blendFile && existsSync(blendFile) ? blendFile : (glbFile && existsSync(glbFile) ? glbFile : undefined);
      await openBlenderWindow(bin, file, joinPath(dataDir(), 'blender-window'));
      return true;
    },
    '3d:workfiles': (id: string) => getWorkfiles(id),
    '3d:export': (id: string, format: 'glb' | 'gltf' | 'obj' | 'fbx') => exportProject(id, format),
    '3d:tools': () => toolStatus(),
    '3d:tool-install': (id: ToolId, opts: { mcp?: boolean } = {}) => {
      void installTool(id, opts, toolEmit);
      return true;
    },
    '3d:tool-cancel': (id: ToolId) => cancelInstall(id),
    '3d:tool-remove': async (id: ToolId) => {
      await uninstallTool(id);
      return toolStatus();
    },
    '3d:tool-mcp': async (enabled: boolean) => {
      await setMcp(enabled, toolEmit);
      return toolStatus();
    },
    '3d:blender': () => {
      const bin = findBlender();
      return { bin, version: bin ? blenderVersion(bin) : undefined, script: blenderScript(pythonDir()) };
    },
    '3d:run': (id: string, goal: string, engine: ChatEngine, maxIterations = 3) => {
      const blender = findBlender();
      if (!blender) {
        throw new Error('Blender nicht gefunden – unter 3D → Werkzeuge installieren (oder QUORUM_BLENDER setzen).');
      }
      const emit = (event: unknown) => send('3d:event', { projectId: id, event });
      const onIteration = (file: string) => {
        if (!hasViewer(id)) {
          return;
        }
        void viewerOn(id, file).catch((err: Error) => emit({ type: 'log', text: `Live-Ansicht: ${err.message}` }));
      };
      void runProject({
        projectId: id,
        goal,
        engine,
        binaries: binaries(),
        blender,
        script: blenderScript(pythonDir()),
        maxIterations: Math.min(Math.max(1, maxIterations), 6),
        emit: emit as never,
        onIteration,
      }).catch((err: Error) => {
        emit({ type: 'log', text: `Fehler: ${err.message}` });
        emit({ type: 'done', ok: false, iterations: 0, reason: err.message });
      });
      return true;
    },
  };
}
