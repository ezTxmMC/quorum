import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChatWorkerBootstrap, ChatWorkerCommand } from '../../shared/chat-host/types';
import type { HubEvent } from '../../shared/types';
import { setDataDirResolver } from '../store';
import { cancelAll, cancelRun, injectMessage, runCli } from '../providers/runner';
import { configureApi } from '../providers/api';
import { configureAcp } from '../providers/acp';
import { shutdownOllama } from '../providers/ollama-management';
import { setOllamaSettings as configureOllama } from '../providers/ollama';
import { setPythonRoot } from '../runtimes/pyworker';
import { setLlamaBinary } from '../runtimes/llamacpp';
import { scheduler } from '../runtimes/scheduler';
import { cancelAllChatModeling, runChatModeling } from '../3d/chat-model';
import { chatMode } from '../../shared/chat-modes';

let bootstrap: ChatWorkerBootstrap | undefined;
let finished = false;
let cancelling = false;
const input = createInterface({ input: process.stdin, terminal: false });
function prefix(text: string, limit: number): string {
  const last = text.charCodeAt(limit - 1);
  const end = limit < text.length && last >= 0xD800 && last <= 0xDBFF ? limit - 1 : limit;
  return text.slice(0, end);
}
function* chunks(text: string): Generator<string> {
  let offset = 0;
  while (offset < text.length) {
    const chunk = prefix(text.slice(offset), 16_000);
    yield chunk;
    offset += chunk.length;
  }
}
function boundedInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') { return value.length > 2048 ? `${prefix(value, 2048)}…` : value; }
  if (depth > 6 || value === null || typeof value !== 'object') { return value; }
  if (Array.isArray(value)) { return value.slice(0, 50).map((item) => boundedInput(item, depth + 1)); }
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, boundedInput(item, depth + 1)]));
}
function writeEvent(event: HubEvent | { type: 'worker_ready' }): void {
  if (process.stdout.writableLength > 32_000_000) { throw new Error('Chat output queue exceeded 32 MB'); }
  const line = JSON.stringify(event, (_key, value: unknown) => typeof value === 'string' ? value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�') : value);
  if (line.length > 2_000_000) { throw new Error('Chat event exceeded 2 MB'); }
  process.stdout.write(`${line}\n`);
}
const emit = (event: HubEvent) => {
  if (finished) { return; }
  if (event.type === 'text' || event.type === 'thinking') {
    for (const delta of chunks(event.delta)) { writeEvent({ ...event, delta }); }
    return;
  }
  if (event.type === 'text_full' && event.text.length > 16_000) {
    let first = true;
    for (const chunk of chunks(event.text)) {
      writeEvent(first ? { type: 'text_full', text: chunk } : { type: 'text', delta: chunk });
      first = false;
    }
    return;
  }
  if (event.type === 'tool_start') { writeEvent({ ...event, input: boundedInput(event.input) }); return; }
  if (event.type === 'tool_end') { writeEvent({ ...event, output: event.output.length > 16000 ? `${prefix(event.output, 16000)}\n… Ausgabe gekürzt` : event.output }); return; }
  writeEvent(event);
};

async function cancel(): Promise<void> {
  if (cancelling) { return; }
  cancelling = true;
  cancelAllChatModeling();
  if (bootstrap) { cancelRun(bootstrap.request.runId); }
  cancelAll();
}
let terminationTimer: ReturnType<typeof setTimeout> | undefined;
function terminate(): void {
  void cancel();
  if (terminationTimer) { return; }
  terminationTimer = setTimeout(() => {
    if (process.platform !== 'win32' && bootstrap?.processGroup === process.pid) {
      try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
      return;
    }
    process.exit(1);
  }, 4500);
  terminationTimer.unref();
}
async function run(value: ChatWorkerBootstrap): Promise<void> {
  setDataDirResolver(() => value.dataRoot);
  process.env.QUORUM_CHAT_WORKER = '1';
  process.env.QUORUM_PYTHON_DIR = value.pythonRoot;
  configureApi(() => value.settings.apiConnections ?? [], async (id) => value.apiKeys[id]);
  configureAcp(() => value.settings.acpAgents ?? []);
  configureOllama(() => value.settings.ollama ?? {});
  setPythonRoot(value.pythonRoot);
  setLlamaBinary(() => value.settings.llamaBinary);
  scheduler.configure(value.settings.localRuntime);
  writeEvent({ type: 'worker_ready' });
  const watchdog = setInterval(() => {
    if (!value.supervisorPid) { return; }
    try { process.kill(value.supervisorPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { terminate(); } }
  }, 500);
  watchdog.unref();
  try {
    if (chatMode(value.request.options) === 'model') {
      await runChatModeling(value.request, emit, value.settings.binaries, (projectId, event) => emit({ type: 'model_progress', projectId, event }));
      return;
    }
    await runCli(value.request, emit, value.settings.binaries);
  } catch (error) {
    emit({ type: 'done', ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await Promise.allSettled([scheduler.shutdown(), shutdownOllama()]);
    clearInterval(watchdog);
    // Closing the input lets the adapter terminate after pending output and image collection have drained.
    input.close();
    process.stdin.destroy();
  }
}
input.on('line', (line) => {
  try {
    if (!bootstrap) {
      bootstrap = JSON.parse(line) as ChatWorkerBootstrap;
      void run(bootstrap).catch((error) => { emit({ type: 'done', ok: false, error: String(error) }); process.exitCode = 1; });
      return;
    }
    const command = JSON.parse(line) as ChatWorkerCommand;
    if (command.type === 'cancel') { void cancel(); }
    if (command.type === 'inject' && command.text && command.id && /^[\w-]+$/.test(command.id)) {
      const configuration = bootstrap;
      void (async () => {
        let accepted = false;
        for (let attempt = 0; attempt < 10 && !accepted && !cancelling && Date.now() < (command.expiresAt ?? 0); attempt++) {
          accepted = injectMessage(configuration.request.runId, command.text!, command.attachments);
          if (!accepted) { await new Promise((resolve) => setTimeout(resolve, 100)); }
        }
        if (accepted) { emit({ type: 'injected', text: command.text! }); }
        await fs.writeFile(join(configuration.jobDirectory, 'acks', `${command.id}.json`), JSON.stringify({ accepted }), { mode: 0o600 });
      })().catch(() => undefined);
    }
  } catch { emit({ type: 'notice', level: 'warn', text: 'Ungültige Worker-Nachricht verworfen.' }); }
});
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
process.on('uncaughtException', () => {
  if (!finished) { process.stdout.write(`${JSON.stringify({ type: 'done', ok: false, error: 'Chat-Worker wurde wegen eines internen Fehlers beendet.' })}\n`); }
  finished = true;
  cancelAll();
  process.exitCode = 1;
  input.close();
  process.stdin.destroy();
  setTimeout(() => process.exit(1), 4000);
});
