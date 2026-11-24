import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { PROVIDERS } from '@shared/catalog';
import type { SandboxProvider, SandboxStatus } from '@shared/sandbox';
import { hub, uid } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { termOptions } from './panels/TerminalPanel';
import { Modal, Toggle, cx } from './ui';

const LOG_LINES = 6;
/** Die Einstellungen erreichen den Hauptprozess asynchron; erst danach liefert die Statusabfrage die neue Variante. */
const SETTINGS_SYNC_MS = 250;

type Busy = 'install' | 'remove' | null;

interface SandboxLoginProps {
  provider: SandboxProvider;
  onClose: () => void;
}

/** Terminal mit der isolierten CLI – für Anmeldung und Ersteinrichtung innerhalb der Sandbox. */
function SandboxLogin({ provider, onClose }: SandboxLoginProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) {
      return;
    }
    const id = uid();
    const term = new Terminal({ ...termOptions(useHub.getState().data.settings.terminal), allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
    let ready = false;
    void hub.sandboxTerminal(id, provider, term.cols || 100, term.rows || 28).then((result) => {
      ready = result.mode !== 'missing';
      if (!ready) {
        term.write(t('Die Sandbox ist nicht installiert.'));
      }
    });
    const offData = hub.onTermData((payload) => {
      if (payload.id === id) {
        term.write(payload.data);
      }
    });
    const offExit = hub.onTermExit((payload) => {
      if (payload.id === id) {
        term.write(`\r\n\x1b[2m[${t('Prozess beendet')}]\x1b[0m\r\n`);
      }
    });
    // Strg+C mit Auswahl kopiert (z. B. den Anmelde-Link), Strg+Umschalt+V fügt den Code ein.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey) {
        return true;
      }
      const key = event.key.toLowerCase();
      if (key === 'c' && (event.shiftKey || term.hasSelection())) {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      if (key === 'v' && event.shiftKey) {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => text && term.paste(text));
        return false;
      }
      return true;
    });
    term.onData((input) => {
      if (ready) {
        void hub.termWrite(id, input);
      }
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (ready) {
        void hub.termResize(id, term.cols, term.rows);
      }
    });
    observer.observe(host.current);
    term.focus();
    return () => {
      observer.disconnect();
      offData();
      offExit();
      void hub.termKill(id);
      term.dispose();
    };
  }, [provider]);

  return (
    <Modal title={`${PROVIDERS[provider].name} – ${t('in der Sandbox anmelden')}`} onClose={onClose} wide>
      <p className="mb-3 text-[12px] text-muted">
        {t('Die Sandbox hat eine eigene Anmeldung. Melde dich hier an (meist /login). Öffnet sich kein Browser, markiere den Link, kopiere ihn mit Strg+C und füge den Code mit Strg+Umschalt+V ein.')}
      </p>
      <div ref={host} className="h-[420px] overflow-hidden rounded-lumen border border-edge bg-bg p-2" />
    </Modal>
  );
}

interface SandboxCardProps {
  provider: SandboxProvider;
}

