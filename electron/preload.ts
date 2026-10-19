import type { ToolId, ToolStatus } from '../shared/threed';
import type { ApiConnection, OllamaManagement, OllamaPull } from '../shared/connections';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Attachment, UsageReport, FsEntry, CliCommandResult, GitStatus, ImportEntry, ImportedSession, MultiEnvelope, MultiStart, Persisted, ProviderId, ProviderOptions, ProviderStatus, RunEnvelope, RunRequest, UpdateChannel, UpdateProgress, UpdateState } from '../shared/types';
import type { ChatMessage, ModelRecord, RuntimeDetection } from '../shared/models';
import type { HfModelInfo, HfSearchHit } from './models/hf';
import type { DownloadState } from './models/manager';
import type { ResourceSnapshot } from './runtimes/resources';
import type { LoadedInfo } from './runtimes/scheduler';
import type { PyStatus } from './runtimes/pyenv';
import type { ImageParams } from './runtimes/adapter';
import type { LocalImageResult } from './models/chat';
import type { RunEvent } from './workflows/engine';
import type { RunRecord } from './workflows/engine';
import type { WorkflowDef, WorkflowNode } from '../shared/workflow';
import type { BbModel, BbSummary } from '../shared/bbmodel';
import type { ProjectInfo } from './3d/service';
import type { LoopEvent } from './3d/loop';
import type { ChatEngine } from './3d/llm';

const sub = <T>(channel: string, cb: (p: T) => void) => {
  const h = (_: unknown, p: T) => cb(p);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.removeListener(channel, h); };
};

