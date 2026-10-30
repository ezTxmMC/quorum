// Austausch zwischen Terminal (TUI) und App: die TUI legt abgeschlossene Turns als einzelne Dateien in den Posteingang,
// die App übernimmt sie in die Chats. Jede Datei hat genau einen Schreiber; das Anwenden ist idempotent (Nachrichten-IDs).
import type { ChatSession, Message, Persisted } from './types';

export interface InboxEntry {
  v: 1;
  chat: Pick<ChatSession, 'id' | 'title' | 'cwd' | 'provider' | 'options' | 'providerSessions' | 'createdAt'>;
  messages: Message[];
}

export function applyInbox(d: Persisted, e: InboxEntry): Persisted {
  const latest = Math.max(e.chat.createdAt, ...e.messages.map((m) => m.createdAt));
  const i = d.sessions.findIndex((s) => s.id === e.chat.id);
  const cwd = e.chat.cwd;
  const projects = !cwd || d.projects.includes(cwd) ? d.projects : [...d.projects, cwd];
  const hidden = d.hidden.filter((h) => h !== cwd);
  const recentProjects = !cwd ? d.recentProjects : [cwd, ...d.recentProjects.filter((p) => p !== cwd)].slice(0, 12);
  if (i < 0) {
    const s: ChatSession = { ...e.chat, messages: e.messages, updatedAt: latest };
    return { ...d, sessions: [s, ...d.sessions], projects, hidden, recentProjects };
  }
  const cur = d.sessions[i];
  const have = new Set(cur.messages.map((m) => m.id));
  const add = e.messages.filter((m) => !have.has(m.id));
  const sessionsChanged = Object.entries(e.chat.providerSessions).some(([k, v]) => cur.providerSessions[k as keyof typeof cur.providerSessions] !== v);
  if (!add.length && !sessionsChanged) return d;
  const next: ChatSession = { ...cur, messages: [...cur.messages, ...add], providerSessions: { ...cur.providerSessions, ...e.chat.providerSessions }, updatedAt: Math.max(cur.updatedAt, latest) };
  return { ...d, sessions: d.sessions.map((s, j) => (j === i ? next : s)), projects, hidden, recentProjects };
}
