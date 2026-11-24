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
