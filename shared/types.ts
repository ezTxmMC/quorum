import type { Capability } from './models';
// Gemeinsame Typen für Main-Prozess und Renderer.

/** `local`: Modelle aus der Modell-Verwaltung (GGUF/Transformers), ohne Werkzeuge, nur Text. */
export type ProviderId = 'claude' | 'codex' | 'antigravity' | 'opencode' | 'ollama' | 'local' | 'api';
export type ChatMode = 'text' | 'coding' | 'image' | 'model';

export interface ProviderOptions {
  chatMode?: ChatMode;
  model?: string;
  effort?: string;
  /** Berechtigungsmodus – providerspezifisch (siehe catalog.ts). */
  permission?: string;
  /** Nur Codex: Sandbox (read-only | workspace-write | danger-full-access). */
  sandbox?: string;
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  /** Alle Prüfungen abschalten (gefährlich). */
  fullAccess?: boolean;
  addDirs?: string[];
  systemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
  mcpConfig?: string;
  agentsJson?: string;
  maxBudgetUsd?: number;
  worktree?: boolean;
  chrome?: boolean;
  ephemeral?: boolean;
  /** Codex: Konfigurationsprofil. */
  profile?: string;
  /** Codex: -c key=value */
  configOverrides?: string[];
  oss?: boolean;
  localProvider?: string;
  jsonSchema?: string;
  /** Antigravity: Projekt-ID/-Name und Agent. */
  project?: string;
  agent?: string;
  sandboxTerminal?: boolean;
  extraArgs?: string;
  /** Codex: Service-Tier für höhere Geschwindigkeit (z. B. "priority"). */
  speed?: string;
  /** Claude Code: "ultracode"-Schlüsselwort voranstellen (Multi-Agent-Orchestrierung in Claude Code). */
  ultracode?: boolean;
  /** Bildmodus des Chats: Bild-Engine (z. B. "gpt-image", "nano-banana", "ollama:<modell>") – leer = aus. */
  imageGen?: string;
  /** Claude Code: Eingabe per stream-json, damit Nachrichten auch während eines Laufs zugestellt werden können (Standard: an). */
  liveInput?: boolean;
}

export interface ResumeInfo {
  sessionId?: string;
  continueLast?: boolean;
  fork?: boolean;
}

/** Im Arbeitsspeicher gehaltener Anhang (z. B. eingefügter Screenshot) – wird nicht dauerhaft gespeichert. */
export interface Attachment { id: string; name: string; mime: string; /** Base64 ohne Präfix */ data: string }

export interface RunRequest {
  modelProjectId?: string;
  runId: string;
  provider: ProviderId;
  prompt: string;
  cwd: string;
  options: ProviderOptions;
  resume?: ResumeInfo;
  images?: string[];
  /** Direkt mitgesendete Anhänge (nur im Speicher; die CLIs bekommen sie, wenn möglich ohne Datei, sonst als kurzlebige Temp-Datei). */
  attachments?: Attachment[];
  /** Interaktiver Chat-Lauf: weitere Nachrichten dürfen mitten im Lauf zugestellt werden (wenn der Anbieter es kann). */
  live?: boolean;
  /** Bisheriger Verlauf für Anbieter ohne eigene Session (Ollama-Chat über die HTTP-API). */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Bildgenerierung mit dieser Engine statt eines normalen Chat-Laufs (unabhängig vom Chat-Anbieter). */
  imageGen?: string;
  /** Nativer Codex-Review (`codex exec review`). */
  review?: { target: 'uncommitted' | 'base' | 'commit'; ref?: string };
}

