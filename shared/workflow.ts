// Workflow-Modell: Knoten mit typisierten Ein- und Ausgängen, Kanten zwischen ihnen.
// Reine Funktionen (Validierung, Reihenfolge) – laufen im Main-Prozess (Ausführung) und in der Oberfläche (Prüfung beim Bearbeiten).

export type PortType = 'text' | 'image';

export type NodeKind = 'input' | 'template' | 'llm' | 'image' | 'condition' | 'output' | 'workflow';

/** Eingangsart je Knoten-Art; `any` nimmt Text oder Bild entgegen. */
export const INPUT_TYPE: Record<NodeKind, PortType | 'any' | undefined> = {
  input: undefined,
  template: 'text',
  llm: 'text',
  image: 'text',
  condition: 'text',
  output: 'any',
  workflow: 'any',
};

/** Ausgangsart je Knoten-Art. Ausgang `output` außer bei der Bedingung, die zusätzlich `true`/`false` hat. */
export const OUTPUT_TYPE: Record<NodeKind, PortType | undefined> = {
  input: 'text',
  template: 'text',
  llm: 'text',
  image: 'image',
  condition: 'text',
  output: undefined,
  workflow: 'text',
};

export const KIND_LABEL: Record<NodeKind, string> = {
  input: 'Eingabe',
  template: 'Vorlage',
  llm: 'Sprachmodell',
  image: 'Bildmodell',
  condition: 'Bedingung',
  output: 'Ausgabe',
  workflow: 'Unter-Workflow',
};

export type LlmEngine = { type: 'local'; modelId: string } | { type: 'cli'; provider: 'claude' | 'codex' | 'antigravity' | 'opencode' };

export interface NodeConfig {
  /** input: Wert der Eingabe (überschreibbar beim Start). */
  value?: string;
  /** template: Text mit {{in}} als Platzhalter für die Eingänge (verbunden mit Leerzeile). */
  template?: string;
  /** llm: Modell oder CLI-Anbieter; system: Systemanweisung. */
  engine?: LlmEngine;
  system?: string;
  /** image: lokales Diffusers-Modell und Parameter. */
  modelId?: string;
  steps?: number;
  guidance?: number;
  width?: number;
  height?: number;
  negative?: string;
  seed?: number;
  /** condition: Prüfung auf Text (contains) oder regulären Ausdruck (regex). */
  mode?: 'contains' | 'regex';
  pattern?: string;
  /** workflow: ID des aufgerufenen Workflows. */
  workflowId?: string;
  /** Anzahl Wiederholungen bei Fehlern und ob der Lauf bei einem Fehler dieses Knotens weitergeht. */
  retries?: number;
  continueOnError?: boolean;
}

/** Eingangsverbindung: Quelle ist ein Knoten, optional mit Ausgangs-Port (`true`/`false` bei Bedingungen). */
export interface Link {
  from: string;
  port?: 'true' | 'false';
}

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  label: string;
  config: NodeConfig;
  inputs: Link[];
}

export interface WorkflowDef {
  id: string;
  name: string;
  version: number;
  nodes: WorkflowNode[];
  /** Frühere Fassungen (neueste zuerst). */
  history: { version: number; at: number; nodes: WorkflowNode[] }[];
  createdAt: number;
  updatedAt: number;
}

export interface ValidationIssue {
  nodeId?: string;
  message: string;
}

const MAX_NODES = 60;

/** Prüft Struktur, Verbindungen, Typen und Kreise. Leere Liste = gültig. */
export function validateWorkflow(nodes: WorkflowNode[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (nodes.length === 0) issues.push({ message: 'Der Workflow hat keine Knoten.' });
  if (nodes.length > MAX_NODES) issues.push({ message: `Höchstens ${MAX_NODES} Knoten.` });
  const byId = new Map<string, WorkflowNode>();
  for (const n of nodes) {
    if (byId.has(n.id)) issues.push({ nodeId: n.id, message: 'Doppelte Knoten-ID.' });
    byId.set(n.id, n);
  }
  for (const n of nodes) {
    const kindIssue = (msg: string) => issues.push({ nodeId: n.id, message: msg });
    if (n.kind === 'input' && n.inputs.length) kindIssue('Eingaben haben keine Eingänge.');
    if (n.kind !== 'input' && n.kind !== 'workflow' && n.inputs.length === 0) kindIssue('Ohne Eingang nicht ausführbar.');
    if (n.kind === 'llm' && !n.config.engine) kindIssue('Kein Modell oder Anbieter gewählt.');
    if (n.kind === 'image' && !n.config.modelId) kindIssue('Kein Bildmodell gewählt.');
    if (n.kind === 'workflow' && !n.config.workflowId) kindIssue('Kein Unter-Workflow gewählt.');
    if (n.kind === 'condition' && n.config.mode === 'regex') {
      try { new RegExp(n.config.pattern ?? ''); } catch { kindIssue('Ungültiger regulärer Ausdruck.'); }
    }
    if (n.kind === 'condition' && n.inputs.some((l) => l.port)) kindIssue('Eingänge einer Bedingung haben keine Ports.');
    for (const link of n.inputs) {
      const src = byId.get(link.from);
      if (!src) { kindIssue(`Eingang von unbekanntem Knoten ${link.from}.`); continue; }
      if (link.port && src.kind !== 'condition') { kindIssue(`Port ${link.port} gibt es nur bei Bedingungen.`); continue; }
      if (src.kind === 'condition' && !link.port) { kindIssue('Ausgang einer Bedingung braucht den Port true oder false.'); continue; }
      if (src.kind === 'output') { kindIssue('Ausgaben können nicht als Eingang dienen.'); continue; }
      const out = OUTPUT_TYPE[src.kind];
      const want = INPUT_TYPE[n.kind];
      if (want && want !== 'any' && out && out !== want) kindIssue(`Typ passt nicht: ${out} → ${want}.`);
    }
  }
  const cycle = findCycle(nodes);
  if (cycle) issues.push({ nodeId: cycle, message: 'Der Workflow enthält einen Kreis.' });
  return issues;
}

/** Knoten-ID, an der ein Kreis erkannt wurde, oder undefined. */
function findCycle(nodes: WorkflowNode[]): string | undefined {
  const deps = new Map(nodes.map((n) => [n.id, n.inputs.map((l) => l.from)]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unbesucht, 1 in Arbeit, 2 fertig
  const visit = (id: string): string | undefined => {
    const s = state.get(id) ?? 0;
    if (s === 1) return id;
    if (s === 2) return undefined;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      const hit = visit(d);
      if (hit) return hit;
    }
    state.set(id, 2);
    return undefined;
  };
  for (const n of nodes) {
    const hit = visit(n.id);
    if (hit) return hit;
  }
  return undefined;
}

/** Ausführungsreihenfolge (Abhängigkeiten zuerst). Setzt gültige Knoten voraus; Kreise werden ausgelassen. */
export function topoOrder(nodes: WorkflowNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const done = new Set<string>();
  const order: string[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const n of nodes) {
      if (done.has(n.id)) continue;
      if (n.inputs.every((l) => !ids.has(l.from) || done.has(l.from))) {
        done.add(n.id);
        order.push(n.id);
        progress = true;
      }
    }
  }
  return order;
}
