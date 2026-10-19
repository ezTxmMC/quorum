import assert from 'node:assert/strict';
import { applyEvent } from '../src/lib/reduce.ts';
import { activeToolActivity, currentActivity, toolKind } from '../src/lib/toolActivity.ts';
import { quotaMeters } from '../src/lib/usageMeters.ts';
import { currentMode, modePatch, modesFor, modelLabel, modelEfforts, IMAGE_ENGINES, isChatModel, CLAUDE_MODELS, canonicalModel, modelChoices, selectModelOptions } from '../shared/catalog.ts';
import { buildClaude, ClaudeParser } from '../electron/providers/claude.ts';
import { buildCodex, CodexParser } from '../electron/providers/codex.ts';
import { buildOpenCode } from '../electron/providers/opencode.ts';
import { runOllama, ollamaStatus } from '../electron/providers/ollama.ts';
import { buildAntigravity } from '../electron/providers/antigravity.ts';

const req = (provider, options) => ({ runId: 'check', provider, cwd: '/tmp', prompt: 'Hello', options });
const quotaFixture = [
  'Current session', 'Current week (all models)', 'Current week (Fable only)',
  'Last 24h · these are independent characteristics of your usage, not a breakdown',
  'Last 24 hours', 'Daily usage', 'Current week (Sonnet only)', 'Unknown statistic',
].map((label, i) => ({ label, percent: i < 3 ? 20 : 99, kind: 'used' }));
assert.deepEqual(quotaMeters('claude', quotaFixture), quotaFixture.slice(0, 3));
assert.equal(Math.max(...quotaMeters('claude', quotaFixture).map((m) => m.percent)), 20);
assert.equal(quotaMeters('antigravity', quotaFixture), quotaFixture);
assert.equal(quotaMeters('codex', quotaFixture), quotaFixture);
assert.equal(quotaMeters('claude', [{ label: 'Fable', group: 'Current week', percent: 10, kind: 'used' }]).length, 1);
const builders = { claude: buildClaude, codex: buildCodex, antigravity: buildAntigravity };
for (const provider of Object.keys(builders)) {
  for (const mode of modesFor(provider)) {
    const options = modePatch(provider, mode);
    assert.equal(currentMode(provider, options), mode, `${provider}: ${mode} roundtrip`);
    const args = builders[provider](req(provider, options)).args;
    const bypass = args.some((a) => a === '--dangerously-skip-permissions' || a === '--dangerously-bypass-approvals-and-sandbox');
    assert.equal(bypass, mode === 'full', `${provider}: bypass only in full access`);
    if (provider === 'codex' && mode !== 'full') {
      assert(args.includes('workspace-write'));
      assert(args.includes(`approval_policy="${options.approvalPolicy}"`));
    }
    // Changing from full access must remove all rights from the previous mode.
    const changed = { ...modePatch(provider, 'full'), ...options };
    assert.equal(currentMode(provider, changed), mode);
  }
}
assert.equal(isChatModel('gpt-reserve'), false);
assert.equal(isChatModel('codex-auto-review'), false);
assert.equal(isChatModel('opencode/gpt-reserve'), false);
assert.equal(isChatModel('gpt-6.1-sol'), true);
assert.equal(currentMode('codex', { sandbox: 'read-only' }), 'plan');
assert.equal(currentMode('antigravity', { permission: 'allow-commands' }), 'full');
assert.equal(currentMode('claude', { permission: 'bypassPermissions' }), 'full');
const raw = { id: 'opencode/deepseek-v4.1-flash-free', label: 'opencode/deepseek-v4.1-flash-free' };
assert.equal(modelLabel(raw), 'DeepSeek v4.1 Flash · Free');
assert.equal(raw.id, 'opencode/deepseek-v4.1-flash-free');
assert.equal(modelLabel({ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }), 'GPT-6.1-Sol');
assert.deepEqual(modelEfforts('codex', { id: 'test', label: 'Test', efforts: ['low', 'ultra'] }), ['low', 'ultra']);
assert.deepEqual(modelEfforts('codex', { id: 'test', label: 'Test', efforts: [] }), []);
assert.deepEqual(modelEfforts('antigravity'), ['low', 'medium', 'high']);
assert(buildClaude(req('claude', { effort: 'xhigh' })).args.includes('xhigh'));
assert(buildCodex(req('codex', { effort: 'ultra' })).args.includes('model_reasoning_effort="ultra"'));
const agy = buildAntigravity(req('antigravity', { model: 'a-model', effort: 'low' })).args;
assert(agy.includes('a-model'));
assert(!agy.includes('a-model-low'));
assert(agy.includes('--effort'));
assert(agy.includes('low'));
assert(buildAntigravity(req('antigravity', { model: 'a-model-high' })).args.includes('a-model-high'));
assert.equal(IMAGE_ENGINES.find((e) => e.id === 'nano-banana-2').model, 'gemini-3.1-flash-image');
assert.equal(IMAGE_ENGINES.find((e) => e.id === 'gpt-image-2.5-sunburst').model, 'gpt-image-2.5-sunburst');
const command = { kind: 'tool', id: 'cmd', name: 'exec_command', input: { cmd: 'npm run build' }, running: true };
const search = { kind: 'tool', id: 'search', name: 'Grep', input: { pattern: 'TODO' }, running: true };
assert.equal(activeToolActivity([]), null);
assert.deepEqual(activeToolActivity([command, search]), { count: 2, kind: 'search', summary: 'TODO' });
assert.equal(activeToolActivity([command, { ...search, running: false }]).summary, 'npm run build');
assert.equal(activeToolActivity([{ ...command, running: false }]), null);
assert.equal(activeToolActivity([{ ...command, input: { command: 'echo\nhello' } }]).summary, 'echo hello');
assert.equal(toolKind('apply_patch'), 'edit');
assert.equal(toolKind('read_file'), 'read');
const stopped = applyEvent({ id: 'm', role: 'assistant', createdAt: 0, blocks: [command] }, { type: 'done', ok: false, error: 'Abgebrochen' });
assert.equal(activeToolActivity(stopped.blocks), null);
assert.equal(stopped.error, 'Abgebrochen');
assert.deepEqual(CLAUDE_MODELS.filter((m) => !m.legacy).map((m) => m.label), ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']);
for (const id of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']) {
  assert(CLAUDE_MODELS.find((m) => m.id === id)?.legacy);
  assert(buildClaude(req('claude', { model: id })).args.includes(id));
}
assert.equal(canonicalModel('claude', 'sonnet'), 'claude-sonnet-5-5');
assert.equal(canonicalModel('ollama', 'llama:latest'), 'llama:latest');
assert(buildClaude(req('claude', { model: 'sonnet' })).args.includes('claude-sonnet-5-5'));
assert(CLAUDE_MODELS.every((m) => !m.label.includes('Latest')));
const modelStatus = { claude: { installed: true, models: [{ id: 'sonnet', label: 'Old alias label' }] }, codex: { installed: true, models: [{ id: 'gpt-text', label: 'GPT Text' }] }, antigravity: { installed: true, models: [] }, ollama: { installed: true, models: [{ id: 'flux:latest', label: 'Flux', image: true }] } };
const claudeChoices = modelChoices('claude', modelStatus);
assert.equal(claudeChoices.filter((m) => m.id === 'claude-sonnet-5-5').length, 1);
assert.equal(claudeChoices.find((m) => m.id === 'claude-sonnet-5-5').label, 'Claude Sonnet 5.5');
const choices = modelChoices('codex', modelStatus, [], true);
const imageChoice = choices.find((m) => m.imageEngine === 'gpt-image-2.5-sunburst');
assert(imageChoice?.image);
assert(choices.some((m) => m.id === 'gpt-text'));
assert(!modelChoices('codex', modelStatus).some((m) => m.imageEngine));
assert.equal(modelChoices('ollama', modelStatus, [], true).filter((m) => m.image).length, 1);
assert.equal(modelChoices('ollama', modelStatus, [], true)[0].imageEngine, 'ollama:flux:latest');
assert(!modelChoices('ollama', modelStatus).length, 'image-only models cannot be selected as text agents');
const imageOptions = selectModelOptions({ model: 'gpt-text', effort: 'high', speed: 'priority', systemPrompt: 'Keep me' }, imageChoice.id, imageChoice, imageChoice.imageEngine);
assert.equal(imageOptions.model, undefined);
assert.equal(imageOptions.imageGen, 'gpt-image-2.5-sunburst');
assert.equal(imageOptions.effort, undefined);
assert.equal(imageOptions.speed, undefined);
assert.equal(imageOptions.systemPrompt, 'Keep me');
const textOptions = selectModelOptions(imageOptions, 'gpt-text', { id: 'gpt-text', label: 'GPT Text' });
assert.equal(textOptions.model, 'gpt-text');
assert.equal(textOptions.imageGen, undefined);
assert.equal(textOptions.systemPrompt, 'Keep me');
// Live status must survive the gap between a completed tool and the next provider event.
assert.equal(currentActivity([]).kind, 'working');
assert.equal(currentActivity([{ ...command, running: false }]).kind, 'processing');
assert.equal(currentActivity([{ kind: 'thinking', text: 'Evaluating results' }]).kind, 'thinking');
assert.equal(currentActivity([{ kind: 'text', text: 'Reply' }]).kind, 'responding');
const claudeParser = new ClaudeParser();
const pushClaude = (value) => claudeParser.push(JSON.stringify(value));
const stream = (event) => pushClaude({ type: 'stream_event', event });
stream({ type: 'message_start', message: { id: 'streamed' } });
const started = stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'stream-tool', name: 'Bash', input: {} } });
assert.equal(started[0].type, 'tool_start', 'show tools before the full assistant message');
let streamingMessage = applyEvent({ id: 'live', role: 'assistant', createdAt: 0, blocks: [] }, started[0]);
assert.equal(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } }).length, 0);
const argsReady = stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"npm run build"}' } });
streamingMessage = applyEvent(streamingMessage, argsReady[0]);
assert.equal(streamingMessage.blocks.length, 1);
assert.equal(currentActivity(streamingMessage.blocks).summary, 'npm run build');
const resultEvent = pushClaude({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'stream-tool', content: 'ok' }] } })[0];
streamingMessage = applyEvent(streamingMessage, resultEvent);
assert.equal(currentActivity(streamingMessage.blocks).kind, 'processing');
const lateSnapshot = pushClaude({ type: 'assistant', message: { id: 'streamed', content: [{ type: 'tool_use', id: 'stream-tool', name: 'Bash', input: { command: 'npm run build' } }] } });
streamingMessage = applyEvent(streamingMessage, lateSnapshot[0]);
assert.equal(streamingMessage.blocks[0].running, false, 'late snapshots must not restart finished tools');
const codexParser = new CodexParser();
const pushCodex = (type, item) => codexParser.push(JSON.stringify({ type, item }));
assert.equal(pushCodex('item.started', { id: 'web', type: 'web_search', query: 'current query' })[0].type, 'tool_start');
assert.equal(pushCodex('item.completed', { id: 'web', type: 'web_search', query: 'current query' }).at(-1).type, 'tool_end');
assert.equal(pushCodex('item.started', { id: 'file', type: 'file_change', changes: [{ path: 'app.ts', kind: 'update' }] })[0].type, 'tool_start');
assert.deepEqual(pushCodex('item.started', { id: 'reason', type: 'reasoning', text: 'First' }), [{ type: 'thinking', delta: 'First' }]);
assert.deepEqual(pushCodex('item.updated', { id: 'reason', type: 'reasoning', text: 'First then second' }), [{ type: 'thinking', delta: ' then second' }]);
assert.deepEqual(pushCodex('item.completed', { id: 'reason', type: 'reasoning', text: 'First then second' }), []);
const systemPrompt = 'Answer in German. "Quoted"\nSecond line \\ path';
const instructions = `developer_instructions=${JSON.stringify(systemPrompt)}`;
assert(buildCodex(req('codex', { systemPrompt })).args.includes(instructions));
assert(buildCodex({ ...req('codex', { systemPrompt }), resume: { sessionId: 'existing' } }).args.includes(instructions));
assert(buildCodex({ ...req('codex', { systemPrompt }), review: { target: 'uncommitted' } }).args.includes(instructions));
assert(buildClaude(req('claude', { systemPrompt })).args.includes(systemPrompt));
assert(buildAntigravity(req('antigravity', { systemPrompt })).args.at(-1).startsWith(`-p=${systemPrompt}\n\n---\n\n`));
assert(buildOpenCode(req('opencode', { systemPrompt })).args.at(-1).startsWith(`${systemPrompt}\n\n`));
for (const build of [buildOpenCode, buildAntigravity]) {
  const long = build({ ...req('opencode', { systemPrompt }), prompt: 'x'.repeat(120000) }).args.at(-1);
  assert(long.includes(systemPrompt), 'instructions survive long-message clipping');
}
assert.equal(modelLabel({ id: 'qwen3:8b-Q4_K_M', label: 'qwen3:8b-Q4_K_M' }), 'qwen3:8b-Q4_K_M');
assert.equal(modelLabel({ id: 'team/model:v1.2-q4_K_M', label: 'team/model:v1.2-q4_K_M · 8B' }), 'team/model:v1.2-q4_K_M · 8B');
const originalFetch = globalThis.fetch;
try {
  const model = 'team/model:8b-q4_K_M';
  const payloads = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: model, details: { parameter_size: '8B' } }] });
    if (String(url).endsWith('/api/version')) return Response.json({ version: 'test' });
    if (String(url).endsWith('/api/show')) {
      assert.equal(JSON.parse(init.body).model, model);
      return Response.json({ capabilities: ['completion'] });
    }
    assert(String(url).endsWith('/api/chat'));
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: { content: 'Hallo' }, done: true }) + '\n');
  };
  const status = await ollamaStatus();
  assert.equal(status.models[0].id, model);
  for (const prompt of [systemPrompt, 'Changed instructions']) {
    const result = await runOllama({ ...req('ollama', { model, systemPrompt: prompt }), history: [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }] }, () => {});
    assert.equal(result.text, 'Hallo');
    const payload = payloads.at(-1);
    assert.equal(payload.model, model);
    assert.deepEqual(payload.messages, [{ role: 'system', content: prompt }, { role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }, { role: 'user', content: 'Hello' }]);
  }
} finally { globalThis.fetch = originalFetch; }
console.log('Chat control checks passed: modes, CLI arguments, effort capabilities, model naming, image targets, activity lifecycle, Ollama tags and system prompts.');
