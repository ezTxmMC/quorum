import type { HubEvent, RunRequest } from '../../shared/types';
import { splitArgs } from './args.ts';
import type { LineParser } from './runner';

const MAX_PROMPT_LENGTH = 110_000;

export function buildKimi(req: RunRequest): { args: string[] } {
  const options = req.options;
  const args = ['--print', '--output-format', 'stream-json'];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.effort === 'low') {
    args.push('--no-thinking');
  } else if (options.effort === 'high') {
    args.push('--thinking');
  }

  if (options.fullAccess || options.permission === 'auto') {
    args.push('--auto');
  } else if (options.permission === 'yolo') {
    args.push('--yolo');
  }

  if (req.resume?.sessionId) {
    args.push('--session', req.resume.sessionId);
  } else if (req.resume?.continueLast) {
    args.push('--continue');
  }

  args.push(...splitArgs(options.extraArgs));

  const images = (req.images ?? []).map((filePath) => `@${filePath}`).join(' ');
  const instructions = options.systemPrompt ? `${options.systemPrompt}\n\n---\n\n` : '';
  const body = (images ? `${images}\n\n` : '') + req.prompt;
  const room = Math.max(0, MAX_PROMPT_LENGTH - instructions.length);
  const prompt = `${instructions}${room ? body.slice(-room) : ''}`;
  args.push('-p', prompt);

  return { args };
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonObject;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class KimiParser implements LineParser {
  private sessionSent = false;
  private seenText = false;
  private seenJson = false;
  private tools = new Set<string>();

  push(line: string): HubEvent[] {
    if (!line.startsWith('{')) {
      if (this.seenJson) {
        return [];
      }
      if (/^(error|fatal|warning)/i.test(line)) {
        return [{ type: 'notice', level: /^warning/i.test(line) ? 'warn' : 'error', text: line }];
      }
      this.seenText = true;
      return [{ type: 'text', delta: `${line}\n` }];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }

    const record = asObject(parsed);
    if (!record) {
      return [];
    }

    this.seenJson = true;
    const events: HubEvent[] = [];
    this.collectSession(record, events);

    const role = asString(record.role);
    const type = asString(record.type) ?? asString(record.event);

    if (type === 'error' || record.error) {
      const errorObj = asObject(record.error);
      const message = asString(errorObj?.message) ?? asString(record.message) ?? asString(record.error) ?? 'Kimi Code Fehler';
      events.push({ type: 'notice', level: 'error', text: message });
      return events;
    }

    if (type === 'tool_use' || type === 'tool_call') {
      this.collectToolStart(record, events);
      return events;
    }

    if (type === 'tool_result' || role === 'tool') {
      this.collectToolEnd(record, events);
      return events;
    }

    if (type === 'thinking' || type === 'reasoning') {
      const delta = asString(record.delta) ?? asString(record.text) ?? asString(record.thinking);
      if (delta) {
        events.push({ type: 'thinking', delta });
      }
      return events;
    }

    if (type === 'text' || type === 'content_block_delta') {
      const deltaObj = asObject(record.delta);
      const thinking = asString(deltaObj?.thinking) ?? asString(record.reasoning_content);
      if (thinking) {
        events.push({ type: 'thinking', delta: thinking });
      }
      const text = asString(deltaObj?.text) ?? asString(record.delta) ?? asString(record.text);
      if (text) {
        this.seenText = true;
        events.push({ type: 'text', delta: text });
      }
      return events;
    }

    if (type === 'assistant' || role === 'assistant') {
      const message = asObject(record.message) ?? record;
      this.collectContent(message.content, events);
      const reasoning = asString(message.reasoning_content);
      if (reasoning) {
        events.push({ type: 'thinking', delta: reasoning });
      }
      this.collectUsage(record, events);
      return events;
    }

    if (type === 'result' || record.usage) {
      const resultText = asString(record.result) ?? asString(record.response);
      if (!this.seenText && resultText) {
        this.seenText = true;
        events.push({ type: 'text', delta: resultText });
      }
      this.collectUsage(record, events);
      return events;
    }

    return events;
  }

  end(): HubEvent[] {
    return [];
  }

  private collectSession(record: JsonObject, events: HubEvent[]): void {
    if (this.sessionSent) {
      return;
    }
    const sessionId = asString(record.session_id) ?? asString(record.sessionId) ?? asString(record.conversation_id);
    if (!sessionId) {
      return;
    }
    this.sessionSent = true;
    events.push({ type: 'session', sessionId });
  }

  private collectContent(content: unknown, events: HubEvent[]): void {
    const directText = asString(content);
    if (directText) {
      this.seenText = true;
      events.push({ type: 'text', delta: directText });
      return;
    }

    if (!Array.isArray(content)) {
      return;
    }

    for (const item of content) {
      const part = asObject(item);
      if (!part) {
        continue;
      }
      const partType = asString(part.type);
      if (partType === 'think' || partType === 'thinking' || partType === 'reasoning') {
        const thought = asString(part.think) ?? asString(part.thinking) ?? asString(part.text);
        if (thought) {
          events.push({ type: 'thinking', delta: thought });
        }
        continue;
      }
      if (partType === 'text') {
        const text = asString(part.text);
        if (text) {
          this.seenText = true;
          events.push({ type: 'text', delta: text });
        }
        continue;
      }
      if (partType === 'tool_use' || partType === 'tool_call') {
        this.collectToolStart(part, events);
      }
    }
  }

  private collectToolStart(record: JsonObject, events: HubEvent[]): void {
    const id = asString(record.id) ?? asString(record.tool_call_id) ?? `tool-${this.tools.size + 1}`;
    if (this.tools.has(id)) {
      return;
    }
    this.tools.add(id);
    const fn = asObject(record.function);
    const name = asString(record.name) ?? asString(fn?.name) ?? 'tool';
    const input = record.input ?? record.arguments ?? fn?.arguments;
    events.push({ type: 'tool_start', id, name, input });
  }

  private collectToolEnd(record: JsonObject, events: HubEvent[]): void {
    const id = asString(record.tool_use_id) ?? asString(record.tool_call_id) ?? asString(record.id);
    if (!id) {
      return;
    }
    const rawOutput = record.output ?? record.content ?? record.result ?? '';
    const output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
    const isError = Boolean(record.is_error ?? record.isError ?? record.error);
    events.push({ type: 'tool_end', id, output, isError });
  }

  private collectUsage(record: JsonObject, events: HubEvent[]): void {
    const usage = asObject(record.usage);
    if (!usage) {
      return;
    }
    const inputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens);
    const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens);
    const cachedTokens = asNumber(usage.cache_read_input_tokens) ?? asNumber(usage.cached_tokens);
    const costUsd = asNumber(record.total_cost_usd) ?? asNumber(record.cost_usd);
    const durationMs = asNumber(record.duration_ms);
    const turns = asNumber(record.num_turns);
    if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) {
      return;
    }
    events.push({ type: 'usage', inputTokens, outputTokens, cachedTokens, costUsd, durationMs, turns });
  }
}
