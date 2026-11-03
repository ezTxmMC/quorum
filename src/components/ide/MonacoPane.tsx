import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useHub } from '@/lib/store';
import { monaco, monacoLanguage } from './monaco';
import type { EditorDocument } from '@shared/ide/types';

export interface MonacoPaneHandle {
  model(path: string): monaco.editor.ITextModel | undefined;
  focus(path: string, line?: number, column?: number): void;
  find(): void;
  commands(): void;
}
interface Props {
  documents: EditorDocument[];
  selected: string;
  diskText: string | null;
  onChange: (path: string, text: string, version: number) => void;
  onModel: (path: string, model: monaco.editor.ITextModel) => void;
  onCloseModel: (path: string) => void;
  onSave: () => void;
  onNavigate: (path: string, line: number, column: number) => Promise<boolean>;
}

export const MonacoPane = forwardRef<MonacoPaneHandle, Props>(function MonacoPane(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const diffContainer = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffEditor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const activePath = useRef('');
  const callbacks = useRef(props);
  callbacks.current = props;
  const theme = useHub((state) => state.data.settings.theme);

  useImperativeHandle(ref, () => ({
    model: (path) => models.current.get(path),
    focus: (path, line = 1, column = 1) => {
      const model = models.current.get(path);
      if (!model || !editor.current) { return; }
      editor.current.setModel(model);
      editor.current.setPosition({ lineNumber: line, column });
      editor.current.revealLineInCenter(line);
      editor.current.focus();
    },
    find: () => { void editor.current?.getAction('actions.find')?.run(); },
    commands: () => { void editor.current?.getAction('editor.action.quickCommand')?.run(); },
  }), []);

  useEffect(() => {
    if (!container.current) { return; }
    const instance = monaco.editor.create(container.current, {
      model: null, automaticLayout: true, fontSize: 13, lineHeight: 22, minimap: { enabled: false },
      scrollBeyondLastLine: false, tabSize: 2, insertSpaces: true, ariaLabel: 'Datei bearbeiten',
      fixedOverflowWidgets: true, padding: { top: 10 },
    });
    editor.current = instance;
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor: async (source, resource, selection) => {
        const sourceModel = source.getModel();
        if (!sourceModel || !models.current.has(sourceModel.uri.fsPath) || resource.scheme !== 'file') { return false; }
        const line = selection && 'startLineNumber' in selection ? selection.startLineNumber : selection?.lineNumber ?? 1;
        const column = selection && 'startColumn' in selection ? selection.startColumn : selection?.column ?? 1;
        return callbacks.current.onNavigate(resource.fsPath, line, column);
      },
    });
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.current.onSave());
    return () => {
      diffEditor.current?.setModel(null);
      for (const [path, model] of models.current) { callbacks.current.onCloseModel(path); model.dispose(); }
      models.current.clear();
      views.current.clear();
      activePath.current = '';
      opener.dispose();
      instance.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => { monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark'); }, [theme]);

  useEffect(() => {
    const paths = new Set(props.documents.map((document) => document.path));
    for (const [path, model] of models.current) {
      if (paths.has(path)) { continue; }
      callbacks.current.onCloseModel(path);
      if (diffEditor.current?.getModel()?.modified === model) { diffEditor.current.setModel(null); }
      if (editor.current?.getModel() === model) { editor.current.setModel(null); }
      model.dispose();
      models.current.delete(path);
      views.current.delete(path);
    }
    for (const document of props.documents) {
      const existing = models.current.get(document.path);
      if (existing) {
        if (existing.getValue(undefined, true) !== document.text) { existing.setValue(document.text); }
        continue;
      }
      const model = monaco.editor.createModel(document.text, monacoLanguage(document.languageId), monaco.Uri.file(document.path));
      models.current.set(document.path, model);
      model.onDidChangeContent(() => {
        callbacks.current.onChange(document.path, model.getValue(undefined, true), model.getVersionId());
      });
      callbacks.current.onModel(document.path, model);
    }
    const instance = editor.current;
    if (!instance || activePath.current === props.selected) { return; }
    if (activePath.current) { views.current.set(activePath.current, instance.saveViewState()); }
    instance.setModel(models.current.get(props.selected) ?? null);
    instance.restoreViewState(views.current.get(props.selected) ?? null);
    activePath.current = props.selected;
  }, [props.documents, props.selected]);

  useEffect(() => {
    if (props.diskText === null || !diffContainer.current) { return; }
    const modified = models.current.get(props.selected);
    if (!modified) { return; }
    const original = monaco.editor.createModel(props.diskText, modified.getLanguageId());
    const instance = monaco.editor.createDiffEditor(diffContainer.current, {
      automaticLayout: true, readOnly: true, originalEditable: false, minimap: { enabled: false },
      renderSideBySide: true, fontSize: 13, ariaLabel: 'Datenträger mit Buffer vergleichen',
    });
    diffEditor.current = instance;
    instance.setModel({ original, modified });
    return () => { instance.dispose(); original.dispose(); diffEditor.current = null; };
  }, [props.diskText, props.selected]);

  return <div className="relative min-h-0 flex-1">
    <div ref={container} className={`absolute inset-0 ${props.diskText === null ? '' : 'invisible'}`} />
    {props.diskText !== null && <div ref={diffContainer} className="absolute inset-0" />}
  </div>;
});
