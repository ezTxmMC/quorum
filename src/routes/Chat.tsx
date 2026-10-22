import { chatMode, CHAT_MODES } from '@shared/chat-modes';
import { getLang, t } from '@/lib/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { PROVIDERS, isTextOnly, modelEfforts, canonicalModel, selectModelOptions, modelChoices } from '@shared/catalog';
import type { ProviderId } from '@shared/types';
import { Composer } from '@/components/Composer';
import { MessageView } from '@/components/MessageView';
import { ModelPane } from '@/components/ModelPane';
import { OptionsPanel } from '@/components/OptionsPanel';
import { ProviderMark, cx, usePresence } from '@/components/ui';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useHub, useHubEq } from '@/lib/store';
import type { ChatSession } from '@shared/types';

const ALIASES: Record<string, ProviderId> = { claude: 'claude', codex: 'codex', gpt: 'codex', agy: 'antigravity', gemini: 'antigravity', antigravity: 'antigravity' };

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
    (a: ChatSession | undefined, b: ChatSession | undefined) => a === b || (!!a && !!b && a.id === b.id && a.provider === b.provider && a.options === b.options && a.cwd === b.cwd && a.modeSettings === b.modeSettings && a.providerSessions === b.providerSessions && a.fallbacks === b.fallbacks),
  );
  const panelPresence = usePresence(optionsOpen, 170);
  // Modell aus dem Chat: wird die Projekt-ID gemeldet, zeigt die Ansicht rechts das Modell.
  const [modelPaneOpen, setModelPaneOpen] = useState(() => !!session && chatMode(session.options) === 'model' && window.innerWidth >= 1100);
  useEffect(() => { setModelPaneOpen(!!session && chatMode(session.options) === 'model' && window.innerWidth >= 1100); }, [id, session?.options.chatMode]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const activeMessages = new Set(Object.values(runs).filter((r) => r.sessionId === id).map((r) => r.messageId));
  const running = activeMessages.size > 0;
  const lastLen = session?.messages.at(-1)?.blocks.length ?? 0;
  const lb = session?.messages.at(-1)?.blocks.at(-1);
  const lastText = !lb ? 0 : lb.kind === 'tool' ? (lb.output?.length ?? 0) + (lb.running ? 1 : 0) : lb.kind === 'image' || lb.kind === 'model' ? 1 : lb.text.length;

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) {
      const raf = requestAnimationFrame(() => {
        if (el && stick.current) el.scrollTop = el.scrollHeight;
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [session?.messages.length, lastLen, lastText]);
  useEffect(() => { stick.current = true; }, [id]);

  // Neuer, leerer Chat mit nicht verfügbarem Anbieter: automatisch auf den ersten verfügbaren wechseln.
  const providerGone = !!session && session.messages.length === 0 && statuses[session.provider]?.installed === false;
  useEffect(() => {
    if (!session || !providerGone) return;
    const st = useHub.getState();
    const next = (['claude', 'codex', 'antigravity', 'opencode', 'ollama', 'local', 'api'] as ProviderId[]).find((p) => st.statuses[p]?.installed);
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
  const onOpenModel = useCallback((projectId: string) => { patchSession(id, { modelProjectId: projectId }); setModelPaneOpen(true); }, [patchSession, id]);
  const onSendMsg = useCallback((txt: string, imgs: string[], mode: 'direct' | 'queue', attachments: import('@shared/types').Attachment[]) => void submit(id, txt, { images: imgs, mode, attachments }), [submit, id]);
  const commandRef = useRef<(cmd: string, arg: string) => boolean>(() => false);
  const onCommandStable = useCallback((cmd: string, arg: string) => commandRef.current(cmd, arg), []);
  if (!session) return <Navigate to="/" replace />;
  const meta = PROVIDERS[session.provider];
  const mode = chatMode(session.options);
  const status = statuses[session.provider];

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
      case 'compact': void useHub.getState().compact(id); return true;
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
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {session.messages.length === 0 ? (
            <div className="mx-auto flex h-full max-w-4xl xl:max-w-5xl flex-col items-center justify-center px-6 text-center">
              {/* Nur verfügbare Anbieter anbieten (CLI vorhanden, angemeldet bzw. erreichbar) – der aktuell gewählte bleibt sichtbar. */}
              <div className="mb-5 flex flex-wrap justify-center gap-2">{(Object.keys(PROVIDERS) as ProviderId[]).filter((p) => statuses[p]?.installed || p === session.provider).map((p) => (
                <button key={p} onClick={() => patchSession(id, { provider: p, options: { ...useHub.getState().data.settings.providerDefaults[p], chatMode: mode } })} className={cx('flex w-36 flex-col items-center gap-2 rounded-lumen-lg border p-4 transition-colors hover:bg-hover', p === session.provider ? 'border-accent bg-hover' : 'border-edge')}>
                  <ProviderMark id={p} size={22} /><span className="text-[13px] font-medium">{PROVIDERS[p].name}</span>
                  <span className="text-[11px] text-subtle">{statuses[p]?.installed === false ? (p === 'ollama' ? t('läuft nicht') : t('nicht installiert')) : PROVIDERS[p].vendor}</span>
                </button>
              ))}</div>
              <h1 className="mb-1.5 text-[22px] font-semibold tracking-tight">{t(CHAT_MODES.find((entry) => entry.id === mode)!.label)}</h1>
              <p className="mb-3 text-muted">{t(CHAT_MODES.find((entry) => entry.id === mode)!.description)}</p>
              <p className="text-muted">{mode !== 'coding' ? t(mode === 'model' ? 'Beschreibe Form, Farben, Texturmuster, Materialien und gewünschte Animationen.' : mode === 'image' ? 'Bilder erzeugen und bearbeiten' : 'Fragen, schreiben und besprechen') : isTextOnly(session.provider) ? <span className="text-subtle">{session.provider === 'ollama' || session.provider === 'local' ? t('Lokaler Chat – kein Dateizugriff, keine Limits') : t('Chat-Modus – kein Dateizugriff, kein Codex-Kontingent')}</span> : session.cwd ? <>{t('Projekt:')} <button className="text-fg underline decoration-edge-strong underline-offset-4 hover:decoration-accent" onClick={pickProject}>{session.cwd}</button></> : <><button className="btn mx-auto" onClick={pickProject}><Icon name="lucide:folder-open" /> {t('Ordner wählen')}</button><span className="mt-2 block text-[12px] text-subtle">{t('Ohne Ordner läuft der Chat ohne Zugriff auf deine Dateien.')}</span></>}</p>
              <p className="mt-6 text-[12px] text-subtle">{t('Tipp:')} <kbd className="rounded bg-active px-1">/</kbd> {t('Befehle & Skills ·')} <kbd className="rounded bg-active px-1">@</kbd> {t('Dateien · Bilder per Drag & Drop · Anbieter wechseln behält den Kontext')}</p>
            </div>
          ) : (
            <div className="mx-auto max-w-5xl xl:max-w-6xl space-y-6 px-4 py-6">
              {session.messages.map((m) => <MessageView key={m.id} onOpenModel={onOpenModel} m={m} live={activeMessages.has(m.id)} onStop={onStopRun} />)}
            </div>
          )}
        </div>

        {status?.installed === false && (
          <div className="mx-auto mb-2 flex w-full max-w-5xl xl:max-w-6xl items-center gap-2 rounded-lumen border border-warn/30 bg-warn/10 px-3 py-2 text-warn">
            <Icon name="lucide:triangle-alert" size={14} /> <span>{session.provider === 'ollama' ? t('Ollama ist nicht erreichbar. Starte es mit „ollama serve“ und lade ein Modell (ollama pull …).') : <><b>{meta.bin}</b> {t('wurde nicht gefunden. Pfad unter Einstellungen angeben.')}</>}</span>
          </div>
        )}
        {mode === 'model' && !modelPaneOpen && <button className="btn mx-auto mb-2" onClick={() => setModelPaneOpen(true)}><Icon name="lucide:cuboid" size={14} />{t('3D-Modell öffnen')}</button>}
        {banner && (
          <div className={cx('mx-auto mb-2 flex w-full max-w-5xl items-center gap-2 rounded-lumen border px-3 py-2 text-[12.5px] xl:max-w-6xl', banner.kind === 'error' ? 'border-bad/30 bg-bad/10 text-bad' : 'border-accent/30 bg-accent/10 text-fg')}>
            <Icon name={banner.kind === 'error' ? 'lucide:triangle-alert' : 'lucide:info'} size={14} className="shrink-0" /><span className="min-w-0 flex-1">{t(banner.text)}</span>
            <button className="icon-btn !size-5" onClick={() => useHub.getState().setBanner(id, null)}><Icon name="lucide:x" size={12} /></button>
          </div>
        )}
        <Composer session={composerSession ?? session} running={running} onSend={onSendMsg} onStop={onStopRun} onCommand={onCommandStable} />
      </div>

      {modelPaneOpen && (mode === 'model' || !!session.modelProjectId) && !panelPresence.mounted && <ModelPane projectId={session.modelProjectId} onProject={(projectId) => patchSession(id, { modelProjectId: projectId })} onClose={() => setModelPaneOpen(false)} />}

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
