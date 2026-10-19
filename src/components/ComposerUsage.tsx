import { useEffect, useState } from 'react';
import type { ChatSession, UsageReport } from '@shared/types';
import { hub } from '@/lib/api';
import { useHub } from '@/lib/store';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { quotaMeters } from '@/lib/usageMeters';
import { Popover, cx } from './ui';

const compact = (n: number) => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export function ComposerUsage({ session }: { session: ChatSession }) {
  const cli = useHub((s) => session.provider === 'claude' || session.provider === 'antigravity' ? s.cliUsage[session.provider] : undefined);
  const visible = useHub((s) => s.data.settings.showUsageInComposer !== false);
  const [report, setReport] = useState<UsageReport>();
  useEffect(() => {
    if (!visible || session.provider !== 'codex') return;
    let alive = true;
    const off = hub.onUsageReport((r) => { if (alive) setReport(r); });
    void hub.usage().then((r) => { if (alive) setReport(r); }).catch(() => {});
    return () => { alive = false; off(); };
  }, [session.provider, visible]);
  if (!visible) return null;
  const tokens = session.messages.reduce((sum, m) => sum + (m.usage?.inputTokens ?? 0) + (m.usage?.outputTokens ?? 0), 0);
  const limits = session.provider === 'codex' ? report?.codexLimits : undefined;
  const meters = limits ? [limits.primary, limits.secondary].filter((w) => w !== null).map((w) => ({
    label: w.window_minutes >= 1440 ? t('Wochenlimit') : `${Math.round(w.window_minutes / 60)} h`,
    used: w.used_percent, reset: new Date(w.resets_at * 1000).toLocaleString(), expired: w.resets_at * 1000 <= Date.now(),
  })) : quotaMeters(session.provider, cli?.ok ? cli.meters : []).map((m) => ({ label: [m.group, m.label].filter(Boolean).join(' · '), used: session.provider === 'antigravity' || m.kind === 'remaining' ? 100 - m.percent : m.percent, reset: m.reset, expired: false }));
  const active = meters.filter((m) => !m.expired && Number.isFinite(m.used));
  const used = active.length ? Math.max(0, Math.min(100, Math.max(...active.map((m) => m.used)))) : undefined;
  const remaining = used === undefined ? undefined : 100 - used;
  const showUsed = session.provider === 'claude';
  const percent = showUsed ? used : remaining;
  const stamp = limits?.at ?? cli?.at;
  return <Popover align="right" trigger={(open, toggle) => <button onClick={toggle} title={t('Nutzung & Limits')} className={cx('btn btn-ghost !gap-1.5 !px-2 text-subtle', open && '!bg-hover')}>
    <Icon name="lucide:chart-no-axes-column" size={13} />
    {percent !== undefined && <span className="h-1.5 w-7 overflow-hidden rounded-full bg-active"><span className={cx('block h-full rounded-full', used! >= 85 ? 'bg-bad' : used! >= 60 ? 'bg-warn' : 'bg-accent')} style={{ width: `${percent}%` }} /></span>}
    <span className="text-[10.5px]">{percent !== undefined ? `${Math.round(percent)}%` : `${compact(tokens)} tok`}</span>
  </button>}>
    {() => <div className="w-64 space-y-3 p-2 text-[12px]">
      <div className="font-medium">{t('Nutzung & Limits')}</div>
      <div className="text-muted">{t('Chat-Verbrauch')}: {compact(tokens)} {t('Token')}</div>
      {meters.map((m, i) => <div key={i}><div className="flex justify-between gap-2"><span>{m.label}</span><span className="shrink-0 text-muted">{m.expired ? t('Fenster abgelaufen') : `${Math.round(Math.max(0, Math.min(100, showUsed ? m.used : 100 - m.used)))}% ${t(showUsed ? 'verbraucht' : 'übrig')}`}</span></div>{m.reset && <div className="mt-0.5 text-[10px] text-subtle">{m.reset}</div>}</div>)}
      {!meters.length && <p className="text-subtle">{t('Keine Kontingentdaten verfügbar. Token sind der gemessene Chat-Verbrauch.')}</p>}
      {stamp && <div className="text-[10px] text-subtle">{t('Stand')}: {new Date(stamp).toLocaleString()}</div>}
    </div>}
  </Popover>;
}