const api = {
  apiSetKey: (id: string, key: string): Promise<{ persistent: boolean }> => ipcRenderer.invoke('api:key', id, key),
  apiHasKey: (id: string): Promise<boolean> => ipcRenderer.invoke('api:has-key', id),
  apiInspect: (connection: ApiConnection): Promise<string[]> => ipcRenderer.invoke('api:inspect', connection),
  ollamaManage: (): Promise<OllamaManagement> => ipcRenderer.invoke('ollama:manage'),
  ollamaAction: (action: 'load' | 'unload' | 'delete', model: string): Promise<void> => ipcRenderer.invoke('ollama:action', action, model),
  ollamaPull: (model: string): Promise<string> => ipcRenderer.invoke('ollama:pull', model),
  ollamaPulls: (): Promise<OllamaPull[]> => ipcRenderer.invoke('ollama:pulls'),
  ollamaCancelPull: (id: string): Promise<void> => ipcRenderer.invoke('ollama:cancel-pull', id),
  ollamaStart: (): Promise<void> => ipcRenderer.invoke('ollama:start'),
  ollamaStop: (): Promise<void> => ipcRenderer.invoke('ollama:stop'),
  onOllamaProgress: (callback: (state: OllamaPull) => void) => sub('ollama:progress', callback),
  load: (): Promise<Persisted> => ipcRenderer.invoke('store:load'),
  save: (d: Persisted): Promise<void> => ipcRenderer.invoke('store:save', d),
  run: (r: RunRequest): Promise<void> => ipcRenderer.invoke('hub:run', r),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke('hub:cancel', id),
  inject: (runId: string, text: string, atts?: Attachment[]): Promise<boolean> => ipcRenderer.invoke('hub:inject', runId, text, atts),
  onRun: (cb: (e: RunEnvelope) => void) => sub('hub:event', cb),
  multiStart: (m: MultiStart): Promise<void> => ipcRenderer.invoke('multi:start', m),
  multiStop: (id: string): Promise<void> => ipcRenderer.invoke('multi:stop', id),
  multiStopTurn: (id: string, turnId: string): Promise<boolean> => ipcRenderer.invoke('multi:stop-turn', id, turnId),
  onMulti: (cb: (e: MultiEnvelope) => void) => sub('multi:event', cb),
  providerStatus: (id: ProviderId, refresh?: boolean): Promise<ProviderStatus> => ipcRenderer.invoke('provider:status', id, refresh),
  cli: (id: ProviderId, args: string[], cwd?: string): Promise<CliCommandResult> => ipcRenderer.invoke('cli:exec', id, args, cwd),
  importList: (): Promise<ImportEntry[]> => ipcRenderer.invoke('import:list'),
  importLoad: (e: ImportEntry[]): Promise<ImportedSession[]> => ipcRenderer.invoke('import:load', e),
  gitStatus: (cwd: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', cwd),
  gitDiff: (cwd: string, file?: string): Promise<string> => ipcRenderer.invoke('git:diff', cwd, file),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:folder'),
  pickFiles: (kind: 'image' | 'json' | 'any'): Promise<string[]> => ipcRenderer.invoke('dialog:files', kind),
  files: (root: string, q: string): Promise<string[]> => ipcRenderer.invoke('fs:files', root, q),
  slash: (cwd: string): Promise<{ name: string; source: string }[]> => ipcRenderer.invoke('fs:slash', cwd),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:open', p),
  revealPath: (p: string): Promise<void> => ipcRenderer.invoke('shell:reveal', p),
  copyImage: (p: string): Promise<void> => ipcRenderer.invoke('image:copy', p),
  saveImageAs: (p: string): Promise<boolean> => ipcRenderer.invoke('image:saveAs', p),
  openExternal: (u: string): Promise<void> => ipcRenderer.invoke('shell:external', u),
  home: (): Promise<string> => ipcRenderer.invoke('app:home'),
  setWindowTheme: (bg: string): Promise<void> => ipcRenderer.invoke('win:theme', bg),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  isPrimary: (): Promise<boolean> => ipcRenderer.invoke('app:isPrimary'),
  onSync: (cb: (d: Persisted) => void) => sub('store:sync', cb),
  winMinimize: (): Promise<void> => ipcRenderer.invoke('win:minimize'),
  winMaximize: (): Promise<void> => ipcRenderer.invoke('win:maximize'),
  winClose: (): Promise<void> => ipcRenderer.invoke('win:close'),
  winState: (): Promise<{ maximized: boolean; fullscreen: boolean }> => ipcRenderer.invoke('win:state'),
  onWinState: (cb: (s: { maximized: boolean; fullscreen: boolean }) => void) => sub('win:state', cb),
  newWindow: (hash?: string): Promise<void> => ipcRenderer.invoke('win:new', hash),
  termCreate: (id: string, cwd: string, cols: number, rows: number, provider?: ProviderId): Promise<{ mode: 'pty' | 'pipe' | 'missing' }> => ipcRenderer.invoke('term:create', id, cwd, cols, rows, provider),
  termWrite: (id: string, d: string): Promise<void> => ipcRenderer.invoke('term:write', id, d),
  termResize: (id: string, c: number, r: number): Promise<void> => ipcRenderer.invoke('term:resize', id, c, r),
  termKill: (id: string): Promise<void> => ipcRenderer.invoke('term:kill', id),
  onTermData: (cb: (p: { id: string; data: string }) => void) => sub('term:data', cb),
  onTermExit: (cb: (p: { id: string; code: number | null }) => void) => sub('term:exit', cb),
  fsList: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke('fs:list', dir),
  fsRead: (file: string): Promise<{ text: string; binary: boolean; truncated: boolean }> => ipcRenderer.invoke('fs:read', file),
  usage: (force?: boolean): Promise<UsageReport> => ipcRenderer.invoke('usage:scan', force),
  onUsageReport: (cb: (r: UsageReport) => void) => sub('usage:report', cb),
  quickTake: (): Promise<{ provider: ProviderId; cwd: string; options: ProviderOptions; prompt: string } | null> => ipcRenderer.invoke('quick:take'),
  quickSubmit: (q: { provider: ProviderId; cwd: string; options: ProviderOptions; prompt: string }): Promise<void> => ipcRenderer.invoke('quick:submit', q),
  quickOpenChat: (id: string): Promise<void> => ipcRenderer.invoke('quick:open', id),
  quickHide: (): Promise<void> => ipcRenderer.invoke('quick:hide'),
  onQuickWake: (cb: () => void) => sub('quick:wake', cb),
  onQuickShow: (cb: () => void) => sub('quick:show', cb),
  onOpenChat: (cb: (id: string) => void) => sub('app:open-chat', cb),
  // Lokale Modelle
  models: (): Promise<ModelRecord[]> => ipcRenderer.invoke('models:list'),
  modelSearch: (q: string, filter?: string): Promise<HfSearchHit[]> => ipcRenderer.invoke('models:search', q, filter),
  modelInfo: (repo: string): Promise<HfModelInfo> => ipcRenderer.invoke('models:info', repo),
  modelDownload: (repo: string, files: string[]): Promise<string> => ipcRenderer.invoke('models:download', repo, files),
  modelDownloads: (): Promise<DownloadState[]> => ipcRenderer.invoke('models:downloads'),
  modelPause: (id: string): Promise<boolean> => ipcRenderer.invoke('models:pause', id),
  modelCancel: (id: string): Promise<void> => ipcRenderer.invoke('models:cancel', id),
  modelImport: (path: string): Promise<ModelRecord> => ipcRenderer.invoke('models:import', path),
  modelRemove: (id: string): Promise<boolean> => ipcRenderer.invoke('models:remove', id),
  modelConfig: (id: string, load: ModelRecord['load']): Promise<ModelRecord | undefined> => ipcRenderer.invoke('models:config', id, load),
  modelLoad: (id: string, priority?: number): Promise<boolean> => ipcRenderer.invoke('models:load', id, priority),
  modelForget: (id: string): Promise<void> => ipcRenderer.invoke('models:forget', id),
  modelUnload: (id: string): Promise<boolean> => ipcRenderer.invoke('models:unload', id),
  modelLoaded: (): Promise<LoadedInfo[]> => ipcRenderer.invoke('models:loaded'),
  modelRuntime: (): Promise<RuntimeDetection> => ipcRenderer.invoke('models:runtime'),
  modelResources: (): Promise<ResourceSnapshot> => ipcRenderer.invoke('models:resources'),
  modelImage: (runId: string, id: string, params: ImageParams): Promise<LocalImageResult> => ipcRenderer.invoke('models:image', runId, id, params),
  pyStatus: (): Promise<PyStatus> => ipcRenderer.invoke('py:status'),
  pySetup: (): Promise<{ ok: boolean; status?: PyStatus; error?: string }> => ipcRenderer.invoke('py:setup'),
  onPyLog: (cb: (line: string) => void) => sub('py:log', cb),
  // Workflows
  wfList: (): Promise<WorkflowDef[]> => ipcRenderer.invoke('wf:list'),
  wfGet: (id: string): Promise<WorkflowDef | undefined> => ipcRenderer.invoke('wf:get', id),
  wfSave: (input: { id?: string; name: string; nodes: WorkflowNode[] }): Promise<WorkflowDef> => ipcRenderer.invoke('wf:save', input),
  wfRestore: (id: string, version: number): Promise<WorkflowDef | undefined> => ipcRenderer.invoke('wf:restore', id, version),
  wfDelete: (id: string): Promise<boolean> => ipcRenderer.invoke('wf:delete', id),
  wfExport: (id: string): Promise<string | undefined> => ipcRenderer.invoke('wf:export', id),
  wfImport: (path: string): Promise<WorkflowDef> => ipcRenderer.invoke('wf:import', path),
  wfRuns: (workflowId?: string): Promise<RunRecord[]> => ipcRenderer.invoke('wf:runs', workflowId),
  wfRun: (id: string, inputs?: Record<string, string>): Promise<string> => ipcRenderer.invoke('wf:run', id, inputs),
  wfCancel: (runId: string): Promise<boolean> => ipcRenderer.invoke('wf:cancel', runId),
  onWfEvent: (cb: (e: RunEvent) => void) => sub('wf:event', cb),
  // 3D-Projekte
  threedList: (): Promise<ProjectInfo[]> => ipcRenderer.invoke('3d:list'),
  threedCreate: (name: string): Promise<ProjectInfo> => ipcRenderer.invoke('3d:create', name),
  threedDelete: (id: string): Promise<boolean> => ipcRenderer.invoke('3d:delete', id),
  threedGet: (id: string): Promise<{ model: BbModel; summary: BbSummary; description: string; renders: string[]; history: { file: string; at: number }[] }> => ipcRenderer.invoke('3d:get', id),
  threedRestore: (id: string, file: string): Promise<BbModel> => ipcRenderer.invoke('3d:restore', id, file),
  threedRun: (id: string, goal: string, engine: ChatEngine, maxIterations?: number): Promise<boolean> => ipcRenderer.invoke('3d:run', id, goal, engine, maxIterations),
  threedCancel: (id: string): Promise<boolean> => ipcRenderer.invoke('3d:cancel', id),
  threedBlender: (): Promise<{ bin?: string; version?: string; script: string }> => ipcRenderer.invoke('3d:blender'),
  threedTools: (): Promise<ToolStatus[]> => ipcRenderer.invoke('3d:tools'),
  threedToolInstall: (id: ToolId, opts?: { mcp?: boolean }): Promise<boolean> => ipcRenderer.invoke('3d:tool-install', id, opts),
  threedToolCancel: (id: ToolId): Promise<void> => ipcRenderer.invoke('3d:tool-cancel', id),
  threedToolRemove: (id: ToolId): Promise<ToolStatus[]> => ipcRenderer.invoke('3d:tool-remove', id),
  threedToolMcp: (enabled: boolean): Promise<ToolStatus[]> => ipcRenderer.invoke('3d:tool-mcp', enabled),
  onThreedToolProgress: (cb: (p: { id: ToolId; step: string; percent?: number; done?: boolean; error?: string }) => void) => sub('3d:tool-progress', cb),
  threedViewerOpen: (id: string): Promise<boolean> => ipcRenderer.invoke('3d:viewer-open', id),
  threedViewerClose: (id: string): Promise<boolean> => ipcRenderer.invoke('3d:viewer-close', id),
  threedViewerStatus: (id: string): Promise<boolean> => ipcRenderer.invoke('3d:viewer-status', id),
  threedOpenWindow: (id: string): Promise<boolean> => ipcRenderer.invoke('3d:open-window', id),
  onThreedFrame: (cb: (f: { projectId: string; jpeg?: string; error?: string }) => void) => sub('3d:frame', cb),
  onChatProject: (cb: (p: { runId: string; projectId: string }) => void) => sub('chat:project', cb),
  onThreedEvent: (cb: (e: { projectId: string; event: LoopEvent | { type: 'log'; text: string } }) => void) => sub('3d:event', cb),
  modelChat: (runId: string, id: string, messages: ChatMessage[]): Promise<void> => ipcRenderer.invoke('models:chat', runId, id, messages),
  onModelDownload: (cb: (d: DownloadState) => void) => sub('models:download', cb),
  onModelRegistry: (cb: () => void) => sub('models:registry', cb),
  onModelEvent: (cb: (e: { type: string; modelId: string; text?: string }) => void) => sub('models:event', cb),
  onModelChat: (cb: (e: { runId: string; event: { type: string; delta?: string; ok?: boolean; error?: string } }) => void) => sub('models:chat-event', cb),
  // GitHub Updater
  updaterCheck: (channel?: UpdateChannel): Promise<UpdateState> => ipcRenderer.invoke('updater:check', channel),
  updaterDownload: (): Promise<boolean> => ipcRenderer.invoke('updater:download'),
  updaterInstall: (): Promise<boolean> => ipcRenderer.invoke('updater:install'),
  updaterState: (): Promise<UpdateState> => ipcRenderer.invoke('updater:state'),
  onUpdaterStatus: (cb: (s: UpdateState) => void) => sub('updater:status', cb),
  onUpdaterProgress: (cb: (p: UpdateProgress) => void) => sub('updater:progress', cb),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('hub', api);
export type HubApi = typeof api;
