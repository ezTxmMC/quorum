import { t } from '@/lib/i18n';
import { useDeferredValue, useMemo, useState } from 'react';
import type { ChatGroupBy, ChatMode, ChatSession, ChatSortBy, ChatSortOrder, MultiRunRecord, ProviderId } from '@shared/types';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { hub } from '@/lib/api';
import { useHub, useHubEq } from '@/lib/store';
import { searchChat } from '@/lib/chatSearch';
import { Icon } from '@/lib/icons';
import { ImportModal } from './ImportModal';
import { Collapse, MenuItem, Modal, Popover, ProviderMark, cx } from './ui';
import { PROVIDERS } from '@shared/catalog';
import { chatMode } from '@shared/chat-modes';

const nav = [
  { to: '/multi', icon: 'lucide:network', label: 'Multi-Agent' },
  { to: '/models', icon: 'lucide:box', label: 'Modelle' },
  { to: '/workflows', icon: 'lucide:workflow', label: 'Workflows' },
  { to: '/tools', icon: 'lucide:wrench', label: 'CLI-Werkzeuge' },
];

const GROUP_OPTIONS: { id: ChatGroupBy; label: string; icon: string }[] = [
  { id: 'project', label: 'Projekt', icon: 'lucide:folder' },
  { id: 'date', label: 'Datum', icon: 'lucide:calendar' },
  { id: 'provider', label: 'Anbieter', icon: 'lucide:bot' },
  { id: 'mode', label: 'Modus', icon: 'lucide:sparkles' },
  { id: 'none', label: 'Ohne Gruppierung', icon: 'lucide:list' },
];

const SORT_OPTIONS: { id: ChatSortBy; label: string; icon: string }[] = [
  { id: 'updated', label: 'Zuletzt aktualisiert', icon: 'lucide:clock' },
  { id: 'created', label: 'Erstellungsdatum', icon: 'lucide:calendar-plus' },
  { id: 'title', label: 'Titel', icon: 'lucide:a-large-small' },
  { id: 'messages', label: 'Anzahl Nachrichten', icon: 'lucide:message-square' },
];

// Während des Streamings ändern sich Nachrichten ständig – die Sidebar interessiert sich nur für diese Felder.
const sessionsEqual = (a: ChatSession[], b: ChatSession[]) =>
  a === b || (a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return x.id === y.id && x.title === y.title && x.cwd === y.cwd && x.provider === y.provider &&
      x.updatedAt === y.updatedAt && x.createdAt === y.createdAt &&
      (x.messages.length > 0) === (y.messages.length > 0) &&
      x.messages.length === y.messages.length &&
      x.options.chatMode === y.options.chatMode;
  }));
const multisEqual = (a: MultiRunRecord[], b: MultiRunRecord[]) =>
  a === b || (a.length === b.length && a.every((x, i) => { const y = b[i]; return x.id === y.id && x.title === y.title && x.status === y.status && x.config.agents.length === y.config.agents.length; }));

function ago(ts: number) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return t('jetzt');
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
}

function compareSessions(a: ChatSession, b: ChatSession, sortBy: ChatSortBy, sortOrder: ChatSortOrder): number {
  let diff = 0;
  if (sortBy === 'updated') {
    diff = a.updatedAt - b.updatedAt;
  } else if (sortBy === 'created') {
    diff = a.createdAt - b.createdAt;
  } else if (sortBy === 'title') {
    diff = a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
  } else if (sortBy === 'messages') {
    diff = a.messages.length - b.messages.length;
  }
  return sortOrder === 'asc' ? diff : -diff;
}

function getDateBucket(ts: number): { key: string; label: string; order: number } {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400_000;
  const startOf7Days = startOfToday - 6 * 86400_000;
  const startOf30Days = startOfToday - 29 * 86400_000;

  if (ts >= startOfToday) return { key: 'today', label: t('Heute'), order: 1 };
  if (ts >= startOfYesterday) return { key: 'yesterday', label: t('Gestern'), order: 2 };
  if (ts >= startOf7Days) return { key: 'last7', label: t('Letzte 7 Tage'), order: 3 };
  if (ts >= startOf30Days) return { key: 'last30', label: t('Letzte 30 Tage'), order: 4 };
  return { key: 'older', label: t('Älter'), order: 5 };
}

