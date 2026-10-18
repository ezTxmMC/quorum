import { t } from '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { GitStatus } from '@shared/types';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { cx } from './ui';

export function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <div className="p-3 text-subtle">{t('Kein Diff.')}</div>;
  return (
    <pre className="overflow-auto p-2 font-mono text-[11.5px] leading-[1.55]">
      {text.split('\n').map((l, i) => (
        <div key={i} className={cx('whitespace-pre px-1', l.startsWith('+') && !l.startsWith('+++') && 'diff-add', l.startsWith('-') && !l.startsWith('---') && 'diff-del', l.startsWith('@@') && 'diff-hunk', (l.startsWith('diff ') || l.startsWith('index ')) && 'text-subtle')}>{l || ' '}</div>
      ))}
    </pre>
  );
}

export function ChangesPanel({ cwd, refreshKey }: { cwd: string; refreshKey?: unknown }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [file, setFile] = useState<string | undefined>();
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const s = await hub.gitStatus(cwd);
    setSt(s);
    if (s.isRepo) setDiff(await hub.gitDiff(cwd, file));
    setBusy(false);
  }, [cwd, file]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  if (st && !st.isRepo) return <div className="p-4 text-muted">{t('Dieses Projekt ist kein Git-Repository – Änderungen können nicht angezeigt werden.')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <Icon name="lucide:git-branch" size={14} className="text-muted" />
        <span className="flex-1 truncate font-medium">{st?.branch ?? '…'}</span>
        <button className="icon-btn" onClick={load} title={t('Aktualisieren')}><Icon name="lucide:refresh-cw" size={14} className={busy ? 'spin' : ''} /></button>
      </div>
      <div className="max-h-44 shrink-0 overflow-auto border-b border-edge p-1">
        <button className={cx('flex w-full items-center gap-2 rounded-lumen-sm px-2 py-1 text-left hover:bg-hover', !file && 'bg-active')} onClick={() => setFile(undefined)}>
          <Icon name="lucide:files" size={13} /> {t('Alle Änderungen')} <span className="ml-auto text-subtle">{st?.files.length ?? 0}</span>
        </button>
        {st?.files.map((f) => (
          <button key={f.path} className={cx('flex w-full items-center gap-2 rounded-lumen-sm px-2 py-1 text-left hover:bg-hover', file === f.path && 'bg-active')} onClick={() => setFile(f.path)}>
            <span className={cx('w-4 text-center font-mono text-[11px]', f.status === 'M' ? 'text-warn' : f.status === 'D' ? 'text-bad' : 'text-ok')}>{f.status}</span>
            <span className="truncate font-mono text-[11.5px]">{f.path}</span>
          </button>
        ))}
        {st && st.files.length === 0 && <div className="px-2 py-2 text-subtle">{t('Keine Änderungen.')}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto"><DiffView text={diff} /></div>
    </div>
  );
}
