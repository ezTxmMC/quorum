import { t } from '@/lib/i18n';
import { useDeferredValue, useMemo, useState } from 'react';
import type { ChatSession, MultiRunRecord } from '@shared/types';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { hub } from '@/lib/api';
import { useHub, useHubEq } from '@/lib/store';
import { searchChat } from '@/lib/chatSearch';
import { Icon } from '@/lib/icons';
import { ImportModal } from './ImportModal';
import { Collapse, Modal, ProviderMark, cx } from './ui';

const nav = [
  { to: '/multi', icon: 'lucide:network', label: 'Multi-Agent' },
  { to: '/models', icon: 'lucide:box', label: 'Modelle' },
  { to: '/workflows', icon: 'lucide:workflow', label: 'Workflows' },
  { to: '/tools', icon: 'lucide:wrench', label: 'CLI-Werkzeuge' },
];

// Während des Streamings ändern sich Nachrichten ständig – die Sidebar interessiert sich nur für diese Felder.
const sessionsEqual = (a: ChatSession[], b: ChatSession[]) =>
  a === b || (a.length === b.length && a.every((x, i) => { const y = b[i]; return x.id === y.id && x.title === y.title && x.cwd === y.cwd && x.provider === y.provider && x.updatedAt === y.updatedAt && (x.messages.length > 0) === (y.messages.length > 0); }));
const multisEqual = (a: MultiRunRecord[], b: MultiRunRecord[]) =>
  a === b || (a.length === b.length && a.every((x, i) => { const y = b[i]; return x.id === y.id && x.title === y.title && x.status === y.status && x.config.agents.length === y.config.agents.length; }));

function ago(ts: number) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return t('jetzt');
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
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
  const { addProject, removeProject, moveProject, moveSession, openSettings } = useHub.getState();
  // Projekte = Ordnerpfade: angelegte + alle, in denen Chats liegen; "Ohne Projekt" (kein Ordner) zuletzt.
  const groups = (() => {
    const map = new Map<string, typeof sessions>();
    if (!searching) for (const p of projects) map.set(p, []);
    for (const s of sessions) map.set(s.cwd, [...(map.get(s.cwd) ?? []), s]);
    const latest = (l: typeof sessions) => Math.max(0, ...l.map((x) => x.updatedAt));
    return [...map.entries()].map(([cwd, list]) => ({ cwd, sessions: list })).sort((a, b) => (a.cwd === '' ? 1 : b.cwd === '' ? -1 : latest(b.sessions) - latest(a.sessions)));
  })();
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
        <div className="flex items-center justify-between px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-subtle">
          {t('Projekte')}
          <span className="flex gap-0.5">
            <button className="icon-btn !size-5" title={t('Projekt hinzufügen')} onClick={async () => { const d = await hub.pickFolder(); if (d) addProject(d); }}><Icon name="lucide:folder-plus" size={13} /></button>
            <button className="icon-btn !size-5" title={t('Sessions importieren')} onClick={() => setImporting(true)}><Icon name="lucide:download" size={13} /></button>
          </span>
        </div>
        {searching && groups.length === 0 && <div className="px-2.5 py-4 text-[12px] text-subtle">{t('Keine passenden Chats gefunden.')}</div>}
        {!searching && groups.length === 0 && <div className="px-2.5 py-2 text-subtle">{t('Noch keine Chats.')} <button className="underline decoration-edge-strong underline-offset-4 hover:text-fg" onClick={() => setImporting(true)}>{t('Sessions importieren')}</button></div>}
        {groups.map((g) => {
          const open = searching || !collapsed.has(g.cwd);
          return (
            <div key={g.cwd || '__none'} className="mb-0.5">
              <div className="group/p flex items-center rounded-lumen-sm hover:bg-hover">
                <button className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(g.cwd) ? n.delete(g.cwd) : n.add(g.cwd); return n; })} title={g.cwd || undefined}>
                  <Icon name="lucide:chevron-right" size={12} className={cx('shrink-0 text-subtle transition-transform duration-200', open && 'rotate-90')} />
                  <Icon name={g.cwd ? 'lucide:folder' : 'lucide:message-square-dashed'} size={14} className="shrink-0 text-muted" />
                  <span className="flex-1 truncate font-medium">{g.cwd ? g.cwd.split(/[\\/]/).filter(Boolean).pop() : t('Ohne Projekt')}</span>
                  <span className="text-[10.5px] text-subtle group-hover/p:hidden">{g.sessions.length || ''}</span>
                </button>
                {g.cwd && (
                  <span className="mr-1 hidden gap-0.5 group-hover/p:flex">
                    <button className="icon-btn !size-5" title={t('Neuer Chat in diesem Projekt')} onClick={() => navigate(`/chat/${newSession({ cwd: g.cwd })}`, { viewTransition: true })}><Icon name="lucide:plus" size={13} /></button>
                    <button className="icon-btn !size-5" title={t('Projektordner ändern')} onClick={async () => { const d = await hub.pickFolder(); if (d) moveProject(g.cwd, d); }}><Icon name="lucide:folder-pen" size={13} /></button>
                    <button className="icon-btn !size-5" title={t('Projekt entfernen')} onClick={() => (g.sessions.length ? setRemoving(g.cwd) : removeProject(g.cwd))}><Icon name="lucide:trash-2" size={12} /></button>
                  </span>
                )}
              </div>
              <Collapse open={open}>
                <div className="ml-3 border-l border-edge pl-1">
                  {g.sessions.map((s) => (
                    <NavLink key={s.id} to={`/chat/${s.id}`} viewTransition className={({ isActive }) => cx('group flex items-center gap-2 rounded-lumen-sm px-2 py-1.5 transition-colors hover:bg-hover', (isActive || id === s.id) && 'bg-active', leaving.has(s.id) && 'row-leave')}>
                      <ProviderMark id={s.provider} size={12} />
                      <span className="min-w-0 flex-1"><span className="block truncate">{s.title}</span>{searching && matches.get(s.id)?.snippet && <span className="mt-0.5 block truncate text-[11px] text-subtle">{matches.get(s.id)?.snippet}</span>}</span>
                      {running.has(s.id) ? <span className="pulse-dot size-2 rounded-full bg-accent" /> : <span className="text-[10.5px] text-subtle group-hover:hidden">{ago(s.updatedAt)}</span>}
                      <button className="icon-btn hidden !size-5 group-hover:grid" title={t('Ordner dieses Chats ändern')} onClick={async (e) => { e.preventDefault(); const d = await hub.pickFolder(); if (d) moveSession(s.id, d); }}><Icon name="lucide:folder-pen" size={12} /></button>
                      <button className="icon-btn hidden !size-5 group-hover:grid" title={t('In neuem Fenster öffnen')} onClick={(e) => { e.preventDefault(); void hub.newWindow(`/chat/${s.id}`); }}><Icon name="lucide:app-window" size={12} /></button>
                      <button className="icon-btn hidden !size-5 group-hover:grid" onClick={(e) => { e.preventDefault(); leave(s.id, () => { del(s.id); if (id === s.id) navigate('/', { viewTransition: true }); }); }}><Icon name="lucide:trash-2" size={12} /></button>
                    </NavLink>
                  ))}
                </div>
              </Collapse>
            </div>
          );
        })}
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
