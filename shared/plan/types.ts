export type ID = string;
export type ISODate = string;

export type PlanStatus =
  | "draft" | "analyzing" | "ready" | "approved"
  | "running" | "paused" | "verifying" | "completed"
  | "failed" | "cancelled" | "archived";

export type TaskStatus =
  | "pending" | "blocked" | "queued" | "running"
  | "verifying" | "completed" | "failed"
  | "skipped" | "cancelled" | "interrupted";

export interface Plan {
  id: ID;
  workspaceId: ID;
  chatId?: ID;
  title: string;
  description: string;
  currentRevisionId: ID;
  status: PlanStatus; // denormalisierte Anzeige; Run bleibt authoritative
  createdAt: ISODate;
  updatedAt: ISODate;
  archivedAt?: ISODate;
}

export interface PlanRevision {
  id: ID;
  planId: ID;
  revision: number;
  objective: string;
  requirements: string[];
  constraints: string[];
  assumptions: string[];
  outOfScope: string[];
  phases: PlanPhase[];
  tasks: PlanTask[];
  modelAssignments: ModelAssignment[];
  createdBy: "user" | "model";
  createdAt: ISODate;
  contentHash: string;
}

export interface PlanPhase {
  id: ID;
  title: string;
  order: number;
}

export interface PlanTask {
  id: ID;
  phaseId: ID;
  order: number;
  title: string;
  description: string;
  dependencies: ID[];
  priority: "low" | "normal" | "high" | "critical";
  complexity: "simple" | "moderate" | "complex";
  instructions: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  expectedFiles: string[];
  expectedArtifacts: string[];
  assignedRole?: string;
  modelAssignmentId?: ID;
  requiresApproval: boolean;
  maxAttempts: number;
}

export interface AcceptanceCriterion {
  id: ID;
  description: string;
  verification: "manual" | "test" | "command" | "model_review";
  command?: string; // nur nach Policy-Freigabe ausführen
}

export interface ModelAssignment {
  id: ID;
  role: string;
  providerId: string;
  modelId: string;
  fallbackModelIds: string[];
}

export interface ApprovalScope {
  workspaceRoot: string;
  allowedPaths: string[];
  allowedTools: string[];
  allowNetwork: boolean;
  allowShell: boolean;
  maxCostUsd?: number;
  expiresAt?: ISODate;
}

export interface PlanApproval {
  id: ID;
  planId: ID;
  revisionId: ID;
  approvedBy: string;
  approvedAt: ISODate;
  scope: ApprovalScope;
  revokedAt?: ISODate;
}

export interface PlanExecution {
  id: ID;
  planId: ID;
  revisionId: ID;
  approvalId: ID;
  status: "queued" | "running" | "paused" | "verifying"
    | "completed" | "failed" | "cancelled" | "interrupted";
  maxConcurrency: number;
  startedAt?: ISODate;
  finishedAt?: ISODate;
}

export interface TaskExecution {
  id: ID;
  executionId: ID;
  taskId: ID;
  status: TaskStatus;
  attempt: number;
  startedAt?: ISODate;
  finishedAt?: ISODate;
  outputArtifactIds: ID[];
  error?: string;
}

export interface TaskAttempt {
  id: ID;
  taskExecutionId: ID;
  number: number;
  providerId: string;
  modelId: string;
  status: "running" | "succeeded" | "failed" | "interrupted";
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  startedAt: ISODate;
  finishedAt?: ISODate;
  errorJson?: string;
}

export interface PlanEvent {
  id: ID;
  planId: ID;
  executionId?: ID;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: ISODate;
}

export type PlanDefinition = Pick<PlanRevision, 'objective' | 'requirements' | 'constraints' | 'assumptions' | 'outOfScope' | 'phases' | 'tasks' | 'modelAssignments'>;
export interface PlanSnapshot {
  workspaceRoot: string;
  plan: Plan;
  revisions: PlanRevision[];
  approvals: (PlanApproval & { contentHash: string })[];
  events: PlanEvent[];
  questions: PlanQuestion[];
}
export interface PlanSaveInput {
  id?: string;
  workspaceRoot: string;
  title: string;
  definition: PlanDefinition;
  expectedRevisionId?: string;
}

export interface PlanQuestion {
  id: string;
  planId: string;
  revisionId: string;
  question: string;
  options: string[];
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}
