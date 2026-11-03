import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { git } from '../electron/git.ts';

const original = childProcess.execFile;
let calls = 0;
const disconnected = () => Object.assign(new Error('spawn ENOTCONN'), { code: 'ENOTCONN' });
try {
  childProcess.execFile = (_binary, _args, _options, callback) => {
    calls++;
    if (calls === 1) { throw disconnected(); }
    callback(null, 'success', '');
  };
  syncBuiltinESMExports();
  assert.deepEqual(await git('/workspace', ['status']), { ok: true, out: 'success', err: '' });
  assert.equal(calls, 2);
  calls = 0;
  childProcess.execFile = () => { calls++; throw disconnected(); };
  syncBuiltinESMExports();
  await assert.rejects(git('/workspace', ['status']), /Git.*workspace.*ENOTCONN/);
  assert.equal(calls, 2, 'persistent startup failure must stop after one retry');
  calls = 0;
  childProcess.execFile = (_binary, _args, _options, callback) => {
    calls++;
    callback(disconnected(), '', '');
  };
  syncBuiltinESMExports();
  assert.equal((await git('/workspace', ['commit'])).ok, false);
  assert.equal(calls, 1, 'commands reported through callbacks must never be replayed');
  console.log('Git launch: bounded pre-launch retry, contextual failure and no replay after launch passed.');
} finally { childProcess.execFile = original; syncBuiltinESMExports(); }
