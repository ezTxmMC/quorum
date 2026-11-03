import type { ChatSession, ProviderId } from '../types.ts';
import type { ChatJob } from './types.ts';

export interface ChatRunRoute { sessionId: string; messageId: string; provider: ProviderId }

export function recoverChats(sessions: ChatSession[], currentRuns: Record<string, ChatRunRoute>, jobs: ChatJob[]): {
  sessions: ChatSession[]; runs: Record<string, ChatRunRoute>; cursors: Record<string, number>;
} {
  const recovered = [...sessions];
  const runs = { ...currentRuns };
  const cursors: Record<string, number> = {};
  for (const job of jobs) {
    if (job.forgotten) { delete runs[job.runId]; continue; }
    if ((job.acknowledged && !currentRuns[job.runId]) || !job.chatId || !job.messageId) { continue; }
    let index = recovered.findIndex((session) => session.id === job.chatId);
    if (index < 0 && job.snapshot) { recovered.push(job.snapshot); index = recovered.length - 1; }
    if (index < 0) { continue; }
    let session = recovered[index];
    if (!session.messages.some((item) => item.id === job.messageId) && job.snapshot) {
      const known = new Set(session.messages.map((item) => item.id));
      session = { ...session, messages: [...session.messages, ...job.snapshot.messages.filter((item) => !known.has(item.id))] };
      recovered[index] = session;
    }
    const message = session.messages.find((item) => item.id === job.messageId);
    if (!message) { continue; }
    const cursor = message.workerRunId === job.runId ? message.workerSequence ?? 0 : 0;
    if (['completed', 'failed', 'cancelled'].includes(job.state.status) && cursor >= job.state.sequence && cursor > 0) { delete runs[job.runId]; continue; }
    cursors[job.runId] = cursor;
    runs[job.runId] = { sessionId: job.chatId, messageId: job.messageId, provider: job.provider };
  }
  return { sessions: recovered, runs, cursors };
}
