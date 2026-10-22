import { getLang, t } from '@/lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PROVIDERS } from '@shared/catalog';
import type { AgentRole, AgentSpec, MultiConfig, ProviderId, Strategy } from '@shared/types';
import type { ModelRecord } from '@shared/models';
import { Dot, EffortButton, ModelList, SpeedButton, UltracodeButton, defaultModel } from '@/components/ModelPicker';
import { Label, Modal, Popover, Select, Toggle, cx } from '@/components/ui';
import { hub, uid } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';

export const STRATEGIES: { id: Strategy; icon: string; name: string; desc: string }[] = [
  { id: 'plan-execute', icon: 'lucide:git-fork', name: 'Plan → Umsetzung → Review', desc: 'Einer plant, die anderen setzen um, Reviewer prüfen.' },
  { id: 'review-loop', icon: 'lucide:repeat-2', name: 'Bauen ↔ Prüfen', desc: 'Einer baut, ein anderer prüft – bis zur Freigabe.' },
  { id: 'pipeline', icon: 'lucide:workflow', name: 'Pipeline', desc: 'Nacheinander, jeder bekommt die Übergabe des Vorgängers.' },
  { id: 'parallel', icon: 'lucide:git-compare-arrows', name: 'Parallel + Synthese', desc: 'Alle lösen es unabhängig, der Lead führt zusammen.' },
  { id: 'debate', icon: 'lucide:messages-square', name: 'Debatte', desc: 'Modelle diskutieren, der Lead entscheidet.' },
];

const ROLES: { value: AgentRole; label: string }[] = [
  { value: 'planner', label: 'Planer / Lead' }, { value: 'worker', label: 'Umsetzer' }, { value: 'reviewer', label: 'Reviewer' },
  { value: 'researcher', label: 'Researcher' }, { value: 'tester', label: 'Tester' },
];
const ROLE_SHORT: Record<AgentRole, string> = { planner: 'Lead', worker: 'Baut', reviewer: 'Prüft', researcher: 'Forscht', tester: 'Testet' };

type Team = { name: string; icon: string; strategy: Strategy; agents: ProviderId[] };
const TEAMS: Team[] = [
  { name: 'Dreier-Team', icon: 'lucide:users', strategy: 'plan-execute', agents: ['claude', 'codex', 'antigravity'] },
  { name: 'Bauen & Prüfen', icon: 'lucide:repeat-2', strategy: 'review-loop', agents: ['codex', 'claude'] },
  { name: 'Denkrunde', icon: 'lucide:messages-square', strategy: 'debate', agents: ['claude', 'codex', 'antigravity'] },
];

/** Rollen automatisch sinnvoll verteilen – manuell geänderte (locked) bleiben unangetastet. */
function autoRoles(agents: AgentSpec[], strategy: Strategy, locked: Set<string>): AgentSpec[] {
  const n = agents.length;
  return agents.map((a, i) => {
    if (locked.has(a.id)) return a;
    let role: AgentRole;
    if (strategy === 'review-loop') role = i === 0 ? 'worker' : 'reviewer';
    else if (strategy === 'debate' || strategy === 'parallel') role = i === 0 ? 'planner' : 'researcher';
    else if (strategy === 'pipeline') role = i === 0 ? 'planner' : i === n - 1 && n > 2 ? 'reviewer' : 'worker';
    else role = i === 0 ? 'planner' : i === n - 1 && n >= 3 ? 'reviewer' : 'worker';
    return a.role === role ? a : { ...a, role };
  });
}

function makeAgent(provider: ProviderId, model: string | undefined, existing: AgentSpec[]): AgentSpec {
  const st = useHub.getState().statuses[provider];
  const label = st?.models.find((m) => m.id === model)?.label ?? PROVIDERS[provider].name;
  const dup = existing.filter((a) => a.name.replace(/ \d+$/, '') === label).length;
  return {
    id: 'a' + uid().slice(0, 6), name: dup ? `${label} ${dup + 1}` : label, provider, role: 'worker',
    options: { ...useHub.getState().data.settings.providerDefaults[provider], model },
  };
}

/** Lokales Denkmodell wählen (GGUF aus der Registry). Leer = CLI-Anbieter des Agenten. */
const CAPABILITY_CHOICES: { value: string; label: string }[] = [
  { value: 'cap:chat', label: 'Automatisch: Chat' },
  { value: 'cap:coding', label: 'Automatisch: Coding' },
  { value: 'cap:reasoning', label: 'Automatisch: Reasoning' },
];

