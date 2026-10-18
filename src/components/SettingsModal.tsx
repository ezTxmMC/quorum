import { useState } from 'react';
import { PROVIDERS, TERMINAL_THEMES, defaultTerminal } from '@shared/catalog';
import type { ProviderId, TerminalStyle } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Dot } from './ModelPicker';
import { OptionsPanel } from './OptionsPanel';
import { UsageView } from './UsageView';
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
        <Toggle checked={settings.autoImport} onChange={(autoImport) => setSettings({ autoImport })} label={t('Neue Sessions automatisch importieren')} hint={t('Prüft alle 60 s auf neue Claude- und Codex-Sessions und legt sie als Chats an')} />
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

function OllamaTab() {
  const st = useHub((s) => s.statuses.ollama);
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3"><Dot id="ollama" size={10} /><h2 className="flex-1 text-[16px] font-semibold">Ollama</h2>
        <span className={cx('text-[12px]', st?.installed ? 'text-ok' : 'text-bad')}>{st?.installed ? `${st.version} · ${st.models.length} ${t('Modelle')}` : t('läuft nicht')}</span>
        <button className="icon-btn" title={t('Aktualisieren')} onClick={() => void useHub.getState().refreshStatus('ollama', true)}><Icon name="lucide:refresh-cw" size={14} /></button></div>
      <p className="text-muted">{t('Lokale Modelle über die Ollama-API (Standard: http://127.0.0.1:11434, änderbar über die Umgebungsvariable OLLAMA_HOST). Reiner Chat – ohne Tools, ohne Konto, ohne Limits.')}</p>
      {!st?.installed && <div className="rounded-lumen border border-warn/30 bg-warn/10 px-3 py-2 text-warn">{t('Ollama ist nicht erreichbar. Starte es mit „ollama serve“ und lade ein Modell (ollama pull …).')}</div>}
      {st?.models.length ? (
        <div className="flex flex-wrap gap-1.5">{st.models.map((m) => <span key={m.id} className="rounded-full border border-edge px-2.5 py-0.5 text-[12px]">{m.label}</span>)}</div>
      ) : null}
      <div>
        <div className="mb-2 text-[12px] font-medium text-muted">{t('Standardwerte für neue Chats & Agenten')}</div>
        <OptionsPanel provider="ollama" value={useHub.getState().data.settings.providerDefaults.ollama} onChange={(patch) => useHub.getState().setProviderDefaults('ollama', patch)} />
      </div>
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
        {sel === 'ollama' ? <OllamaTab /> : <ProviderTab p={sel} />}
      </div>
    </div>
  );
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
      </div>
    </Modal>
  );
}
