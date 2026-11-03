import { stageChatRuntime, type DurableChatRuntime } from './runtime.ts';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Attachment, Persisted, RunEnvelope, RunRequest } from '../../shared/types';
import type { ChatJob, ChatJobState, ChatJournalEvent, ChatWorkerBootstrap } from '../../shared/chat-host/types';

const ID = /^[\w-]{1,100}$/;
const terminal = (state: ChatJobState): boolean => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state.status);
interface Watcher { emit: (events: RunEnvelope[]) => void; cursors: Record<string, number>; offsets: Map<string, { offset: number; tail: string; decoder: StringDecoder }> }

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, path);
}

export class ChatHostManager {
  private readonly root: string;
  private readonly executable: string;
  private readonly worker: string;
  private readonly jobs = new Map<string, ChatJob>();
  private readonly watchers = new Map<number, Watcher>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private accepting = true;
  private runtime?: Promise<DurableChatRuntime>;
  private metadataWrites = Promise.resolve();
  private readonly forgottenChats = new Set<string>();
  private tombstones?: Promise<void>;
  private readonly starting = new Set<string>();
  private readonly startingChats = new Set<string>();

  constructor(root: string, executable: string, worker: string) {
    this.root = join(root, 'chat-jobs');
    this.executable = executable;
    this.worker = worker;
  }

  private directory(id: string): string {
    if (!ID.test(id)) { throw new Error('Invalid chat run ID'); }
    return join(this.root, id);
  }

