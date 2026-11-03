import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const output = await mkdtemp(join(tmpdir(), 'quorum-close-test-'));
try {
  await build({ configFile: false, logLevel: 'error', resolve: { alias: { electron: resolve('scripts/fixtures/chat-lifecycle-electron.ts') } },
    build: { ssr: 'scripts/fixtures/chat-lifecycle-test.ts', outDir: output, emptyOutDir: true, minify: false, rollupOptions: { output: { entryFileNames: 'check.mjs' } } } });
  await import(pathToFileURL(join(output, 'check.mjs')).href);
} finally { await rm(output, { recursive: true, force: true }); }
