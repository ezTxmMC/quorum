import { isSandboxProvider } from '@shared/sandbox';
import { HostInstallCard } from './ProviderInstall';
import { SandboxCard } from './ProviderSandbox';
import { useEffect, useState } from 'react';
import { DEFAULT_OPTIONS, PROVIDERS, PROVIDER_ORDER, TERMINAL_THEMES, defaultTerminal, withTerminalFontFallbacks } from '@shared/catalog';
import type { ProviderId, TerminalStyle, UpdateChannel } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { ApiProviderSettings } from './ApiProviderSettings';
import { FallbackList } from './FallbackModels';
import { LocalProviderSettings } from './LocalProviderSettings';
import { Markdown } from './Markdown';
import { Dot } from './ModelPicker';
import { OllamaProviderSettings } from './OllamaProviderSettings';
import { OptionsPanel } from './OptionsPanel';
import { termBackground } from './panels/TerminalPanel';
import { Label, Modal, Select, Toggle, cx } from './ui';
import { UsageView } from './UsageView';

const ACCENTS = ['#7c8cff', '#d97757', '#10a37f', '#4c8bf5', '#e879f9', '#f59e0b', '#22d3ee'];

const FONTS = [
  { value: "'JetBrainsMono Nerd Font Mono', 'JetBrains Mono', 'FiraCode Nerd Font Mono', 'Fira Code', ui-monospace, monospace", label: 'JetBrainsMono Nerd Font' },
  { value: "'FiraCode Nerd Font Mono', 'Fira Code', ui-monospace, monospace", label: 'FiraCode Nerd Font' },
  { value: "'CaskaydiaMono Nerd Font Mono', 'CaskaydiaCove Nerd Font Mono', 'Cascadia Code', ui-monospace, monospace", label: 'Caskaydia Nerd Font' },
  { value: "'MesloLGS Nerd Font Mono', 'MesloLGS NF', ui-monospace, monospace", label: 'MesloLGS Nerd Font' },
  { value: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace", label: 'JetBrains Mono' },
  { value: "'Fira Code', ui-monospace, monospace", label: 'Fira Code' },
  { value: "'Cascadia Code', ui-monospace, monospace", label: 'Cascadia Code' },
  { value: "'Source Code Pro', ui-monospace, monospace", label: 'Source Code Pro' },
  { value: "'Hack', ui-monospace, monospace", label: 'Hack' },
  { value: "'DejaVu Sans Mono', ui-monospace, monospace", label: 'DejaVu Sans Mono' },
  { value: "'Menlo', 'Consolas', ui-monospace, monospace", label: 'Menlo / Consolas' },
  { value: 'ui-monospace, monospace', label: 'System' },
];

const TABS = [
  { id: 'general', icon: 'lucide:sliders-horizontal', label: 'Allgemein' },
  { id: 'chat', icon: 'lucide:message-circle', label: 'Chat' },
  { id: 'providers', icon: 'lucide:plug', label: 'Anbieter' },
  { id: 'terminal', icon: 'lucide:square-terminal', label: 'Terminal' },
  { id: 'usage', icon: 'lucide:chart-no-axes-column', label: 'Nutzung' },
  { id: 'updates', icon: 'lucide:sparkles', label: 'Updates' },
] as const;

const SHORTCUTS = [
  { keys: 'Strg+B', label: 'Seitenleiste ein-/ausblenden' },
  { keys: 'Strg+`', label: 'Terminal des Chats' },
  { keys: 'Strg+N', label: 'Neues Fenster' },
  { keys: 'Strg+P', label: 'Datei öffnen (Plan & IDE)' },
  { keys: 'Strg+Umschalt+F', label: 'Im Workspace suchen (Plan & IDE)' },
  { keys: 'Strg+S', label: 'Datei speichern (Editor)' },
  { keys: 'Strg+Enter', label: 'Team starten' },
  { keys: '↑ / ↓', label: 'Frühere Eingaben in der Chatbox' },
  { keys: 'Esc', label: 'Dialog, Menü oder Vollbild schließen' },
];

/** Suchindex der Einstellungen: Begriffe je Karte, damit die Suche direkt zur richtigen Stelle springt. */
const SETTINGS_INDEX: { tab: string; card?: string; title: string; keywords: string }[] = [
  { tab: 'general', card: 'appearance', title: 'Darstellung', keywords: 'theme dunkel hell sprache language akzentfarbe farbe design' },
  { tab: 'general', card: 'workspace', title: 'Workspace', keywords: 'projektordner ordner hotkey schnell-prompt tray seitenleiste sidebar anheften' },
  { tab: 'general', card: 'shortcuts', title: 'Tastenkürzel', keywords: 'shortcuts tasten kürzel keyboard strg' },
  { tab: 'general', card: 'hidden-projects', title: 'Ausgeblendete Projekte', keywords: 'projekte wiederherstellen ausgeblendet' },
  { tab: 'chat', card: 'new-chats', title: 'Neue Chats', keywords: 'standard-anbieter letzte auswahl modell modus nutzung chatbox ältere modelle' },
  { tab: 'chat', card: 'compaction', title: 'Kompaktieren', keywords: 'compact zusammenfassen verlauf kontext token automatisch' },
  { tab: 'chat', card: 'fallbacks', title: 'Ausweich-Modelle für alle Chats', keywords: 'fallback limit kontingent wechseln' },
  { tab: 'chat', card: 'import', title: 'Import', keywords: 'sessions importieren claude codex automatisch' },
  { tab: 'providers', title: 'Anbieter', keywords: 'cli pfad api ollama lokal sandbox isoliert anmelden modellkatalog standardwerte berechtigungen' },
  { tab: 'terminal', card: 'shell', title: 'Shell', keywords: 'bash zsh fish shell pfad' },
  { tab: 'terminal', card: 'terminal-theme', title: 'Farbschema', keywords: 'terminal farben theme' },
  { tab: 'terminal', card: 'terminal-font', title: 'Schrift & Verhalten', keywords: 'schriftart font cursor schriftgröße zeilenhöhe scrollback nerd' },
  { tab: 'usage', title: 'Nutzung', keywords: 'token kosten verbrauch limits statistik' },
  { tab: 'updates', title: 'Software-Updates', keywords: 'update version kanal release beta dev' },
];

/** Springt zur Karte und hebt sie kurz hervor; der Tab wird erst gerendert, deshalb einen Frame warten. */
function revealCard(card: string | undefined) {
  if (!card) {
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const element = document.querySelector<HTMLElement>(`[data-settings-card="${card}"]`);
    if (!element) {
      return;
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('settings-card-found');
    setTimeout(() => element.classList.remove('settings-card-found'), 1600);
  }));
}

