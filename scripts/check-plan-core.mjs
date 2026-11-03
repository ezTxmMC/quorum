import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PlanService, definitionHash } from '../core/plan/service.ts';
import { initialDefinition, validateDefinition } from '../shared/plan/validation.ts';
import { DocumentService } from '../core/ide/documents.ts';

const temporary = mkdtempSync(join(tmpdir(), 'quorum-plan-'));
const root = join(temporary, 'workspace');
mkdirSync(root);
const path = join(temporary, 'plans.sqlite');
let service = new PlanService(path);
try {
  const definition = initialDefinition('Implement feature');
  const original = structuredClone(definition);
  const first = service.save({ workspaceRoot: root, title: 'Feature', definition });
  assert.notEqual(first.plan.workspaceId, root, 'workspace identity is an independent UUID');
  assert.equal(first.workspaceRoot, root);
  const firstRevision = first.plan.currentRevisionId;
  definition.tasks[0].title = 'mutated by caller';
  assert.equal(service.get(first.plan.id).revisions[0].tasks[0].title, original.tasks[0].title);
  assert.equal(definitionHash(original), definitionHash(Object.fromEntries(Object.entries(original).reverse())));
  const scope = { workspaceRoot: root, allowedPaths: ['.'], allowedTools: ['read'], allowShell: false, allowNetwork: false };
  const approved = service.approve(first.plan.id, firstRevision, scope);
  assert.equal(approved.approvals[0].contentHash, first.revisions[0].contentHash);
  assert.equal(approved.plan.status, 'approved');
  assert.throws(() => service.approve(first.plan.id, firstRevision, { ...scope, allowedPaths: ['../'] }), /inside/);
  assert.throws(() => service.approve(first.plan.id, firstRevision, { ...scope, allowShell: true }), /scope/);
  assert.throws(() => service.approve(first.plan.id, firstRevision, { ...scope, expiresAt: '2000-01-01' }), /expiry/);
  assert.throws(() => service.save({ id: first.plan.id, workspaceRoot: root, title: 'Stale', definition: original }), /reload/);
  const second = service.save({ id: first.plan.id, workspaceRoot: root, expectedRevisionId: firstRevision, title: 'Feature v2', definition: original });
  assert.equal(second.plan.status, 'draft');
  assert.equal(second.revisions.length, 2);
  assert.equal(second.approvals[0].revisionId, firstRevision);
  assert.throws(() => service.approve(first.plan.id, firstRevision, scope), /current/);
  const secondApproval = service.approve(first.plan.id, second.plan.currentRevisionId, scope);
  const revoked = service.revoke(first.plan.id, secondApproval.approvals[1].id);
  assert.equal(revoked.plan.status, 'draft');
  assert.ok(revoked.approvals[1].revokedAt);
  assert.deepEqual(revoked.events.map((event) => event.sequence), [1, 2, 3, 4, 5]);

  for (const mutate of [
    (value) => { value.tasks[0].dependencies = ['task-1']; },
    (value) => { value.tasks[0].dependencies = ['missing']; },
    (value) => { value.tasks[0].expectedFiles = ['../../secret']; },
    (value) => { value.tasks[0].acceptanceCriteria = []; },
    (value) => { value.tasks[0].phaseId = 'missing'; },
    (value) => { value.tasks.push(structuredClone(value.tasks[0])); },
    (value) => { value.tasks[0].maxAttempts = 0; },
  ]) {
    const invalid = structuredClone(original);
    mutate(invalid);
    assert.throws(() => validateDefinition(invalid));
    assert.throws(() => service.save({ workspaceRoot: root, title: 'Invalid', definition: invalid }));
  }
  assert.equal(service.list().length, 1, 'invalid writes are atomic');
  service.close();
  service = new PlanService(path);
  assert.equal(service.get(first.plan.id).revisions.length, 2, 'revisions survive restart');
  assert.equal(service.get(first.plan.id).events.length, 5);
  const concurrent = new PlanService(path);
  try {
    const before = concurrent.get(first.plan.id);
    service.save({ id: first.plan.id, workspaceRoot: root, expectedRevisionId: before.plan.currentRevisionId, title: 'Update', definition: original });
    assert.throws(() => concurrent.save({ id: first.plan.id, workspaceRoot: root, expectedRevisionId: before.plan.currentRevisionId, title: 'Race', definition: original }), /reload/);
  } finally { concurrent.close(); }

  const documents = new DocumentService();
  const file = join(root, 'test.ts');
  writeFileSync(file, 'const value = 1;\r\n');
  const document = await documents.read(root, file);
  assert.equal(document.lineEnding, 'CRLF');
  assert.equal(document.languageId, 'typescript');
  writeFileSync(file, 'external change');
  await assert.rejects(documents.save(root, file, 'overwrite', document.diskHash), /geändert/);
  assert.equal(readFileSync(file, 'utf8'), 'external change');
  const fresh = await documents.read(root, file);
  const writes = await Promise.allSettled([
    documents.save(root, file, 'first save', fresh.diskHash),
    documents.save(root, file, 'second save', fresh.diskHash),
  ]);
  assert.equal(writes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(readFileSync(file, 'utf8'), 'first save');
  const outside = join(temporary, 'secret');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(root, 'escape'));
  await assert.rejects(documents.read(root, '../secret'), /outside/);
  await assert.rejects(documents.read(root, 'escape'), /outside/);
  await assert.rejects(documents.save(root, 'escape', 'bad', ''), /outside/);
  assert.throws(() => service.approve(first.plan.id, service.get(first.plan.id).plan.currentRevisionId, { ...scope, allowedPaths: ['escape'] }), /outside/);
  assert.equal((await documents.list(root)).some((entry) => entry.name === 'escape'), false);
  writeFileSync(join(root, 'binary'), Buffer.from([0, 255]));
  await assert.rejects(documents.read(root, 'binary'), /Binary/);
  writeFileSync(join(root, 'invalid-utf8'), Buffer.from([255]));
  await assert.rejects(documents.read(root, 'invalid-utf8'));
  writeFileSync(join(root, 'bom'), Buffer.from([239, 187, 191, 65]));
  const bom = await documents.read(root, 'bom');
  assert.equal(bom.text.charCodeAt(0), 0xfeff, 'BOM is preserved');
  await documents.save(root, 'bom', bom.text, bom.diskHash);
  assert.deepEqual(readFileSync(join(root, 'bom')), Buffer.from([239, 187, 191, 65]));

  const questionPlan = service.save({ workspaceRoot: root, title: 'Questions', definition: original });
  const asked = service.ask(questionPlan.plan.id, questionPlan.plan.currentRevisionId, 'Which test suite?', ['unit', 'integration']);
  assert.throws(() => service.approve(asked.plan.id, asked.plan.currentRevisionId, scope), /open questions/);
  const answered = service.answer(asked.plan.id, asked.questions[0].id, 'integration');
  assert.equal(answered.questions[0].answer, 'integration');
  assert.throws(() => service.answer(asked.plan.id, asked.questions[0].id, 'unit'), /Unanswered/);
  const questionApproved = service.approve(asked.plan.id, asked.plan.currentRevisionId, scope);
  const newQuestion = service.ask(asked.plan.id, asked.plan.currentRevisionId, 'Another question?');
  assert.ok(newQuestion.approvals[0].revokedAt, 'new questions invalidate existing approvals');
  assert.equal(newQuestion.plan.status, 'draft');
  assert.equal(questionApproved.plan.status, 'approved');
  const exported = service.export(asked.plan.id);
  const imported = service.import(root, JSON.parse(exported));
  assert.notEqual(imported.plan.id, asked.plan.id);
  assert.equal(imported.approvals.length, 0, 'imports never inherit execution permissions');
  assert.equal(imported.questions.length, 0);
  const archived = service.archive(imported.plan.id);
  assert.equal(archived.plan.status, 'archived');
  assert.throws(() => service.approve(archived.plan.id, archived.plan.currentRevisionId, scope), /Archived/);

  const inspector = new DatabaseSync(path);
  inspector.exec("CREATE TRIGGER fail_event BEFORE INSERT ON plan_events BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END");
  const count = service.list().length;
  assert.throws(() => service.save({ workspaceRoot: root, title: 'Rollback', definition: original }), /simulated/);
  assert.equal(service.list().length, count, 'failed audit write rolls back the entire revision transaction');
  inspector.exec('DROP TRIGGER fail_event');
  inspector.close();

  const futurePath = join(temporary, 'future.sqlite');
  const future = new DatabaseSync(futurePath);
  future.exec('PRAGMA user_version = 99');
  future.close();
  assert.throws(() => new PlanService(futurePath), /newer/);
  const legacyPath = join(temporary, 'legacy.sqlite');
  const legacy = new DatabaseSync(legacyPath);
  legacy.close();
  const migrated = new PlanService(legacyPath);
  migrated.close();
  const backup = new DatabaseSync(`${legacyPath}.v0.backup`);
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 0, 'pre-migration backup');
  backup.close();
  console.log('Plan core and editor: persistence, revisions, scopes, DAG, concurrency, migration and workspace boundaries passed.');
} finally {
  service.close();
  rmSync(temporary, { recursive: true, force: true });
}
