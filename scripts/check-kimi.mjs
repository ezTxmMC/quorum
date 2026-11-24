import assert from 'node:assert/strict';
import { API_PRESETS } from '../shared/api-presets.ts';
import { KIMI_MODELS, PROVIDERS, modelLabel, modesFor } from '../shared/catalog.ts';
import { apiCost, priceFor } from '../shared/pricing.ts';
import { KimiParser, buildKimi } from '../electron/providers/kimi.ts';

const kimiPreset = API_PRESETS.find((preset) => preset.name === 'Kimi AI');
assert.ok(kimiPreset, 'Kimi AI API preset exists');
assert.equal(kimiPreset.baseUrl, 'https://api.moonshot.ai/v1');
assert.deepEqual(kimiPreset.models, ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3', 'kimi-k3-256k']);

assert.equal(PROVIDERS.kimi.bin, 'kimi');
assert.ok(KIMI_MODELS.some((model) => model.id === 'kimi-k3.1-pro'));
assert.ok(KIMI_MODELS.some((model) => model.id === 'kimi-k3'));
assert.deepEqual(modesFor('kimi'), ['ask', 'edit', 'auto', 'full']);

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
assert.deepEqual(built.args.slice(0, 10), [
  '--print',
  '--output-format',
  'stream-json',
  '--model',
  'kimi-k3.1-pro',
  '--thinking',
  '--yolo',
  '--session',
  'sess-42',
  '-p',
]);
assert.match(built.args[10], /Be concise/);
assert.match(built.args[10], /@\/tmp\/shot\.png/);
assert.match(built.args[10], /Explain this module/);

const builtAuto = buildKimi({
  runId: 'r2',
  provider: 'kimi',
  cwd: '/tmp',
  prompt: 'Fix tests',
  options: { effort: 'low', fullAccess: true },
  resume: { continueLast: true },
});
assert.ok(builtAuto.args.includes('--no-thinking'));
assert.ok(builtAuto.args.includes('--auto'));
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
