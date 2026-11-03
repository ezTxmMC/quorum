import { workspaceRoot } from '../../core/ide/paths';
import { WorkspaceSearch } from '../../core/ide/search';
import { registerLspIpc } from './lsp-ipc';
import { ipcMain } from 'electron';
import { join } from 'node:path';
import { PlanService } from '../../core/plan/service';
import { DocumentService } from '../../core/ide/documents';
import type { ApprovalScope, PlanSaveInput } from '../../shared/plan/types';
import { dataDir } from '../store';

export function registerWorkspaceIpc(): { shutdown: () => Promise<void>; close: () => void } {
  const plans = new PlanService(join(dataDir(), 'plans.sqlite'));
  const documents = new DocumentService();
  const closeLsp = registerLspIpc();
  const search = new WorkspaceSearch();
  const searches = new Map<number, AbortController>();
  ipcMain.handle('ide:find', async ({ sender }, root: string, query: string, content: boolean) => {
    searches.get(sender.id)?.abort();
    const controller = new AbortController();
    searches.set(sender.id, controller);
    const abort = () => controller.abort();
    sender.once('destroyed', abort);
    try { return content ? await search.search(root, query, controller.signal) : await search.files(root, query, controller.signal); }
    finally {
      sender.removeListener('destroyed', abort);
      if (searches.get(sender.id) === controller) { searches.delete(sender.id); }
    }
  });
  ipcMain.handle('plan:ask', (_event, id: string, revisionId: string, question: string, options: string[]) => plans.ask(id, revisionId, question, options));
  ipcMain.handle('plan:answer', (_event, id: string, questionId: string, answer: string) => plans.answer(id, questionId, answer));
  ipcMain.handle('plan:archive', (_event, id: string) => plans.archive(id));
  ipcMain.handle('plan:export', (_event, id: string) => plans.export(id));
  ipcMain.handle('plan:import', (_event, root: string, value: unknown) => plans.import(root, value));
  ipcMain.handle('plan:list', (_event, root?: string) => plans.list(root));
  ipcMain.handle('plan:get', (_event, id: string) => plans.get(id));
  ipcMain.handle('plan:save', (_event, input: PlanSaveInput) => plans.save(input));
  ipcMain.handle('plan:approve', (_event, id: string, revisionId: string, scope: ApprovalScope) => plans.approve(id, revisionId, scope));
  ipcMain.handle('plan:revoke', (_event, id: string, approvalId: string) => plans.revoke(id, approvalId));
  ipcMain.handle('ide:root', (_event, root: string) => workspaceRoot(root));
  ipcMain.handle('ide:list', (_event, root: string, path?: string) => documents.list(root, path));
  ipcMain.handle('ide:read', (_event, root: string, path: string) => documents.read(root, path));
  ipcMain.handle('ide:save', (_event, root: string, path: string, text: string, expectedHash: string) => documents.save(root, path, text, expectedHash));
  return {
    shutdown: async () => {
      for (const controller of searches.values()) { controller.abort(); }
      await closeLsp();
    },
    close: () => plans.close(),
  };
}
