import { startTransition, useEffect, useMemo, useState } from 'react';
import { PROVIDERS, PROVIDER_ORDER } from '@shared/catalog';
import { fmtUsd } from '@shared/pricing';
import type { ProviderId, RateWindow, UsageReport } from '@shared/types';
import {
  aggregateByProvider,
  availableMonths,
  buildDailySeries,
  extractUsageEntries,
  localMonthKey,
  type UsageEntry,
} from '@shared/usage-stats';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { quotaMeters } from '@/lib/usageMeters';
import { Dot } from './ModelPicker';
import { Select, cx } from './ui';

type TableRange = 'month' | '3m' | '6m' | 'all';

const fmt = (n: number) => (
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k`
        : String(Math.round(n))
);

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) {
    return monthKey;
  }
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function until(ts: number): string {
  const minutes = Math.max(0, Math.round((ts * 1000 - Date.now()) / 60000));
  if (minutes >= 1440) {
    return `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`;
  }
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** Codex zeigt – wie die CLI selbst – das verbleibende Kontingent: 100 % → 0 %. */
function Meter({ label, w }: { label: string; w: RateWindow }) {
  const expired = w.resets_at * 1000 < Date.now();
  const left = expired ? 100 : Math.max(0, Math.min(100, 100 - w.used_percent));
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="font-medium">{label}</span>
        <span className="text-[12px] text-muted">{expired ? t('zurückgesetzt') : `${Math.round(left)} % ${t('übrig')}`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-active">
        <div className={cx('h-full rounded-full transition-[width] duration-500', left < 15 ? 'bg-bad' : left < 40 ? 'bg-warn' : 'bg-accent')} style={{ width: `${left}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-subtle">{expired ? t('Fenster abgelaufen') : `${t('Zurücksetzung in')} ${until(w.resets_at)}`}</div>
    </div>
  );
}

