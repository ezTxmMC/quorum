import assert from 'node:assert/strict';
import { compactionPrompt, compactionSummary, estimateTokens, handoff, planCompaction, transcript, workDigest } from '../shared/chat-context.ts';

let id = 0;
const user = (text) => ({ id: `m${id++}`, role: 'user', blocks: [{ kind: 'text', text }], createdAt: 0 });
const assistant = (text, provider = 'claude', tools = []) => ({ id: `m${id++}`, role: 'assistant', provider, blocks: [...tools, { kind: 'text', text }], createdAt: 0 });
const tool = (name, input) => ({ kind: 'tool', id: `t${id++}`, name, input, output: 'ok', running: false });

const messages = [
  user('Bau ein Login mit Passwort-Reset.'),
  assistant('Login steht.', 'claude', [tool('Edit', { file_path: 'src/login.ts' }), tool('Bash', { command: 'npm   test' }), tool('Edit', { file_path: 'src/login.ts' })]),
  user('Jetzt der Reset.'),
  assistant('Reset steht.', 'claude', [tool('apply_patch', '*** Begin Patch\n*** Update File: src/reset.ts\n*** Add File: src/mail.ts\n'), tool('Read', { file_path: 'README.md' })]),
  user('Danke, und Tests?'),
  assistant('Tests laufen.', 'claude', [tool('shell', { command: ['npm', 'run', 'lint'] })]),
];

const digest = workDigest(messages);
assert.deepEqual(digest.files, ['src/login.ts', 'src/reset.ts', 'src/mail.ts'], 'edited files once, patches parsed, reads ignored');
assert.deepEqual(digest.commands, ['npm test', 'npm run lint'], 'commands normalised');
assert.ok(estimateTokens(messages) > 0);

const long = [user('ZIEL: Shop bauen'), ...Array.from({ length: 30 }, (_, i) => (i % 2 ? assistant(`Antwort ${i} ${'x'.repeat(400)}`) : user(`Frage ${i} ${'y'.repeat(400)}`)))];
const cut = transcript(long, 'de', 3000);
assert.ok(cut.text.startsWith('Nutzer: ZIEL: Shop bauen'), 'the original goal survives the budget');
assert.ok(cut.omitted > 0 && cut.text.includes('ältere Nachrichten ausgelassen'));
assert.ok(cut.text.includes('Antwort 29'), 'newest messages are kept');
assert.ok(!cut.text.includes('Frage 2 '), 'old messages fall out');

const plan = planCompaction(messages, 30);
assert.equal(plan.tail[0].role, 'user', 'kept tail starts at a user message');
assert.equal(plan.head.length + plan.tail.length, messages.length);
assert.ok(plan.tail.length >= 2);
assert.equal(planCompaction(messages, 1_000_000).head.length, 0, 'a short chat has nothing to compact');

const prompt = compactionPrompt(plan.head, 'de', 50_000, 'die Mail-Anbindung');
assert.ok(prompt.includes('## Ziel') && prompt.includes('## Offen') && prompt.includes('Achte besonders auf: die Mail-Anbindung'));
assert.ok(compactionSummary('## Ziel\n- Login', plan.head, 'de').includes('- src/login.ts'), 'exact file list is appended');
assert.equal(compactionSummary(' nur Text ', [user('a')], 'de'), 'nur Text');

const given = handoff(messages, 'codex', 'de', 20_000, '/proj');
assert.equal(given.from, 'claude');
assert.equal(given.messages, 6);
assert.ok(given.text.includes('von einem anderen Assistenten (claude)') && given.text.includes('Projektordner: /proj') && given.text.includes('- src/mail.ts'));
assert.ok(given.text.trimEnd().endsWith('[Aktuelle Nachricht des Nutzers:]'));
assert.ok(handoff(messages, 'codex', 'en', 20_000).text.includes('Continue seamlessly'));
assert.equal(handoff([], 'codex', 'de', 1000), undefined);
