import type { LspReply, LspRequest } from '@shared/ide/lsp';
import { monaco } from './monaco';

type Model = monaco.editor.ITextModel;
export interface LspProviderHost {
  owns(model: Model): boolean;
  request(model: Model, position: monaco.Position, feature: LspRequest['feature'], token: monaco.CancellationToken): Promise<LspReply | undefined>;
  error(error: unknown): void;
}
function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) { return value as Record<string, unknown>; }
  return {};
}
function range(value: unknown): monaco.IRange | undefined {
  const item = object(value);
  const start = object(item.start);
  const end = object(item.end);
  if (![start.line, start.character, end.line, end.character].every((part) => Number.isSafeInteger(part) && Number(part) >= 0)) { return; }
  return { startLineNumber: Number(start.line) + 1, startColumn: Number(start.character) + 1, endLineNumber: Number(end.line) + 1, endColumn: Number(end.character) + 1 };
}
function markdown(value: unknown): monaco.IMarkdownString[] {
  if (Array.isArray(value)) { return value.flatMap(markdown); }
  if (typeof value === 'string') { return [{ value, isTrusted: false, supportHtml: false }]; }
  const item = object(value);
  if (typeof item.value !== 'string') { return []; }
  if (item.language && typeof item.language === 'string') {
    return [{ value: `\`\`\`${item.language.replace(/[^\w+-]/g, '')}\n${item.value}\n\`\`\``, isTrusted: false, supportHtml: false }];
  }
  return [{ value: item.kind === 'plaintext' ? item.value.replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&') : item.value, isTrusted: false, supportHtml: false }];
}
const kinds = [
  monaco.languages.CompletionItemKind.Text, monaco.languages.CompletionItemKind.Method,
  monaco.languages.CompletionItemKind.Function, monaco.languages.CompletionItemKind.Constructor,
  monaco.languages.CompletionItemKind.Field, monaco.languages.CompletionItemKind.Variable,
  monaco.languages.CompletionItemKind.Class, monaco.languages.CompletionItemKind.Interface,
  monaco.languages.CompletionItemKind.Module, monaco.languages.CompletionItemKind.Property,
  monaco.languages.CompletionItemKind.Unit, monaco.languages.CompletionItemKind.Value,
  monaco.languages.CompletionItemKind.Enum, monaco.languages.CompletionItemKind.Keyword,
  monaco.languages.CompletionItemKind.Snippet, monaco.languages.CompletionItemKind.Color,
  monaco.languages.CompletionItemKind.File, monaco.languages.CompletionItemKind.Reference,
  monaco.languages.CompletionItemKind.Folder, monaco.languages.CompletionItemKind.EnumMember,
  monaco.languages.CompletionItemKind.Constant, monaco.languages.CompletionItemKind.Struct,
  monaco.languages.CompletionItemKind.Event, monaco.languages.CompletionItemKind.Operator,
  monaco.languages.CompletionItemKind.TypeParameter,
];

export function registerLspProviders(host: LspProviderHost): () => void {
  const selectors = ['typescript', 'javascript', 'python'].map((language) => ({ language, scheme: 'file' }));
  const completion = monaco.languages.registerCompletionItemProvider(selectors, {
    triggerCharacters: ['.', '"', "'"],
    provideCompletionItems: async (model, position, _context, token) => {
      if (!host.owns(model)) { return { suggestions: [] }; }
      try {
        const reply = await host.request(model, position, 'completion', token);
        if (!reply || token.isCancellationRequested) { return { suggestions: [] }; }
        const list = object(reply.result);
        const defaults = object(list.itemDefaults);
        const items: unknown[] = Array.isArray(reply.result) ? reply.result : Array.isArray(list.items) ? list.items : [];
        const word = model.getWordUntilPosition(position);
        const fallback = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
        const suggestions: monaco.languages.CompletionItem[] = [];
        for (const value of items.slice(0, 500)) {
          const item = object(value);
          if (typeof item.label !== 'string') { continue; }
          const edit = object(item.textEdit);
          const editRange = range(edit.range) ?? range(edit.replace) ?? range(defaults.editRange) ?? range(object(defaults.editRange).replace) ?? fallback;
          const text = edit.newText ?? item.textEditText ?? item.insertText ?? item.label;
          suggestions.push({
            label: item.label, kind: kinds[Number(item.kind) - 1] ?? monaco.languages.CompletionItemKind.Text,
            insertText: typeof text === 'string' ? text : item.label, range: editRange,
            insertTextRules: (item.insertTextFormat ?? defaults.insertTextFormat) === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            detail: typeof item.detail === 'string' ? item.detail : undefined,
            documentation: markdown(item.documentation)[0],
            sortText: typeof item.sortText === 'string' ? item.sortText : undefined,
            filterText: typeof item.filterText === 'string' ? item.filterText : undefined,
          });
        }
        return { suggestions, incomplete: list.isIncomplete === true };
      } catch (error) { if (!token.isCancellationRequested) { host.error(error); } return { suggestions: [] }; }
    },
  });
  const hover = monaco.languages.registerHoverProvider(selectors, {
    provideHover: async (model, position, token) => {
      if (!host.owns(model)) { return null; }
      try {
        const reply = await host.request(model, position, 'hover', token);
        if (!reply || token.isCancellationRequested) { return null; }
        const result = object(reply.result);
        return { contents: markdown(result.contents), range: range(result.range) };
      } catch (error) { if (!token.isCancellationRequested) { host.error(error); } return null; }
    },
  });
  const locations = async (model: Model, position: monaco.Position, feature: 'definition' | 'references', token: monaco.CancellationToken): Promise<monaco.languages.Location[]> => {
    if (!host.owns(model)) { return []; }
    try {
      const reply = await host.request(model, position, feature, token);
      if (!reply || token.isCancellationRequested || !reply.result) { return []; }
      const values = Array.isArray(reply.result) ? reply.result : [reply.result];
      return values.flatMap((value) => {
        const item = object(value);
        const uri = item.uri ?? item.targetUri;
        const target = range(item.targetSelectionRange ?? item.range ?? item.targetRange);
        if (typeof uri !== 'string' || !target) { return []; }
        return [{ uri: monaco.Uri.parse(uri), range: target }];
      });
    } catch (error) { if (!token.isCancellationRequested) { host.error(error); } return []; }
  };
  const definition = monaco.languages.registerDefinitionProvider(selectors, { provideDefinition: (model, position, token) => locations(model, position, 'definition', token) });
  const references = monaco.languages.registerReferenceProvider(selectors, { provideReferences: (model, position, _context, token) => locations(model, position, 'references', token) });
  return () => { completion.dispose(); hover.dispose(); definition.dispose(); references.dispose(); };
}
