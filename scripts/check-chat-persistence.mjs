import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults, save, waitForSave, flushSaveSync, setDataDirResolver, onSaved } from '../electron/store.ts';
const root = await mkdtemp(join(tmpdir(), 'quorum-chat-save-'));
setDataDirResolver(() => root);
const acknowledged = [];
const unsubscribe = onSaved((data) => acknowledged.push(data.settings.defaultCwd));
try {
  const first = defaults(); first.settings.defaultCwd = 'first';
  const second = structuredClone(first); second.settings.defaultCwd = 'second';
  save(first); const pending = waitForSave(); save(second);
  await pending; await waitForSave();
  assert.equal(JSON.parse(await readFile(join(root, 'hub.json'), 'utf8')).settings.defaultCwd, 'second');
  assert.equal(acknowledged.at(-1), 'second', 'worker acknowledgements follow an actual atomic save');
  const bad = join(root, 'not-a-directory'); await writeFile(bad, 'occupied');
  setDataDirResolver(() => bad);
  const previousCount = acknowledged.length;
  save(first);
  await assert.rejects(waitForSave());
  assert.equal(acknowledged.length, previousCount, 'failed saves cannot acknowledge a journal');
  assert.equal(flushSaveSync(first), false, 'close coordinator can keep the window open on disk errors');
  setDataDirResolver(() => root);
  save(second); await waitForSave();
  assert.equal(flushSaveSync(first), true);
  assert.equal(JSON.parse(await readFile(join(root, 'hub.json'), 'utf8')).settings.defaultCwd, 'first');
  console.log('Chat persistence: serialized async writes, durable close flush, failure reporting and journal acknowledgements passed.');
} finally { unsubscribe(); await rm(root, { recursive: true, force: true }); }
