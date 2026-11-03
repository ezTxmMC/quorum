import { useEffect, useRef, useState } from 'react';
import { hub } from '@/lib/api';

export function QuickOpen({ root, mode, onOpen, onClose }: {
  root: string; mode: 'files' | 'content'; onOpen: (path: string, line: number, column: number) => Promise<boolean>; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<{ path: string; line: number; column: number; preview?: string }[]>([]);
  const [error, setError] = useState('');
  const [limited, setLimited] = useState(false);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    return () => element?.close();
  }, []);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setSelected(0);
    const timer = setTimeout(() => {
      if (mode === 'content' && !query) { setItems([]); setLimited(false); setError(''); setBusy(false); return; }
      const run = async () => {
        try {
          const result = mode === 'files' ? await hub.ideFindFiles(root, query) : await hub.ideSearch(root, query);
          if (!active) { return; }
          setItems('files' in result ? result.files.map((path) => ({ path, line: 1, column: 1 })) : result.matches);
          setSelected(0);
          setLimited(result.truncated);
          setError('');
        } catch (reason) { if (active) { setError(String(reason)); } }
        finally { if (active) { setBusy(false); } }
      };
      void run();
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [root, query, mode]);
  const choose = async (index: number) => {
    const item = items[index];
    if (!item || busy) { return; }
    if (await onOpen(item.path, item.line, item.column)) { onClose(); }
  };
  return <dialog ref={dialog} onCancel={(event) => { event.preventDefault(); onClose(); }} aria-label={mode === 'files' ? 'Datei öffnen' : 'Workspace durchsuchen'}
    className="m-auto w-[min(680px,90vw)] rounded border border-edge bg-surface p-4 text-fg shadow-xl backdrop:bg-black/60">
    <div className="mb-2 flex items-center gap-2"><label className="flex-1 font-medium" htmlFor="workspace-query">{mode === 'files' ? 'Datei öffnen' : 'Workspace durchsuchen'}</label><button className="btn" onClick={onClose}>Schließen</button></div>
    <input ref={input} id="workspace-query" className="input w-full" value={query} placeholder={mode === 'files' ? 'Dateiname oder Pfad…' : 'Text suchen (Groß-/Kleinschreibung beachten)…'} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((previous) => Math.max(0, Math.min(items.length - 1, previous + 1))); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((previous) => Math.max(0, previous - 1)); }
      if (event.key === 'Enter') { event.preventDefault(); void choose(selected); }
    }} />
    {busy && <p className="mt-2 text-xs text-muted">Suche läuft…</p>}
    {error && <p role="alert" className="text-bad">{error}</p>}
    {limited && <p className="mt-2 text-xs text-warn">Ergebnisse begrenzt. Suche genauer eingrenzen.</p>}
    <div className="mt-2 max-h-[55vh] overflow-auto">{items.map((item, index) => <button key={`${item.path}:${item.line}:${item.column}`} className={`block w-full rounded px-2 py-2 text-left text-xs hover:bg-hover ${selected === index ? 'bg-hover' : ''}`} onClick={() => { void choose(index); }}>
      <span className="block truncate">{item.path.slice(root.length).replace(/^[\\/]/, '')}{mode === 'content' ? `:${item.line}` : ''}</span>
      {item.preview !== undefined && <span className="block truncate font-mono text-muted">{item.preview}</span>}
    </button>)}</div>
    <p className="mt-2 text-xs text-muted">Generierte Ordner, Symlinks und bekannte Secret-Dateien werden ausgelassen. ↑ ↓ auswählen · Enter öffnen · Esc schließen.</p>
  </dialog>;
}
