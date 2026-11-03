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

export function monacoLanguage(languageId: string): string {
  if (languageId === 'typescriptreact') { return 'typescript'; }
  if (languageId === 'javascriptreact') { return 'javascript'; }
  return languageId;
}

export { monaco };
