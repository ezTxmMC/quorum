import { useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import type { FsEntry } from '@shared/types';
import { hub } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { cx } from '../ui';

const join = (a: string, b: string) => (a.endsWith('/') || a.endsWith('\\') ? a + b : a + (a.includes('\\') && !a.includes('/') ? '\\' : '/') + b);

function Node({ dir, name, depth, onOpen, cache, load }: { dir: string; name: string; depth: number; onOpen: (p: string) => void; cache: Record<string, FsEntry[]>; load: (d: string) => void }) {
  const path = join(dir, name);
  const [open, setOpen] = useState(false);
  const kids = cache[path];
  return (
    <>
      <button className="flex w-full items-center gap-1.5 rounded-lumen-sm py-[3px] pr-2 text-left hover:bg-hover" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => { setOpen((o) => !o); if (!open) load(path); }}>
        <Icon name="lucide:chevron-right" size={12} className={cx('shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        <Icon name={open ? 'lucide:folder-open' : 'lucide:folder'} size={14} className="shrink-0 text-muted" /><span className="truncate">{name}</span>
      </button>
      {open && kids?.map((e) => (e.isDir
        ? <Node key={e.name} dir={path} name={e.name} depth={depth + 1} onOpen={onOpen} cache={cache} load={load} />
        : <FileRow key={e.name} path={join(path, e.name)} name={e.name} depth={depth + 1} onOpen={onOpen} />))}
    </>
  );
}

function FileRow({ path, name, depth, onOpen }: { path: string; name: string; depth: number; onOpen: (p: string) => void }) {
  return (
    <button className="flex w-full items-center gap-1.5 rounded-lumen-sm py-[3px] pr-2 text-left hover:bg-hover" style={{ paddingLeft: 8 + depth * 14 + 16 }} onClick={() => onOpen(path)}>
      <Icon name="lucide:file" size={13} className="shrink-0 text-subtle" /><span className="truncate">{name}</span>
    </button>
  );
}

export function FilesPanel({ cwd }: { cwd: string }) {
  const [cache, setCache] = useState<Record<string, FsEntry[]>>({});
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const load = useCallback((d: string) => { void hub.ideList(cwd, d === cwd ? undefined : d.slice(cwd.length).replace(/^[\\/]/, '')).then((entries) => setCache((c) => ({ ...c, [d]: entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory })) }))).catch((reason: unknown) => setError(String(reason))); }, [cwd]);
  useEffect(() => { setCache({}); setError(''); if (cwd) load(cwd); }, [cwd, load]);

  const open = (path: string) => navigate('/plan', { state: { ideOpen: { root: cwd, path: path.slice(cwd.length).replace(/^[\\/]/, '') } } });
  if (!cwd) { return <div className="p-4 text-muted">{t('Kein Ordner gewählt.')}</div>; }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-edge px-2 py-1.5">
        <Icon name="lucide:folder" size={14} className="text-muted" /><span className="min-w-0 flex-1 truncate font-medium" title={cwd}>{cwd.split(/[\\/]/).filter(Boolean).pop()}</span>
        <button className="icon-btn" onClick={() => { setCache({}); load(cwd); }} title={t('Aktualisieren')}><Icon name="lucide:refresh-cw" size={13} /></button>
      </div>
      <p className="border-b border-edge px-3 py-2 text-xs text-muted">Dateien öffnen im IDE-Editor.</p>
      {error && <p role="alert" className="p-2 text-xs text-bad">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto p-1 text-[12.5px]">
        {cache[cwd]?.map((e) => (e.isDir
          ? <Node key={e.name} dir={cwd} name={e.name} depth={0} onOpen={open} cache={cache} load={load} />
          : <FileRow key={e.name} path={join(cwd, e.name)} name={e.name} depth={0} onOpen={open} />))}
      </div>
    </div>
  );
}
