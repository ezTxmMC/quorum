import { QuickOpen } from './QuickOpen';
import { MonacoPane, type MonacoPaneHandle } from './MonacoPane';
import { useLsp } from './useLsp';
import { lspLanguage } from '@shared/ide/lsp';
import { useEffect, useRef, useState } from 'react';
import type { EditorDocument, WorkspaceEntry } from '@shared/ide/types';
import { hub } from '@/lib/api';

type Buffer = EditorDocument & { savedText: string; conflict?: boolean };

function Tree({ root, directory, onOpen, onError }: { root: string; directory?: string; onOpen: (path: string) => void; onError: (error: unknown) => void }) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    void hub.ideList(root, directory).then((result) => { if (active) { setEntries(result); } }).catch(onError);
    return () => { active = false; };
  }, [root, directory, onError]);
  return <div className="pl-2">{entries.map((entry) => <div key={entry.path}>
    <button className="block w-full truncate py-1 text-left hover:bg-hover" title={entry.path} onClick={() => {
      if (!entry.isDirectory) { onOpen(entry.path); return; }
      setExpanded((previous) => previous.includes(entry.path) ? previous.filter((path) => path !== entry.path) : [...previous, entry.path]);
    }}>{entry.isDirectory ? (expanded.includes(entry.path) ? '▾ ' : '▸ ') : '  '}{entry.name}</button>
    {expanded.includes(entry.path) && <Tree root={root} directory={entry.path} onOpen={onOpen} onError={onError} />}
  </div>)}</div>;
}