function accelerator(event: React.KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
    return null;
  }
  const mods = [
    event.ctrlKey || event.metaKey ? 'CommandOrControl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
  ].filter(Boolean);
  if (!mods.length) {
    return null;
  }
  let key = event.code;
  if (key.startsWith('Key')) {
    key = key.slice(3);
  } else if (key.startsWith('Digit')) {
    key = key.slice(5);
  } else if (key.startsWith('Arrow')) {
    key = key.slice(5);
  } else if (key === 'Backquote') {
    key = '`';
  }
  return [...mods, key].join('+');
}

function HotkeyField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [recording, setRecording] = useState(false);
  return (
    <div className="flex gap-2">
      <button
        className={cx('field text-left font-mono text-[12px]', recording && '!border-accent')}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(event) => {
          if (!recording) {
            return;
          }
          event.preventDefault();
          if (event.key === 'Escape') {
            setRecording(false);
            return;
          }
          const next = accelerator(event);
          if (next) {
            onChange(next);
            setRecording(false);
          }
        }}
      >
        {recording ? t('Tastenkombination drücken …') : value || t('Kein Hotkey')}
      </button>
      {value && (
        <button className="btn" onClick={() => onChange('')} title={t('Entfernen')}>
          <Icon name="lucide:x" size={14} />
        </button>
      )}
    </div>
  );
}

const CARD_STATE_KEY = 'quorum.settings.cards';

function readCardState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CARD_STATE_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

interface SettingsCardProps {
  /** Anker für die Suche und Schlüssel, unter dem der Auf-/Zu-Zustand gemerkt wird. */
  id?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Einklappbar; zugeklappt zeigt die Kopfzeile `summary` als Kurzstand. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  summary?: string;
  children: React.ReactNode;
}

function SettingsCard({ id, title, description, action, collapsible, defaultOpen = true, summary, children }: SettingsCardProps) {
  const [open, setOpen] = useState(() => (id ? readCardState()[id] : undefined) ?? defaultOpen);
  const shown = !collapsible || open;

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (id) {
      try {
        localStorage.setItem(CARD_STATE_KEY, JSON.stringify({ ...readCardState(), [id]: next }));
      } catch { /* Speicher nicht verfügbar: der Zustand gilt dann nur für diese Sitzung */ }
    }
  }

  const heading = (
    <div className="min-w-0 flex-1">
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {description && shown && <p className="mt-0.5 text-[11.5px] text-subtle">{description}</p>}
    </div>
  );

  return (
    <section data-settings-card={id} className="settings-card rounded-lumen-lg border border-edge bg-surface/55">
      {collapsible ? (
        <button type="button" aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={handleToggle}>
          {heading}
          {!open && summary && <span className="shrink-0 truncate text-[11.5px] text-subtle">{summary}</span>}
          <Icon name="lucide:chevron-down" size={14} className={cx('shrink-0 text-subtle transition-transform duration-200', !open && '-rotate-90')} />
        </button>
      ) : (
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          {heading}
          {action}
        </div>
      )}
      {/* Kein animiertes Einklappen: dessen Beschnitt würde Auswahlmenüs innerhalb der Karte abschneiden. */}
      {shown && <div className={cx('fade-in space-y-4 px-4 pb-4', collapsible ? 'pt-1' : 'pt-4')}>{children}</div>}
    </section>
  );
}

