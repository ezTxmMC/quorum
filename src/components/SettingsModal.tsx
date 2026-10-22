import { useEffect, useState } from 'react';
import { DEFAULT_OPTIONS, PROVIDERS, TERMINAL_THEMES, defaultTerminal } from '@shared/catalog';
import type { ProviderId, TerminalStyle, UpdateChannel } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Dot } from './ModelPicker';
import { FallbackList } from './FallbackModels';
import { OptionsPanel } from './OptionsPanel';
import { ApiProviderSettings } from './ApiProviderSettings';
import { OllamaProviderSettings } from './OllamaProviderSettings';
import { LocalProviderSettings } from './LocalProviderSettings';
import { UsageView } from './UsageView';
import { Markdown } from './Markdown';
import { termBackground } from './panels/TerminalPanel';
import { Label, Modal, Select, Toggle, cx } from './ui';

const ACCENTS = ['#7c8cff', '#d97757', '#10a37f', '#4c8bf5', '#e879f9', '#f59e0b', '#22d3ee'];

/** Electron-Accelerator aus einem Tastendruck bauen. */
function accelerator(e: React.KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const mods = [e.ctrlKey || e.metaKey ? 'CommandOrControl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
  if (!mods.length) return null;
  let k = e.code;
  if (k.startsWith('Key')) k = k.slice(3); else if (k.startsWith('Digit')) k = k.slice(5);
  else if (k.startsWith('Arrow')) k = k.slice(5);
  else if (k === 'Backquote') k = '`';
  return [...mods, k].join('+');
}

function HotkeyField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [rec, setRec] = useState(false);
  return (
    <div className="flex gap-2">
      <button className={cx('field text-left font-mono text-[12.5px]', rec && '!border-accent')} onClick={() => setRec(true)} onBlur={() => setRec(false)}
        onKeyDown={(e) => { if (!rec) return; e.preventDefault(); if (e.key === 'Escape') { setRec(false); return; } const a = accelerator(e); if (a) { onChange(a); setRec(false); } }}>
        {rec ? t('Tastenkombination drücken …') : value || t('Kein Hotkey')}
      </button>
      {value && <button className="btn" onClick={() => onChange('')} title={t('Entfernen')}><Icon name="lucide:x" size={14} /></button>}
    </div>
  );
}

const TABS = [
  { id: 'general', icon: 'lucide:sliders-horizontal', label: 'Allgemein' },
  { id: 'providers', icon: 'lucide:plug', label: 'Anbieter' },
  { id: 'terminal', icon: 'lucide:square-terminal', label: 'Terminal' },
  { id: 'usage', icon: 'lucide:chart-no-axes-column', label: 'Nutzung' },
  { id: 'updates', icon: 'lucide:sparkles', label: 'Updates' },
];

