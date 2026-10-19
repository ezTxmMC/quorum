// Use the selected chat provider for JSON plans, without granting project write access.
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId, ProviderOptions } from '../../shared/types';
import type { ChatMessage } from '../../shared/models';
import { cancelRun, runCli } from '../providers/runner';
import { dataDir } from '../store';

export type ChatEngine = { type: 'local'; modelId: string }
  | { type: 'cli'; provider: 'claude' | 'codex' | 'antigravity' | 'opencode' }
  | { type: 'provider'; provider: ProviderId; options: ProviderOptions };

export function chatFor(engine: ChatEngine, binaries: Partial<Record<ProviderId, string>>, signal?: AbortSignal): (messages: ChatMessage[]) => Promise<string> {
  return async (messages) => {
    if (signal?.aborted) throw new Error('Abgebrochen');
    const runId = randomUUID();
    const provider = engine.type === 'local' ? 'local' : engine.provider;
    const options: ProviderOptions = engine.type === 'local' ? { model: engine.modelId } : engine.type === 'provider' ? engine.options : {};
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const conversation = messages.filter((message) => message.role !== 'system');
    const cwd = join(dataDir(), 'scratch');
    await fsp.mkdir(cwd, { recursive: true });
    if (signal?.aborted) throw new Error('Abgebrochen');
    const abort = () => cancelRun(runId);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await runCli({
        runId, provider, cwd, prompt: conversation.at(-1)?.content ?? '',
        options: { ...options, chatMode: 'text', imageGen: undefined, systemPrompt: [options.systemPrompt, system].filter(Boolean).join('\n\n') },
        history: conversation.slice(0, -1).map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })),
      }, () => {}, binaries);
      if (signal?.aborted) throw new Error('Abgebrochen');
      if (!result.ok) throw new Error(`${provider}: Modellierungsplan fehlgeschlagen`);
      return result.text;
    } finally { signal?.removeEventListener('abort', abort); }
  };
}
