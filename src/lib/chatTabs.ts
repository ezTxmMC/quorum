import { create } from 'zustand';

// Je Fenster eigene Tabs: sessionStorage gilt pro Fenster und übersteht ein Neuladen der Oberfläche.
const STORAGE_KEY = 'quorum.chat.tabs';

function stored(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

interface ChatTabs {
  tabs: string[];
  /** Der angezeigte Chat hat gewechselt: ist er kein Tab, übernimmt er den Platz des bisher aktiven Tabs. */
  visit: (id: string, previous: string | undefined) => void;
  /** Öffnet den Chat als eigenen Tab rechts neben dem aktiven. */
  open: (id: string, active: string | undefined) => void;
  close: (id: string) => void;
  /** Entfernt Tabs gelöschter Chats. */
  prune: (existing: Set<string>) => void;
}

export const useChatTabs = create<ChatTabs>((set) => {
  const update = (change: (tabs: string[]) => string[]) => set((state) => {
    const tabs = change(state.tabs);
    if (tabs === state.tabs) {
      return state;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    return { tabs };
  });
  return {
    tabs: stored(),
    visit(id, previous) {
      update((tabs) => {
        if (tabs.includes(id)) {
          return tabs;
        }
        const slot = previous ? tabs.indexOf(previous) : -1;
        if (slot < 0) {
          return [...tabs, id];
        }
        return tabs.map((entry, index) => (index === slot ? id : entry));
      });
    },
    open(id, active) {
      update((tabs) => {
        if (tabs.includes(id)) {
          return tabs;
        }
        // Der gerade angezeigte Chat wird beim ersten weiteren Tab selbst zum Tab.
        const base = active && !tabs.includes(active) ? [...tabs, active] : tabs;
        const slot = active ? base.indexOf(active) : base.length - 1;
        return [...base.slice(0, slot + 1), id, ...base.slice(slot + 1)];
      });
    },
    close(id) {
      update((tabs) => (tabs.includes(id) ? tabs.filter((entry) => entry !== id) : tabs));
    },
    prune(existing) {
      update((tabs) => (tabs.every((entry) => existing.has(entry)) ? tabs : tabs.filter((entry) => existing.has(entry))));
    },
  };
});

/** Tab, der nach dem Schließen von `id` aktiv wird: der rechte Nachbar, sonst der linke. */
export function neighbourTab(tabs: string[], id: string): string | undefined {
  const index = tabs.indexOf(id);
  if (index < 0) {
    return undefined;
  }
  return tabs[index + 1] ?? tabs[index - 1];
}
