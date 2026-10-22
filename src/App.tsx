import { setLang } from '@/lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, RouterProvider, createHashRouter, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Dock, PanelBody } from '@/components/Dock';
import { QuickPage } from '@/routes/Quick';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { cx } from '@/components/ui';
import type { PanelId } from '@shared/types';
import { hub } from '@/lib/api';
import { useHub, wireEvents, wirePersistence } from '@/lib/store';
import { ChatPage } from '@/routes/Chat';
import { MultiBuilder } from '@/routes/MultiBuilder';
import { MultiRunPage } from '@/routes/MultiRun';
import { SettingsModal } from '@/components/SettingsModal';
import { ToolsPage } from '@/routes/Tools';
import { ModelsPage } from '@/routes/Models';
import { WorkflowsPage } from '@/routes/Workflows';
import { ThreeDPage } from '@/routes/ThreeD';

/** Startseite: öffnet immer einen neuen Chat (ein vorhandener leerer Chat wird wiederverwendet, es entstehen keine Duplikate). */
function Home() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => { setId(useHub.getState().newSession()); }, []);
  return id ? <Navigate to={`/chat/${id}`} replace /> : null;
}

const isQuick = location.hash.startsWith('#/quick');

export default function App() {
  const init = useHub((s) => s.init);
  const ready = useHub((s) => s.ready);
  const theme = useHub((s) => s.data.settings.theme);
  const accent = useHub((s) => s.data.settings.accent);
  const language = useHub((s) => s.data.settings.language);
  setLang(language);

  useEffect(() => {
    void init();
    const a = wireEvents();
    const b = isQuick ? () => {} : wirePersistence();
    // Änderungen aus anderen Fenstern übernehmen
    const c = hub.onSync((d) => useHub.getState().applyRemote(d));
    return () => { a(); b(); c(); };
  }, [init]);

  // Neue CLI-Sessions automatisch importieren – nur im Hauptfenster (sonst Duplikate).
  useEffect(() => {
    if (!ready || isQuick) return;
    const run = () => void hub.isPrimary().then((p) => { if (p) void useHub.getState().autoImport(); });
    const first = setTimeout(run, 1500);
    const iv = setInterval(run, 60000);
    window.addEventListener('focus', run);
    return () => { clearTimeout(first); clearInterval(iv); window.removeEventListener('focus', run); };
  }, [ready]);

  // Limits (/usage) von Claude Code und Antigravity automatisch und unsichtbar im Hintergrund aktualisieren – nur im Hauptfenster.
  useEffect(() => {
    if (!ready || isQuick) return;
    let alive = true;
    const run = () => void hub.isPrimary().then((p) => { if (p && alive) void useHub.getState().refreshCliUsage(); });
    const first = setTimeout(run, 6000);
    const iv = setInterval(run, 10 * 60 * 1000);
    return () => { alive = false; clearTimeout(first); clearInterval(iv); };
  }, [ready]);

  // Schnell-Prompt aus dem Tray-Fenster: neuen Chat anlegen, senden und öffnen.
  useEffect(() => {
    if (!ready || isQuick) return;
    const take = async () => {
      const q = await hub.quickTake();
      if (!q) return;
      const st = useHub.getState();
      const id = st.newSession({ provider: q.provider, cwd: q.cwd, options: q.options }, true);
      st.send(id, q.prompt);
      location.hash = `#/chat/${id}`;
    };
    void take();
    const a = hub.onQuickWake(() => void take());
    const b = hub.onOpenChat((id) => { location.hash = `#/chat/${id}`; });
    return () => { a(); b(); };
  }, [ready]);

  // Tastenkürzel: Strg+N neues Fenster, Strg+B Seitenleiste, Strg+` Terminal
  useEffect(() => {
    if (isQuick) return;
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const st = useHub.getState();
      if (e.key === 'n' && !e.shiftKey) { e.preventDefault(); void hub.newWindow(); }
      else if (e.key === 'b') { e.preventDefault(); st.setSettings({ sidebarPinned: !st.data.settings.sidebarPinned }); }
      else if (e.key === '`') { e.preventDefault(); st.togglePanel('terminal'); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--c-accent', accent);
    const cs = getComputedStyle(document.documentElement);
    void hub.setWindowTheme(cs.getPropertyValue('--c-bg').trim());
  }, [theme, accent]);

  if (!ready) return null;
  return <RouterProvider key={language} router={router} />;
}

function Shell() {
  const pinned = useHub((s) => s.data.settings.sidebarPinned);
  const setSettings = useHub.getState().setSettings;
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const location = useLocation();
  // Hover-Absicht: die Leiste öffnet erst, wenn die Maus kurz am Rand verweilt – beim bloßen Vorbeifahren springt sie nicht auf.
  const enter = () => { clearTimeout(timer.current); if (!open) timer.current = setTimeout(() => setOpen(true), 220); };
  const keep = () => { clearTimeout(timer.current); };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 240); };
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => { if (pinned) setOpen(false); }, [pinned]);

  return (
    <div className="flex h-full flex-col">
      <TopBar hover={{ open, enter, leave }} />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Angeheftete Seitenleiste mit flüssiger Breiten- und Einblendanimation */}
        <div
          className="relative shrink-0 overflow-hidden"
          style={{
            width: pinned ? 340 : 0,
            transition: 'width 280ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div
            className="h-full w-[340px]"
            style={{
              // Release the compositor layer at rest so sidebar text stays sharp.
              transform: pinned ? 'none' : 'translateX(-100%)',
              opacity: pinned ? 1 : 0.4,
              transition: 'transform 280ms cubic-bezier(0.16, 1, 0.3, 1), opacity 240ms ease',
            }}
          >
            <Sidebar pinned={pinned} onTogglePin={() => setSettings({ sidebarPinned: !pinned })} />
          </div>
        </div>

        {/* Nicht angeheftet: Feiner linker Hover-Rand zum bequemen Öffnen */}
        {!pinned && (
          <div
            className="absolute bottom-0 left-0 top-0 z-20 w-3 cursor-pointer"
            onMouseEnter={enter}
            onMouseLeave={leave}
          />
        )}

        {/* Nicht angeheftet: Sanfter Backdrop-Scrim */}
        {!pinned && (
          <div
            className={cx(
              'absolute inset-0 z-30 bg-black/35 backdrop-blur-[2px] transition-opacity duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
              open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            )}
            onClick={() => setOpen(false)}
          />
        )}

        {/* Nicht angeheftet: Schwebende Seitenleiste (Drawer) mit physikalischer Feder-Kurve & Glow */}
        {!pinned && (
          <div
            className={cx(
              'absolute bottom-0 left-0 top-0 z-40 flex',
              open ? 'pointer-events-auto' : 'pointer-events-none'
            )}
            style={{
              transform: open ? 'none' : 'translateX(-102%)',
              opacity: open ? 1 : 0.85,
              boxShadow: open
                ? '12px 0 36px -4px rgba(0, 0, 0, 0.5), 4px 0 12px -2px rgba(0, 0, 0, 0.3), 0 0 0 1px var(--c-border)'
                : 'none',
              transition: 'transform 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 240ms ease, box-shadow 300ms ease',
            }}
            onMouseEnter={keep}
            onMouseLeave={leave}
          >
            <Sidebar
              pinned={pinned}
              onTogglePin={() => {
                setSettings({ sidebarPinned: true });
                setOpen(false);
              }}
              onClose={() => setOpen(false)}
            />
          </div>
        )}

        <SettingsModal />
        <Dock><main className="page-root absolute inset-0 flex min-w-0 flex-col overflow-hidden"><Outlet /></main></Dock>
      </div>
    </div>
  );
}

function PopoutPage() {
  const { panel = 'terminal' } = useParams();
  const [sp] = useSearchParams();
  return (
    <div className="flex h-full flex-col">
      <TopBar minimal />
      <div className="min-h-0 flex-1 bg-surface"><PanelBody id={panel as PanelId} cwd={sp.get('cwd') ?? ''} /></div>
    </div>
  );
}

const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/chat/:id', element: <ChatPage /> },
      { path: '/multi', element: <MultiBuilder /> },
      { path: '/multi/:id', element: <MultiRunPage /> },
      { path: '/tools', element: <ToolsPage /> },
      { path: '/models', element: <ModelsPage /> },
      { path: '/workflows', element: <WorkflowsPage /> },
      { path: '/workflows/:id', element: <WorkflowsPage /> },
      { path: '/3d', element: <ThreeDPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  { path: '/popout/:panel', element: <PopoutPage /> },
  { path: '/quick', element: <QuickPage /> },
]);
