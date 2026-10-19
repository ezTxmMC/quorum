// Statischer Katalog: Welche Funktionen bietet welche CLI – die UI generiert daraus Formulare & Matrix.
import type { DockState, ModelInfo, TerminalStyle, ProviderId, ProviderOptions } from './types';

export interface Choice { value: string; label: string; hint?: string }

/** Anbieter, die Nachrichten mitten im Lauf annehmen (Steuern). Alle anderen: nur einreihen (Queue). */
export const DIRECT_MESSAGES: Record<ProviderId, boolean> = { claude: true, codex: false, antigravity: false, opencode: false, ollama: false, local: false, api: false };

/** Reine Text-Chats über eine HTTP-API: kein Projektordner, keine Tools, der Verlauf kommt aus dem Hub. */
export const TEXT_ONLY: ProviderId[] = ['ollama', 'local', 'api'];
export const isTextOnly = (p: ProviderId) => TEXT_ONLY.includes(p);

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  vendor: string;
  bin: string;
  color: string;
  icon: string;
  permissionLabel: string;
  permissions: Choice[];
  efforts: Choice[];
  /** Admin-Unterbefehle, die im Tools-Bereich angeboten werden. */
  commands: { id: string; label: string; icon: string; args: string[]; hint: string }[];
  /** Slash-Befehle im Composer (werden als Aktion oder Prompt-Vorlage behandelt). */
  features: string[];
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  api: {
    id: 'api', name: 'API', vendor: 'Externe API', bin: '', color: '#a78bfa', icon: 'lucide:cloud',
    permissionLabel: 'Modus', permissions: [], efforts: [], commands: [],
    features: ['OpenAI-kompatible Chat-API', 'Streaming', 'Eigene Endpunkte & Modelle', 'System-Prompt', 'Ohne lokale Runtime'],
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'OpenCode · alle Anbieter',
    bin: 'opencode',
    color: '#e6c34a',
    icon: 'lucide:code-xml',
    permissionLabel: 'Modus',
    permissions: [],
    efforts: [],
    commands: [
      { id: 'models', label: 'Modelle', icon: 'lucide:cpu', args: ['models'], hint: 'opencode models' },
      { id: 'auth', label: 'Anmeldung', icon: 'lucide:key-round', args: ['auth', 'list'], hint: 'opencode auth list' },
      { id: 'mcp', label: 'MCP-Server', icon: 'lucide:plug', args: ['mcp', 'list'], hint: 'opencode mcp list' },
      { id: 'agents', label: 'Agenten', icon: 'lucide:bot', args: ['agent', 'list'], hint: 'opencode agent list' },
      { id: 'stats', label: 'Nutzung', icon: 'lucide:chart-no-axes-column', args: ['stats'], hint: 'opencode stats' },
      { id: 'version', label: 'Version', icon: 'lucide:info', args: ['--version'], hint: 'opencode --version' },
    ],
    features: ['Streaming (JSON-Events)', 'Tool-Aufrufe', 'Modelle aller Anbieter (anbieter/modell)', 'Eigene Agenten (--agent)', 'Session fortsetzen', 'Dateien anhängen (--file)', 'MCP-Server', 'Token & Kosten'],
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    vendor: 'Lokal · Ollama',
    bin: '',
    color: '#d6d3cd',
    icon: 'lucide:server',
    permissionLabel: 'Modus',
    permissions: [],
    efforts: [],
    commands: [],
    features: ['Lokale Modelle (kein Konto, kein Limit)', 'Streaming', 'Thinking-Modelle', 'Modelle live von der Ollama-API', 'Token-Nutzung', 'Verlauf wird im Hub gehalten'],
  },
  local: {
    id: 'local',
    name: 'llama.cpp / Lokal',
    vendor: 'Lokal · GGUF / Transformers',
    bin: '',
    color: '#8fb7a8',
    icon: 'lucide:cpu',
    permissionLabel: 'Modus',
    permissions: [],
    efforts: [],
    commands: [],
    features: ['Lokale Modelle aus der Modell-Verwaltung (GGUF, Transformers)', 'Streaming', 'Ohne Werkzeuge: nur Text, keine Dateiänderungen', 'Verlauf wird im Hub gehalten'],
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    vendor: 'Anthropic',
    bin: 'claude',
    color: '#d97757',
    icon: 'lucide:sparkles',
    permissionLabel: 'Berechtigungsmodus',
    permissions: [
      { value: 'manual', label: 'Manuell', hint: 'Nicht erlaubte Tools werden im Headless-Betrieb abgelehnt' },
      { value: 'acceptEdits', label: 'Edits akzeptieren', hint: 'Dateiänderungen ohne Rückfrage' },
      { value: 'plan', label: 'Plan (nur lesen)', hint: 'Analysiert und plant, ändert nichts' },
      { value: 'auto', label: 'Auto', hint: 'Klassifikator entscheidet' },
      { value: 'dontAsk', label: 'Nicht fragen', hint: 'Nur vorab erlaubte Tools' },
      { value: 'bypassPermissions', label: 'Alles erlauben', hint: 'Keine Prüfungen – gefährlich' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v })),
    commands: [
      { id: 'mcp', label: 'MCP-Server', icon: 'lucide:plug', args: ['mcp', 'list'], hint: 'claude mcp list' },
      { id: 'plugins', label: 'Plugins', icon: 'lucide:puzzle', args: ['plugin', 'list'], hint: 'claude plugin list' },
      { id: 'agents', label: 'Hintergrund-Agenten', icon: 'lucide:bot', args: ['agents'], hint: 'claude agents' },
      { id: 'auth', label: 'Anmeldung', icon: 'lucide:key-round', args: ['auth', 'status'], hint: 'claude auth status' },
      { id: 'doctor', label: 'Diagnose', icon: 'lucide:stethoscope', args: ['doctor'], hint: 'claude doctor' },
      { id: 'version', label: 'Version', icon: 'lucide:info', args: ['--version'], hint: 'claude --version' },
    ],
    features: ['Streaming & Thinking', 'Tool-Aufrufe', 'Sub-Agenten (--agents)', 'MCP (--mcp-config)', 'Plugins & Skills', 'Berechtigungsmodi', 'Plan-Modus', 'Session fortsetzen / forken', 'Git-Worktree (-w)', 'Budget-Limit', 'JSON-Schema-Ausgabe', 'System-Prompt anhängen', 'Tool Allow/Deny', 'Claude in Chrome', 'Zusätzliche Verzeichnisse', 'Bilder (@Pfad)', 'Kosten & Token', 'Ultracode'],
  },
  codex: {
    id: 'codex',
    name: 'GPT Codex',
    vendor: 'OpenAI',
    bin: 'codex',
    color: '#10a37f',
    icon: 'lucide:terminal-square',
    permissionLabel: 'Sandbox',
    permissions: [
      { value: 'read-only', label: 'Nur lesen', hint: 'Keine Änderungen' },
      { value: 'workspace-write', label: 'Workspace schreiben', hint: 'Änderungen im Projektordner' },
      { value: 'danger-full-access', label: 'Voller Zugriff', hint: 'Keine Sandbox – gefährlich' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((v) => ({ value: v, label: v })),
    commands: [
      { id: 'mcp', label: 'MCP-Server', icon: 'lucide:plug', args: ['mcp', 'list'], hint: 'codex mcp list' },
      { id: 'plugins', label: 'Plugins', icon: 'lucide:puzzle', args: ['plugin', 'list'], hint: 'codex plugin list' },
      { id: 'features', label: 'Feature-Flags', icon: 'lucide:flag', args: ['features', 'list'], hint: 'codex features list' },
      { id: 'cloud', label: 'Cloud-Tasks', icon: 'lucide:cloud', args: ['cloud', 'list'], hint: 'codex cloud list' },
      { id: 'login', label: 'Anmeldung', icon: 'lucide:key-round', args: ['login', 'status'], hint: 'codex login status' },
      { id: 'doctor', label: 'Diagnose', icon: 'lucide:stethoscope', args: ['doctor'], hint: 'codex doctor' },
      { id: 'version', label: 'Version', icon: 'lucide:info', args: ['--version'], hint: 'codex --version' },
    ],
    features: ['Streaming (JSONL)', 'Befehlsausführung', 'Dateiänderungen', 'Sandbox-Modi', 'Reasoning-Effort', 'Session fortsetzen (resume)', 'Code-Review (review)', 'MCP-Server', 'Plugins', 'Cloud-Tasks', 'Profile & -c Overrides', 'Bilder (-i)', 'Output-Schema', 'OSS-/lokale Modelle (Ollama, LM Studio)', 'Ephemere Sessions', 'Git-Worktree', 'Zusätzliche Verzeichnisse', 'Token-Nutzung', 'Geschwindigkeitsstufen (Fast)'],
  },
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google · Gemini',
    bin: 'agy',
    color: '#4c8bf5',
    icon: 'lucide:orbit',
    permissionLabel: 'Modus',
    permissions: [
      { value: 'default', label: 'Standard', hint: 'Tools mit Rückfrage werden im Headless-Betrieb abgelehnt' },
      { value: 'accept-edits', label: 'Edits akzeptieren', hint: 'Nur Dateiänderungen – Shell-Befehle werden abgelehnt' },
      { value: 'allow-commands', label: 'Befehle & Edits erlauben', hint: 'Alle Tool-Aufrufe automatisch genehmigt (Shell, Edits)' },
      { value: 'plan', label: 'Plan (nur lesen)' },
      { value: 'auto', label: 'Auto', hint: 'Nicht für jeden Account verfügbar' },
    ],
    efforts: ['low', 'medium', 'high'].map((v) => ({ value: v, label: v })),
    commands: [
      { id: 'models', label: 'Modelle', icon: 'lucide:cpu', args: ['models'], hint: 'agy models' },
      { id: 'agents', label: 'Agenten', icon: 'lucide:bot', args: ['agents'], hint: 'agy agents' },
      { id: 'mcp', label: 'MCP-Server', icon: 'lucide:plug', args: ['mcp', 'list'], hint: 'agy mcp list' },
      { id: 'plugins', label: 'Plugins', icon: 'lucide:puzzle', args: ['plugin', 'list'], hint: 'agy plugin list' },
      { id: 'remote', label: 'Remote-Control', icon: 'lucide:radio', args: ['remote-control', 'status'], hint: 'agy remote-control status' },
      { id: 'changelog', label: 'Changelog', icon: 'lucide:scroll-text', args: ['changelog'], hint: 'agy changelog' },
      { id: 'version', label: 'Version', icon: 'lucide:info', args: ['--version'], hint: 'agy --version' },
    ],
    features: ['Streaming (stream-json)', 'Tools: Dateien, Shell, Suche', 'Browser-Steuerung & Screenshots', 'Sub-Agenten', 'Bildgenerierung', 'Modi (accept-edits, plan, auto)', 'Effort-Stufen', 'Projekte', 'Konversation fortsetzen', 'MCP & Plugins', 'Terminal-Sandbox', 'JSON-Schema-Ausgabe', 'Remote-Control', 'Zusätzliche Verzeichnisse', 'Token-Nutzung'],
  },
};

