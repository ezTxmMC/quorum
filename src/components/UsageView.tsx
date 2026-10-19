import { startTransition, useEffect, useMemo, useState } from 'react';
import { PROVIDERS } from '@shared/catalog';
import type { Persisted, ProviderId, RateWindow, UsageReport } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { quotaMeters } from '@/lib/usageMeters';
import { useHub } from '@/lib/store';
import { Dot } from './ModelPicker';
import { cx } from './ui';

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

function until(ts: number) {
  const m = Math.max(0, Math.round((ts * 1000 - Date.now()) / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** Codex zeigt – wie die CLI selbst – das verbleibende Kontingent: 100 % → 0 %. */
function Meter({ label, w }: { label: string; w: RateWindow }) {
  const expired = w.resets_at * 1000 < Date.now();
  const left = expired ? 100 : Math.max(0, Math.min(100, 100 - w.used_percent));
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between"><span className="font-medium">{label}</span><span className="text-[12px] text-muted">{expired ? t('zurückgesetzt') : `${Math.round(left)} % ${t('übrig')}`}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-active"><div className={cx('h-full rounded-full transition-[width] duration-500', left < 15 ? 'bg-bad' : left < 40 ? 'bg-warn' : 'bg-accent')} style={{ width: `${left}%` }} /></div>
      <div className="mt-1 text-[11px] text-subtle">{expired ? t('Fenster abgelaufen') : `${t('Zurücksetzung in')} ${until(w.resets_at)}`}</div>
    </div>
  );
}

/** Limits aus `/usage` der interaktiven CLI (wird auf Knopfdruck abgefragt, weil dafür kurz die CLI gestartet wird). */
function CliLimits({ provider }: { provider: 'claude' | 'antigravity' }) {
  // Werte kommen aus dem Store und werden dort automatisch im Hintergrund aktualisiert.
  const res = useHub((s) => s.cliUsage[provider]);
  const busy = !!useHub((s) => s.cliUsageBusy[provider]);
  const [showRaw, setShowRaw] = useState(false);
  const groups = useMemo(() => {
    const g = new Map<string, NonNullable<typeof res>['meters']>();
    for (const m of quotaMeters(provider, res?.meters ?? [])) g.set(m.group ?? '', [...(g.get(m.group ?? '') ?? []), m]);
    return [...g.entries()];
  }, [res, provider]);
  return (
    <section className="rounded-lumen-lg border border-edge bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <Dot id={provider} /><span className="font-medium">{PROVIDERS[provider].name} – {t('Limits')}</span>
        <div className="flex-1" />
        {res && <span className="text-[11px] text-subtle">{t('Stand')} {new Date(res.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
        <button className="icon-btn" title={t('Aktualisieren')} disabled={busy} onClick={() => void useHub.getState().refreshCliUsage(provider)}><Icon name={busy ? 'lucide:loader-circle' : 'lucide:refresh-cw'} size={14} className={busy ? 'spin' : ''} /></button>
      </div>
      {!res && <div className="text-muted">{busy ? t('Frage /usage ab …') : t('Wird automatisch im Hintergrund abgefragt.')}</div>}
      {groups.map(([group, meters]) => (
        <div key={group} className="mb-4 last:mb-0">
          {group && <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-subtle">{group}</div>}
          <div className="grid gap-5 md:grid-cols-2">
            {meters.map((m, i) => {
              // Konvention je Anbieter: Claude zählt hoch (genutzt, 0 → 100 %), Antigravity/Gemini zählt herunter (übrig, 100 → 0 %).
              const showRemaining = provider !== 'claude';
              // Antigravity zeigt immer das verbleibende Kontingent – auch bei Zeilen ohne "Remaining" im Namen (z. B. Gemini 4 Argon Weekly Limit).
              const kind = provider === 'antigravity' ? 'remaining' : m.kind;
              const pct = Math.max(0, Math.min(100, (kind === 'remaining') === showRemaining ? m.percent : 100 - m.percent));
              const bad = showRemaining ? 100 - pct : pct; // Auslastung für die Farbe
              return (
                <div key={i}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-2"><span className="truncate font-medium">{m.label}</span><span className="shrink-0 text-[12px] text-muted">{pct.toFixed(pct % 1 ? 1 : 0)} % {showRemaining ? t('übrig') : t('genutzt')}</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-active"><div className={cx('h-full rounded-full transition-[width] duration-500', bad > 85 ? 'bg-bad' : bad > 60 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} /></div>
                  {m.reset && <div className="mt-1 text-[11px] text-subtle">{m.reset}</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {res && !groups.length && <div className="text-warn">{res.error ?? t('Keine Prozentwerte gefunden.')}</div>}
      {res?.raw && (
        <div className="mt-3">
          <button className="text-[11.5px] text-subtle hover:text-fg" onClick={() => setShowRaw((r) => !r)}>{showRaw ? t('Rohausgabe ausblenden') : t('Rohausgabe anzeigen')}</button>
          {showRaw && <pre className="mt-1.5 max-h-60 overflow-auto rounded-lumen-sm bg-bg p-2.5 font-mono text-[11px] text-muted">{res.raw}</pre>}
        </div>
      )}
    </section>
  );
}

type Stats = Record<ProviderId, { msgs: number; input: number; output: number; cost: number }>;
function computeStats(d: Persisted): Stats {
  const acc = Object.fromEntries((['claude', 'codex', 'antigravity', 'opencode', 'ollama', 'local', 'api'] as ProviderId[]).map((p) => [p, { msgs: 0, input: 0, output: 0, cost: 0 }])) as Stats;
  const add = (p: ProviderId | undefined, u: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined) => { if (!p || !u) return; const a = acc[p]; a.msgs++; a.input += u.inputTokens ?? 0; a.output += u.outputTokens ?? 0; a.cost += u.costUsd ?? 0; };
  for (const s of d.sessions) for (const m of s.messages) if (m.role === 'assistant') add(m.provider, m.usage);
  for (const r of d.multiRuns) for (const tn of r.turns) add(tn.message.provider, tn.message.usage);
  return acc;
}
const idle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 50));

/**
 * Vom Hub selbst gemessen – im Leerlauf und höchstens alle 2 s berechnet. Die Ansicht abonniert die Chats nicht direkt,
 * damit laufende Antworten (jedes Streaming-Event ändert die Sessions) die Einstellungen nicht ständig neu rendern.
 */
function useHubStats(): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    let alive = true;
    const run = () => idle(() => { timer = undefined; if (alive) startTransition(() => setStats(computeStats(useHub.getState().data))); });
    run();
    let last = useHub.getState().data;
    const unsub = useHub.subscribe((st) => {
      if (st.data.sessions === last.sessions && st.data.multiRuns === last.multiRuns) return;
      last = st.data;
      if (timer === undefined) timer = window.setTimeout(run, 2000);
    });
    return () => { alive = false; unsub(); if (timer !== undefined) clearTimeout(timer); };
  }, []);
  return stats;
}

export function UsageView() {
  const [rep, setRep] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const hubStats = useHubStats();
  // Sofort der zwischengespeicherte Stand; neue Auswertungen (Worker-Thread im Hauptprozess) kommen per Push.
  useEffect(() => {
    const off = hub.onUsageReport((r) => startTransition(() => setRep(r)));
    void hub.usage().then((r) => startTransition(() => setRep(r)));
    return off;
  }, []);
  const load = () => { setBusy(true); void hub.usage(true).then((r) => startTransition(() => setRep(r))).finally(() => setBusy(false)); };

  const max = useMemo(() => Math.max(1, ...(rep?.days.map((d) => d.claude.input + d.claude.output + d.codex.input + d.codex.output) ?? [1])), [rep]);
  const sum = (key: 'claude' | 'codex', n: number) => (rep?.days.slice(-n) ?? []).reduce((a, d) => a + d[key].input + d[key].output, 0);

  const lim = rep?.codexLimits;
  return (
    <div className="space-y-7">
      <div className="flex items-center justify-between">
        <div><h2 className="text-[16px] font-semibold">{t('Nutzung')}</h2><p className="text-muted">{t('Verbrauch aus den lokalen Verläufen der CLIs und aus dem Hub.')}</p></div>
        <button className="btn" disabled={busy} onClick={load}><Icon name="lucide:refresh-cw" size={14} className={busy || !rep ? 'spin' : ''} /> {t('Aktualisieren')}</button>
      </div>

      <section className="rounded-lumen-lg border border-edge bg-surface p-4">
        <div className="mb-3 flex items-center gap-2"><Dot id="codex" /><span className="font-medium">{t('GPT Codex – Limits')}</span>{lim?.plan && <span className="rounded-full bg-active px-2 text-[11px] uppercase text-muted">{lim.plan}</span>}</div>
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
        <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Token pro Tag')} (14 {t('Tage')})</h3>
        <div className="flex h-36 items-end gap-1.5 rounded-lumen-lg border border-edge bg-surface p-3">
          {rep?.days.map((d) => {
            const c = d.claude.input + d.claude.output, x = d.codex.input + d.codex.output;
            return (
              <div key={d.date} className="group flex h-full min-w-0 flex-1 flex-col justify-end" title={`${d.date}\nClaude ${fmt(c)} · Codex ${fmt(x)}`}>
                <div className="bar-grow flex flex-col justify-end overflow-hidden rounded-t-sm" style={{ height: `${((c + x) / max) * 100}%` }}>
                  <div style={{ flex: x, background: PROVIDERS.codex.color }} /><div style={{ flex: c, background: PROVIDERS.claude.color }} />
                </div>
                <div className="mt-1 text-center text-[9.5px] text-subtle">{d.date.slice(8)}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-4 text-[12px] text-muted"><span className="flex items-center gap-1.5"><Dot id="claude" size={7} /> Claude Code</span><span className="flex items-center gap-1.5"><Dot id="codex" size={7} /> GPT Codex</span></div>
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([['claude', 1], ['claude', 7], ['codex', 1], ['codex', 7]] as const).map(([p, n]) => (
          <div key={p + n} className="rounded-lumen-lg border border-edge bg-surface p-3.5">
            <div className="flex items-center gap-1.5 text-[11.5px] text-muted"><Dot id={p} size={7} />{PROVIDERS[p].name} · {n === 1 ? t('heute') : `7 ${t('Tage')}`}</div>
            <div className="mt-1 text-[22px] font-semibold tracking-tight">{rep ? fmt(sum(p, n)) : '…'}</div>
            <div className="text-[11px] text-subtle">{t('Token')}</div>
          </div>
        ))}
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Im Hub gemessen')}</h3>
        <div className="overflow-hidden rounded-lumen-lg border border-edge">
          <table className="w-full text-left">
            <thead className="bg-surface text-[11.5px] text-muted"><tr><th className="px-3 py-2 font-medium">{t('Anbieter')}</th><th className="px-3 py-2 font-medium">{t('Antworten')}</th><th className="px-3 py-2 font-medium">↑ {t('Eingabe')}</th><th className="px-3 py-2 font-medium">↓ {t('Ausgabe')}</th><th className="px-3 py-2 font-medium">{t('Kosten')}</th></tr></thead>
            <tbody>
              {(['claude', 'codex', 'antigravity', 'opencode', 'ollama', 'local', 'api'] as ProviderId[]).map((p) => (
                <tr key={p} className="border-t border-edge"><td className="px-3 py-2"><span className="flex items-center gap-2"><Dot id={p} />{PROVIDERS[p].name}</span></td><td className="px-3 py-2">{hubStats ? hubStats[p].msgs : '…'}</td><td className="px-3 py-2">{hubStats ? fmt(hubStats[p].input) : '…'}</td><td className="px-3 py-2">{hubStats ? fmt(hubStats[p].output) : '…'}</td><td className="px-3 py-2">{hubStats?.[p].cost ? `$${hubStats[p].cost.toFixed(2)}` : '–'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11.5px] text-subtle">{t('Claude Code und Antigravity melden über die CLI keine Kontingente; angezeigt wird der tatsächliche Verbrauch. Importierte Chats enthalten keine Token-Angaben.')}</p>
      </section>
    </div>
  );
}
