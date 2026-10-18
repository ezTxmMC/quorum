import { useEffect, useMemo, useState } from 'react';
import { PROVIDERS } from '@shared/catalog';
import type { ImportEntry, ProviderId } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { Dot } from './ModelPicker';
import { Modal, cx } from './ui';

const key = (e: ImportEntry) => `${e.provider}:${e.sessionId}`;

export function ImportModal({ onClose }: { onClose: () => void }) {
  const sessions = useHub((s) => s.data.sessions);
  const [entries, setEntries] = useState<ImportEntry[] | null>(null);
  const [filter, setFilter] = useState<'all' | ProviderId>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => { void hub.importList().then(setEntries); }, []);

  const have = useMemo(() => new Set(sessions.flatMap((s) => Object.entries(s.providerSessions).map(([p, id]) => `${p}:${id}`))), [sessions]);
  const shown = useMemo(() => (entries ?? []).filter((e) => (filter === 'all' || e.provider === filter) && (!q || (e.title + e.cwd).toLowerCase().includes(q.toLowerCase()))), [entries, filter, q]);
  const fresh = shown.filter((e) => !have.has(key(e)));

  const run = async (list: ImportEntry[]) => {
    if (!list.length) return;
    setBusy(true);
    // In Häppchen laden, damit die UI nicht einfriert.
    for (let i = 0; i < list.length; i += 10) {
      const loaded = await hub.importLoad(list.slice(i, i + 10));
      useHub.getState().importSessions(loaded);
    }
    setBusy(false);
    onClose();
  };

  const toggle = (e: ImportEntry) => setSel((s) => { const n = new Set(s); n.has(key(e)) ? n.delete(key(e)) : n.add(key(e)); return n; });
  const chosen = (entries ?? []).filter((e) => sel.has(key(e)));

  return (
    <Modal wide title={t('Sessions importieren')} onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex rounded-lumen-sm border border-edge p-0.5">
          {(['all', 'claude', 'codex'] as const).map((f) => (
            <button key={f} className={cx('whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[12px] transition-colors', filter === f ? 'bg-active text-fg' : 'text-muted hover:text-fg')} onClick={() => setFilter(f)}>
              {f === 'all' ? t('Alle') : PROVIDERS[f].name}
            </button>
          ))}
        </div>
        <input className="field" placeholder={t('Suchen …')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="h-[380px] overflow-y-auto rounded-lumen border border-edge">
        {entries === null && <div className="grid h-full place-items-center text-muted"><Icon name="lucide:loader-circle" className="spin" /></div>}
        {entries && shown.length === 0 && <div className="grid h-full place-items-center text-muted">{t('Keine Sessions gefunden.')}</div>}
        {shown.map((e) => {
          const done = have.has(key(e));
          return (
            <button key={key(e)} disabled={done} onClick={() => toggle(e)} className={cx('flex w-full items-center gap-3 border-b border-edge px-3 py-2 text-left last:border-0', done ? 'opacity-45' : 'hover:bg-hover')}>
              <span className={cx('grid size-4 shrink-0 place-items-center rounded border', sel.has(key(e)) || done ? 'border-accent bg-accent text-accent-fg' : 'border-edge-strong')}>{(sel.has(key(e)) || done) && <Icon name="lucide:check" size={11} />}</span>
              <Dot id={e.provider} />
              <span className="min-w-0 flex-1"><span className="block truncate">{e.title}</span><span className="block truncate font-mono text-[11px] text-subtle">{e.cwd}</span></span>
              <span className="shrink-0 text-[11px] text-subtle">{done ? t('importiert') : new Date(e.updatedAt).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' })}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="mr-auto text-[12px] text-subtle">{fresh.length} {t('neue Sessions')}</span>
        <button className="btn" disabled={busy || !chosen.length} onClick={() => run(chosen)}>{t('Auswahl importieren')} ({chosen.length})</button>
        <button className="btn btn-primary" disabled={busy || !fresh.length} onClick={() => run(fresh)}>{busy ? <Icon name="lucide:loader-circle" className="spin" /> : <Icon name="lucide:download" />} {t('Alle neuen importieren')}</button>
      </div>
    </Modal>
  );
}
