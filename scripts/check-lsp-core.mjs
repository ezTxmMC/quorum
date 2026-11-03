import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { LspRpc } from '../core/ide/lsp/rpc.ts';
import { LspManager } from '../core/ide/lsp/manager.ts';
import { installedServer } from '../core/ide/lsp/servers.ts';

const frame = (value) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};
const messages = [];
function child(onMessage = () => undefined) {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  let buffer = Buffer.alloc(0);
  process.stdin = new Writable({ write(chunk, _encoding, done) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const header = buffer.indexOf('\r\n\r\n');
      if (header < 0) break;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, header).toString())[1]);
      if (buffer.length < header + 4 + length) break;
      const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length));
      buffer = buffer.subarray(header + 4 + length);
      messages.push(message);
      queueMicrotask(() => onMessage(message, process));
    }
    done();
  } });
  return process;
}

let failure;
const notices = [];
const process = child((message, server) => {
  if (message.method === 'echo') {
    const bytes = frame({ id: message.id, result: 'Grüße 🌍' });
    server.stdout.write(bytes.subarray(0, 10));
    server.stdout.write(bytes.subarray(10, bytes.length - 2));
    server.stdout.write(bytes.subarray(bytes.length - 2));
  }
});
const rpc = new LspRpc(process, (method, params) => notices.push({ method, params }), () => ({ safe: true }), (error) => { failure = error; });
assert.equal(await rpc.request('echo'), 'Grüße 🌍', 'fragmented UTF-8 messages are framed by byte length');
process.stdout.write(Buffer.concat([frame({ method: 'one', params: 1 }), frame({ method: 'two', params: 2 })]));
assert.deepEqual(notices.map((notice) => notice.method), ['one', 'two']);
process.stdout.write(frame({ id: 500, method: 'workspace/applyEdit', params: {} }));
assert.deepEqual(messages.at(-1).result, { safe: true });
await assert.rejects(rpc.request('never', {}, 15), /timed out/);
assert.equal(messages.at(-1).method, '$/cancelRequest');
const waiting = rpc.request('pending');
process.emit('error', new Error('simulated crash'));
await assert.rejects(waiting, /simulated crash/);
assert.ok(failure);
rpc.dispose();

const malformedChild = child();
const malformed = new LspRpc(malformedChild, () => {}, () => {}, (error) => { failure = error; });
malformedChild.stdout.write(Buffer.from('Content-Length: 9000000\r\n\r\n'));
assert.match(failure.message, /length/);
await assert.rejects(malformed.request('closed'), /unavailable/);

