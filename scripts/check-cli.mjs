// Kommandozeile: Argument-Parser und (wenn gebaut) Einmal-Antwort mit einem Fake-Provider – ohne echte Modellaufrufe.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../cli/args.ts';
import { applyInbox } from '../shared/inbox.ts';

const tmp = mkdtempSync(join(tmpdir(), 'quorum-cli-'));
const dir = join(tmp, 'mein projekt');
mkdirSync(dir);
writeFileSync(join(dir, 'a.txt'), 'x');

let a = parseArgs([dir], '/');
assert.equal(a.folder, dir, 'folder positional (with space)');
a = parseArgs([join(dir, 'a.txt')], '/');
assert.equal(a.folder, dir, 'file opens its folder');
a = parseArgs(['--tray', '--no-sandbox', '--user-data-dir=/x'], '/');
assert.ok(a.tray && !a.unknown.length && !a.errors.length, 'tray + chromium switches are not errors');
a = parseArgs(['--tui', '-P', 'codex', '-m', 'm1', '--permission=plan', '-C', dir], '/');
assert.deepEqual([a.tui, a.provider, a.model, a.permission, a.folder], [true, 'codex', 'm1', 'plan', dir]);
a = parseArgs(['-p', '-', 'Review', 'this'], '/');
assert.deepEqual([a.print, a.rest], ['-', ['Review', 'this']], 'extra words belong to the prompt');
assert.ok(parseArgs(['/definitely/not/here'], '/').errors.length, 'missing path is an error');
assert.ok(parseArgs(['-m'], '/').errors.length, 'missing value is an error');
assert.deepEqual(parseArgs(['--bogus'], '/').unknown, ['--bogus']);

// Teilen mit der App: Posteingang legt Chats an, ergänzt idempotent und verliert nichts.
const empty = { version: 1, settings: {}, recentProjects: [], projects: [], hidden: ['/x'], dismissed: [], sessions: [], multiRuns: [], presets: [] };
const msg = (id, role, text) => ({ id, role, blocks: [{ kind: 'text', text }], createdAt: 5 });
const entry = { v: 1, chat: { id: 'c1', title: 'T', cwd: '/x', provider: 'claude', options: {}, providerSessions: { claude: 's1' }, createdAt: 1 }, messages: [msg('m1', 'user', 'hi'), msg('m2', 'assistant', 'yo')] };
let d = applyInbox(empty, entry);
assert.equal(d.sessions.length, 1);
assert.deepEqual([d.projects, d.hidden, d.recentProjects], [['/x'], [], ['/x']], 'folder is registered and unhidden');
assert.equal(applyInbox(d, entry), d, 'applying the same entry twice changes nothing');
d = applyInbox(d, { ...entry, messages: [msg('m3', 'user', 'more')] });
assert.deepEqual(d.sessions[0].messages.map((m) => m.id), ['m1', 'm2', 'm3']);

const bundle = new URL('../dist-cli/quorum.mjs', import.meta.url).pathname;
if (existsSync(bundle)) {
  const bin = join(tmp, 'fake');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
cat >/dev/null
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Hallo vom Fake"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Hallo vom Fake","session_id":"s1"}'
`);
  chmodSync(join(bin, 'claude'), 0o755);
  const env = { ...process.env, QUORUM_DATA_DIR: tmp, PATH: `${bin}:${process.env.PATH}` };
  const r = spawnSync(process.execPath, [bundle, '-p', 'hi', '-P', 'claude'], { env, encoding: 'utf8', input: '', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Hallo vom Fake/);
  assert.equal(spawnSync(process.execPath, [bundle, '-p', ''], { env, input: '', encoding: 'utf8' }).status, 2, 'empty prompt exits 2');
  console.log('Print-mode check passed (fake provider).');

  // ACP: ein Fake-Agent spricht JSON-RPC über stdio (initialize, session/new, Updates, Berechtigungsfrage, prompt-Ergebnis).
  const agentPath = join(tmp, 'fake-acp.mjs');
  writeFileSync(agentPath, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
let promptId = null, permId = 900;
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (m.method === 'session/new') out({ id: m.id, result: { sessionId: 'acp-1' } });
  else if (m.method === 'session/prompt') {
    promptId = m.id;
    out({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hallo ACP' } } } });
    out({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Datei lesen', kind: 'read', status: 'pending' } } });
    out({ id: permId, method: 'session/request_permission', params: { sessionId: 'acp-1', toolCall: { toolCallId: 't1', title: 'Datei schreiben' }, options: [{ optionId: 'yes', name: 'Ja', kind: 'allow_once' }, { optionId: 'no', name: 'Nein', kind: 'reject_once' }] } });
  } else if (m.id === permId) {
    out({ method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok:' + m.result.outcome.optionId } }] } } });
    out({ id: promptId, result: { stopReason: 'end_turn' } });
  }
});
`);
  chmodSync(agentPath, 0o755);
  writeFileSync(join(tmp, 'hub.json'), JSON.stringify({ settings: { acpAgents: [{ id: 'fake', name: 'Fake', command: agentPath, args: [] }] } }));
  const acp = spawnSync(process.execPath, [bundle, '-p', 'hi', '-P', 'acp', '-m', 'fake', '--json'], { env, encoding: 'utf8', input: '', timeout: 30000 });
  assert.equal(acp.status, 0, acp.stderr);
  const ev = acp.stdout.trim().split('\n').map((x) => JSON.parse(x));
  assert.ok(ev.some((e) => e.type === 'text' && e.delta === 'Hallo ACP'), 'agent text arrives');
  assert.ok(ev.some((e) => e.type === 'tool_start' && e.id === 't1'), 'tool call arrives');
  assert.ok(ev.some((e) => e.type === 'tool_end' && e.output === 'ok:no'), 'permission request is rejected in read-only mode');
  assert.ok(ev.some((e) => e.type === 'session' && e.sessionId === 'acp-1'));
  console.log('ACP check passed (fake agent).');
}
console.log('CLI checks passed: argument parsing, folder/file resolution, chromium switches, prompt words.');
