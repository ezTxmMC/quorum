import type { HubEvent, RunRequest } from '../../shared/types';
import type { LineParser } from './runner';
import { splitArgs } from './args.ts';

export function buildCodex(req: RunRequest): { args: string[]; stdin?: string } {
  const o = req.options;
  if (req.review) {
    const a = ['exec', 'review', '--json', '--skip-git-repo-check'];
    // Ziel-Flag und Prompt '-' schließen sich in codex aus (clap): mit Ziel kein stdin-Prompt.
    let targeted = true;
    if (req.review.target === 'uncommitted') a.push('--uncommitted');
    else if (req.review.target === 'base' && req.review.ref) a.push('--base', req.review.ref);
    else if (req.review.target === 'commit' && req.review.ref) a.push('--commit', req.review.ref);
    else targeted = false;
    if (o.systemPrompt) a.push('-c', `developer_instructions=${JSON.stringify(o.systemPrompt)}`);
    if (req.options.model) a.push('-m', req.options.model);
    if (req.options.fullAccess) a.push('--dangerously-bypass-approvals-and-sandbox');
    if (targeted) return { args: a, stdin: undefined };
    a.push('-');
    return { args: a, stdin: req.prompt };
  }
  const resuming = !!(req.resume?.sessionId || req.resume?.continueLast);
  // Eltern-Flags von `codex exec` müssen VOR `resume` stehen; `resume` akzeptiert sie nicht.
  const pre: string[] = [];
  const rest: string[] = [];
  pre.push('-C', req.cwd);
  if (!o.fullAccess && o.sandbox) pre.push('-s', o.sandbox);
  if (o.profile) pre.push('-p', o.profile);
  if (o.oss) { pre.push('--oss'); if (o.localProvider) pre.push('--local-provider', o.localProvider); }
  for (const d of o.addDirs ?? []) pre.push('--add-dir', d);
  if (o.chatMode === 'text') rest.push('-c', 'sandbox_mode="read-only"');
  if (o.systemPrompt) rest.push('-c', `developer_instructions=${JSON.stringify(o.systemPrompt)}`);
  if (o.model) rest.push('-m', o.model);
  if (o.effort) rest.push('-c', `model_reasoning_effort="${o.effort}"`);
  if (o.speed) rest.push('-c', `service_tier="${o.speed}"`);
  if (o.fullAccess) rest.push('--dangerously-bypass-approvals-and-sandbox');
  // 'untrusted' wird von neueren Codex-Versionen nicht mehr geladen
  if (!o.fullAccess && (o.approvalPolicy === 'on-request' || o.approvalPolicy === 'never')) rest.push('-c', `approval_policy="${o.approvalPolicy}"`);
  for (const c of o.configOverrides ?? []) rest.push('-c', c);
  if (o.ephemeral) rest.push('--ephemeral');
  if (o.worktree) rest.push('--worktree');
  if (o.jsonSchema) rest.push('--output-schema', o.jsonSchema);
  const args = ['exec', ...pre, ...(resuming ? ['resume'] : []), '--json', '--skip-git-repo-check', ...rest];
  for (const img of req.images ?? []) args.push('-i', img);
  args.push(...splitArgs(o.extraArgs));
  if (resuming) args.push(req.resume!.sessionId ?? '--last');
  args.push('-'); // Prompt von stdin
  return { args, stdin: req.prompt };
}

export class CodexParser implements LineParser {
  private startedItems = new Set<string>();
  private reasoningText = new Map<string, string>();

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
        out.push({ type: 'usage', inputTokens: u.input_tokens, outputTokens: u.output_tokens /* reasoning_output_tokens ist darin enthalten */, cachedTokens: u.cached_input_tokens });
        break;
      }
      case 'turn.failed':
        out.push({ type: 'notice', level: 'error', text: String(m.error?.message ?? 'Turn fehlgeschlagen') });
        break;
      case 'error':
        // Transiente Verbindungsversuche sind keine Fehler; echte Fehler meldet das Ende des Laufs.
        if (/^Reconnecting\.\.\./i.test(String(m.message ?? ''))) break;
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
      case 'reasoning': {
        const text = typeof it.text === 'string' ? it.text : (Array.isArray(it.summary) ? it.summary.map((part: { text?: string }) => part.text ?? '').join('\n') : '');
        const previous = this.reasoningText.get(id) ?? '';
        if (text && text !== previous) {
          out.push({ type: 'thinking', delta: text.startsWith(previous) ? text.slice(previous.length) : `\n\n${text}` });
          this.reasoningText.set(id, text);
        }
        break;
      }
      case 'command_execution':
        if (!this.startedItems.has(id)) {
          this.startedItems.add(id);
          out.push({ type: 'tool_start', id, name: 'Shell', input: { command: it.command } });
        }
        if (done) out.push({ type: 'tool_end', id, output: String(it.aggregated_output ?? ''), isError: it.exit_code !== 0 && it.exit_code != null });
        break;
      case 'file_change':
        this.startedItems.add(id);
        out.push({ type: 'tool_start', id, name: 'Dateiänderung', input: { changes: it.changes, path: it.changes?.[0]?.path } });
        if (done) out.push({ type: 'tool_end', id, output: ((it.changes ?? []) as { kind: string; path: string }[]).map((c) => `${c.kind} ${c.path}`).join('\n'), isError: it.status === 'failed' });
        break;
      case 'mcp_tool_call':
        if (!this.startedItems.has(id)) {
          this.startedItems.add(id);
          out.push({ type: 'tool_start', id, name: `${it.server ?? 'mcp'}:${it.tool ?? ''}`, input: it.arguments });
        }
        if (done) out.push({ type: 'tool_end', id, output: typeof it.result === 'string' ? it.result : JSON.stringify(it.result ?? it.error ?? ''), isError: it.status === 'failed' });
        break;
      case 'web_search':
        this.startedItems.add(id);
        out.push({ type: 'tool_start', id, name: 'Websuche', input: { query: it.query ?? it.action?.query ?? it.action?.url ?? it.action?.queries?.join(', ') } });
        if (done) out.push({ type: 'tool_end', id, output: '', isError: it.status === 'failed' });
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
