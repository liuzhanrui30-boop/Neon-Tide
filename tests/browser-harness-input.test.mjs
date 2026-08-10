import assert from 'node:assert/strict';
import test from 'node:test';
import { GamePage } from './browser/harness.mjs';

function createFakeClient({ failDownAttempts = 0, dispatchDelayMs = 0 } = {}) {
  const calls = [];
  let downAttempts = 0;
  let inFlight = 0;
  let maximumInFlight = 0;
  return {
    calls,
    get maximumInFlight() { return maximumInFlight; },
    async send(method, params = {}, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      if (method === 'Debugger.resume') throw new Error('Debugger.resume: Can only perform operation while paused.');
      if (method !== 'Input.dispatchKeyEvent') return {};
      if (params.type === 'rawKeyDown') {
        downAttempts += 1;
        if (downAttempts <= failDownAttempts) {
          throw new Error(`Input.dispatchKeyEvent timed out after ${timeoutMs}ms`);
        }
      }
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      if (dispatchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, dispatchDelayMs));
      inFlight -= 1;
      return {};
    },
  };
}

test('bounded input recovers a lost CDP acknowledgement, releases keys, and retries once', async () => {
  const client = createFakeClient({ failDownAttempts: 1 });
  const page = new GamePage('input-recovery', {}, client, {
    inputCommandTimeoutMs: 17,
    inputRecoveryTimeoutMs: 9,
  });
  page.setScenarioStage('protocol-zero:firewall:1/4');

  assert.equal(await page.dispatchKey('rawKeyDown', 'd', 'KeyD'), true);
  assert.deepEqual(page.getInputDiagnostics(), {
    stage: 'protocol-zero:firewall:1/4',
    debuggerPaused: false,
    heldKeys: [{ key: 'd', code: 'KeyD' }],
    inputSequence: 1,
    inputRecoveryCount: 1,
    lastInputFailure: page.getInputDiagnostics().lastInputFailure,
  });
  assert.match(page.getInputDiagnostics().lastInputFailure.cause, /timed out after 17ms/);
  assert.ok(client.calls.some(({ method }) => method === 'Page.bringToFront'));
  assert.ok(client.calls.some(({ method, params, timeoutMs }) => (
    method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && params.code === 'Space' && timeoutMs === 9
  )));

  await page.dispatchKey('keyUp', 'd', 'KeyD');
  assert.deepEqual(page.getInputDiagnostics().heldKeys, []);
});

test('input batches dispatch simultaneous direction keys without serial acknowledgement waits', async () => {
  const client = createFakeClient({ dispatchDelayMs: 8 });
  const page = new GamePage('input-batch', {}, client, {
    inputCommandTimeoutMs: 25,
    inputRecoveryTimeoutMs: 9,
  });
  await page.dispatchKeyBatch([
    { type: 'rawKeyDown', key: 'w', code: 'KeyW' },
    { type: 'rawKeyDown', key: 'd', code: 'KeyD' },
  ]);
  assert.equal(client.maximumInFlight, 2);
  assert.deepEqual(page.getInputDiagnostics().heldKeys, [
    { key: 'w', code: 'KeyW' },
    { key: 'd', code: 'KeyD' },
  ]);
});

test('a second bounded input failure reports stage and leaves no held-key state', async () => {
  const client = createFakeClient({ failDownAttempts: 2 });
  const page = new GamePage('input-terminal', {}, client, {
    inputCommandTimeoutMs: 13,
    inputRecoveryTimeoutMs: 7,
  });
  page.setScenarioStage('data-city:dual-crisis:natural');
  await assert.rejects(
    page.dispatchKey('rawKeyDown', 'a', 'KeyA'),
    /input batch 1 failed at data-city:dual-crisis:natural/,
  );
  assert.equal(page.getInputDiagnostics().inputRecoveryCount, 2);
  assert.deepEqual(page.getInputDiagnostics().heldKeys, []);
});
