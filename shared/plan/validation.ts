import type { PlanDefinition } from './types.ts';

const MAX_TASKS = 500;

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
}

function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000) {
    throw new Error('Expected non-empty text (maximum 100000 characters)');
  }
}

function strings(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 1000) {
    throw new Error('Expected a bounded string array');
  }
  for (const item of value) {
    text(item);
  }
}

export function validateRelativePath(path: string): void {
  if (!path || path.includes('\0') || /^(?:[\\/]|[a-z]:)/i.test(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error(`Path must stay inside the workspace: ${path}`);
  }
}

export function validateDefinition(value: unknown): asserts value is PlanDefinition {
  record(value);
  text(value.objective);
  for (const key of ['requirements', 'constraints', 'assumptions', 'outOfScope']) {
    strings(value[key]);
  }
  if (!Array.isArray(value.phases) || !value.phases.length || value.phases.length > MAX_TASKS) {
    throw new Error('Expected 1–500 phases');
  }
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > MAX_TASKS) {
    throw new Error('Expected 1–500 tasks');
  }
  const phases = new Set<string>();
  for (const phase of value.phases) {
    record(phase);
    text(phase.id);
    text(phase.title);
    if (phases.has(phase.id) || !Number.isSafeInteger(phase.order)) {
      throw new Error('Duplicate phase or invalid order');
    }
    phases.add(phase.id);
  }
  if (!Array.isArray(value.modelAssignments) || value.modelAssignments.length > MAX_TASKS) {
    throw new Error('Expected model assignments');
  }
  const assignments = new Set<string>();
  for (const assignment of value.modelAssignments) {
    record(assignment);
    for (const key of ['id', 'role', 'providerId', 'modelId']) {
      text(assignment[key]);
    }
    strings(assignment.fallbackModelIds);
    const id = assignment.id as string;
    if (assignments.has(id)) {
      throw new Error('Duplicate model assignment');
    }
    assignments.add(id);
  }
  const tasks = new Map<string, string[]>();
  for (const task of value.tasks) {
    record(task);
    text(task.id);
    text(task.title);
    text(task.description);
    strings(task.dependencies);
    strings(task.instructions);
    strings(task.expectedFiles);
    strings(task.expectedArtifacts);
    if (tasks.has(task.id) || !phases.has(String(task.phaseId)) || !Number.isSafeInteger(task.order)) {
      throw new Error('Duplicate task, invalid phase or order');
    }
    if (!['low', 'normal', 'high', 'critical'].includes(String(task.priority)) || !['simple', 'moderate', 'complex'].includes(String(task.complexity))) {
      throw new Error('Invalid task priority or complexity');
    }
    if (typeof task.requiresApproval !== 'boolean' || !Number.isSafeInteger(task.maxAttempts) || Number(task.maxAttempts) < 1 || Number(task.maxAttempts) > 10) {
      throw new Error('Invalid approval requirement or attempt limit');
    }
    if (task.modelAssignmentId !== undefined && !assignments.has(String(task.modelAssignmentId))) {
      throw new Error('Unknown model assignment');
    }
    if (task.assignedRole !== undefined) {
      text(task.assignedRole);
    }
    for (const path of task.expectedFiles) {
      validateRelativePath(path);
    }
    if (!Array.isArray(task.acceptanceCriteria) || !task.acceptanceCriteria.length || task.acceptanceCriteria.length > 100) {
      throw new Error('Every task needs acceptance criteria');
    }
    const criteria = new Set<string>();
    for (const criterion of task.acceptanceCriteria) {
      record(criterion);
      text(criterion.id);
      text(criterion.description);
      if (criteria.has(criterion.id) || !['manual', 'test', 'command', 'model_review'].includes(String(criterion.verification))) {
        throw new Error('Invalid acceptance criterion');
      }
      criteria.add(criterion.id);
      if (criterion.command !== undefined) {
        text(criterion.command);
      }
      if (criterion.verification === 'command') {
        text(criterion.command);
      }
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      throw new Error('Duplicate dependency');
    }
    tasks.set(task.id, task.dependencies);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error('Cyclic task dependencies');
    }
    if (visited.has(id)) {
      return;
    }
    const dependencies = tasks.get(id);
    if (!dependencies) {
      throw new Error(`Unknown task dependency: ${id}`);
    }
    visiting.add(id);
    for (const dependency of dependencies) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of tasks.keys()) {
    visit(id);
  }
}

export function initialDefinition(objective: string): PlanDefinition {
  return {
    objective, requirements: [], constraints: [], assumptions: [], outOfScope: [],
    phases: [{ id: 'implementation', title: 'Umsetzung', order: 0 }],
    tasks: [{
      id: 'task-1', phaseId: 'implementation', order: 0, title: objective, description: objective,
      dependencies: [], priority: 'normal', complexity: 'moderate', instructions: [],
      acceptanceCriteria: [{ id: 'acceptance-1', description: 'Ergebnis durch Nutzer geprüft', verification: 'manual' }],
      expectedFiles: [], expectedArtifacts: [], requiresApproval: true, maxAttempts: 1,
    }],
    modelAssignments: [],
  };
}