/** Denkmodell wählen: CLI-Anbieter, festes lokales Modell oder automatisch nach Fähigkeit. */
function LocalModelPicker({ localModel, capability, onChange }: { localModel?: string; capability?: string; onChange: (p: Partial<AgentSpec>) => void }) {
  const [list, setList] = useState<ModelRecord[]>([]);
  useEffect(() => { void hub.models().then((ms) => setList(ms.filter((m) => m.format === 'gguf' || m.capabilities.some((c) => ['chat', 'coding', 'reasoning', 'agent'].includes(c))))); }, []);
  const value = localModel ? localModel : capability ? `cap:${capability}` : '';
  const pick = (v: string) => {
    if (!v) return onChange({ localModel: undefined, capability: undefined });
    if (v.startsWith('cap:')) return onChange({ localModel: undefined, capability: v.slice(4) as AgentSpec['capability'] });
    onChange({ localModel: v, capability: undefined });
  };
  return (
    <div>
      <Label hint={t('Ohne Werkzeuge: das Modell antwortet nur mit Text und ändert keine Dateien.')}>{t('Denkmodell')}</Label>
      <Select value={value} onChange={pick} options={[
        { value: '', label: t('CLI-Anbieter (mit Werkzeugen)') },
        ...CAPABILITY_CHOICES.map((c) => ({ ...c, label: t(c.label) })),
        ...list.map((m) => ({ value: m.id, label: m.name })),
      ]} />
    </div>
  );
}

function AgentChip({ a, onChange, onRemove, onLock }: { a: AgentSpec; onChange: (p: Partial<AgentSpec>) => void; onRemove: () => void; onLock: () => void }) {
  return (
    <Popover down trigger={(open, tg) => (
      <button onClick={tg} className={cx('chip-in flex items-center gap-2 rounded-full border border-edge-strong bg-surface py-1 pl-2.5 pr-3 transition-colors hover:bg-hover', open && 'bg-hover')}>
        <Dot id={a.provider} />
        <span className="text-[12.5px] font-medium">{a.name}</span>
        <span className="rounded-full bg-active px-1.5 text-[10.5px] text-muted">{t(ROLE_SHORT[a.role])}</span>
      </button>
    )}>
      {(close) => (
        <div className="w-72 space-y-3 p-2.5">
          <div><Label>{t('Rolle')}</Label><Select value={a.role} onChange={(role) => { onLock(); onChange({ role }); }} options={ROLES.map((r) => ({ ...r, label: t(r.label) }))} /></div>
          <LocalModelPicker localModel={a.localModel} capability={a.capability} onChange={onChange} />
          {!a.localModel && !a.capability && <>
          <div className="flex items-center justify-between"><Label>{t('Denktiefe')}</Label><EffortButton down provider={a.provider} model={a.options.model} value={a.options.effort} onChange={(effort) => onChange({ options: { ...a.options, effort } })} /></div>
          <div className="flex flex-wrap items-center gap-1"><SpeedButton down provider={a.provider} model={a.options.model} value={a.options.speed} onChange={(speed) => onChange({ options: { ...a.options, speed } })} />{a.provider === 'claude' && <UltracodeButton value={a.options.ultracode} onChange={(ultracode) => onChange({ options: { ...a.options, ultracode } })} />}</div>
          </>}
          <div><Label>{t('Besondere Anweisung')}</Label><textarea className="field min-h-16" placeholder={t('Optional')} value={a.instructions ?? ''} onChange={(e) => onChange({ instructions: e.target.value || undefined })} /></div>
          <button className="btn w-full justify-center text-bad" onClick={() => { onRemove(); close(); }}><Icon name="lucide:trash-2" size={14} /> {t('Entfernen')}</button>
        </div>
      )}
    </Popover>
  );
}

