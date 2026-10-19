import { useState } from 'react';
import type { ProviderId } from '@shared/types';
import { useMatch } from 'react-router-dom';
import type { Block, Message } from '@shared/types';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { hub } from '@/lib/api';
import { ToolActivity } from '../ToolActivity';
import { Dot } from '../ModelPicker';
import { toolSummary } from '@/lib/toolActivity';
import { messageText } from '@/lib/reduce';

type Tool = Extract<Block, { kind: 'tool' }>;

const SUBAGENT = /(?:^|[:./])(?:task|agent|spawn_agent|invoke_subagent|browser_subagent|define_subagent|subagent)$/i;
const toolsOf = (messages: Message[]): Tool[] => messages.flatMap((m) => m.blocks.filter((b): b is Tool => b.kind === 'tool'));
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function describe(b: Tool): string {
  const i = (b.input ?? {}) as Record<string, unknown>;
  return str(i.description) ?? str(i.subagent_type) ?? str(i.prompt)?.slice(0, 90) ?? str(i.Task) ?? b.name;
}
function Section({ title, count, running, children }: { title: string; count: number; running?: number; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 px-1.5 pb-1 pt-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle">
        {title}<span className="rounded-full bg-active px-1.5 text-[10px] normal-case tracking-normal text-muted">{count}</span>
        {!!running && <span className="flex items-center gap-1 normal-case tracking-normal text-accent"><span className="pulse-dot size-1.5 rounded-full bg-accent" />{running} {t('läuft')}</span>}
      </div>
      {children}
    </div>
  );
}

interface TaskRowData {
  key: string;
  label: string;
  sub: string;
  running: boolean;
  failed?: boolean;
  stopped?: boolean;
  provider?: ProviderId;
  output?: string;
  onStop?: () => void;
}