// Versioned IDs keep an explicit selection stable when CLI aliases move to a newer release.
// Sources: https://platform.claude.com/docs/en/models/overview and its legacy model pages.
export const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5', label: 'Claude Fable 5', legacy: true },
  { id: 'claude-opus-5', label: 'Claude Opus 5', legacy: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', legacy: true },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', legacy: true },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', legacy: true },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', legacy: true },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', legacy: true },
  { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', legacy: true },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', legacy: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', legacy: true, efforts: [] },
];

const CLAUDE_ALIASES: Record<string, string> = {
  fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
};

export function canonicalModel(provider: ProviderId, id?: string): string | undefined {
  return provider === 'claude' && id ? CLAUDE_ALIASES[id] ?? id : id;
}

export const EFFORT_LABELS: Record<string, string> = {
  low: 'Niedrig', medium: 'Mittel', high: 'Hoch', xhigh: 'Sehr hoch', max: 'Maximal', ultra: 'Ultra',
};

export const DEFAULT_OPTIONS: Record<ProviderId, ProviderOptions> = {
  claude: { permission: 'acceptEdits', model: 'claude-sonnet-5-5' },
  codex: { sandbox: 'workspace-write' },
  antigravity: { permission: 'allow-commands' },
  opencode: {},
  ollama: {},
  local: {},
  api: {},
};