export function WorkspaceEditor({ root, file, onDirty }: { root: string; file?: string; onDirty: (dirty: boolean) => void }) {
  const [buffers, setBuffers] = useState<Buffer[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quickOpen, setQuickOpen] = useState<'files' | 'content' | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const navigation = useRef<{ path: string; line: number; column: number } | null>(null);
  const [diskText, setDiskText] = useState<string | null>(null);
  const editor = useRef<MonacoPaneHandle>(null);
  const current = buffers.find((buffer) => buffer.path === selected);
  useEffect(() => { onDirty(buffers.some((buffer) => buffer.text !== buffer.savedText)); }, [buffers, onDirty]);
  const report = useRef((reason: unknown) => setError(String(reason))).current;
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const lsp = useLsp(root, buffers, report);
  const language = current ? lspLanguage(current.languageId) : undefined;
  const status = language ? lsp.statuses[language] : undefined;
  const problems = Object.values(lsp.diagnostics).flatMap((snapshot) => snapshot.diagnostics.map((diagnostic) => ({ ...diagnostic, path: snapshot.path })));
  useEffect(() => {
    const target = navigation.current;
    if (!target || target.path !== selected || !editor.current?.model(selected)) { return; }
    editor.current.focus(target.path, target.line, target.column);
    navigation.current = null;
  }, [selected, buffers]);

  const open = async (path: string) => {
    const existing = buffersRef.current.find((buffer) => buffer.path === path);
    if (existing) { setSelected(existing.path); return existing.path; }
    try {
      const document = await hub.ideRead(root, path);
      setBuffers((previous) => previous.some((buffer) => buffer.path === document.path) ? previous : [...previous, { ...document, savedText: document.text }]);
      setSelected(document.path);
      setDiskText(null);
      return document.path;
    } catch (reason) { report(reason); }
  };

  useEffect(() => { if (file) { void open(file); } }, [file, root]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (buffersRef.current.some((buffer) => buffer.text !== buffer.savedText)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // Polling is portable across platforms; dirty buffers remain authoritative.
  useEffect(() => {
    let active = true;
    const check = async () => {
      const snapshot = buffersRef.current;
      for (const buffer of snapshot) {
        try {
          const disk = await hub.ideRead(root, buffer.path);
          if (!active || disk.diskHash === buffer.diskHash) { continue; }
          setBuffers((previous) => previous.map((latest) => {
            if (latest.path !== buffer.path || latest.diskHash !== buffer.diskHash) { return latest; }
            if (latest.text !== latest.savedText) { return { ...latest, conflict: true }; }
            return { ...disk, savedText: disk.text };
          }));
        } catch (reason) { if (active) { report(reason); } }
      }
    };
    const timer = window.setInterval(() => { void check(); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [root, report]);

  const save = async () => {
    if (!current || busy || current.conflict) { return; }
    setBusy(true);
    setError('');
    try {
      const saved = await hub.ideSave(root, current.path, current.text, current.diskHash);
      setBuffers((previous) => previous.map((buffer) => buffer.path === saved.path ? { ...saved, text: buffer.text, savedText: saved.text } : buffer));
      setDiskText(null);
      await lsp.saved(saved.path, saved.text);
    } catch (reason) { report(reason); }
    finally { setBusy(false); }
  };
  const reload = async () => {
    if (!current) { return; }
    if (current.text !== current.savedText && !window.confirm('Ungespeicherte Änderungen verwerfen und vom Datenträger laden?')) { return; }
    try {
      const document = await hub.ideRead(root, current.path);
      setBuffers((previous) => previous.map((buffer) => buffer.path === current.path ? { ...document, savedText: document.text } : buffer));
      setDiskText(null);
    } catch (reason) { report(reason); }
  };
  const navigate = async (path: string, line = 1, column = 1): Promise<boolean> => {
    navigation.current = { path, line, column };
    const canonical = await open(path);
    if (!canonical) { navigation.current = null; return false; }
    navigation.current = { path: canonical, line, column };
    if (canonical === selected) { editor.current?.focus(canonical, line, column); navigation.current = null; }
    setDiskText(null);
    return true;
  };

  return <div className="flex min-h-0 flex-1 border-t border-edge" onKeyDownCapture={(event) => {
    if (!(event.ctrlKey || event.metaKey)) { return; }
    if (event.key.toLowerCase() === 'p' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); setQuickOpen('files'); }
    if (event.key.toLowerCase() === 'f' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); setQuickOpen('content'); }
  }}>
    {quickOpen && <QuickOpen root={root} mode={quickOpen} onOpen={navigate} onClose={() => setQuickOpen(null)} />}
    <aside className="w-52 shrink-0 overflow-auto border-r border-edge p-2 text-xs"><div className="mb-2 flex gap-1"><button className="btn" onClick={() => setQuickOpen('files')}>Öffnen</button><button className="btn" onClick={() => setQuickOpen('content')}>Suche</button></div><Tree root={root} onOpen={(path) => { void open(path); }} onError={report} /></aside>
    <div className="flex min-w-0 flex-1 flex-col" onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); }
    }}>
      <div className="flex overflow-x-auto border-b border-edge">{buffers.map((buffer) => <div key={buffer.path} className="flex shrink-0 items-center border-r border-edge">
        <button className={`px-3 py-2 text-xs ${selected === buffer.path ? 'bg-hover' : ''}`} title={buffer.path} onClick={() => { setSelected(buffer.path); setDiskText(null); }}>{buffer.path.split(/[\\/]/).pop()}{buffer.text !== buffer.savedText ? ' •' : ''}{buffer.conflict ? ' ⚠' : ''}</button>
        <button className="px-2" aria-label={`Schließen: ${buffer.path}`} onClick={() => {
          if (buffer.text !== buffer.savedText && !window.confirm('Ungespeicherte Änderungen verwerfen?')) { return; }
          setBuffers((previous) => previous.filter((item) => item.path !== buffer.path));
          if (selected === buffer.path) { setSelected(buffers.find((item) => item.path !== buffer.path)?.path ?? ''); }
        }}>×</button>
      </div>)}</div>
      {error && <div role="alert" className="p-2 text-sm text-red-400">{error}</div>}
      {current && <>
        <div className="flex flex-wrap items-center gap-2 border-b border-edge p-2 text-xs">
          <button className="btn" disabled={busy || current.conflict || current.text === current.savedText} onClick={() => { void save(); }}>Speichern</button>
          <button className="btn" onClick={() => { void reload(); }}>Neu laden</button>
          <button className="btn" onClick={() => editor.current?.find()}>Suchen / Ersetzen</button>
          <button className="btn" onClick={() => editor.current?.commands()}>Befehlspalette</button>
          {language && <>
            <span title={status?.message}>LSP: {status?.state ?? 'deaktiviert'}</span>
            <button className="btn" disabled={status?.state === 'starting'} onClick={() => { void lsp.start(language, !!status && status.state !== 'stopped'); }}>{status?.state === 'ready' ? 'LSP neu starten' : 'LSP aktivieren'}</button>
            {status?.state === 'ready' && <button className="btn" onClick={() => { void lsp.stop(language); }}>LSP stoppen</button>}
          </>}
          <button className="btn" onClick={() => setProblemsOpen((previous) => !previous)}>Probleme ({problems.length})</button>
          <span className="text-muted">{current.languageId} · UTF-8 · {current.lineEnding}</span>
        </div>
        {status?.message && <div role="status" className="px-2 py-1 text-xs text-warn">{status.message}</div>}
        {current.conflict && <div className="p-2 text-sm text-amber-400">Externe Änderung erkannt. Der Buffer bleibt erhalten. <button className="btn" onClick={() => { void hub.ideRead(root, current.path).then((document) => setDiskText(document.text)).catch(report); }}>Datenträger vergleichen</button></div>}
        {diskText !== null && <div className="flex items-center gap-2 px-2 py-1 text-xs"><span>Links: Datenträger · Rechts: aktueller Buffer</span><button className="btn" onClick={() => setDiskText(null)}>Vergleich schließen</button></div>}
        <MonacoPane ref={editor} documents={buffers} selected={selected} diskText={diskText}
          onChange={(path, text) => setBuffers((previous) => previous.map((buffer) => buffer.path === path ? { ...buffer, text } : buffer))}
          onModel={lsp.onModel} onCloseModel={lsp.onCloseModel} onSave={() => { void save(); }} onNavigate={navigate} />
        {problemsOpen && <div className="max-h-44 shrink-0 overflow-auto border-t border-edge p-2 text-xs" aria-label="LSP-Probleme">
          {!problems.length && <p className="text-muted">Keine Diagnosen für die geöffneten Dokumentversionen.</p>}
          {problems.map((problem, index) => <button key={`${problem.path}:${index}`} className="block w-full py-1 text-left hover:bg-hover" onClick={() => { void navigate(problem.path, problem.range.start.line + 1, problem.range.start.character + 1); }}>
            <span className={(problem.severity ?? 1) === 1 ? 'text-bad' : 'text-warn'}>{(problem.severity ?? 1) === 1 ? 'Fehler' : 'Hinweis'}</span> {problem.path.split(/[\\/]/).pop()}:{problem.range.start.line + 1} · {problem.message}
          </button>)}
        </div>}
      </>}
      {!current && <div className="p-6 text-muted">Datei im Baum öffnen. Strg+S speichert den aktiven Buffer.</div>}
    </div>
  </div>;
}
