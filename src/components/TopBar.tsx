import { Fragment, useEffect, useState } from 'react';
import { useMatch } from 'react-router-dom';
import { Logo } from './Logo';
import { Dot, useModelLabel } from './ModelPicker';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { PANELS } from './Dock';
import { ShortPath, cx } from './ui';

function WindowControls() {
  const [st, setSt] = useState({ maximized: false, fullscreen: false });
  useEffect(() => { void hub.winState().then(setSt); return hub.onWinState(setSt); }, []);
  const base = 'no-drag grid h-full w-11 place-items-center text-muted transition-colors hover:text-fg';
  return (
    <div className="no-drag flex h-full">
      <button className={cx(base, 'hover:bg-hover')} onClick={() => hub.winMinimize()} title={t('Minimieren')}><Icon name="lucide:minus" size={15} /></button>
      <button className={cx(base, 'hover:bg-hover')} onClick={() => hub.winMaximize()} title={st.maximized ? t('Wiederherstellen') : t('Maximieren')}><Icon name={st.maximized ? 'lucide:copy' : 'lucide:square'} size={st.maximized ? 13 : 12} /></button>
      <button className={cx(base, 'hover:!bg-[#e5484d] hover:!text-white')} onClick={() => hub.winClose()} title={t('Schließen')}><Icon name="lucide:x" size={16} /></button>
    </div>
  );
}

/** Chat-Infos in der Menüleiste: Titel, Modell, Projektordner und Optionen. */
function ChatHeader({ id }: { id: string }) {
  const session = useHub((s) => s.data.sessions.find((x) => x.id === id));
  const label = useModelLabel(session?.provider ?? 'claude', session?.options.model);
  if (!session) return <div className="flex-1" />;
  const pickProject = async () => {
    const d = await hub.pickFolder();
    if (d) { useHub.getState().patchSession(id, { cwd: d, providerSessions: {} }); useHub.getState().addProject(d); }
  };
  return (
    <>
      <div className="mx-2 flex min-w-0 flex-1 items-center gap-2.5 px-2">
        <Dot id={session.provider} size={9} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[12.5px] font-medium">{session.title}</div>
          <div className="truncate text-[10.5px] text-subtle">{label}</div>
        </div>
      </div>
      <div className="no-drag flex items-center gap-0.5 pr-1">
        {/* Ordner nur bei einem neuen, noch leeren Chat wählbar; bei bestehenden Chats ändert man ihn in der Seitenleiste (Bearbeiten). */}
        {session.messages.length === 0 && (
          <button className="btn btn-ghost !px-2 !py-1 text-muted" onClick={pickProject} title={session.cwd || t('Ordner wählen')}>
            <Icon name="lucide:folder-open" size={15} />{session.cwd ? <ShortPath path={session.cwd} /> : t('Ordner wählen')}
          </button>
        )}
      </div>
    </>
  );
}

export interface SidebarHover { open: boolean; enter: () => void; leave: () => void }

export function TopBar({ hover, minimal }: { hover?: SidebarHover; minimal?: boolean }) {
  const pinned = useHub((s) => s.data.settings.sidebarPinned);
  const panels = useHub((s) => s.data.settings.dock.panels);
  const updaterState = useHub((s) => s.updaterState);
  const { setSettings, togglePanel, openSettings } = useHub.getState();
  const mac = hub.platform === 'darwin';
  const chat = useMatch('/chat/:id');
  const cwd = useHub((s) => s.activeCwd);

  return (
    <header className="drag relative z-50 flex h-10 shrink-0 items-center border-b border-edge bg-bg">
      {mac && <div className="w-[78px] shrink-0" />}
      {!minimal && (
        <div className="no-drag flex items-center gap-1 pl-2">
          <button className={cx('icon-btn !size-8', (pinned || hover?.open) && 'text-fg')} title={pinned ? t('Seitenleiste ausblenden') : t('Seitenleiste (Hover) – Klick zum Anheften')}
            onMouseEnter={() => !pinned && hover?.enter()} onMouseLeave={() => !pinned && hover?.leave()} onClick={() => setSettings({ sidebarPinned: !pinned })}>
            <Icon name={pinned ? 'lucide:panel-left-close' : 'lucide:panel-left'} size={17} />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 px-3">
        <Logo size={22} />
        <span className="text-[12.5px] font-extrabold uppercase tracking-[0.14em]">Quorum</span>
      </div>
      {chat ? <ChatHeader id={chat.params.id ?? ''} /> : <div className="flex-1" />}
      {!minimal && (
        <div className="no-drag flex items-center gap-0.5 pr-2">
          {PANELS.map((p) => (
            <Fragment key={p.id}>
              <button className={cx('icon-btn !size-8', panels[p.id].visible && 'bg-active text-fg')} title={t(p.label)} onClick={() => togglePanel(p.id)}><Icon name={p.icon} size={16} /></button>
              {/* Rechts neben dem Terminal: Ordner des aktuellen Chats im Dateimanager öffnen */}
              {p.id === 'terminal' && (
                <button className="icon-btn !size-8 disabled:opacity-35" disabled={!cwd} title={cwd ? `${t('Chat-Ordner öffnen')}: ${cwd}` : t('Kein Ordner gewählt.')} onClick={() => void hub.openPath(cwd)}><Icon name="lucide:folder-open" size={16} /></button>
              )}
            </Fragment>
          ))}
          <div className="mx-1 h-4 w-px bg-edge" />
          <button className="icon-btn !size-8" title={t('Neues Fenster') + ' (Ctrl+N)'} onClick={() => hub.newWindow()}><Icon name="lucide:app-window" size={16} /></button>
          {(updaterState?.status === 'available' || updaterState?.status === 'downloaded' || updaterState?.status === 'downloading') && (
            <button
              className={cx(
                'no-drag ml-1 flex items-center gap-1.5 rounded-lumen-sm px-2 py-1 text-[11px] font-medium transition-colors',
                updaterState.status === 'downloaded'
                  ? 'bg-ok/20 text-ok hover:bg-ok/30'
                  : 'bg-accent/20 text-accent hover:bg-accent/30'
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
