import { chatMode } from '@shared/chat-modes';
import { useRef } from 'react';
import { create } from 'zustand';
import { DEFAULT_OPTIONS, DIRECT_MESSAGES, PROVIDERS, canonicalModel, defaultDock, defaultTerminal, isTextOnly, modelChoices, selectModelOptions } from '@shared/catalog';
import type {
  Attachment, ChatListSettings, CliUsage, DockPos, ImportedSession, ChatSession, HubEvent, PanelId, Message, MultiConfig, MultiEvent, MultiRunRecord, Persisted, ProviderId, ProviderOptions, ProviderStatus, RunRequest, UpdateChannel, UpdateState,
} from '@shared/types';
import { hub, uid } from './api';
import { queryCliUsage } from './cliUsage';
import { applyEvent, messageText } from './reduce';

interface RunRoute { sessionId: string; messageId: string; provider: ProviderId }

interface State {
  ready: boolean;
  /** Projektordner des aktuell angezeigten Chats/Teams – Terminal, Dateien und Änderungen beziehen sich darauf. */
  activeCwd: string;
  settingsTab: string | null;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  setActiveCwd: (cwd: string) => void;
  applyRemote: (d: Persisted) => void;
  togglePanel: (id: PanelId) => void;
  /** Panel, das gerade als schwebende Insel im Vollbild angezeigt wird (nicht persistent). */
  maximizedPanel: PanelId | null;
  setMaximizedPanel: (id: PanelId | null) => void;
  movePanel: (id: PanelId, pos: DockPos) => void;
  resizeDock: (pos: DockPos, size: number) => void;
  data: Persisted;
  statuses: Partial<Record<ProviderId, ProviderStatus>>;
  runs: Record<string, RunRoute>; // runId -> Ziel
  init: () => Promise<void>;
  refreshStatus: (id: ProviderId, force?: boolean) => Promise<void>;

  setSettings: (patch: Partial<Persisted['settings']>) => void;
  setProviderDefaults: (id: ProviderId, patch: ProviderOptions) => void;
  touchProject: (cwd: string) => void;
  addProject: (cwd: string) => void;
  removeProject: (cwd: string) => void;
  moveProject: (from: string, to: string) => void;
  moveSession: (id: string, to: string) => void;
  restoreProject: (cwd: string) => void;

  newSession: (init?: Partial<ChatSession>, fresh?: boolean) => string;
  patchSession: (id: string, patch: Partial<ChatSession>) => void;
  deleteSession: (id: string) => void;
  importSessions: (items: ImportedSession[]) => void;
  autoImport: () => Promise<void>;
  /** Zuletzt gelesene Limits aus /usage (Claude Code, Antigravity) – wird im Hintergrund aktualisiert. */
  cliUsage: Partial<Record<'claude' | 'antigravity', CliUsage>>;
  cliUsageBusy: Partial<Record<'claude' | 'antigravity', boolean>>;
  refreshCliUsage: (p?: 'claude' | 'antigravity') => Promise<void>;
  send: (sessionId: string, text: string, opts?: { images?: string[]; attachments?: Attachment[]; review?: RunRequest['review']; continueLast?: boolean; fork?: boolean }) => void;
  cancel: (sessionId: string) => void;
  isRunning: (sessionId: string) => boolean;
  /** Nachrichten, die auf das Ende des laufenden Laufs warten (je Chat). */
  queued: Record<string, { id: string; text: string; images?: string[]; attachments?: Attachment[] }[]>;
  /** Sendet auch während eines Laufs: direkt zustellen (wenn der Anbieter es kann) oder einreihen. */
  submit: (sessionId: string, text: string, opts?: { images?: string[]; attachments?: Attachment[]; mode?: 'direct' | 'queue' }) => Promise<void>;
  unqueue: (sessionId: string, id: string) => void;
  /** Chat-Optionen (Seitenpanel) – wird in der Titelleiste umgeschaltet. */
  chatOptionsOpen: boolean;
  toggleChatOptions: (v?: boolean) => void;

  createMulti: (config: MultiConfig, title?: string) => string;
  startMulti: (id: string) => void;
  stopMulti: (id: string) => void;
  patchMulti: (id: string, patch: Partial<MultiRunRecord>) => void;
  deleteMulti: (id: string) => void;
  savePreset: (name: string, config: MultiConfig) => void;
  deletePreset: (id: string) => void;

  updaterState: UpdateState;
  checkUpdate: (channel?: UpdateChannel) => Promise<UpdateState>;
  downloadUpdate: () => Promise<boolean>;
  installUpdate: () => Promise<boolean>;
  setChatListSettings: (patch: Partial<ChatListSettings>) => void;
  /** Verlauf des Chats vom aktuellen Modell zusammenfassen lassen und durch die Zusammenfassung ersetzen. */
  compact: (sessionId: string) => Promise<void>;
  compacting: Record<string, boolean>;
  /** Kurze Hinweise über dem Eingabefeld (z. B. Wechsel auf ein Ausweich-Modell, Fehler beim Kompaktieren). */
  banners: Record<string, { kind: 'info' | 'error'; text: string }>;
  setBanner: (sessionId: string, banner: { kind: 'info' | 'error'; text: string } | null) => void;
  /** Bei erreichtem Limit: zum nächsten Ausweich-Modell wechseln und die letzte Anfrage wiederholen. */
  switchToFallback: (sessionId: string) => boolean;
}

