import { PROVIDER_ORDER } from './catalog.ts';
import { apiCost } from './pricing.ts';
import type { Message, Persisted, ProviderId, UsageReport } from './types';

export interface UsageEntry {
  provider: ProviderId;
  timestamp: number;
  freshInput: number;
  cachedInput: number;
  output: number;
  cost: number;
}

export interface ProviderUsageSummary {
  msgs: number;
  freshInput: number;
  cachedInput: number;
  output: number;
  cost: number;
}

export type UsageStatsMap = Record<ProviderId, ProviderUsageSummary>;

export interface DailyProviderUsage {
  date: string;
  byProvider: Record<ProviderId, number>;
  total: number;
}

interface PreviousSnapshot {
  input: number;
  output: number;
  cached: number;
  cost: number;
}

const CUMULATIVE_TOKEN_PROVIDERS = new Set<ProviderId>(['codex', 'antigravity']);
const CUMULATIVE_COST_PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'antigravity']);

function positiveDelta(current: number, previous: number | undefined): number {
  if (previous === undefined || current < previous) {
    return current;
  }
  return current - previous;
}

function emptySummary(): ProviderUsageSummary {
  return { msgs: 0, freshInput: 0, cachedInput: 0, output: 0, cost: 0 };
}

export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localMonthKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function buildEntry(
  provider: ProviderId,
  usage: NonNullable<Message['usage']>,
  model: string | undefined,
  timestamp: number,
  previous?: PreviousSnapshot,
): { entry: UsageEntry; snapshot: PreviousSnapshot } {
  const rawInput = usage.inputTokens ?? 0;
  const rawOutput = usage.outputTokens ?? 0;
  const rawCached = usage.cachedTokens ?? 0;
  const rawCost = usage.costUsd ?? 0;

  const isCumulativeTokens = CUMULATIVE_TOKEN_PROVIDERS.has(provider);
  const isCumulativeCost = CUMULATIVE_COST_PROVIDERS.has(provider);

  const deltaInput = isCumulativeTokens ? positiveDelta(rawInput, previous?.input) : rawInput;
  const deltaOutput = isCumulativeTokens ? positiveDelta(rawOutput, previous?.output) : rawOutput;
  const deltaCached = isCumulativeTokens ? positiveDelta(rawCached, previous?.cached) : rawCached;
  const deltaCostUsd = rawCost > 0
    ? (isCumulativeCost ? positiveDelta(rawCost, previous?.cost) : rawCost)
    : undefined;

  const separateCache = provider === 'antigravity' || deltaCached > deltaInput;
  const cachedInput = separateCache ? deltaCached : Math.min(deltaCached, deltaInput);
  const freshInput = separateCache ? deltaInput : deltaInput - cachedInput;

  const cost = apiCost(
    {
      inputTokens: separateCache ? freshInput : freshInput + cachedInput,
      outputTokens: deltaOutput,
      cachedTokens: cachedInput,
      costUsd: deltaCostUsd,
    },
    model,
    provider,
  )?.usd ?? 0;

  return {
    entry: {
      provider,
      timestamp,
      freshInput,
      cachedInput,
      output: deltaOutput,
      cost,
    },
    snapshot: {
      input: rawInput,
      output: rawOutput,
      cached: rawCached,
      cost: rawCost,
    },
  };
}

/**
 * Normalizes all assistant usage records from Hub sessions and multi-runs into per-turn deltas.
 * Deduplicates cumulative session counters (Claude `total_cost_usd`, Codex & Antigravity session totals).
 */
export function extractUsageEntries(data: Persisted): UsageEntry[] {
  const entries: UsageEntry[] = [];

  for (const session of data.sessions) {
    const previousByProvider = new Map<ProviderId, PreviousSnapshot>();
    for (const message of session.messages) {
      if (message.role !== 'assistant' || !message.provider || !message.usage) {
        continue;
      }
      const { entry, snapshot } = buildEntry(
        message.provider,
        message.usage,
        message.model ?? session.options.model,
        message.createdAt || session.updatedAt || session.createdAt,
        previousByProvider.get(message.provider),
      );
      previousByProvider.set(message.provider, snapshot);
      entries.push(entry);
    }
  }

  for (const run of data.multiRuns) {
    const previousByAgent = new Map<string, PreviousSnapshot>();
    for (const turn of run.turns) {
      const { message } = turn;
      if (!message.provider || !message.usage) {
        continue;
      }
      const agentKey = `${turn.agentId}:${message.provider}`;
      const model = message.model ?? run.config.agents.find((agent) => agent.id === turn.agentId)?.options.model;
      const { entry, snapshot } = buildEntry(
        message.provider,
        message.usage,
        model,
        message.createdAt || run.createdAt,
        previousByAgent.get(agentKey),
      );
      previousByAgent.set(agentKey, snapshot);
      entries.push(entry);
    }
  }

  return entries;
}

export function aggregateByProvider(
  entries: UsageEntry[],
  filter?: { month?: string; sinceMs?: number },
): UsageStatsMap {
  const acc = Object.fromEntries(PROVIDER_ORDER.map((provider) => [provider, emptySummary()])) as UsageStatsMap;

  for (const entry of entries) {
    if (filter?.sinceMs !== undefined && entry.timestamp < filter.sinceMs) {
      continue;
    }
    if (filter?.month && localMonthKey(entry.timestamp) !== filter.month) {
      continue;
    }
    const bucket = acc[entry.provider];
    if (!bucket) {
      continue;
    }
    bucket.msgs += 1;
    bucket.freshInput += entry.freshInput;
    bucket.cachedInput += entry.cachedInput;
    bucket.output += entry.output;
    bucket.cost += entry.cost;
  }

  return acc;
}

export function availableMonths(entries: UsageEntry[], now = Date.now()): string[] {
  const months = new Set<string>([localMonthKey(now)]);
  for (const entry of entries) {
    if (entry.timestamp > 0) {
      months.add(localMonthKey(entry.timestamp));
    }
  }
  return [...months].sort((a, b) => b.localeCompare(a));
}

export function buildDailySeries(
  entries: UsageEntry[],
  report: UsageReport | null,
  daysCount = 14,
  now = Date.now(),
): DailyProviderUsage[] {
  const dayMap = new Map<string, Record<ProviderId, number>>();
  for (let offset = daysCount - 1; offset >= 0; offset -= 1) {
    const key = localDayKey(now - offset * 86_400_000);
    const zeroRow = Object.fromEntries(PROVIDER_ORDER.map((provider) => [provider, 0])) as Record<ProviderId, number>;
    dayMap.set(key, zeroRow);
  }

  for (const entry of entries) {
    const row = dayMap.get(localDayKey(entry.timestamp));
    if (!row) {
      continue;
    }
    row[entry.provider] += entry.freshInput + entry.output;
  }

  if (report) {
    for (const day of report.days) {
      const row = dayMap.get(day.date);
      if (!row) {
        continue;
      }
      const cliClaude = day.claude.input + day.claude.output;
      const cliCodex = Math.max(0, day.codex.input - day.codex.cached) + day.codex.output;
      row.claude = Math.max(row.claude, cliClaude);
      row.codex = Math.max(row.codex, cliCodex);
    }
  }

  return [...dayMap.entries()].map(([date, byProvider]) => {
    const total = PROVIDER_ORDER.reduce((sum, provider) => sum + byProvider[provider], 0);
    return { date, byProvider, total };
  });
}