// ---- Berechtigungsmodi (pro Chat wählbar) ---------------------------------------------------------------------------------
export type ModeId = 'ask' | 'edit' | 'plan' | 'auto' | 'noask' | 'full' | 'review';

export const MODES: { id: ModeId; icon: string; label: string; hint: string }[] = [
  { id: 'review', icon: 'lucide:clipboard-check', label: 'Request review', hint: 'Plant zuerst; keine Änderungen bis zur Freigabe durch Moduswechsel' },
  { id: 'ask', icon: 'lucide:message-circle-question', label: 'Fragen', hint: 'Fragt vor Änderungen – nicht erlaubte Tools werden headless abgelehnt' },
  { id: 'edit', icon: 'lucide:file-pen-line', label: 'Bearbeiten', hint: 'Dateiänderungen ohne Rückfrage' },
  { id: 'plan', icon: 'lucide:map', label: 'Plan', hint: 'Nur lesen und planen, nichts ändern' },
  { id: 'auto', icon: 'lucide:sparkles', label: 'Auto', hint: 'Automatische Freigabe nach Einschätzung der CLI' },
  { id: 'noask', icon: 'lucide:bell-off', label: 'Nicht fragen', hint: 'Keine Rückfragen – nur vorab erlaubte bzw. alle Tools' },
  { id: 'full', icon: 'lucide:shield-alert', label: 'Vollzugriff', hint: 'Keine Prüfungen und keine Sandbox – gefährlich' },
];

