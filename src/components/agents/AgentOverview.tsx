import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentRole, MultiRunRecord } from '@shared/types';
import { agentOverview } from '@shared/agent-overview';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { MessageView } from '../MessageView';
import { Modal, ProviderMark } from '../ui';

const roles: Record<AgentRole, string> = { planner: 'Planung', worker: 'Umsetzung', reviewer: 'Review', researcher: 'Recherche', tester: 'Tests' };
const states = {
  running: { label: 'Arbeitet', color: 'text-accent' }, waiting: { label: 'Wartet', color: 'text-muted' },
  interrupted: { label: 'Unterbrochen', color: 'text-warn' }, failed: { label: 'Fehlgeschlagen', color: 'text-bad' }, done: { label: 'Letzter Beitrag fertig', color: 'text-ok' },
};
const runStates: Record<MultiRunRecord['status'], string> = { idle: 'Bereit', running: 'Läuft', done: 'Abgeschlossen', failed: 'Fehlgeschlagen', stopped: 'Gestoppt' };
const duration = (milliseconds: number) => `${Math.floor(milliseconds / 60000)}m ${Math.floor(milliseconds / 1000) % 60}s`;
const tokens = (value: number) => new Intl.NumberFormat('de', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export function AgentOverview({ run, onClose, onShowHistory }: { run: MultiRunRecord; onClose: () => void; onShowHistory: (agentId: string) => void }) {
  const [selected, setSelected] = useState<string>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run.status !== 'running') { return; }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.status]);
  const agent = run.config.agents.find((item) => item.id === selected);
  const detail = agent ? agentOverview(run, agent.id, now) : undefined;
  const activeCount = run.config.agents.filter((item) => agentOverview(run, item.id, now).state === 'running').length;

  return createPortal(<Modal title="Agentenübersicht" xl onClose={onClose}>
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
      <span>{run.config.agents.length} Agenten · {activeCount} aktiv</span>
      <span>· Verbindungen zeigen die Teamzugehörigkeit</span>
    </div>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.85fr)]">
      <section aria-label="Teamdiagramm" className="min-w-0">
        <div className="rounded-xl border border-accent/40 bg-accent/5 p-4">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-accent"><Icon name="lucide:network" size={14} /> Teamauftrag · {runStates[run.status]}</div>
          <h4 className="break-words font-semibold">{run.title}</h4>
          <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-sm text-muted">{run.config.goal}</p>
        </div>
        <div className="ml-5 border-l border-edge pl-5">
          {run.config.agents.map((item) => {
            const summary = agentOverview(run, item.id, now);
            const state = states[summary.state];
            const stage = run.stages.find((entry) => entry.stageId === summary.latest?.stageId);
            return <div key={item.id} className="relative pt-3 before:absolute before:left-[-21px] before:top-9 before:w-5 before:border-t before:border-edge">
              <button aria-pressed={selected === item.id} onClick={() => setSelected(item.id)} className={`w-full min-w-0 rounded-lg border p-3 text-left transition-colors hover:bg-hover ${selected === item.id ? 'border-accent bg-accent/5' : 'border-edge bg-surface'}`}>
                <div className="flex items-center gap-2"><ProviderMark id={item.provider} size={14} /><span className="min-w-0 flex-1 break-words text-sm font-medium">{item.name}</span><Icon name="lucide:chevron-right" size={14} /></div>
                <div className={`mt-2 flex items-center gap-1.5 text-xs ${state.color}`}><span className={`size-1.5 rounded-full bg-current ${summary.state === 'running' ? 'pulse-dot' : ''}`} />{state.label}<span className="ml-auto text-muted">{roles[item.role]}</span></div>
                <div className="mt-1 text-xs text-muted">{summary.durationMs ? duration(summary.durationMs) : 'Keine Zeitangabe'} · {summary.tokens === undefined ? 'Keine Tokenangaben' : `${tokens(summary.tokens)} Tokens gesamt`}</div>
                {stage && <div className="mt-1 truncate text-xs text-subtle">{stage.label}</div>}
              </button>
            </div>;
          })}
        </div>
      </section>
      <section aria-label="Agentendetails" className="min-w-0 rounded-xl border border-edge bg-surface p-4 lg:sticky lg:top-0">
        {!agent || !detail ? <div className="py-12 text-center text-sm text-muted"><Icon name="lucide:mouse-pointer-2" className="mx-auto mb-3" />Wähle einen Agenten für Aufgaben, Modell und Ergebnisse.</div> : <>
          <h4 className="break-words font-semibold">{agent.name}</h4>
          <p className="mt-1 break-words text-xs text-muted">{roles[agent.role]} · {agent.localModel ?? (agent.capability ? `Auto: ${agent.capability}` : agent.options.model ?? agent.provider)}</p>
          <p className={`my-3 text-sm ${states[detail.state].color}`}>{states[detail.state].label} · {detail.turns.length} Beiträge</p>
          <div className="mb-4 flex flex-wrap gap-2">
            <button className="btn text-xs" onClick={() => { onShowHistory(agent.id); onClose(); }}>Beiträge im Verlauf</button>
            {detail.state === 'running' && detail.latest && <button className="btn text-xs text-bad" onClick={() => { for (const turn of detail.turns.filter((entry) => entry.running)) { void hub.multiStopTurn(run.id, turn.turnId); } }}>Agent stoppen</button>}
          </div>
          {run.plan.filter((task) => task.assignee === agent.id).map((task) => <p key={task.id} className="mb-2 rounded border border-edge p-2 text-xs">{task.title}</p>)}
          {detail.latest && <>
            <details className="mb-3 text-xs"><summary className="cursor-pointer text-muted">Aktueller / letzter Auftrag</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{detail.latest.prompt}</pre></details>
            <div className="max-h-80 overflow-auto"><MessageView m={detail.latest.message} live={detail.state === 'running'} onStop={() => void hub.multiStopTurn(run.id, detail.latest!.turnId)} /></div>
          </>}
        </>}
      </section>
    </div>
  </Modal>, document.body);
}