export type HubEvent =
  | { type: 'model_project'; projectId: string }
  | { type: 'session'; sessionId: string }
  | { type: 'text'; delta: string }
  | { type: 'text_full'; text: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown; parentId?: string }
  | { type: 'tool_end'; id: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedTokens?: number; costUsd?: number; durationMs?: number; turns?: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  /** Erzeugtes Bild (in den App-Daten abgelegte Kopie). */
  | { type: 'image'; path: string; engine?: string }
  | { type: 'done'; ok: boolean; code?: number | null; error?: string };

export interface RunEnvelope {
  runId: string;
  event: HubEvent;
}

// ---- Multi-Agent ---------------------------------------------------------

export type AgentRole = 'planner' | 'worker' | 'reviewer' | 'researcher' | 'tester';
export type Strategy = 'plan-execute' | 'pipeline' | 'parallel' | 'debate' | 'review-loop';

export interface AgentSpec {
  id: string;
  name: string;
  provider: ProviderId;
  /** Lokales Modell aus der Registry (models.json). Gesetzt = der Agent denkt mit diesem Modell statt mit `provider`; er hat dann keine Werkzeuge und kann keine Dateien ändern. */
  localModel?: string;
  /** Statt eines festen Modells: der Hub wählt zur Laufzeit ein installiertes Modell mit dieser Fähigkeit. */
  capability?: Capability;
  role: AgentRole;
  instructions?: string;
  options: ProviderOptions;
}

export interface MultiConfig {
  strategy: Strategy;
  goal: string;
  cwd: string;
  agents: AgentSpec[];
  rounds: number;
  /** shared: alle im selben Ordner; worktree: je Agent ein git-Worktree (erlaubt Parallelität). */
  isolation: 'shared' | 'worktree';
  parallel: boolean;
  /** Agenten dürfen ohne Rückfrage Dateien ändern/Befehle ausführen. */
  autonomous: boolean;
  /** Sprache für Agenten-Antworten und Status. */
  lang?: 'de' | 'en';
}

export interface MultiStart {
  multiId: string;
  config: MultiConfig;
}

export type MultiEvent =
  | { type: 'stage_start'; stageId: string; label: string; agentIds: string[] }
  | { type: 'stage_end'; stageId: string }
  | { type: 'agent_start'; stageId: string; turnId: string; agentId: string; prompt: string; cwd: string }
  | { type: 'agent_event'; turnId: string; agentId: string; event: HubEvent }
  | { type: 'agent_end'; turnId: string; agentId: string; ok: boolean; output: string }
  | { type: 'plan'; tasks: PlanTask[] }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'finished'; ok: boolean; summary: string };

export interface PlanTask {
  id: string;
  title: string;
  description: string;
  assignee: string;
  dependsOn: string[];
}

export interface MultiEnvelope {
  multiId: string;
  event: MultiEvent;
}

// ---- Provider-Infos ----------------------------------------------------------

export interface SpeedTier { id: string; name: string; description: string }

export interface ModelInfo {
  id: string;
  label: string;
  efforts?: string[];
  speedTiers?: SpeedTier[];
  legacy?: boolean;
  effortModels?: Record<string, string>;
  group?: string;
  /** Modell erzeugt Bilder (z. B. Ollama-Bildmodelle). */
  image?: boolean;
  /** Image route shown in the common model picker; never sent as a text-model ID. */
  imageEngine?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  installed: boolean;
  path?: string;
  version?: string;
  models: ModelInfo[];
  error?: string;
}

export interface CliCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  files: { path: string; status: string }[];
}

// ---- Persistenz ----------------------------------------------------------------

export type Block =
  | { kind: 'model'; projectId: string }
  | { kind: 'text'; text: string }
  /** Direkt zugestellte Nutzernachricht mitten im Lauf. */
  | { kind: 'inject'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'image'; path: string; engine?: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; output?: string; isError?: boolean; running: boolean; parentId?: string };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  provider?: ProviderId;
  agentId?: string;
  blocks: Block[];
  images?: string[];
  createdAt: number;
  usage?: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; costUsd?: number; durationMs?: number; turns?: number };
  error?: string;
}

