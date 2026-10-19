import assert from 'node:assert/strict';
import { applyEvent } from '../src/lib/reduce.ts';
import { activeToolActivity, toolKind } from '../src/lib/toolActivity.ts';
import { currentMode, modePatch, modesFor, modelLabel, modelEfforts, IMAGE_ENGINES, isChatModel } from '../shared/catalog.ts';
import { buildClaude } from '../electron/providers/claude.ts';
import { buildCodex } from '../electron/providers/codex.ts';
import { buildOpenCode } from '../electron/providers/opencode.ts';
import { runOllama, ollamaStatus } from '../electron/providers/ollama.ts';
import { buildAntigravity } from '../electron/providers/antigravity.ts';

const req = (provider, options) => ({ runId: 'check', provider, cwd: '/tmp', prompt: 'Hello', options });
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
