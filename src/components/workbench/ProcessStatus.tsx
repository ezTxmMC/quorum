import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ChatJob } from '@shared/chat-host/types';
import { useHub } from '@/lib/store';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';

const active = (job: Omit<ChatJob, 'snapshot'>) => ['starting', 'running'].includes(job.state.status);

export function ProcessStatus() {
  const [jobs, setJobs] = useState<Omit<ChatJob, 'snapshot'>[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const cwd = useHub((state) => state.activeCwd);
  const location = useLocation();
  const navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try { const result = await hub.chatProcessStatus(); if (mounted) { setJobs(result); } }
      catch (reason) { if (mounted) { setError(String(reason)); } }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    const unsubscribe = hub.onChatChanged(() => { void refresh(); });
    return () => { mounted = false; clearInterval(timer); unsubscribe(); };
  }, []);
  useEffect(() => {
    if (open) { dialog.current?.showModal(); return; }
    dialog.current?.close();
  }, [open]);
  const running = jobs.filter(active);
  const showFooter = location.pathname.startsWith('/plan') || running.length > 0;
  if (!showFooter && !open) {
    return null;
  }
  return <>
    {showFooter && (
      <footer className="workbench-status flex h-7 shrink-0 items-center gap-4 px-4 text-[11px] text-muted">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate" title={cwd}><Icon name="lucide:folder-open" size={12} className="shrink-0 text-subtle" />{cwd || t('Kein Workspace')}</span>
        <button className="flex items-center gap-1.5 rounded-full px-2 py-0.5 transition-colors hover:bg-hover hover:text-fg" onClick={() => setOpen(true)}><span className={`size-1.5 rounded-full ${running.length ? 'animate-pulse bg-ok' : 'bg-subtle'}`} />{running.length} {running.length === 1 ? t('Chat-Prozess') : t('Chat-Prozesse')}<Icon name="lucide:activity" size={12} /></button>
        {location.pathname.startsWith('/plan') && <span className="hidden items-center gap-1.5 text-subtle sm:flex"><kbd className="kbd-pill">Strg+P</kbd> {t('Öffnen')} · <kbd className="kbd-pill">Strg+Shift+F</kbd> {t('Suche')}</span>}
      </footer>
    )}
    <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); setOpen(false); }} className="m-auto w-[min(640px,90vw)] rounded-lumen-lg border border-edge-strong bg-surface p-5 text-fg shadow-2xl backdrop:bg-black/65 backdrop:backdrop-blur-xs" aria-label={t('Chat-Prozesse')}>
      <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">{t('Chat-Prozesse')}</h2><p className="mt-1 text-xs text-muted">{t('Unabhängige Ausführung mit gespeichertem Verlauf.')}</p></div><button className="icon-btn" aria-label={t('Schließen')} onClick={() => setOpen(false)}><Icon name="lucide:x" size={16} /></button></div>
      {error && <p role="alert" className="mb-2 text-xs text-bad">{error}</p>}
      <div className="max-h-80 space-y-2 overflow-auto">
        {!jobs.length && <p className="py-4 text-sm text-muted">{t('Noch keine Chat-Prozesse gestartet.')}</p>}
        {jobs.slice().reverse().slice(0, 50).map((job) => <div key={job.runId} className="flex items-center gap-3 rounded border border-edge p-3">
          <Icon name={active(job) ? 'lucide:loader-circle' : job.state.status === 'completed' ? 'lucide:circle-check' : 'lucide:circle-alert'} size={16} className={active(job) ? 'spin text-accent' : 'text-muted'} />
          <button className="min-w-0 flex-1 text-left" disabled={!job.chatId} onClick={() => { if (job.chatId) { navigate(`/chat/${job.chatId}`); setOpen(false); } }}><span className="block truncate text-sm">{job.title}</span><span className="text-[11px] text-muted">{job.provider} · {job.state.status} · Rust PID {job.state.pid ?? '…'}</span></button>
          {active(job) && <button className="btn text-xs text-bad" onClick={() => { void hub.cancel(job.runId).catch((reason: unknown) => setError(String(reason))); }}>{t('Stoppen')}</button>}
        </div>)}
      </div>
      <div className="mt-4 flex justify-end"><button className="btn text-xs text-bad" disabled={!running.length} onClick={() => { void hub.chatStopAll().catch((reason: unknown) => setError(String(reason))); }}>{t('Alle Chat-Prozesse stoppen')}</button></div>
    </dialog>
  </>;
}
