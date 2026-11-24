// Transitional adapter for Quorum's existing Node services. The Tauri process owns the window.
import { createInterface } from 'node:readline';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ChatHostManager } from '../electron/chat-host/manager';
import { dataDir, load, defaults } from '../electron/store';
import { providerStatus, resolveBinary, execCli } from '../electron/providers/detect';
import { terminalCommand } from '../electron/providers/sandbox';
import { installSandbox, removeSandbox, sandboxStatus } from '../electron/providers/sandbox-install';
import { effectiveBinaries, type SandboxProvider } from '../shared/sandbox';
import { configureApi, inspectApi } from '../electron/providers/api';
import { discoverLocalServers } from '../electron/providers/discover';
import { configureAcp } from '../electron/providers/acp';
import { setOllamaSettings } from '../electron/providers/ollama';
import {
  cancelOllamaPull,
  ollamaManagement,
  ollamaModelAction,
  ollamaPullList,
  pullOllama,
  shutdownOllama,
  startOllama,
  stopOllama,
} from '../electron/providers/ollama-management';
import { DocumentService } from '../core/ide/documents';
import { WorkspaceSearch } from '../core/ide/search';
import { watchDocuments } from '../core/ide/watch';
import { workspaceRoot } from '../core/ide/paths';
import { PlanService } from '../core/plan/service';
import { gitDiff, gitStatus } from '../electron/git';
import { listImportable, loadImportable } from '../electron/importer';
import { scanUsage } from '../electron/usage';
import { chatMode } from '../shared/chat-modes';
import type { Attachment, MultiStart, Persisted, ProviderId, RunRequest } from '../shared/types';
import { startMulti, stopMulti, stopMultiTurn } from '../electron/orchestrator';
import { createTerminal, killAllTerminals, killTerminal, listShells, resizeTerminal, writeTerminal } from '../electron/terminal';
import { LspManager } from '../core/ide/lsp/manager';
import { installedServer } from '../core/ide/lsp/servers';
import { slashCommands } from '../core/ide/composer-files';
import { openThreeDRoutes } from '../electron/3d/routes';
import { openWorkflowRoutes } from '../electron/workflows/routes';

