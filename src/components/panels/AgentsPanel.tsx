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
import { detectAgents, isActive, type AgentInfo, type AgentStatus } from '@shared/subagents';
import { cx } from '../ui';

type Tool = Extract<Block, { kind: 'tool' }>;

const toolsOf = (messages: Message[]): Tool[] => messages.flatMap((m) => m.blocks.filter((b): b is Tool => b.kind === 'tool'));

const STATUS: Record<AgentStatus, { label: string; icon: string; tone: string }> = {
  running: { label: 'Arbeitet', icon: 'lucide:loader-circle', tone: 'text-accent' },
  background: { label: 'Läuft im Hintergrund', icon: 'lucide:loader-circle', tone: 'text-accent' },
  done: { label: 'Fertig', icon: 'lucide:circle-check', tone: 'text-ok' },
  failed: { label: 'Fehlgeschlagen', icon: 'lucide:circle-x', tone: 'text-bad' },
  stopped: { label: 'Gestoppt', icon: 'lucide:square', tone: 'text-subtle' },
  ended: { label: 'Mit dem Lauf beendet', icon: 'lucide:circle-dashed', tone: 'text-subtle' },
};

interface AgentCardProps {
  agent: AgentInfo;
  onStop: () => void;
}

/** Ein Sub-Agent: Status, Art, aktueller Schritt – aufklappbar mit Auftrag, Schritten und Ergebnis. */
function AgentCard({ agent, onStop }: AgentCardProps) {
  const [open, setOpen] = useState(false);
  const status = STATUS[agent.status];
  const active = isActive(agent);
  return (
    <div className={cx('mb-1.5 rounded-lumen border bg-surface/60', active ? 'border-accent/40' : 'border-edge')} style={{ marginLeft: agent.depth * 14 }}>
      <div className="flex items-start gap-2 px-2.5 py-2">
        <Icon name={status.icon} size={14} className={cx('mt-0.5 shrink-0', status.tone, active && 'spin')} />
        <button className="min-w-0 flex-1 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="block truncate font-medium text-fg" title={agent.title}>{agent.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-subtle">
            <span className={status.tone}>{t(status.label)}</span>
            {agent.type && <span className="rounded-full bg-active px-1.5 text-[10px] text-muted">{agent.type}</span>}
            <span>· {agent.steps.length} {t('Schritte')}</span>
          </span>
          {active && agent.activity && <span className="mt-1 block truncate font-mono text-[10.5px] text-muted" title={agent.activity}>{agent.activity}</span>}
        </button>
        {active && <button className="icon-btn !size-6 shrink-0 text-bad" aria-label={t('Zugehörigen Lauf stoppen')} title={t('Zugehörigen Lauf stoppen')} onClick={onStop}><Icon name="lucide:square" size={11} /></button>}
        <button className="icon-btn !size-6 shrink-0" aria-label={t('Details')} onClick={() => setOpen(!open)}><Icon name={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={12} /></button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-edge/70 px-2.5 py-2 text-[11.5px]">
          {agent.prompt && <AgentDetail title={t('Auftrag')} text={agent.prompt} />}
          {agent.steps.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-subtle">{t('Schritte')}</div>
              <ol className="max-h-40 space-y-0.5 overflow-y-auto">
                {agent.steps.map((step) => (
                  <li key={step.id} className="flex items-center gap-1.5 truncate text-muted">
                    <Icon name={step.running ? 'lucide:loader-circle' : step.isError ? 'lucide:x' : 'lucide:check'} size={11} className={cx('shrink-0', step.running ? 'spin text-accent' : step.isError ? 'text-bad' : 'text-ok')} />
                    <span className="truncate" title={toolSummary(step)}><span className="text-subtle">{step.name}</span> {toolSummary(step) === step.name ? '' : toolSummary(step)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {agent.result && <AgentDetail title={t('Ergebnis')} text={agent.result} />}
          {!agent.result && agent.status === 'ended' && <p className="text-subtle">{t('Der Agent lief im Hintergrund; ein Ergebnis wurde in diesem Lauf nicht mehr gemeldet.')}</p>}
        </div>
      )}
    </div>
  );
}

function AgentDetail({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-subtle">{title}</div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lumen-sm border border-edge bg-bg p-2 font-mono text-[11px] text-muted">{text}</pre>
    </div>
  );
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
  const [showFinished, setShowFinished] = useState(false);

  if (!session && !run) {
    return <div className="p-4 text-muted">{t('Öffne einen Chat oder ein Team, um dessen Agenten und Hintergrundaufgaben zu sehen.')}</div>;
  }

  const messages = session ? session.messages : run!.turns.map((turn) => turn.message);
  const liveIds = session
    ? new Set(Object.values(activeRuns).filter((r) => r.sessionId === session.id).map((r) => r.messageId))
    : new Set(run!.turns.filter((turn) => turn.running).map((turn) => turn.message.id));
  const agents = detectAgents(messages, liveIds);
  const agentTools = new Set(agents.flatMap((agent) => [agent.id, ...agent.steps.map((step) => step.id)]));
  const tools = toolsOf(messages).filter((tool) => !agentTools.has(tool.id));
  const liveTools = new Set(toolsOf(messages.filter((m) => liveIds.has(m.id))));
  const background = tools.filter((tool) => tool.running && liveTools.has(tool));
  const finished = tools.filter((tool) => !background.includes(tool));
  const members: TaskRowData[] = run ? run.turns.map((turn) => {
    const member = run.config.agents.find((entry) => entry.id === turn.agentId);
    return {
      key: turn.turnId, label: member?.name ?? turn.agentId, sub: `${member?.role ?? ''} · ${toolsOf([turn.message]).length} ${t('Schritte')}`, running: turn.running, failed: turn.ok === false,
      stopped: !turn.running && turn.ok === undefined, output: messageText(turn.message) || turn.message.error, provider: member?.provider, onStop: () => void hub.multiStopTurn(run.id, turn.turnId),
    };
  }) : [];

  function stopOwner(messageId: string) {
    if (session) {
      useHub.getState().cancel(session.id);
      return;
    }
    const turn = run!.turns.find((entry) => entry.message.id === messageId);
    if (turn) {
      void hub.multiStopTurn(run!.id, turn.turnId);
    }
  }

  function stopBackground() {
    const owner = messages.find((m) => m.blocks.includes(background.at(-1)!));
    if (owner) {
      stopOwner(owner.id);
    }
  }

  return (
    <div key={session?.id ?? run?.id} className="h-full overflow-y-auto p-2 text-[12.5px]">
      {run && (
        <Section title={t('Team')} count={members.length} running={members.filter((member) => member.running).length}>
          {members.length === 0 && <div className="px-2 py-1.5 text-subtle">{t('Noch keine Agenten gestartet.')}</div>}
          {members.slice().reverse().map((member) => <TaskRow key={member.key} task={member} agent />)}
        </Section>
      )}

      <Section title={t('Sub-Agenten')} count={agents.length} running={agents.filter(isActive).length}>
        {agents.length === 0 && <div className="px-2 py-1.5 text-subtle">{t('Keine Sub-Agenten in diesem Verlauf.')}</div>}
        {orderAgents(agents).map((agent) => <AgentCard key={agent.id} agent={agent} onStop={() => stopOwner(agent.messageId)} />)}
      </Section>

      <Section title={t('Hintergrundaufgaben')} count={background.length} running={background.length}>
        {!background.length && <div className="px-2 py-1.5 text-subtle">{t('Keine laufenden Hintergrundaufgaben.')}</div>}
        {!!background.length && <div className="px-2 py-1.5"><ToolActivity blocks={background} onStop={stopBackground} /></div>}
      </Section>

      {finished.length > 0 && (
        <div>
          <button className="flex w-full items-center gap-2 rounded-lumen-sm px-1.5 py-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle hover:bg-hover" aria-expanded={showFinished} onClick={() => setShowFinished(!showFinished)}>
            <Icon name={showFinished ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={11} />
            {t('Abgeschlossene Aufgaben')}
            <span className="rounded-full bg-active px-1.5 text-[10px] normal-case tracking-normal text-muted">{finished.length}</span>
          </button>
          {showFinished && finished.slice().reverse().map((tool, index) => (
            <TaskRow key={`${tool.id}:${index}`} task={{ key: tool.id, label: toolSummary(tool), sub: tool.name, running: false, failed: tool.isError, stopped: tool.output === undefined && !tool.isError, output: tool.output }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Aktive Agenten zuerst, danach die neuesten; verschachtelte Agenten bleiben direkt unter ihrem Elternteil. */
function orderAgents(agents: AgentInfo[]): AgentInfo[] {
  const roots = agents.filter((agent) => !agent.parent).reverse().sort((a, b) => Number(isActive(b)) - Number(isActive(a)));
  const childrenOf = (id: string): AgentInfo[] => agents.filter((agent) => agent.parent === id).flatMap((child) => [child, ...childrenOf(child.id)]);
  return roots.flatMap((root) => [root, ...childrenOf(root.id)]);
}
