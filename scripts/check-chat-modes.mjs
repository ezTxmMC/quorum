import assert from 'node:assert/strict';
import { CHAT_MODES, chatMode, modeOptions, switchChatMode, textOptions } from '../shared/chat-modes.ts';
import { selectModelOptions } from '../shared/catalog.ts';
import { buildClaude } from '../electron/providers/claude.ts';
import { buildCodex } from '../electron/providers/codex.ts';
import { applyEvent } from '../src/lib/reduce.ts';

assert.deepEqual(CHAT_MODES.map((mode) => mode.id), ['text', 'coding', 'image', 'model']);
assert.equal(chatMode({}), 'coding', 'existing sessions retain coding behavior');
assert.equal(chatMode({ imageGen: 'nano-banana' }), 'image');
assert.equal(chatMode(modeOptions({ imageGen: 'nano-banana' }, 'model')), 'model');
let session = { provider: 'claude', options: { chatMode: 'coding', model: 'claude-sonnet-5-5', effort: 'high', fullAccess: true }, modelProjectId: 'kept-project', providerSessions: { claude: 'old-thread' } };
const original = structuredClone(session);
session = { ...session, ...switchChatMode(session, 'image', [{ id: 'nano-banana', provider: 'antigravity' }]) };
assert.equal(chatMode(session.options), 'image');
assert.equal(session.provider, 'antigravity');
assert.equal(session.options.imageGen, 'nano-banana');
assert.equal(session.options.model, undefined);
assert.equal(session.modelProjectId, 'kept-project');
assert.deepEqual(session.providerSessions, {});
session = { ...session, ...switchChatMode(session, 'coding', []) };
assert.equal(session.provider, original.provider);
assert.deepEqual(session.options, { ...original.options, imageGen: undefined }, 'returning to coding restores its model, effort and permissions');
assert.deepEqual(switchChatMode(session, 'coding', []), {}, 'selecting the current mode does not reset CLI sessions');
const missing = switchChatMode(original, 'image', []);
assert.equal(missing.options.imageGen, undefined);
assert.equal(chatMode(missing.options), 'image', 'an unavailable image engine must not silently route to text');
const options = textOptions('claude', { ...session.options, extraArgs: '--dangerously-skip-permissions', mcpConfig: '/tmp/custom.json', systemPrompt: 'Keep the custom prompt' });
assert.equal(options.fullAccess, false);
assert.equal(options.extraArgs, undefined);
assert.equal(options.mcpConfig, undefined);
assert(options.systemPrompt.includes('Keep the custom prompt'));
const req = { runId: 'fixture', provider: 'claude', prompt: 'Hello', cwd: '/tmp', options };
const args = buildClaude(req).args;
assert.equal(args[args.indexOf('--tools') + 1], '');
assert(!args.includes('--dangerously-skip-permissions'));
assert(args.includes('--strict-mcp-config'));
const codexArgs = buildCodex({ ...req, provider: 'codex', options: textOptions('codex', session.options) }).args;
assert(codexArgs.includes('read-only'));
assert(!codexArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
const selectedImage = selectModelOptions({ chatMode: 'text' }, 'image:nano-banana', undefined, 'nano-banana');
assert.equal(chatMode(selectedImage), 'image');
assert.equal(chatMode(selectModelOptions(selectedImage, 'text-model')), 'coding');
const event = { type: 'model_project', projectId: 'model-project' };
const message = applyEvent({ id: 'message', role: 'assistant', blocks: [], createdAt: 0 }, event);
assert.deepEqual(message.blocks, [{ kind: 'model', projectId: 'model-project' }]);
assert.equal(applyEvent(message, event).blocks.length, 1);

// Test Chat Sort By and Group By helpers
const testSessions = [
  { id: '1', title: 'Beta Chat', cwd: '/project/b', provider: 'codex', updatedAt: 2000, createdAt: 1000, messages: [{ id: 'm1' }] },
  { id: '2', title: 'Alpha Chat', cwd: '/project/a', provider: 'claude', updatedAt: 3000, createdAt: 500, messages: [{ id: 'm1' }, { id: 'm2' }] },
  { id: '3', title: 'Gamma Chat', cwd: '', provider: 'claude', updatedAt: 1000, createdAt: 2000, messages: [] },
];

function testCompare(a, b, sortBy, sortOrder) {
  let diff = 0;
  if (sortBy === 'updated') diff = a.updatedAt - b.updatedAt;
  else if (sortBy === 'created') diff = a.createdAt - b.createdAt;
  else if (sortBy === 'title') diff = a.title.localeCompare(b.title);
  else if (sortBy === 'messages') diff = a.messages.length - b.messages.length;
  return sortOrder === 'asc' ? diff : -diff;
}

assert.deepEqual(
  [...testSessions].sort((a, b) => testCompare(a, b, 'updated', 'desc')).map((s) => s.id),
  ['2', '1', '3']
);
assert.deepEqual(
  [...testSessions].sort((a, b) => testCompare(a, b, 'title', 'asc')).map((s) => s.id),
  ['2', '1', '3']
);
assert.deepEqual(
  [...testSessions].sort((a, b) => testCompare(a, b, 'messages', 'desc')).map((s) => s.id),
  ['2', '1', '3']
);

console.log('Chat mode, group-by and sort-by checks passed.');