const assets = process.argv[2];
if (!assets) throw new Error('Quorum resource directory required');
const root = dataDir();
let data = defaults();
const host = new ChatHostManager(root, join(assets, 'native/bin', 'quorum-chat-host' + (process.platform === 'win32' ? '.exe' : '')), join(assets, 'dist-electron/chat-worker.js'));
const keys = new Map<string, string>();
const keyFor = async (id: string) => keys.get(id) ?? process.env['QUORUM_API_KEY_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_')];
configureApi(() => data.settings.apiConnections ?? [], keyFor);
configureAcp(() => data.settings.acpAgents ?? []);
setOllamaSettings(() => data.settings.ollama ?? {});
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const event = (channel: string, payload?: unknown) => { send({ channel, payload: payload ?? null }); };
const terminal = { isDestroyed: () => false, send: event };
const documents = new DocumentService();
const search = new WorkspaceSearch();
const watchers = new Map<string, () => void>();
const plans = new PlanService(join(root, 'plans.sqlite'));
const lsp = new LspManager((value) => event('lsp:event', value), (language) => installedServer(language, assets));
const keyUpdate = (id: string, key: string) => {
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Ungültige Verbindungs-ID');
  if (key) keys.set(id, key); else keys.delete(id);
  return { persistent: false };
};
async function launch(request: RunRequest) {
  if (!request.cwd || chatMode(request.options) === 'text') {
    const cwd = join(root, 'scratch');
    await mkdir(cwd, { recursive: true });
    request = { ...request, cwd };
  }
  const apiKeys: Record<string, string> = {};
  if (request.provider === 'api') {
    const connection = data.settings.apiConnections?.find((c) => c.enabled && request.options.model?.startsWith(c.id + '::'));
    const key = connection && await keyFor(connection.id);
    if (connection && key) apiKeys[connection.id] = key;
  }
  await host.launch(request, { dataRoot: root, pythonRoot: join(assets, 'python'), settings: data.settings, apiKeys });
  event('chat:changed');
}
const workflows = openWorkflowRoutes(event, () => effectiveBinaries(data.settings));
const threed = openThreeDRoutes(event, () => effectiveBinaries(data.settings));
const routes = {
  ...workflows,
  ...threed,
  'app:home': homedir, 'app:isPrimary': () => true, 'launch:take': () => null, 'quick:take': () => null,
  'store:seed': load,
  'store:adopt': (next: Partial<Persisted>) => {
    if (next?.settings) {
      data = { ...data, settings: next.settings };
    }
  },
  'store:ack': async (next: Partial<Persisted> & { completed?: { chatId: string; messageId: string; runId: string }[] }) => {
    if (next?.settings) {
      data = { ...data, settings: next.settings };
    }
    if (Array.isArray(next?.completed)) {
      const synthetic: Persisted = {
        ...data,
        sessions: next.completed.map((entry) => ({
          id: entry.chatId,
          title: '',
          cwd: '',
          provider: 'claude',
          options: {},
          providerSessions: {},
          createdAt: 0,
          updatedAt: 0,
          messages: [{ id: entry.messageId, role: 'assistant', blocks: [], createdAt: 0, workerDone: true, workerRunId: entry.runId }],
        })),
      };
      await host.acknowledge(synthetic);
      return;
    }
    if (Array.isArray(next?.sessions)) {
      await host.acknowledge(next as Persisted);
    }
  },
  'provider:status': (id: ProviderId, force?: boolean) => providerStatus(id, effectiveBinaries(data.settings), force),
  'api:has-key': async (id: string) => !!await keyFor(id), 'api:key': keyUpdate, 'api:inspect': inspectApi, 'api:discover': discoverLocalServers,
  'ollama:manage': ollamaManagement,
  'ollama:action': ollamaModelAction,
  'ollama:pull': (model: string) => pullOllama(model, (state) => event('ollama:progress', state)),
  'ollama:pulls': ollamaPullList,
  'ollama:cancel-pull': cancelOllamaPull,
  'ollama:start': startOllama,
  'ollama:stop': stopOllama,
  'chat:jobs': () => host.discover(),
  'chat:process-status': async () => (await host.list()).filter((job) => !job.forgotten).map(({ snapshot: _snapshot, ...job }) => job),
  'chat:attach': (cursors: Record<string, number>) => host.attach(1, cursors, (batch) => event('hub:batch', batch)),
  'chat:forget': (id: string) => host.forgetChat(id), 'chat:stop-all': () => host.stopAll(),
  'chat:prepare': async () => { host.pauseStarts(); return (await host.active()).length; },
  'chat:resume-starts': () => host.resumeStarts(),
  'hub:run': launch, 'hub:cancel': (id: string) => host.cancel(id),
  'hub:inject': (id: string, text: string, attachments?: Attachment[]) => host.inject(id, text, attachments),
  'multi:start': (m: MultiStart) => { void startMulti(m.multiId, m.config, (value) => event('multi:event', { multiId: m.multiId, event: value }), effectiveBinaries(data.settings), root); },
  'multi:stop': stopMulti, 'multi:stop-turn': stopMultiTurn,
  'import:list': listImportable, 'import:load': loadImportable,
  'git:status': gitStatus, 'git:diff': gitDiff, 'usage:scan': scanUsage,
  'term:shells': listShells, 'term:write': writeTerminal, 'term:kill': killTerminal, 'term:resize': resizeTerminal,
  'term:create': (id: string, cwd: string, cols: number, rows: number, provider?: ProviderId, shell?: string) => {
    const bin = provider && resolveBinary(provider, effectiveBinaries(data.settings));
    if (provider && !bin) return { mode: 'missing' };
    return createTerminal(terminal, id, cwd, cols, rows, root, bin ? terminalCommand(bin, cwd) : undefined, shell);
  },
  'sandbox:status': (provider: SandboxProvider) => sandboxStatus(root, provider),
  'sandbox:install': (provider: SandboxProvider) => installSandbox(root, provider, data.settings.binaries, (text) => event('sandbox:progress', { provider, text })),
  'sandbox:remove': (provider: SandboxProvider) => removeSandbox(root, provider),
  'sandbox:terminal': async (id: string, provider: SandboxProvider, cols: number, rows: number) => {
    const status = await sandboxStatus(root, provider);
    if (!status.bin) return { mode: 'missing' };
    return createTerminal(terminal, id, status.home, cols, rows, root, terminalCommand(status.bin, status.home));
  },
  'cli:exec': (id: ProviderId, args: string[], cwd?: string) => {
    const bin = resolveBinary(id, effectiveBinaries(data.settings));
    if (!bin) throw new Error('CLI fehlt');
    return execCli(bin, args, cwd);
  },
  'ide:root': workspaceRoot,
  'ide:list': (cwd: string, directory?: string | null) => documents.list(cwd, directory ?? undefined),
  'ide:read': documents.read.bind(documents),
  'ide:save': documents.save.bind(documents),
  'ide:find': (cwd: string, query: string, content: boolean) => content ? search.search(cwd, query) : search.files(cwd, query),
  'ide:watch': (id: string, cwd: string, paths: string[]) => {
    watchers.get(id)?.();
    watchers.set(id, watchDocuments(cwd, paths, (change) => event('ide:change', { id, ...change })));
  },
  'ide:unwatch': (id: string) => { watchers.get(id)?.(); watchers.delete(id); },
  'lsp:start': lsp.start.bind(lsp), 'lsp:stop': lsp.stop.bind(lsp), 'lsp:sync': lsp.sync.bind(lsp),
  'lsp:close': lsp.closeDocument.bind(lsp), 'lsp:saved': lsp.saved.bind(lsp), 'lsp:request': lsp.request.bind(lsp),
  'plan:list': plans.list.bind(plans), 'plan:get': plans.get.bind(plans), 'plan:save': plans.save.bind(plans),
  'plan:ask': plans.ask.bind(plans), 'plan:answer': plans.answer.bind(plans), 'plan:approve': plans.approve.bind(plans),
  'plan:revoke': plans.revoke.bind(plans), 'plan:archive': plans.archive.bind(plans), 'plan:import': plans.import.bind(plans), 'plan:export': plans.export.bind(plans),
  'fs:files': async (cwd: string, query: string) => (await search.files(cwd, query)).files, 'fs:slash': slashCommands,
  'fs:list': async (dir: string) => (await documents.list(dir)).map((e) => ({ name: e.name, isDir: e.isDirectory })),
  'fs:read': async (path: string) => ({ text: (await documents.read(dirname(path), path)).text, binary: false, truncated: false }),
  'image:preview': async (path: string) => {
    const ext = basename(path).split('.').pop()?.toLowerCase();
    if (!ext || !['png', 'gif', 'jpeg', 'jpg', 'webp'].includes(ext)) throw new Error('Bildformat wird nicht unterstützt');
    const bytes = await readFile(path);
    return 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + bytes.toString('base64');
  },
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let frame: { id: number; channel: string; args: unknown[] };
  try { frame = JSON.parse(line); } catch { return; }
  const { id, channel, args } = frame;
  void (async () => {
    if (!Object.hasOwn(routes, channel) || !Array.isArray(args)) throw new Error('Im Tauri-Desktop noch nicht verfügbar: ' + channel);
    const handler = routes[channel as keyof typeof routes] as (...args: unknown[]) => unknown;
    const result = await handler(...args);
    send({ id, result: result ?? null });
  })().catch((error) => send({ id, error: String(error) }));
});
lines.on('close', () => {
  host.dispose();
  for (const stop of watchers.values()) {
    stop();
  }
  killAllTerminals();
  plans.close();
  void Promise.allSettled([shutdownOllama(), lsp.dispose()]).finally(() => process.exit(0));
});
