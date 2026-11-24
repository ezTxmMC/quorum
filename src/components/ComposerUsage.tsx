import { useEffect } from 'react';
import type { ChatSession, ProviderId } from '@shared/types';
import { useHub } from '@/lib/store';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { currentMeters } from '@/lib/usageMeters';
import { Popover, cx } from './ui';

const REFRESH_MS = 10_000;

const compact = (n: number) => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const clamp = (n: number) => Math.max(0, Math.min(100, n));

function barColor(used: number): string {
  if (used >= 85) {
    return 'bg-bad';
  }
  return used >= 60 ? 'bg-warn' : 'bg-accent';
}

/** Hält die Limit-Werte des Anbieters aktuell, solange die Anzeige sichtbar ist. Läuft noch eine Abfrage, wird der Takt übersprungen. */
function useLiveLimits(provider: ProviderId, enabled: boolean) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const refresh = () => {
      const st = useHub.getState();
      const busy = provider === 'claude' || provider === 'antigravity' ? st.cliUsageBusy[provider] : false;
      if (document.visibilityState === 'visible' && !busy) {
        void st.refreshLimits(provider);
      }
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [provider, enabled]);
}

export function ComposerUsage({ session }: { session: ChatSession }) {
  const cli = useHub((s) => session.provider === 'claude' || session.provider === 'antigravity' ? s.cliUsage[session.provider] : undefined);
  const visible = useHub((s) => s.data.settings.showUsageInComposer !== false);
  const codexLimits = useHub((s) => s.codexLimits);
  const codexAt = useHub((s) => s.codexLimitsAt);
  const busy = useHub((s) => session.provider === 'claude' || session.provider === 'antigravity' ? !!s.cliUsageBusy[session.provider] : false);
  const metered = session.provider === 'claude' || session.provider === 'antigravity' || session.provider === 'codex';
  useLiveLimits(session.provider, visible && metered);
  const tokens = useHub((s) => (s.data.sessions.find((x) => x.id === session.id)?.messages ?? []).reduce((sum, m) => sum + (m.usage?.inputTokens ?? 0) + (m.usage?.outputTokens ?? 0), 0));
  if (!visible) return null;
  const limits = session.provider === 'codex' ? codexLimits ?? undefined : undefined;
  const meters = currentMeters(session.provider, cli, limits).map((m) => ({ ...m, label: m.label === 'weekly' ? t('Wochenlimit') : m.label }));
  const active = meters.filter((m) => !m.expired && Number.isFinite(m.used));
  const used = active.length ? Math.max(0, Math.min(100, Math.max(...active.map((m) => m.used)))) : undefined;
  const remaining = used === undefined ? undefined : 100 - used;
  const showUsed = session.provider === 'claude';
  const percent = showUsed ? used : remaining;
  const stamp = session.provider === 'codex' ? codexAt || undefined : cli?.at;
  return <Popover align="right" trigger={(open, toggle) => <button onClick={toggle} title={t('Nutzung & Limits')} className={cx('btn btn-ghost !gap-1.5 !px-2 text-subtle', open && '!bg-hover')}>
    <Icon name="lucide:chart-no-axes-column" size={13} />
    {percent !== undefined && <span className="h-1.5 w-7 overflow-hidden rounded-full bg-active"><span className={cx('block h-full rounded-full transition-[width] duration-500', barColor(used!))} style={{ width: `${percent}%` }} /></span>}
    <span className="text-[10.5px]">{percent !== undefined ? `${Math.round(percent)}%` : `${compact(tokens)} tok`}</span>
  </button>}>
    {() => <div className="w-64 space-y-3 p-2 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t('Nutzung & Limits')}</span>
        {metered && <span className="flex items-center gap-1.5 text-[10px] text-subtle"><span className={cx('size-1.5 rounded-full', busy ? 'pulse-dot bg-accent' : 'bg-ok')} />{t('Live')}</span>}
      </div>
      <div className="text-muted">{t('Chat-Verbrauch')}: {compact(tokens)} {t('Token')}</div>
      {meters.map((m, i) => {
        const shown = clamp(showUsed ? m.used : 100 - m.used);
        return (
          <div key={i}>
            <div className="flex justify-between gap-2"><span>{m.label}</span><span className="shrink-0 tabular-nums text-muted">{m.expired ? t('Fenster abgelaufen') : `${Math.round(shown)}% ${t(showUsed ? 'verbraucht' : 'übrig')}`}</span></div>
            {!m.expired && <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-active"><div className={cx('h-full rounded-full transition-[width] duration-500', barColor(m.used))} style={{ width: `${shown}%` }} /></div>}
            {m.reset && <div className="mt-1 text-[10px] text-subtle">{m.reset}</div>}
          </div>
        );
      })}
      {!meters.length && <p className="text-subtle">{t('Keine Kontingentdaten verfügbar. Token sind der gemessene Chat-Verbrauch.')}</p>}
      {stamp && <div className="text-[10px] text-subtle">{t('Stand')}: {new Date(stamp).toLocaleTimeString()} · {t('aktualisiert alle 10 s')}</div>}
    </div>}
  </Popover>;
}