/** Welche Modi ein Anbieter kennt und wie sie auf dessen Optionen abgebildet werden. */
const MODE_MAP: Partial<Record<ProviderId, Partial<Record<ModeId, ProviderOptions>>>> = {
  claude: {
    ask: { permission: 'manual' }, edit: { permission: 'acceptEdits' }, plan: { permission: 'plan' },
    auto: { permission: 'auto' }, full: { fullAccess: true },
  },
  codex: {
    ask: { sandbox: 'workspace-write', approvalPolicy: 'untrusted' },
    auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request' }, full: { fullAccess: true },
  },
  antigravity: {
    review: { permission: 'plan' }, ask: { permission: 'default' },
    auto: { permission: 'auto' }, full: { fullAccess: true },
  },
};

export const modesFor = (p: ProviderId): ModeId[] => Object.keys(MODE_MAP[p] ?? {}) as ModeId[];

/** Optionen-Patch für einen Modus (setzt die jeweils anderen Rechte-Felder zurück). */
export function modePatch(p: ProviderId, mode: ModeId): ProviderOptions {
  const m = MODE_MAP[p]?.[mode];
  if (!m) return {};
  return { permission: undefined, sandbox: undefined, approvalPolicy: undefined, fullAccess: false, ...m };
}

/** Aktueller Modus aus den Optionen eines Chats. */
export function currentMode(p: ProviderId, o: ProviderOptions): ModeId {
  if (o.fullAccess || o.permission === 'bypassPermissions' || o.sandbox === 'danger-full-access' || (p === 'antigravity' && o.permission === 'allow-commands')) return 'full';
  if (p === 'claude' && o.permission === 'dontAsk') return 'noask';
  if (p === 'antigravity' && o.permission === 'accept-edits') return 'edit';
  if (p === 'codex' && o.sandbox === 'read-only') return 'plan';
  if (p === 'codex' && o.sandbox === 'workspace-write' && !o.approvalPolicy) return 'auto';
  const map = MODE_MAP[p];
  if (!map) return 'edit';
  for (const [id, patch] of Object.entries(map) as [ModeId, ProviderOptions][]) {
    if (id === 'full') continue;
    if (patch.permission !== undefined && patch.permission === o.permission) return id;
    if (patch.sandbox !== undefined && patch.sandbox === o.sandbox && (!patch.approvalPolicy || patch.approvalPolicy === o.approvalPolicy)) return id;
  }
  // Unbekannt/Standard: bei Claude und Antigravity ist der Standard „Fragen“, bei Codex „Auto“
  return p === 'codex' ? 'auto' : 'ask';
}


