import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatHostManager } from '../electron/chat-host/manager.ts';
const root = await mkdtemp(join(tmpdir(), 'quorum-host-manager-'));
const directory = join(root, 'chat-jobs', 'run');
await mkdir(directory, { recursive: true });
const state = { status: 'completed', sequence: 2, heartbeat: Date.now() };
const job = { runId: 'run', chatId: 'chat', messageId: 'message', provider: 'claude', title: 'Test', createdAt: Date.now(), state };
await writeFile(join(directory, 'meta.json'), JSON.stringify(job));
await writeFile(join(directory, 'state.json'), JSON.stringify(state));
const text = 'Grüße 🌍'.repeat(70_000);
await writeFile(join(directory, 'events.jsonl'), [JSON.stringify({ sequence: 1, event: { type: 'text', delta: text } }), JSON.stringify({ sequence: 2, event: { type: 'done', ok: true } }), ''].join('\n'));
const manager = new ChatHostManager(root, '/missing-host', '/missing-worker');
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'journal replay timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
try {
  assert.equal((await manager.discover()).length, 1);
  const first = [];
  manager.attach(1, { run: 0 }, (events) => first.push(...events));
  await waitFor(() => first.some((entry) => entry.event.type === 'done'));
  assert.equal(first.length, 2);
  assert.equal(first[0].event.delta, text, 'UTF-8 survives bounded reads that split code points and JSON frames');
  const second = [];
  manager.attach(2, { run: 1 }, (events) => second.push(...events));
  await waitFor(() => second.some((entry) => entry.event.type === 'done'));
  assert.equal(second.length, 1, 'durable cursor skips already applied output');
  await manager.acknowledge({ sessions: [{ id: 'chat', messages: [{ id: 'message', workerRunId: 'run', workerSequence: 2, workerDone: true }] }] });
  assert.equal(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')).acknowledged, true);
  await manager.forgetChat('chat');
  assert.equal((await manager.discover()).length, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8')).forgotten, true);
  manager.pauseStarts();
  await assert.rejects(manager.launch({ runId: 'other' }, {}), /geschlossen/);
  manager.resumeStarts();
  await assert.rejects(manager.launch({ runId: 'other' }, {}), /Worker fehlt/);
  console.log('Chat manager: bounded UTF-8 replay, durable cursors, acknowledgements, deletion and missing binaries passed.');
} finally { manager.dispose(); await rm(root, { recursive: true, force: true }); }
