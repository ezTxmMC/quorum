import type { ChatLimit, CliUsage, ProviderId, UsageMeter, UsageReport } from '@shared/types';

/** Claude's daily statistics are not quota windows and must not drive the quota indicator. */
export function quotaMeters(provider: ProviderId, meters: UsageMeter[]): UsageMeter[] {
  if (provider !== 'claude') return meters;
  return meters.filter((meter) => {
    const label = [meter.group, meter.label].filter(Boolean).join(' ');
    if (/\b24\s*(?:h(?:ours?)?|stunden?)\b|\bdaily\b|\btäglich\b/i.test(label)) return false;
    if (/\b(?:session|sitzung)\b/i.test(label)) return true;
    if (!/\bweek(?:ly)?\b|\bwoche(?:nlimit)?\b/i.test(label)) return false;
    return /\bfable\b/i.test(label) || !/\b(?:sonnet|opus|haiku)\b/i.test(label);
  });
}

export interface Meter { label: string; used: number; reset?: string; expired: boolean; weekly: boolean }

const WEEKLY = /\bweek(?:ly)?\b|\bwoche(?:nlimit)?\b/i;

/** Aktuelle Limit-Balken eines Anbieters als „verbraucht in %“ – Claude/Antigravity aus /usage, Codex aus den Rate-Limits. */
export function currentMeters(provider: ProviderId, cli: CliUsage | undefined, codex: UsageReport['codexLimits'] | undefined): Meter[] {
  if (provider === 'codex') {
    return [codex?.primary, codex?.secondary].filter((w): w is NonNullable<typeof w> => !!w).map((w) => ({
      label: w.window_minutes >= 1440 ? 'weekly' : `${Math.round(w.window_minutes / 60)} h`,
      used: w.used_percent, reset: new Date(w.resets_at * 1000).toLocaleString(), expired: w.resets_at * 1000 <= Date.now(), weekly: w.window_minutes >= 1440,
    }));
  }
  if (provider !== 'claude' && provider !== 'antigravity') return [];
  return quotaMeters(provider, cli?.ok ? cli.meters : []).map((m) => {
    const label = [m.group, m.label].filter(Boolean).join(' · ');
    return { label, used: provider === 'antigravity' || m.kind === 'remaining' ? 100 - m.percent : m.percent, reset: m.reset, expired: false, weekly: WEEKLY.test(label) };
  });
}

/** Höchster Verbrauch der Fenster, die das Limit betrifft (abgelaufene Fenster zählen nicht). undefined = keine Daten. */
export function limitUsage(limit: ChatLimit, meters: Meter[]): number | undefined {
  const pool = meters.filter((m) => !m.expired && Number.isFinite(m.used) && (limit.window === 'any' || (limit.window === 'weekly') === m.weekly));
  return pool.length ? Math.max(...pool.map((m) => m.used)) : undefined;
}
