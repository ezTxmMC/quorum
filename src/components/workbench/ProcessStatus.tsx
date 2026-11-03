import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatJob } from '@shared/chat-host/types';
import { useHub } from '@/lib/store';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';

const active = (job: Omit<ChatJob, 'snapshot'>) => ['starting', 'running'].includes(job.state.status);

export function ProcessStatus() {
  const [jobs, setJobs] = useState<Omit<ChatJob, 'snapshot'>[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const cwd = useHub((state) => state.activeCwd);
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
  return <>
    <footer className="workbench-status flex h-6 shrink-0 items-center gap-4 border-t border-edge px-3 text-[10.5px] text-muted">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate" title={cwd}><Icon name="lucide:folder-open" size={12} />{cwd || 'Kein Workspace'}</span>
      <button className="flex items-center gap-1.5 hover:text-fg" onClick={() => setOpen(true)}><span className={`size-1.5 rounded-full ${running.length ? 'animate-pulse bg-ok' : 'bg-subtle'}`} />{running.length} {running.length === 1 ? 'Chat-Prozess' : 'Chat-Prozesse'}<Icon name="lucide:activity" size={12} /></button>
      <span className="hidden text-subtle sm:block">Strg+P Öffnen · Strg+Shift+F Suche</span>
    </footer>
    <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); setOpen(false); }} className="m-auto w-[min(640px,90vw)] rounded-lg border border-edge bg-surface p-5 text-fg shadow-2xl backdrop:bg-black/65" aria-label="Chat-Prozesse">
      <div className="mb-4 flex items-center justify-between"><div><h2 className="font-semibold">Chat-Prozesse</h2><p className="mt-1 text-xs text-muted">Unabhängige Ausführung mit gespeichertem Verlauf.</p></div><button className="icon-btn" aria-label="Schließen" onClick={() => setOpen(false)}><Icon name="lucide:x" size={16} /></button></div>
      {error && <p role="alert" className="mb-2 text-xs text-bad">{error}</p>}
      <div className="max-h-80 space-y-2 overflow-auto">
        {!jobs.length && <p className="py-4 text-sm text-muted">Noch keine Chat-Prozesse gestartet.</p>}
        {jobs.slice().reverse().slice(0, 50).map((job) => <div key={job.runId} className="flex items-center gap-3 rounded border border-edge p-3">
          <Icon name={active(job) ? 'lucide:loader-circle' : job.state.status === 'completed' ? 'lucide:circle-check' : 'lucide:circle-alert'} size={16} className={active(job) ? 'spin text-accent' : 'text-muted'} />
          <button className="min-w-0 flex-1 text-left" disabled={!job.chatId} onClick={() => { if (job.chatId) { navigate(`/chat/${job.chatId}`); setOpen(false); } }}><span className="block truncate text-sm">{job.title}</span><span className="text-[11px] text-muted">{job.provider} · {job.state.status} · Rust PID {job.state.pid ?? '…'}</span></button>
          {active(job) && <button className="btn text-xs text-bad" onClick={() => { void hub.cancel(job.runId).catch((reason: unknown) => setError(String(reason))); }}>Stoppen</button>}
        </div>)}
      </div>
      <div className="mt-4 flex justify-end"><button className="btn text-xs text-bad" disabled={!running.length} onClick={() => { void hub.chatStopAll().catch((reason: unknown) => setError(String(reason))); }}>Alle Chat-Prozesse stoppen</button></div>
    </dialog>
  </>;
}
