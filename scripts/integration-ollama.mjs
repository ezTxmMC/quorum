import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setOllamaSettings, host } from '../electron/providers/ollama.ts';
import { ollamaManagement, ollamaModelAction, pullOllama, cancelOllamaPull, ollamaPullList, startOllama, stopOllama } from '../electron/providers/ollama-management.ts';

if (process.platform !== 'win32') {
  const outside = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ version: 'fixture', models: [] })); });
  let directory;
  try {
    await new Promise((resolve) => outside.listen(0, '127.0.0.1', resolve));
    const port = outside.address().port;
    setOllamaSettings(() => ({ host: `http://127.0.0.1:${port}`, binary: '/does-not-exist', mode: 'api' }));
    await assert.rejects(() => startOllama(), /API-Modus/);
    setOllamaSettings(() => ({ host: `http://127.0.0.1:${port}`, binary: '/does-not-exist', mode: 'local' }));
    await startOllama();
    assert.equal((await ollamaManagement()).owned, false);
    await assert.rejects(() => stopOllama(), /nicht von Quorum/);
    assert((await fetch(`http://127.0.0.1:${port}/api/version`)).ok);
    await new Promise((resolve) => outside.close(resolve));
    directory = await mkdtemp(join(tmpdir(), 'quorum-ollama-test-'));
    const binary = join(directory, 'fake-ollama.mjs');
    await writeFile(binary, `#!/usr/bin/env node
import { createServer } from 'node:http';
const endpoint = new URL('http://' + process.env.OLLAMA_HOST);
const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({version:'fixture',models:[]})); });
server.listen(Number(endpoint.port), endpoint.hostname);
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`, { mode: 0o700 });
    setOllamaSettings(() => ({ host: `http://127.0.0.1:${port}`, binary, mode: 'local' }));
    await startOllama();
    assert.equal((await ollamaManagement()).owned, true);
    await stopOllama();
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/version`));
  } finally {
    await stopOllama().catch(() => {});
    if (outside.listening) await new Promise((resolve) => outside.close(resolve));
    if (directory) await rm(directory, { recursive: true, force: true });
    setOllamaSettings(() => ({}));
  }
}
