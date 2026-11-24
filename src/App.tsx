import { ProcessStatus } from '@/components/workbench/ProcessStatus';
import { lazy, Suspense } from 'react';
import { setLang } from '@/lib/i18n';
import { useEffect, useState } from 'react';
import { Navigate, Outlet, RouterProvider, createHashRouter, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { Dock, PanelBody } from '@/components/Dock';
import { IdeSidebar, ThreeDSidebar } from '@/components/ModeSidebars';
import { Sidebar } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { cx } from '@/components/ui';
import type { PanelId } from '@shared/types';
import { hub } from '@/lib/api';
import { useHub, wireEvents, wirePersistence } from '@/lib/store';
import { ChatPage } from '@/routes/Chat';
import { SettingsModal } from '@/components/SettingsModal';

const PlanWorkspace = lazy(() => import('@/routes/plan/PlanWorkspace').then((module) => ({ default: module.PlanWorkspace })));
const MultiBuilder = lazy(() => import('@/routes/MultiBuilder').then((module) => ({ default: module.MultiBuilder })));
const MultiRunPage = lazy(() => import('@/routes/MultiRun').then((module) => ({ default: module.MultiRunPage })));
const ToolsPage = lazy(() => import('@/routes/Tools').then((module) => ({ default: module.ToolsPage })));
const ModelsPage = lazy(() => import('@/routes/Models').then((module) => ({ default: module.ModelsPage })));
const WorkflowsPage = lazy(() => import('@/routes/Workflows').then((module) => ({ default: module.WorkflowsPage })));
const ThreeDPage = lazy(() => import('@/routes/ThreeD').then((module) => ({ default: module.ThreeDPage })));
const QuickPage = lazy(() => import('@/routes/Quick').then((module) => ({ default: module.QuickPage })));

function RouteFallback() {
  return <div className="p-4 text-[12.5px] text-muted">Ansicht wird geladen …</div>;
}


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
    void init().catch((error) => {
      const target = document.getElementById('root');
      if (target) target.textContent = 'Quorum konnte das Profil nicht öffnen. ' + String(error);
    });
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
    // quorum <Ordner>: neuer (bzw. leerer) Chat im Ordner.
    const openFolder = (folder: string) => {
      const st = useHub.getState();
      st.addProject(folder); st.touchProject(folder);
      const id = st.newSession({ cwd: folder });
      location.hash = `#/chat/${id}`;
    };
    void hub.launchTake().then((f) => { if (f) openFolder(f); });
    const d = hub.onOpenFolder(openFolder);
    return () => { a(); b(); d(); };
  }, [ready]);

  // Tastenkürzel: Strg+N neues Fenster, Strg+B Seitenleiste, Strg+` Terminal
  useEffect(() => {
    if (isQuick) return;
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const st = useHub.getState();
      if (e.key === 'n' && !e.shiftKey) { e.preventDefault(); void hub.newWindow(); }
      else if (e.key === 'b') { e.preventDefault(); st.setSettings({ sidebarPinned: !st.data.settings.sidebarPinned }); }
      else if (e.key === '`') {
        const match = /^#\/chat\/([^/?#]+)/.exec(location.hash);
        if (match?.[1]) {
          e.preventDefault();
          st.toggleChatTerminal(match[1]);
        }
      }
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

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-bg text-[13px] text-muted">
        Lade Quorum …
      </div>
    );
  }
  return <RouterProvider key={language} router={router} />;
}

function Shell() {
  const pinned = useHub((s) => s.data.settings.sidebarPinned);
  const [winState, setWinState] = useState({ maximized: false, fullscreen: false });
  const setSettings = useHub.getState().setSettings;
  const location = useLocation();
  const isThreeD = location.pathname.startsWith('/3d');
  const isIde = location.pathname.startsWith('/plan');
  const roundedFrame = Boolean(window.__TAURI__) && !winState.maximized && !winState.fullscreen;
  useEffect(() => {
    void hub.winState().then(setWinState);
    return hub.onWinState(setWinState);
  }, []);
  const toggleSidebar = () => {
    setSettings({ sidebarPinned: !pinned });
  };
  const renderSidebar = () => {
    if (isThreeD) {
      return <ThreeDSidebar />;
    }
    if (isIde) {
      return <IdeSidebar />;
    }
    return <Sidebar />;
  };

  return (
    <div className={cx('flex h-full flex-col overflow-hidden bg-bg', roundedFrame && 'rounded-[14px] border border-edge-strong/80 shadow-2xl')}>
      <TopBar sidebarVisible={pinned} onToggleSidebar={toggleSidebar} />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Seitenleiste mit ruhiger Breiten- und Einblendanimation – nur per Klick oder Strg+B */}
        <div
          className="relative shrink-0 overflow-hidden"
          inert={!pinned}
          style={{
            width: pinned ? 272 : 0,
            transition: 'width 220ms cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          <div
            className="h-full w-[272px]"
            style={{
              transform: pinned ? 'none' : 'translateX(-100%)',
              opacity: pinned ? 1 : 0,
              transition: 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms ease',
            }}
          >
            {renderSidebar()}
          </div>
        </div>

        <SettingsModal />
        <Dock><main className="page-root absolute inset-0 flex min-w-0 flex-col overflow-hidden"><Outlet /></main></Dock>
      </div>
      <ProcessStatus />
    </div>
  );
}

function PopoutPage() {
  const { panel = 'terminal' } = useParams();
  const [sp] = useSearchParams();
  return (
    <div className="flex h-full flex-col">
      <TopBar minimal />
      <div className="min-h-0 flex-1 bg-surface"><PanelBody id={panel as PanelId} cwd={sp.get('cwd') ?? ''} popout /></div>
    </div>
  );
}

const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/chat/:id', element: <ChatPage /> },
      { path: '/multi', element: <Suspense fallback={<RouteFallback />}><MultiBuilder /></Suspense> },
      { path: '/multi/:id', element: <Suspense fallback={<RouteFallback />}><MultiRunPage /></Suspense> },
      { path: '/plan', element: <Suspense fallback={<div className="p-4 text-muted">Editor wird geladen…</div>}><PlanWorkspace /></Suspense> },
      { path: '/tools', element: <Suspense fallback={<RouteFallback />}><ToolsPage /></Suspense> },
      { path: '/models', element: <Suspense fallback={<RouteFallback />}><ModelsPage /></Suspense> },
      { path: '/workflows', element: <Suspense fallback={<RouteFallback />}><WorkflowsPage /></Suspense> },
      { path: '/workflows/:id', element: <Suspense fallback={<RouteFallback />}><WorkflowsPage /></Suspense> },
      { path: '/3d', element: <Suspense fallback={<RouteFallback />}><ThreeDPage /></Suspense> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  { path: '/popout/:panel', element: <PopoutPage /> },
  { path: '/quick', element: <Suspense fallback={<RouteFallback />}><QuickPage /></Suspense> },
]);