const root = mkdtempSync(join(tmpdir(), 'quorum-lsp-'));
const file = join(root, 'sample.ts');
writeFileSync(file, 'const value = "hello";\nvalue;');
const events = [];
const servers = [];
let syncKind = 2;
let pendingHover;
const manager = new LspManager((event) => events.push(event), () => ({ executable: 'test', args: [], environment: {} }), () => {
  const server = child((message, connection) => {
    if (message.method === 'initialize') {
      assert.deepEqual(message.params.capabilities.general.positionEncodings, ['utf-16']);
      connection.stdout.write(frame({ id: message.id, result: { capabilities: { positionEncoding: 'utf-16', textDocumentSync: { openClose: true, change: syncKind, save: { includeText: true } }, hoverProvider: true, completionProvider: {}, definitionProvider: true, referencesProvider: true } } }));
    }
    if (message.method === 'shutdown') connection.stdout.write(frame({ id: message.id, result: null }));
    if (message.method === 'textDocument/hover') pendingHover = () => connection.stdout.write(frame({ id: message.id, result: { contents: 'value' } }));
    if (message.method === 'textDocument/definition') connection.stdout.write(frame({ id: message.id, result: [{ uri: pathToFileURL(file).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }, { uri: 'file:///etc/passwd', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] }));
  });
  servers.push(server);
  return server;
});
try {
  assert.equal((await manager.start(root, 'typescript')).state, 'ready');
  assert.equal((await manager.start(root, 'typescript')).state, 'ready');
  assert.equal(servers.length, 1, 'same workspace/language reuses one server');
  const document = { root, language: 'typescript', path: file, languageId: 'typescript', version: 1, text: 'const value = "hello";\r\nvalue;' };
  manager.sync(document);
  assert.equal(messages.at(-1).method, 'textDocument/didOpen');
  manager.sync({ ...document, version: 2, text: 'const value = 1;\r\nvalue;' });
  const change = messages.at(-1);
  assert.equal(change.method, 'textDocument/didChange');
  assert.deepEqual(change.params.contentChanges[0].range.end, { line: 1, character: 6 });
  assert.throws(() => manager.sync(document), /Stale/);
  assert.throws(() => manager.sync({ ...document, version: 2, text: 'different' }), /conflicts/);
  assert.throws(() => manager.sync({ ...document, path: '/etc/passwd' }), /outside/);
  assert.throws(() => manager.sync({ ...document, version: 3, languageId: 'python' }), /language/);
  const uri = pathToFileURL(file).href;
  const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'test diagnostic', severity: 1 };
  const before = events.length;
  servers[0].stdout.write(frame({ method: 'textDocument/publishDiagnostics', params: { uri, version: 1, diagnostics: [diagnostic] } }));
  assert.equal(events.length, before, 'stale diagnostics rejected');
  servers[0].stdout.write(frame({ method: 'textDocument/publishDiagnostics', params: { uri, version: 2, diagnostics: [diagnostic] } }));
  assert.equal(events.at(-1).diagnostics.version, 2);
  assert.equal(events.at(-1).diagnostics.diagnostics[0].message, 'test diagnostic');
  const request = { root, language: 'typescript', path: file, version: 2, feature: 'hover', position: { line: 0, character: 6 } };
  const hover = manager.request(request);
  await new Promise((resolve) => setImmediate(resolve));
  manager.sync({ ...document, version: 3, text: 'const value = 2;' });
  pendingHover();
  await assert.rejects(hover, /stale/);
  const definition = await manager.request({ ...request, version: 3, feature: 'definition' });
  assert.equal(definition.result.length, 1, 'navigation outside workspace is filtered');
  await assert.rejects(manager.request({ ...request, version: 3, feature: 'executeCommand' }), /Unsupported/);
  manager.saved(root, 'typescript', file);
  assert.equal(messages.at(-1).method, 'textDocument/didSave');
  assert.equal(messages.at(-1).params.text, 'const value = 2;');
  manager.closeDocument(root, 'typescript', file);
  assert.equal(messages.at(-1).method, 'textDocument/didClose');
  await manager.stop(root, 'typescript');
  assert.ok(messages.some((message) => message.method === 'shutdown'));
  assert.ok(messages.some((message) => message.method === 'exit'));
  syncKind = 1;
  await manager.start(root, 'typescript');
  manager.sync(document);
  manager.sync({ ...document, version: 2, text: 'full text' });
  assert.deepEqual(messages.at(-1).params.contentChanges, [{ text: 'full text' }], 'full synchronization respects negotiation');
  servers.at(-1).emit('exit', 1);
  assert.equal(events.filter((event) => event.type === 'status').at(-1).status.state, 'failed');
  await manager.stop(root, 'typescript');
  await manager.start(root, 'typescript');
  rmSync(root, { recursive: true });
  await manager.dispose();
  for (const language of ['typescript', 'python']) {
    const command = installedServer(language);
    assert.equal(command.environment.NODE_OPTIONS, undefined);
    assert.equal(command.environment.OPENAI_API_KEY, undefined);
    assert.ok(command.args[0].includes(language === 'python' ? 'pyright' : 'typescript-language-server'));
  }
  console.log('LSP core: framing, limits, timeouts, crash, lifecycle, document versions, full/incremental sync, navigation and diagnostics passed.');
} finally {
  await manager.dispose();
  rmSync(root, { recursive: true, force: true });
}
