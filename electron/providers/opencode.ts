import type { HubEvent, RunRequest } from '../../shared/types';
import type { LineParser } from './runner';
import { splitArgs } from './runner';

// OpenCode (sst/opencode): `opencode run --format json` gibt je Schritt einen JSON-Event pro Zeile aus.
export function buildOpenCode(req: RunRequest): { args: string[] } {
  const o = req.options;
  const args = ['run', '--format', 'json'];
  if (o.model) args.push('--model', o.model);       // Format: anbieter/modell
  if (o.agent) args.push('--agent', o.agent);
  if (req.resume?.sessionId) args.push('--session', req.resume.sessionId);
  else if (req.resume?.continueLast) args.push('--continue');
  for (const img of req.images ?? []) args.push('--file', img);
  args.push(...splitArgs(o.extraArgs));
  const prompt = o.systemPrompt ? `${o.systemPrompt}\n\n${req.prompt}` : req.prompt;
  args.push('--', prompt.length > 110000 ? prompt.slice(-110000) : prompt);
  return { args };
}

export class OpenCodeParser implements LineParser {
  private sessionSent = false;
  private tokens = { input: 0, output: 0, cached: 0, cost: 0 };

  push(line: string): HubEvent[] {
    if (!line.startsWith('{')) return [];
    let m: Record<string, any>;
    try { m = JSON.parse(line); } catch { return []; }
    const out: HubEvent[] = [];
    const sid = m.sessionID ?? m.part?.sessionID;
    if (!this.sessionSent && typeof sid === 'string') { this.sessionSent = true; out.push({ type: 'session', sessionId: sid }); }
    const p = m.part ?? {};
    switch (m.type) {
      case 'text':
        if (p.text) out.push({ type: 'text', delta: String(p.text) + '\n\n' });
        break;
      case 'reasoning':
        if (p.text) out.push({ type: 'thinking', delta: String(p.text) + '\n\n' });
        break;
      case 'tool_use': {
        const st = p.state ?? {};
        const id = String(p.callID ?? p.id ?? `${Date.now()}`);
        out.push({ type: 'tool_start', id, name: String(p.tool ?? 'tool'), input: st.input });
        if (st.status === 'completed' || st.status === 'error') {
          out.push({ type: 'tool_end', id, output: typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? st.error ?? ''), isError: st.status === 'error' });
        }
        break;
      }
      case 'step_finish': {
        const t = p.tokens ?? {};
        this.tokens.input += t.input ?? 0;
        this.tokens.output += (t.output ?? 0) + (t.reasoning ?? 0);
        this.tokens.cached += t.cache?.read ?? 0;
        this.tokens.cost += p.cost ?? 0;
        break;
      }
      case 'error':
        out.push({ type: 'notice', level: 'error', text: String(m.error?.data?.message ?? m.error?.message ?? m.error?.name ?? 'Fehler') });
        break;
    }
    return out;
  }

  end(): HubEvent[] {
    const t = this.tokens;
    return t.input || t.output ? [{ type: 'usage', inputTokens: t.input, outputTokens: t.output, cachedTokens: t.cached, costUsd: t.cost || undefined }] : [];
  }
}