const emptyData = (): Persisted => ({
  version: 1,
  settings: {
    theme: 'dark', language: navigator.language.startsWith('de') ? 'de' : 'en', autoImport: true, sidebarPinned: true, quickHotkey: 'CommandOrControl+Shift+Space', dock: defaultDock(), terminal: defaultTerminal(), accent: '#7c8cff', defaultProvider: 'claude', defaultCwd: '', binaries: {},
    providerDefaults: { claude: { ...DEFAULT_OPTIONS.claude }, codex: { ...DEFAULT_OPTIONS.codex }, antigravity: { ...DEFAULT_OPTIONS.antigravity }, opencode: {}, ollama: {}, local: {}, api: {} },
    updateChannel: 'release', autoCheckUpdate: true,
    threed: { preferredTool: 'blockbench', defaultExportFormat: 'glb', autoExport: true },
    chatList: { groupBy: 'project', sortBy: 'updated', sortOrder: 'desc' },
  },
  recentProjects: [], projects: [], hidden: [], dismissed: [], sessions: [], multiRuns: [], presets: [],
});

const titleOf = (t: string) => (t.replace(/\s+/g, ' ').trim().slice(0, 56) || 'Neuer Chat');

/** Wenn zwischen Anbietern gewechselt wird, bekommt der neue Anbieter den bisherigen Verlauf als Kontext. */
function contextPreamble(s: ChatSession): string {
  const lines: string[] = [];
  for (const m of s.messages.slice(-12)) {
    const t = messageText(m);
    if (!t) continue;
    if (m.role === 'system') { lines.push(`Zusammenfassung des früheren Verlaufs: ${t}`); continue; }
    lines.push(`${m.role === 'user' ? 'Nutzer' : `Assistent (${m.provider ?? '?'})`}: ${t.length > 1800 ? t.slice(0, 1800) + '…' : t}`);
  }
  if (!lines.length) return '';
  return `[Bisheriger Gesprächsverlauf mit einem anderen Assistenten – nur als Kontext:]\n${lines.join('\n\n')}\n\n[Aktuelle Nachricht des Nutzers:]\n`;
}

/** Läufe ohne Chat-Ziel (z. B. Zusammenfassung beim Kompaktieren): Events gehen direkt an den Sammler. */
const collectors = new Map<string, (e: HubEvent) => void>();
/** Fehlertexte, die auf ein erreichtes Nutzungs-/Ratenlimit hindeuten. */
const LIMIT_RE = /usage limit|rate.?limit|limit (has been )?(reached|exceeded)|hit your (usage )?limit|out of (extra )?usage|quota|exceeded|too many requests|\b429\b|resource.?exhausted|insufficient[_ ]credits?|credit balance|overloaded|billing/i;

let autoImporting = false;
let lastRemote: Persisted | null = null;
const localMultiIds = new Set<string>();