export interface ChatSession {
  modeSettings?: Partial<Record<ChatMode, { provider: ProviderId; options: ProviderOptions }>>;
  modelProjectId?: string;
  id: string;
  title: string;
  cwd: string;
  provider: ProviderId;
  options: ProviderOptions;
  /** Provider-seitige Session-ID je CLI, damit "weiter" funktioniert. */
  providerSessions: Partial<Record<ProviderId, string>>;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

export interface MultiTurn {
  turnId: string;
  stageId: string;
  agentId: string;
  prompt: string;
  cwd: string;
  message: Message;
  ok?: boolean;
  running: boolean;
}

export interface MultiStage {
  stageId: string;
  label: string;
  agentIds: string[];
  done: boolean;
}

export interface MultiRunRecord {
  id: string;
  title: string;
  config: MultiConfig;
  status: 'idle' | 'running' | 'done' | 'failed' | 'stopped';
  stages: MultiStage[];
  turns: MultiTurn[];
  plan: PlanTask[];
  log: { level: 'info' | 'warn' | 'error'; text: string; at: number }[];
  summary?: string;
  createdAt: number;
  updatedAt: number;
}

export type PanelId = 'terminal' | 'files' | 'agents' | 'changes';
export type DockPos = 'left' | 'right' | 'top' | 'bottom';

export interface DockState {
  panels: Record<PanelId, { visible: boolean; pos: DockPos }>;
  sizes: Record<DockPos, number>;
}

export interface FsEntry { name: string; isDir: boolean }

export interface TerminalStyle {
  /** 'app' = Farben der App übernehmen, sonst ein Preset aus TERMINAL_THEMES. */
  theme: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  scrollback: number;
}

export interface ThreeDSettings {
  preferredTool?: 'blockbench' | 'blender';
  defaultExportFormat?: 'glb' | 'gltf' | 'obj' | 'fbx';
  autoExport?: boolean;
}

export type ChatGroupBy = 'project' | 'date' | 'provider' | 'mode' | 'none';
export type ChatSortBy = 'updated' | 'created' | 'title' | 'messages';
export type ChatSortOrder = 'desc' | 'asc';

export interface ChatListSettings {
  groupBy?: ChatGroupBy;
  sortBy?: ChatSortBy;
  sortOrder?: ChatSortOrder;
}

export interface Settings {
  sidebarPinned: boolean;
  showOlderModels?: boolean;
  showUsageInComposer?: boolean;
  customModels?: Partial<Record<ProviderId, string[]>>;
  llamaBinary?: string;
  ollama?: { host?: string; binary?: string; mode?: 'local' | 'api' };
  apiConnections?: import('./connections').ApiConnection[];
  localRuntime?: { idleMinutes?: number; cpuFallback?: boolean; vramReserveMb?: number };
  terminal: TerminalStyle;
  /** Globaler Hotkey für das Schnell-Prompt-Fenster (Electron-Accelerator). */
  quickHotkey: string;
  dock: DockState;
  theme: 'dark' | 'light';
  language: 'de' | 'en';
  autoImport: boolean;
  accent: string;
  defaultProvider: ProviderId;
  defaultCwd: string;
  binaries: Partial<Record<ProviderId, string>>;
  providerDefaults: Record<ProviderId, ProviderOptions>;
  updateChannel: UpdateChannel;
  autoCheckUpdate: boolean;
  threed?: ThreeDSettings;
  chatList?: ChatListSettings;
}

export interface Persisted {
  version: 1;
  settings: Settings;
  recentProjects: string[];
  /** Vom Nutzer angelegte Projekte (Ordnerpfade); Projekte mit Chats kommen zusätzlich aus den Sessions. */
  projects: string[];
  /** Gelöschte Projekte: ihre Chats bleiben gespeichert, werden aber ausgeblendet. */
  hidden: string[];
  /** Provider-Sessions ("anbieter:id"), die nicht automatisch importiert werden (gelöschte oder vom Hub selbst erzeugte). */
  dismissed: string[];
  sessions: ChatSession[];
  multiRuns: MultiRunRecord[];
  presets: { id: string; name: string; config: Omit<MultiConfig, 'goal' | 'cwd'> }[];
}

// ---- Import bestehender CLI-Sessions --------------------------------------------------------------

export interface ImportEntry {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  file: string;
}

export interface ImportedSession {
  entry: ImportEntry;
  messages: Message[];
}

// ---- Nutzung ------------------------------------------------------------------------------------

export interface UsageTokens { input: number; output: number; cached: number; sessions: number }

export interface RateWindow { used_percent: number; window_minutes: number; resets_at: number }

/** Ein Limit-Balken aus `/usage`. kind: "remaining" = Prozent sind noch verfügbar, "used" = bereits verbraucht. */
export interface UsageMeter { label: string; percent: number; reset?: string; group?: string; kind: 'used' | 'remaining' }

/** Ergebnis von `/usage` aus der interaktiven CLI (Claude Code, Antigravity). */
export interface CliUsage { provider: 'claude' | 'antigravity'; ok: boolean; meters: UsageMeter[]; raw: string; error?: string; at: number }

export interface UsageReport {
  days: { date: string; claude: UsageTokens; codex: UsageTokens }[];
  codexLimits: { plan: string | null; primary: RateWindow; secondary: RateWindow | null; credits: { has_credits: boolean; unlimited: boolean; balance: string } | null; at: number } | null;
}

// ---- Updater & GitHub Releases ----------------------------------------------------

export type UpdateChannel = 'release' | 'beta' | 'dev';

export interface UpdateAsset {
  name: string;
  downloadUrl: string;
  size: number;
  contentType: string;
}

export interface UpdateInfo {
  version: string;
  tag: string;
  channel: UpdateChannel;
  name: string;
  notes: string;
  publishedAt: string;
  asset?: UpdateAsset;
}

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  channel: UpdateChannel;
  updateInfo?: UpdateInfo;
  progress?: UpdateProgress;
  error?: string;
  downloadPath?: string;
  lastChecked?: number;
}
