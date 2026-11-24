import type { ChatJob } from './chat-host/types';
import type { HostInstallPlan } from './cli-packages';
import type { SandboxProgress, SandboxProvider, SandboxResult, SandboxStatus } from './sandbox';
import type { LspDocument, LspEvent, LspLanguage, LspReply, LspRequest, LspStatus } from './ide/lsp';
import type { ApprovalScope, Plan, PlanSaveInput, PlanSnapshot } from './plan/types';
import type { EditorDocument, WorkspaceEntry, WorkspaceFileResult, WorkspaceSearchResult } from './ide/types';
import type { AnimationPreview, ToolId, ToolStatus } from './threed';
import type { ApiConnection, OllamaManagement, OllamaPull } from './connections';
import type { Attachment, UsageReport, FsEntry, CliCommandResult, GitStatus, ImportEntry, ImportedSession, MultiEnvelope, MultiStart, Persisted, ProviderId, ProviderOptions, ProviderStatus, RunEnvelope, RunRequest, UpdateChannel, UpdateProgress, UpdateState } from './types';
import type { ChatMessage, ModelRecord, RuntimeDetection } from './models';
import type { HfModelInfo, HfSearchHit } from './contracts/models';
import type { DownloadState } from './contracts/models';
import type { ResourceSnapshot } from './contracts/models';
import type { LoadedInfo } from './contracts/models';
import type { PyStatus } from './contracts/models';
import type { ImageParams } from './contracts/models';
import type { LocalImageResult } from './contracts/models';
import type { RunEvent } from './contracts/workflows';
import type { RunRecord } from './contracts/workflows';
import type { WorkflowDef, WorkflowNode } from './workflow';
import type { BbModel, BbSummary } from './bbmodel';
import type { ProjectInfo, WorkfileItem } from './contracts/threed';
import type { LoopEvent } from './contracts/threed';
import type { ChatEngine } from './contracts/threed';

export interface DesktopTransport {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>;
  sub<T>(channel: string, callback: (payload: T) => void): () => void;
  pathForFile(file: File): string;
  platform: string;
}

