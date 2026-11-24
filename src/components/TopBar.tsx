import { FallbackButton } from './FallbackModels';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import { Logo } from './Logo';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { PANELS } from './Dock';
import { Popover, ShortPath, cx } from './ui';

type WorkspaceMode = 'chat' | '3d' | 'ide';

const WORKSPACE_MODES: { id: WorkspaceMode; label: string; icon: string }[] = [
  { id: 'chat', label: 'Chat', icon: 'lucide:message-square' },
  { id: '3d', label: '3D', icon: 'lucide:cuboid' },
  { id: 'ide', label: 'IDE', icon: 'lucide:code-2' },
];

function ModeSlider() {
  const location = useLocation();
  const navigate = useNavigate();
  const lastChatId = useRef<string | null>(null);
  const chatMatch = useMatch('/chat/:id');

  if (chatMatch?.params.id) {
    lastChatId.current = chatMatch.params.id;
  }

  const activeMode: WorkspaceMode = location.pathname.startsWith('/3d')
    ? '3d'
    : location.pathname.startsWith('/plan')
      ? 'ide'
      : 'chat';

  const activeIndex = WORKSPACE_MODES.findIndex((item) => item.id === activeMode);

  const selectMode = (mode: WorkspaceMode) => {
    if (mode === activeMode) {
      return;
    }
    if (mode === '3d') {
      navigate('/3d', { viewTransition: true });
      return;
    }
    if (mode === 'ide') {
      navigate('/plan', { viewTransition: true });
      return;
    }
    const store = useHub.getState();
    const remembered = lastChatId.current && store.data.sessions.some((s) => s.id === lastChatId.current)
      ? lastChatId.current
      : store.data.sessions[0]?.id ?? store.newSession();
    navigate(`/chat/${remembered}`, { viewTransition: true });
  };

  return (
    <div
      role="tablist"
      aria-label={t('Arbeitsbereich')}
      className="no-drag relative grid h-7 grid-cols-3 rounded-full border border-edge bg-surface/80 p-0.5"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-[calc((100%-4px)/3)] rounded-full border border-edge-strong/70 bg-overlay shadow-xs transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ transform: `translateX(${activeIndex * 100}%)` }}
      />
      {WORKSPACE_MODES.map((item) => {
        const selected = item.id === activeMode;
        return (
          <button
            key={item.id}
            role="tab"
            aria-selected={selected}
            onClick={() => selectMode(item.id)}
            className={cx(
              'relative z-10 flex w-[68px] items-center justify-center gap-1.5 rounded-full text-[11.5px] font-medium transition-colors duration-150',
              selected ? 'text-fg' : 'text-subtle hover:text-muted',
            )}
          >
            <Icon name={item.icon} size={13} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function WindowControls() {
  const [st, setSt] = useState({ maximized: false, fullscreen: false });
  useEffect(() => { void hub.winState().then(setSt); return hub.onWinState(setSt); }, []);
  const base = 'no-drag grid h-full w-11 place-items-center text-muted transition-colors duration-150 hover:text-fg';
  return (
    <div className="no-drag ml-1 flex h-full border-l border-edge/80">
      <button className={cx(base, 'hover:bg-hover')} onClick={() => hub.winMinimize()} title={t('Minimieren')}><Icon name="lucide:minus" size={14} /></button>
      <button className={cx(base, 'hover:bg-hover')} onClick={() => hub.winMaximize()} title={st.maximized ? t('Wiederherstellen') : t('Maximieren')}><Icon name={st.maximized ? 'lucide:copy' : 'lucide:square'} size={st.maximized ? 12 : 11} /></button>
      <button className={cx(base, 'hover:!bg-[#e5484d] hover:!text-white')} onClick={() => hub.winClose()} title={t('Schließen')}><Icon name="lucide:x" size={15} /></button>
    </div>
  );
}

/** Kompakte Chat-Kopfzeile: nur Titel und optionaler Projektordner bei leerem Chat. */
function ChatHeader({ id }: { id: string }) {
  const session = useHub((s) => s.data.sessions.find((x) => x.id === id));
  if (!session) {
    return <div className="flex-1" />;
  }
  const pickProject = async () => {
    const d = await hub.pickFolder();
    if (d) {
      useHub.getState().patchSession(id, { cwd: d, providerSessions: {} });
      useHub.getState().addProject(d);
    }
  };
  return (
    <div className="mx-3 flex min-w-0 flex-1 items-center justify-center gap-2">
      {session.messages.length > 0 && (
        <span className="truncate text-[12px] font-medium text-muted">{session.title}</span>
      )}
      {session.messages.length === 0 && session.cwd && (
        <button className="no-drag btn btn-ghost !px-2 !py-0.5 text-[11.5px] text-subtle hover:text-fg" onClick={pickProject} title={session.cwd}>
          <Icon name="lucide:folder" size={13} />
          <ShortPath path={session.cwd} />
        </button>
      )}
    </div>
  );
}

export interface SidebarHover { open: boolean; enter: () => void; leave: () => void }

export function TopBar({ hover, minimal, sidebarVisible, onToggleSidebar }: { hover?: SidebarHover; minimal?: boolean; sidebarVisible?: boolean; onToggleSidebar?: () => void }) {
  const preference = useHub((s) => s.data.settings.sidebarPinned);
  const pinned = sidebarVisible ?? preference;
  const panels = useHub((s) => s.data.settings.dock.panels);
  const updaterState = useHub((s) => s.updaterState);
  const { setSettings, togglePanel, openSettings } = useHub.getState();
  const mac = hub.platform === 'darwin';
  const chat = useMatch('/chat/:id');
  const chatId = chat?.params.id ?? '';
  const chatTerminalOpen = useHub((s) => (chatId ? Boolean(s.chatTerminals[chatId]) : false));
  const cwd = useHub((s) => s.activeCwd);
  const anyPanelOpen = PANELS.some((panel) => panels[panel.id].visible);

  const startWindowDrag = (event: React.MouseEvent<HTMLElement>) => {
    if (!window.__TAURI__ || event.button !== 0 || event.detail > 1) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('.no-drag, button, input, select, textarea, a')) {
      return;
    }
    void window.__TAURI__.window.getCurrentWindow().startDragging();
  };

  const toggleMaximizeOnDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.no-drag, button, input, select, textarea, a')) {
      return;
    }
    void hub.winMaximize();
  };

  return (
    <header
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
      onDoubleClick={toggleMaximizeOnDoubleClick}
      className="drag relative z-50 flex h-11 shrink-0 select-none items-center border-b border-edge bg-bg"
    >
      {mac && <div className="w-[78px] shrink-0" />}
      {!minimal && (
        <div className="no-drag flex items-center gap-1 pl-2">
          <button
            className={cx('icon-btn !size-8', (pinned || hover?.open) && 'text-fg')}
            title={pinned ? `${t('Seitenleiste ausblenden')} (Strg+B)` : `${t('Seitenleiste (Hover) – Klick zum Anheften')} (Strg+B)`}
            onPointerEnter={() => !pinned && hover?.enter()}
            onPointerLeave={() => !pinned && hover?.leave()}
            onClick={() => onToggleSidebar ? onToggleSidebar() : setSettings({ sidebarPinned: !pinned })}
          >
            <Icon name={pinned ? 'lucide:panel-left-close' : 'lucide:panel-left'} size={16} />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 pl-2 pr-3">
        <Logo size={20} />
        <span className="text-[12px] font-bold uppercase tracking-[0.14em] text-fg/90">Quorum</span>
      </div>
      {!minimal && <ModeSlider />}
      {chat ? <ChatHeader id={chat.params.id ?? ''} /> : <div className="flex-1" />}
      {!minimal && (
        <div className="no-drag flex items-center gap-1 pr-2">
          {chatId && <FallbackButton chatId={chatId} />}
          {chatId && (
            <button
              className={cx('icon-btn !size-8', chatTerminalOpen && 'bg-active text-fg')}
              title={`${t('Terminal')} (${t('nur für diesen Chat')} · Strg+\`)`}
              onClick={() => useHub.getState().toggleChatTerminal(chatId)}
            >
              <Icon name="lucide:terminal" size={15} />
            </button>
          )}
          <Popover
            down
            align="right"
            trigger={(open, toggle) => (
              <button
                className={cx('icon-btn !size-8', (open || anyPanelOpen) && 'bg-hover text-fg')}
                title={t('Panels')}
                onClick={toggle}
              >
                <Icon name="lucide:layout-panel-left" size={15} />
              </button>
            )}
          >
            {(close) => (
              <div className="w-48 space-y-0.5 p-0.5">
                {PANELS.map((panel) => (
                  <button
                    key={panel.id}
                    className={cx('flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover', panels[panel.id].visible && 'bg-active text-fg')}
                    onClick={() => { togglePanel(panel.id); close(); }}
                  >
                    <Icon name={panel.icon} size={14} className="text-muted" />
                    <span className="flex-1">{t(panel.label)}</span>
                    {panels[panel.id].visible && <Icon name="lucide:check" size={13} className="text-accent" />}
                  </button>
                ))}
                {cwd && (
                  <>
                    <div className="my-1 border-t border-edge" />
                    <button
                      className="flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover"
                      onClick={() => { void hub.openPath(cwd); close(); }}
                    >
                      <Icon name="lucide:folder-open" size={14} className="text-muted" />
                      <span>{t('Chat-Ordner öffnen')}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </Popover>
          <button className="icon-btn !size-8" title={t('Einstellungen')} onClick={() => openSettings()}>
            <Icon name="lucide:settings-2" size={15} />
          </button>
          {(updaterState?.status === 'available' || updaterState?.status === 'downloaded' || updaterState?.status === 'downloading') && (
            <button
              className={cx(
                'no-drag ml-1 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                updaterState.status === 'downloaded'
                  ? 'bg-ok/20 text-ok hover:bg-ok/30'
                  : 'bg-accent/20 text-accent hover:bg-accent/30',
              )}
              onClick={() => openSettings('updates')}
              title={updaterState.status === 'downloaded' ? t('Update bereit zur Installation') : t('Software-Update verfügbar')}
            >
              <span className={cx('size-1.5 rounded-full', updaterState.status === 'downloaded' ? 'bg-ok' : 'bg-accent animate-pulse')} />
              <span>{updaterState.status === 'downloaded' ? t('Update bereit') : t('Update')}</span>
            </button>
          )}
        </div>
      )}
      {!mac && <WindowControls />}
    </header>
  );
}
