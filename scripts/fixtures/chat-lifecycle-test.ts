import assert from 'node:assert/strict';
import { ChatLifecycle } from '../../electron/chat-host/lifecycle';
import { answers, calls, app, FakeWindow, windows, reset } from './chat-lifecycle-electron';

const settle = async () => { for (let step = 0; step < 12; step++) { await new Promise((resolve) => setImmediate(resolve)); } };
function setup({ active = true, failStop = false, failSave = false } = {}) {
  reset();
  let quitting = false;
  const manager = {
    pauseStarts: () => undefined, resumeStarts: () => undefined, prepareDetach: async () => undefined,
    active: async () => active ? [{}] : [],
    stopAll: async () => { calls.push('stop'); if (failStop) { throw new Error('Stop not confirmed'); } },
  };
  const coordinator = new ChatLifecycle({
    manager: manager as never,
    windows: () => windows.filter((window) => !window.destroyed) as never,
    save: () => { calls.push('save'); return !failSave; },
    acknowledge: async () => { calls.push('ack'); },
    cleanup: async (keep) => { calls.push(`cleanup:${keep ? 'keep' : 'stop'}`); },
    setQuitting: (value) => { quitting = value; },
  });
  const window = new FakeWindow(1);
  coordinator.guard(window as never);
  return { coordinator, window, quitting: () => quitting };
}

let test = setup();
answers.push(0);
test.window.close(); await settle();
assert.equal(test.window.destroyed, false);
assert.equal(app.exited, false);
assert.deepEqual(calls, ['question'], 'cancel never stops a job or flushes an unapproved close');

test = setup(); answers.push(1);
test.window.close(); await settle();
assert.equal(app.exited, true);
assert.equal(test.window.destroyed, true);
assert.deepEqual(calls, ['question', 'prepare:1', 'save', 'ack', 'cleanup:keep']);
assert.equal(test.quitting(), true);

test = setup(); answers.push(2);
app.quit(); await settle();
assert.equal(app.exited, true);
assert.deepEqual(calls, ['question', 'prepare:1', 'save', 'ack', 'stop', 'cleanup:stop']);

test = setup({ failStop: true }); answers.push(2);
app.quit(); await settle();
assert.equal(app.exited, false);
assert.equal(test.window.destroyed, false);
assert.equal(test.quitting(), false);
assert.ok(calls.includes('error:Stop not confirmed'));
assert.equal(calls.some((call) => call.startsWith('cleanup:')), false);

test = setup({ failSave: true }); answers.push(2);
test.window.close(); await settle();
assert.equal(app.exited, false);
assert.equal(calls.includes('stop'), false, 'do not stop processes if the latest UI cannot be persisted');

test = setup(); test.window.prepareError = 'save failure'; answers.push(1);
test.window.close(); await settle();
assert.equal(app.exited, false);
assert.ok(calls.includes('error:save failure'));

test = setup(); const other = new FakeWindow(2); test.coordinator.guard(other as never); answers.push(1);
test.window.close(); await settle();
assert.equal(test.window.destroyed, true);
assert.equal(other.destroyed, false);
assert.equal(app.exited, false);
assert.deepEqual(calls, ['question', 'prepare:1', 'save', 'ack']);

test = setup({ active: false }); test.window.close(); await settle();
assert.equal(app.exited, true);
assert.equal(calls.includes('question'), false);
console.log('Close lifecycle: cancel, keep, stop, durable flush, stop failure, save failure and multiple windows passed.');
