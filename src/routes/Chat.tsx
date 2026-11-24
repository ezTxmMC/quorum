import { PROVIDER_ORDER } from '@shared/catalog';
import { chatMode, CHAT_MODES } from '@shared/chat-modes';
import { getLang, t } from '@/lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { PROVIDERS, isTextOnly, modelEfforts, canonicalModel, selectModelOptions, modelChoices } from '@shared/catalog';
import type { ProviderId } from '@shared/types';
import { AgentIsland } from '@/components/agents/AgentIsland';
import { Composer } from '@/components/Composer';
import { MessageView } from '@/components/MessageView';
import { TerminalPanel } from '@/components/panels/TerminalPanel';
import { OptionsPanel } from '@/components/OptionsPanel';
import { cx, usePresence } from '@/components/ui';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useHub, useHubEq } from '@/lib/store';
import type { ChatSession } from '@shared/types';

const ALIASES: Record<string, ProviderId> = { claude: 'claude', codex: 'codex', gpt: 'codex', agy: 'antigravity', gemini: 'antigravity', antigravity: 'antigravity', kimi: 'kimi', opencode: 'opencode' };

export function ChatPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const session = useHub((s) => s.data.sessions.find((x) => x.id === id));
  const runs = useHub((s) => s.runs);
  const statuses = useHub((s) => s.statuses);
  const optionsOpen = useHub((s) => s.chatOptionsOpen);
  const { send, submit, cancel, patchSession, newSession } = useHub.getState();
  const banner = useHub((s) => s.banners[id]);
  // Eingabefeld bekommt nur die Teile der Sitzung, die es braucht – so rendert es beim Streamen nicht mit.
  const composerSession = useHubEq(
    (s) => s.data.sessions.find((x) => x.id === id),
    (a: ChatSession | undefined, b: ChatSession | undefined) => a === b || (!!a && !!b && a.id === b.id && a.provider === b.provider && a.options === b.options && a.cwd === b.cwd && a.limit === b.limit && a.modeSettings === b.modeSettings && a.providerSessions === b.providerSessions && a.fallbacks === b.fallbacks),
  );
  const panelPresence = usePresence(optionsOpen, 170);
  const terminalOpen = useHub((s) => Boolean(s.chatTerminals[id]));
  const [terminalHeight, setTerminalHeight] = useState(240);
  const [terminalSlot, setTerminalSlot] = useState<HTMLElement | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const activeMessages = new Set(Object.values(runs).filter((r) => r.sessionId === id).map((r) => r.messageId));
  const running = activeMessages.size > 0;
  const lastLen = session?.messages.at(-1)?.blocks.length ?? 0;
  const lb = session?.messages.at(-1)?.blocks.at(-1);
  const lastText = !lb ? 0 : lb.kind === 'tool' ? (lb.output?.length ?? 0) + (lb.running ? 1 : 0) : lb.kind === 'image' || lb.kind === 'model' ? 1 : lb.text.length;

  // Eine selbst gesendete Nachricht holt die Ansicht immer ans Ende, auch wenn vorher nach oben gescrollt wurde.
  const lastUserId = session?.messages.filter((message) => message.role === 'user').at(-1)?.id;
  useEffect(() => { stick.current = true; }, [lastUserId]);
  // Nur eine eben gesendete Nachricht bekommt die Sende-Animation, nicht der Verlauf beim Öffnen eines Chats.
  // Einmal markierte Nachrichten bleiben markiert: ein Klassenwechsel würde ihre Animation erneut abspielen.
  const opened = useRef({ id, lastUserId, fresh: new Set<string>() });
  if (opened.current.id !== id) {
    opened.current = { id, lastUserId, fresh: new Set() };
  }
  if (lastUserId && lastUserId !== opened.current.lastUserId) {
    opened.current.fresh.add(lastUserId);
  }
  const freshIds = opened.current.fresh;

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) {
      const raf = requestAnimationFrame(() => {
        if (el && stick.current) el.scrollTop = el.scrollHeight;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [session?.messages.length, lastLen, lastText, lastUserId]);
  useEffect(() => { stick.current = true; }, [id]);

  // Neuer, leerer Chat mit nicht verfügbarem Anbieter: automatisch auf den ersten verfügbaren wechseln.
  const providerGone = !!session && session.messages.length === 0 && statuses[session.provider]?.installed === false;
  useEffect(() => {
    if (!session || !providerGone) return;
    const st = useHub.getState();
    const next = PROVIDER_ORDER.find((p) => st.statuses[p]?.installed);
    if (next) patchSession(session.id, { provider: next, options: { ...st.data.settings.providerDefaults[next], chatMode: chatMode(session.options) } });
  }, [providerGone, session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chat mit Prozent-Limit: Werte sofort beim Öffnen/Ändern und danach alle 90 s im Hintergrund auffrischen und prüfen.
  const limitKey = session?.limit ? `${session.provider}:${session.limit.window}:${session.limit.percent}:${session.limit.action}` : '';
  useEffect(() => {
    if (!limitKey) return;
    const provider = useHub.getState().data.sessions.find((x) => x.id === id)?.provider;
    if (!provider) return;
    const run = () => { const st = useHub.getState(); if (!st.isRunning(id)) void st.refreshLimits(provider).then(() => { if (!useHub.getState().isRunning(id)) void useHub.getState().checkLimit(id); }); };
    void useHub.getState().checkLimit(id);
    run();
    const iv = setInterval(run, 90_000);
    return () => clearInterval(iv);
  }, [id, limitKey]);

  const setActiveCwd = useHub.getState().setActiveCwd;
  useEffect(() => { if (session) setActiveCwd(session.cwd); }, [session?.cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  const onStopRun = useCallback(() => cancel(id), [cancel, id]);
  const onOpenModel = useCallback((projectId: string) => { navigate('/3d', { state: { projectId }, viewTransition: true }); }, [navigate]);
  const onSendMsg = useCallback((txt: string, imgs: string[], mode: 'direct' | 'queue', attachments: import('@shared/types').Attachment[], files: import('@shared/types').MessageFile[]) => submit(id, txt, { images: imgs, mode, attachments, files }), [submit, id]);
  const commandRef = useRef<(cmd: string, arg: string) => boolean>(() => false);
  const onCommandStable = useCallback((cmd: string, arg: string) => commandRef.current(cmd, arg), []);
  if (!session) return <Navigate to="/" replace />;
  const meta = PROVIDERS[session.provider];
  const rawMode = chatMode(session.options);
  const mode = rawMode === 'model' ? 'text' : rawMode;
  const status = statuses[session.provider];
  const empty = session.messages.length === 0;

  const setOpts = (patch: object) => patchSession(id, { options: { ...session.options, ...patch } });

  const onCommand = (cmd: string, arg: string): boolean => {
    switch (cmd) {
      case 'new': navigate(`/chat/${newSession({ cwd: session.cwd, provider: session.provider, options: session.options })}`, { viewTransition: true }); return true;
      case 'plan': {
        const key = session.provider === 'codex' ? 'sandbox' : 'permission';
        const cur = session.provider === 'codex' ? session.options.sandbox : session.options.permission;
        const planVal = session.provider === 'codex' ? 'read-only' : 'plan';
        const def = useHub.getState().data.settings.providerDefaults[session.provider][key as 'permission'] ;
        setOpts({ [key]: cur === planVal ? (def === planVal ? undefined : def) : planVal, fullAccess: false, approvalPolicy: undefined });
        return true;
      }
      case 'provider': {
        const p = ALIASES[arg.trim().toLowerCase()];
        if (!p) return false;
        patchSession(id, { provider: p, options: { ...useHub.getState().data.settings.providerDefaults[p], chatMode: mode } });
        return true;
      }
      case 'model': {
        const model = canonicalModel(session.provider, arg.trim());
        const info = modelChoices(session.provider, statuses, undefined, true).find((m) => m.id === model || m.imageEngine === model);
        setOpts(selectModelOptions(session.options, info?.id ?? model ?? '', info, info?.imageEngine));
        return true;
      }
      case 'effort': {
        const effort = arg.trim();
        const info = status?.models.find((m) => m.id === session.options.model);
        if (effort && !modelEfforts(session.provider, info).includes(effort)) return false;
        setOpts({ effort: effort || undefined }); return true;
      }
      case 'diff': { const st = useHub.getState(); if (!st.data.settings.dock.panels.changes.visible) st.togglePanel('changes'); return true; }
      case 'review':
        if (session.provider === 'codex') send(id, '/review (Codex: uncommitted changes)', { review: { target: 'uncommitted' } });
        else send(id, getLang() === 'en' ? 'Review the current uncommitted changes in this project (git diff, git status) thoroughly as a code review. Name concrete bugs, risks and improvements with file references. Do not change anything.' : 'Prüfe die aktuellen, nicht committeten Änderungen in diesem Projekt (git diff, git status) gründlich als Code-Review. Nenne konkrete Fehler, Risiken und Verbesserungen mit Dateiverweisen. Ändere nichts.');
        return true;
      case 'compact': void useHub.getState().compact(id, { focus: arg }); return true;
      case 'continue': send(id, arg || 'Fahre fort.', { continueLast: true }); return true;
      case 'fork': send(id, arg || 'Fahre fort.', { fork: true }); return true;
    }
    return false;
  };

  commandRef.current = onCommand;

  const pickProject = async () => {
    const d = await hub.pickFolder();
    if (d) { patchSession(id, { cwd: d, providerSessions: {} }); useHub.getState().addProject(d); }
  };

  return (
    <div className="relative flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <AgentIsland chatId={id} />
        <div className={cx('flex min-h-0 flex-1 flex-col', empty && 'justify-center overflow-y-auto pb-[8vh]')}>
        {empty ? (
          <h1 key={mode} className="rise-in mx-auto w-full max-w-3xl px-6 pb-5 text-center text-[24px] font-semibold tracking-tight text-fg">
            {t(CHAT_MODES.find((entry) => entry.id === mode)!.description)}
          </h1>
        ) : (
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            <div className="mx-auto max-w-5xl xl:max-w-6xl space-y-6 px-4 py-6">
              {session.messages.map((m) => <MessageView key={m.id} onOpenModel={onOpenModel} m={m} fresh={freshIds.has(m.id)} live={activeMessages.has(m.id)} onStop={onStopRun} />)}
            </div>
          </div>
        )}

        {status?.installed === false && (
          <div className="fade-in mx-auto mb-2 flex w-full max-w-5xl xl:max-w-6xl items-center gap-2 rounded-lumen border border-warn/30 bg-warn/10 px-3 py-2 text-warn">
            <Icon name="lucide:triangle-alert" size={14} /> <span>{session.provider === 'ollama' ? t('Ollama ist nicht erreichbar. Starte es mit „ollama serve“ und lade ein Modell (ollama pull …).') : <><b>{meta.bin}</b> {t('wurde nicht gefunden. Pfad unter Einstellungen angeben.')}</>}</span>
          </div>
        )}
        {banner && (
          <div className={cx('fade-in mx-auto mb-2 flex w-full max-w-5xl items-center gap-2 rounded-lumen border px-3 py-2 text-[12.5px] xl:max-w-6xl', banner.kind === 'error' ? 'border-bad/30 bg-bad/10 text-bad' : 'border-accent/30 bg-accent/10 text-fg')}>
            <Icon name={banner.kind === 'error' ? 'lucide:triangle-alert' : 'lucide:info'} size={14} className="shrink-0" /><span className="min-w-0 flex-1">{t(banner.text)}</span>
            {banner.action === 'undo-compact' && <button className="btn !py-0.5 text-[11.5px]" onClick={() => useHub.getState().undoCompact(id)}><Icon name="lucide:undo-2" size={12} /> {t('Rückgängig')}</button>}
            <button className="icon-btn !size-5" onClick={() => useHub.getState().setBanner(id, null)}><Icon name="lucide:x" size={12} /></button>
          </div>
        )}
        <Composer session={composerSession ?? session} running={running} onSend={onSendMsg} onStop={onStopRun} onCommand={onCommandStable} centered={empty} />
        {empty && mode === 'coding' && !isTextOnly(session.provider) && (
          <div className="flex justify-center px-4">
            <button className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-edge bg-surface/60 px-3 py-1 text-[12.5px] text-muted transition-colors hover:border-edge-strong hover:text-fg" onClick={pickProject}>
              <Icon name={session.cwd ? 'lucide:folder' : 'lucide:folder-open'} size={13} />
              <span className="max-w-xs truncate">{session.cwd || t('Ordner wählen')}</span>
            </button>
          </div>
        )}
        </div>
        {terminalOpen && (
          <section className="relative flex shrink-0 flex-col border-t border-edge bg-surface" style={{ height: terminalHeight }}>
            <div
              className="group absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize"
              onPointerDown={(event) => {
                event.preventDefault();
                const startY = event.clientY;
                const startHeight = terminalHeight;
                const onMove = (moveEvent: PointerEvent) => {
                  const next = Math.max(150, Math.min(window.innerHeight * 0.65, startHeight - (moveEvent.clientY - startY)));
                  setTerminalHeight(next);
                };
                const onUp = () => {
                  window.removeEventListener('pointermove', onMove);
                  window.removeEventListener('pointerup', onUp);
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
              }}
            >
              <div className="mx-auto mt-1 h-px w-full bg-accent opacity-0 transition-opacity group-hover:opacity-60" />
            </div>
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-edge px-2.5 text-[11.5px]">
              <Icon name="lucide:terminal" size={13} className="text-muted" />
              <span className="font-medium text-fg">{t('Terminal')}</span>
              <div ref={setTerminalSlot} className="flex min-w-0 flex-1 items-center gap-1" />
              <button
                className="icon-btn !size-6"
                title={t('Schließen')}
                onClick={() => useHub.getState().toggleChatTerminal(id, false)}
              >
                <Icon name="lucide:x" size={13} />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <TerminalPanel
                key={session.id}
                cwd={session.cwd || useHub.getState().data.recentProjects[0] || ''}
                slot={terminalSlot}
                onCloseAll={() => useHub.getState().toggleChatTerminal(id, false)}
              />
            </div>
          </section>
        )}
      </div>

      {panelPresence.mounted && (
        <aside data-state={panelPresence.state} className="dock-zone dock-right flex w-[380px] shrink-0 flex-col border-l border-edge bg-surface">
          <div className="flex items-center justify-between border-b border-edge px-3 py-2">
            <span className="font-medium">{meta.name} – {t('CLI-Optionen')}</span>
            <button className="icon-btn" onClick={() => useHub.getState().toggleChatOptions(false)}><Icon name="lucide:x" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3"><OptionsPanel allowImages provider={session.provider} value={session.options} onChange={setOpts} /></div>
        </aside>
      )}
    </div>
  );
}
