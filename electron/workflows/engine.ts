// Workflow-Engine: führt einen Knoten-Graphen aus. Bereite Knoten laufen parallel, Verzweigungen werden über
// Bedingungen gesteuert, Fehler werden wiederholt (mit Backoff) und können den Lauf stoppen oder weiterlaufen lassen.
// Jeder Knoten läuft unter seiner eigenen Kennung, damit Abbruch und Logs eindeutig bleiben.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from '../../shared/types';
import type { ChatMessage } from '../../shared/models';
import { topoOrder, type WorkflowDef, type WorkflowNode } from '../../shared/workflow';
import { runLocalChat, runLocalImage } from '../models/chat';
import { runCli, cancelRun } from '../providers/runner';
import { dataDir } from '../store';

export type NodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface NodeState {
  status: NodeStatus;
  /** Ergebnis: Text oder Bildpfad. */
  text?: string;
  imagePath?: string;
  /** Bedingungen: welcher Ausgang gewählt wurde. */
  branch?: 'true' | 'false';
  error?: string;
  attempts: number;
  ms?: number;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  nodes: Record<string, NodeState>;
  /** Ergebnisse der Ausgabe-Knoten. */
  artifacts: { nodeId: string; label: string; text?: string; imagePath?: string }[];
}

export type RunEvent =
  | { type: 'node'; runId: string; nodeId: string; state: NodeState }
  | { type: 'run'; runId: string; status: RunRecord['status']; record: RunRecord };

export interface RunOptions {
  runId: string;
  /** Werte für Eingabe-Knoten (Schlüssel: Knoten-ID). */
  inputs?: Record<string, string>;
  emit: (e: RunEvent) => void;
  binaries: Partial<Record<ProviderId, string>>;
  /** Unter-Workflows nachschlagen. */
  resolve: (id: string) => WorkflowDef | undefined;
  depth?: number;
}

const MAX_DEPTH = 4;
const active = new Map<string, AbortController>();