export function MultiBuilder() {
  const navigate = useNavigate();
  const loc = useLocation();
  const prefill = loc.state as { goal?: string; cwd?: string } | null;
  const { presets } = useHub((s) => s.data);
  const statuses = useHub((s) => s.statuses);
  const { createMulti, startMulti, savePreset, deletePreset } = useHub.getState();
  const [goal, setGoal] = useState(prefill?.goal ?? '');
  const [cwd, setCwd] = useState(prefill?.cwd ?? '');
  const [strategy, setStrategy] = useState<Strategy>('plan-execute');
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [rounds, setRounds] = useState(2);
  const [isolation, setIsolation] = useState<'shared' | 'worktree'>('shared');
  const [parallel, setParallel] = useState(false);
  const [autonomous, setAutonomous] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  // Startteam: zwei verschiedene Modelle, sobald die Modelllisten geladen sind.
  useEffect(() => {
    if (agents.length || !statuses.claude || !statuses.codex) return;
    const list: AgentSpec[] = [];
    for (const p of ['claude', 'codex'] as ProviderId[]) { if (statuses[p]?.installed) list.push(makeAgent(p, defaultModel(p, statuses[p]), list)); }
    if (list.length) setAgents(autoRoles(list, strategy, locked));
  }, [statuses, agents.length, strategy, locked]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 260) + 'px';
  }, [goal]);

  const setTeam = (next: AgentSpec[], strat = strategy) => setAgents(autoRoles(next, strat, locked));
  const add = (p: ProviderId, model: string) => setTeam([...agents, makeAgent(p, model, agents)]);
  const patch = (id: string, pt: Partial<AgentSpec>) => setAgents((as) => as.map((a) => (a.id === id ? { ...a, ...pt } : a)));
  const changeStrategy = (s: Strategy) => { setStrategy(s); setAgents((as) => autoRoles(as, s, locked)); };
  const applyTeam = (t: Team) => {
    const list: AgentSpec[] = [];
    for (const p of t.agents) list.push(makeAgent(p, defaultModel(p, statuses[p]), list));
    setLocked(new Set());
    setStrategy(t.strategy);
    setAgents(autoRoles(list, t.strategy, new Set()));
  };
  const config = (): MultiConfig => ({ lang: getLang(), strategy, goal: goal.trim(), cwd, agents, rounds, isolation, parallel: parallel && isolation === 'worktree', autonomous });
  const valid = goal.trim().length > 0 && agents.length > 0 && !!cwd;
  const start = () => { if (!valid) return; const id = createMulti(config()); startMulti(id); navigate(`/multi/${id}`, { viewTransition: true }); };
  const strat = STRATEGIES.find((s) => s.id === strategy)!;
  const usesRounds = strategy === 'plan-execute' || strategy === 'review-loop' || strategy === 'debate';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-5 px-6 py-10">
        <div className="fade-in text-center">
          <h1 className="text-[22px] font-semibold tracking-tight">{t('Was soll das Team erledigen?')}</h1>
          <p className="mt-1 text-muted">{t('Wähle Modelle, beschreibe das Ziel – den Rest koordinieren sie selbst.')}</p>
        </div>

        <div className="fade-in relative z-30 rounded-[18px] border border-edge-strong bg-surface shadow-lg transition-colors focus-within:border-accent/60">
          <textarea ref={ta} autoFocus rows={3} className="block max-h-[260px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14px] leading-relaxed outline-none placeholder:text-subtle"
            placeholder={t('z. B. „Baue eine REST-API für Todos mit Tests“')} value={goal} onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); } }} />
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
            <button className="btn btn-ghost !px-2 text-muted" title={cwd} onClick={async () => { const d = await hub.pickFolder(); if (d) { setCwd(d); useHub.getState().addProject(d); } }}>
              <Icon name="lucide:folder-open" /> <span className="max-w-40 truncate">{cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : t('Ordner wählen')}</span>
            </button>
            <Popover down trigger={(open, tg) => (
              <button className={cx('btn btn-ghost !px-2 text-muted', open && '!bg-hover')} onClick={tg}><Icon name={strat.icon} /> <span>{t(strat.name)}</span><Icon name="lucide:chevron-down" size={12} className={cx('transition-transform', open && 'rotate-180')} /></button>
            )}>
              {(close) => (
                <div className="w-72">
                  {STRATEGIES.map((s) => (
                    <button key={s.id} className={cx('flex w-full items-start gap-2.5 rounded-lumen-sm px-2.5 py-2 text-left hover:bg-hover', s.id === strategy && 'bg-active')} onClick={() => { changeStrategy(s.id); close(); }}>
                      <Icon name={s.icon} size={16} className="mt-0.5 text-accent" />
                      <span><span className="block text-[12.5px] font-medium">{t(s.name)}</span><span className="block text-[11.5px] text-subtle">{t(s.desc)}</span></span>
                    </button>
                  ))}
                </div>
              )}
            </Popover>
            <Popover down trigger={(open, tg) => <button className={cx('icon-btn', open && 'bg-hover text-fg')} onClick={tg} title={t('Weitere Einstellungen')}><Icon name="lucide:sliders-horizontal" /></button>}>
              {() => (
                <div className="w-80 space-y-2 p-2.5">
                  <div><Label>{t('Arbeitsweise')}</Label><Select value={isolation} onChange={setIsolation} options={[{ value: 'shared', label: t('Gemeinsamer Ordner (nacheinander)') }, { value: 'worktree', label: t('Git-Worktree je Agent') }]} /></div>
                  <Toggle checked={parallel && isolation === 'worktree'} onChange={setParallel} label={t('Aufgaben parallel')} hint={isolation === 'worktree' ? 'Danach wird automatisch gemergt' : 'Benötigt Worktree'} />
                  <Toggle checked={autonomous} onChange={setAutonomous} label={t('Darf Dateien ändern & Befehle ausführen')} hint={t('Sonst werden schreibende Tools abgelehnt')} />
                  {usesRounds && <div className="flex items-center justify-between"><Label>{t('Max. Runden')}</Label><input type="number" min={1} max={8} className="field !w-20" value={rounds} onChange={(e) => setRounds(Math.max(1, Number(e.target.value) || 1))} /></div>}
                </div>
              )}
            </Popover>
            <div className="flex-1" />
            <button className="grid size-8 place-items-center rounded-full bg-accent text-accent-fg transition-all enabled:hover:scale-105 disabled:opacity-35" disabled={!valid} onClick={start} title={t('Team starten (Strg+Enter)')}><Icon name="lucide:arrow-up" size={16} /></button>
          </div>
        </div>

        <div className="fade-in relative z-20 flex flex-wrap items-center justify-center gap-2">
          {agents.map((a) => (
            <AgentChip key={a.id} a={a} onChange={(pt) => patch(a.id, pt)} onLock={() => setLocked((l) => new Set(l).add(a.id))}
              onRemove={() => setTeam(agents.filter((x) => x.id !== a.id))} />
          ))}
          <Popover down trigger={(open, tg) => (
            <button onClick={tg} className={cx('flex items-center gap-1.5 rounded-full border border-dashed border-edge-strong px-3 py-1 text-muted transition-colors hover:bg-hover hover:text-fg', open && 'bg-hover text-fg')}><Icon name="lucide:plus" size={14} /> {t('Modell')}</button>
          )}>
            {(close) => <ModelList onPick={(p, m) => { add(p, m); close(); }} />}
          </Popover>
        </div>

        <div className="fade-in flex flex-wrap items-center justify-center gap-1.5 text-[12px]">
          {TEAMS.map((tm) => (
            <button key={tm.name} className="btn btn-ghost !gap-1.5 !px-2.5 !py-1 text-muted hover:!text-fg" onClick={() => applyTeam(tm)}><Icon name={tm.icon} size={13} /> {t(tm.name)}</button>
          ))}
          {presets.map((p) => (
            <span key={p.id} className="group relative inline-flex">
              <button className="btn btn-ghost !gap-1.5 !px-2.5 !py-1 text-muted hover:!text-fg" onClick={() => { setLocked(new Set()); setStrategy(p.config.strategy); setRounds(p.config.rounds); setIsolation(p.config.isolation); setParallel(p.config.parallel); setAutonomous(p.config.autonomous); setAgents(p.config.agents.map((a) => ({ ...a, id: 'a' + uid().slice(0, 6) }))); }}><Icon name="lucide:bookmark" size={13} /> {p.name}</button>
              <button className="absolute -right-1 -top-1 hidden size-4 place-items-center rounded-full bg-active text-muted hover:text-fg group-hover:grid" onClick={() => deletePreset(p.id)}><Icon name="lucide:x" size={10} /></button>
            </span>
          ))}
          {agents.length > 0 && <button className="btn btn-ghost !gap-1.5 !px-2.5 !py-1 text-subtle hover:!text-fg" onClick={() => setSaving('')}><Icon name="lucide:bookmark-plus" size={13} /> {t('Speichern')}</button>}
        </div>
      </div>

      {saving !== null && (
        <Modal title={t('Team als Vorlage speichern')} onClose={() => setSaving(null)}>
          <input className="field" autoFocus placeholder={t('Name der Vorlage')} value={saving} onChange={(e) => setSaving(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && saving.trim()) { savePreset(saving.trim(), config()); setSaving(null); } }} />
          <div className="mt-3 flex justify-end"><button className="btn btn-primary" disabled={!saving.trim()} onClick={() => { savePreset(saving.trim(), config()); setSaving(null); }}>{t('Speichern')}</button></div>
        </Modal>
      )}
    </div>
  );
}
