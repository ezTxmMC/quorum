import { t, t as tr } from '@/lib/i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import type { AgentSpec, MultiRunRecord, MultiTurn } from '@shared/types';
import { ChangesPanel } from '@/components/ChangesPanel';
import { Markdown } from '@/components/Markdown';
import { MessageView } from '@/components/MessageView';
import { Collapse, ProviderMark, cx, usePresence } from '@/components/ui';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { STRATEGIES } from './MultiBuilder';

const STATUS: Record<MultiRunRecord['status'], { label: string; cls: string }> = {
  idle: { label: 'Bereit', cls: 'text-muted' }, running: { label: 'Läuft', cls: 'text-accent' },
  done: { label: 'Fertig', cls: 'text-ok' }, failed: { label: 'Fehlgeschlagen', cls: 'text-bad' }, stopped: { label: 'Gestoppt', cls: 'text-warn' },
};

function TurnCard({ t, agent, defaultOpen, multiId }: { t: MultiTurn; agent?: AgentSpec; defaultOpen: boolean; multiId: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [showPrompt, setShowPrompt] = useState(false);
  useEffect(() => { if (t.running) setOpen(true); }, [t.running]);
  return (
    <div className="rounded-lumen-lg border border-edge bg-surface">
      <button className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left" onClick={() => setOpen((o) => !o)}>
        {agent && <ProviderMark id={agent.provider} size={14} />}
        <span className="font-medium">{agent?.name ?? t.agentId}</span>
        <span className="text-[11.5px] text-subtle">{agent?.role}{t.message.usage?.durationMs ? ` · ${(t.message.usage.durationMs / 1000).toFixed(0)}s` : ''}</span>
        <span className="flex-1" />
        {t.running ? <span className="pulse-dot size-2 rounded-full bg-accent" /> : t.ok === false ? <Icon name="lucide:circle-x" className="text-bad" size={15} /> : <Icon name="lucide:circle-check" className="text-ok" size={15} />}
        <Icon name={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={14} className="text-subtle" />
      </button>
      <Collapse open={open}>
        <div className="space-y-3 border-t border-edge p-3">
          <button className="flex items-center gap-1.5 text-[11.5px] text-subtle hover:text-muted" onClick={() => setShowPrompt((p) => !p)}>
            <Icon name="lucide:scroll-text" size={12} /> {showPrompt ? tr('Prompt ausblenden') : tr('Prompt anzeigen')}{t.cwd ? ` · ${t.cwd.split(/[\\/]/).slice(-2).join('/')}` : ''}
          </button>
          <Collapse open={showPrompt}><pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lumen-sm bg-bg p-2.5 font-mono text-[11.5px] text-muted">{t.prompt}</pre></Collapse>
          <MessageView m={{ ...t.message, provider: undefined }} live={t.running} onStop={() => void hub.multiStopTurn(multiId, t.turnId)} />
        </div>
      </Collapse>
    </div>
  );
}

export function MultiRunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const run = useHub((s) => s.data.multiRuns.find((r) => r.id === id));
  const { startMulti, stopMulti, createMulti } = useHub.getState();
  const [filter, setFilter] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const diffPresence = usePresence(showDiff, 170);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const sig = run ? `${run.turns.length}:${run.turns.at(-1)?.message.blocks.length}:${(JSON.stringify(run.turns.at(-1)?.message.blocks.at(-1)) ?? "").length}:${run.stages.length}` : '';

  useLayoutEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [sig]);

  const setActiveCwd = useHub.getState().setActiveCwd;
  useEffect(() => { if (run) setActiveCwd(run.config.cwd); }, [run?.config.cwd]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!run) return <Navigate to="/multi" replace />;
  const st = STATUS[run.status];
  const stLabel = t(st.label);
  const strat = STRATEGIES.find((s) => s.id === run.config.strategy);
  const agentOf = (aid: string) => run.config.agents.find((a) => a.id === aid);
  const active = new Set(run.turns.filter((t) => t.running).map((t) => t.agentId));
  const turnsByStage = (sid: string) => run.turns.filter((t) => t.stageId === sid && (!filter || t.agentId === filter));

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-edge px-4 pb-2.5">
          <Icon name={strat?.icon ?? 'lucide:network'} size={18} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-medium">{run.title}</div>
            <div className="truncate text-[11px] text-subtle">{strat ? t(strat.name) : ''} · <span className={st.cls}>{stLabel}</span> · {run.config.cwd}</div>
          </div>
          <button className={cx('icon-btn', showDiff && 'bg-active text-fg')} onClick={() => setShowDiff((d) => !d)} title={t('Änderungen')}><Icon name="lucide:git-compare" /></button>
          {run.status === 'running' ? (
            <button className="btn" onClick={() => stopMulti(run.id)}><Icon name="lucide:square" size={13} /> {t('Stoppen')}</button>
          ) : (
            <>
              <button className="btn" onClick={() => { const nid = createMulti({ ...run.config, agents: run.config.agents.map((a) => ({ ...a })) }, run.title); startMulti(nid); navigate(`/multi/${nid}`, { viewTransition: true }); }}><Icon name="lucide:rotate-ccw" /> {t('Neu starten')}</button>
              <button className="btn" onClick={() => navigate('/multi', { viewTransition: true })}><Icon name="lucide:plus" /> {t('Neues Team')}</button>
            </>
          )}
        </header>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
          <button className={cx('btn !py-1', !filter && 'bg-active')} onClick={() => setFilter(null)}>{t('Alle')}</button>
          {run.config.agents.map((a) => (
            <button key={a.id} className={cx('btn !py-1', filter === a.id && 'bg-active')} onClick={() => setFilter(filter === a.id ? null : a.id)}>
              <ProviderMark id={a.provider} size={11} /> {a.name}
              {active.has(a.id) && <span className="pulse-dot size-1.5 rounded-full bg-accent" />}
            </button>
          ))}
        </div>

        <div ref={box} className="min-h-0 flex-1 overflow-y-auto" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
            <div className="rounded-lumen-lg border border-edge bg-surface p-3.5">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">{t('Ziel')}</div>
              <div className="whitespace-pre-wrap text-[14px]">{run.config.goal}</div>
            </div>

            {run.plan.length > 0 && (
              <div className="rounded-lumen-lg border border-edge bg-surface p-3.5">
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-subtle"><Icon name="lucide:list-checks" size={13} /> {t('Plan')}</div>
                <div className="space-y-1.5">
                  {run.plan.map((t) => {
                    const a = agentOf(t.assignee);
                    return (
                      <div key={t.id} className="flex items-start gap-2.5">
                        {a ? <ProviderMark id={a.provider} size={12} /> : <span className="w-5" />}
                        <div className="min-w-0 flex-1"><div className="font-medium">{t.title} <span className="font-normal text-subtle">· {a?.name ?? t.assignee}{t.dependsOn.length ? ` · nach ${t.dependsOn.join(', ')}` : ''}</span></div>
                          <div className="line-clamp-2 text-[12px] text-muted">{t.description}</div></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {run.stages.map((s) => {
              const turns = turnsByStage(s.stageId);
              if (!turns.length && filter) return null;
              return (
                <section key={s.stageId} className="fade-in">
                  <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-muted">
                    <Icon name={s.done ? 'lucide:circle-check' : 'lucide:loader-circle'} size={14} className={s.done ? 'text-ok' : 'spin text-accent'} /> {s.label}
                  </div>
                  <div className="space-y-2 border-l-2 border-edge pl-3">
                    {turns.map((t) => <TurnCard multiId={id} key={t.turnId} t={t} agent={agentOf(t.agentId)} defaultOpen={t.running || turns.length === 1} />)}
                  </div>
                </section>
              );
            })}

            {run.log.length > 0 && (
              <div className="space-y-1 rounded-lumen border border-edge p-2.5 text-[12px]">
                {run.log.map((l, i) => <div key={i} className={cx('flex gap-2', l.level === 'error' ? 'text-bad' : l.level === 'warn' ? 'text-warn' : 'text-muted')}><Icon name={l.level === 'info' ? 'lucide:info' : 'lucide:triangle-alert'} size={13} className="mt-0.5 shrink-0" />{l.text}</div>)}
              </div>
            )}

            {run.summary && (
              <div className={cx('rounded-lumen-lg border p-4', run.status === 'done' ? 'border-ok/30 bg-ok/5' : 'border-edge bg-surface')}>
                <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-subtle"><Icon name="lucide:flag" size={13} /> {t('Ergebnis')}</div>
                <Markdown text={run.summary} />
              </div>
            )}
            {run.status === 'running' && run.turns.every((t) => !t.running) && <div className="flex items-center gap-2 text-muted"><Icon name="lucide:loader-circle" className="spin" /> {t('Orchestrator arbeitet…')}</div>}
          </div>
        </div>
      </div>
      {diffPresence.mounted && (
        <aside data-state={diffPresence.state} className="dock-zone dock-right flex w-[420px] shrink-0 flex-col border-l border-edge bg-surface">
          <ChangesPanel cwd={run.config.cwd} refreshKey={run.turns.filter((t) => !t.running).length + run.status} />
        </aside>
      )}
    </div>
  );
}
