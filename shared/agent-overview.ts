import type { MultiRunRecord } from './types';

export function agentOverview(run: MultiRunRecord, agentId: string, now: number) {
  const turns = run.turns.filter((turn) => turn.agentId === agentId);
  const latest = turns.at(-1);
  const running = run.status === 'running' && turns.some((turn) => turn.running);
  const state: 'running' | 'waiting' | 'interrupted' | 'failed' | 'done' = running ? 'running' : !latest ? 'waiting' : latest.running ? 'interrupted' : latest.ok === false ? 'failed' : 'done';
  const tokens = turns.reduce((total, turn) => total + (turn.message.usage?.inputTokens ?? 0) + (turn.message.usage?.outputTokens ?? 0), 0);
  const hasTokens = turns.some((turn) => turn.message.usage?.inputTokens !== undefined || turn.message.usage?.outputTokens !== undefined);
  const durationMs = turns.reduce((total, turn) => total + (turn.running && run.status === 'running' ? Math.max(0, now - turn.message.createdAt) : turn.message.usage?.durationMs ?? 0), 0);
  return { turns, latest, state, tokens: hasTokens ? tokens : undefined, durationMs };
}
