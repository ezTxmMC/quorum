import { useEffect, useRef } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import type { ChatSession } from '@shared/types';
import { neighbourTab, useChatTabs } from '@/lib/chatTabs';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub, useHubEq } from '@/lib/store';
import { ProviderMark, cx } from './ui';

type TabInfo = Pick<ChatSession, 'id' | 'title' | 'provider'> & { empty: boolean };

const sameTabs = (a: TabInfo[], b: TabInfo[]) =>
  a.length === b.length && a.every((tab, index) => {
    const other = b[index];
    return tab.id === other.id && tab.title === other.title && tab.provider === other.provider && tab.empty === other.empty;
  });

/** Tab-Leiste über dem Chat. Erscheint erst ab zwei Tabs, damit ein einzelner Chat keine zusätzliche Zeile bekommt. */
export function ChatTabs() {
  const navigate = useNavigate();
  const activeId = useMatch('/chat/:id')?.params.id;
  const tabIds = useChatTabs((state) => state.tabs);
  const tabs = useHubEq(
    (state) => tabIds.flatMap((id): TabInfo[] => {
      const session = state.data.sessions.find((entry) => entry.id === id);
      return session ? [{ id, title: session.title, provider: session.provider, empty: session.messages.length === 0 }] : [];
    }),
    sameTabs,
  );
  const sessionCount = useHub((state) => state.data.sessions.length);
  const runs = useHub((state) => state.runs);
  const previous = useRef<string | undefined>(undefined);

  useEffect(() => {
    useChatTabs.getState().prune(new Set(useHub.getState().data.sessions.map((session) => session.id)));
  }, [sessionCount]);

  useEffect(() => {
    if (!activeId) {
      return;
    }
    useChatTabs.getState().visit(activeId, previous.current);
    previous.current = activeId;
  }, [activeId]);

  // Strg+Tab wechselt zum nächsten Tab, Strg+Umschalt+Tab zum vorigen, Strg+W schließt den aktiven Tab.
  useEffect(() => {
    if (!activeId || tabIds.length < 2) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return;
      }
      const index = tabIds.indexOf(activeId);
      if (event.key === 'Tab' && index >= 0) {
        event.preventDefault();
        const step = event.shiftKey ? tabIds.length - 1 : 1;
        navigate(`/chat/${tabIds[(index + step) % tabIds.length]}`);
        return;
      }
      if (event.key.toLowerCase() === 'w' && !event.shiftKey && index >= 0) {
        event.preventDefault();
        closeTab(activeId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const closeTab = (id: string) => {
    const next = id === activeId ? neighbourTab(tabIds, id) : undefined;
    previous.current = next ?? previous.current;
    useChatTabs.getState().close(id);
    if (next) {
      navigate(`/chat/${next}`);
    }
  };

  const newTab = () => {
    const id = useHub.getState().newSession();
    useChatTabs.getState().open(id, activeId);
    navigate(`/chat/${id}`);
  };

  if (!activeId || tabs.length < 2) {
    return null;
  }
  const running = new Set(Object.values(runs).map((run) => run.sessionId));

  return (
    <div role="tablist" aria-label={t('Geöffnete Chats')} className="chat-tabs flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-edge bg-base/40 px-1.5 pt-1">
      {tabs.map((tab) => {
        const selected = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={selected}
            title={tab.title}
            onClick={() => navigate(`/chat/${tab.id}`)}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(`/chat/${tab.id}`); } }}
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } }}
            className={cx(
              'chip-in group/tab flex h-8 min-w-[92px] max-w-[220px] flex-1 cursor-pointer items-center gap-1.5 rounded-t-lumen-sm border border-b-0 px-2.5 text-[12px] transition-colors',
              selected ? 'border-edge bg-[var(--c-island)] text-fg' : 'border-transparent text-subtle hover:bg-hover hover:text-muted',
            )}
          >
            {running.has(tab.id) ? <span className="pulse-dot size-2 shrink-0 rounded-full bg-accent" /> : <ProviderMark id={tab.provider} size={11} />}
            <span className="min-w-0 flex-1 truncate">{tab.empty ? t('Neuer Chat') : tab.title}</span>
            <button
              className={cx('icon-btn !size-5 shrink-0', !selected && 'opacity-0 group-hover/tab:opacity-100')}
              title={t('Tab schließen')}
              aria-label={t('Tab schließen')}
              onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
            >
              <Icon name="lucide:x" size={11} />
            </button>
          </div>
        );
      })}
      <button className="icon-btn mb-1 ml-0.5 !size-6 shrink-0" title={t('Neuer Chat in neuem Tab')} aria-label={t('Neuer Chat in neuem Tab')} onClick={newTab}>
        <Icon name="lucide:plus" size={13} />
      </button>
    </div>
  );
}