/** Bricht einen laufenden Workflow ab: wartende Knoten werden übersprungen, laufende gestoppt. */
export function cancelWorkflowRun(runId: string): boolean {
  const c = active.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Scratch-Ordner für CLI-Anbieter (wie in den übrigen Läufen: ohne echte Projektdateien). */
function scratchDir(): string {
  const d = join(dataDir(), 'scratch');
  mkdirSync(d, { recursive: true });
  return d;
}

export async function runWorkflow(wf: WorkflowDef, opts: RunOptions): Promise<RunRecord> {
  const depth = opts.depth ?? 0;
  const ctl = new AbortController();
  active.set(opts.runId, ctl);
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const order = topoOrder(wf.nodes);
  const record: RunRecord = {
    id: opts.runId,
    workflowId: wf.id,
    workflowName: wf.name,
    workflowVersion: wf.version,
    status: 'running',
    startedAt: Date.now(),
    nodes: Object.fromEntries(wf.nodes.map((n) => [n.id, { status: 'pending', attempts: 0 } as NodeState])),
    artifacts: [],
  };
  const report = (nodeId: string) => opts.emit({ type: 'node', runId: opts.runId, nodeId, state: record.nodes[nodeId] });
  let fatal = false;

  /** Ist ein Eingang verfügbar? `undefined` = noch offen (Quelle läuft noch). */
  const linkState = (nodeId: string): 'ready' | 'blocked' | 'open' => {
    const node = byId.get(nodeId)!;
    if (node.inputs.length === 0) return 'ready';
    let open = false;
    let any = false;
    for (const link of node.inputs) {
      const src = record.nodes[link.from];
      if (!src || src.status === 'pending' || src.status === 'running') { open = true; continue; }
      if (src.status !== 'done') continue;
      const srcNode = byId.get(link.from)!;
      if (srcNode.kind === 'condition' && src.branch !== link.port) continue;
      any = true;
    }
    if (open) return 'open';
    return any ? 'ready' : 'blocked';
  };

  /** Eingangstexte in Reihenfolge der Verbindungen (Quellen mit Ergebnis). */
  const inputTexts = (node: WorkflowNode): string[] =>
    node.inputs
      .map((l) => ({ l, s: record.nodes[l.from] }))
      .filter(({ l, s }) => s?.status === 'done' && (byId.get(l.from)?.kind !== 'condition' || s.branch === l.port))
      .map(({ s }) => s.text ?? '')
      .filter((t) => t.length > 0);

  /** Knoten einmal ausführen. Wirft bei Fehlern. */
  const execute = async (node: WorkflowNode, nodeRun: string): Promise<Partial<NodeState>> => {
    const texts = inputTexts(node);
    const joined = texts.join('\n\n');
    switch (node.kind) {
      case 'input': {
        const value = opts.inputs?.[node.id] ?? node.config.value ?? '';
        return { text: value };
      }
      case 'template': {
        const tpl = node.config.template ?? '{{in}}';
        return { text: tpl.split('{{in}}').join(joined) };
      }
      case 'llm': {
        const engine = node.config.engine;
        if (!engine) throw new Error('Kein Modell gewählt');
        const user = joined;
        if (engine.type === 'local') {
          const messages: ChatMessage[] = [];
          if (node.config.system) messages.push({ role: 'system', content: node.config.system });
          messages.push({ role: 'user', content: user });
          const r = await runLocalChat({ runId: nodeRun, modelId: engine.modelId, messages, priority: 1, onDelta: () => {} });
          if (!r.ok) throw new Error(r.error ?? 'Sprachmodell fehlgeschlagen');
          return { text: r.text.trim() };
        }
        // CLI-Anbieter: nur lesend, in einem leeren Arbeitsordner.
        const prompt = node.config.system ? `${node.config.system}\n\n---\n\n${user}` : user;
        const options = engine.provider === 'codex' ? { sandbox: 'read-only' } : { permission: 'plan' };
        const res = await runCli({ runId: nodeRun, provider: engine.provider, cwd: scratchDir(), prompt, options }, () => {}, opts.binaries);
        if (!res.ok) throw new Error(`${engine.provider} fehlgeschlagen`);
        return { text: res.text.trim() };
      }
      case 'image': {
        const r = await runLocalImage({
          runId: nodeRun,
          modelId: node.config.modelId!,
          params: {
            prompt: joined,
            negative: node.config.negative,
            steps: node.config.steps,
            guidance: node.config.guidance,
            width: node.config.width,
            height: node.config.height,
            seed: node.config.seed,
          },
        });
        if (!r.ok || !r.path) throw new Error(r.error ?? 'Bild fehlgeschlagen');
        return { imagePath: r.path, text: undefined };
      }
      case 'condition': {
        const hit = node.config.mode === 'regex'
          ? new RegExp(node.config.pattern ?? '', 'i').test(joined)
          : joined.toLowerCase().includes((node.config.pattern ?? '').toLowerCase());
        return { text: joined, branch: hit ? 'true' : 'false' };
      }
      case 'output': {
        // Ausgabe trägt Text und das erste Bild seiner Eingänge (Bildknoten liefern nur einen Pfad).
        const img = node.inputs.map((l) => record.nodes[l.from]).find((s) => s?.status === 'done' && s.imagePath);
        return { text: joined || undefined, imagePath: img?.imagePath };
      }
      case 'workflow': {
        if (depth >= MAX_DEPTH) throw new Error('Unter-Workflows sind zu tief verschachtelt');
        const child = opts.resolve(node.config.workflowId!);
        if (!child) throw new Error('Unter-Workflow nicht gefunden');
        // Jeder Eingabe-Knoten des Unter-Workflows bekommt den gesammelten Eingangstext.
        const inputs = Object.fromEntries(child.nodes.filter((n) => n.kind === 'input').map((n) => [n.id, joined]));
        const sub = await runWorkflow(child, { ...opts, runId: nodeRun, inputs, depth: depth + 1 });
        if (sub.status !== 'done') throw new Error(`Unter-Workflow ${sub.status}`);
        const last = sub.artifacts.filter((a) => a.text !== undefined).pop();
        return { text: last?.text ?? '' };
      }
    }
  };

  /** Ein Knoten mit Wiederholungen. Setzt den Status am Ende; wirft nie. */
  const runNode = async (node: WorkflowNode): Promise<void> => {
    const st = record.nodes[node.id];
    st.status = 'running';
    report(node.id);
    const started = Date.now();
    const retries = Math.max(0, node.config.retries ?? 0);
    const nodeRun = `${opts.runId}/${node.id}`;
    // Abbruch des Laufs stoppt auch den laufenden Prozess dieses Knotens (CLI oder Modell).
    const stop = () => cancelRun(nodeRun);
    ctl.signal.addEventListener('abort', stop, { once: true });
    for (let attempt = 0; ; attempt++) {
      st.attempts = attempt + 1;
      if (ctl.signal.aborted) break;
      try {
        const out = await execute(node, nodeRun);
        Object.assign(st, out, { status: 'done', error: undefined, ms: Date.now() - started });
        if (node.kind === 'output') record.artifacts.push({ nodeId: node.id, label: node.label, text: st.text, imagePath: st.imagePath });
        ctl.signal.removeEventListener('abort', stop);
        report(node.id);
        return;
      } catch (e) {
        st.error = e instanceof Error ? e.message : String(e);
        if (ctl.signal.aborted || attempt >= retries) break;
        await sleep(1000 * 2 ** attempt, ctl.signal);
      }
    }
    ctl.signal.removeEventListener('abort', stop);
    if (ctl.signal.aborted && st.status === 'running') {
      st.status = 'skipped';
      st.error = 'Abgebrochen';
    } else {
      st.status = 'failed';
      st.ms = Date.now() - started;
      if (!node.config.continueOnError) fatal = true;
    }
    report(node.id);
  };

  const running = new Map<string, Promise<void>>();
  const launch = (node: WorkflowNode) => {
    const p = runNode(node).finally(() => running.delete(node.id));
    running.set(node.id, p);
  };

  try {
    for (;;) {
      // Knoten, deren Eingänge feststehen, starten oder überspringen.
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of order) {
          const st = record.nodes[id];
          if (st.status !== 'pending') continue;
          if (ctl.signal.aborted || fatal) {
            st.status = 'skipped';
            changed = true;
            report(id);
            continue;
          }
          const node = byId.get(id)!;
          const state = linkState(id);
          if (state === 'open') continue;
          if (state === 'blocked') {
            st.status = 'skipped';
            changed = true;
            report(id);
            continue;
          }
          if (!running.has(id)) { launch(node); changed = true; }
        }
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
  } finally {
    active.delete(opts.runId);
  }

  // Übrig gebliebene Knoten (z. B. nach Abbruch) gelten als übersprungen.
  for (const id of order) {
    if (record.nodes[id].status === 'pending') record.nodes[id].status = 'skipped';
  }
  record.status = ctl.signal.aborted ? 'stopped' : fatal ? 'failed' : 'done';
  record.endedAt = Date.now();
  // Ausgabeknoten in Workflow-Reihenfolge zeigen, nicht in Ausführungsreihenfolge.
  record.artifacts.sort((a, b) => order.indexOf(a.nodeId) - order.indexOf(b.nodeId));
  opts.emit({ type: 'run', runId: opts.runId, status: record.status, record });
  return record;
}
