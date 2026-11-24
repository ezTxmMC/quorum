import { QuickOpen } from './QuickOpen';
import { MonacoPane, type MonacoPaneHandle } from './MonacoPane';
import { useLsp } from './useLsp';
import { lspLanguage } from '@shared/ide/lsp';
import { useEffect, useRef, useState } from 'react';
import type { EditorDocument } from '@shared/ide/types';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useHub } from '@/lib/store';
import { cx } from '@/components/ui';

type Buffer = EditorDocument & { savedText: string; conflict?: boolean };

export function WorkspaceEditor({ root, file, fileRequest, onDirty }: { root: string; file?: string; fileRequest?: number; onDirty: (dirty: boolean) => void }) {
  const ideQuickAction = useHub((state) => state.ideQuickAction);
  const [buffers, setBuffers] = useState<Buffer[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quickOpen, setQuickOpen] = useState<'files' | 'content' | null>(null);

  const handledQuickAction = useRef(ideQuickAction?.seq ?? 0);

  useEffect(() => {
    if (!ideQuickAction || ideQuickAction.seq === handledQuickAction.current) {
      return;
    }
    handledQuickAction.current = ideQuickAction.seq;
    setQuickOpen(ideQuickAction.kind);
  }, [ideQuickAction]);
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

  // fileRequest zählt jeden Klick: dieselbe Datei erneut zu wählen öffnet bzw. fokussiert sie wieder.
  useEffect(() => { if (file) { void open(file); } }, [file, root, fileRequest]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (buffersRef.current.some((buffer) => buffer.text !== buffer.savedText)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // The path list changes only when tabs open or close, including across external renames.
  const openPaths = JSON.stringify(buffers.map((buffer) => buffer.path));
  useEffect(() => {
    const paths: string[] = JSON.parse(openPaths);
    if (!paths.length) return;
    const id = crypto.randomUUID();
    let active = true;
    const versions = new Map<string, number>();
    const refresh = async (path: string) => {
      const version = (versions.get(path) ?? 0) + 1;
      versions.set(path, version);
      const before = buffersRef.current.find((buffer) => buffer.path === path);
      if (!before) return;
      try {
        const disk = await hub.ideRead(root, path);
        if (!active || versions.get(path) !== version) return;
        setBuffers((previous) => previous.map((buffer) => {
          if (buffer.path !== path || buffer.diskHash !== before.diskHash || disk.diskHash === buffer.diskHash) return buffer;
          if (buffer.text !== buffer.savedText) return { ...buffer, conflict: true };
          return { ...disk, savedText: disk.text };
        }));
      } catch (error) { if (active) report(error); }
    };
    const off = hub.onFileChange((event) => {
      if (event.id !== id) return;
      if (event.error) { report(event.error); return; }
      void refresh(event.path);
    });
    const registered = hub.ideWatch(id, root, paths);
    void registered.then(() => { if (active) paths.forEach((path) => void refresh(path)); }).catch(report);
    return () => {
      active = false;
      off();
      void registered.then(() => hub.ideUnwatch(id)).catch(report);
    };
  }, [root, openPaths, report]);

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

  return (
    <div className="flex min-h-0 flex-1">
      {quickOpen && <QuickOpen root={root} mode={quickOpen} onOpen={navigate} onClose={() => setQuickOpen(null)} />}
      <div
        className="flex min-w-0 flex-1 flex-col bg-bg"
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); }
        }}
      >
        {buffers.length > 0 && (
          <div className="flex overflow-x-auto border-b border-edge bg-surface/40">
            {buffers.map((buffer) => {
              const active = selected === buffer.path;
              const modified = buffer.text !== buffer.savedText;
              return (
                <div
                  key={buffer.path}
                  className={cx(
                    'group flex shrink-0 items-center border-r border-edge transition-colors',
                    active ? 'bg-bg text-fg' : 'text-muted hover:bg-hover/60 hover:text-fg',
                  )}
                >
                  <button
                    className="flex items-center gap-1.5 px-3 py-2 text-[12px]"
                    title={buffer.path}
                    onClick={() => { setSelected(buffer.path); setDiskText(null); }}
                  >
                    <Icon name="lucide:file-code" size={12} className={active ? 'text-accent' : 'text-subtle'} />
                    <span>{buffer.path.split(/[\\/]/).pop()}</span>
                    {modified && <span className="size-1.5 rounded-full bg-accent" />}
                    {buffer.conflict && <span className="text-warn">⚠</span>}
                  </button>
                  <button
                    className="mr-1.5 grid size-5 place-items-center rounded text-subtle opacity-60 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100"
                    aria-label={`Schließen: ${buffer.path}`}
                    onClick={() => {
                      if (modified && !window.confirm('Ungespeicherte Änderungen verwerfen?')) { return; }
                      setBuffers((previous) => previous.filter((item) => item.path !== buffer.path));
                      if (selected === buffer.path) { setDiskText(null); setSelected(buffers.find((item) => item.path !== buffer.path)?.path ?? ''); }
                    }}
                  >
                    <Icon name="lucide:x" size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {error && <div role="alert" className="border-b border-bad/30 bg-bad/10 px-3 py-2 text-[12px] text-bad">{error}</div>}
        {current && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 border-b border-edge bg-surface/30 px-3 py-1.5 text-[11.5px]">
              <button className="btn !py-0.5 text-[11.5px]" disabled={busy || current.conflict || current.text === current.savedText} onClick={() => void save()}>
                <Icon name="lucide:save" size={12} />
                <span>Speichern</span>
              </button>
              <button className="icon-btn !size-6" title="Neu laden" onClick={() => void reload()}>
                <Icon name="lucide:refresh-cw" size={12} />
              </button>
              <button className="icon-btn !size-6" title="Suchen / Ersetzen" onClick={() => editor.current?.find()}>
                <Icon name="lucide:search" size={12} />
              </button>
              <button className="icon-btn !size-6" title="Befehlspalette" onClick={() => editor.current?.commands()}>
                <Icon name="lucide:terminal" size={12} />
              </button>
              {language && (
                <div className="ml-1 flex items-center gap-1.5 border-l border-edge pl-2">
                  <span className="inline-flex items-center gap-1 text-subtle" title={status?.message}>
                    <span className={cx('size-1.5 rounded-full', status?.state === 'ready' ? 'bg-ok' : status?.state === 'starting' ? 'bg-warn animate-pulse' : 'bg-subtle')} />
                    LSP
                  </span>
                  <button className="btn !px-2 !py-0.5 text-[11px]" disabled={status?.state === 'starting'} onClick={() => void lsp.start(language, !!status && status.state !== 'stopped')}>
                    {status?.state === 'ready' ? 'Neu starten' : 'Aktivieren'}
                  </button>
                  {status?.state === 'ready' && (
                    <button className="btn !px-2 !py-0.5 text-[11px]" onClick={() => void lsp.stop(language)}>Stoppen</button>
                  )}
                </div>
              )}
              <div className="flex-1" />
              <button className={cx('btn !px-2 !py-0.5 text-[11px]', problems.length > 0 && 'border-warn/40 text-warn')} onClick={() => setProblemsOpen((previous) => !previous)}>
                Probleme ({problems.length})
              </button>
              <span className="text-[11px] text-subtle">{current.languageId} · UTF-8 · {current.lineEnding}</span>
            </div>
            {status?.message && <div role="status" className="border-b border-edge bg-warn/10 px-3 py-1 text-[11.5px] text-warn">{status.message}</div>}
            {current.conflict && (
              <div className="flex items-center gap-2 border-b border-edge bg-warn/10 px-3 py-1.5 text-[12px] text-warn">
                <span>Externe Änderung erkannt.</span>
                <button className="btn !py-0.5 text-[11.5px]" onClick={() => void hub.ideRead(root, current.path).then((document) => setDiskText(document.text)).catch(report)}>
                  Datenträger vergleichen
                </button>
              </div>
            )}
            {diskText !== null && (
              <div className="flex items-center gap-2 border-b border-edge bg-surface px-3 py-1 text-[11.5px] text-muted">
                <span>Links: Datenträger · Rechts: aktueller Buffer</span>
                <button className="btn !py-0.5 text-[11px]" onClick={() => setDiskText(null)}>Vergleich schließen</button>
              </div>
            )}
            <MonacoPane
              ref={editor}
              documents={buffers}
              selected={selected}
              diskText={diskText}
              onChange={(path, text) => setBuffers((previous) => previous.map((buffer) => buffer.path === path ? { ...buffer, text } : buffer))}
              onModel={lsp.onModel}
              onCloseModel={lsp.onCloseModel}
              onSave={() => { void save(); }}
              onNavigate={navigate}
            />
            {problemsOpen && (
              <div className="max-h-44 shrink-0 overflow-auto border-t border-edge bg-surface/60 p-2 text-[12px]" aria-label="LSP-Probleme">
                {!problems.length && <p className="px-2 py-1 text-subtle">Keine Diagnosen für die geöffneten Dateien.</p>}
                {problems.map((problem, index) => (
                  <button key={`${problem.path}:${index}`} className="block w-full rounded px-2 py-1 text-left hover:bg-hover" onClick={() => void navigate(problem.path, problem.range.start.line + 1, problem.range.start.character + 1)}>
                    <span className={(problem.severity ?? 1) === 1 ? 'text-bad' : 'text-warn'}>{(problem.severity ?? 1) === 1 ? 'Fehler' : 'Hinweis'}</span> {problem.path.split(/[\\/]/).pop()}:{problem.range.start.line + 1} · {problem.message}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {!current && (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-subtle">
            <Icon name="lucide:code-2" size={28} className="mb-3 opacity-40" />
            <p className="text-[13px] text-muted">Datei im Explorer öffnen</p>
            <div className="mt-3 flex items-center gap-3 text-[11.5px]">
              <span className="inline-flex items-center gap-1"><kbd className="kbd-pill">Strg+P</kbd> Öffnen</span>
              <span className="inline-flex items-center gap-1"><kbd className="kbd-pill">Strg+Shift+F</kbd> Suche</span>
              <span className="inline-flex items-center gap-1"><kbd className="kbd-pill">Strg+S</kbd> Speichern</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
