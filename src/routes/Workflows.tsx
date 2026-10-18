import { t } from '@/lib/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ModelRecord } from '@shared/models';
import { KIND_LABEL, validateWorkflow, type NodeKind, type WorkflowDef, type WorkflowNode } from '@shared/workflow';
import type { RunEvent, NodeState, RunRecord } from '../../electron/workflows/engine';
import { imageUrl } from '@/components/MessageView';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { cx } from '@/components/ui';

const KINDS: NodeKind[] = ['input', 'template', 'llm', 'image', 'condition', 'workflow', 'output'];

const STATUS_CLASS: Record<NodeState['status'], string> = {
  pending: 'bg-hover text-subtle',
  running: 'bg-accent/20 text-accent',
  done: 'bg-ok/15 text-ok',
  failed: 'bg-bad/15 text-bad',
  skipped: 'bg-hover text-subtle line-through',
};
const STATUS_LABEL: Record<NodeState['status'], string> = { pending: 'wartet', running: 'läuft', done: 'fertig', failed: 'fehlgeschlagen', skipped: 'übersprungen' };

function newNode(kind: NodeKind): WorkflowNode {
  const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const config: WorkflowNode['config'] = {};
  if (kind === 'input') config.value = '';
  if (kind === 'template') config.template = '{{in}}';
  if (kind === 'image') Object.assign(config, { steps: 4, guidance: 0, width: 512, height: 512 });
  if (kind === 'condition') config.mode = 'contains';
  return { id, kind, label: t(KIND_LABEL[kind]), config, inputs: [] };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-[12px]"><span className="text-subtle">{t(label)}</span>{children}</label>;
}

