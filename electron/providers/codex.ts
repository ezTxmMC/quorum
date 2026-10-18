import type { HubEvent, RunRequest } from '../../shared/types';
import type { LineParser } from './runner';
import { splitArgs } from './runner';

export function buildCodex(req: RunRequest): { args: string[]; stdin: string } {
  const o = req.options;
  if (req.review) {
    const a = ['exec', 'review', '--json', '--skip-git-repo-check'];
    if (req.review.target === 'uncommitted') a.push('--uncommitted');
    else if (req.review.target === 'base' && req.review.ref) a.push('--base', req.review.ref);
    else if (req.review.target === 'commit' && req.review.ref) a.push('--commit', req.review.ref);
    if (req.options.model) a.push('-m', req.options.model);
    if (req.options.fullAccess) a.push('--dangerously-bypass-approvals-and-sandbox');
    a.push('-');
    return { args: a, stdin: req.prompt };
  }
  const resuming = !!(req.resume?.sessionId || req.resume?.continueLast);
  const args = ['exec'];
  if (resuming) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (!resuming) args.push('-C', req.cwd);
  if (o.model) args.push('-m', o.model);
  if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
  if (o.speed) args.push('-c', `service_tier="${o.speed}"`);
  if (o.fullAccess) args.push('--dangerously-bypass-approvals-and-sandbox');
  else if (o.sandbox && !resuming) args.push('-s', o.sandbox);
  if (o.profile) args.push('-p', o.profile);
  for (const c of o.configOverrides ?? []) args.push('-c', c);
  if (o.oss) { args.push('--oss'); if (o.localProvider) args.push('--local-provider', o.localProvider); }
  if (o.ephemeral) args.push('--ephemeral');
  if (o.worktree) args.push('--worktree');
  if (o.jsonSchema && !resuming) args.push('--output-schema', o.jsonSchema);
  if (!resuming) for (const d of o.addDirs ?? []) args.push('--add-dir', d);
  for (const img of req.images ?? []) args.push('-i', img);
  args.push(...splitArgs(o.extraArgs));
  if (resuming) args.push(req.resume!.sessionId ?? '--last');
  args.push('-'); // Prompt von stdin
  return { args, stdin: req.prompt };
}

export class CodexParser implements LineParser {
  private startedItems = new Set<string>();

  push(line: string): HubEvent[] {
    if (!line.startsWith('{')) return [];
    let m: Record<string, any>;
    try { m = JSON.parse(line); } catch { return []; }
    const out: HubEvent[] = [];
    switch (m.type) {
      case 'thread.started':
        out.push({ type: 'session', sessionId: m.thread_id });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.item(m.type, m.item, out);
        break;
      case 'turn.completed': {
        const u = m.usage ?? {};
        out.push({ type: 'usage', inputTokens: u.input_tokens, outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cachedTokens: u.cached_input_tokens });
        break;
      }
      case 'turn.failed':
        out.push({ type: 'notice', level: 'error', text: String(m.error?.message ?? 'Turn fehlgeschlagen') });
        break;
      case 'error':
        out.push({ type: 'notice', level: 'error', text: String(m.message ?? 'Fehler') });
        break;
    }
    return out;
  }

  private item(kind: string, it: Record<string, any>, out: HubEvent[]) {
    if (!it) return;
    const id = String(it.id);
    const done = kind === 'item.completed';
    switch (it.type) {
      case 'agent_message':
        if (done) out.push({ type: 'text', delta: (it.text ?? '') + '\n\n' });
        break;
      case 'reasoning':
        if (done && it.text) out.push({ type: 'thinking', delta: it.text + '\n\n' });
        break;
      case 'command_execution':
        if (!this.startedItems.has(id)) {
          this.startedItems.add(id);
          out.push({ type: 'tool_start', id, name: 'Shell', input: { command: it.command } });
        }
        if (done) out.push({ type: 'tool_end', id, output: String(it.aggregated_output ?? ''), isError: it.exit_code !== 0 && it.exit_code != null });
        break;
      case 'file_change':
        if (done) {
          out.push({ type: 'tool_start', id, name: 'Dateiänderung', input: { changes: it.changes } });
          out.push({ type: 'tool_end', id, output: ((it.changes ?? []) as { kind: string; path: string }[]).map((c) => `${c.kind} ${c.path}`).join('\n'), isError: it.status === 'failed' });
        }
        break;
      case 'mcp_tool_call':
        if (!this.startedItems.has(id)) {
          this.startedItems.add(id);
          out.push({ type: 'tool_start', id, name: `${it.server ?? 'mcp'}:${it.tool ?? ''}`, input: it.arguments });
        }
        if (done) out.push({ type: 'tool_end', id, output: typeof it.result === 'string' ? it.result : JSON.stringify(it.result ?? it.error ?? ''), isError: it.status === 'failed' });
        break;
      case 'web_search':
        if (done) {
          out.push({ type: 'tool_start', id, name: 'Websuche', input: { query: it.query } });
          out.push({ type: 'tool_end', id, output: '', isError: false });
        }
        break;
      case 'todo_list':
        if (done) {
          out.push({ type: 'tool_start', id, name: 'Aufgabenliste', input: it.items });
          out.push({ type: 'tool_end', id, output: ((it.items ?? []) as { text: string; completed: boolean }[]).map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'), isError: false });
        }
        break;
      case 'error':
        out.push({ type: 'notice', level: 'warn', text: String(it.message ?? 'Fehler') });
        break;
    }
  }

  end(): HubEvent[] { return []; }
}
