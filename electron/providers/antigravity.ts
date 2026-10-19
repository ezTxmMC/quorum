import type { HubEvent, RunRequest } from '../../shared/types';
import type { LineParser } from './runner';
import { splitArgs } from './args.ts';

export function buildAntigravity(req: RunRequest): { args: string[] } {
  const o = req.options;
  const args = ['--output-format', 'stream-json'];
  // Pass effort separately: not every model exposes suffixed variants.
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  // Headless kann agy nicht nachfragen: Shell-Befehle gehen nur mit Auto-Genehmigung (optional zusätzlich Terminal-Sandbox).
  const allowCommands = o.permission === 'allow-commands';
  if (o.fullAccess || allowCommands) args.push('--dangerously-skip-permissions');
  else if (o.permission && o.permission !== 'default') args.push('--mode', o.permission);
  if (o.sandboxTerminal) args.push('--sandbox');
  for (const d of o.addDirs ?? []) args.push('--add-dir', d);
  if (o.project) args.push('--project', o.project);
  if (o.agent) args.push('--agent', o.agent);
  if (o.jsonSchema) args.push('--json-schema', o.jsonSchema);
  if (req.resume?.sessionId) args.push('--conversation', req.resume.sessionId);
  else if (req.resume?.continueLast) args.push('--continue');
  args.push(...splitArgs(o.extraArgs));
  const imgs = (req.images ?? []).map((p) => `@${p}`).join(' ');
  // agy erwartet den Prompt als `-p=<text>` (Flag und Wert müssen zusammenhängen).
  const instructions = o.systemPrompt ? `${o.systemPrompt}\n\n---\n\n` : '';
  const body = (imgs ? `${imgs}\n\n` : '') + req.prompt;
  // Keep instructions intact when the message must be clipped to the CLI argument limit.
  const room = Math.max(0, 110000 - instructions.length);
  args.push(`-p=${instructions}${room ? body.slice(-room) : ''}`);
  return { args };
}

export class AntigravityParser implements LineParser {
  private seenText = false;
  private tools = new Set<string>();

  push(line: string): HubEvent[] {
    if (!line.startsWith('{')) {
      return /^(warning|error|jetski)/i.test(line) ? [{ type: 'notice', level: /^error/i.test(line) ? 'error' : 'warn', text: line }] : [];
    }
    let m: Record<string, any>;
    try { m = JSON.parse(line); } catch { return []; }
    const out: HubEvent[] = [];
    switch (m.event) {
      case 'init':
        out.push({ type: 'session', sessionId: m.conversation_id });
        break;
      case 'step_update': {
        const s = m.step_update;
        if (s.step_type === 'agent_response' && s.text_delta) {
          this.seenText = true;
          out.push({ type: 'text', delta: s.text_delta });
        } else if (s.step_type === 'tool') {
          const id = `${s.conversation_id}:${s.step_index}`;
          const params = s.tool_info?.parameters;
          if (!this.tools.has(id)) {
            this.tools.add(id);
            out.push({ type: 'tool_start', id, name: s.tool_name ?? 'tool', input: params });
          }
          if (s.state === 'DONE' || s.state === 'ERROR' || s.state === 'FAILED') {
            out.push({ type: 'tool_end', id, output: s.tool_info?.output ?? s.output ?? s.error ?? '', isError: s.state !== 'DONE' });
          }
        } else if (s.step_type === 'thinking' && s.text_delta) {
          out.push({ type: 'thinking', delta: s.text_delta });
        }
        break;
      }
      case 'result': {
        const r = m.result ?? {};
        if (!this.seenText && r.response) out.push({ type: 'text', delta: String(r.response) });
        const u = r.usage ?? {};
        out.push({ type: 'usage', inputTokens: u.input_tokens, outputTokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0), cachedTokens: u.cache_read_tokens, durationMs: r.duration_seconds ? Math.round(r.duration_seconds * 1000) : undefined, turns: r.num_turns });
        for (const d of (r.denied_actions ?? []) as { display_name?: string; action?: string }[]) {
          out.push({ type: 'notice', level: 'warn', text: `Aktion „${d.display_name ?? d.action}“ wurde abgelehnt (Headless). Wähle „Befehle & Edits erlauben“ oder Vollzugriff.` });
        }
        if (r.status && r.status !== 'SUCCESS') out.push({ type: 'notice', level: 'error', text: `Status: ${r.status}` });
        break;
      }
    }
    return out;
  }

  end(): HubEvent[] { return []; }
}