/** Limits aus `/usage` der interaktiven CLI (wird auf Knopfdruck abgefragt, weil dafür kurz die CLI gestartet wird). */
function CliLimits({ provider }: { provider: 'claude' | 'antigravity' }) {
  const res = useHub((s) => s.cliUsage[provider]);
  const busy = !!useHub((s) => s.cliUsageBusy[provider]);
  const [showRaw, setShowRaw] = useState(false);

  const groups = useMemo(() => {
    const grouped = new Map<string, NonNullable<typeof res>['meters']>();
    for (const meter of quotaMeters(provider, res?.meters ?? [])) {
      grouped.set(meter.group ?? '', [...(grouped.get(meter.group ?? '') ?? []), meter]);
    }
    return [...grouped.entries()];
  }, [res, provider]);

  return (
    <section className="rounded-lumen-lg border border-edge bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <Dot id={provider} />
        <span className="font-medium">{PROVIDERS[provider].name} – {t('Limits')}</span>
        <div className="flex-1" />
        {res && <span className="text-[11px] text-subtle">{t('Stand')} {new Date(res.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
        <button className="icon-btn" title={t('Aktualisieren')} disabled={busy} onClick={() => void useHub.getState().refreshCliUsage(provider)}>
          <Icon name={busy ? 'lucide:loader-circle' : 'lucide:refresh-cw'} size={14} className={busy ? 'spin' : ''} />
        </button>
      </div>
      {!res && <div className="text-muted">{busy ? t('Frage /usage ab …') : t('Wird automatisch im Hintergrund abgefragt.')}</div>}
      {groups.map(([group, meters]) => (
        <div key={group} className="mb-4 last:mb-0">
          {group && <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-subtle">{group}</div>}
          <div className="grid gap-5 md:grid-cols-2">
            {meters.map((meter, index) => {
              const showRemaining = provider !== 'claude';
              const kind = provider === 'antigravity' ? 'remaining' : meter.kind;
              const pct = Math.max(0, Math.min(100, (kind === 'remaining') === showRemaining ? meter.percent : 100 - meter.percent));
              const bad = showRemaining ? 100 - pct : pct;
              return (
                <div key={index}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{meter.label}</span>
                    <span className="shrink-0 text-[12px] text-muted">{pct.toFixed(pct % 1 ? 1 : 0)} % {showRemaining ? t('übrig') : t('genutzt')}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-active">
                    <div className={cx('h-full rounded-full transition-[width] duration-500', bad > 85 ? 'bg-bad' : bad > 60 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
                  </div>
                  {meter.reset && <div className="mt-1 text-[11px] text-subtle">{meter.reset}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {res && !groups.length && <div className="text-warn">{res.error ?? t('Keine Prozentwerte gefunden.')}</div>}
      {res?.raw && (
        <div className="mt-3">
          <button className="text-[11.5px] text-subtle hover:text-fg" onClick={() => setShowRaw((open) => !open)}>
            {showRaw ? t('Rohausgabe ausblenden') : t('Rohausgabe anzeigen')}
          </button>
          {showRaw && <pre className="mt-1.5 max-h-60 overflow-auto rounded-lumen-sm bg-bg p-2.5 font-mono text-[11px] text-muted">{res.raw}</pre>}
        </div>
      )}
    </section>
  );
}

const idle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 50));

/**
 * Normalisierte Verbrauchsdaten aus dem Hub – im Leerlauf und höchstens alle 2 s berechnet.
 */
function useHubUsageEntries(): UsageEntry[] | null {
  const [entries, setEntries] = useState<UsageEntry[] | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    let alive = true;
    const run = () => idle(() => {
      timer = undefined;
      if (alive) {
        startTransition(() => setEntries(extractUsageEntries(useHub.getState().data)));
      }
    });
    run();
    let last = useHub.getState().data;
    const unsub = useHub.subscribe((state) => {
      if (state.data.sessions === last.sessions && state.data.multiRuns === last.multiRuns) {
        return;
      }
      last = state.data;
      if (timer === undefined) {
        timer = window.setTimeout(run, 2000);
      }
    });
    return () => {
      alive = false;
      unsub();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, []);
  return entries;
}

export function UsageView() {
  const [rep, setRep] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [range, setRange] = useState<TableRange>('month');
  const [selectedMonth, setSelectedMonth] = useState<string>(() => localMonthKey(Date.now()));
  const entries = useHubUsageEntries();

  useEffect(() => {
    const off = hub.onUsageReport((report) => startTransition(() => setRep(report)));
    void hub.usage().then((report) => startTransition(() => setRep(report)));
    return off;
  }, []);

  const load = () => {
    setBusy(true);
    void hub.usage(true).then((report) => startTransition(() => setRep(report))).finally(() => setBusy(false));
  };

  const daily = useMemo(() => buildDailySeries(entries ?? [], rep, 14), [entries, rep]);
  const maxDayTotal = useMemo(() => Math.max(1, ...daily.map((day) => day.total)), [daily]);

  const activeProviders = useMemo<ProviderId[]>(() => {
    const active = PROVIDER_ORDER.filter((provider) => (
      daily.some((day) => day.byProvider[provider] > 0)
      || (entries?.some((entry) => entry.provider === provider) ?? false)
    ));
    return active.length ? active : ['claude', 'codex'];
  }, [daily, entries]);

  const sumDays = (provider: ProviderId, days: number) => (
    daily.slice(-days).reduce((total, day) => total + day.byProvider[provider], 0)
  );

  const months = useMemo(() => availableMonths(entries ?? []), [entries]);
  const activeMonth = months.includes(selectedMonth) ? selectedMonth : months[0];

  const allStats = useMemo(() => (entries ? aggregateByProvider(entries) : null), [entries]);
  const tableStats = useMemo(() => {
    if (!entries) {
      return null;
    }
    if (range === 'month') {
      return aggregateByProvider(entries, { month: activeMonth });
    }
    if (range === '3m') {
      return aggregateByProvider(entries, { sinceMs: Date.now() - 90 * 86_400_000 });
    }
    if (range === '6m') {
      return aggregateByProvider(entries, { sinceMs: Date.now() - 180 * 86_400_000 });
    }
    return allStats;
  }, [entries, range, activeMonth, allStats]);

  const tableTotals = useMemo(() => {
    if (!tableStats) {
      return null;
    }
    return PROVIDER_ORDER.reduce(
      (acc, provider) => {
        const row = tableStats[provider];
        acc.msgs += row.msgs;
        acc.freshInput += row.freshInput;
        acc.cachedInput += row.cachedInput;
        acc.output += row.output;
        acc.cost += row.cost;
        return acc;
      },
      { msgs: 0, freshInput: 0, cachedInput: 0, output: 0, cost: 0 },
    );
  }, [tableStats]);

  const allTimeTotals = useMemo(() => {
    if (!allStats) {
      return null;
    }
    return PROVIDER_ORDER.reduce(
      (acc, provider) => {
        acc.msgs += allStats[provider].msgs;
        acc.cost += allStats[provider].cost;
        return acc;
      },
      { msgs: 0, cost: 0 },
    );
  }, [allStats]);

  const lim = rep?.codexLimits;
  const rangeTabs: { id: TableRange; label: string }[] = [
    { id: 'month', label: t('Pro Monat') },
    { id: '3m', label: `3 ${t('Monate')}` },
    { id: '6m', label: `6 ${t('Monate')}` },
    { id: 'all', label: t('Insgesamt') },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">{t('Nutzung')}</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">{t('Verbrauch aus den lokalen Verläufen der CLIs und aus dem Hub.')}</p>
        </div>
        <button className="btn" disabled={busy} onClick={load}>
          <Icon name="lucide:refresh-cw" size={14} className={busy || !rep ? 'spin' : ''} /> {t('Aktualisieren')}
        </button>
      </div>

      <section className="rounded-lumen-lg border border-edge bg-surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <Dot id="codex" />
          <span className="font-medium">{t('GPT Codex – Limits')}</span>
          {lim?.plan && <span className="rounded-full bg-active px-2 text-[11px] uppercase text-muted">{lim.plan}</span>}
        </div>
        {!rep && <div className="text-muted">…</div>}
        {rep && !lim && <div className="text-muted">{t('Noch keine Limit-Daten – sie erscheinen nach dem ersten Codex-Lauf.')}</div>}
        {lim && (
          <div className="grid gap-5 md:grid-cols-2">
            <Meter label={lim.primary.window_minutes >= 1440 ? t('Wochenlimit') : `${Math.round(lim.primary.window_minutes / 60)}-${t('Stunden-Limit')}`} w={lim.primary} />
            {lim.secondary && <Meter label={lim.secondary.window_minutes >= 1440 ? t('Wochenlimit') : `${Math.round(lim.secondary.window_minutes / 60)}-${t('Stunden-Limit')}`} w={lim.secondary} />}
          </div>
        )}
        {lim && <div className="mt-3 text-[11px] text-subtle">{t('Stand des letzten Codex-Laufs:')} {new Date(lim.at).toLocaleString()}</div>}
      </section>

      <CliLimits provider="claude" />
      <CliLimits provider="antigravity" />

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Token pro Tag')} (14 {t('Tage')})</h3>
          <span className="text-[11px] text-subtle">{t('Neue Eingabe + Ausgabe (ohne Cache-Treffer)')}</span>
        </div>
        <div className="flex h-36 items-end gap-1.5 rounded-lumen-lg border border-edge bg-surface p-3">
          {daily.map((day) => {
            const breakdown = activeProviders
              .filter((provider) => day.byProvider[provider] > 0)
              .map((provider) => `${PROVIDERS[provider].name} ${fmt(day.byProvider[provider])}`)
              .join(' · ');
            return (
              <div
                key={day.date}
                className="group flex h-full min-w-0 flex-1 flex-col justify-end"
                title={breakdown ? `${day.date}\n${breakdown}` : `${day.date}\n0`}
              >
                <div
                  className="bar-grow flex flex-col justify-end overflow-hidden rounded-t-sm"
                  style={{ height: `${(day.total / maxDayTotal) * 100}%` }}
                >
                  {activeProviders.map((provider) => (
                    day.byProvider[provider] > 0 ? (
                      <div key={provider} style={{ flex: day.byProvider[provider], background: PROVIDERS[provider].color }} />
                    ) : null
                  ))}
                </div>
                <div className="mt-1 text-center text-[9.5px] text-subtle">{day.date.slice(8)}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          {activeProviders.map((provider) => (
            <span key={provider} className="flex items-center gap-1.5">
              <Dot id={provider} size={7} /> {PROVIDERS[provider].name}
            </span>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {activeProviders.map((provider) => (
          <div key={provider} className="rounded-lumen-lg border border-edge bg-surface p-3.5">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg">
              <Dot id={provider} size={7} />
              <span className="truncate">{PROVIDERS[provider].name}</span>
            </div>
            <div className="mt-2.5 grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10.5px] uppercase tracking-wide text-subtle">{t('heute')}</div>
                <div className="mt-0.5 text-[19px] font-semibold tracking-tight">{entries || rep ? fmt(sumDays(provider, 1)) : '…'}</div>
              </div>
              <div>
                <div className="text-[10.5px] uppercase tracking-wide text-subtle">7 {t('Tage')}</div>
                <div className="mt-0.5 text-[19px] font-semibold tracking-tight">{entries || rep ? fmt(sumDays(provider, 7)) : '…'}</div>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="overflow-hidden rounded-lumen-lg border border-edge bg-surface/60">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-hover/60"
          onClick={() => setTableOpen((open) => !open)}
          aria-expanded={tableOpen}
        >
          <div className="flex items-center gap-2">
            <Icon name={tableOpen ? 'lucide:chevron-down' : 'lucide:chevron-right'} size={15} className="text-muted" />
            <span className="text-[12.5px] font-semibold uppercase tracking-wide text-fg">{t('Im Hub gemessen')}</span>
          </div>
          <div className="flex items-center gap-3 text-[11.5px] text-muted">
            {allTimeTotals && (
              <>
                <span>{allTimeTotals.msgs.toLocaleString()} {t('Antworten')}</span>
                {allTimeTotals.cost > 0 && <span className="font-mono text-fg">≈ {fmtUsd(allTimeTotals.cost)}</span>}
              </>
            )}
          </div>
        </button>

        {tableOpen && (
          <div className="border-t border-edge p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex rounded-lumen-sm border border-edge bg-bg/70 p-0.5 text-[12px]">
                {rangeTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setRange(tab.id)}
                    className={cx(
                      'rounded-[5px] px-2.5 py-1 font-medium transition-colors',
                      range === tab.id ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted',
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {range === 'month' && (
                <div className="w-48">
                  <Select
                    value={activeMonth}
                    onChange={setSelectedMonth}
                    options={months.map((month) => ({ value: month, label: formatMonthLabel(month) }))}
                  />
                </div>
              )}
            </div>

            <div className="overflow-hidden rounded-lumen border border-edge bg-bg/40">
              <table className="w-full text-left text-[12.5px]">
                <thead className="bg-surface text-[11.5px] text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">{t('Anbieter')}</th>
                    <th className="px-3 py-2 font-medium">{t('Antworten')}</th>
                    <th className="px-3 py-2 font-medium" title={t('Neue Eingabe-Token (Cache-Treffer separat ausgewiesen)')}>↑ {t('Eingabe')}</th>
                    <th className="px-3 py-2 font-medium">↓ {t('Ausgabe')}</th>
                    <th className="px-3 py-2 font-medium" title={t('Theoretische API-Kosten – so viel würde dieselbe Nutzung über die API kosten (Listenpreise, geschätzt).')}>
                      {t('API-Kosten (theoretisch)')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {PROVIDER_ORDER.map((provider) => {
                    const row = tableStats?.[provider];
                    return (
                      <tr key={provider} className={cx('border-t border-edge', row && row.msgs === 0 && 'opacity-50')}>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2"><Dot id={provider} />{PROVIDERS[provider].name}</span>
                        </td>
                        <td className="px-3 py-2 tabular-nums">{row ? row.msgs.toLocaleString() : '…'}</td>
                        <td className="px-3 py-2 tabular-nums">
                          <div>{row ? fmt(row.freshInput) : '…'}</div>
                          {row && row.cachedInput > 0 && (
                            <div className="text-[10.5px] text-subtle">+{fmt(row.cachedInput)} Cache</div>
                          )}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{row ? fmt(row.output) : '…'}</td>
                        <td className="px-3 py-2 tabular-nums">{row?.cost ? `≈ ${fmtUsd(row.cost)}` : '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {tableTotals && (
                  <tfoot className="border-t border-edge bg-surface/80 font-medium text-fg">
                    <tr>
                      <td className="px-3 py-2">{t('Gesamt')}</td>
                      <td className="px-3 py-2 tabular-nums">{tableTotals.msgs.toLocaleString()}</td>
                      <td className="px-3 py-2 tabular-nums">
                        <div>{fmt(tableTotals.freshInput)}</div>
                        {tableTotals.cachedInput > 0 && (
                          <div className="text-[10.5px] font-normal text-subtle">+{fmt(tableTotals.cachedInput)} Cache</div>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{fmt(tableTotals.output)}</td>
                      <td className="px-3 py-2 tabular-nums">{tableTotals.cost ? `≈ ${fmtUsd(tableTotals.cost)}` : '–'}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <p className="mt-2.5 text-[11.5px] text-subtle">
              {t('Kumulative Session-Zähler (Claude-Kosten, Codex & Antigravity) werden je Schritt bereinigt. Importierte Chats enthalten keine Token-Angaben.')}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
