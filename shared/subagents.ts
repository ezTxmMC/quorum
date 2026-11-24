import type { Block, Message } from './types';

type ToolBlock = Extract<Block, { kind: 'tool' }>;

/** running = arbeitet im Vordergrund, background = läuft im Hintergrund weiter, ended = Hintergrund-Agent ohne gemeldetes Ergebnis, als der Lauf endete. */
export type AgentStatus = 'running' | 'background' | 'done' | 'failed' | 'stopped' | 'ended';

export interface AgentInfo {
  /** ID des Werkzeugaufrufs, der den Agenten gestartet hat. */
  id: string;
  tool: string;
  /** Art des Agenten (z. B. „Explore“, „browser“), wenn der Anbieter sie nennt. */
  type?: string;
  title: string;
  prompt?: string;
  status: AgentStatus;
  background: boolean;
  /** Vom Anbieter vergebene Kennung, über die spätere Aufrufe (Ergebnis abholen, stoppen) den Agenten ansprechen. */
  agentId?: string;
  /** Übergeordneter Agent bei verschachtelten Agenten. */
  parent?: string;
  depth: number;
  steps: ToolBlock[];
  /** Was der Agent gerade tut bzw. zuletzt getan hat. */
  activity?: string;
  result?: string;
  messageId: string;
}

