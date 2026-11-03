// The Python harness owns the real processes; this script exercises the actual manager over relayed stdio.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { LspManager } from '../core/ide/lsp/manager.ts';

const [language, root, path] = process.argv.slice(2);
const events = [];
const transport = new EventEmitter();
transport.stdin = process.stdout;
transport.stdout = process.stdin;
transport.stderr = new PassThrough();
const manager = new LspManager((event) => events.push(event), () => ({ executable: 'relay', args: [], environment: {} }), () => transport);
const source = language === 'typescript'
  ? 'export const greeting: string = "hello";\nconst wrong: string = 42;\ngreeting.toUpperCase();\n'
  : 'value: str = 42\nvalue.upper()\n';
const position = language === 'typescript' ? { line: 2, character: 9 } : { line: 1, character: 6 };
const symbol = language === 'typescript' ? { line: 2, character: 3 } : { line: 1, character: 2 };
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
let exitCode = 0;
try {
  assert.equal((await manager.start(root, language)).state, 'ready');
  const document = { root, language, path, languageId: language, text: source, version: 1 };
  manager.sync(document);
  const request = { root, language, path, version: 1, position };
  const completion = await manager.request({ ...request, feature: 'completion' });
  const suggestions = Array.isArray(completion.result) ? completion.result : completion.result.items;
  assert.ok(suggestions.some((item) => item.label === (language === 'typescript' ? 'toUpperCase' : 'upper')), `${language} completion`);
  const hover = await manager.request({ ...request, position: symbol, feature: 'hover' });
  assert.ok(hover.result?.contents, `${language} hover`);
  const definition = await manager.request({ ...request, position: symbol, feature: 'definition' });
  assert.ok(definition.result.length, `${language} definition`);
  const references = await manager.request({ ...request, position: symbol, feature: 'references' });
  assert.ok(references.result.length, `${language} references`);
  await waitFor(() => events.some((event) => event.type === 'diagnostics' && event.diagnostics.version === 1 && event.diagnostics.diagnostics.some((item) => item.severity === 1)), `${language} diagnostics did not arrive`);
  manager.sync({ ...document, version: 2, text: source.replace('= 42', '= "fixed"') });
  manager.saved(root, language, path);
  // didChange immediately clears obsolete markers; wait for the server's new diagnostic notification as well.
  const afterChange = events.length;
  await waitFor(() => events.slice(afterChange).some((event) => event.type === 'diagnostics' && event.diagnostics.version === 2 && !event.diagnostics.diagnostics.some((item) => item.severity === 1)), `${language} fresh diagnostics did not arrive`);
  await assert.rejects(manager.request({ ...request, position: symbol, feature: 'hover' }), /Stale/);
  process.stderr.write(`${language}: initialize, open/change/save, completion, hover, definition, references and diagnostics passed.\n`);
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  exitCode = 1;
} finally {
  await manager.dispose();
  process.stdout.write('', () => process.exit(exitCode));
}
