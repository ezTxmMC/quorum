import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { LspDiagnostics, LspDocument, LspEvent, LspLanguage, LspReply, LspRequest, LspStatus } from '../../../shared/ide/lsp.ts';
import { workspacePath, workspaceRoot } from '../paths.ts';
import { LspRpc } from './rpc.ts';
import { installedServer, type ServerCommand } from './servers.ts';

interface OpenDocument { uri: string; path: string; text: string; version: number; languageId: string }
interface Session {
  root: string;
  language: LspLanguage;
  child: ChildProcessWithoutNullStreams;
  rpc: LspRpc;
  documents: Map<string, OpenDocument>;
  status: LspStatus['state'];
  capabilities: Record<string, unknown>;
  ready: Promise<LspStatus>;
  stopping?: Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) { return value as Record<string, unknown>; }
  return {};
}

export class LspManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingKills = new Set<Promise<void>>();

  private readonly emit: (event: LspEvent) => void;
  private readonly resolveServer: (language: LspLanguage) => ServerCommand;
  private readonly spawnServer: (command: ServerCommand, root: string) => ChildProcessWithoutNullStreams;

  constructor(emit: (event: LspEvent) => void, resolveServer: (language: LspLanguage) => ServerCommand = installedServer,
    spawnServer = (command: ServerCommand, root: string): ChildProcessWithoutNullStreams => spawn(command.executable, command.args, {
      cwd: root, env: command.environment, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32',
    })) {
    this.emit = emit;
    this.resolveServer = resolveServer;
    this.spawnServer = spawnServer;
  }

  private key(root: string, language: LspLanguage): string {
    if (!['typescript', 'python'].includes(language)) { throw new Error('Unsupported language server'); }
    const direct = `${root}\0${language}`;
    if (this.sessions.has(direct)) { return direct; }
    return `${workspaceRoot(root)}\0${language}`;
  }

  private publishStatus(session: Session, state: LspStatus['state'], message?: string): LspStatus {
    session.status = state;
    const status: LspStatus = { root: session.root, language: session.language, state, message };
    this.emit({ type: 'status', status });
    return status;
  }

  async start(root: string, language: LspLanguage): Promise<LspStatus> {
    const key = this.key(root, language);
    const existing = this.sessions.get(key);
    if (existing) { return existing.ready; }
    const canonical = workspaceRoot(root);
    let command: ServerCommand;
    try { command = this.resolveServer(language); }
    catch {
      const status: LspStatus = { root: canonical, language, state: 'missing', message: 'Language Server nicht installiert. Installation prüfen.' };
      this.emit({ type: 'status', status });
      return status;
    }
    const child = this.spawnServer(command, canonical);
    let activeSession: Session | undefined;
    const rpc = new LspRpc(child,
      (method, params) => { if (activeSession) { this.notification(activeSession, method, params); } },
      (method, params) => {
        if (!activeSession) { throw new Error('Language server is initializing'); }
        return this.serverRequest(activeSession, method, params);
      },
      () => {
        if (!activeSession || activeSession.status === 'stopped') { return; }
        this.publishStatus(activeSession, 'failed', 'Language Server beendet. Über Neustart erneut verbinden.');
        for (const document of activeSession.documents.values()) { this.publishDiagnostics(activeSession, document, []); }
        this.kill(activeSession);
      });
    const session: Session = {
      root: canonical, language, child, rpc, documents: new Map(), status: 'starting', capabilities: {},
      ready: Promise.resolve({ root: canonical, language, state: 'starting' }),
    };
    activeSession = session;
    this.sessions.set(key, session);
    this.publishStatus(session, 'starting');
    session.ready = this.initialize(session, command);
    return session.ready;
  }

  private async initialize(session: Session, command: ServerCommand): Promise<LspStatus> {
    try {
      const result = object(await session.rpc.request('initialize', {
        processId: process.pid, clientInfo: { name: 'Quorum', version: '1.0' },
        rootUri: pathToFileURL(session.root).href,
        workspaceFolders: [{ uri: pathToFileURL(session.root).href, name: 'Workspace' }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: true },
            completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
            hover: { contentFormat: ['markdown', 'plaintext'] }, definition: { linkSupport: true },
            publishDiagnostics: { versionSupport: true },
          },
        },
        initializationOptions: command.initializationOptions,
      }));
      if (session.status !== 'starting') { throw new Error('Language server startup cancelled'); }
      session.capabilities = object(result.capabilities);
      const encoding = session.capabilities.positionEncoding;
      if (encoding !== undefined && encoding !== 'utf-16') { throw new Error('Unsupported position encoding'); }
      session.rpc.notify('initialized', {});
      session.rpc.notify('workspace/didChangeConfiguration', { settings: this.configuration() });
      return this.publishStatus(session, 'ready');
    } catch {
      if (session.status === 'stopped') { return { root: session.root, language: session.language, state: 'stopped' }; }
      this.kill(session);
      return this.publishStatus(session, 'failed', 'Language Server konnte nicht initialisiert werden. Installation prüfen und neu starten.');
    }
  }

  private configuration(): Record<string, unknown> {
    return { python: { analysis: { diagnosticMode: 'openFilesOnly', typeCheckingMode: 'basic', autoImportCompletions: true } }, formattingOptions: { tabSize: 2, insertSpaces: true } };
  }

  private serverRequest(session: Session, method: string, params: unknown): unknown {
    if (method === 'workspace/configuration') {
      const items = object(params).items;
      if (!Array.isArray(items) || items.length > 100) { throw new Error('Invalid configuration request'); }
      return items.map((item) => {
        const section = object(item).section;
        if (typeof section !== 'string') { return this.configuration(); }
        return section.split('.').reduce<unknown>((value, key) => object(value)[key], this.configuration()) ?? null;
      });
    }
    if (method === 'workspace/workspaceFolders') { return [{ uri: pathToFileURL(session.root).href, name: 'Workspace' }]; }
    if (method === 'window/workDoneProgress/create') { return null; }
    // Never execute commands or apply workspace edits requested by a server.
    if (method === 'workspace/applyEdit') { return { applied: false, failureReason: 'Workspace edits require a reviewed proposal' }; }
    throw new Error('Unsupported server request');
  }

  private publishDiagnostics(session: Session, document: OpenDocument, diagnostics: LspDiagnostics['diagnostics']): void {
    this.emit({ type: 'diagnostics', diagnostics: { root: session.root, language: session.language, path: document.path, version: document.version, diagnostics } });
  }

  private notification(session: Session, method: string, value: unknown): void {
    if (method !== 'textDocument/publishDiagnostics' || session.status !== 'ready') { return; }
    const params = object(value);
    if (typeof params.uri !== 'string' || !Array.isArray(params.diagnostics)) { return; }
    const document = session.documents.get(params.uri);
    if (!document || (params.version !== undefined && params.version !== document.version)) { return; }
    const diagnostics = params.diagnostics.slice(0, 1000).filter((diagnostic): diagnostic is LspDiagnostics['diagnostics'][number] => {
      const item = object(diagnostic);
      const range = object(item.range);
      const start = object(range.start);
      const end = object(range.end);
      return typeof item.message === 'string' && item.message.length <= 100_000
        && [start.line, start.character, end.line, end.character].every((part) => Number.isSafeInteger(part) && Number(part) >= 0);
    });
    this.publishDiagnostics(session, document, diagnostics);
  }

  private session(root: string, language: LspLanguage): Session {
    const session = this.sessions.get(this.key(root, language));
    if (!session || session.status !== 'ready') { throw new Error('Language server is not ready'); }
    return session;
  }

  sync(input: LspDocument): void {
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 2_000_000 || !Number.isSafeInteger(input.version) || input.version < 1) {
      throw new Error('Invalid language server document');
    }
    const session = this.session(input.root, input.language);
    const path = workspacePath(input.root, input.path);
    if ((input.language === 'python' && input.languageId !== 'python') || (input.language === 'typescript' && !['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(input.languageId))) {
      throw new Error('Document language does not match server');
    }
    const uri = pathToFileURL(path).href;
    const previous = session.documents.get(uri);
    if (previous && input.version < previous.version) { throw new Error('Stale document version'); }
    if (previous && input.version === previous.version) {
      if (input.text !== previous.text) { throw new Error('Document version conflicts with server buffer'); }
      return;
    }
    const document: OpenDocument = { uri, path, version: input.version, text: input.text, languageId: input.languageId };
    const synchronization = session.capabilities.textDocumentSync;
    const syncKind = typeof synchronization === 'number' ? synchronization : object(synchronization).change;
    if (!previous) {
      session.rpc.notify('textDocument/didOpen', { textDocument: { uri, languageId: input.languageId, version: input.version, text: input.text } });
      session.documents.set(uri, document);
      return;
    }
    if (syncKind !== 1 && syncKind !== 2) { throw new Error('Language server did not negotiate document synchronization'); }
    const lines = previous.text.split(/\r\n|\r|\n/);
    const change = syncKind === 2 ? {
      range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines[lines.length - 1].length } }, text: input.text,
    } : { text: input.text };
    session.rpc.notify('textDocument/didChange', { textDocument: { uri, version: input.version }, contentChanges: [change] });
    session.documents.set(uri, document);
    this.publishDiagnostics(session, document, []);
  }

  saved(root: string, language: LspLanguage, path: string): void {
    const session = this.session(root, language);
    const uri = pathToFileURL(workspacePath(root, path)).href;
    const document = session.documents.get(uri);
    if (!document) { return; }
    const sync = object(session.capabilities.textDocumentSync);
    if (!sync.save) { return; }
    session.rpc.notify('textDocument/didSave', { textDocument: { uri }, text: object(sync.save).includeText ? document.text : undefined });
  }

  closeDocument(root: string, language: LspLanguage, path: string): void {
    const session = this.sessions.get(this.key(root, language));
    if (!session) { return; }
    const document = [...session.documents.values()].find((candidate) => candidate.path === path);
    if (!document) { return; }
    if (session.status === 'ready') { session.rpc.notify('textDocument/didClose', { textDocument: { uri: document.uri } }); }
    this.publishDiagnostics(session, document, []);
    session.documents.delete(document.uri);
  }

  async request(input: LspRequest): Promise<LspReply> {
    const session = this.session(input.root, input.language);
    if (!['completion', 'hover', 'definition', 'references'].includes(input.feature)) { throw new Error('Unsupported language feature'); }
    if (!input.position || ![input.position.line, input.position.character].every((part) => Number.isSafeInteger(part) && part >= 0)) {
      throw new Error('Invalid language server position');
    }
    const uri = pathToFileURL(workspacePath(input.root, input.path)).href;
    const document = session.documents.get(uri);
    if (!document || document.version !== input.version) { throw new Error('Stale language server request'); }
    const lines = document.text.split(/\r\n|\r|\n/);
    if (input.position.line >= lines.length || input.position.character > lines[input.position.line].length) { throw new Error('Position outside document'); }
    if (!session.capabilities[`${input.feature}Provider`]) { return { version: input.version, result: null }; }
    const result = await session.rpc.request(`textDocument/${input.feature}`, {
      textDocument: { uri }, position: input.position, context: input.feature === 'references' ? { includeDeclaration: true } : undefined,
    });
    if (session.documents.get(uri)?.version !== input.version) { throw new Error('Language server result is stale'); }
    if (input.feature === 'definition' || input.feature === 'references') {
      const locations = Array.isArray(result) ? result : result ? [result] : [];
      return { version: input.version, result: locations.slice(0, 1000).filter((location) => {
        const item = object(location);
        const uri = item.uri ?? item.targetUri;
        if (typeof uri !== 'string') { return false; }
        try { workspacePath(session.root, fileURLToPath(uri)); return true; }
        catch { return false; }
      }) };
    }
    return { version: input.version, result };
  }

  private kill(session: Session): void {
    if (!session.child.pid) { return; }
    try {
      if (process.platform === 'win32') {
        const taskkill = join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'taskkill.exe');
        const cleanup = new Promise<void>((resolve) => {
          execFile(taskkill, ['/PID', String(session.child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => {
            if (session.child.exitCode === null) { session.child.kill('SIGKILL'); }
            resolve();
          });
        });
        this.pendingKills.add(cleanup);
        void cleanup.finally(() => this.pendingKills.delete(cleanup));
        return;
      }
      process.kill(-session.child.pid, 'SIGKILL');
    } catch { /* Process group already exited. */ }
  }

  async stop(root: string, language: LspLanguage): Promise<void> {
    const key = this.key(root, language);
    const session = this.sessions.get(key);
    if (!session) { return; }
    if (session.stopping) { return session.stopping; }
    session.stopping = this.shutdown(session).finally(() => {
      if (this.sessions.get(key) === session) { this.sessions.delete(key); }
    });
    return session.stopping;
  }

  private async shutdown(session: Session): Promise<void> {
    const wasReady = session.status === 'ready';
    this.publishStatus(session, 'stopped');
    for (const document of session.documents.values()) { this.publishDiagnostics(session, document, []); }
    if (wasReady) {
      try {
        await session.rpc.request('shutdown', undefined, 1500);
        session.rpc.notify('exit');
        if (session.child.pid && session.child.exitCode === null) {
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); session.child.removeListener('exit', done); resolve(); };
            const timer = setTimeout(done, 250);
            session.child.once('exit', done);
          });
        }
      }
      catch { /* Force cleanup below after bounded graceful shutdown. */ }
    }
    this.kill(session);
    session.rpc.dispose();
    session.documents.clear();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.stop(session.root, session.language)));
    await Promise.all([...this.pendingKills]);
  }

}