const AGENT_NAME = /^(task|agent|subagent|sub_agent|spawn_agent|spawn_subagent|invoke_subagent|browser_subagent|define_subagent|create_subagent|use_subagent|delegate|delegate_task|dispatch_agent|run_agent|launch_agent|call_agent|agent_tool|new_task)$/i;
const RESULT_NAME = /^(taskoutput|task_output|agentoutput|agentoutputtool|agent_output|wait|wait_agent|get_agent_result|check_agent)$/i;
const STOP_NAME = /^(taskstop|task_stop|killshell|kill_shell|close_agent|stop_agent|cancel_agent|kill_agent)$/i;
const NOT_AN_AGENT = /bash|shell|command|exec|edit|write|read|grep|glob|search|fetch/i;
const AGENT_INPUT_KEYS = ['prompt', 'description', 'subagent_type', 'agent_type', 'agent', 'instructions', 'message', 'Task', 'TaskName', 'task'];
const LAUNCHED = /async agent launched|agent (was |has been )?(launched|started|spawned)|running in the background|started in the background|spawn(ed)? (successfully|agent)|launched successfully/i;
const STILL_RUNNING = /\b(still running|not (yet )?(complete|completed|finished|done)|in[_ ]progress|status["':\s]+running|timed out waiting)\b/i;
const FINISHED_NOTE = /\b(completed|finished|done|failed|stopped|killed)\b/i;
const AGENT_ID = /(?:agent[_ ]?id|agentId|task[_ ]?id|taskId|thread[_ ]?id|receiver_thread_ids?)["'\]:=\s[]+([\w-]{6,})/i;
const TITLE_CAP = 90;

/** Werkzeugname ohne Server-/Namensraum-Präfix („mcp__x__task“, „collab:spawn_agent“, „functions.agent“). */
function baseName(name: string): string {
  return name.split(/__|[:./]/).filter(Boolean).pop() ?? name;
}

function record(tool: ToolBlock): Record<string, unknown> {
  return tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input) ? (tool.input as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Ein Werkzeugaufruf startet einen Agenten, wenn mindestens eines zutrifft: andere Aufrufe hängen an ihm (parentId),
 * die Eingabe nennt einen Agententyp, oder der Name ist ein bekannter Agenten-Starter und die Eingabe sieht nach einem
 * Auftrag aus. Der Name allein reicht nicht – „task“ heißt bei manchen Servern auch ein gewöhnliches Werkzeug.
 */
export function isAgentTool(tool: ToolBlock, hasChildren: boolean): boolean {
  const name = baseName(tool.name);
  if (RESULT_NAME.test(name) || STOP_NAME.test(name)) {
    return false;
  }
  if (hasChildren) {
    return true;
  }
  const input = record(tool);
  if (text(input.subagent_type) || text(input.agent_type)) {
    return true;
  }
  if (AGENT_NAME.test(name)) {
    return tool.input === undefined || AGENT_INPUT_KEYS.some((key) => input[key] !== undefined);
  }
  return !NOT_AN_AGENT.test(name) && !!text(input.prompt) && !!text(input.description) && /agent/i.test(name);
}

function titleOf(tool: ToolBlock): string {
  const input = record(tool);
  const prompt = text(input.prompt) ?? text(input.instructions) ?? text(input.message) ?? text(input.Task) ?? text(input.task);
  const firstLine = prompt?.split('\n')[0];
  const title = text(input.description) ?? text(input.TaskName) ?? text(input.title) ?? firstLine ?? text(input.subagent_type) ?? baseName(tool.name);
  return title.length > TITLE_CAP ? `${title.slice(0, TITLE_CAP)}…` : title;
}

function typeOf(tool: ToolBlock): string | undefined {
  const input = record(tool);
  const named = text(input.subagent_type) ?? text(input.agent_type) ?? text(input.agent);
  if (named) {
    return named;
  }
  return /browser/i.test(tool.name) ? 'browser' : undefined;
}

function summary(tool: ToolBlock): string {
  const input = record(tool);
  const value = ['description', 'command', 'cmd', 'CommandLine', 'pattern', 'query', 'file_path', 'path', 'url', 'prompt'].map((key) => text(input[key])).find(Boolean);
  return value ? `${tool.name}: ${value.replace(/\s+/g, ' ').slice(0, 120)}` : tool.name;
}

function isBackground(tool: ToolBlock): boolean {
  if (tool.isError) {
    return false;
  }
  return record(tool).run_in_background === true || /spawn/i.test(baseName(tool.name)) || (tool.output !== undefined && LAUNCHED.test(tool.output.slice(0, 400)));
}

function agentIdOf(tool: ToolBlock): string | undefined {
  const fromOutput = tool.output ? AGENT_ID.exec(tool.output.slice(0, 600))?.[1] : undefined;
  const receivers = record(tool).agents;
  return fromOutput ?? (Array.isArray(receivers) && typeof receivers[0] === 'string' ? receivers[0] : undefined);
}

interface Follow {
  status: AgentStatus;
  result?: string;
}

/** Sucht nach dem Start eines Hintergrund-Agenten die Aufrufe und Meldungen, die ihn über seine Kennung ansprechen. */
function followUp(agentId: string, later: Block[]): Follow | undefined {
  let found: Follow | undefined;
  for (const block of later) {
    if (block.kind === 'tool' && JSON.stringify(block.input ?? '').includes(agentId)) {
      const name = baseName(block.name);
      if (STOP_NAME.test(name)) {
        found = { status: 'stopped' };
      }
      if (RESULT_NAME.test(name) && block.output !== undefined && !STILL_RUNNING.test(block.output.slice(0, 300))) {
        found = { status: block.isError ? 'failed' : 'done', result: block.output };
      }
    }
    if ((block.kind === 'text' || block.kind === 'inject') && block.text.includes(agentId) && FINISHED_NOTE.test(block.text)) {
      found = found ?? { status: /failed/i.test(block.text) ? 'failed' : 'done' };
    }
  }
  return found;
}

function statusOf(tool: ToolBlock, live: boolean, background: boolean, follow: Follow | undefined): AgentStatus {
  if (tool.isError) {
    return 'failed';
  }
  if (tool.running) {
    return live ? 'running' : 'stopped';
  }
  if (background) {
    return follow?.status ?? (live ? 'background' : 'ended');
  }
  return tool.output === undefined ? 'stopped' : 'done';
}

function descendants(id: string, children: Map<string, ToolBlock[]>): ToolBlock[] {
  return (children.get(id) ?? []).flatMap((child) => [child, ...descendants(child.id, children)]);
}

/** Alle Agenten eines Verlaufs in Startreihenfolge, mit Status, Schritten und Ergebnis. */
export function detectAgents(messages: Message[], liveMessageIds: ReadonlySet<string>): AgentInfo[] {
  const blocks = messages.flatMap((message) => message.blocks.map((block) => ({ block, messageId: message.id })));
  const tools = blocks.filter((entry): entry is { block: ToolBlock; messageId: string } => entry.block.kind === 'tool');
  const children = new Map<string, ToolBlock[]>();
  for (const { block } of tools) {
    if (block.parentId) {
      children.set(block.parentId, [...(children.get(block.parentId) ?? []), block]);
    }
  }
  const agentIds = new Set(tools.filter(({ block }) => isAgentTool(block, children.has(block.id))).map(({ block }) => block.id));
  const byId = new Map(tools.map(({ block }) => [block.id, block]));

  function parentAgent(tool: ToolBlock): string | undefined {
    for (let parent = tool.parentId; parent; parent = byId.get(parent)?.parentId) {
      if (agentIds.has(parent)) {
        return parent;
      }
    }
    return undefined;
  }

  function depthOf(tool: ToolBlock): number {
    const parent = parentAgent(tool);
    return parent ? depthOf(byId.get(parent)!) + 1 : 0;
  }

  return tools.filter(({ block }) => agentIds.has(block.id)).map(({ block, messageId }) => {
    const live = liveMessageIds.has(messageId);
    const background = isBackground(block);
    const agentId = agentIdOf(block);
    const position = blocks.findIndex((entry) => entry.block === block);
    const follow = background && agentId ? followUp(agentId, blocks.slice(position + 1).map((entry) => entry.block)) : undefined;
    const steps = descendants(block.id, children);
    const status = statusOf(block, live, background, follow);
    const lastStep = [...steps].reverse().find((step) => step.running) ?? steps.at(-1);
    return {
      id: block.id, tool: block.name, type: typeOf(block), title: titleOf(block), prompt: text(record(block).prompt) ?? text(record(block).instructions),
      status, background, agentId, parent: parentAgent(block), depth: depthOf(block), steps,
      activity: lastStep ? summary(lastStep) : undefined,
      result: follow?.result ?? (background && status !== 'failed' ? undefined : block.output),
      messageId,
    };
  });
}

export function isActive(agent: AgentInfo): boolean {
  return agent.status === 'running' || agent.status === 'background';
}
