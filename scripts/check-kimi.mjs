import assert from 'node:assert/strict';
import { API_PRESETS } from '../shared/api-presets.ts';
import { KIMI_MODELS, PROVIDERS, canonicalModel, modelChoices, modelLabel, modesFor } from '../shared/catalog.ts';
import { parseKimiModels } from '../shared/kimi-models.ts';
import { apiCost, priceFor } from '../shared/pricing.ts';
import { KimiParser, buildKimi } from '../electron/providers/kimi.ts';

const kimiPreset = API_PRESETS.find((preset) => preset.name === 'Kimi AI');
assert.ok(kimiPreset, 'Kimi AI API preset exists');
assert.equal(kimiPreset.baseUrl, 'https://api.moonshot.ai/v1');
assert.deepEqual(kimiPreset.models, ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3', 'kimi-k3-256k']);

assert.equal(PROVIDERS.kimi.bin, 'kimi');
assert.ok(KIMI_MODELS.some((model) => model.id === 'kimi-code/k3.1-pro'));
assert.ok(KIMI_MODELS.some((model) => model.id === 'kimi-code/k3'));
assert.equal(canonicalModel('kimi', 'kimi-k3.1-pro'), 'kimi-code/k3.1-pro', 'chats saved with the old CLI ids keep working');
assert.equal(canonicalModel('kimi', 'kimi-code/k3'), 'kimi-code/k3');
assert.equal(canonicalModel('api', 'kimi-k3.1-pro'), 'kimi-k3.1-pro', 'the Moonshot API keeps its own ids');

const listed = parseKimiModels(JSON.stringify({ providers: { 'managed:kimi-code': { apiKey: 'secret' } }, models: {
  'kimi-code/k3.1-pro': { provider: 'managed:kimi-code', model: 'k3.1-pro', displayName: 'K3.1 Pro', supportEfforts: ['low', 'high'] },
  'kimi-code/kimi-for-coding': { provider: 'managed:kimi-code', model: 'kimi-for-coding', displayName: 'K2.8 Preview' },
  'custom/x': { provider: 'managed:kimi-code', model: 'x' },
} }));
assert.deepEqual(listed, [
  { id: 'kimi-code/k3.1-pro', label: 'Kimi K3.1 Pro', efforts: [], group: undefined },
  { id: 'kimi-code/kimi-for-coding', label: 'Kimi K2.8 Preview', efforts: [], group: undefined },
  { id: 'custom/x', label: 'custom/x', efforts: [], group: undefined },
]);
assert.ok(!JSON.stringify(listed).includes('secret'), 'credentials never leave the parser');
assert.deepEqual(parseKimiModels('not json'), []);
assert.equal(parseKimiModels(JSON.stringify({ models: { a: { provider: 'managed:one' }, b: { provider: 'two' } } }))[0].group, 'one', 'several providers are grouped');
const dynamic = { kimi: { installed: true, models: listed } };
assert.deepEqual(modelChoices('kimi', dynamic).map((model) => model.id), ['kimi-code/k3.1-pro', 'kimi-code/kimi-for-coding', 'custom/x'], 'the CLI list replaces the built-in fallback');
assert.ok(modelChoices('kimi', {}).some((model) => model.id === 'kimi-code/k3'), 'fallback list without the CLI');
assert.deepEqual(modesFor('kimi'), ['ask'], 'prompt mode accepts no permission flags');

assert.equal(modelLabel({ id: 'kimi-k3.1-pro', label: 'kimi-k3.1-pro' }), 'Kimi K3.1 Pro');
assert.equal(modelLabel({ id: 'kimi-k3.1-pro-highspeed', label: 'kimi-k3.1-pro-highspeed' }), 'Kimi K3.1 Pro Highspeed');
assert.equal(modelLabel({ id: 'kimi-k3-256k', label: 'kimi-k3-256k' }), 'Kimi K3 256K');

assert.deepEqual(priceFor('kimi-k3.1-pro', 'api'), { in: 2, out: 10, cache: 0.2 });
assert.deepEqual(priceFor('kimi-k3', 'api'), { in: 3, out: 15, cache: 0.3 });
assert.deepEqual(priceFor(undefined, 'kimi'), { in: 2, out: 10, cache: 0.2 });
const cost = apiCost({ inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 500_000 }, 'kimi-k3.1-pro', 'api');
assert.ok(cost && Math.abs(cost.usd - 6.1) < 1e-6);

const built = buildKimi({
  runId: 'r1',
  provider: 'kimi',
  cwd: '/tmp',
  prompt: 'Explain this module',
  options: {
    model: 'kimi-k3.1-pro',
    effort: 'high',
    permission: 'yolo',
    systemPrompt: 'Be concise',
  },
  resume: { sessionId: 'sess-42' },
  images: ['/tmp/shot.png'],
});
assert.deepEqual(built.args.slice(0, 6), [
  '--output-format',
  'stream-json',
  '--model',
  'kimi-code/k3.1-pro',
  '--session',
  'sess-42',
]);
assert.equal(built.args[6], '-p');
assert.match(built.args[7], /Be concise/);
assert.match(built.args[7], /@\/tmp\/shot\.png/);
assert.match(built.args[7], /Explain this module/);
for (const removed of ['--print', '--thinking', '--no-thinking', '--yolo', '--auto']) {
  assert.ok(!built.args.includes(removed), `${removed} is rejected by the Kimi Code CLI in prompt mode`);
}

const builtAuto = buildKimi({
  runId: 'r2',
  provider: 'kimi',
  cwd: '/tmp',
  prompt: 'Fix tests',
  options: { effort: 'low', fullAccess: true, addDirs: ['/tmp/extra'] },
  resume: { continueLast: true },
});
assert.ok(!builtAuto.args.includes('--no-thinking'));
assert.deepEqual(builtAuto.args.slice(builtAuto.args.indexOf('--add-dir'), builtAuto.args.indexOf('--add-dir') + 2), ['--add-dir', '/tmp/extra']);
assert.ok(!builtAuto.args.includes('--auto'));
assert.ok(builtAuto.args.includes('--continue'));

const parser = new KimiParser();
const events = [
  ...parser.push(JSON.stringify({ type: 'assistant', session_id: 'kimi-s1', message: { content: [{ type: 'thinking', thinking: 'Checking files' }, { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] } })),
  ...parser.push(JSON.stringify({ type: 'tool_result', tool_use_id: 'call-1', content: 'ok', is_error: false })),
  ...parser.push(JSON.stringify({ type: 'content_block_delta', delta: { text: 'Done!' } })),
  ...parser.push(JSON.stringify({ type: 'result', usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 20 } })),
  ...parser.end(),
];
assert.ok(events.some((event) => event.type === 'session' && event.sessionId === 'kimi-s1'));
assert.ok(events.some((event) => event.type === 'thinking' && event.delta === 'Checking files'));
assert.ok(events.some((event) => event.type === 'tool_start' && event.id === 'call-1' && event.name === 'read_file'));
assert.ok(events.some((event) => event.type === 'tool_end' && event.id === 'call-1' && event.output === 'ok' && !event.isError));
assert.ok(events.some((event) => event.type === 'text' && event.delta === 'Done!'));
assert.ok(events.some((event) => event.type === 'usage' && event.inputTokens === 120 && event.outputTokens === 45 && event.cachedTokens === 20));

console.log('Kimi AI & Kimi Code checks passed.');
