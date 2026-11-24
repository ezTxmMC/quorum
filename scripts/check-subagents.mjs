import assert from 'node:assert/strict';
import { detectAgents, isActive, isAgentTool } from '../shared/subagents.ts';

const tool = (id, name, input, extra = {}) => ({ kind: 'tool', id, name, input, running: false, output: 'ok', ...extra });
const message = (id, blocks) => ({ id, role: 'assistant', blocks, createdAt: 0 });
const live = new Set(['live']);

assert.ok(isAgentTool(tool('a', 'Task', { description: 'x', prompt: 'y', subagent_type: 'Explore' }), false));
assert.ok(isAgentTool(tool('a', 'mcp__srv__spawn_agent', { prompt: 'y' }), false), 'namespaced names');
assert.ok(isAgentTool(tool('a', 'collab:spawn_agent', { prompt: 'y' }), false));
assert.ok(isAgentTool(tool('a', 'whatever', { subagent_type: 'general' }), false), 'agent type in the input is enough');
assert.ok(isAgentTool(tool('a', 'Bash', { command: 'ls' }), true), 'a tool with child calls is an agent container');
assert.ok(!isAgentTool(tool('a', 'TaskCreate', { subject: 'todo' }), false), 'todo tools are not agents');
assert.ok(!isAgentTool(tool('a', 'TaskOutput', { task_id: 'abc12345' }), false), 'result polling is not an agent');
assert.ok(!isAgentTool(tool('a', 'task', { id: 3 }), false), 'the bare name without an assignment is not enough');
assert.ok(!isAgentTool(tool('a', 'Bash', { command: 'agent --run', description: 'x', prompt: 'y' }), false));

const foreground = detectAgents([message('live', [
  tool('t1', 'Task', { description: 'Suche Stellen', prompt: 'Finde alle…', subagent_type: 'Explore' }, { running: true, output: undefined }),
  tool('c1', 'Grep', { pattern: 'foo' }, { parentId: 't1' }),
  tool('c2', 'Read', { file_path: 'a.ts' }, { parentId: 't1', running: true, output: undefined }),
  tool('n1', 'Task', { description: 'Unteragent', prompt: 'p' }, { parentId: 't1', running: true, output: undefined }),
  tool('n2', 'Bash', { command: 'ls' }, { parentId: 'n1' }),
])], live);
assert.equal(foreground.length, 2);
assert.deepEqual([foreground[0].status, foreground[0].type, foreground[0].title, foreground[0].steps.length, foreground[0].depth], ['running', 'Explore', 'Suche Stellen', 4, 0]);
assert.ok(foreground[0].activity.startsWith('Bash') || foreground[0].activity.startsWith('Task') || foreground[0].activity.startsWith('Read'));
assert.deepEqual([foreground[1].parent, foreground[1].depth, foreground[1].steps.length], ['t1', 1, 1]);

const launch = tool('b1', 'Agent', { description: 'Hintergrund', prompt: 'p', run_in_background: true }, { output: 'Async agent launched successfully. agentId: a1b2c3d4e5' });
assert.deepEqual(detectAgents([message('live', [launch])], live).map((a) => [a.status, a.agentId, a.result]), [['background', 'a1b2c3d4e5', undefined]]);
assert.equal(detectAgents([message('old', [launch])], live)[0].status, 'ended', 'the run is over and no result was reported');
const polled = message('live', [launch, tool('p1', 'TaskOutput', { task_id: 'a1b2c3d4e5' }, { output: 'status: running' })]);
assert.equal(detectAgents([polled], live)[0].status, 'background', 'a poll that says "still running" does not finish the agent');
const finished = message('live', [launch, tool('p1', 'TaskOutput', { task_id: 'a1b2c3d4e5' }, { output: 'Fertig: 3 Treffer' })]);
assert.deepEqual(detectAgents([finished], live).map((a) => [a.status, a.result]), [['done', 'Fertig: 3 Treffer']]);
const stopped = message('live', [launch, tool('s1', 'TaskStop', { task_id: 'a1b2c3d4e5' })]);
assert.equal(detectAgents([stopped], live)[0].status, 'stopped');
const notified = message('live', [launch, { kind: 'text', text: 'Agent a1b2c3d4e5 completed.' }]);
assert.equal(detectAgents([notified], live)[0].status, 'done');

assert.equal(detectAgents([message('old', [tool('x', 'Task', { prompt: 'p' }, { running: true, output: undefined })])], live)[0].status, 'stopped', 'interrupted mid-run');
assert.equal(detectAgents([message('old', [tool('x', 'Task', { prompt: 'p' }, { isError: true })])], live)[0].status, 'failed');
assert.deepEqual(detectAgents([message('live', [launch, tool('z', 'Task', { prompt: 'p' })])], live).map(isActive), [true, false]);
