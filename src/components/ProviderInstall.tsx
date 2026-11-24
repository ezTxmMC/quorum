import { useEffect, useState } from 'react';
import { PROVIDERS } from '@shared/catalog';
import { CLI_PACKAGES, type HostInstallPlan } from '@shared/cli-packages';
import type { ProviderId } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { cx } from './ui';

const LOG_LINES = 6;

interface HostInstallCardProps {
  provider: ProviderId;
}

/** Installiert die CLI eines Anbieters ins Benutzerverzeichnis. Erscheint nur, solange die CLI fehlt, und zeigt vorab genau, was geprüft und ausgeführt wird. */
export function HostInstallCard({ provider }: HostInstallCardProps) {
  const installed = useHub((s) => s.statuses[provider]?.installed);
  const sandboxed = useHub((s) => !!s.data.settings.sandboxed?.[provider]);
  const [plan, setPlan] = useState<HostInstallPlan>();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const offered = !!CLI_PACKAGES[provider] && (!installed || sandboxed || done);

  useEffect(() => {
    if (!offered) {
      return;
    }
    let alive = true;
    void hub.cliInstallPlan(provider).then((next) => {
      if (alive) {
        setPlan(next);
      }
    });
    const off = hub.onCliInstallProgress((progress) => {
      if (progress.provider === provider) {
        setLog((lines) => [...lines, progress.text].slice(-LOG_LINES));
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [provider, offered]);

  async function handleInstall() {
    setBusy(true);
    setError('');
    setLog([]);
    const result = await hub.cliInstall(provider);
    setBusy(false);
    setPlan(await hub.cliInstallPlan(provider));
    if (!result.ok) {
      setError(result.error ?? t('Installation fehlgeschlagen.'));
      return;
    }
    setDone(true);
    void useHub.getState().refreshStatus(provider, true);
  }

  // Ist die CLI schon vorhanden (und wurde nicht eben hier installiert), gibt es nichts anzubieten.
  if (!offered || !plan?.available || (!done && !plan.ready && plan.checks[0]?.ok === false)) {
    return null;
  }

  return (
    <section className="space-y-3 rounded-lumen border border-edge bg-bg/40 p-4">
      <div className="flex items-start gap-3">
        <Icon name={done ? 'lucide:circle-check' : 'lucide:package-plus'} size={16} className={cx('mt-0.5 shrink-0', done ? 'text-ok' : 'text-muted')} />
        <div className="min-w-0 flex-1">
          <h4 className="text-[13px] font-semibold text-fg">{done ? `${PROVIDERS[provider].name} ${t('wurde installiert')}` : `${PROVIDERS[provider].name} ${t('installieren')}`}</h4>
          <p className="mt-0.5 text-[11.5px] text-subtle">
            {done ? `${t('Die CLI liegt in')} ${plan.binDir}. ${t('Melde dich einmal im Terminal an, bevor du den ersten Chat startest.')}` : t('Installiert die offizielle CLI in dein Benutzerverzeichnis – ohne Administratorrechte. Bestehende Installationen werden nie ersetzt.')}
          </p>
        </div>
      </div>

      {!done && (
        <>
          <ul className="space-y-1 text-[12px]">
            {plan.checks.map((check) => (
              <li key={check.text} className="flex items-start gap-2">
                <Icon name={!check.ok ? 'lucide:circle-x' : check.warning ? 'lucide:triangle-alert' : 'lucide:circle-check'} size={13} className={cx('mt-0.5 shrink-0', !check.ok ? 'text-bad' : check.warning ? 'text-warn' : 'text-ok')} />
                <span className={cx('min-w-0 break-words', check.ok ? 'text-muted' : 'text-fg')}>{check.text}</span>
              </li>
            ))}
          </ul>
          {plan.command && (
            <div>
              <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-subtle">{t('Dieser Befehl wird ausgeführt')}</div>
              <pre className="select-text overflow-x-auto whitespace-pre-wrap break-all rounded-lumen-sm bg-bg px-3 py-2 font-mono text-[11px] text-muted">{plan.command}</pre>
            </div>
          )}
          <button className="btn btn-primary" disabled={busy || !plan.ready} onClick={handleInstall}>
            <Icon name={busy ? 'lucide:loader-circle' : 'lucide:download'} size={13} className={cx(busy && 'spin')} />
            {busy ? t('Installiere …') : t('Jetzt installieren')}
          </button>
        </>
      )}

      {busy && log.length > 0 && <pre className="max-h-28 overflow-hidden whitespace-pre-wrap rounded-lumen-sm bg-bg px-3 py-2 font-mono text-[10.5px] text-subtle">{log.join('\n')}</pre>}
      {error && <div className="rounded-lumen-sm border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad">{error}</div>}
    </section>
  );
}
