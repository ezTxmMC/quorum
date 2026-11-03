import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { ApprovalScope, Plan, PlanApproval, PlanDefinition, PlanEvent, PlanQuestion, PlanRevision, PlanSaveInput, PlanSnapshot } from '../../shared/plan/types.ts';
import { validateDefinition, validateRelativePath } from '../../shared/plan/validation.ts';
import { workspacePath, workspaceRoot } from '../ide/paths.ts';
import { openPlanDatabase } from './database.ts';

type Row = Record<string, unknown>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function definitionHash(definition: PlanDefinition): string {
  return createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

function toPlan(row: Row): Plan {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), title: String(row.title), description: '',
    currentRevisionId: String(row.current_revision_id), status: row.status as Plan['status'],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export class PlanService {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = openPlanDatabase(path);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private write(sql: string, ...values: SQLInputValue[]): void {
    this.db.prepare(sql).run(...values);
  }

  private event(planId: string, type: string, payload: unknown): void {
    this.write(`INSERT INTO plan_events VALUES (?, ?,
      (SELECT COALESCE(MAX(sequence), 0) + 1 FROM plan_events WHERE plan_id = ?), ?, ?, ?)`,
    randomUUID(), planId, planId, type, JSON.stringify(payload), new Date().toISOString());
  }

  list(root?: string): Plan[] {
    if (root) {
      return this.db.prepare('SELECT plans.* FROM plans JOIN workspaces ON workspaces.id = plans.workspace_id WHERE workspaces.root = ? ORDER BY updated_at DESC').all(workspaceRoot(root)).map(toPlan);
    }
    return this.db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all().map(toPlan);
  }

  get(id: string): PlanSnapshot {
    const row = this.db.prepare('SELECT plans.*, workspaces.root FROM plans JOIN workspaces ON workspaces.id = plans.workspace_id WHERE plans.id = ?').get(id);
    if (!row) {
      throw new Error('Plan not found');
    }
    const revisions: PlanRevision[] = this.db.prepare('SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision').all(id).map((revision) => ({
      ...JSON.parse(String(revision.definition_json)) as PlanDefinition,
      id: String(revision.id), planId: id, revision: Number(revision.revision), contentHash: String(revision.content_hash),
      createdAt: String(revision.created_at), createdBy: 'user',
    }));
    const approvals: (PlanApproval & { contentHash: string })[] = this.db.prepare('SELECT * FROM plan_approvals WHERE plan_id = ? ORDER BY approved_at').all(id).map((approval) => ({
      id: String(approval.id), planId: id, revisionId: String(approval.revision_id), contentHash: String(approval.content_hash),
      approvedBy: String(approval.approved_by), approvedAt: String(approval.approved_at),
      scope: JSON.parse(String(approval.scope_json)) as ApprovalScope,
      revokedAt: approval.revoked_at ? String(approval.revoked_at) : undefined,
    }));
    const events: PlanEvent[] = this.db.prepare('SELECT * FROM plan_events WHERE plan_id = ? ORDER BY sequence').all(id).map((event) => ({
      id: String(event.id), planId: id, sequence: Number(event.sequence), type: String(event.type),
      payload: JSON.parse(String(event.payload_json)) as unknown, createdAt: String(event.created_at),
    }));
    const questions: PlanQuestion[] = this.db.prepare('SELECT * FROM plan_questions WHERE plan_id = ? ORDER BY created_at').all(id).map((question) => ({
      id: String(question.id), planId: id, revisionId: String(question.revision_id), question: String(question.question),
      options: JSON.parse(String(question.options_json)) as string[], answer: question.answer === null ? undefined : String(question.answer),
      createdAt: String(question.created_at), answeredAt: question.answered_at === null ? undefined : String(question.answered_at),
    }));
    return { questions, workspaceRoot: String(row.root), plan: toPlan(row), revisions, approvals, events };
  }

  save(input: PlanSaveInput): PlanSnapshot {
    validateDefinition(input.definition);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) {
      throw new Error('Plan title must contain 1–200 characters');
    }
    const root = workspaceRoot(input.workspaceRoot);
    const definition = JSON.stringify(input.definition);
    if (definition.length > 2_000_000) {
      throw new Error('Plan definition exceeds 2 MB');
    }
    const id = input.id ?? randomUUID();
    this.transaction(() => {
      const now = new Date().toISOString();
      const existing = input.id ? this.get(input.id) : undefined;
      if (existing && (existing.plan.currentRevisionId !== input.expectedRevisionId || existing.workspaceRoot !== root)) {
        throw new Error('Plan changed or workspace mismatch; reload before saving');
      }
      if (!existing) {
        this.write('INSERT OR IGNORE INTO workspaces VALUES (?, ?)', randomUUID(), root);
        const workspace = this.db.prepare('SELECT id FROM workspaces WHERE root = ?').get(root);
        this.write('INSERT INTO plans VALUES (?, ?, ?, NULL, ?, ?, ?)', id, String(workspace?.id), input.title.trim(), 'draft', now, now);
      }
      const revisionId = randomUUID();
      this.write('INSERT INTO plan_revisions VALUES (?, ?, ?, ?, ?, ?)', revisionId, id,
        (existing?.revisions.length ?? 0) + 1, definition, definitionHash(input.definition), now);
      this.write('UPDATE plans SET title = ?, current_revision_id = ?, status = ?, updated_at = ? WHERE id = ?', input.title.trim(), revisionId, 'draft', now, id);
      this.event(id, 'revision.created', { revisionId });
    });
    return this.get(id);
  }

  approve(id: string, revisionId: string, scope: ApprovalScope): PlanSnapshot {
    this.transaction(() => {
      const snapshot = this.get(id);
      if (snapshot.plan.status === 'archived') {
        throw new Error('Archived plans cannot be approved');
      }
      const revision = snapshot.revisions.find((candidate) => candidate.id === revisionId);
      if (!revision || snapshot.plan.currentRevisionId !== revisionId) {
        throw new Error('Only the current revision can be approved');
      }
      if (snapshot.questions.some((question) => question.revisionId === revisionId && !question.answeredAt)) {
        throw new Error('Answer open questions before approving this revision');
      }
      validateDefinition(revision);
      const { objective, requirements, constraints, assumptions, outOfScope, phases, tasks, modelAssignments } = revision;
      if (definitionHash({ objective, requirements, constraints, assumptions, outOfScope, phases, tasks, modelAssignments }) !== revision.contentHash) {
        throw new Error('Revision integrity check failed');
      }
      this.validateScope(snapshot.workspaceRoot, scope);
      this.write('INSERT INTO plan_approvals VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', randomUUID(), id, revisionId,
        revision.contentHash, 'user', new Date().toISOString(), JSON.stringify(scope));
      this.write('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', 'approved', new Date().toISOString(), id);
      this.event(id, 'revision.approved', { revisionId, contentHash: revision.contentHash, scope });
    });
    return this.get(id);
  }

  revoke(id: string, approvalId: string): PlanSnapshot {
    this.transaction(() => {
      const snapshot = this.get(id);
      const approval = snapshot.approvals.find((candidate) => candidate.id === approvalId && !candidate.revokedAt);
      if (!approval) {
        throw new Error('Active approval not found');
      }
      this.write('UPDATE plan_approvals SET revoked_at = ? WHERE id = ?', new Date().toISOString(), approvalId);
      const active = this.get(id).approvals.some((candidate) => !candidate.revokedAt && candidate.revisionId === snapshot.plan.currentRevisionId);
      if (!active) {
        this.write('UPDATE plans SET status = ? WHERE id = ?', 'draft', id);
      }
      this.event(id, 'approval.revoked', { approvalId });
    });
    return this.get(id);
  }

  ask(id: string, revisionId: string, question: string, options: string[] = []): PlanSnapshot {
    if (typeof question !== 'string' || !question.trim() || question.length > 10000 || !Array.isArray(options) || options.length > 10 || options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 1000)) {
      throw new Error('Invalid plan question');
    }
    this.transaction(() => {
      const snapshot = this.get(id);
      if (snapshot.plan.status === 'archived') {
        throw new Error('Archived plans cannot receive questions');
      }
      if (snapshot.plan.currentRevisionId !== revisionId) {
        throw new Error('Question must refer to the current revision');
      }
      const questionId = randomUUID();
      this.write('INSERT INTO plan_questions VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)', questionId, id, revisionId, question.trim(), JSON.stringify(options), new Date().toISOString());
      this.write('UPDATE plan_approvals SET revoked_at = ? WHERE plan_id = ? AND revision_id = ? AND revoked_at IS NULL', new Date().toISOString(), id, revisionId);
      this.write('UPDATE plans SET status = ? WHERE id = ?', 'draft', id);
      this.event(id, 'question.created', { questionId, revisionId });
    });
    return this.get(id);
  }

  answer(id: string, questionId: string, answer: string): PlanSnapshot {
    if (typeof answer !== 'string' || !answer.trim() || answer.length > 10000) {
      throw new Error('Answer must contain 1–10000 characters');
    }
    this.transaction(() => {
      const question = this.get(id).questions.find((candidate) => candidate.id === questionId);
      if (!question || question.answeredAt) {
        throw new Error('Unanswered question not found');
      }
      this.write('UPDATE plan_questions SET answer = ?, answered_at = ? WHERE id = ?', answer.trim(), new Date().toISOString(), questionId);
      this.event(id, 'question.answered', { questionId });
    });
    return this.get(id);
  }

  archive(id: string): PlanSnapshot {
    this.transaction(() => {
      this.get(id);
      const now = new Date().toISOString();
      this.write('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?', 'archived', now, id);
      this.write('UPDATE plan_approvals SET revoked_at = ? WHERE plan_id = ? AND revoked_at IS NULL', now, id);
      this.event(id, 'plan.archived', {});
    });
    return this.get(id);
  }

  export(id: string): string {
    const snapshot = this.get(id);
    const revision = snapshot.revisions[snapshot.revisions.length - 1];
    const definition: PlanDefinition = {
      objective: revision.objective, requirements: revision.requirements, constraints: revision.constraints,
      assumptions: revision.assumptions, outOfScope: revision.outOfScope, phases: revision.phases,
      tasks: revision.tasks, modelAssignments: revision.modelAssignments,
    };
    return JSON.stringify({ format: 'quorum-plan', version: 1, title: snapshot.plan.title, definition }, null, 2);
  }

  import(root: string, value: unknown): PlanSnapshot {
    if (!value || typeof value !== 'object') {
      throw new Error('Invalid plan export');
    }
    const input = value as Record<string, unknown>;
    if (input.format !== 'quorum-plan' || input.version !== 1 || typeof input.title !== 'string') {
      throw new Error('Unsupported plan export');
    }
    validateDefinition(input.definition);
    return this.save({ workspaceRoot: root, title: input.title, definition: input.definition });
  }

  private validateScope(root: string, scope: ApprovalScope): void {
    if (!scope || workspaceRoot(scope.workspaceRoot) !== root || !Array.isArray(scope.allowedPaths) || !Array.isArray(scope.allowedTools)) {
      throw new Error('Invalid approval scope');
    }
    if (typeof scope.allowShell !== 'boolean' || typeof scope.allowNetwork !== 'boolean') {
      throw new Error('Explicit shell and network permissions required');
    }
    if (scope.expiresAt !== undefined && (!Number.isFinite(Date.parse(scope.expiresAt)) || Date.parse(scope.expiresAt) <= Date.now())) {
      throw new Error('Approval expiry must be in the future');
    }
    if (scope.maxCostUsd !== undefined && (!Number.isFinite(scope.maxCostUsd) || scope.maxCostUsd < 0)) {
      throw new Error('Invalid cost limit');
    }
    for (const path of scope.allowedPaths) {
      if (typeof path !== 'string') {
        throw new Error('Invalid allowed path');
      }
      validateRelativePath(path);
      workspacePath(root, path);
    }
    for (const tool of scope.allowedTools) {
      if (!['read', 'write', 'git', 'shell', 'network'].includes(tool)) {
        throw new Error('Unknown tool permission');
      }
    }
    if (scope.allowedTools.includes('shell') !== scope.allowShell || scope.allowedTools.includes('network') !== scope.allowNetwork) {
      throw new Error('Inconsistent tool scope');
    }
  }
}
