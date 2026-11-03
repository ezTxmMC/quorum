import assert from 'node:assert/strict';
import { recoverChats } from '../shared/chat-host/recovery.ts';
import { applyEvent } from '../src/lib/reduce.ts';
const snapshot = { id: 'chat', title: 'Example', cwd: '/tmp', provider: 'claude', options: {}, providerSessions: {}, createdAt: 1, updatedAt: 2,
  messages: [{ id: 'user', role: 'user', blocks: [{ kind: 'text', text: 'hello' }], createdAt: 2 }, { id: 'assistant', role: 'assistant', blocks: [], createdAt: 3 }] };
const job = { runId: 'run', chatId: 'chat', messageId: 'assistant', provider: 'claude', title: 'Example', createdAt: 3, snapshot,
  state: { status: 'running', sequence: 3, heartbeat: Date.now() } };
const empty = recoverChats([], {}, [job]);
assert.equal(empty.sessions[0].messages.length, 2, 'launch snapshot restores unsaved initial messages');
assert.equal(empty.runs.run.messageId, 'assistant');
assert.equal(empty.cursors.run, 0);
const early = recoverChats([{ ...snapshot, messages: [snapshot.messages[0]] }], {}, [job]);
assert.equal(early.sessions[0].messages.length, 2, 'restore missing assistant into existing chat');
let partial = applyEvent(snapshot.messages[1], { type: 'text', delta: 'hello' });
partial = { ...partial, workerRunId: 'run', workerSequence: 1 };
const resumed = recoverChats([{ ...snapshot, messages: [snapshot.messages[0], partial] }], {}, [job]);
assert.equal(resumed.cursors.run, 1);
assert.equal(resumed.sessions[0].messages[1].blocks[0].text, 'hello', 'already persisted text is retained');
const doneMessage = { ...partial, workerSequence: 3, workerDone: true };
assert.deepEqual(recoverChats([{ ...snapshot, messages: [snapshot.messages[0], doneMessage] }], {}, [{ ...job, state: { ...job.state, status: 'completed' } }]).cursors, {});
assert.equal(recoverChats([], {}, [{ ...job, forgotten: true }]).sessions.length, 0, 'deleted chats stay deleted');
assert.equal(recoverChats([], {}, [{ ...job, acknowledged: true }]).sessions.length, 0, 'compacted old messages are not resurrected');
assert.equal(recoverChats(snapshot.messages ? [snapshot] : [], {}, [job]).sessions[0].messages.length, 2);
const acknowledgedElsewhere = recoverChats([{ ...snapshot, messages: [snapshot.messages[0], partial] }], { run: { sessionId: 'chat', messageId: 'assistant', provider: 'claude' } }, [{ ...job, acknowledged: true, snapshot: undefined }]);
assert.equal(acknowledgedElsewhere.cursors.run, 1, 'another window acknowledging a run does not strand a local partial response');
const final = recoverChats([{ ...snapshot, messages: [snapshot.messages[0], doneMessage] }], { run: { sessionId: 'chat', messageId: 'assistant', provider: 'claude' } }, [{ ...job, state: { ...job.state, status: 'completed' } }]);
assert.equal(final.runs.run, undefined, 'a completed durable message cannot keep a stale running badge');
console.log('Chat recovery: initial snapshots, missing messages, durable cursors, completed runs, deletion and compaction passed.');