function TaskRow({ task, agent = false }: { task: TaskRowData; agent?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const status = task.running ? t('Läuft') : task.failed ? t('Fehlgeschlagen') : task.stopped ? t('Gestoppt') : t('Fertig');
  const hasOutput = !!task.output;
  return <div className="rounded-lumen-sm hover:bg-hover">
    <div className="flex items-center gap-1 px-2 py-1.5">
      {task.provider ? <Dot id={task.provider} size={7} /> : <Icon name={agent ? 'lucide:bot' : 'lucide:terminal'} size={14} className="shrink-0 text-muted" />}
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" disabled={!hasOutput}
        aria-expanded={hasOutput ? expanded : undefined} onClick={() => setExpanded(!expanded)}>
        <span className="min-w-0 flex-1"><span className="block truncate" title={task.label}>{task.label}</span><span className="block truncate text-[11px] text-subtle">{status} · {task.sub}</span></span>
        <Icon name={task.running ? 'lucide:loader-circle' : task.failed ? 'lucide:circle-x' : task.stopped ? 'lucide:square' : 'lucide:circle-check'} size={14}
          className={`shrink-0 ${task.running ? 'spin text-accent' : task.failed ? 'text-bad' : task.stopped ? 'text-subtle' : 'text-ok'}`} />
        {hasOutput && <Icon name={expanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={12} className="shrink-0 text-subtle" />}
      </button>
      {task.running && task.onStop && <button className="icon-btn !size-6 shrink-0 text-bad" aria-label={t('Zugehörigen Lauf stoppen')} title={t('Zugehörigen Lauf stoppen')} onClick={task.onStop}><Icon name="lucide:square" size={11} /></button>}
    </div>
    {expanded && hasOutput && <pre className="mx-2 mb-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lumen-sm border border-edge bg-bg p-2 font-mono text-[11px] text-muted">{task.output}</pre>}
  </div>;
}

/** Rechts/links andockbares Panel: Sub-Agenten und Hintergrundaufgaben (Edits, Bash, Befehle) des aktuellen Chats bzw. Teams. */
export function AgentsPanel() {
  const chat = useMatch('/chat/:id');
  const multi = useMatch('/multi/:id');
  const session = useHub((s) => s.data.sessions.find((x) => x.id === chat?.params.id));
  const activeRuns = useHub((s) => s.runs);
  const run = useHub((s) => s.data.multiRuns.find((x) => x.id === multi?.params.id));

  let tools: Tool[] = [];
  let liveTools: Tool[] = [];
  const owners = new Map<Tool, string>();
  let agents: TaskRowData[] = [];

  if (session) {
    tools = toolsOf(session.messages);
    const messageIds = new Set(Object.values(activeRuns).filter((r) => r.sessionId === session.id).map((r) => r.messageId));
    liveTools = toolsOf(session.messages.filter((m) => messageIds.has(m.id)));
    agents = tools.filter((b) => !b.parentId && SUBAGENT.test(b.name)).map((b) => ({
      key: b.id, label: describe(b), running: b.running && liveTools.includes(b), failed: b.isError, stopped: !(b.running && liveTools.includes(b)) && b.output === undefined && !b.isError, output: b.output,
      onStop: () => useHub.getState().cancel(session.id),
      sub: `${b.name} · ${tools.filter((c) => c.parentId === b.id).length} ${t('Schritte')}`,
    }));
  } else if (run) {
    const all = run.turns;
    tools = toolsOf(all.map((x) => x.message));
    for (const turn of all.filter((x) => x.running)) {
      for (const tool of toolsOf([turn.message])) { liveTools.push(tool); owners.set(tool, turn.turnId); }
    }
    agents = all.map((x) => {
      const a = run.config.agents.find((y) => y.id === x.agentId);
      return { key: x.turnId, label: a?.name ?? x.agentId, sub: `${a?.role ?? ''} · ${toolsOf([x.message]).length} ${t('Schritte')}`, running: x.running, failed: x.ok === false, stopped: !x.running && x.ok === undefined, output: messageText(x.message) || x.message.error, provider: a?.provider, onStop: () => { void hub.multiStopTurn(run.id, x.turnId); } };
    });
  }

  const background = liveTools.filter((b) => b.running && !(SUBAGENT.test(b.name) && !b.parentId));
  const finished = tools.filter((b) => !(b.running && liveTools.includes(b)) && !(SUBAGENT.test(b.name) && !b.parentId));
  const latest = background.at(-1);
  const stopBackground = () => {
    if (session) useHub.getState().cancel(session.id);
    else if (run && latest) { const turnId = owners.get(latest); if (turnId) void hub.multiStopTurn(run.id, turnId); }
  };

  if (!session && !run) return <div className="p-4 text-muted">{t('Öffne einen Chat oder ein Team, um dessen Agenten und Hintergrundaufgaben zu sehen.')}</div>;

  return (
    <div key={session?.id ?? run?.id} className="h-full overflow-y-auto p-2 text-[12.5px]">
      <Section title={t('Agenten')} count={agents.length} running={agents.filter((a) => a.running).length}>
        {agents.length === 0 && <div className="px-2 py-1.5 text-subtle">{session ? t('Keine Sub-Agenten in diesem Chat.') : t('Noch keine Agenten gestartet.')}</div>}
        {agents.slice().reverse().map((a) => <TaskRow key={a.key} task={a} agent />)}
      </Section>

      <Section title={t('Hintergrundaufgaben')} count={background.length + finished.length} running={background.length}>
        {!background.length && <div className="px-2 py-1.5 text-subtle">{t('Keine laufenden Hintergrundaufgaben.')}</div>}
        {!!background.length && <div className="px-2 py-1.5"><ToolActivity blocks={background} onStop={stopBackground} /></div>}
        {!!finished.length && <div className="px-2 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Abgeschlossene Aufgaben')} · {finished.length}</div>}
        {finished.slice().reverse().map((b, index) => <TaskRow key={`${b.id}:${index}`} task={{
          key: b.id, label: toolSummary(b), sub: b.name, running: false, failed: b.isError,
          stopped: b.output === undefined && !b.isError, output: b.output,
        }} />)}
      </Section>
    </div>
  );
}
