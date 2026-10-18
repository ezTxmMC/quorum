// Verbindung der Modellierungsschleife mit dem vorhandenen Agenten- und Provider-System:
// lokale Modelle laufen über den Scheduler, CLI-Anbieter über den bestehenden Runner (nur lesend, leerer Arbeitsordner).
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from '../../shared/types';
import type { ChatMessage } from '../../shared/models';
import { runLocalChat } from '../models/chat';
import { runCli } from '../providers/runner';
import { dataDir } from '../store';

export type ChatEngine = { type: 'local'; modelId: string } | { type: 'cli'; provider: 'claude' | 'codex' | 'antigravity' | 'opencode' };

/** Ein Chat-Aufruf für die Modellierungsschleife. Gibt den Antworttext zurück, wirft bei Fehlern. */
export function chatFor(engine: ChatEngine, binaries: Partial<Record<ProviderId, string>>): (messages: ChatMessage[]) => Promise<string> {
  return async (messages) => {
    if (engine.type === 'local') {
      const r = await runLocalChat({ runId: randomUUID(), modelId: engine.modelId, messages, priority: 1, onDelta: () => {} });
      if (!r.ok) throw new Error(r.error ?? 'Sprachmodell fehlgeschlagen');
      return r.text;
    }
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
    const cwd = join(dataDir(), 'scratch');
    mkdirSync(cwd, { recursive: true });
    const options = engine.provider === 'codex' ? { sandbox: 'read-only' } : { permission: 'plan' };
    const res = await runCli({ runId: randomUUID(), provider: engine.provider, cwd, prompt: system ? `${system}\n\n---\n\n${rest}` : rest, options }, () => {}, binaries);
    if (!res.ok) throw new Error(`${engine.provider} fehlgeschlagen`);
    return res.text;
  };
}