function WorkflowList() {
  const nav = useNavigate();
  const [list, setList] = useState<WorkflowDef[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => void hub.wfList().then(setList);
  useEffect(reload, []);
  const create = async () => {
    const w = await hub.wfSave({ name: t('Neuer Workflow'), nodes: [newNode('input')] });
    nav(`/workflows/${w.id}`);
  };
  const importFile = async () => {
    const [p] = await hub.pickFiles('json');
    if (!p) return;
    try { const w = await hub.wfImport(p); nav(`/workflows/${w.id}`); } catch (e) { setErr((e as Error).message); }
  };
  const exportOne = async (id: string) => {
    const p = await hub.wfExport(id);
    if (p) void hub.revealPath(p);
  };
  const remove = async (w: WorkflowDef) => {
    if (!window.confirm(t('Workflow löschen? Die Ausführungsprotokolle bleiben erhalten.'))) return;
    await hub.wfDelete(w.id);
    reload();
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <h1 className="mb-1 text-[22px] font-semibold tracking-tight">{t('Workflows')}</h1>
            <p className="text-muted">{t('Knoten für Sprach-, Bild- und Agenten-Schritte verbinden. Läufe werden protokolliert.')}</p>
          </div>
          <button className="btn" onClick={() => void importFile()}><Icon name="lucide:file-down" size={14} /> {t('Importieren')}</button>
          <button className="btn btn-primary" onClick={() => void create()}><Icon name="lucide:plus" size={14} /> {t('Neuer Workflow')}</button>
        </div>
        {err && <div className="rounded-lumen border border-bad/40 bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{err}</div>}
        {list.length === 0 && <div className="text-[12.5px] text-subtle">{t('Noch keine Workflows.')}</div>}
        <ul className="space-y-2">
          {list.map((w) => (
            <li key={w.id} className="flex items-center gap-3 rounded-lumen-lg border border-edge bg-surface p-3">
              <button className="min-w-0 flex-1 text-left" onClick={() => nav(`/workflows/${w.id}`)}>
                <div className="truncate font-medium">{w.name}</div>
                <div className="text-[11.5px] text-subtle">v{w.version} · {w.nodes.length} {t('Knoten')} · {new Date(w.updatedAt).toLocaleString('de-DE')}</div>
              </button>
              <button className="icon-btn" title={t('Exportieren')} onClick={() => void exportOne(w.id)}><Icon name="lucide:file-up" size={14} /></button>
              <button className="icon-btn" title={t('Löschen')} onClick={() => void remove(w)}><Icon name="lucide:trash-2" size={14} /></button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function NodeEditor({ node, nodes, models, workflows, selfId, onChange, onRemove, onMove }: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  models: ModelRecord[];
  workflows: WorkflowDef[];
  selfId: string;
  onChange: (n: WorkflowNode) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  const cfg = node.config;
  const set = (patch: Partial<WorkflowNode['config']>) => onChange({ ...node, config: { ...cfg, ...patch } });
  const textModels = models.filter((m) => m.capabilities.some((c) => ['chat', 'coding', 'reasoning', 'agent', 'vision'].includes(c)));
  const imageModels = models.filter((m) => m.capabilities.includes('text-to-image'));
  const sources = nodes.filter((n) => n.id !== node.id && n.kind !== 'output');
  const has = (from: string, port?: 'true' | 'false') => node.inputs.some((l) => l.from === from && l.port === port);
  const toggleLink = (from: string, port?: 'true' | 'false') => {
    const inputs = has(from, port)
      ? node.inputs.filter((l) => !(l.from === from && l.port === port))
      : [...node.inputs, port ? { from, port } : { from }];
    onChange({ ...node, inputs });
  };
  const engineValue = cfg.engine ? (cfg.engine.type === 'local' ? `local:${cfg.engine.modelId}` : `cli:${cfg.engine.provider}`) : '';
  const setEngine = (v: string) => {
    if (!v) return set({ engine: undefined });
    const [kind, rest] = [v.slice(0, v.indexOf(':')), v.slice(v.indexOf(':') + 1)];
    set({ engine: kind === 'local' ? { type: 'local', modelId: rest } : { type: 'cli', provider: rest as 'claude' } });
  };
  return (
    <article className="space-y-3 rounded-lumen-lg border border-edge bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-subtle">{t(KIND_LABEL[node.kind])}</span>
        <input className="field min-w-0 flex-1" value={node.label} onChange={(e) => onChange({ ...node, label: e.target.value })} />
        <button className="icon-btn" title={t('Nach oben')} onClick={() => onMove(-1)}><Icon name="lucide:arrow-up" size={14} /></button>
        <button className="icon-btn" title={t('Nach unten')} onClick={() => onMove(1)}><Icon name="lucide:arrow-down" size={14} /></button>
        <button className="icon-btn" title={t('Entfernen')} onClick={onRemove}><Icon name="lucide:trash-2" size={14} /></button>
      </div>

      {node.kind === 'input' && <Field label="Standardwert"><textarea className="field min-h-14" value={cfg.value ?? ''} onChange={(e) => set({ value: e.target.value })} /></Field>}
      {node.kind === 'template' && <Field label="Vorlage ({{in}} = Eingänge)"><textarea className="field min-h-14 font-mono text-[12px]" value={cfg.template ?? ''} onChange={(e) => set({ template: e.target.value })} /></Field>}
      {node.kind === 'llm' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Modell oder Anbieter">
            <select className="field" value={engineValue} onChange={(e) => setEngine(e.target.value)}>
              <option value="">{t('– wählen –')}</option>
              {textModels.map((m) => <option key={m.id} value={`local:${m.id}`}>{m.name} ({t('lokal')})</option>)}
              {(['claude', 'codex', 'antigravity', 'opencode'] as const).map((p) => <option key={p} value={`cli:${p}`}>{p} ({t('CLI, nur lesend')})</option>)}
            </select>
          </Field>
          <Field label="Systemanweisung"><textarea className="field min-h-10" value={cfg.system ?? ''} onChange={(e) => set({ system: e.target.value || undefined })} /></Field>
        </div>
      )}
      {node.kind === 'image' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Bildmodell">
            <select className="field" value={cfg.modelId ?? ''} onChange={(e) => set({ modelId: e.target.value || undefined })}>
              <option value="">{t('– wählen –')}</option>
              {imageModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Schritte"><input className="field" value={cfg.steps ?? ''} onChange={(e) => set({ steps: Number(e.target.value.replace(/\D/g, '')) || 1 })} /></Field>
          <Field label="Negativ-Prompt"><input className="field" value={cfg.negative ?? ''} onChange={(e) => set({ negative: e.target.value || undefined })} /></Field>
        </div>
      )}
      {node.kind === 'condition' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Prüfung">
            <select className="field" value={cfg.mode ?? 'contains'} onChange={(e) => set({ mode: e.target.value as 'contains' | 'regex' })}>
              <option value="contains">{t('Enthält Text')}</option>
              <option value="regex">{t('Regulärer Ausdruck')}</option>
            </select>
          </Field>
          <Field label="Text oder Muster"><input className="field" value={cfg.pattern ?? ''} onChange={(e) => set({ pattern: e.target.value })} /></Field>
        </div>
      )}
      {node.kind === 'workflow' && (
        <Field label="Unter-Workflow">
          <select className="field" value={cfg.workflowId ?? ''} onChange={(e) => set({ workflowId: e.target.value || undefined })}>
            <option value="">{t('– wählen –')}</option>
            {workflows.filter((w) => w.id !== selfId).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      )}

      {node.kind !== 'output' && node.kind !== 'input' && (
        <div>
          <div className="mb-1 text-[11.5px] text-subtle">{t('Eingänge')}</div>
          <div className="flex flex-wrap gap-2">
            {sources.map((s) => s.kind === 'condition'
              ? (['true', 'false'] as const).map((port) => (
                <label key={`${s.id}${port}`} className={cx('flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]', has(s.id, port) ? 'border-accent bg-accent/10' : 'border-edge')}>
                  <input type="checkbox" className="hidden" checked={has(s.id, port)} onChange={() => toggleLink(s.id, port)} />
                  {s.label} · {port === 'true' ? t('wahr') : t('falsch')}
                </label>
              ))
              : (
                <label key={s.id} className={cx('flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]', has(s.id) ? 'border-accent bg-accent/10' : 'border-edge')}>
                  <input type="checkbox" className="hidden" checked={has(s.id)} onChange={() => toggleLink(s.id)} />
                  {s.label}
                </label>
              ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-[12px]">
        <label className="flex items-center gap-2"><span className="text-subtle">{t('Wiederholungen')}</span><input className="field w-16" value={cfg.retries ?? 0} onChange={(e) => set({ retries: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></label>
        <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={!!cfg.continueOnError} onChange={(e) => set({ continueOnError: e.target.checked || undefined })} /> {t('Bei Fehler weiterlaufen')}</label>
      </div>
    </article>
  );
}

function RunView({ runId, nodes, record, states }: { runId: string; nodes: WorkflowNode[]; record: RunRecord | null; states: Record<string, NodeState> }) {
  return (
    <section className="space-y-3 rounded-lumen-lg border border-edge bg-surface p-4">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Lauf')} · <span className="font-mono normal-case">{runId.slice(0, 8)}</span></h2>
        {record && <span className={cx('rounded-full px-2.5 py-0.5 text-[11.5px]', record.status === 'done' ? 'bg-ok/15 text-ok' : record.status === 'running' ? 'bg-accent/15 text-accent' : 'bg-bad/15 text-bad')}>{record.status}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {nodes.map((n) => {
          const s = states[n.id];
          return (
            <span key={n.id} className={cx('rounded-full px-2.5 py-1 text-[12px]', s ? STATUS_CLASS[s.status] : STATUS_CLASS.pending)}>
              {n.label} · {s ? t(STATUS_LABEL[s.status]) : t('wartet')}{s?.attempts && s.attempts > 1 ? ` · ${s.attempts}×` : ''}
            </span>
          );
        })}
      </div>
      {nodes.filter((n) => states[n.id]?.error).map((n) => (
        <div key={n.id} className="text-[12px] text-bad">{n.label}: {states[n.id].error}</div>
      ))}
      {record?.artifacts.map((a) => (
        <div key={a.nodeId + a.label} className="space-y-1">
          <div className="text-[11.5px] text-subtle">{a.label}</div>
          {a.text && <pre className="whitespace-pre-wrap rounded-lumen border border-edge bg-hover p-3 text-[12.5px]">{a.text}</pre>}
          {a.imagePath && <img src={imageUrl(a.imagePath)} alt={a.label} className="max-h-96 rounded-lumen border border-edge" />}
        </div>
      ))}
    </section>
  );
}

function WorkflowEditor({ id }: { id: string }) {
  const nav = useNavigate();
  const [wf, setWf] = useState<WorkflowDef | null>(null);
  const [name, setName] = useState('');
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [all, setAll] = useState<WorkflowDef[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, NodeState>>({});
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  // Nur Ereignisse des eigenen Laufs übernehmen (Unter-Workflows laufen unter eigenen Kennungen).
  const runRef = useRef<string | null>(null);

  const load = async () => {
    const w = await hub.wfGet(id);
    if (!w) { nav('/workflows', { replace: true }); return; }
    setWf(w); setName(w.name); setNodes(w.nodes); setDirty(false);
  };
  useEffect(() => {
    void load();
    void hub.models().then(setModels);
    void hub.wfList().then(setAll);
    return hub.onWfEvent((e: RunEvent) => {
      if (e.runId !== runRef.current) return;
      if (e.type === 'node') setStates((s) => ({ ...s, [e.nodeId]: e.state }));
      if (e.type === 'run') { setRecord(e.record); setStates(e.record.nodes); }
    });
  }, [id]);

  const issues = useMemo(() => validateWorkflow(nodes), [nodes]);
  const update = (next: WorkflowNode[]) => { setNodes(next); setDirty(true); };
  const save = async () => {
    const w = await hub.wfSave({ id, name, nodes });
    setWf(w); setDirty(false); setMsg(t('Gespeichert'));
    setAll(await hub.wfList());
    return w;
  };
  const run = async () => {
    if (dirty) await save();
    setMsg(null); setRecord(null); setStates({});
    try {
      const rid = await hub.wfRun(id, inputs);
      runRef.current = rid;
      setRunId(rid);
    } catch (e) { setMsg((e as Error).message); }
  };
  const restore = async (version: number) => {
    const w = await hub.wfRestore(id, version);
    if (w) { setWf(w); setName(w.name); setNodes(w.nodes); setDirty(false); setMsg(`${t('Version')} ${version} ${t('wiederhergestellt')} → v${w.version}`); }
  };
  const exportNow = async () => {
    const p = await hub.wfExport(id);
    if (p) void hub.revealPath(p);
  };
  const inputNodes = nodes.filter((n) => n.kind === 'input');

  if (!wf) return null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-5 px-6 py-8">
        <div className="flex flex-wrap items-center gap-2">
          <button className="icon-btn" title={t('Zurück')} onClick={() => nav('/workflows')}><Icon name="lucide:arrow-left" size={14} /></button>
          <input className="field min-w-0 flex-1 text-[18px] font-semibold" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
          <span className="rounded-full bg-hover px-2.5 py-0.5 text-[11.5px] text-subtle">v{wf.version}{dirty ? ` · ${t('ungespeichert')}` : ''}</span>
          <button className="btn" disabled={!dirty} onClick={() => void save()}>{t('Speichern')}</button>
          <button className="btn btn-primary" disabled={issues.length > 0 || (runId !== null && !record)} onClick={() => void run()}><Icon name="lucide:play" size={14} /> {t('Starten')}</button>
          {runId && !record && <button className="btn" onClick={() => void hub.wfCancel(runId)}><Icon name="lucide:square" size={14} /> {t('Stopp')}</button>}
          <button className="icon-btn" title={t('Exportieren')} onClick={() => void exportNow()}><Icon name="lucide:file-up" size={14} /></button>
        </div>

        {msg && <div className="text-[12px] text-subtle">{msg}</div>}
        {issues.length > 0 && (
          <div className="rounded-lumen border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">
            {issues.map((i, k) => <div key={k}>{i.nodeId ? `${nodes.find((n) => n.id === i.nodeId)?.label ?? ''}: ` : ''}{i.message}</div>)}
          </div>
        )}

        {inputNodes.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Eingaben für den Start')}</h2>
            {inputNodes.map((n) => (
              <Field key={n.id} label={n.label}>
                <textarea className="field min-h-12" value={inputs[n.id] ?? n.config.value ?? ''} onChange={(e) => setInputs((i) => ({ ...i, [n.id]: e.target.value }))} />
              </Field>
            ))}
          </section>
        )}

        <section className="space-y-3">
          {nodes.map((n, i) => (
            <NodeEditor
              key={n.id}
              node={n}
              nodes={nodes}
              models={models}
              workflows={all}
              selfId={id}
              onChange={(next) => update(nodes.map((x) => (x.id === n.id ? next : x)))}
              onRemove={() => update(nodes.filter((x) => x.id !== n.id).map((x) => ({ ...x, inputs: x.inputs.filter((l) => l.from !== n.id) })))}
              onMove={(d) => {
                const j = i + d;
                if (j < 0 || j >= nodes.length) return;
                const next = [...nodes];
                [next[i], next[j]] = [next[j], next[i]];
                update(next);
              }}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <button key={k} className="btn" onClick={() => update([...nodes, newNode(k)])}><Icon name="lucide:plus" size={14} /> {t(KIND_LABEL[k])}</button>
            ))}
          </div>
        </section>

        {runId && <RunView runId={runId} nodes={nodes} record={record} states={states} />}

        {wf.history.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Versionen')}</h2>
            {wf.history.map((h) => (
              <div key={h.version} className="flex items-center gap-3 rounded-lumen border border-edge px-3 py-2 text-[12.5px]">
                <span className="flex-1 text-subtle">v{h.version} · {new Date(h.at).toLocaleString('de-DE')} · {h.nodes.length} {t('Knoten')}</span>
                <button className="btn" onClick={() => void restore(h.version)}>{t('Wiederherstellen')}</button>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

export function WorkflowsPage() {
  const { id } = useParams();
  return id ? <WorkflowEditor key={id} id={id} /> : <WorkflowList />;
}
