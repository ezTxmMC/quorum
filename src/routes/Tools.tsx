import { t } from '@/lib/i18n';
import { useState } from 'react';
import { PROVIDERS, isTextOnly } from '@shared/catalog';
import type { CliCommandResult, ProviderId } from '@shared/types';
import { ProviderMark, cx } from '@/components/ui';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { splitArgs } from '@/lib/args';
import { useHub } from '@/lib/store';

export function ToolsPage() {
  const [pid, setPid] = useState<ProviderId>('claude');
  const meta = PROVIDERS[pid];
  const status = useHub((s) => s.statuses[pid]);
  const refresh = useHub((s) => s.refreshStatus);
  const cwd = useHub((s) => s.data.recentProjects[0] ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<{ title: string; res: CliCommandResult } | null>(null);
  const [custom, setCustom] = useState('');

  const exec = async (title: string, args: string[]) => {
    setBusy(title);
    setOut({ title, res: await hub.cli(pid, args, cwd) });
    setBusy(null);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
        <div>
          <h1 className="mb-1 text-[22px] font-semibold tracking-tight">{t('CLI-Werkzeuge')}</h1>
          <p className="text-muted">{t('Alle Verwaltungsfunktionen der drei CLIs an einem Ort: MCP, Plugins, Agenten, Anmeldung, Diagnose und die Funktionsübersicht.')}</p>
        </div>

        <div className="flex gap-2">
          {(Object.keys(PROVIDERS) as ProviderId[]).filter((p) => !isTextOnly(p)).map((p) => (
            <button key={p} onClick={() => { setPid(p); setOut(null); }} className={cx('btn !gap-2.5 !px-3.5 !py-2', pid === p && 'border-accent bg-hover')}>
              <ProviderMark id={p} size={14} /> {PROVIDERS[p].name}
            </button>
          ))}
        </div>

        <section className="rounded-lumen-lg border border-edge bg-surface p-4">
          <div className="flex items-center gap-3">
            <ProviderMark id={pid} size={22} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{meta.name} <span className="font-normal text-subtle">· {meta.vendor}</span></div>
              <div className="truncate font-mono text-[11.5px] text-subtle">{status?.installed ? `${status.path} · ${status.version ?? ''}` : t('Nicht installiert / nicht im PATH')}</div>
            </div>
            <span className={cx('rounded-full px-2.5 py-0.5 text-[11.5px]', status?.installed ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad')}>{status?.installed ? t('bereit') : t('fehlt')}</span>
            <button className="icon-btn" title={t('Neu erkennen')} onClick={() => refresh(pid, true)}><Icon name="lucide:refresh-cw" size={14} /></button>
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Befehle')}</h2>
          <div className="grid grid-cols-3 gap-2">
            {meta.commands.map((c) => (
              <button key={c.id} disabled={!status?.installed || !!busy} onClick={() => exec(c.label, c.args)} className="flex items-center gap-3 rounded-lumen-lg border border-edge p-3 text-left transition-colors enabled:hover:bg-hover disabled:opacity-50">
                <Icon name={busy === c.label ? 'lucide:loader-circle' : c.icon} size={17} className={busy === c.label ? 'spin text-accent' : 'text-muted'} />
                <span className="min-w-0"><span className="block font-medium">{t(c.label)}</span><span className="block truncate font-mono text-[11px] text-subtle">{c.hint}</span></span>
              </button>
            ))}
          </div>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) void exec(`${meta.bin} ${custom}`, splitArgs(custom)); }}>
            <div className="flex flex-1 items-center gap-2 rounded-lumen-sm border border-edge bg-input px-3 font-mono text-[12.5px] focus-within:border-accent">
              <span className="text-subtle">{meta.bin}</span>
              <input className="w-full bg-transparent py-1.5 outline-none" placeholder="mcp add …   |   plugin install …   |   login …" value={custom} onChange={(e) => setCustom(e.target.value)} />
            </div>
            <button className="btn btn-primary" disabled={!custom.trim() || !!busy}><Icon name="lucide:play" size={13} /> {t('Ausführen')}</button>
          </form>
          <p className="mt-1.5 text-[11.5px] text-subtle">{t('Läuft im Projekt')} <span className="font-mono">{cwd}</span>{t('. Interaktive Befehle (z. B. Login-Flow) bitte im Terminal starten.')}</p>
        </section>

        {out && (
          <section className="fade-in overflow-hidden rounded-lumen-lg border border-edge">
            <div className="flex items-center gap-2 border-b border-edge bg-surface px-3 py-2">
              <Icon name={out.res.ok ? 'lucide:circle-check' : 'lucide:circle-x'} size={15} className={out.res.ok ? 'text-ok' : 'text-bad'} />
              <span className="font-medium">{out.title}</span><span className="text-subtle">Exit {out.res.code}</span>
              <span className="flex-1" /><button className="icon-btn" onClick={() => setOut(null)}><Icon name="lucide:x" size={14} /></button>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] text-muted">{(out.res.stdout + (out.res.stderr ? '\n' + out.res.stderr : '')).trim() || t('(keine Ausgabe)')}</pre>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-subtle">Modelle ({status?.models.length ?? 0})</h2>
          <div className="flex flex-wrap gap-1.5">
            {status?.models.map((m) => <span key={m.id} className="rounded-full border border-edge px-2.5 py-0.5 text-[12px]" title={m.id}>{m.label}{m.efforts?.length ? <span className="text-subtle"> · {m.efforts.length} Stufen</span> : null}</span>)}
            {!status?.models.length && <span className="text-subtle">{t('Keine Modelle erkannt.')}</span>}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Im Hub unterstützte Funktionen')}</h2>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {meta.features.map((f) => <div key={f} className="flex items-center gap-2 py-0.5"><Icon name="lucide:check" size={14} className="text-ok" />{t(f)}</div>)}
          </div>
        </section>
      </div>
    </div>
  );
}
