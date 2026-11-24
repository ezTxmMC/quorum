import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const helpers = new Set(['check-chat-platform.mjs', 'check-lsp-server-relay.mjs']);
const files = await readdir(new URL('./', import.meta.url));
for (const file of files.sort()) {
  if (!/^check-.*\.mjs$/.test(file) || helpers.has(file)) continue;
  test(file, async () => {
    await run(process.execPath, ['scripts/' + file], { timeout: 120_000 });
  });
}
