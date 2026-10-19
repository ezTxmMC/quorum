import type { ProviderId } from '@shared/types';
import { useMatch } from 'react-router-dom';
import type { Block, Message } from '@shared/types';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { hub } from '@/lib/api';
import { ToolActivity } from '../ToolActivity';
import { Dot } from '../ModelPicker';

type Tool = Extract<Block, { kind: 'tool' }>;

const SUBAGENT = /^(task|agent|invoke_subagent|browser_subagent|define_subagent|subagent)$/i;
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
  let agents: { key: string; label: string; sub: string; running: boolean; failed?: boolean; provider?: ProviderId; onStop?: () => void }[] = [];

  if (session) {
    tools = toolsOf(session.messages);
    const messageIds = new Set(Object.values(activeRuns).filter((r) => r.sessionId === session.id).map((r) => r.messageId));
    liveTools = toolsOf(session.messages.filter((m) => messageIds.has(m.id)));
    agents = tools.filter((b) => !b.parentId && SUBAGENT.test(b.name)).map((b) => ({
      key: b.id, label: describe(b), running: b.running && liveTools.includes(b), failed: b.isError,
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
      return { key: x.turnId, label: a?.name ?? x.agentId, sub: `${a?.role ?? ''} · ${toolsOf([x.message]).length} ${t('Schritte')}`, running: x.running, failed: x.ok === false, provider: a?.provider, onStop: () => { void hub.multiStopTurn(run.id, x.turnId); } };
    });
  }

  const background = liveTools.filter((b) => b.running);
  const latest = background.at(-1);
  const stopBackground = () => {
    if (session) useHub.getState().cancel(session.id);
    else if (run && latest) { const turnId = owners.get(latest); if (turnId) void hub.multiStopTurn(run.id, turnId); }
  };

  if (!session && !run) return <div className="p-4 text-muted">{t('Öffne einen Chat oder ein Team, um dessen Agenten und Hintergrundaufgaben zu sehen.')}</div>;

  return (
    <div className="h-full overflow-y-auto p-2 text-[12.5px]">
      <Section title={t('Agenten')} count={agents.length} running={agents.filter((a) => a.running).length}>
        {agents.length === 0 && <div className="px-2 py-1.5 text-subtle">{session ? t('Keine Sub-Agenten in diesem Chat.') : t('Noch keine Agenten gestartet.')}</div>}
        {agents.slice().reverse().map((a) => (
          <div key={a.key} className="flex items-center gap-2 rounded-lumen-sm px-2 py-1.5 hover:bg-hover">
            {a.provider ? <Dot id={a.provider} size={7} /> : <Icon name="lucide:bot" size={14} className="shrink-0 text-muted" />}
            <div className="min-w-0 flex-1"><div className="truncate">{a.label}</div><div className="truncate text-[11px] text-subtle">{a.sub}</div></div>
            {a.running && <button className="icon-btn !size-6 shrink-0 text-bad" aria-label={t('Zugehörigen Lauf stoppen')} title={t('Zugehörigen Lauf stoppen')} onClick={a.onStop}><Icon name="lucide:square" size={11} /></button>}
            {a.running ? <span className="pulse-dot size-2 shrink-0 rounded-full bg-accent" /> : a.failed ? <Icon name="lucide:circle-x" size={14} className="shrink-0 text-bad" /> : <Icon name="lucide:circle-check" size={14} className="shrink-0 text-ok" />}
          </div>
        ))}
      </Section>

      <Section title={t('Hintergrundaufgaben')} count={background.length} running={background.length}>
        {!background.length && <div className="px-2 py-1.5 text-subtle">{t('Keine laufenden Hintergrundaufgaben.')}</div>}
        <div className="px-2 py-1.5"><ToolActivity blocks={background} onStop={stopBackground} /></div>
      </Section>
    </div>
  );
}