  private loadTombstones(): Promise<void> {
    if (!this.tombstones) {
      this.tombstones = (async () => {
        await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
        try {
          const entries: unknown = JSON.parse(await fs.readFile(join(this.root, 'deleted-chats.json'), 'utf8'));
          if (!Array.isArray(entries)) { throw new Error('Invalid deleted-chat journal'); }
          for (const id of entries) { if (typeof id === 'string' && ID.test(id)) { this.forgottenChats.add(id); } }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
      })();
    }
    return this.tombstones;
  }

  async discover(): Promise<ChatJob[]> {
    await this.loadTombstones();
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const directories = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of directories) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !ID.test(entry.name) || this.jobs.has(entry.name)) { continue; }
      try {
        const job = JSON.parse(await fs.readFile(join(this.root, entry.name, 'meta.json'), 'utf8')) as ChatJob;
        if (job.runId !== entry.name || !job.state || typeof job.createdAt !== 'number') { continue; }
        if (job.chatId && this.forgottenChats.has(job.chatId)) { job.forgotten = true; job.snapshot = undefined; }
        this.jobs.set(job.runId, job);
        if (job.forgotten) { await this.cancel(job.runId); }
      } catch { /* Incomplete or foreign directories are never started or interpreted as commands. */ }
    }
    return (await this.list()).filter((job) => !job.forgotten).map((job) => job.acknowledged ? { ...job, snapshot: undefined } : job);
  }

  async list(): Promise<ChatJob[]> {
    for (const job of this.jobs.values()) {
      if (terminal(job.state) && job.state.status !== 'interrupted') { continue; }
      try { job.state = JSON.parse(await fs.readFile(join(this.directory(job.runId), 'state.json'), 'utf8')) as ChatJobState; }
      catch { /* Keep the last known state across an atomic update. */ }
      if (!terminal(job.state) && Date.now() - job.state.heartbeat > 15_000 && !this.starting.has(job.runId)) {
        let alive = false;
        if (job.state.pid) {
          try {
            process.kill(job.state.pid, 0); alive = true;
            if (process.platform === 'linux') {
              const stat = await fs.readFile(`/proc/${job.state.pid}/stat`, 'utf8');
              if (stat.slice(stat.lastIndexOf(')') + 1).trimStart().startsWith('Z')) { alive = false; }
            }
          }
          catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
        }
        if (!alive) { job.state = { ...job.state, status: 'interrupted' }; }
      }
    }
    return [...this.jobs.values()].sort((left, right) => left.createdAt - right.createdAt);
  }

  pauseStarts(): void { this.accepting = false; }
  resumeStarts(): void { this.accepting = true; }

  async launch(request: RunRequest, configuration: Omit<ChatWorkerBootstrap, 'request' | 'jobDirectory'>): Promise<void> {
    if (!this.accepting) { throw new Error('Quorum wird geschlossen. Es werden keine weiteren Chats gestartet.'); }
    if (request.chatId && this.startingChats.has(request.chatId)) { throw new Error('Dieser Chat wird bereits gestartet.'); }
    if (request.chatId) { this.startingChats.add(request.chatId); }
    try { await this.launchIsolated(request, configuration); }
    finally { if (request.chatId) { this.startingChats.delete(request.chatId); } }
  }

  private async launchIsolated(request: RunRequest, configuration: Omit<ChatWorkerBootstrap, 'request' | 'jobDirectory'>): Promise<void> {
    await this.loadTombstones();
    if (request.chatId && this.forgottenChats.has(request.chatId)) { throw new Error('Dieser Chat wurde gelöscht.'); }
    if (!existsSync(this.executable) || !existsSync(this.worker)) { throw new Error('Chat-Worker fehlt. Bitte npm run build ausführen.'); }
    if (this.jobs.has(request.runId)) { throw new Error('Chat run already exists'); }
    const deadline = Date.now() + 8000;
    while (request.chatId && (await this.active()).some((job) => job.chatId === request.chatId)) {
      if (Date.now() > deadline) { throw new Error('Der vorherige Chat-Prozess räumt noch auf. Bitte kurz warten.'); }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const directory = this.directory(request.runId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.mkdir(join(directory, 'commands'), { mode: 0o700 });
    await fs.mkdir(join(directory, 'acks'), { mode: 0o700 });
    const job: ChatJob = {
      runId: request.runId, chatId: request.chatId, messageId: request.messageId, provider: request.provider,
      title: request.chatSnapshot?.title ?? request.prompt.slice(0, 70), createdAt: Date.now(), snapshot: request.chatSnapshot,
      state: { status: 'starting', sequence: 0, heartbeat: Date.now() },
    };
    await atomicJson(join(directory, 'meta.json'), job);
    this.jobs.set(job.runId, job);
    if (job.chatId && this.forgottenChats.has(job.chatId)) {
      job.forgotten = true; job.snapshot = undefined; job.state.status = 'cancelled';
      await this.saveMetadata(job);
      await atomicJson(join(directory, 'state.json'), job.state);
      throw new Error('Dieser Chat wurde während des Starts gelöscht.');
    }
    for (const watcher of this.watchers.values()) { watcher.cursors[job.runId] = 0; }
    this.starting.add(job.runId);
    const { chatSnapshot: _snapshot, ...isolatedRequest } = request;
    try {
      if (!this.runtime) {
        this.runtime = stageChatRuntime(configuration.dataRoot, this.executable, this.worker, configuration.pythonRoot).catch((error) => { this.runtime = undefined; throw error; });
      }
      const runtime = await this.runtime;
      const launch = JSON.stringify({ executable: process.execPath, worker: runtime.worker,
        payload: { ...configuration, pythonRoot: runtime.pythonRoot, request: isolatedRequest, jobDirectory: directory } },
        (_key, value: unknown) => typeof value === 'string' ? value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�') : value);
      if (!this.accepting) { throw new Error('Chat-Start beim Schließen abgebrochen.'); }
      if (Buffer.byteLength(launch) > 32_000_000) { throw new Error('Chat-Anfrage überschreitet 32 MB. Bitte den Verlauf kompaktieren.'); }
      const child = spawn(runtime.executable, [directory], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => {
          child.stdin?.once('error', reject);
          child.stdin?.end(launch, () => resolve());
        });
      });
      child.unref();
      this.arm();
    } catch (error) {
      job.state = { ...job.state, status: 'failed', sequence: 1 };
      await atomicJson(join(directory, 'state.json'), job.state);
      await fs.writeFile(join(directory, 'events.jsonl'), `${JSON.stringify({ sequence: 1, event: { type: 'done', ok: false, error: String(error) } })}\n`, { mode: 0o600 });
      throw error;
    } finally { this.starting.delete(job.runId); }
  }

  attach(owner: number, cursors: Record<string, number>, emit: Watcher['emit']): void {
    this.watchers.set(owner, { cursors: { ...cursors }, offsets: new Map(), emit });
    this.arm();
  }

  detach(owner: number): void { this.watchers.delete(owner); }

  private arm(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => { void this.poll().catch(() => undefined); }, 100);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    if (this.polling) { return; }
    this.polling = true;
    try {
      if (![...this.watchers.values()].some((watcher) => Object.keys(watcher.cursors).length)) {
        if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
        return;
      }
      await this.list();
      for (const watcher of this.watchers.values()) {
        const batch: RunEnvelope[] = [];
        for (const [runId, cursor] of Object.entries(watcher.cursors)) {
          const job = this.jobs.get(runId);
          if (!job) { continue; }
          const location = watcher.offsets.get(runId) ?? { offset: 0, tail: '', decoder: new StringDecoder('utf8') };
          let handle;
          try {
            handle = await fs.open(join(this.directory(runId), 'events.jsonl'), 'r');
            const bytes = Buffer.alloc(256_000);
            const read = await handle.read(bytes, 0, bytes.length, location.offset);
            location.offset += read.bytesRead;
            const text = location.tail + location.decoder.write(bytes.subarray(0, read.bytesRead));
            const lastNewline = text.lastIndexOf('\n');
            location.tail = lastNewline < 0 ? text : text.slice(lastNewline + 1);
            if (location.tail.length > 32_000_000) { throw new Error('Invalid chat journal frame'); }
            if (lastNewline >= 0) {
              for (const line of text.slice(0, lastNewline).split('\n')) {
                if (!line) { continue; }
                const entry = JSON.parse(line) as ChatJournalEvent;
                if (!Number.isSafeInteger(entry.sequence) || !entry.event?.type || entry.sequence <= (watcher.cursors[runId] ?? cursor)) { continue; }
                batch.push({ runId, sequence: entry.sequence, event: entry.event });
                watcher.cursors[runId] = entry.sequence;
              }
            }
            if (read.bytesRead === 0 && (job.state.status === 'interrupted' || (terminal(job.state) && !!location.tail))) {
              batch.push({ runId, sequence: Math.max(watcher.cursors[runId] ?? 0, job.state.sequence) + 1, event: { type: 'done', ok: false, error: 'Chat-Prozess wurde unterbrochen. Kein automatischer Neustart.' } });
              delete watcher.cursors[runId];
            }
            if (read.bytesRead === 0 && terminal(job.state)) { delete watcher.cursors[runId]; }
            watcher.offsets.set(runId, location);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || terminal(job.state)) {
              batch.push({ runId, sequence: Math.max(watcher.cursors[runId] ?? 0, job.state.sequence) + 1, event: { type: 'done', ok: false, error: 'Chat-Protokoll konnte nicht gelesen werden.' } });
              delete watcher.cursors[runId];
            }
          } finally { await handle?.close(); }
          if (batch.length >= 2000) { break; }
        }
        if (batch.length) { watcher.emit(batch); }
      }
    } finally { this.polling = false; }
  }

  async cancel(runId: string): Promise<void> {
    if (!this.jobs.has(runId)) { return; }
    await fs.writeFile(join(this.directory(runId), 'stop'), '', { mode: 0o600 });
  }

  async inject(runId: string, text: string, attachments: Attachment[] = []): Promise<boolean> {
    const job = this.jobs.get(runId);
    if (!job || job.provider !== 'claude' || terminal(job.state)) { return false; }
    const id = randomUUID();
    const directory = this.directory(runId);
    await atomicJson(join(directory, 'commands', `${Date.now()}-${id}.json`), { type: 'inject', id, text, attachments, expiresAt: Date.now() + 2500 });
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const accepted = JSON.parse(await fs.readFile(join(directory, 'acks', `${id}.json`), 'utf8')) as { accepted: boolean };
        await fs.rm(join(directory, 'acks', `${id}.json`), { force: true });
        return accepted.accepted === true;
      } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    throw new Error('Zustellung nicht bestätigt. Bitte den Chat-Verlauf prüfen, bevor die Nachricht erneut gesendet wird.');
  }

  private saveMetadata(job: ChatJob): Promise<void> {
    const operation = this.metadataWrites.catch(() => undefined).then(() => atomicJson(join(this.directory(job.runId), 'meta.json'), job));
    this.metadataWrites = operation;
    return operation;
  }

  async acknowledge(data: Persisted): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.acknowledged || !job.chatId || !job.messageId) { continue; }
      const message = data.sessions.find((session) => session.id === job.chatId)?.messages.find((item) => item.id === job.messageId);
      if (!message?.workerDone || message.workerRunId !== job.runId) { continue; }
      const snapshot = job.snapshot;
      job.acknowledged = true;
      job.snapshot = undefined;
      try { await this.saveMetadata(job); }
      catch (error) { job.acknowledged = false; if (!job.forgotten) { job.snapshot = snapshot; } throw error; }
    }
    await this.metadataWrites;
  }

  async forgetChat(chatId: string): Promise<void> {
    if (!ID.test(chatId)) { throw new Error('Invalid chat ID'); }
    await this.loadTombstones();
    this.forgottenChats.add(chatId);
    const tombstone = this.metadataWrites.catch(() => undefined).then(() => atomicJson(join(this.root, 'deleted-chats.json'), [...this.forgottenChats]));
    this.metadataWrites = tombstone;
    await tombstone;
    for (const job of this.jobs.values()) {
      if (job.chatId !== chatId) { continue; }
      await this.cancel(job.runId);
      job.forgotten = true;
      job.snapshot = undefined;
      await this.saveMetadata(job);
      for (const watcher of this.watchers.values()) { delete watcher.cursors[job.runId]; }
    }
  }

  async prepareDetach(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const jobs = await this.active();
      if (!this.starting.size && jobs.every((job) => job.state.workerReady)) { return; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Die Chat-Worker sind noch nicht für die Hintergrundausführung bereit. Quorum bleibt geöffnet.');
  }

  async active(): Promise<ChatJob[]> { return (await this.list()).filter((job) => !terminal(job.state)); }

  async stopAll(): Promise<void> {
    const accepting = this.accepting;
    this.accepting = false;
    try {
      const active = await this.active();
      await Promise.all(active.map((job) => this.cancel(job.runId)));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (!(await this.active()).length) { return; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Einige Chat-Prozesse haben den Stopp noch nicht bestätigt.');
    } finally { this.accepting = accepting; }
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.watchers.clear();
  }
}
