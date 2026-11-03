import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const MAX_MESSAGE_BYTES = 8_000_000;
const MAX_PENDING_REQUESTS = 100;
type Message = Record<string, unknown>;
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class LspRpc {
  private buffer = Buffer.alloc(0);
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onNotification: (method: string, params: unknown) => void;
  private readonly onRequest: (method: string, params: unknown) => unknown;
  private readonly onFailure: (error: Error) => void;

  constructor(child: ChildProcessWithoutNullStreams, onNotification: (method: string, params: unknown) => void,
    onRequest: (method: string, params: unknown) => unknown, onFailure: (error: Error) => void) {
    this.child = child;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onFailure = onFailure;
    child.stdout.on('data', (chunk: Buffer) => {
      try { this.receive(chunk); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdin.on('error', (error) => this.fail(error));
    child.on('error', (error) => this.fail(error));
    child.on('exit', () => this.fail(new Error('Language server exited')));
    // Drain stderr without exposing source paths or server output in application logs.
    child.stderr.on('data', () => undefined);
  }

  private send(message: Message): void {
    if (this.closed) {
      throw new Error('Language server connection is closed');
    }
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    if (body.length > MAX_MESSAGE_BYTES || this.child.stdin.writableLength > MAX_MESSAGE_BYTES) {
      throw new Error('Language server message queue limit exceeded');
    }
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed || this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('Language server is unavailable or busy'));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        try { this.notify('$/cancelRequest', { id }); } catch { /* Connection already closed. */ }
        reject(new Error(`Language server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (this.buffer.length > 8192) { throw new Error('Invalid LSP header'); }
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthHeader = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
      const length = Number(lengthHeader?.[1]);
      if (!lengthHeader || headerEnd > 8192 || !Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
        throw new Error('Invalid LSP message length');
      }
      const messageEnd = headerEnd + 4 + length;
      if (this.buffer.length < messageEnd) { return; }
      const message: unknown = JSON.parse(this.buffer.subarray(headerEnd + 4, messageEnd).toString('utf8'));
      this.buffer = this.buffer.subarray(messageEnd);
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('Invalid LSP message');
      }
      this.dispatch(message as Message);
    }
  }

  private dispatch(message: Message): void {
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        try { this.send({ id: message.id, result: this.onRequest(message.method, message.params) }); }
        catch { this.send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } }); }
        return;
      }
      this.onNotification(message.method, message.params);
      return;
    }
    const pending = this.pending.get(Number(message.id));
    if (!pending) { return; }
    clearTimeout(pending.timeout);
    this.pending.delete(Number(message.id));
    if (message.error) {
      // Server errors can include source text. Keep the application error bounded and generic.
      pending.reject(new Error('Language server could not answer the request'));
      return;
    }
    pending.resolve(message.result);
  }

  private fail(error: Error): void {
    if (this.closed) { return; }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.onFailure(error);
  }

  dispose(): void {
    this.fail(new Error('Language server connection closed'));
  }
}