function General() {
  const settings = useHub((s) => s.data.settings);
  const hidden = useHub((s) => s.data.hidden);
  const { setSettings, restoreProject } = useHub.getState();
  return (
    <div className="space-y-7">
      <h2 className="text-[16px] font-semibold">{t('Allgemein')}</h2>
      <section className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div><Label>{t('Theme')}</Label><Select value={settings.theme} onChange={(theme) => setSettings({ theme })} options={[{ value: 'dark', label: t('Dunkel') }, { value: 'light', label: t('Hell') }]} /></div>
          <div><Label>{t('Sprache')}</Label><Select value={settings.language} onChange={(language) => setSettings({ language })} options={[{ value: 'de', label: 'Deutsch' }, { value: 'en', label: 'English' }]} /></div>
          <div><Label>{t('Standard-Anbieter')}</Label><Select value={settings.defaultProvider} onChange={(defaultProvider) => setSettings({ defaultProvider })} options={(Object.keys(PROVIDERS) as ProviderId[]).map((p) => ({ value: p, label: PROVIDERS[p].name }))} /></div>
        </div>
        <div>
          <Label>{t('Akzentfarbe')}</Label>
          <div className="flex gap-2">{ACCENTS.map((c) => <button key={c} onClick={() => setSettings({ accent: c })} className={cx('size-7 rounded-full border-2 transition-transform hover:scale-110', settings.accent === c ? 'border-fg' : 'border-transparent')} style={{ background: c }} />)}</div>
        </div>
      </section>
      <section className="space-y-2">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Fenster & Schnellzugriff')}</h3>
        <Toggle checked={settings.sidebarPinned} onChange={(sidebarPinned) => setSettings({ sidebarPinned })} label={t('Seitenleiste angeheftet')} hint={t('Aus: Die Seitenleiste erscheint nur beim Überfahren des Icons in der Titelleiste')} />
        <div>
          <Label hint={t('Öffnet das Schnell-Prompt-Fenster (Tray). Unter Wayland evtl. nicht verfügbar.')}>{t('Hotkey Schnell-Prompt')}</Label>
          <HotkeyField value={settings.quickHotkey} onChange={(quickHotkey) => setSettings({ quickHotkey })} />
        </div>
        <Toggle checked={settings.showUsageInComposer !== false} onChange={(showUsageInComposer) => setSettings({ showUsageInComposer })} label={t('Nutzung in der Chatbox anzeigen')} />
        <Toggle checked={!!settings.showOlderModels} onChange={(showOlderModels) => setSettings({ showOlderModels })} label={t('Ältere Modelle standardmäßig anzeigen')} hint={t('Zeigt zusätzlich von der CLI gelistete ältere und eigene Modelle')} />
        <div><Label>{t('Standard-Projektordner')}</Label><div className="flex gap-2"><input className="field" value={settings.defaultCwd} onChange={(e) => setSettings({ defaultCwd: e.target.value })} /><button className="btn" onClick={async () => { const d = await hub.pickFolder(); if (d) setSettings({ defaultCwd: d }); }}><Icon name="lucide:folder-open" /></button></div></div>
        <Toggle checked={settings.autoImport} onChange={(autoImport) => setSettings({ autoImport })} label={t('Neue Sessions automatisch importieren')} hint={t('Prüft alle 60 s auf neue Claude- und Codex-Sessions und legt sie als Chats an')} />
      </section>
      <section className="space-y-2">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Ausweich-Modelle (global)')}</h3>
        <p className="text-[12px] text-subtle">{t('Gelten für alle Chats ohne eigene Liste. Ist das Nutzungslimit erreicht (oder das Prozent-Limit eines Chats), wird der Reihe nach das nächste Modell verwendet. Pro Chat lässt sich die Liste in der Chatbox überschreiben.')}</p>
        <div className="rounded-lumen border border-edge p-1"><FallbackList value={settings.fallbacks ?? []} onChange={(fallbacks) => setSettings({ fallbacks })} /></div>
      </section>
      {hidden.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[12px] font-medium uppercase tracking-wide text-subtle">{t('Ausgeblendete Projekte')}</h3>
          {hidden.map((h) => (
            <div key={h} className="flex items-center gap-3 rounded-lumen border border-edge px-3 py-2">
              <Icon name="lucide:folder" className="text-muted" /><span className="min-w-0 flex-1 truncate font-mono text-[12px]">{h || t('Ohne Projekt')}</span>
              <button className="btn" onClick={() => restoreProject(h)}><Icon name="lucide:rotate-ccw" size={14} /> {t('Wiederherstellen')}</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function ProviderTab({ p }: { p: ProviderId }) {
  const settings = useHub((s) => s.data.settings);
  const st = useHub((s) => s.statuses[p]);
  const { setSettings, setProviderDefaults, refreshStatus } = useHub.getState();
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><Dot id={p} size={10} /><h2 className="flex-1 text-[16px] font-semibold">{PROVIDERS[p].name}</h2>
        <span className={cx('text-[12px]', st?.installed ? 'text-ok' : 'text-bad')}>{st?.installed ? st.version : t('nicht gefunden')}</span></div>
      <div>
        <Label hint={t('leer = automatisch aus PATH')}>{t('Pfad zur CLI')} ({PROVIDERS[p].bin})</Label>
        <div className="flex gap-2">
          <input className="field font-mono text-[12px]" placeholder={st?.path ?? PROVIDERS[p].bin} value={settings.binaries[p] ?? ''} onChange={(e) => setSettings({ binaries: { ...settings.binaries, [p]: e.target.value || undefined } })} />
          <button className="btn" onClick={async () => { const [f] = await hub.pickFiles('any'); if (f) setSettings({ binaries: { ...settings.binaries, [p]: f } }); }}><Icon name="lucide:file-search" /></button>
          <button className="btn" onClick={() => setTimeout(() => void refreshStatus(p, true), 200)}><Icon name="lucide:refresh-cw" /></button>
        </div>
      </div>
      <div>
        <div className="mb-2 text-[12px] font-medium text-muted">{t('Standardwerte für neue Chats & Agenten')}</div>
        <OptionsPanel provider={p} value={settings.providerDefaults[p]} onChange={(patch) => setProviderDefaults(p, patch)} />
      </div>
    </div>
  );
}

/** Alle Anbieter-Einstellungen an einem Ort: Auswahl oben, darunter Status, Pfad/Konto/Host und Standardwerte des gewählten Anbieters. */
function ProvidersTab() {
  const statuses = useHub((s) => s.statuses);
  const [sel, setSel] = useState<ProviderId>('claude');
  const ids = Object.keys(PROVIDERS) as ProviderId[];
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[16px] font-semibold">{t('Anbieter')}</h2>
        <p className="text-muted">{t('Installation, Anmeldung, Pfade und Standardwerte aller Anbieter. Nicht verfügbare Anbieter erscheinen in Chats und Teams nicht zur Auswahl.')}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {ids.map((p) => {
          const st = statuses[p];
          return (
            <button key={p} onClick={() => setSel(p)} className={cx('flex items-center gap-2.5 rounded-lumen-lg border px-3 py-2.5 text-left transition-colors', sel === p ? 'border-accent bg-hover' : 'border-edge hover:bg-hover')}>
              <Dot id={p} size={9} />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{PROVIDERS[p].name}</span><span className="block truncate text-[11px] text-subtle">{PROVIDERS[p].vendor}</span></span>
              <span className={cx('size-2 shrink-0 rounded-full', st === undefined ? 'bg-subtle' : st.installed ? 'bg-ok' : 'bg-bad')} title={st?.installed ? t('verfügbar') : t('nicht verfügbar')} />
            </button>
          );
        })}
      </div>
      <div key={sel} className="fade-in rounded-lumen-lg border border-edge p-5">
        {sel === 'api' ? <ApiProviderSettings /> : sel === 'local' ? <LocalProviderSettings onApi={() => setSel('api')} /> : sel === 'ollama' ? <OllamaProviderSettings /> : <ProviderTab p={sel} />}
        <ProviderCatalog p={sel} />
      </div>
    </div>
  );
}

function ProviderCatalog({ p }: { p: ProviderId }) {
  const settings = useHub((s) => s.data.settings);
  const status = useHub((s) => s.statuses[p]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState((settings.customModels?.[p] ?? []).join('\n'));
  useEffect(() => { setDraft((settings.customModels?.[p] ?? []).join('\n')); }, [p, settings.customModels]);
  const refresh = async () => { setBusy(true); setError(''); try { await useHub.getState().refreshStatus(p, true); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <section className="mt-6 space-y-3 border-t border-edge pt-5">
    <div className="flex items-center justify-between"><Label>{t('Modellkatalog')}</Label><button className="btn" disabled={busy} onClick={() => void refresh()}><Icon name="lucide:refresh-cw" size={13} />{t('Aktualisieren')}</button></div>
    <div className="max-h-44 overflow-auto rounded-lumen border border-edge">
      {status?.models.map((m) => <div key={m.id} className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2 last:border-0"><span className="min-w-0"><span className="block text-[12px]">{m.label}</span><span className="block truncate font-mono text-[10px] text-subtle">{m.id}</span></span><span className="text-[10px] text-subtle">{m.efforts?.join(' · ')}</span></div>)}
      {!status?.models.length && <p className="p-3 text-muted">{t('Keine Modelle verfügbar')}</p>}
    </div>
    {error && <p className="text-bad">{error}</p>}
    {!['local', 'ollama', 'api'].includes(p) && <>
      <Label hint={t('Eine Modell-ID pro Zeile')}>{t('Eigene / ältere Modell-IDs')}</Label>
      <textarea className="field min-h-20 resize-y font-mono text-[12px]" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <p className="text-[11px] text-subtle">{t('Nur IDs eintragen, auf die dein Konto Zugriff hat. Diese Einträge sind manuell konfiguriert; die Verfügbarkeit wird nicht geprüft.')}</p>
      <button className="btn" onClick={() => useHub.getState().setSettings({ customModels: { ...settings.customModels, [p]: [...new Set(draft.split('\n').map((id) => id.trim()).filter(Boolean))] } })}>{t('Speichern')}</button>
    </>}
    <button className="btn btn-ghost text-muted" onClick={() => useHub.getState().setSettings({ providerDefaults: { ...settings.providerDefaults, [p]: { ...DEFAULT_OPTIONS[p] } } })}><Icon name="lucide:rotate-ccw" size={13} />{t('Anbieter-Standardwerte zurücksetzen')}</button>
  </section>;
}

const FONTS = [
  { value: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace", label: 'JetBrains Mono' },
  { value: "'Fira Code', ui-monospace, monospace", label: 'Fira Code' },
  { value: "'Cascadia Code', ui-monospace, monospace", label: 'Cascadia Code' },
  { value: "'Source Code Pro', ui-monospace, monospace", label: 'Source Code Pro' },
  { value: "'Hack', ui-monospace, monospace", label: 'Hack' },
  { value: "'DejaVu Sans Mono', ui-monospace, monospace", label: 'DejaVu Sans Mono' },
  { value: "'Menlo', 'Consolas', ui-monospace, monospace", label: 'Menlo / Consolas' },
  { value: 'ui-monospace, monospace', label: 'System' },
];

/** Darstellung aller Terminals – Änderungen gelten sofort für offene Terminals. */
function TerminalTab() {
  const st = useHub((s) => s.data.settings.terminal);
  const set = (patch: Partial<TerminalStyle>) => useHub.getState().setSettings({ terminal: { ...st, ...patch } });
  const colors = TERMINAL_THEMES[st.theme]?.colors;
  const sw = (c: string) => <span className="size-2.5 rounded-full" style={{ background: c }} />;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><h2 className="flex-1 text-[16px] font-semibold">{t('Terminal')}</h2>
        <button className="btn btn-ghost text-muted" onClick={() => useHub.getState().setSettings({ terminal: defaultTerminal() })}><Icon name="lucide:rotate-ccw" size={13} /> {t('Zurücksetzen')}</button></div>

      <div className="overflow-hidden rounded-lumen-lg border border-edge p-3" style={{ background: termBackground(st), color: colors?.foreground ?? 'var(--c-text)', fontFamily: st.fontFamily, fontSize: st.fontSize, lineHeight: st.lineHeight }}>
        <div><span style={{ color: colors?.green ?? 'var(--c-accent)' }}>user@quorum</span>:<span style={{ color: colors?.blue ?? 'var(--c-accent)' }}>~/projekt</span>$ git status</div>
        <div><span style={{ color: colors?.red }}>modified:</span>   src/App.tsx</div>
        <div><span style={{ color: colors?.yellow }}>warning:</span> 2 files changed<span className={cx('ml-0.5 inline-block align-middle', st.cursorBlink && 'animate-pulse')} style={{ background: colors?.cursor ?? 'var(--c-accent)', width: st.cursorStyle === 'block' ? '0.6em' : st.cursorStyle === 'bar' ? 2 : '0.6em', height: st.cursorStyle === 'underline' ? 2 : '1.1em' }} /></div>
        {colors && <div className="mt-2 flex gap-1">{[colors.red, colors.green, colors.yellow, colors.blue, colors.magenta, colors.cyan].map((c) => <span key={c}>{sw(c)}</span>)}</div>}
      </div>

      <div>
        <Label>{t('Farbschema')}</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[{ id: 'app', label: t('App (Theme & Akzent)'), bg: 'var(--c-bg-elevated)', fg: 'var(--c-text)' }, ...Object.entries(TERMINAL_THEMES).map(([id, x]) => ({ id, label: x.label, bg: x.colors.background, fg: x.colors.foreground }))].map((x) => (
            <button key={x.id} onClick={() => set({ theme: x.id })} className={cx('rounded-lumen border px-2.5 py-2 text-left font-mono text-[11.5px] transition-[border-color,transform] hover:scale-[1.02]', st.theme === x.id ? 'border-accent ring-1 ring-accent' : 'border-edge')} style={{ background: x.bg, color: x.fg }}>{x.label}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div><Label>{t('Schriftart')}</Label><Select value={FONTS.some((f) => f.value === st.fontFamily) ? st.fontFamily : FONTS[0].value} onChange={(fontFamily) => set({ fontFamily })} options={FONTS} /></div>
        <div><Label>{t('Cursor')}</Label><Select value={st.cursorStyle} onChange={(cursorStyle) => set({ cursorStyle })} options={[{ value: 'block', label: t('Block') }, { value: 'bar', label: t('Strich') }, { value: 'underline', label: t('Unterstrich') }]} /></div>
        <div><Label hint={`${st.fontSize}px`}>{t('Schriftgröße')}</Label><input type="range" min={9} max={22} step={0.5} value={st.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} className="w-full accent-[var(--c-accent)]" /></div>
        <div><Label hint={st.lineHeight.toFixed(2)}>{t('Zeilenhöhe')}</Label><input type="range" min={1} max={1.8} step={0.05} value={st.lineHeight} onChange={(e) => set({ lineHeight: Number(e.target.value) })} className="w-full accent-[var(--c-accent)]" /></div>
        <div><Label hint={t('Zeilen')}>{t('Verlauf (Scrollback)')}</Label><Select value={String(st.scrollback)} onChange={(v) => set({ scrollback: Number(v) })} options={['1000', '5000', '10000', '50000'].map((v) => ({ value: v, label: Number(v).toLocaleString() }))} /></div>
      </div>
      <Toggle checked={st.cursorBlink} onChange={(cursorBlink) => set({ cursorBlink })} label={t('Blinkender Cursor')} />
    </div>
  );
}

function UpdatesTab() {
  const settings = useHub((s) => s.data.settings);
  const { setSettings, checkUpdate, downloadUpdate, installUpdate } = useHub.getState();
  const updaterState = useHub((s) => s.updaterState);
  const [checking, setChecking] = useState(false);

  const handleCheck = async () => {
    setChecking(true);
    try {
      await checkUpdate(settings.updateChannel);
    } finally {
      setChecking(false);
    }
  };

  const channelOptions = [
    { value: 'release', label: `${t('Release')} (${t('Stabil')})` },
    { value: 'beta', label: `${t('Beta')} (${t('Vorabversionen')})` },
    { value: 'dev', label: `${t('Dev')} (${t('Bleeding Edge - Jeder Commit')})` },
  ];

  const info = updaterState.updateInfo;
  const progress = updaterState.progress;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[16px] font-semibold">{t('Software-Updates')}</h2>
          <p className="text-[12.5px] text-muted">
            {t('Verwalte Aktualisierungen über GitHub Releases und automatische Update-Kanäle.')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-edge bg-surface px-2.5 py-1 font-mono text-[11.5px] text-muted">
            v{updaterState.currentVersion}
          </span>
          <span className={cx(
            'rounded-full px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
            settings.updateChannel === 'release' ? 'bg-ok/15 text-ok' : settings.updateChannel === 'beta' ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn'
          )}>
            {settings.updateChannel}
          </span>
        </div>
      </div>

      <section className="space-y-4 rounded-lumen border border-edge bg-surface/50 p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label hint={t('Bestimmt, welche Releases bezogen werden')}>
              {t('Release-Kanal')}
            </Label>
            <Select
              value={settings.updateChannel}
              onChange={(updateChannel) => {
                setSettings({ updateChannel: updateChannel as UpdateChannel });
                void checkUpdate(updateChannel as UpdateChannel);
              }}
              options={channelOptions}
            />
          </div>
          <div className="flex items-end">
            <button
              className="btn btn-primary h-9 w-full justify-center gap-2"
              disabled={checking || updaterState.status === 'downloading'}
              onClick={handleCheck}
            >
              <Icon name={checking ? 'lucide:loader-2' : 'lucide:refresh-cw'} className={cx(checking && 'animate-spin')} size={15} />
              {checking ? t('Suche nach Updates …') : t('Nach Updates suchen')}
            </button>
          </div>
        </div>

        <Toggle
          checked={settings.autoCheckUpdate}
          onChange={(autoCheckUpdate) => setSettings({ autoCheckUpdate })}
          label={t('Automatisch nach Updates suchen')}
          hint={t('Prüft beim Starten der App im Hintergrund und meldet verfügbare Aktualisierungen')}
        />
      </section>

      {/* Status-Bereiche */}
      {updaterState.status === 'checking' && (
        <div className="flex items-center gap-3 rounded-lumen border border-edge bg-surface p-4">
          <Icon name="lucide:loader-2" className="animate-spin text-accent" size={20} />
          <div>
            <div className="font-medium">{t('Prüfe auf GitHub Releases …')}</div>
            <div className="text-[12px] text-muted">github.com/ezTxmMC/quorum</div>
          </div>
        </div>
      )}

      {updaterState.status === 'up-to-date' && (
        <div className="flex items-center gap-3 rounded-lumen border border-ok/30 bg-ok/5 p-4 text-fg">
          <Icon name="lucide:check-circle-2" className="text-ok" size={22} />
          <div className="flex-1">
            <div className="font-medium text-ok">{t('Quorum ist auf dem neuesten Stand')}</div>
            <div className="text-[12px] text-muted">
              {t('Installierte Version')}: <span className="font-mono">v{updaterState.currentVersion}</span> ({settings.updateChannel}-Kanal)
            </div>
          </div>
          <span className="text-[11px] text-subtle">{t('Gerade geprüft')}</span>
        </div>
      )}

      {updaterState.status === 'error' && (
        <div className="flex items-start gap-3 rounded-lumen border border-bad/30 bg-bad/10 p-4">
          <Icon name="lucide:alert-circle" className="text-bad shrink-0 mt-0.5" size={18} />
          <div className="flex-1">
            <div className="font-medium text-bad">{t('Update-Fehler')}</div>
            <div className="text-[12px] text-muted mt-0.5">{updaterState.error}</div>
          </div>
          <button className="btn btn-ghost !px-2.5 !py-1 text-[12px]" onClick={handleCheck}>
            {t('Erneut versuchen')}
          </button>
        </div>
      )}

      {updaterState.status === 'available' && info && (
        <div className="space-y-4 rounded-lumen border border-accent/40 bg-accent/5 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex size-2 rounded-full bg-accent animate-pulse" />
                <h3 className="text-[15px] font-semibold">{t('Neue Version verfügbar')}: {info.name}</h3>
              </div>
              <div className="mt-1 flex items-center gap-3 font-mono text-[12px] text-subtle">
                <span>Tag: {info.tag}</span>
                {info.asset && <span>Größe: {(info.asset.size / 1024 / 1024).toFixed(1)} MB</span>}
                <span>{new Date(info.publishedAt).toLocaleDateString()}</span>
              </div>
            </div>
            <button
              className="btn btn-primary gap-2"
              onClick={() => void downloadUpdate()}
            >
              <Icon name="lucide:download" size={15} />
              {t('Update herunterladen')}
            </button>
          </div>

          {info.notes && (
            <div className="mt-3 max-h-48 overflow-y-auto rounded-lumen-sm border border-edge bg-bg p-3 text-[12.5px] leading-relaxed">
              <div className="text-[11px] font-medium uppercase tracking-wide text-subtle mb-1">{t('Änderungen')}</div>
              <Markdown text={info.notes} />
            </div>
          )}
        </div>
      )}

      {updaterState.status === 'downloading' && (
        <div className="space-y-3 rounded-lumen border border-accent/40 bg-accent/5 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium">
              <Icon name="lucide:loader-2" className="animate-spin text-accent" size={16} />
              {t('Update wird heruntergeladen …')}
            </div>
            <span className="font-mono text-[13px] font-semibold text-accent">
              {progress?.percent ?? 0}%
            </span>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
            <div
              className="h-full bg-accent transition-all duration-300 ease-out"
              style={{ width: `${progress?.percent ?? 0}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-[11.5px] text-subtle font-mono">
            <span>
              {progress ? `${(progress.transferred / 1024 / 1024).toFixed(1)} MB / ${(progress.total / 1024 / 1024).toFixed(1)} MB` : ''}
            </span>
            <span>
              {progress?.bytesPerSecond ? `${(progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : ''}
            </span>
          </div>
        </div>
      )}

      {updaterState.status === 'downloaded' && (
        <div className="flex items-start justify-between gap-4 rounded-lumen border border-ok/40 bg-ok/10 p-4">
          <div className="flex items-start gap-3">
            <Icon name="lucide:check-circle" className="text-ok shrink-0 mt-0.5" size={20} />
            <div>
              <div className="font-semibold text-ok">{t('Update bereit zur Installation')}</div>
              <p className="mt-0.5 text-[12px] text-muted">
                {t('Das Update wurde vollständig geladen. Beim Klick auf „Jetzt neu starten“ wird Quorum aktualisiert und automatisch neu gestartet.')}
              </p>
            </div>
          </div>
          <button
            className="btn btn-primary gap-2 shrink-0 !bg-ok !text-black hover:!bg-ok/90"
            onClick={() => void installUpdate()}
          >
            <Icon name="lucide:rotate-cw" size={15} />
            {t('Jetzt neu starten')}
          </button>
        </div>
      )}

      <div className="rounded-lumen border border-edge bg-surface/30 p-3 text-[12px] text-subtle space-y-1">
        <div className="font-medium text-muted">{t('Über die Release-Kanäle')}:</div>
        <div>• <span className="text-fg font-medium">dev</span>: {t('Jeder erfolgreiche Commit erzeugt eine Vorabversion (1.0.0-dev.<8 Zeichen>)')}</div>
        <div>• <span className="text-fg font-medium">beta</span>: {t('Vorabversionen mit Tag 1.0.0-beta.<Nummer> für frühe Tester')}</div>
        <div>• <span className="text-fg font-medium">release</span>: {t('Stabile Hauptversionen mit Tag 1.0.0-release.<Nummer>')}</div>
      </div>
    </div>
  );
}

/** Einstellungen als Popup im Stil der Claude-App: links Kategorien, rechts Inhalt. */
export function SettingsModal() {
  const tab = useHub((s) => s.settingsTab);
  const { closeSettings, openSettings } = useHub.getState();
  if (!tab) return null;
  return (
    <Modal xl bare title={t('Einstellungen')} onClose={closeSettings}>
      <nav className="w-52 shrink-0 space-y-0.5 border-r border-edge bg-surface p-3">
        <div className="px-2.5 pb-2 pt-1 text-[13px] font-semibold">{t('Einstellungen')}</div>
        {TABS.map((x) => (
          <button key={x.id} onClick={() => openSettings(x.id)} className={cx('flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-left transition-colors', tab === x.id ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg')}>
            <Icon name={x.icon} size={16} /> {t(x.label)}
          </button>
        ))}
      </nav>
      <div key={tab} className="fade-in min-w-0 flex-1 overflow-y-auto p-6">
        {tab === 'general' && <General />}
        {tab === 'providers' && <ProvidersTab />}
        {tab === 'terminal' && <TerminalTab />}
        {tab === 'usage' && <UsageView />}
        {tab === 'updates' && <UpdatesTab />}
      </div>
    </Modal>
  );
}
