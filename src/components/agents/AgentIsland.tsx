import { detectAgents, isActive } from '@shared/subagents';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';

interface AgentIslandProps {
  chatId: string;
}

/** Schwebende Anzeige im Chat, solange Sub-Agenten arbeiten und das Agenten-Panel geschlossen ist: wie viele, und was der jüngste gerade tut. Ein Klick öffnet das Agenten-Panel. */
export function AgentIsland({ chatId }: AgentIslandProps) {
  const messages = useHub((s) => s.data.sessions.find((x) => x.id === chatId)?.messages);
  const runs = useHub((s) => s.runs);
  const panelOpen = useHub((s) => s.data.settings.dock.panels.agents.visible);
  const liveIds = new Set(Object.values(runs).filter((run) => run.sessionId === chatId).map((run) => run.messageId));
  // Das offene Agenten-Panel zeigt dieselben Agenten ausführlicher; die Anzeige wäre dort nur doppelt.
  if (panelOpen || !messages || liveIds.size === 0) {
    return null;
  }
  const active = detectAgents(messages.filter((message) => liveIds.has(message.id)), liveIds).filter(isActive);
  if (active.length === 0) {
    return null;
  }
  const latest = active.at(-1)!;

  function handleOpen() {
    const state = useHub.getState();
    if (!state.data.settings.dock.panels.agents.visible) {
      state.togglePanel('agents');
    }
  }

  return (
    <button className="island island-float fade-in absolute right-4 top-3 z-20 flex max-w-[min(26rem,calc(100%-2rem))] items-center gap-2.5 px-3 py-2 text-left text-[12px]" title={t('Agenten-Panel öffnen')} onClick={handleOpen}>
      <span className="relative grid size-6 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
        <Icon name="lucide:bot" size={14} />
        <span className="pulse-dot absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent" />
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-fg">{active.length} {active.length === 1 ? t('Agent arbeitet') : t('Agenten arbeiten')}</span>
        <span className="block truncate text-[11px] text-subtle">{latest.activity ?? latest.title}</span>
      </span>
      <Icon name="lucide:chevron-right" size={13} className="shrink-0 text-subtle" />
    </button>
  );
}