function GeneralTab() {
  const settings = useHub((s) => s.data.settings);
  const hidden = useHub((s) => s.data.hidden);
  const { setSettings, restoreProject } = useHub.getState();

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight">{t('Allgemein')}</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">{t('Darstellung, Sprache, Workspace und Tastenkürzel.')}</p>
      </div>

      <SettingsCard id="appearance" title={t('Darstellung')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label>{t('Theme')}</Label>
            <div className="grid grid-cols-2 rounded-lumen-sm border border-edge bg-bg/60 p-0.5 text-[12px]">
              {(['dark', 'light'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setSettings({ theme: mode })}
                  className={cx(
                    'flex items-center justify-center gap-1.5 rounded-[5px] py-1.5 font-medium transition-colors',
                    settings.theme === mode ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted',
                  )}
                >
                  <Icon name={mode === 'dark' ? 'lucide:moon' : 'lucide:sun'} size={13} />
                  <span>{mode === 'dark' ? t('Dunkel') : t('Hell')}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label>{t('Sprache')}</Label>
            <div className="grid grid-cols-2 rounded-lumen-sm border border-edge bg-bg/60 p-0.5 text-[12px]">
              {([{ id: 'de', label: 'Deutsch' }, { id: 'en', label: 'English' }] as const).map((lang) => (
                <button
                  key={lang.id}
                  onClick={() => setSettings({ language: lang.id })}
                  className={cx(
                    'rounded-[5px] py-1.5 font-medium transition-colors',
                    settings.language === lang.id ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted',
                  )}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <Label>{t('Akzentfarbe')}</Label>
          <div className="flex flex-wrap gap-2.5">
            {ACCENTS.map((color) => (
              <button
                key={color}
                onClick={() => setSettings({ accent: color })}
                className={cx(
                  'size-7 rounded-full border-2 transition-transform hover:scale-110',
                  settings.accent === color ? 'border-fg ring-2 ring-fg/20' : 'border-transparent',
                )}
                style={{ background: color }}
                aria-label={color}
              />
            ))}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard id="workspace" title={t('Workspace')}>
        <div>
          <Label>{t('Standard-Projektordner')}</Label>
          <div className="flex gap-2">
            <input className="field font-mono text-[12px]" value={settings.defaultCwd} onChange={(e) => setSettings({ defaultCwd: e.target.value })} />
            <button className="btn" onClick={async () => { const dir = await hub.pickFolder(); if (dir) setSettings({ defaultCwd: dir }); }}>
              <Icon name="lucide:folder-open" size={14} />
            </button>
          </div>
        </div>
        <div>
          <Label hint={t('Schnell-Prompt (Tray)')}>{t('Hotkey Schnell-Prompt')}</Label>
          <HotkeyField value={settings.quickHotkey} onChange={(quickHotkey) => setSettings({ quickHotkey })} />
        </div>
        <div className="border-t border-edge/70 pt-2">
          <Toggle checked={settings.sidebarPinned} onChange={(sidebarPinned) => setSettings({ sidebarPinned })} label={t('Seitenleiste angeheftet')} hint={t('Aus: Die Seitenleiste öffnet sich beim Verweilen am linken Rand oder per Strg+B')} />
        </div>
      </SettingsCard>

      <SettingsCard id="shortcuts" title={t('Tastenkürzel')} collapsible defaultOpen={false} summary={`${SHORTCUTS.length} ${t('Kürzel')}`}>
        <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys} className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-muted">{t(shortcut.label)}</span>
              <kbd className="kbd-pill shrink-0">{shortcut.keys}</kbd>
            </div>
          ))}
        </div>
      </SettingsCard>

      {hidden.length > 0 && (
        <SettingsCard id="hidden-projects" title={t('Ausgeblendete Projekte')} collapsible defaultOpen={false} summary={String(hidden.length)}>
          <div className="space-y-2">
            {hidden.map((path) => (
              <div key={path} className="flex items-center gap-3 rounded-lumen border border-edge bg-bg/50 px-3 py-2">
                <Icon name="lucide:folder" size={14} className="text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{path || t('Ohne Projekt')}</span>
                <button className="btn !py-1 text-[12px]" onClick={() => restoreProject(path)}>
                  <Icon name="lucide:rotate-ccw" size={13} /> {t('Wiederherstellen')}
                </button>
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </div>
  );
}

const COMPACT_STEPS = [20_000, 40_000, 60_000, 100_000, 150_000, 200_000];
const DEFAULT_COMPACT_TOKENS = 60_000;

function ChatTab() {
  const settings = useHub((s) => s.data.settings);
  const { setSettings } = useHub.getState();
  const compaction = settings.compaction ?? {};
  const autoCompact = compaction.auto !== false;
  const threshold = compaction.thresholdTokens ?? DEFAULT_COMPACT_TOKENS;
  const fallbackCount = settings.fallbacks?.length ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight">{t('Chat')}</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">{t('Neue Chats, Kompaktieren, Ausweich-Modelle und Import.')}</p>
      </div>

      <SettingsCard id="new-chats" title={t('Neue Chats')}>
        <div>
          <Label hint={t('gilt, wenn keine letzte Auswahl übernommen wird')}>{t('Standard-Anbieter')}</Label>
          <Select value={settings.defaultProvider} onChange={(defaultProvider) => setSettings({ defaultProvider })} options={PROVIDER_ORDER.map((id) => ({ value: id, label: PROVIDERS[id].name }))} />
        </div>
        <div className="space-y-1 border-t border-edge/70 pt-2">
          <Toggle checked={settings.rememberLastChat !== false} onChange={(rememberLastChat) => setSettings({ rememberLastChat })} label={t('Letzte Auswahl übernehmen')} hint={t('Neue Chats starten mit Anbieter, Modus, Modell, Berechtigungen und Effort des zuletzt genutzten Chats')} />
          <Toggle checked={settings.showUsageInComposer !== false} onChange={(showUsageInComposer) => setSettings({ showUsageInComposer })} label={t('Nutzung in der Chatbox anzeigen')} />
          <Toggle checked={!!settings.showOlderModels} onChange={(showOlderModels) => setSettings({ showOlderModels })} label={t('Ältere Modelle standardmäßig anzeigen')} hint={t('Zeigt zusätzlich ältere und eigene Modell-IDs in der Auswahl')} />
        </div>
      </SettingsCard>

      <SettingsCard id="compaction" title={t('Kompaktieren')} description={t('Fasst ältere Teile eines langen Chats zusammen; die jüngsten Nachrichten bleiben wörtlich erhalten. Manuell jederzeit mit /compact.')}>
        <Toggle
          checked={autoCompact}
          onChange={(auto) => setSettings({ compaction: { ...compaction, auto } })}
          label={t('Automatisch kompaktieren')}
          hint={t('Für API-, Ollama- und lokale Modelle, die den Verlauf bei jeder Anfrage komplett mitbekommen. Claude, Codex und Co. verdichten ihre Sitzung selbst.')}
        />
        {autoCompact && (
          <div>
            <Label hint={`~${(threshold / 1000).toFixed(0)}k ${t('Token')}`}>{t('Ab dieser Verlaufsgröße')}</Label>
            <input
              type="range" min={0} max={COMPACT_STEPS.length - 1} step={1}
              value={Math.max(0, COMPACT_STEPS.findIndex((value) => value >= threshold))}
              onChange={(event) => setSettings({ compaction: { ...compaction, thresholdTokens: COMPACT_STEPS[Number(event.target.value)] } })}
              className="w-full accent-[var(--c-accent)]"
            />
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        id="fallbacks"
        title={t('Ausweich-Modelle für alle Chats')}
        description={t('Ist das Kontingent eines Modells aufgebraucht, wechselt der Chat der Reihe nach auf diese Modelle. Pro Chat anpassbar über das Rettungsring-Symbol in der Titelleiste.')}
        collapsible
        defaultOpen={fallbackCount > 0}
        summary={fallbackCount ? `${fallbackCount} ${t('Modelle')}` : t('keine gewählt')}
      >
        <FallbackList value={settings.fallbacks ?? []} onChange={(fallbacks) => setSettings({ fallbacks })} />
      </SettingsCard>

      <SettingsCard id="import" title={t('Import')}>
        <Toggle checked={settings.autoImport} onChange={(autoImport) => setSettings({ autoImport })} label={t('Neue Sessions automatisch importieren')} hint={t('Prüft alle 60 s auf neue Claude- und Codex-Sessions')} />
      </SettingsCard>
    </div>
  );
}

function ProviderTab({ p }: { p: ProviderId }) {
  const settings = useHub((s) => s.data.settings);
  const status = useHub((s) => s.statuses[p]);
  const { setSettings, setProviderDefaults, refreshStatus } = useHub.getState();

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Dot id={p} size={10} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold">{PROVIDERS[p].name}</h3>
          <p className="text-[11.5px] text-subtle">{PROVIDERS[p].vendor}</p>
        </div>
        <span className={cx('rounded-full px-2.5 py-0.5 text-[11px] font-medium', status?.installed ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad')}>
          {status?.installed ? (status.version || t('verfügbar')) : t('nicht gefunden')}
        </span>
      </div>

      {PROVIDERS[p].bin && (
        <div>
          <Label hint={t('leer = automatisch aus PATH')}>{t('Pfad zur CLI')} ({PROVIDERS[p].bin})</Label>
          <div className="flex gap-2">
            <input
              className="field font-mono text-[12px]"
              placeholder={status?.path ?? PROVIDERS[p].bin}
              value={settings.binaries[p] ?? ''}
              onChange={(e) => setSettings({ binaries: { ...settings.binaries, [p]: e.target.value || undefined } })}
            />
            <button className="btn" onClick={async () => { const [file] = await hub.pickFiles('any'); if (file) setSettings({ binaries: { ...settings.binaries, [p]: file } }); }}>
              <Icon name="lucide:file-search" size={14} />
            </button>
            <button className="btn" onClick={() => setTimeout(() => void refreshStatus(p, true), 200)}>
              <Icon name="lucide:refresh-cw" size={14} />
            </button>
          </div>
        </div>
      )}

      <HostInstallCard provider={p} />
      {isSandboxProvider(p) && <SandboxCard provider={p} />}

      <SettingsCard id={`defaults-${p}`} title={t('Standardwerte für neue Chats & Agenten')} collapsible defaultOpen={false} summary={t('Modell, Berechtigungen, CLI-Optionen')}>
        <OptionsPanel provider={p} value={settings.providerDefaults[p]} onChange={(patch) => setProviderDefaults(p, patch)} />
      </SettingsCard>
    </div>
  );
}

function ProvidersTab() {
  const statuses = useHub((s) => s.statuses);
  const [selected, setSelected] = useState<ProviderId>('claude');

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-tight">{t('Anbieter')}</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">{t('CLI-Pfade, API-Verbindungen, lokale Modelle und Standardwerte.')}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {PROVIDER_ORDER.map((id) => {
          const st = statuses[id];
          const active = selected === id;
          return (
            <button
              key={id}
              onClick={() => setSelected(id)}
              className={cx(
                'flex items-center gap-2.5 rounded-lumen border px-3 py-2.5 text-left transition-all',
                active ? 'border-accent/70 bg-surface shadow-xs' : 'border-edge bg-surface/40 hover:border-edge-strong hover:bg-surface',
              )}
            >
              <Dot id={id} size={8} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-fg">{PROVIDERS[id].name}</span>
                <span className="block truncate text-[10.5px] text-subtle">{PROVIDERS[id].vendor}</span>
              </span>
              <span
                className={cx('size-2 shrink-0 rounded-full', st === undefined ? 'bg-subtle' : st.installed ? 'bg-ok' : 'bg-bad/80')}
                title={st?.installed ? t('verfügbar') : t('nicht verfügbar')}
              />
            </button>
          );
        })}
      </div>

      <div key={selected} className="fade-in rounded-lumen-lg border border-edge bg-surface/55 p-5">
        {selected === 'api' ? (
          <ApiProviderSettings />
        ) : selected === 'local' ? (
          <LocalProviderSettings onApi={() => setSelected('api')} />
        ) : selected === 'ollama' ? (
          <OllamaProviderSettings />
        ) : (
          <ProviderTab p={selected} />
        )}
        <ProviderCatalog p={selected} />
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

  useEffect(() => {
    setDraft((settings.customModels?.[p] ?? []).join('\n'));
  }, [p, settings.customModels]);

  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      await useHub.getState().refreshStatus(p, true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 space-y-3 border-t border-edge pt-5">
      <div className="flex items-center justify-between">
        <Label>{t('Modellkatalog')}</Label>
        <button className="btn !py-1 text-[11.5px]" disabled={busy} onClick={() => void refresh()}>
          <Icon name="lucide:refresh-cw" size={12} className={cx(busy && 'spin')} />
          {t('Aktualisieren')}
        </button>
      </div>
      <div className="max-h-44 overflow-auto rounded-lumen border border-edge bg-bg/50">
        {status?.models.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-2 border-b border-edge px-3 py-2 last:border-0">
            <span className="min-w-0">
              <span className="block text-[12px]">{m.label}</span>
              <span className="block truncate font-mono text-[10px] text-subtle">{m.id}</span>
            </span>
            <span className="text-[10px] text-subtle">{m.efforts?.join(' · ')}</span>
          </div>
        ))}
        {!status?.models.length && <p className="p-3 text-[12px] text-muted">{t('Keine Modelle verfügbar')}</p>}
      </div>
      {error && <p className="text-[12px] text-bad">{t(error)}</p>}
      {!['local', 'ollama', 'api'].includes(p) && (
        <>
          <Label hint={t('Eine Modell-ID pro Zeile')}>{t('Eigene / ältere Modell-IDs')}</Label>
          <textarea className="field min-h-20 resize-y font-mono text-[12px]" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <p className="text-[11px] text-subtle">{t('Nur IDs eintragen, auf die dein Konto Zugriff hat. Diese Einträge sind manuell konfiguriert; die Verfügbarkeit wird nicht geprüft.')}</p>
          <button
            className="btn"
            onClick={() => useHub.getState().setSettings({ customModels: { ...settings.customModels, [p]: [...new Set(draft.split('\n').map((id) => id.trim()).filter(Boolean))] } })}
          >
            {t('Speichern')}
          </button>
        </>
      )}
      <div>
        <button
          className="btn btn-ghost text-muted"
          onClick={() => useHub.getState().setSettings({ providerDefaults: { ...settings.providerDefaults, [p]: { ...DEFAULT_OPTIONS[p] } } })}
        >
          <Icon name="lucide:rotate-ccw" size={13} />
          {t('Anbieter-Standardwerte zurücksetzen')}
        </button>
      </div>
    </section>
  );
}

function TerminalTab() {
  const st = useHub((s) => s.data.settings.terminal);
  const [shells, setShells] = useState<{ id: string; name: string; path: string }[]>([]);
  const set = (patch: Partial<TerminalStyle>) => useHub.getState().setSettings({ terminal: { ...st, ...patch } });

  useEffect(() => {
    let alive = true;
    void hub.termShells().then((list) => { if (alive) { setShells(list); } }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const colors = TERMINAL_THEMES[st.theme]?.colors;
  const currentShell = st.shell ?? '';
  const isKnownShell = !currentShell || shells.some((sh) => sh.path === currentShell);
  const selectValue = isKnownShell ? currentShell : '__custom__';
  const activeShellName = shells.find((sh) => sh.path === currentShell)?.name ?? (currentShell ? currentShell.split(/[\\/]/).pop() : 'System');

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">{t('Terminal')}</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">{t('Shell-Auswahl, Farbschema und Schriftart für alle Chat-Terminals.')}</p>
        </div>
        <button className="btn btn-ghost text-muted" onClick={() => useHub.getState().setSettings({ terminal: defaultTerminal() })}>
          <Icon name="lucide:rotate-ccw" size={13} /> {t('Zurücksetzen')}
        </button>
      </div>

      <SettingsCard
        id="shell"
        title={t('Shell')}
        description={t('Wähle eine erkannte Shell oder gib einen eigenen Pfad an (gilt für neu geöffnete Terminals).')}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>{t('Standard-Shell')}</Label>
            <Select
              value={selectValue}
              onChange={(value) => {
                if (value === '__custom__') {
                  if (!currentShell) {
                    set({ shell: '/bin/bash' });
                  }
                  return;
                }
                set({ shell: value || undefined });
              }}
              options={[
                { value: '', label: t('System-Standard (Login-Shell)') },
                ...shells.map((sh) => ({ value: sh.path, label: `${sh.name} (${sh.path})` })),
                { value: '__custom__', label: t('Eigener Pfad …') },
              ]}
            />
          </div>

          <div>
            <Label hint={t('leer = System-Standard')}>{t('Shell-Pfad')}</Label>
            <div className="flex gap-1.5">
              <input
                className="field font-mono text-[12px]"
                placeholder="/usr/bin/fish"
                value={currentShell}
                onChange={(e) => set({ shell: e.target.value.trim() || undefined })}
              />
              <button
                className="btn shrink-0"
                title={t('Shell-Binary auswählen')}
                onClick={async () => {
                  const [file] = await hub.pickFiles('any');
                  if (file) {
                    set({ shell: file });
                  }
                }}
              >
                <Icon name="lucide:file-search" size={14} />
              </button>
              {currentShell && (
                <button className="btn shrink-0" title={t('Auf Standard zurücksetzen')} onClick={() => set({ shell: undefined })}>
                  <Icon name="lucide:x" size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </SettingsCard>

      <div
        className="overflow-hidden rounded-lumen-lg border border-edge p-3.5 shadow-xs"
        style={{ background: termBackground(st), color: colors?.foreground ?? 'var(--c-text)', fontFamily: withTerminalFontFallbacks(st.fontFamily), fontSize: st.fontSize, lineHeight: st.lineHeight }}
      >
        <div className="mb-1 text-[10.5px] opacity-55">{activeShellName}</div>
        <div><span style={{ color: colors?.green ?? 'var(--c-accent)' }}>user@quorum</span>:<span style={{ color: colors?.blue ?? 'var(--c-accent)' }}>~/projekt</span>$ git status</div>
        <div><span style={{ color: colors?.red }}>modified:</span>   src/App.tsx</div>
        <div>
          <span style={{ color: colors?.yellow }}>warning:</span> 2 files changed
          <span
            className={cx('ml-0.5 inline-block align-middle', st.cursorBlink && 'animate-pulse')}
            style={{
              background: colors?.cursor ?? 'var(--c-accent)',
              width: st.cursorStyle === 'bar' ? 2 : '0.6em',
              height: st.cursorStyle === 'underline' ? 2 : '1.1em',
            }}
          />
        </div>
      </div>

      <SettingsCard id="terminal-theme" title={t('Farbschema')} collapsible>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { id: 'app', label: t('App'), bg: 'var(--c-bg-elevated)', fg: 'var(--c-text)' },
            ...Object.entries(TERMINAL_THEMES).map(([id, entry]) => ({ id, label: entry.label, bg: entry.colors.background, fg: entry.colors.foreground })),
          ].map((entry) => (
            <button
              key={entry.id}
              onClick={() => set({ theme: entry.id })}
              className={cx(
                'rounded-lumen border px-2.5 py-2 text-left font-mono text-[11.5px] transition-all hover:scale-[1.02]',
                st.theme === entry.id ? 'border-accent ring-1 ring-accent' : 'border-edge',
              )}
              style={{ background: entry.bg, color: entry.fg }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard id="terminal-font" title={t('Schrift & Verhalten')} collapsible>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label>{t('Schriftart')}</Label>
            <Select value={FONTS.some((f) => f.value === st.fontFamily) ? st.fontFamily : FONTS[0].value} onChange={(fontFamily) => set({ fontFamily })} options={FONTS} />
          </div>
          <div>
            <Label>{t('Cursor')}</Label>
            <div className="grid grid-cols-3 rounded-lumen-sm border border-edge bg-bg/60 p-0.5 text-[12px]">
              {([{ id: 'block', label: 'Block' }, { id: 'bar', label: 'Strich' }, { id: 'underline', label: 'Unterstrich' }] as const).map((item) => (
                <button
                  key={item.id}
                  onClick={() => set({ cursorStyle: item.id })}
                  className={cx('rounded-[5px] py-1.5 font-medium transition-colors', st.cursorStyle === item.id ? 'bg-overlay text-fg shadow-xs' : 'text-subtle hover:text-muted')}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label hint={`${st.fontSize}px`}>{t('Schriftgröße')}</Label>
            <input type="range" min={9} max={22} step={0.5} value={st.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} className="w-full accent-[var(--c-accent)]" />
          </div>
          <div>
            <Label hint={st.lineHeight.toFixed(2)}>{t('Zeilenhöhe')}</Label>
            <input type="range" min={1} max={1.8} step={0.05} value={st.lineHeight} onChange={(e) => set({ lineHeight: Number(e.target.value) })} className="w-full accent-[var(--c-accent)]" />
          </div>
          <div>
            <Label hint={t('Zeilen')}>{t('Verlauf (Scrollback)')}</Label>
            <Select value={String(st.scrollback)} onChange={(v) => set({ scrollback: Number(v) })} options={['1000', '5000', '10000', '50000'].map((v) => ({ value: v, label: Number(v).toLocaleString() }))} />
          </div>
          <div className="flex items-end">
            <Toggle checked={st.cursorBlink} onChange={(cursorBlink) => set({ cursorBlink })} label={t('Blinkender Cursor')} />
          </div>
        </div>
      </SettingsCard>
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
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">{t('Software-Updates')}</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">{t('Aktualisierungen über GitHub Releases und Update-Kanäle.')}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-edge bg-surface px-2.5 py-0.5 font-mono text-[11.5px] text-muted">
            v{updaterState.currentVersion}
          </span>
          <span className={cx(
            'rounded-full px-2.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
            settings.updateChannel === 'release' ? 'bg-ok/15 text-ok' : settings.updateChannel === 'beta' ? 'bg-accent/15 text-accent' : 'bg-warn/15 text-warn',
          )}>
            {settings.updateChannel}
          </span>
        </div>
      </div>

      <SettingsCard title={t('Update-Kanal')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label hint={t('Bestimmt, welche Releases bezogen werden')}>{t('Release-Kanal')}</Label>
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
          hint={t('Prüft beim Starten der App im Hintergrund auf neue Releases')}
        />
      </SettingsCard>

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
              {t('Installierte Version')}: <span className="font-mono">v{updaterState.currentVersion}</span> ({settings.updateChannel})
            </div>
          </div>
          <span className="text-[11px] text-subtle">{t('Gerade geprüft')}</span>
        </div>
      )}

      {updaterState.status === 'error' && (
        <div className="flex items-start gap-3 rounded-lumen border border-bad/30 bg-bad/10 p-4">
          <Icon name="lucide:alert-circle" className="mt-0.5 shrink-0 text-bad" size={18} />
          <div className="flex-1">
            <div className="font-medium text-bad">{t('Update-Fehler')}</div>
            <div className="mt-0.5 text-[12px] text-muted">{t(updaterState.error ?? '')}</div>
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
                <span className="inline-flex size-2 animate-pulse rounded-full bg-accent" />
                <h3 className="text-[15px] font-semibold">{t('Neue Version verfügbar')}: {info.name}</h3>
              </div>
              <div className="mt-1 flex items-center gap-3 font-mono text-[12px] text-subtle">
                <span>Tag: {info.tag}</span>
                {info.asset && <span>Größe: {(info.asset.size / 1024 / 1024).toFixed(1)} MB</span>}
                <span>{new Date(info.publishedAt).toLocaleDateString()}</span>
              </div>
            </div>
            <button className="btn btn-primary gap-2" onClick={() => void downloadUpdate()}>
              <Icon name="lucide:download" size={15} />
              {t('Update herunterladen')}
            </button>
          </div>

          {info.notes && (
            <div className="mt-3 max-h-48 overflow-y-auto rounded-lumen-sm border border-edge bg-bg p-3 text-[12.5px] leading-relaxed">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">{t('Änderungen')}</div>
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
            <span className="font-mono text-[13px] font-semibold text-accent">{progress?.percent ?? 0}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
            <div className="h-full bg-accent transition-all duration-300 ease-out" style={{ width: `${progress?.percent ?? 0}%` }} />
          </div>
          <div className="flex items-center justify-between font-mono text-[11.5px] text-subtle">
            <span>{progress ? `${(progress.transferred / 1024 / 1024).toFixed(1)} MB / ${(progress.total / 1024 / 1024).toFixed(1)} MB` : ''}</span>
            <span>{progress?.bytesPerSecond ? `${(progress.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : ''}</span>
          </div>
        </div>
      )}

      {updaterState.status === 'downloaded' && (
        <div className="flex items-start justify-between gap-4 rounded-lumen border border-ok/40 bg-ok/10 p-4">
          <div className="flex items-start gap-3">
            <Icon name="lucide:check-circle" className="mt-0.5 shrink-0 text-ok" size={20} />
            <div>
              <div className="font-semibold text-ok">{t('Update bereit zur Installation')}</div>
              <p className="mt-0.5 text-[12px] text-muted">{t('Beim Klick auf „Jetzt neu starten“ wird Quorum aktualisiert und neu gestartet.')}</p>
            </div>
          </div>
          <button className="btn btn-primary shrink-0 gap-2 !bg-ok !text-black hover:!bg-ok/90" onClick={() => void installUpdate()}>
            <Icon name="lucide:rotate-cw" size={15} />
            {t('Jetzt neu starten')}
          </button>
        </div>
      )}
    </div>
  );
}

export function SettingsModal() {
  const tab = useHub((s) => s.settingsTab);
  const version = useHub((s) => s.updaterState.currentVersion);
  const { closeSettings, openSettings } = useHub.getState();
  const [query, setQuery] = useState('');

  if (!tab) {
    return null;
  }

  const needle = query.trim().toLowerCase();
  const results = needle ? SETTINGS_INDEX.filter((entry) => `${entry.title} ${t(entry.title)} ${entry.keywords}`.toLowerCase().includes(needle)) : [];

  function handleJump(target: string, card?: string) {
    setQuery('');
    openSettings(target);
    revealCard(card);
  }

  return (
    <Modal xl bare title={t('Einstellungen')} onClose={closeSettings}>
      <nav className="flex w-52 shrink-0 flex-col border-r border-edge bg-surface/80 p-3">
        <div className="px-2.5 pb-3 pt-1 text-[13px] font-semibold tracking-tight text-fg">{t('Einstellungen')}</div>
        <div className="mb-2 flex items-center gap-2 rounded-lumen-sm border border-edge bg-input px-2.5 focus-within:border-accent/60">
          <Icon name="lucide:search" size={13} className="shrink-0 text-subtle" />
          <input type="text" role="searchbox" aria-label={t('Einstellungen durchsuchen')} placeholder={t('Suchen …')} value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-1.5 text-[12px] outline-none placeholder:text-subtle" />
          {query && <button className="icon-btn !size-5" aria-label={t('Suche leeren')} onClick={() => setQuery('')}><Icon name="lucide:x" size={12} /></button>}
        </div>
        {query.trim() ? (
          <div className="space-y-0.5">
            {results.length === 0 && <div className="px-2.5 py-2 text-[12px] text-subtle">{t('Nichts gefunden.')}</div>}
            {results.map((entry) => (
              <button key={`${entry.tab}:${entry.card ?? ''}`} onClick={() => handleJump(entry.tab, entry.card)} className="flex w-full flex-col rounded-lumen-sm px-2.5 py-1.5 text-left transition-colors hover:bg-hover">
                <span className="text-[12.5px] font-medium text-fg">{t(entry.title)}</span>
                <span className="text-[10.5px] text-subtle">{t(TABS.find((item) => item.id === entry.tab)?.label ?? '')}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {TABS.map((item) => (
              <button
                key={item.id}
                onClick={() => openSettings(item.id)}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors',
                  tab === item.id ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                )}
              >
                <Icon name={item.icon} size={15} className={tab === item.id ? 'text-accent' : 'text-subtle'} />
                <span>{t(item.label)}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex-1" />
        <div className="px-2.5 pt-3 font-mono text-[11px] text-subtle">Quorum v{version}</div>
      </nav>
      <div className="relative flex min-w-0 flex-1 flex-col bg-bg/50">
        <button
          className="icon-btn absolute right-4 top-4 z-10 !size-8"
          title={t('Schließen')}
          onClick={closeSettings}
        >
          <Icon name="lucide:x" size={15} />
        </button>
        <div key={tab} className="fade-in min-h-0 flex-1 overflow-y-auto p-6 pr-12">
          {tab === 'general' && <GeneralTab />}
          {tab === 'chat' && <ChatTab />}
          {tab === 'providers' && <ProvidersTab />}
          {tab === 'terminal' && <TerminalTab />}
          {tab === 'usage' && <UsageView />}
          {tab === 'updates' && <UpdatesTab />}
        </div>
      </div>
    </Modal>
  );
}
