import * as monaco from 'monaco-editor/editor/editor.api';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/diffEditor/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/hover/register';
import 'monaco-editor/features/suggest/register';
import 'monaco-editor/features/snippet/register';
import 'monaco-editor/features/gotoSymbol/register';
import 'monaco-editor/features/referenceSearch/register';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands';
import 'monaco-editor/features/gotoError/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/quickCommand/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/folding/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/features/json/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/rust/register';

self.MonacoEnvironment = { getWorker: (_id, label) => label === 'json' ? new JsonWorker() : new EditorWorker() };

monaco.editor.defineTheme('quorum-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#171a21',
    'editorGutter.background': '#171a21',
    'editor.lineHighlightBackground': '#1e222b',
    'editor.selectionBackground': '#7c8cff40',
    'editor.inactiveSelectionBackground': '#7c8cff22',
    'editorLineNumber.foreground': '#5a6378',
    'editorLineNumber.activeForeground': '#a3adbf',
    'editorIndentGuide.background1': '#292f3d',
    'editorIndentGuide.activeBackground1': '#3b4357',
    'editorWidget.background': '#1e222b',
    'editorWidget.border': '#2e3444',
    'editorSuggestWidget.background': '#1e222b',
    'editorSuggestWidget.border': '#2e3444',
    'editorSuggestWidget.selectedBackground': '#292f3d',
    'editorHoverWidget.background': '#1e222b',
    'editorHoverWidget.border': '#2e3444',
    'input.background': '#202530',
    'scrollbarSlider.background': '#ffffff24',
    'scrollbarSlider.hoverBackground': '#ffffff3a',
    'scrollbarSlider.activeBackground': '#ffffff4d',
  },
});

monaco.editor.defineTheme('quorum-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#f7f7f5',
    'editorGutter.background': '#f7f7f5',
    'editor.lineHighlightBackground': '#efeee9',
    'editorWidget.background': '#ffffff',
    'editorSuggestWidget.background': '#ffffff',
    'editorHoverWidget.background': '#ffffff',
  },
});

export function monacoLanguage(languageId: string): string {
  if (languageId === 'typescriptreact') { return 'typescript'; }
  if (languageId === 'javascriptreact') { return 'javascript'; }
  return languageId;
}

export { monaco };
