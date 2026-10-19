import type { ProviderId, UsageMeter } from '@shared/types';

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
