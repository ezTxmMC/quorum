import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PlanService } from '../core/plan/service';
import type { ApprovalScope, PlanDefinition } from '../shared/plan/types';
import { dataDir } from '../electron/store';

export const PLAN_HELP = `Usage:
  quorum plan list [workspace]
  quorum plan show <plan-id>
  quorum plan create <workspace> <title> <definition.json>
  quorum plan revise <plan-id> <expected-revision-id> <definition.json>
  quorum plan approve <plan-id> <revision-id> <scope.json>
  quorum plan revoke <plan-id> <approval-id>
  quorum plan ask <plan-id> <revision-id> <question>
  quorum plan answer <plan-id> <question-id> <answer>
  quorum plan archive <plan-id>
  quorum plan export <plan-id>
  quorum plan import <workspace> <export.json>

Output is JSON. Definitions and approval scopes use the same schema as the desktop.
No agent is launched by these commands. Node >=24 with node:sqlite is required.
`;

export async function planCommand(args: string[]): Promise<number> {
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(PLAN_HELP);
    return 0;
  }
  const service = new PlanService(join(dataDir(), 'plans.sqlite'));
  try {
    const [command, ...values] = args;
    const counts: Record<string, number[]> = { list: [0, 1], show: [1], create: [3], revise: [3], approve: [3], revoke: [2], ask: [3], answer: [3], archive: [1], export: [1], import: [2] };
    if (!counts[command]?.includes(values.length)) {
      throw new Error(PLAN_HELP);
    }
    const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown;
    let result: unknown;
    switch (command) {
      case 'ask': result = service.ask(values[0], values[1], values[2]); break;
      case 'answer': result = service.answer(values[0], values[1], values[2]); break;
      case 'archive': result = service.archive(values[0]); break;
      case 'export': process.stdout.write(`${service.export(values[0])}\n`); return 0;
      case 'import': result = service.import(values[0], await json(values[1])); break;
      case 'list': result = service.list(values[0]); break;
      case 'show': result = service.get(values[0]); break;
      case 'create': result = service.save({ workspaceRoot: values[0], title: values[1], definition: await json(values[2]) as PlanDefinition }); break;
      case 'revise': {
        const snapshot = service.get(values[0]);
        result = service.save({ id: values[0], expectedRevisionId: values[1], workspaceRoot: snapshot.workspaceRoot, title: snapshot.plan.title, definition: await json(values[2]) as PlanDefinition });
        break;
      }
      case 'approve': result = service.approve(values[0], values[1], await json(values[2]) as ApprovalScope); break;
      case 'revoke': result = service.revoke(values[0], values[1]); break;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    service.close();
  }
}