export function modeLabel(p: ProviderId, id: ModeId): string {
  if (id === 'ask') return p === 'antigravity' ? 'Default / Ask' : 'Manuell / Ask';
  if (id === 'full') return p === 'antigravity' ? 'Turbo / Full access' : 'Full access';
  if (id === 'edit') return 'Accept edits';
  return MODES.find((m) => m.id === id)?.label ?? id;
}

export const isChatModel = (id: string): boolean => !/(?:^|\/)(?:gpt-reserve|codex-auto-review)$/i.test(id);

/** Keep transport IDs intact; normalize names only for presentation. */
export function modelLabel(model: ModelInfo): string {
  // Ollama tags (including quantization names) are part of the exact model name.
  if (model.id.includes(':') && !model.id.startsWith('opencode/')) return model.label;
  const raw = model.label.replace(/^opencode\//i, '');
  if (model.label !== model.id && !model.label.includes('/')) return model.label;
  return raw.replace(/^opencode\//i, '').replace(/-free$/i, ' · Free')
    .replace(/\b(gpt|glm|vl)\b/gi, (v) => v.toUpperCase())
    .replace(/deepseek/gi, 'DeepSeek').replace(/nemotron/gi, 'Nemotron')
    .replace(/longcat/gi, 'LongCat').replace(/mimo/gi, 'MiMo')
    .replace(/[-_]/g, ' ').replace(/\b(beam|big|pickle|flash|preview|ultra|lightning|super|space|bunny)\b/gi, (v) => v[0].toUpperCase() + v.slice(1));
}

export function effortLabel(p: ProviderId, value: string): string {
  if (value === 'xhigh' && p === 'claude') return 'Extra';
  return EFFORT_LABELS[value] ?? value;
}

export function modelEfforts(p: ProviderId, info?: ModelInfo): string[] {
  return info?.efforts ?? PROVIDERS[p].efforts.map((e) => e.value);
}

export function defaultTerminal(): TerminalStyle {
  return { theme: 'app', fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace", fontSize: 12.5, lineHeight: 1.2, cursorStyle: 'block', cursorBlink: true, scrollback: 5000 };
}

type TermColors = { background: string; foreground: string; cursor: string; selectionBackground: string; black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string; brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string };
/** Farbschemata fürs Terminal (zusätzlich zu „App“). */
export const TERMINAL_THEMES: Record<string, { label: string; colors: TermColors }> = {
  dracula: { label: 'Dracula', colors: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2', brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff' } },
  nord: { label: 'Nord', colors: { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e', black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0', brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4' } },
  'one-dark': { label: 'One Dark', colors: { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#3e4451', black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf', brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff' } },
  'tokyo-night': { label: 'Tokyo Night', colors: { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c', black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6', brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5' } },
  'solarized-dark': { label: 'Solarized Dark', colors: { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' } },
  'solarized-light': { label: 'Solarized Light', colors: { background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selectionBackground: '#eee8d5', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5', brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3' } },
  'github-light': { label: 'GitHub Light', colors: { background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#ddf4ff', black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f' } },
};

export function defaultDock(): DockState {
  return {
    panels: {
      terminal: { visible: false, pos: 'bottom' as const },
      files: { visible: false, pos: 'left' as const },
      agents: { visible: false, pos: 'right' as const },
      changes: { visible: false, pos: 'right' as const },
    },
    sizes: { left: 280, right: 340, top: 260, bottom: 280 },
  };
}


// ---- Bildgenerierung -----------------------------------------------------------------------------------------------

export interface ImageEngine { id: string; label: string; via: string; provider: ProviderId; hint: string; model?: string }

/** Bild-Engines, die über vorhandene Anmeldungen laufen (kein API-Key): GPT Image über Codex (ChatGPT-Plan), Nano Banana über Antigravity. */
export const IMAGE_ENGINES: ImageEngine[] = [
  { id: 'gpt-image', label: 'GPT Image', via: 'Codex · ChatGPT-Plan', provider: 'codex', hint: 'Fotos, Illustrationen, Text im Bild, Bearbeiten mit Referenzbildern' },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 · Sunburst', model: 'gpt-image-2.5-sunburst', via: 'Codex', provider: 'codex', hint: 'Version wird angefordert; Modellzugriff über die CLI erforderlich' },
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 · Flare', model: 'gpt-image-2.5-flare', via: 'Codex', provider: 'codex', hint: 'Version wird angefordert; Modellzugriff über die CLI erforderlich' },
  { id: 'nano-banana-2', label: 'Nano Banana 2', model: 'gemini-3.1-flash-image', via: 'Antigravity', provider: 'antigravity', hint: 'Version wird angefordert; Modellzugriff über die CLI erforderlich' },
  { id: 'nano-banana', model: 'gemini-2.5-flash-image', label: 'Nano Banana', via: 'Antigravity · Gemini', provider: 'antigravity', hint: 'Schnelle Bilder und Bearbeitungen mit Gemini' },
];

/** Verfügbare Engines inkl. lokaler Ollama-Bildmodelle. */
export function imageEngines(statuses: Partial<Record<ProviderId, { installed: boolean; models: ModelInfo[] }>>): ImageEngine[] {
  const fixed = IMAGE_ENGINES.filter((e) => statuses[e.provider]?.installed);
  const local = (statuses.ollama?.installed ? statuses.ollama.models : []).filter((m) => m.image)
    .map((m) => ({ id: `ollama:${m.id}`, label: m.id, via: 'Ollama · lokal', provider: 'ollama' as const, hint: 'Lokales Bildmodell' }));
  return [...fixed, ...local];
}

export function imageEngineLabel(id?: string): string {
  if (!id) return '';
  return IMAGE_ENGINES.find((e) => e.id === id)?.label ?? id.replace(/^ollama:/, '');
}

/** The same entries and row presentation serve chat, quick prompts and provider options. */
export function modelChoices(
  provider: ProviderId,
  statuses: Partial<Record<ProviderId, { installed: boolean; models: ModelInfo[] }>>,
  customIds: string[] = [],
  includeImages = false,
): ModelInfo[] {
  const known = provider === 'claude' ? CLAUDE_MODELS : [];
  const regular = [...known, ...(statuses[provider]?.models ?? [])]
    .filter((m) => !m.image)
    .map((m) => {
      const id = canonicalModel(provider, m.id)!;
      return { ...m, ...known.find((entry) => entry.id === id), id };
    });
  const custom = customIds.map((raw) => {
    const id = canonicalModel(provider, raw)!;
    return { id, label: id, group: 'Custom' };
  });
  const images = includeImages ? imageEngines(statuses).filter((e) => e.provider === provider)
    .map((e) => ({ id: `image:${e.id}`, label: e.label, image: true, imageEngine: e.id, efforts: [] })) : [];
  return [...new Map([...regular, ...custom.filter((m) => !regular.some((r) => r.id === m.id)), ...images]
    .filter((m) => isChatModel(m.id)).map((m) => [m.id, m])).values()];
}

/** Clear the image route on text selection, and never leak an image engine ID into a text CLI call. */
export function selectModelOptions(base: ProviderOptions, id: string, info?: ModelInfo, imageEngine?: string): ProviderOptions {
  if (imageEngine) return { ...base, chatMode: 'image', model: undefined, imageGen: imageEngine, effort: undefined, speed: undefined };
  return { ...base, chatMode: base.chatMode === 'image' ? 'coding' : base.chatMode, model: id, imageGen: undefined,
    effort: base.effort && info?.efforts && !info.efforts.includes(base.effort) ? undefined : base.effort,
    speed: info?.speedTiers?.some((tier) => tier.id === base.speed) ? base.speed : undefined,
  };
}