export function createHub(transport: DesktopTransport) {
  const { invoke, sub } = transport;
  return {
    chatProcessStatus: (): Promise<Omit<ChatJob, 'snapshot'>[]> => invoke('chat:process-status'),
    onPrepareClose: (callback: (token: string) => void) => sub('chat:prepare-close', callback),
    readyClose: (token: string, error?: string): Promise<void> => invoke('chat:ready-close', token, error),
    chatForget: (chatId: string): Promise<void> => invoke('chat:forget', chatId),
    chatJobs: (): Promise<ChatJob[]> => invoke('chat:jobs'),
    chatAttach: (cursors: Record<string, number>): Promise<void> => invoke('chat:attach', cursors),
    chatStopAll: (): Promise<void> => invoke('chat:stop-all'),
    onChatChanged: (callback: () => void) => sub('chat:changed', callback),
    onRunBatch: (callback: (events: RunEnvelope[]) => void) => sub('hub:batch', callback),
    ideWatch: (id: string, root: string, paths: string[]): Promise<void> => invoke('ide:watch', id, root, paths),
    ideUnwatch: (id: string): Promise<void> => invoke('ide:unwatch', id),
    onFileChange: (callback: (event: { id: string; path: string; error?: string }) => void) => sub('ide:change', callback),
    ideRoot: (root: string): Promise<string> => invoke('ide:root', root),
    ideFindFiles: (root: string, query: string): Promise<WorkspaceFileResult> => invoke('ide:find', root, query, false),
    ideSearch: (root: string, query: string): Promise<WorkspaceSearchResult> => invoke('ide:find', root, query, true),
    lspStart: (root: string, language: LspLanguage): Promise<LspStatus> => invoke('lsp:start', root, language),
    lspStop: (root: string, language: LspLanguage): Promise<void> => invoke('lsp:stop', root, language),
    lspSync: (document: LspDocument): Promise<void> => invoke('lsp:sync', document),
    lspSaved: (root: string, language: LspLanguage, path: string): Promise<void> => invoke('lsp:saved', root, language, path),
    lspClose: (root: string, language: LspLanguage, path: string): Promise<void> => invoke('lsp:close', root, language, path),
    lspRequest: (input: LspRequest): Promise<LspReply> => invoke('lsp:request', input),
    onLspEvent: (callback: (event: LspEvent) => void) => sub('lsp:event', callback),
    planAsk: (id: string, revisionId: string, question: string, options: string[] = []): Promise<PlanSnapshot> => invoke('plan:ask', id, revisionId, question, options),
    planAnswer: (id: string, questionId: string, answer: string): Promise<PlanSnapshot> => invoke('plan:answer', id, questionId, answer),
    planArchive: (id: string): Promise<PlanSnapshot> => invoke('plan:archive', id),
    planExport: (id: string): Promise<string> => invoke('plan:export', id),
    planImport: (root: string, value: unknown): Promise<PlanSnapshot> => invoke('plan:import', root, value),
    planList: (root?: string): Promise<Plan[]> => invoke('plan:list', root),
    planGet: (id: string): Promise<PlanSnapshot> => invoke('plan:get', id),
    planSave: (input: PlanSaveInput): Promise<PlanSnapshot> => invoke('plan:save', input),
    planApprove: (id: string, revisionId: string, scope: ApprovalScope): Promise<PlanSnapshot> => invoke('plan:approve', id, revisionId, scope),
    planRevoke: (id: string, approvalId: string): Promise<PlanSnapshot> => invoke('plan:revoke', id, approvalId),
    ideList: (root: string, path?: string): Promise<WorkspaceEntry[]> => invoke('ide:list', root, path),
    ideRead: (root: string, path: string): Promise<EditorDocument> => invoke('ide:read', root, path),
    ideSave: (root: string, path: string, text: string, expectedHash: string): Promise<EditorDocument> => invoke('ide:save', root, path, text, expectedHash),
    apiSetKey: (id: string, key: string): Promise<{ persistent: boolean }> => invoke('api:key', id, key),
    apiHasKey: (id: string): Promise<boolean> => invoke('api:has-key', id),
    apiDiscover: (): Promise<{ name: string; baseUrl: string; models: string[]; needsKey: boolean }[]> => invoke('api:discover'),
    apiInspect: (connection: ApiConnection): Promise<string[]> => invoke('api:inspect', connection),
    ollamaManage: (): Promise<OllamaManagement> => invoke('ollama:manage'),
    ollamaAction: (action: 'load' | 'unload' | 'delete', model: string): Promise<void> => invoke('ollama:action', action, model),
    ollamaPull: (model: string): Promise<string> => invoke('ollama:pull', model),
    ollamaPulls: (): Promise<OllamaPull[]> => invoke('ollama:pulls'),
    ollamaCancelPull: (id: string): Promise<void> => invoke('ollama:cancel-pull', id),
    ollamaStart: (): Promise<void> => invoke('ollama:start'),
    ollamaStop: (): Promise<void> => invoke('ollama:stop'),
    onOllamaProgress: (callback: (state: OllamaPull) => void) => sub('ollama:progress', callback),
    load: (): Promise<Persisted> => invoke('store:load'),
    save: (d: Persisted): Promise<void> => invoke('store:save', d),
    run: (r: RunRequest): Promise<void> => invoke('hub:run', r),
    cancel: (id: string): Promise<void> => invoke('hub:cancel', id),
    inject: (runId: string, text: string, atts?: Attachment[]): Promise<boolean> => invoke('hub:inject', runId, text, atts),
    onRun: (cb: (e: RunEnvelope) => void) => sub('hub:event', cb),
    multiStart: (m: MultiStart): Promise<void> => invoke('multi:start', m),
    multiStop: (id: string): Promise<void> => invoke('multi:stop', id),
    multiStopTurn: (id: string, turnId: string): Promise<boolean> => invoke('multi:stop-turn', id, turnId),
    onMulti: (cb: (e: MultiEnvelope) => void) => sub('multi:event', cb),
    providerStatus: (id: ProviderId, refresh?: boolean): Promise<ProviderStatus> => invoke('provider:status', id, refresh),
    cli: (id: ProviderId, args: string[], cwd?: string): Promise<CliCommandResult> => invoke('cli:exec', id, args, cwd),
    importList: (): Promise<ImportEntry[]> => invoke('import:list'),
    importLoad: (e: ImportEntry[]): Promise<ImportedSession[]> => invoke('import:load', e),
    gitStatus: (cwd: string): Promise<GitStatus> => invoke('git:status', cwd),
    gitDiff: (cwd: string, file?: string): Promise<string> => invoke('git:diff', cwd, file),
    pickFolder: (): Promise<string | null> => invoke('dialog:folder'),
    pickFiles: (kind: 'image' | 'json' | 'any'): Promise<string[]> => invoke('dialog:files', kind),
    files: (root: string, q: string): Promise<string[]> => invoke('fs:files', root, q),
    slash: (cwd: string): Promise<{ name: string; source: string }[]> => invoke('fs:slash', cwd),
    openPath: (p: string): Promise<string> => invoke('shell:open', p),
    revealPath: (p: string): Promise<void> => invoke('shell:reveal', p),
    previewImage: (p: string): Promise<string> => invoke('image:preview', p),
    copyImage: (p: string): Promise<void> => invoke('image:copy', p),
    saveImageAs: (p: string): Promise<boolean> => invoke('image:saveAs', p),
    openExternal: (u: string): Promise<void> => invoke('shell:external', u),
    home: (): Promise<string> => invoke('app:home'),
    setWindowTheme: (bg: string): Promise<void> => invoke('win:theme', bg),
    pathForFile: (f: File): string => transport.pathForFile(f),
    isPrimary: (): Promise<boolean> => invoke('app:isPrimary'),
    onSync: (cb: (d: Persisted) => void) => sub('store:sync', cb),
    winMinimize: (): Promise<void> => invoke('win:minimize'),
    winMaximize: (): Promise<void> => invoke('win:maximize'),
    winClose: (): Promise<void> => invoke('win:close'),
    winState: (): Promise<{ maximized: boolean; fullscreen: boolean }> => invoke('win:state'),
    onWinState: (cb: (s: { maximized: boolean; fullscreen: boolean }) => void) => sub('win:state', cb),
    newWindow: (hash?: string): Promise<void> => invoke('win:new', hash),
    termCreate: (id: string, cwd: string, cols: number, rows: number, provider?: ProviderId, shell?: string): Promise<{ mode: 'pty' | 'pipe' | 'missing' }> => invoke('term:create', id, cwd, cols, rows, provider, shell),
    cliInstallPlan: (provider: ProviderId): Promise<HostInstallPlan> => invoke('cli:install-plan', provider),
    cliInstall: (provider: ProviderId): Promise<SandboxResult> => invoke('cli:install', provider),
    onCliInstallProgress: (callback: (progress: { provider: ProviderId; text: string }) => void) => sub('cli:install-progress', callback),
    sandboxStatus: (provider: SandboxProvider): Promise<SandboxStatus> => invoke('sandbox:status', provider),
    sandboxInstall: (provider: SandboxProvider): Promise<SandboxResult> => invoke('sandbox:install', provider),
    sandboxRemove: (provider: SandboxProvider): Promise<SandboxResult> => invoke('sandbox:remove', provider),
    sandboxTerminal: (id: string, provider: SandboxProvider, cols: number, rows: number): Promise<{ mode: 'pty' | 'pipe' | 'missing' }> => invoke('sandbox:terminal', id, provider, cols, rows),
    onSandboxProgress: (callback: (progress: SandboxProgress) => void) => sub('sandbox:progress', callback),
    termShells: (): Promise<{ id: string; name: string; path: string }[]> => invoke('term:shells'),
    termWrite: (id: string, d: string): Promise<void> => invoke('term:write', id, d),
    termResize: (id: string, c: number, r: number): Promise<void> => invoke('term:resize', id, c, r),
    termKill: (id: string): Promise<void> => invoke('term:kill', id),
    onTermData: (cb: (p: { id: string; data: string }) => void) => sub('term:data', cb),
    onTermExit: (cb: (p: { id: string; code: number | null }) => void) => sub('term:exit', cb),
    fsList: (dir: string): Promise<FsEntry[]> => invoke('fs:list', dir),
    fsRead: (file: string): Promise<{ text: string; binary: boolean; truncated: boolean }> => invoke('fs:read', file),
    usage: (force?: boolean): Promise<UsageReport> => invoke('usage:scan', force),
    onUsageReport: (cb: (r: UsageReport) => void) => sub('usage:report', cb),
    quickTake: (): Promise<{ provider: ProviderId; cwd: string; options: ProviderOptions; prompt: string } | null> => invoke('quick:take'),
    quickSubmit: (q: { provider: ProviderId; cwd: string; options: ProviderOptions; prompt: string }): Promise<void> => invoke('quick:submit', q),
    quickOpenChat: (id: string): Promise<void> => invoke('quick:open', id),
    quickHide: (): Promise<void> => invoke('quick:hide'),
    onQuickWake: (cb: () => void) => sub('quick:wake', cb),
    onQuickShow: (cb: () => void) => sub('quick:show', cb),
    onOpenChat: (cb: (id: string) => void) => sub('app:open-chat', cb),
    /** Ordner aus der Kommandozeile (quorum <Ordner>): beim Start abholen bzw. später per Ereignis. */
    launchTake: (): Promise<string | null> => invoke('launch:take'),
    onOpenFolder: (cb: (folder: string) => void) => sub('app:open-folder', cb),
    // Lokale Modelle
    models: (): Promise<ModelRecord[]> => invoke('models:list'),
    modelSearch: (q: string, filter?: string): Promise<HfSearchHit[]> => invoke('models:search', q, filter),
    modelInfo: (repo: string): Promise<HfModelInfo> => invoke('models:info', repo),
    modelDownload: (repo: string, files: string[]): Promise<string> => invoke('models:download', repo, files),
    modelDownloads: (): Promise<DownloadState[]> => invoke('models:downloads'),
    modelPause: (id: string): Promise<boolean> => invoke('models:pause', id),
    modelCancel: (id: string): Promise<void> => invoke('models:cancel', id),
    modelImport: (path: string): Promise<ModelRecord> => invoke('models:import', path),
    modelRemove: (id: string): Promise<boolean> => invoke('models:remove', id),
    modelConfig: (id: string, load: ModelRecord['load']): Promise<ModelRecord | undefined> => invoke('models:config', id, load),
    modelLoad: (id: string, priority?: number): Promise<boolean> => invoke('models:load', id, priority),
    modelForget: (id: string): Promise<void> => invoke('models:forget', id),
    modelUnload: (id: string): Promise<boolean> => invoke('models:unload', id),
    modelLoaded: (): Promise<LoadedInfo[]> => invoke('models:loaded'),
    modelRuntime: (): Promise<RuntimeDetection> => invoke('models:runtime'),
    modelResources: (): Promise<ResourceSnapshot> => invoke('models:resources'),
    modelImage: (runId: string, id: string, params: ImageParams): Promise<LocalImageResult> => invoke('models:image', runId, id, params),
    pyStatus: (): Promise<PyStatus> => invoke('py:status'),
    pySetup: (): Promise<{ ok: boolean; status?: PyStatus; error?: string }> => invoke('py:setup'),
    onPyLog: (cb: (line: string) => void) => sub('py:log', cb),
    // Workflows
    wfList: (): Promise<WorkflowDef[]> => invoke('wf:list'),
    wfGet: (id: string): Promise<WorkflowDef | undefined> => invoke('wf:get', id),
    wfSave: (input: { id?: string; name: string; nodes: WorkflowNode[] }): Promise<WorkflowDef> => invoke('wf:save', input),
    wfRestore: (id: string, version: number): Promise<WorkflowDef | undefined> => invoke('wf:restore', id, version),
    wfDelete: (id: string): Promise<boolean> => invoke('wf:delete', id),
    wfExport: (id: string): Promise<string | undefined> => invoke('wf:export', id),
    wfImport: (path: string): Promise<WorkflowDef> => invoke('wf:import', path),
    wfRuns: (workflowId?: string): Promise<RunRecord[]> => invoke('wf:runs', workflowId),
    wfRun: (id: string, inputs?: Record<string, string>): Promise<string> => invoke('wf:run', id, inputs),
    wfCancel: (runId: string): Promise<boolean> => invoke('wf:cancel', runId),
    onWfEvent: (cb: (e: RunEvent) => void) => sub('wf:event', cb),
    // 3D-Projekte
    threedList: (): Promise<ProjectInfo[]> => invoke('3d:list'),
    threedCreate: (name: string): Promise<ProjectInfo> => invoke('3d:create', name),
    threedDelete: (id: string): Promise<boolean> => invoke('3d:delete', id),
    threedGet: (id: string): Promise<{ model: BbModel; summary: BbSummary; description: string; renders: string[]; history: { file: string; at: number }[]; animationPreviews: AnimationPreview[]; exportFile?: string }> => invoke('3d:get', id),
    threedRestore: (id: string, file: string): Promise<BbModel> => invoke('3d:restore', id, file),
    threedRun: (id: string, goal: string, engine: ChatEngine, maxIterations?: number): Promise<boolean> => invoke('3d:run', id, goal, engine, maxIterations),
    threedCancel: (id: string): Promise<boolean> => invoke('3d:cancel', id),
    threedBlender: (): Promise<{ bin?: string; version?: string; script: string }> => invoke('3d:blender'),
    threedTools: (): Promise<ToolStatus[]> => invoke('3d:tools'),
    threedToolInstall: (id: ToolId, opts?: { mcp?: boolean }): Promise<boolean> => invoke('3d:tool-install', id, opts),
    threedToolCancel: (id: ToolId): Promise<void> => invoke('3d:tool-cancel', id),
    threedToolRemove: (id: ToolId): Promise<ToolStatus[]> => invoke('3d:tool-remove', id),
    threedToolMcp: (enabled: boolean): Promise<ToolStatus[]> => invoke('3d:tool-mcp', enabled),
    onThreedToolProgress: (cb: (p: { id: ToolId; step: string; percent?: number; done?: boolean; error?: string }) => void) => sub('3d:tool-progress', cb),
    threedViewerOpen: (id: string): Promise<boolean> => invoke('3d:viewer-open', id),
    threedViewerClose: (id: string): Promise<boolean> => invoke('3d:viewer-close', id),
    threedViewerStatus: (id: string): Promise<boolean> => invoke('3d:viewer-status', id),
    threedOpenWindow: (id: string): Promise<boolean> => invoke('3d:open-window', id),
    threedOpenBlender: (id?: string): Promise<boolean> => invoke('3d:open-blender', id),
    threedWorkfiles: (id: string): Promise<WorkfileItem[]> => invoke('3d:workfiles', id),
    threedExport: (id: string, format: 'glb' | 'gltf' | 'obj' | 'fbx'): Promise<string> => invoke('3d:export', id, format),
    onThreedFrame: (cb: (f: { projectId: string; jpeg?: string; error?: string }) => void) => sub('3d:frame', cb),
    onChatProject: (cb: (p: { runId: string; projectId: string }) => void) => sub('chat:project', cb),
    onThreedEvent: (cb: (e: { projectId: string; event: LoopEvent | { type: 'log'; text: string } }) => void) => sub('3d:event', cb),
    modelChat: (runId: string, id: string, messages: ChatMessage[]): Promise<void> => invoke('models:chat', runId, id, messages),
    onModelDownload: (cb: (d: DownloadState) => void) => sub('models:download', cb),
    onModelRegistry: (cb: () => void) => sub('models:registry', cb),
    onModelEvent: (cb: (e: { type: string; modelId: string; text?: string }) => void) => sub('models:event', cb),
    onModelChat: (cb: (e: { runId: string; event: { type: string; delta?: string; ok?: boolean; error?: string } }) => void) => sub('models:chat-event', cb),
    // GitHub Updater
    updaterCheck: (channel?: UpdateChannel): Promise<UpdateState> => invoke('updater:check', channel),
    updaterDownload: (): Promise<boolean> => invoke('updater:download'),
    updaterInstall: (): Promise<boolean> => invoke('updater:install'),
    updaterState: (): Promise<UpdateState> => invoke('updater:state'),
    onUpdaterStatus: (cb: (s: UpdateState) => void) => sub('updater:status', cb),
    onUpdaterProgress: (cb: (p: UpdateProgress) => void) => sub('updater:progress', cb),
    platform: transport.platform,
  };
}

export type HubApi = ReturnType<typeof createHub>;
