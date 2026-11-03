import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorDocument } from '@shared/ide/types';
import { lspLanguage, type LspDiagnostics, type LspLanguage, type LspStatus } from '@shared/ide/lsp';
import { hub } from '@/lib/api';
import { monaco } from './monaco';
import { registerLspProviders } from './lspProviders';

interface AttachedModel { language?: LspLanguage; model: monaco.editor.ITextModel; subscription: monaco.IDisposable }

export function useLsp(root: string, documents: EditorDocument[], onError: (error: unknown) => void) {
  const [statuses, setStatuses] = useState<Partial<Record<LspLanguage, LspStatus>>>({});
  const [diagnostics, setDiagnostics] = useState<Record<string, LspDiagnostics>>({});
  const statusRef = useRef(statuses);
  const documentRef = useRef(documents);
  const models = useRef(new Map<string, AttachedModel>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const active = useRef(true);
  documentRef.current = documents;

  const sync = useCallback(async (path: string, model: monaco.editor.ITextModel): Promise<void> => {
    const document = documentRef.current.find((item) => item.path === path);
    const language = document ? lspLanguage(document.languageId) : undefined;
    if (!document || !language || statusRef.current[language]?.state !== 'ready' || model.isDisposed()) { return; }
    clearTimeout(timers.current.get(path));
    timers.current.delete(path);
    await hub.lspSync({ root, path, language, languageId: document.languageId, version: model.getVersionId(), text: model.getValue() });
  }, [root]);

  const onModel = useCallback((path: string, model: monaco.editor.ITextModel) => {
    const subscription = model.onDidChangeContent(() => {
      monaco.editor.setModelMarkers(model, 'quorum-lsp', []);
      setDiagnostics((previous) => { const next = { ...previous }; delete next[path]; return next; });
      clearTimeout(timers.current.get(path));
      timers.current.set(path, setTimeout(() => { void sync(path, model).catch(onError); }, 180));
    });
    const document = documentRef.current.find((item) => item.path === path);
    models.current.set(path, { model, subscription, language: document ? lspLanguage(document.languageId) : undefined });
    void sync(path, model).catch(onError);
  }, [sync, onError]);

  const onCloseModel = useCallback((path: string) => {
    const attached = models.current.get(path);
    attached?.subscription.dispose();
    models.current.delete(path);
    clearTimeout(timers.current.get(path));
    timers.current.delete(path);
    const language = attached?.language;
    if (language) { void hub.lspClose(root, language, path).catch(onError); }
    if (active.current) { setDiagnostics((previous) => { const next = { ...previous }; delete next[path]; return next; }); }
  }, [root, onError]);

  useEffect(() => {
    active.current = true;
    const unsubscribe = hub.onLspEvent((event) => {
      if (event.type === 'status') {
        if (event.status.root !== root) { return; }
        statusRef.current = { ...statusRef.current, [event.status.language]: event.status };
        setStatuses(statusRef.current);
        if (event.status.state === 'ready') {
          for (const [path, entry] of models.current) { void sync(path, entry.model).catch(onError); }
        }
        return;
      }
      const payload = event.diagnostics;
      const model = models.current.get(payload.path)?.model;
      if (payload.root !== root || !model || model.isDisposed() || payload.version !== model.getVersionId()) { return; }
      setDiagnostics((previous) => ({ ...previous, [payload.path]: payload }));
      monaco.editor.setModelMarkers(model, 'quorum-lsp', payload.diagnostics.map((diagnostic) => ({
        startLineNumber: diagnostic.range.start.line + 1, startColumn: diagnostic.range.start.character + 1,
        endLineNumber: diagnostic.range.end.line + 1, endColumn: diagnostic.range.end.character + 1,
        message: diagnostic.message, source: diagnostic.source, code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
        severity: ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint })[diagnostic.severity ?? 1] ?? monaco.MarkerSeverity.Error,
      })));
    });
    const providers = registerLspProviders({
      owns: (model) => models.current.get(model.uri.fsPath)?.model === model,
      error: onError,
      request: async (model, position, feature, token) => {
        const path = model.uri.fsPath;
        const document = documentRef.current.find((item) => item.path === path);
        const language = document ? lspLanguage(document.languageId) : undefined;
        if (!language || statusRef.current[language]?.state !== 'ready' || token.isCancellationRequested) { return; }
        const version = model.getVersionId();
        await sync(path, model);
        if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) { return; }
        let reply;
        try { reply = await hub.lspRequest({ root, language, path, version, feature, position: { line: position.lineNumber - 1, character: position.column - 1 } }); }
        catch (error) {
          if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) { return; }
          throw error;
        }
        if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== reply.version) { return; }
        return reply;
      },
    });
    return () => {
      active.current = false;
      unsubscribe();
      providers();
      for (const timer of timers.current.values()) { clearTimeout(timer); }
      timers.current.clear();
      for (const entry of models.current.values()) { entry.subscription.dispose(); }
      for (const language of ['typescript', 'python'] as const) { void hub.lspStop(root, language).catch(() => undefined); }
    };
  }, [root, sync, onError]);

  const start = async (language: LspLanguage, restart = false) => {
    try {
      if (restart) { await hub.lspStop(root, language); }
      const status = await hub.lspStart(root, language);
      if (!active.current) { await hub.lspStop(root, language); return; }
      statusRef.current = { ...statusRef.current, [language]: status };
      setStatuses(statusRef.current);
    } catch (error) { if (active.current) { onError(error); } }
  };
  const stop = async (language: LspLanguage) => {
    try { await hub.lspStop(root, language); }
    catch (error) { onError(error); }
  };
  const saved = async (path: string, savedText: string) => {
    const document = documentRef.current.find((item) => item.path === path);
    const model = models.current.get(path)?.model;
    const language = document ? lspLanguage(document.languageId) : undefined;
    if (!language || !model || statusRef.current[language]?.state !== 'ready') { return; }
    await sync(path, model);
    if (model.getValue(undefined, true) === savedText) { await hub.lspSaved(root, language, path); }
  };
  return { statuses, diagnostics, start, stop, saved, onModel, onCloseModel };
}