export const useHub = create<State>((set, get) => {
  const mutData = (fn: (d: Persisted) => Persisted) => set((s) => ({ data: fn(s.data) }));
  const mutSession = (id: string, fn: (s: ChatSession) => ChatSession) =>
    mutData((d) => ({ ...d, sessions: d.sessions.map((s) => (s.id === id ? fn(s) : s)) }));
  const mutMulti = (id: string, fn: (r: MultiRunRecord) => MultiRunRecord) =>
    mutData((d) => ({ ...d, multiRuns: d.multiRuns.map((r) => (r.id === id ? { ...fn(r), updatedAt: Date.now() } : r)) }));

  return {
    ready: false,
    activeCwd: '',
    settingsTab: null,
    openSettings: (tab = 'general') => set({ settingsTab: tab }),
    closeSettings: () => set({ settingsTab: null }),
    setActiveCwd: (cwd) => { if (get().activeCwd !== cwd) set({ activeCwd: cwd }); },
    data: emptyData(),
    statuses: {},
    runs: {},

    async init() {
      const data = await hub.load();
      data.projects ??= [];
      data.hidden ??= [];
      // Migration: der ChatGPT-Anbieter wurde entfernt – alte ChatGPT-Chats bleiben lesbar und laufen mit dem Standard-Anbieter weiter.
      const gone = (p: string) => p === 'chatgpt';
      const fallback: ProviderId = gone(data.settings.defaultProvider) ? 'claude' : data.settings.defaultProvider;
      if (gone(data.settings.defaultProvider)) data.settings.defaultProvider = 'claude';
      delete (data.settings.providerDefaults as Record<string, unknown>).chatgpt;
      delete (data.settings.binaries as Record<string, unknown>).chatgpt;
      data.sessions = data.sessions.map((s) => (gone(s.provider)
        ? { ...s, provider: fallback, options: { ...data.settings.providerDefaults[fallback] }, messages: s.messages.map((m) => (m.provider && gone(m.provider) ? { ...m, provider: undefined } : m)) }
        : s));
      data.settings.providerDefaults.opencode ??= {};
      data.settings.providerDefaults.ollama ??= {};
      data.settings.sidebarPinned ??= true;
      data.settings.quickHotkey ??= 'CommandOrControl+Shift+Space';
      data.settings.dock = { panels: { ...defaultDock().panels, ...data.settings.dock?.panels }, sizes: { ...defaultDock().sizes, ...data.settings.dock?.sizes } };
      data.dismissed ??= [];
      data.settings.terminal = { ...defaultTerminal(), ...data.settings.terminal };
      data.settings.autoImport ??= true;
      // Migration: Antigravity-Modus "accept-edits" lehnt Shell-Befehle headless ab -> neuer Standard.
      const mig = (o: { permission?: string }) => { if (o.permission === 'accept-edits') o.permission = 'allow-commands'; };
      mig(data.settings.providerDefaults.antigravity);
      data.sessions.forEach((s) => { if (s.provider === 'antigravity') mig(s.options); });
      // Beim Start hängende "laufende" Zustände bereinigen.
      data.sessions = data.sessions.filter((x) => x.messages.length > 0);
      data.multiRuns = data.multiRuns.map((r) => (r.status === 'running' ? { ...r, status: 'stopped', turns: r.turns.map((t) => ({ ...t, running: false })) } : r));
      set({ data, ready: true });
      (['claude', 'codex', 'antigravity', 'opencode', 'ollama', 'local', 'api'] as ProviderId[]).forEach((id) => void get().refreshStatus(id));
    },

    async refreshStatus(id, force) {
      const st = await hub.providerStatus(id, force);
      set((s) => ({ statuses: { ...s.statuses, [id]: st } }));
    },

    applyRemote(remote) {
      // Änderungen aus einem anderen Fenster übernehmen – laufende lokale Läufe dabei nicht überschreiben.
      lastRemote = remote;
      set((st) => {
        const running = new Set(Object.values(st.runs).map((r) => r.sessionId));
        const local = new Map(st.data.sessions.filter((s) => running.has(s.id)).map((s) => [s.id, s]));
        const sessions = remote.sessions.map((s) => local.get(s.id) ?? s);
        for (const [id, s] of local) if (!sessions.some((x) => x.id === id)) sessions.unshift(s);
        const localMulti = new Map(st.data.multiRuns.filter((r) => localMultiIds.has(r.id) && r.status === 'running').map((r) => [r.id, r]));
        const multiRuns = remote.multiRuns.map((r) => localMulti.get(r.id) ?? r);
        return { data: { ...remote, sessions, multiRuns } };
      });
    },
    maximizedPanel: null,
    setMaximizedPanel: (id) => set({ maximizedPanel: id }),
    togglePanel(id) {
      if (get().maximizedPanel === id) set({ maximizedPanel: null });
      mutData((d) => ({ ...d, settings: { ...d.settings, dock: { ...d.settings.dock, panels: { ...d.settings.dock.panels, [id]: { ...d.settings.dock.panels[id], visible: !d.settings.dock.panels[id].visible } } } } }));
    },
    movePanel(id, pos) {
      mutData((d) => ({ ...d, settings: { ...d.settings, dock: { ...d.settings.dock, panels: { ...d.settings.dock.panels, [id]: { ...d.settings.dock.panels[id], pos, visible: true } } } } }));
    },
    resizeDock(pos, size) {
      mutData((d) => ({ ...d, settings: { ...d.settings, dock: { ...d.settings.dock, sizes: { ...d.settings.dock.sizes, [pos]: Math.round(size) } } } }));
    },
    setSettings(patch) { mutData((d) => ({ ...d, settings: { ...d.settings, ...patch } })); },
    setProviderDefaults(id, patch) {
      mutData((d) => ({ ...d, settings: { ...d.settings, providerDefaults: { ...d.settings.providerDefaults, [id]: { ...d.settings.providerDefaults[id], ...patch } } } }));
    },
    touchProject(cwd) {
      if (!cwd) return;
      mutData((d) => ({ ...d, recentProjects: [cwd, ...d.recentProjects.filter((p) => p !== cwd)].slice(0, 12) }));
    },

    newSession(init, fresh) {
      // Ein leerer Chat (noch kein Prompt) wird wiederverwendet statt einen weiteren anzulegen.
      const empty = fresh ? undefined : get().data.sessions.find((x) => x.messages.length === 0);
      if (empty) {
        if (init?.cwd) get().addProject(init.cwd);
        if (init) mutSession(empty.id, (x) => ({ ...x, ...init, options: { ...(init.provider && init.provider !== x.provider ? { ...get().data.settings.providerDefaults[init.provider], chatMode: 'text' as const } : x.options), ...init.options } }));
        return empty.id;
      }
      const { settings } = get().data;
      const provider = init?.provider ?? settings.defaultProvider;
      const s: ChatSession = {
        id: uid(), title: 'Neuer Chat', cwd: init?.cwd ?? '', provider,
        providerSessions: {}, messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...init,
        options: { ...settings.providerDefaults[provider], chatMode: 'text', ...init?.options },
      };
      mutData((d) => ({ ...d, sessions: [s, ...d.sessions] }));
      return s.id;
    },
    addProject(cwd) {
      if (cwd) mutData((d) => ({ ...d, hidden: d.hidden.filter((h) => h !== cwd), projects: d.projects.includes(cwd) ? d.projects : [...d.projects, cwd] }));
    },
    /** Ordner eines Projekts ändern: alle Chats des Projekts ziehen um. Die CLI-Sessions hängen am alten Ordner, deshalb starten sie neu (Verlauf bleibt im Hub). */
    moveProject(from, to) {
      if (!to || from === to) return;
      mutData((d) => ({
        ...d,
        projects: [...new Set(d.projects.map((p) => (p === from ? to : p)).concat(to))],
        hidden: d.hidden.filter((h) => h !== to),
        sessions: d.sessions.map((s) => (s.cwd === from ? { ...s, cwd: to, providerSessions: {} } : s)),
      }));
    },
    /** Ordner eines einzelnen Chats ändern (landet damit im anderen Projekt). */
    moveSession(id, to) {
      if (!to) return;
      get().addProject(to);
      mutSession(id, (s) => (s.cwd === to ? s : { ...s, cwd: to, providerSessions: {} }));
    },
    removeProject(cwd) { mutData((d) => ({ ...d, projects: d.projects.filter((p) => p !== cwd), hidden: d.hidden.includes(cwd) ? d.hidden : [...d.hidden, cwd] })); },
    restoreProject(cwd) { get().addProject(cwd); },
    patchSession(id, patch) { mutSession(id, (s) => ({ ...s, ...patch })); },
    deleteSession(id) {
      get().cancel(id);
      // Gelöschte Chats nicht wieder automatisch importieren.
      mutData((d) => {
        const s = d.sessions.find((x) => x.id === id);
        const keys = s ? Object.entries(s.providerSessions).map(([p, sid]) => `${p}:${sid}`) : [];
        return { ...d, dismissed: [...new Set([...d.dismissed, ...keys])], sessions: d.sessions.filter((x) => x.id !== id) };
      });
    },

    importSessions(items) {
      mutData((d) => {
        const have = new Set(d.sessions.flatMap((s) => Object.entries(s.providerSessions).map(([p, id]) => `${p}:${id}`)));
        const added: ChatSession[] = items.filter((i) => !have.has(`${i.entry.provider}:${i.entry.sessionId}`)).map((i) => ({
          id: uid(), title: i.entry.title, cwd: i.entry.cwd, provider: i.entry.provider, options: { ...d.settings.providerDefaults[i.entry.provider] },
          providerSessions: { [i.entry.provider]: i.entry.sessionId }, messages: i.messages,
          createdAt: i.messages[0]?.createdAt ?? i.entry.updatedAt, updatedAt: i.entry.updatedAt,
        }));
        return { ...d, sessions: [...d.sessions, ...added].sort((a, b) => b.updatedAt - a.updatedAt) };
      });
    },

    cliUsage: {},
    cliUsageBusy: {},
    async refreshCliUsage(only) {
      const targets = only ? [only] : (['claude', 'antigravity'] as const);
      for (const p of targets) {
        const st = get().statuses[p];
        if (!st?.installed || get().cliUsageBusy[p]) continue;
        set((s) => ({ cliUsageBusy: { ...s.cliUsageBusy, [p]: true } }));
        try {
          const res = await queryCliUsage(p, '');
          // Ein fehlgeschlagener Versuch überschreibt keine bereits gelesenen Werte.
          if (res.ok || !get().cliUsage[p]?.ok) set((s) => ({ cliUsage: { ...s.cliUsage, [p]: res } }));
        } finally { set((s) => ({ cliUsageBusy: { ...s.cliUsageBusy, [p]: false } })); }
      }
    },
    async autoImport() {
      // Nicht während eigener Läufe importieren, damit Hub-Chats nicht doppelt auftauchen.
      if (autoImporting || !get().data.settings.autoImport || Object.keys(get().runs).length || get().data.multiRuns.some((r) => r.status === 'running')) return;
      autoImporting = true;
      try {
        const list = await hub.importList();
        const d = get().data;
        const known = new Set([...d.dismissed, ...d.sessions.flatMap((s) => Object.entries(s.providerSessions).map(([p, id]) => `${p}:${id}`))]);
        const fresh = list.filter((e) => !known.has(`${e.provider}:${e.sessionId}`));
        for (let i = 0; i < fresh.length; i += 10) get().importSessions(await hub.importLoad(fresh.slice(i, i + 10)));
      } catch { /* nächster Versuch beim nächsten Intervall */ } finally { autoImporting = false; }
    },

    isRunning: (sessionId) => Object.values(get().runs).some((r) => r.sessionId === sessionId),

    send(sessionId, text, opts = {}) {
      const s = get().data.sessions.find((x) => x.id === sessionId);
      if (!s || get().isRunning(sessionId)) return;
      const runId = uid();
      const userMsg: Message = { id: uid(), role: 'user', blocks: [{ kind: 'text', text }], images: [...(opts.images ?? []), ...(opts.attachments?.map((a) => a.name) ?? [])], createdAt: Date.now() };
      const asst: Message = { id: uid(), role: 'assistant', provider: s.provider, model: s.options.imageGen ? undefined : s.options.model, blocks: [], createdAt: Date.now() };
      const mode = chatMode(s.options);
      if (mode === 'model') {
        mutSession(sessionId, (x) => ({ ...x, title: x.messages.length === 0 ? titleOf(text) : x.title, messages: [...x.messages, userMsg, asst], updatedAt: Date.now() }));
        set((st) => ({ runs: { ...st.runs, [runId]: { sessionId, messageId: asst.id, provider: s.provider } } }));
        void hub.run({ runId, provider: s.provider, prompt: text, cwd: s.cwd, options: s.options, modelProjectId: s.modelProjectId, images: opts.images, attachments: opts.attachments });
        return;
      }
      if (mode === 'image' && !s.options.imageGen) return;
      // Bildmodus: Anfrage geht an die Bild-Engine; das zuletzt erzeugte Bild des Chats dient als Referenz für Änderungswünsche.
      if (s.options.imageGen) {
        const lastImage = [...s.messages].reverse().flatMap((m) => [...m.blocks].reverse()).find((b) => b.kind === 'image') as { path: string } | undefined;
        mutSession(sessionId, (x) => ({ ...x, title: x.messages.length === 0 ? titleOf(text) : x.title, messages: [...x.messages, userMsg, asst], updatedAt: Date.now() }));
        set((st) => ({ runs: { ...st.runs, [runId]: { sessionId, messageId: asst.id, provider: s.provider } } }));
        void hub.run({ runId, provider: s.provider, prompt: text, cwd: s.cwd, options: s.options, imageGen: s.options.imageGen, images: [...(lastImage ? [lastImage.path] : []), ...(opts.images ?? [])], attachments: opts.attachments });
        return;
      }
      const providerSession = s.providerSessions[s.provider];
      const isApi = isTextOnly(s.provider);
      const prompt = !isApi && !providerSession && !opts.continueLast && s.messages.length ? contextPreamble(s) + text : text;
      // Ollama-Chat (API) hat keine eigene Session: der Verlauf kommt aus dem Hub.
      const history = isApi ? s.messages.slice(-40).map((m) => ({ role: m.role === 'assistant' ? 'assistant' as const : 'user' as const, content: m.role === 'system' ? `[Zusammenfassung des früheren Verlaufs]\n${messageText(m)}` : messageText(m) })).filter((m) => m.content) : undefined;
      mutSession(sessionId, (x) => ({
        ...x, title: x.messages.length === 0 ? titleOf(text) : x.title, messages: [...x.messages, userMsg, asst], updatedAt: Date.now(),
      }));
      set((st) => ({ runs: { ...st.runs, [runId]: { sessionId, messageId: asst.id, provider: s.provider } } }));
      get().touchProject(s.cwd);
      void hub.run({
        runId, provider: s.provider, prompt, cwd: s.cwd, options: s.options, images: opts.images, attachments: opts.attachments, review: opts.review, history, live: DIRECT_MESSAGES[s.provider] && s.options.liveInput !== false,
        resume: providerSession || opts.continueLast ? { sessionId: opts.continueLast ? undefined : providerSession, continueLast: opts.continueLast, fork: opts.fork } : undefined,
      });
    },

    cancel(sessionId) {
      // Stopp bricht auch die wartenden Nachrichten ab – sonst würde direkt die nächste starten.
      set((st) => ({ queued: { ...st.queued, [sessionId]: [] } }));
      for (const [runId, r] of Object.entries(get().runs)) if (r.sessionId === sessionId) void hub.cancel(runId);
    },

    queued: {},
    chatOptionsOpen: false,
    toggleChatOptions: (v) => set((st) => ({ chatOptionsOpen: v ?? !st.chatOptionsOpen })),
    unqueue(sessionId, id) { set((st) => ({ queued: { ...st.queued, [sessionId]: (st.queued[sessionId] ?? []).filter((q) => q.id !== id) } })); },
    async submit(sessionId, text, opts = {}) {
      const s = get().data.sessions.find((x) => x.id === sessionId);
      if (!s) return;
      if (!get().isRunning(sessionId)) { get().send(sessionId, text, { images: opts.images, attachments: opts.attachments }); return; }
      const route = Object.entries(get().runs).find(([, r]) => r.sessionId === sessionId);
      if ((chatMode(s.options) === 'text' || chatMode(s.options) === 'coding') && opts.mode === 'direct' && route && DIRECT_MESSAGES[s.provider] && s.options.liveInput !== false) {
        const full = opts.images?.length ? `${opts.images.map((p) => `@${p}`).join(' ')}\n\n${text}` : text;
        if (await hub.inject(route[0], full, opts.attachments)) {
          mutSession(sessionId, (x) => ({ ...x, messages: x.messages.map((m) => (m.id === route[1].messageId ? { ...m, blocks: [...m.blocks, { kind: 'inject' as const, text }] } : m)) }));
          return;
        }
      }
      set((st) => ({ queued: { ...st.queued, [sessionId]: [...(st.queued[sessionId] ?? []), { id: uid(), text, images: opts.images, attachments: opts.attachments }] } }));
    },

    createMulti(config, title) {
      const r: MultiRunRecord = {
        id: uid(), title: title ?? titleOf(config.goal), config, status: 'idle', stages: [], turns: [], plan: [], log: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      mutData((d) => ({ ...d, multiRuns: [r, ...d.multiRuns] }));
      return r.id;
    },
    startMulti(id) {
      const r = get().data.multiRuns.find((x) => x.id === id);
      if (!r) return;
      localMultiIds.add(id);
      mutMulti(id, (x) => ({ ...x, status: 'running', stages: [], turns: [], plan: [], log: [], summary: undefined }));
      get().touchProject(r.config.cwd);
      void hub.multiStart({ multiId: id, config: r.config });
    },
    stopMulti(id) { void hub.multiStop(id); },
    patchMulti(id, patch) { mutMulti(id, (r) => ({ ...r, ...patch })); },
    deleteMulti(id) {
      if (get().data.multiRuns.find((r) => r.id === id)?.status === 'running') void hub.multiStop(id);
      mutData((d) => ({ ...d, multiRuns: d.multiRuns.filter((r) => r.id !== id) }));
    },
    savePreset(name, config) {
      const { goal: _g, cwd: _c, ...rest } = config;
      mutData((d) => ({ ...d, presets: [...d.presets, { id: uid(), name, config: rest }] }));
    },
    deletePreset(id) { mutData((d) => ({ ...d, presets: d.presets.filter((p) => p.id !== id) })); },

    updaterState: { status: 'idle', currentVersion: '1.0.0', channel: 'release' },
    async checkUpdate(channel) {
      const ch = channel ?? get().data.settings.updateChannel ?? 'release';
      return hub.updaterCheck(ch);
    },
    async downloadUpdate() {
      return hub.updaterDownload();
    },
    async installUpdate() {
      return hub.updaterInstall();
    },
    compacting: {},
    banners: {},
    setBanner(sessionId, banner) {
      set((st) => {
        const { [sessionId]: _old, ...rest } = st.banners;
        return { banners: banner ? { ...rest, [sessionId]: banner } : rest };
      });
    },
    async compact(sessionId) {
      const s = get().data.sessions.find((x) => x.id === sessionId);
      if (!s || get().isRunning(sessionId) || get().compacting[sessionId]) return;
      const mode = chatMode(s.options);
      if (mode === 'image' || mode === 'model') return;
      const body = s.messages.filter((m) => messageText(m));
      if (body.length < 4) { get().setBanner(sessionId, { kind: 'info', text: 'Der Verlauf ist noch zu kurz zum Kompaktieren.' }); return; }
      get().setBanner(sessionId, null);
      set((st) => ({ compacting: { ...st.compacting, [sessionId]: true } }));
      const en = get().data.settings.language === 'en';
      // Neueste Nachrichten zuerst auswählen, damit bei sehr langen Chats das Aktuelle erhalten bleibt.
      let budget = 90_000;
      const parts: string[] = [];
      for (const m of [...body].reverse()) {
        let t = messageText(m);
        if (t.length > 6000) t = t.slice(0, 3500) + ' […] ' + t.slice(-2000);
        const tools = m.blocks.filter((b) => b.kind === 'tool').length;
        const line = `${m.role === 'user' ? (en ? 'User' : 'Nutzer') : m.role === 'system' ? (en ? 'Earlier summary' : 'Frühere Zusammenfassung') : (en ? 'Assistant' : 'Assistent')}: ${t}${tools ? ` [${tools} ${en ? 'tool calls' : 'Werkzeugaufrufe'}]` : ''}`;
        if (budget - line.length < 0 && parts.length) break;
        budget -= line.length;
        parts.unshift(line);
      }
      const intro = en
        ? "Summarize the following conversation so it can be continued in a fresh context without losing anything important. Keep: the user's goals, decisions made, files/paths/commands/identifiers mentioned, current state of the work, open tasks and constraints. Be dense and factual, use short bullet points, no preface. Do not use any tools."
        : 'Fasse die folgende Unterhaltung so zusammen, dass sie in einem frischen Kontext ohne Verlust des Wichtigen fortgesetzt werden kann. Behalte: Ziele des Nutzers, getroffene Entscheidungen, genannte Dateien/Pfade/Befehle/Bezeichner, aktuellen Arbeitsstand, offene Aufgaben und Rahmenbedingungen. Kompakt und sachlich, kurze Stichpunkte, keine Einleitung. Nutze keine Werkzeuge.';
      const prompt = [intro, en ? '--- CONVERSATION ---' : '--- UNTERHALTUNG ---', parts.join('\n\n')].join('\n\n');
      const runId = uid();
      const result = await new Promise<{ ok: boolean; text: string; error?: string }>((resolve) => {
        let text = '';
        collectors.set(runId, (e) => {
          if (e.type === 'text') text += e.delta;
          else if (e.type === 'text_full') text = e.text;
          else if (e.type === 'done') { collectors.delete(runId); resolve({ ok: e.ok && !!text.trim(), text: text.trim(), error: e.error }); }
        });
        void hub.run({ runId, provider: s.provider, prompt, cwd: '', options: { ...s.options, chatMode: 'text', imageGen: undefined }, history: isTextOnly(s.provider) ? [] : undefined }).catch((err) => {
          if (collectors.delete(runId)) resolve({ ok: false, text: '', error: String(err?.message ?? err) });
        });
      });
      set((st) => ({ compacting: { ...st.compacting, [sessionId]: false } }));
      if (!result.ok) { get().setBanner(sessionId, { kind: 'error', text: `${en ? 'Compacting failed' : 'Kompaktieren fehlgeschlagen'}${result.error ? `: ${result.error}` : ''}` }); return; }
      const cur = get().data.sessions.find((x) => x.id === sessionId);
      if (!cur) return;
      // Die letzten zwei Nachrichten bleiben wörtlich erhalten, alles davor wird durch die Zusammenfassung ersetzt.
      const keep = cur.messages.slice(-2).filter((m) => m.role !== 'system');
      const replaced = cur.messages.length - keep.length;
      const summary: Message = { id: uid(), role: 'system', provider: s.provider, blocks: [{ kind: 'text', text: result.text }], createdAt: Date.now(), usage: { turns: replaced } };
      mutSession(sessionId, (x) => ({ ...x, messages: [summary, ...keep], providerSessions: {}, updatedAt: Date.now() }));
      get().setBanner(sessionId, { kind: 'info', text: en ? `Conversation compacted: ${replaced} messages summarized.` : `Verlauf kompaktiert: ${replaced} Nachrichten zusammengefasst.` });
    },
    switchToFallback(sessionId) {
      const s = get().data.sessions.find((x) => x.id === sessionId);
      const next = s?.fallbacks?.[0];
      if (!s || !next || get().isRunning(sessionId)) return false;
      const last = s.messages.at(-1);
      const prev = s.messages.at(-2);
      if (last?.role !== 'assistant' || prev?.role !== 'user') return false;
      const text = messageText(prev);
      const statuses = get().statuses;
      const model = canonicalModel(next.provider, next.model) ?? next.model;
      const info = modelChoices(next.provider, statuses).find((m) => m.id === model);
      const base = next.provider === s.provider ? s.options : { ...get().data.settings.providerDefaults[next.provider], chatMode: chatMode(s.options) };
      const en = get().data.settings.language === 'en';
      const label = `${PROVIDERS[next.provider].name} · ${info?.label ?? model}`;
      // Die fehlgeschlagene Antwort samt Anfrage entfernen; send() legt die Anfrage mit dem neuen Modell neu an.
      mutSession(sessionId, (x) => ({
        ...x, provider: next.provider, options: selectModelOptions(base, model, info), fallbacks: x.fallbacks?.slice(1), messages: x.messages.slice(0, -2),
      }));
      get().setBanner(sessionId, { kind: 'info', text: en ? `Usage limit reached – continuing with ${label}.` : `Nutzungslimit erreicht – weiter mit ${label}.` });
      get().send(sessionId, text, { images: prev.images?.filter((p) => /[\\/]/.test(p)) });
      return true;
    },
    setChatListSettings(patch) {
      mutData((d) => ({
        ...d,
        settings: {
          ...d.settings,
          chatList: { ...d.settings.chatList, ...patch },
        },
      }));
    },
  };
});

// ---- Event-Verarbeitung (gebündelt pro Frame) --------------------------------------------------

type QItem = { kind: 'run'; runId: string; event: HubEvent } | { kind: 'multi'; multiId: string; event: MultiEvent };
let queue: QItem[] = [];
let scheduled = false;

function flush() {
  scheduled = false;
  const items = queue;
  queue = [];
  if (!items.length) return;
  const finished: string[] = []; // Chats, deren Lauf erfolgreich endete -> wartende Nachrichten starten
  const failed: string[] = []; // Chats, deren Lauf fehlschlug -> ggf. Ausweich-Modell
  useHub.setState((st) => {
    let data = st.data;
    let runs = st.runs;
    // Events je Lauf bündeln: jede Nachricht und die Sitzungsliste werden pro Flush nur einmal neu aufgebaut.
    const perRun = new Map<string, HubEvent[]>();
    for (const it of items) {
      if (it.kind === 'run') { const list = perRun.get(it.runId); if (list) list.push(it.event); else perRun.set(it.runId, [it.event]); }
      else data = applyMulti(data, it.multiId, it.event);
    }
    for (const [runId, events] of perRun) {
      const route = runs[runId];
      if (!route) continue;
      data = {
        ...data,
        sessions: data.sessions.map((s) => {
          if (s.id !== route.sessionId) return s;
          let next: ChatSession = s;
          let msg = s.messages.find((m) => m.id === route.messageId);
          if (!msg) return s;
          let providerSessions = s.providerSessions;
          let modelProjectId = s.modelProjectId;
          for (const ev of events) {
            msg = applyEvent(msg, ev);
            if (ev.type === 'model_project') modelProjectId = ev.projectId;
            if (ev.type === 'session') providerSessions = { ...providerSessions, [route.provider]: ev.sessionId };
          }
          const done = events.find((e) => e.type === 'done');
          const m2 = msg;
          // updatedAt nur am Ende ändern: sonst re-rendert die Sidebar bei jedem Token.
          next = { ...s, messages: s.messages.map((m) => (m.id === route.messageId ? m2 : m)), providerSessions, modelProjectId, updatedAt: done ? Date.now() : s.updatedAt };
          return next;
        }),
      };
      const done = events.find((e): e is Extract<HubEvent, { type: 'done' }> => e.type === 'done');
      if (done) {
        const { [runId]: _gone, ...rest } = runs; runs = rest;
        if (done.ok) finished.push(route.sessionId);
        else {
          const sess = data.sessions.find((x) => x.id === route.sessionId);
          const err = sess?.messages.find((m) => m.id === route.messageId)?.error ?? done.error ?? '';
          if (sess?.fallbacks?.length && LIMIT_RE.test(err)) failed.push(route.sessionId);
        }
      }
    }
    return { data, runs };
  });
  for (const sid of finished) {
    setTimeout(() => {
      const st = useHub.getState();
      const next = st.queued[sid]?.[0];
      if (!next || st.isRunning(sid)) return;
      useHub.setState({ queued: { ...st.queued, [sid]: st.queued[sid].slice(1) } });
      st.send(sid, next.text, { images: next.images, attachments: next.attachments });
    }, 0);
  }
  for (const sid of failed) setTimeout(() => { useHub.getState().switchToFallback(sid); }, 0);
}

function applyMulti(data: Persisted, multiId: string, e: MultiEvent): Persisted {
  const upd = (fn: (r: MultiRunRecord) => MultiRunRecord): Persisted => ({
    ...data, multiRuns: data.multiRuns.map((r) => (r.id === multiId ? { ...fn(r), updatedAt: Date.now() } : r)),
  });
  switch (e.type) {
    case 'stage_start': return upd((r) => ({ ...r, stages: [...r.stages, { stageId: e.stageId, label: e.label, agentIds: e.agentIds, done: false }] }));
    case 'stage_end': return upd((r) => ({ ...r, stages: r.stages.map((s) => (s.stageId === e.stageId ? { ...s, done: true } : s)) }));
    case 'plan': return upd((r) => ({ ...r, plan: e.tasks }));
    case 'agent_start':
      return upd((r) => {
        const agent = r.config.agents.find((a) => a.id === e.agentId);
        return {
          ...r,
          turns: [...r.turns, {
            turnId: e.turnId, stageId: e.stageId, agentId: e.agentId, prompt: e.prompt, cwd: e.cwd, running: true,
            message: { id: e.turnId, role: 'assistant', provider: agent?.provider, model: agent?.options.model, agentId: e.agentId, blocks: [], createdAt: Date.now() },
          }],
        };
      });
    case 'agent_event':
      if (e.event.type === 'session') {
        const prov = data.multiRuns.find((r) => r.id === multiId)?.config.agents.find((a) => a.id === e.agentId)?.provider;
        if (prov) data = { ...data, dismissed: [...data.dismissed, `${prov}:${e.event.sessionId}`] }; // vom Hub erzeugt – nicht als Chat importieren
      }
      return upd((r) => ({ ...r, turns: r.turns.map((t) => (t.turnId === e.turnId ? { ...t, message: applyEvent(t.message, e.event) } : t)) }));
    case 'agent_end': return upd((r) => ({ ...r, turns: r.turns.map((t) => (t.turnId === e.turnId ? { ...t, running: false, ok: e.ok } : t)) }));
    case 'log': return upd((r) => ({ ...r, log: [...r.log, { level: e.level, text: e.text, at: Date.now() }] }));
    case 'finished': return upd((r) => ({ ...r, status: r.status === 'stopped' ? 'stopped' : e.ok ? 'done' : 'failed', summary: e.summary, turns: r.turns.map((t) => ({ ...t, running: false })) }));
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  // ~20 Updates pro Sekunde reichen für flüssiges Streaming und halten Render-Last und Eingabe-Latenz niedrig.
  setTimeout(flush, 50);
}

export function wireEvents(): () => void {
  const a = hub.onRun((p) => {
    const collect = collectors.get(p.runId);
    if (collect) { collect(p.event); return; }
    queue.push({ kind: 'run', runId: p.runId, event: p.event }); schedule();
  });
  const b = hub.onMulti((p) => { queue.push({ kind: 'multi', multiId: p.multiId, event: p.event }); schedule(); });
  const c = hub.onUpdaterStatus((s) => useHub.setState({ updaterState: s }));
  const d = hub.onUpdaterProgress((p) => {
    useHub.setState((s) => ({ updaterState: { ...s.updaterState, status: 'downloading', progress: p } }));
  });
  void hub.updaterState().then((s) => { if (s) useHub.setState({ updaterState: s }); }).catch(() => {});
  return () => { a(); b(); c(); d(); };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveSlow = false;
export function wirePersistence(): () => void {
  const arm = (ms: number) => {
    saveSlow = ms > 1000;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      const run = () => void hub.save(useHub.getState().data);
      if ('requestIdleCallback' in window) (window as unknown as { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback(run, { timeout: 2000 });
      else run();
    }, ms);
  };
  return useHub.subscribe((s, prev) => {
    if (!s.ready) return;
    const busy = Object.keys(s.runs).length > 0;
    // Lauf beendet, aber ein langsamer Speichertimer aus der Streaming-Phase steht noch: jetzt zeitnah speichern.
    if (saveTimer && saveSlow && !busy) { clearTimeout(saveTimer); arm(700); return; }
    if (s.data === prev.data || s.data === lastRemote || (lastRemote && s.data.sessions === lastRemote.sessions && s.data.multiRuns === lastRemote.multiRuns && s.data.settings === lastRemote.settings)) return;
    // Drosselung statt Entprellung: Beim Streaming wird nur selten gespeichert (der Klon großer Daten über IPC blockiert die Oberfläche),
    // im Leerlauf fast sofort. Das eigentliche Speichern läuft, wenn der Browser Luft hat.
    if (saveTimer) return;
    arm(busy ? 15000 : 700);
  });
}

export const providerName = (id: ProviderId) => PROVIDERS[id].name;

/** Selektor mit eigener Gleichheitsprüfung: liefert die alte Referenz zurück, solange nichts Relevantes geändert ist (vermeidet Re-Renders beim Streaming). */
export function useHubEq<T>(select: (s: State) => T, equal: (a: T, b: T) => boolean): T {
  const ref = useRef<T | undefined>(undefined);
  return useHub((s) => {
    const v = select(s);
    if (ref.current !== undefined && equal(ref.current, v)) return ref.current;
    ref.current = v;
    return v;
  });
}