function getModeInfo(m: ChatMode): { label: string; icon: string } {
  switch (m) {
    case 'coding': return { label: 'Coding', icon: 'lucide:code-2' };
    case 'text': return { label: 'Text', icon: 'lucide:message-square' };
    case 'image': return { label: t('Bildgenerierung'), icon: 'lucide:image' };
    case 'model': return { label: t('3D-Modell'), icon: 'lucide:cuboid' };
    default: return { label: t('Chat'), icon: 'lucide:message-square' };
  }
}

interface ChatGroup {
  id: string;
  label: string;
  icon?: string;
  provider?: ProviderId;
  cwd?: string;
  action?: 'project' | 'provider' | 'mode';
  actionValue?: string;
  sessions: ChatSession[];
}

export function Sidebar({ pinned, onTogglePin, onClose }: { pinned?: boolean; onTogglePin?: () => void; onClose?: () => void } = {}) {
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim());
  const searching = query.length > 0;
  const allSessions = useHubEq((s) => s.data.sessions, search.trim() ? Object.is : sessionsEqual);
  const searchSessions = useDeferredValue(allSessions);
  // Chats erscheinen erst, nachdem der erste Prompt gesendet wurde.
  const hidden = useHub((s) => s.data.hidden);
  const matches = useMemo(() => {
    const results = new Map<string, { snippet?: string }>();
    if (!query) return results;
    for (const session of searchSessions) {
      if (!session.messages.length || hidden.includes(session.cwd)) continue;
      const result = searchChat(session, query);
      if (result) results.set(session.id, result);
    }
    return results;
  }, [searchSessions, hidden, query]);
  const sessions = (searching ? searchSessions : allSessions).filter((s) => s.messages.length > 0 && !hidden.includes(s.cwd) && (!searching || matches.has(s.id)));
  const [removing, setRemoving] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const projects = useHub((s) => s.data.projects);
  const chatListSettings = useHub((s) => s.data.settings.chatList);
  const groupBy: ChatGroupBy = chatListSettings?.groupBy ?? 'project';
  const sortBy: ChatSortBy = chatListSettings?.sortBy ?? 'updated';
  const sortOrder: ChatSortOrder = chatListSettings?.sortOrder ?? 'desc';
  const setChatListSettings = useHub((s) => s.setChatListSettings);
  const { addProject, removeProject, moveProject, moveSession, openSettings } = useHub.getState();

  const groups: ChatGroup[] = useMemo(() => {
    if (groupBy === 'none') {
      const sorted = [...sessions].sort((a, b) => compareSessions(a, b, sortBy, sortOrder));
      return [{ id: '__all', label: t('Alle Chats'), sessions: sorted }];
    }

    if (groupBy === 'project') {
      const map = new Map<string, ChatSession[]>();
      if (!searching) for (const p of projects) map.set(p, []);
      for (const s of sessions) map.set(s.cwd, [...(map.get(s.cwd) ?? []), s]);
      const latest = (l: ChatSession[]) => (l.length ? Math.max(...l.map((x) => x.updatedAt)) : 0);
      return [...map.entries()]
        .map(([cwd, list]) => ({
          id: cwd || '__none',
          cwd,
          label: cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : t('Ohne Projekt'),
          icon: cwd ? 'lucide:folder' : 'lucide:message-square-dashed',
          action: 'project' as const,
          actionValue: cwd,
          sessions: [...list].sort((a, b) => compareSessions(a, b, sortBy, sortOrder)),
        }))
        .sort((a, b) => {
          if (sortBy === 'title') {
            if (a.cwd === '') return 1;
            if (b.cwd === '') return -1;
            const cmp = a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });
            return sortOrder === 'asc' ? cmp : -cmp;
          }
          return a.cwd === '' ? 1 : b.cwd === '' ? -1 : latest(b.sessions) - latest(a.sessions);
        });
    }

    if (groupBy === 'date') {
      const buckets: Record<string, { label: string; order: number; list: ChatSession[] }> = {};
      for (const s of sessions) {
        const g = getDateBucket(sortBy === 'created' ? s.createdAt : s.updatedAt);
        if (!buckets[g.key]) buckets[g.key] = { label: g.label, order: g.order, list: [] };
        buckets[g.key].list.push(s);
      }
      return Object.entries(buckets)
        .sort(([, a], [, b]) => (sortOrder === 'asc' ? b.order - a.order : a.order - b.order))
        .map(([key, b]) => ({
          id: key,
          label: b.label,
          icon: 'lucide:calendar',
          sessions: [...b.list].sort((a, b) => compareSessions(a, b, sortBy, sortOrder)),
        }));
    }

    if (groupBy === 'provider') {
      const map = new Map<ProviderId, ChatSession[]>();
      for (const s of sessions) {
        map.set(s.provider, [...(map.get(s.provider) ?? []), s]);
      }
      return [...map.entries()]
        .map(([provider, list]) => ({
          id: provider,
          label: PROVIDERS[provider]?.name ?? provider,
          provider,
          action: 'provider' as const,
          actionValue: provider,
          sessions: [...list].sort((a, b) => compareSessions(a, b, sortBy, sortOrder)),
        }))
        .sort((a, b) => {
          if (sortBy === 'title') {
            const cmp = a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });
            return sortOrder === 'asc' ? cmp : -cmp;
          }
          return b.sessions.length - a.sessions.length;
        });
    }

    if (groupBy === 'mode') {
      const map = new Map<ChatMode, ChatSession[]>();
      for (const s of sessions) {
        const m = chatMode(s.options);
        map.set(m, [...(map.get(m) ?? []), s]);
      }
      return [...map.entries()]
        .map(([mode, list]) => {
          const info = getModeInfo(mode);
          return {
            id: mode,
            label: info.label,
            icon: info.icon,
            action: 'mode' as const,
            actionValue: mode,
            sessions: [...list].sort((a, b) => compareSessions(a, b, sortBy, sortOrder)),
          };
        })
        .sort((a, b) => {
          if (sortBy === 'title') {
            const cmp = a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });
            return sortOrder === 'asc' ? cmp : -cmp;
          }
          return b.sessions.length - a.sessions.length;
        });
    }

    return [];
  }, [groupBy, sessions, sortBy, sortOrder, searching, projects]);

  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const leave = (key: string, fn: () => void) => { setLeaving((l) => new Set(l).add(key)); setTimeout(fn, 170); };
  const multis = useHubEq((s) => s.data.multiRuns, multisEqual);
  const runs = useHub((s) => s.runs);
  const newSession = useHub((s) => s.newSession);
  const del = useHub((s) => s.deleteSession);
  const delMulti = useHub((s) => s.deleteMulti);
  const navigate = useNavigate();
  const { id } = useParams();
  const running = new Set(Object.values(runs).map((r) => r.sessionId));

  const renderSessionItem = (s: ChatSession) => {
    const isSelected = id === s.id;
    const projectName = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
    return (
      <NavLink
        key={s.id}
        to={`/chat/${s.id}`}
        viewTransition
        className={({ isActive }) =>
          cx(
            'group flex items-center gap-2 rounded-lumen-sm px-2 py-1.5 transition-colors hover:bg-hover',
            (isActive || isSelected) && 'bg-active',
            leaving.has(s.id) && 'row-leave',
          )
        }
      >
        <ProviderMark id={s.provider} size={12} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{s.title}</span>
          {searching && matches.get(s.id)?.snippet ? (
            <span className="mt-0.5 block truncate text-[11px] text-subtle">{matches.get(s.id)?.snippet}</span>
          ) : groupBy !== 'project' && projectName ? (
            <span className="mt-0.5 flex items-center gap-1 truncate text-[10.5px] text-subtle">
              <Icon name="lucide:folder" size={10} className="shrink-0 text-muted" />
              <span className="truncate">{projectName}</span>
            </span>
          ) : null}
        </span>
        {running.has(s.id) ? (
          <span className="pulse-dot size-2 rounded-full bg-accent" />
        ) : (
          <span className="text-[10.5px] text-subtle group-hover:hidden">{ago(s.updatedAt)}</span>
        )}
        <button
          className="icon-btn hidden !size-5 group-hover:grid"
          title={t('Ordner dieses Chats ändern')}
          onClick={async (e) => {
            e.preventDefault();
            const d = await hub.pickFolder();
            if (d) moveSession(s.id, d);
          }}
        >
          <Icon name="lucide:folder-pen" size={12} />
        </button>
        <button
          className="icon-btn hidden !size-5 group-hover:grid"
          title={t('In neuem Fenster öffnen')}
          onClick={(e) => {
            e.preventDefault();
            void hub.newWindow(`/chat/${s.id}`);
          }}
        >
          <Icon name="lucide:app-window" size={12} />
        </button>
        <button
          className="icon-btn hidden !size-5 group-hover:grid"
          onClick={(e) => {
            e.preventDefault();
            leave(s.id, () => {
              del(s.id);
              if (id === s.id) navigate('/', { viewTransition: true });
            });
          }}
        >
          <Icon name="lucide:trash-2" size={12} />
        </button>
      </NavLink>
    );
  };

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-r border-edge bg-surface select-none">
      <div className="flex items-center gap-1.5 px-2.5 pb-2 pt-2.5">
        <button className="btn btn-primary min-w-0 flex-1 justify-center gap-2" onClick={() => navigate(`/chat/${newSession()}`, { viewTransition: true })}>
          <Icon name="lucide:plus" size={15} />
          <span className="truncate">{t('Neuer Chat')}</span>
        </button>
        {onTogglePin && (
          <button
            className={cx('icon-btn !size-8 shrink-0', pinned ? 'text-fg' : 'text-muted hover:text-fg')}
            title={pinned ? t('Seitenleiste lösen (schweben)') + ' (Strg+B)' : t('Seitenleiste anheften') + ' (Strg+B)'}
            onClick={onTogglePin}
          >
            <Icon name={pinned ? 'lucide:pin-off' : 'lucide:pin'} size={14} />
          </button>
        )}
        {!pinned && onClose && (
          <button
            className="icon-btn !size-8 shrink-0 text-muted hover:text-fg md:hidden"
            title={t('Schließen')}
            onClick={onClose}
          >
            <Icon name="lucide:x" size={15} />
          </button>
        )}
      </div>
      <nav className="space-y-0.5 px-2.5 pb-2">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} viewTransition className={({ isActive }) => cx('flex items-center gap-2.5 rounded-lumen-sm px-2.5 py-1.5 text-muted hover:bg-hover hover:text-fg', isActive && 'bg-active text-fg')}>
            <Icon name={n.icon} size={16} /> {t(n.label)}
          </NavLink>
        ))}
      </nav>
      <div role="search" className="px-2.5 pb-2">
        <div className="flex items-center gap-2 rounded-lumen-sm border border-edge bg-input px-2.5 focus-within:border-accent/60">
          <Icon name="lucide:search" size={14} className="shrink-0 text-subtle" />
          <input type="text" role="searchbox" aria-label={t('Chats durchsuchen')} placeholder={t('Chats durchsuchen …')} value={search} onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); e.stopPropagation(); setSearch(''); } }}
            className="min-w-0 flex-1 bg-transparent py-2 text-[12px] outline-none placeholder:text-subtle" />
          {search && <button className="icon-btn !size-5" aria-label={t('Suche leeren')} title={t('Suche leeren')} onClick={() => setSearch('')}><Icon name="lucide:x" size={12} /></button>}
        </div>
        {search.trim() && <div role="status" aria-live="polite" className="px-1 pt-1.5 text-[10.5px] text-subtle">{query !== search.trim() ? t('Suche …') : `${matches.size} ${t('Chats gefunden')}`}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {!searching && multis.length > 0 && (
          <>
            <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-subtle">{t('Teams')}</div>
            {multis.slice(0, 8).map((m) => (
              <NavLink key={m.id} to={`/multi/${m.id}`} viewTransition className={({ isActive }) => cx('group flex items-center gap-2 rounded-lumen-sm px-2.5 py-1.5 transition-colors hover:bg-hover', isActive && 'bg-active', leaving.has(m.id) && 'row-leave')}>
                <span className={cx('size-2 shrink-0 rounded-full', m.status === 'running' ? 'pulse-dot bg-accent' : m.status === 'done' ? 'bg-ok' : m.status === 'failed' ? 'bg-bad' : 'bg-subtle')} />
                <span className="flex-1 truncate">{m.title}</span>
                <span className="text-[10.5px] text-subtle group-hover:hidden">{m.config.agents.length} {t('Agenten')}</span>
                <button className="icon-btn hidden !size-5 group-hover:grid" onClick={(e) => { e.preventDefault(); leave(m.id, () => { delMulti(m.id); if (location.hash.includes(m.id)) navigate('/multi', { viewTransition: true }); }); }}><Icon name="lucide:trash-2" size={12} /></button>
              </NavLink>
            ))}
          </>
        )}
        <div className="flex items-center justify-between px-2.5 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-wide text-subtle">
          <span className="flex items-center gap-1.5 font-semibold text-muted">
            {groupBy === 'project' ? t('Projekte') : t('Chats')}
            <span className="text-[10px] text-subtle font-normal">({sessions.length})</span>
          </span>
          <div className="flex items-center gap-0.5">
            {/* Popover für Gruppierung */}
            <Popover
              align="right"
              down
              trigger={(open, toggle) => (
                <button
                  className={cx('icon-btn !size-6', (open || groupBy !== 'project') && 'text-accent bg-active')}
                  title={`${t('Gruppieren nach')}: ${t(GROUP_OPTIONS.find((x) => x.id === groupBy)?.label ?? '')}`}
                  onClick={toggle}
                >
                  <Icon name="lucide:layers" size={13} />
                </button>
              )}
            >
              {(close) => (
                <div className="p-1 min-w-44">
                  <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">{t('Gruppieren nach')}</div>
                  {GROUP_OPTIONS.map((opt) => (
                    <MenuItem
                      key={opt.id}
                      icon={<Icon name={opt.icon} size={14} className="text-muted" />}
                      active={groupBy === opt.id}
                      onClick={() => { setChatListSettings({ groupBy: opt.id }); close(); }}
                    >
                      {t(opt.label)}
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>

            {/* Popover für Sortierung */}
            <Popover
              align="right"
              down
              trigger={(open, toggle) => (
                <button
                  className={cx('icon-btn !size-6', (open || sortBy !== 'updated') && 'text-accent bg-active')}
                  title={`${t('Sortieren nach')}: ${t(SORT_OPTIONS.find((x) => x.id === sortBy)?.label ?? '')}`}
                  onClick={toggle}
                >
                  <Icon name="lucide:arrow-down-up" size={13} />
                </button>
              )}
            >
              {(close) => (
                <div className="p-1 min-w-48">
                  <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">{t('Sortieren nach')}</div>
                  {SORT_OPTIONS.map((opt) => (
                    <MenuItem
                      key={opt.id}
                      icon={<Icon name={opt.icon} size={14} className="text-muted" />}
                      active={sortBy === opt.id}
                      onClick={() => { setChatListSettings({ sortBy: opt.id }); close(); }}
                    >
                      {t(opt.label)}
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>

            {/* Auf-/Absteigend Umschalter */}
            <button
              className="icon-btn !size-6"
              title={sortOrder === 'asc' ? t('Aufsteigend (Klick für absteigend)') : t('Absteigend (Klick für aufsteigend)')}
              onClick={() => setChatListSettings({ sortOrder: sortOrder === 'asc' ? 'desc' : 'asc' })}
            >
              <Icon name={sortOrder === 'asc' ? 'lucide:arrow-up-narrow-wide' : 'lucide:arrow-down-wide-narrow'} size={13} />
            </button>

            {groupBy === 'project' && (
              <button className="icon-btn !size-6" title={t('Projekt hinzufügen')} onClick={async () => { const d = await hub.pickFolder(); if (d) addProject(d); }}>
                <Icon name="lucide:folder-plus" size={13} />
              </button>
            )}
            <button className="icon-btn !size-6" title={t('Sessions importieren')} onClick={() => setImporting(true)}>
              <Icon name="lucide:download" size={13} />
            </button>
          </div>
        </div>

        {searching && sessions.length === 0 && <div className="px-2.5 py-4 text-[12px] text-subtle">{t('Keine passenden Chats gefunden.')}</div>}
        {!searching && sessions.length === 0 && (
          <div className="px-2.5 py-2 text-subtle">
            {t('Noch keine Chats.')} <button className="underline decoration-edge-strong underline-offset-4 hover:text-fg" onClick={() => setImporting(true)}>{t('Sessions importieren')}</button>
          </div>
        )}

        {groupBy === 'none' ? (
          <div className="space-y-0.5">
            {groups[0]?.sessions.map((s) => renderSessionItem(s))}
          </div>
        ) : (
          groups.map((g) => {
            const open = searching || !collapsed.has(g.id);
            return (
              <div key={g.id} className="mb-0.5">
                <div className="group/p flex items-center rounded-lumen-sm hover:bg-hover">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
                    onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(g.id) ? n.delete(g.id) : n.add(g.id); return n; })}
                    title={g.cwd || g.label}
                  >
                    <Icon name="lucide:chevron-right" size={12} className={cx('shrink-0 text-subtle transition-transform duration-200', open && 'rotate-90')} />
                    {g.provider ? <ProviderMark id={g.provider} size={14} /> : <Icon name={g.icon ?? 'lucide:folder'} size={14} className="shrink-0 text-muted" />}
                    <span className="flex-1 truncate font-medium">{g.label}</span>
                    <span className="text-[10.5px] text-subtle group-hover/p:hidden">{g.sessions.length || ''}</span>
                  </button>
                  <span className="mr-1 hidden gap-0.5 group-hover/p:flex">
                    {g.action === 'project' && g.cwd && (
                      <>
                        <button className="icon-btn !size-5" title={t('Neuer Chat in diesem Projekt')} onClick={() => navigate(`/chat/${newSession({ cwd: g.cwd })}`, { viewTransition: true })}><Icon name="lucide:plus" size={13} /></button>
                        <button className="icon-btn !size-5" title={t('Projektordner ändern')} onClick={async () => { const d = await hub.pickFolder(); if (d) moveProject(g.cwd!, d); }}><Icon name="lucide:folder-pen" size={13} /></button>
                        <button className="icon-btn !size-5" title={t('Projekt entfernen')} onClick={() => (g.sessions.length ? setRemoving(g.cwd!) : removeProject(g.cwd!))}><Icon name="lucide:trash-2" size={12} /></button>
                      </>
                    )}
                    {g.action === 'provider' && g.provider && (
                      <button className="icon-btn !size-5" title={t('Neuer Chat')} onClick={() => navigate(`/chat/${newSession({ provider: g.provider })}`, { viewTransition: true })}><Icon name="lucide:plus" size={13} /></button>
                    )}
                    {g.action === 'mode' && g.actionValue && (
                      <button className="icon-btn !size-5" title={t('Neuer Chat')} onClick={() => navigate(`/chat/${newSession({ options: { chatMode: g.actionValue as ChatMode } })}`, { viewTransition: true })}><Icon name="lucide:plus" size={13} /></button>
                    )}
                  </span>
                </div>
                <Collapse open={open}>
                  <div className="ml-3 border-l border-edge pl-1">
                    {g.sessions.map((s) => renderSessionItem(s))}
                  </div>
                </Collapse>
              </div>
            );
          })
        )}
      </div>
      <div className="border-t border-edge p-2">
        <button className="flex w-full items-center gap-2.5 rounded-lumen-sm px-2.5 py-2 text-muted transition-colors hover:bg-hover hover:text-fg" onClick={() => openSettings()}><Icon name="lucide:settings-2" size={16} /> {t('Einstellungen')}</button>
      </div>
      {removing && (
        <Modal title={t('Projekt entfernen')} onClose={() => setRemoving(null)}>
          <p className="text-muted">{t('Das Projekt wird aus der Liste entfernt und seine Chats werden ausgeblendet. Die Chats werden nicht gelöscht – du kannst sie unter Einstellungen wiederherstellen.')}</p>
          <p className="mt-2 font-mono text-[12px] text-subtle">{removing}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn" onClick={() => setRemoving(null)}>{t('Abbrechen')}</button>
            <button className="btn btn-primary" onClick={() => { const cwd = removing; const cur = sessions.find((x) => x.id === id); removeProject(cwd); setRemoving(null); if (cur?.cwd === cwd) navigate('/', { viewTransition: true }); }}>{t('Entfernen')}</button>
          </div>
        </Modal>
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} />}
    </aside>
  );
}