/** Isolierte Variante eines Anbieters: installieren, anmelden, umschalten und entfernen. */
export function SandboxCard({ provider }: SandboxCardProps) {
  const sandboxed = useHub((s) => s.data.settings.sandboxed);
  const [status, setStatus] = useState<SandboxStatus>();
  const [busy, setBusy] = useState<Busy>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [login, setLogin] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const active = !!sandboxed?.[provider];

  useEffect(() => {
    let alive = true;
    void hub.sandboxStatus(provider).then((next) => {
      if (alive) {
        setStatus(next);
      }
    });
    const off = hub.onSandboxProgress((progress) => {
      if (progress.provider === provider) {
        setLog((lines) => [...lines, progress.text].slice(-LOG_LINES));
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [provider]);

  function applyVariant(bin: string | undefined) {
    const { data, setSettings, refreshStatus } = useHub.getState();
    setSettings({ sandboxed: { ...data.settings.sandboxed, [provider]: bin } });
    setTimeout(() => void refreshStatus(provider, true), SETTINGS_SYNC_MS);
  }

  async function handleInstall() {
    setBusy('install');
    setError('');
    setLog([]);
    const result = await hub.sandboxInstall(provider);
    const next = await hub.sandboxStatus(provider);
    setStatus(next);
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? t('Installation fehlgeschlagen.'));
      return;
    }
    if (active) {
      applyVariant(next.bin);
    }
  }

  async function handleRemove() {
    setConfirmRemove(false);
    setBusy('remove');
    setError('');
    // Erst zurückschalten, damit kein Chat auf eine gelöschte Sandbox zeigt.
    applyVariant(undefined);
    const result = await hub.sandboxRemove(provider);
    setStatus(await hub.sandboxStatus(provider));
    setBusy(null);
    if (!result.ok) {
      setError(result.error ?? '');
    }
  }

  if (!status) {
    return null;
  }

  const pillClass = cx('rounded-full px-2.5 py-0.5 text-[11px] font-medium', active ? 'bg-ok/15 text-ok' : status.installed ? 'bg-accent/15 text-accent' : 'bg-active text-muted');
  const pillText = active ? t('aktiv') : status.installed ? (status.version ?? t('installiert')) : t('nicht installiert');

  return (
    <section className="space-y-3 rounded-lumen border border-edge bg-bg/40 p-4">
      <div className="flex items-start gap-3">
        <Icon name="lucide:shield-check" size={16} className={cx('mt-0.5 shrink-0', active ? 'text-ok' : 'text-muted')} />
        <div className="min-w-0 flex-1">
          <h4 className="text-[13px] font-semibold text-fg">{t('Sandbox-Variante')}</h4>
          <p className="mt-0.5 text-[11.5px] text-subtle">
            {t('Eigene, isolierte Installation mit eigener Anmeldung. Die CLI sieht nur den Projektordner des Chats und ihr Sandbox-Verzeichnis – dein Benutzerverzeichnis und andere Laufwerke existieren darin nicht, das System ist schreibgeschützt.')}
          </p>
        </div>
        <span className={pillClass}>{pillText}</span>
      </div>

      {!status.supported && (
        <div className="flex items-center gap-2 rounded-lumen-sm border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          <Icon name="lucide:triangle-alert" size={13} className="shrink-0" /> {t(status.reason ?? '')}
        </div>
      )}

      {status.supported && (
        <>
          {status.installed && (
            <Toggle
              checked={active}
              onChange={(on) => applyVariant(on ? status.bin : undefined)}
              label={t('Sandbox-Variante verwenden')}
              hint={t('Alle Chats, Teams und Workflows dieses Anbieters laufen dann isoliert.')}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn" disabled={!!busy} onClick={handleInstall}>
              <Icon name={busy === 'install' ? 'lucide:loader-circle' : 'lucide:download'} size={13} className={cx(busy === 'install' && 'animate-spin')} />
              {busy === 'install' ? t('Installiere …') : status.installed ? t('Update installieren') : t('In Sandbox installieren')}
            </button>
            {status.installed && (
              <button className="btn" disabled={!!busy} onClick={() => setLogin(true)}>
                <Icon name="lucide:log-in" size={13} /> {t('Anmelden')}
              </button>
            )}
            {status.installed && !confirmRemove && (
              <button className="btn" disabled={!!busy} onClick={() => setConfirmRemove(true)}>
                <Icon name="lucide:trash-2" size={13} /> {t('Entfernen')}
              </button>
            )}
            {confirmRemove && (
              <>
                <span className="text-[11.5px] text-muted">{t('Sandbox samt Anmeldung und Verlauf löschen?')}</span>
                <button className="btn !border-bad/40 !text-bad" onClick={handleRemove}>{t('Löschen')}</button>
                <button className="btn" onClick={() => setConfirmRemove(false)}>{t('Abbrechen')}</button>
              </>
            )}
          </div>
          {status.installed && <div className="truncate font-mono text-[10.5px] text-subtle" title={status.home}>{status.home}</div>}
        </>
      )}

      {log.length > 0 && busy === 'install' && (
        <pre className="max-h-28 overflow-hidden whitespace-pre-wrap rounded-lumen-sm bg-bg px-3 py-2 font-mono text-[10.5px] text-subtle">{log.join('\n')}</pre>
      )}
      {error && <div className="rounded-lumen-sm border border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad">{error}</div>}
      {login && <SandboxLogin provider={provider} onClose={() => setLogin(false)} />}
    </section>
  );
}
