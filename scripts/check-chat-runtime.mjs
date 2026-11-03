import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageChatRuntime } from '../electron/chat-host/runtime.ts';

const root = await mkdtemp(join(tmpdir(), 'quorum-runtime-'));
try {
  const source = join(root, 'source');
  await mkdir(join(source, 'scripts', 'chunks'), { recursive: true });
  await mkdir(join(source, 'python'), { recursive: true });
  const executable = join(source, 'host');
  const worker = join(source, 'scripts', 'chat-worker.js');
  const python = join(source, 'python');
  await writeFile(executable, 'native-v1');
  await writeFile(worker, "import './chunks/helper.js';");
  await writeFile(join(source, 'scripts', 'chunks', 'helper.js'), 'export const value = 1;');
  await writeFile(join(python, 'worker.py'), 'print(1)');
  const first = await stageChatRuntime(root, executable, worker, python);
  assert.deepEqual(await stageChatRuntime(root, executable, worker, python), first);
  await writeFile(executable, 'native-v2');
  const second = await stageChatRuntime(root, executable, worker, python);
  assert.notEqual(second.executable, first.executable, 'updates retain the running version');
  await rm(source, { recursive: true });
  assert.equal(await readFile(first.executable, 'utf8'), 'native-v1');
  assert.equal(await readFile(first.worker, 'utf8'), "import './chunks/helper.js';");
  assert.equal(await readFile(join(first.pythonRoot, 'worker.py'), 'utf8'), 'print(1)');
  assert.equal(await readFile(join(first.worker, '..', 'chunks', 'helper.js'), 'utf8'), 'export const value = 1;');
  console.log('Durable runtime: version isolation and scripts/Python survive source removal.');
} finally { await rm(root, { recursive: true, force: true }); }
