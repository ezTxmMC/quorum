import type { HubEvent, RunRequest } from '../../shared/types';
import type { LineParser } from './runner';
import { splitArgs } from './runner';

export function buildClaude(req: RunRequest): { args: string[]; stdin: string; live: boolean } {
  const o = req.options;
  // "live": Eingabe als stream-json über stdin – dadurch kann der Hub während des Laufs weitere Nachrichten zustellen (Steuern/Queue).
  const live = o.liveInput !== false && !!req.live;
  const args = ['-p', ...(live ? ['--input-format', 'stream-json'] : []), '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.fullAccess) args.push('--dangerously-skip-permissions');
  else if (o.permission) args.push('--permission-mode', o.permission);
  for (const d of o.addDirs ?? []) args.push('--add-dir', d);
  if (o.systemPrompt) args.push('--append-system-prompt', o.systemPrompt);
  if (o.allowedTools) args.push('--allowedTools', ...splitArgs(o.allowedTools.replace(/,/g, ' ')));
  if (o.disallowedTools) args.push('--disallowedTools', ...splitArgs(o.disallowedTools.replace(/,/g, ' ')));
  if (o.mcpConfig) args.push('--mcp-config', o.mcpConfig);
  if (o.agentsJson) args.push('--agents', o.agentsJson);
  if (o.maxBudgetUsd) args.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.worktree) args.push('--worktree');
  if (o.chrome === true) args.push('--chrome');
  if (o.chrome === false) args.push('--no-chrome');
  if (o.ephemeral) args.push('--no-session-persistence');
  if (o.jsonSchema) args.push('--json-schema', o.jsonSchema);
  if (req.resume?.sessionId) {
    args.push('--resume', req.resume.sessionId);
    if (req.resume.fork) args.push('--fork-session');
  } else if (req.resume?.continueLast) args.push('--continue');
  args.push(...splitArgs(o.extraArgs));
  // Bilder werden per @Pfad referenziert; Claude liest sie mit dem Read-Tool.
  const imgs = (req.images ?? []).map((p) => `@${p}`).join(' ');
  const prompt = o.ultracode ? `ultracode ${req.prompt}` : req.prompt;
  const text = imgs ? `${imgs}\n\n${prompt}` : prompt;
  // Live-Modus: Bilder aus dem Speicher als Base64-Blöcke direkt in die Nachricht (keine Datei nötig).
  const content = live && req.attachments?.length
    ? [...req.attachments.map((a) => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } })), { type: 'text', text }]
    : text;
  return { args, live, stdin: live ? JSON.stringify({ type: 'user', message: { role: 'user', content } }) : text };
}

interface ClaudeContent { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }

function stringify(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : JSON.stringify(x))).join('\n');
  return c === undefined ? '' : JSON.stringify(c);
}

export class ClaudeParser implements LineParser {
  private streamed = new Set<string>();
  private sessionSent = false;
  private finished = false;
  /** Anzahl abgeschlossener Turns (result-Events). */
  results = 0;

  push(line: string): HubEvent[] {
    let m: Record<string, any>;
    try { m = JSON.parse(line); } catch { return []; }
    const out: HubEvent[] = [];
    const parent = m.parent_tool_use_id as string | undefined;
    if (!this.sessionSent && typeof m.session_id === 'string') {
      this.sessionSent = true;
      out.push({ type: 'session', sessionId: m.session_id });
    }
    switch (m.type) {
      case 'stream_event': {
        const ev = m.event;
        if (ev?.type === 'message_start') this.streamed.add(ev.message?.id ?? '');
        if (ev?.type === 'content_block_delta' && !parent) {
          if (ev.delta?.type === 'text_delta') out.push({ type: 'text', delta: ev.delta.text });
          else if (ev.delta?.type === 'thinking_delta') out.push({ type: 'thinking', delta: ev.delta.thinking });
        }
        break;
      }
      case 'assistant': {
        const id: string = m.message?.id ?? '';
        const wasStreamed = this.streamed.has(id) && !parent;
        for (const b of (m.message?.content ?? []) as ClaudeContent[]) {
          if (b.type === 'tool_use') out.push({ type: 'tool_start', id: b.id!, name: b.name!, input: b.input, parentId: parent });
          else if (b.type === 'text' && !wasStreamed && b.text) out.push({ type: parent ? 'text_full' : 'text', ...(parent ? { text: b.text } : { delta: b.text }) } as HubEvent);
          else if (b.type === 'thinking' && !wasStreamed && b.thinking) out.push({ type: 'thinking', delta: b.thinking });
        }
        break;
      }
      case 'user': {
        const c = m.message?.content;
        if (Array.isArray(c)) {
          for (const b of c as ClaudeContent[]) {
            if (b.type === 'tool_result') out.push({ type: 'tool_end', id: b.tool_use_id!, output: stringify(b.content), isError: !!b.is_error });
          }
        }
        break;
      }
      case 'result': {
        this.finished = true;
        this.results++;
        const u = m.usage ?? {};
        out.push({
          type: 'usage',
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens,
          cachedTokens: u.cache_read_input_tokens,
          costUsd: m.total_cost_usd,
          durationMs: m.duration_ms,
          turns: m.num_turns,
        });
        if (m.is_error) out.push({ type: 'notice', level: 'error', text: String(m.result ?? m.subtype ?? 'Fehler') });
        break;
      }
      case 'system': {
        if (m.subtype === 'api_retry') out.push({ type: 'notice', level: 'warn', text: `API-Wiederholung (${m.attempt ?? '?'})` });
        break;
      }
    }
    return out;
  }

  end(): HubEvent[] { return []; }
  get isFinished() { return this.finished; }
}
