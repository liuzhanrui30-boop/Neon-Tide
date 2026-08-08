import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRadialDeadzone,
  createInputSystem,
  normalizeActionSnapshot,
} from '../src/systems/input-system.js';

const nearly = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) <= epsilon;

test('keyboard, touch joystick, and gamepad normalize to the same named action snapshot', () => {
  const keyboard = normalizeActionSnapshot({ keyboard: { right: true, up: true } });
  const touch = normalizeActionSnapshot({ touch: { x: 1, y: 1 } });
  const gamepad = normalizeActionSnapshot({ gamepad: { axes: [1, -1], dash: false, ultimate: false } });

  for (const snapshot of [keyboard, touch, gamepad]) {
    assert.ok(nearly(snapshot.moveX, Math.SQRT1_2));
    assert.ok(nearly(snapshot.moveY, Math.SQRT1_2));
    assert.deepEqual(Object.keys(snapshot), ['moveX', 'moveY', 'dashPressed', 'ultimatePressed', 'inputDevice']);
  }
  assert.equal(keyboard.inputDevice, 'keyboard');
  assert.equal(touch.inputDevice, 'touch');
  assert.equal(gamepad.inputDevice, 'gamepad');
});

test('radial deadzone rejects drift and rescales the surviving stick range', () => {
  assert.deepEqual(applyRadialDeadzone(0.1, 0.1, 0.2), { x: 0, y: 0 });
  const output = applyRadialDeadzone(0.6, 0.8, 0.2);
  assert.ok(nearly(Math.hypot(output.x, output.y), 1));
  assert.ok(nearly(output.x / output.y, 0.75));
});

test('pointer and mouse positions never enter gameplay input', () => {
  const snapshot = normalizeActionSnapshot({
    keyboard: { right: true },
    pointer: { x: 999, y: -123 },
    mouseX: 42,
    mouseY: 24,
  });
  assert.deepEqual(snapshot, {
    moveX: 1,
    moveY: 0,
    dashPressed: false,
    ultimatePressed: false,
    inputDevice: 'keyboard',
  });
  assert.equal('pointer' in snapshot, false);
  assert.equal('aimX' in snapshot, false);
  assert.equal('aimY' in snapshot, false);
});

test('held movement persists while dash and ultimate are buffered press edges', () => {
  const system = createInputSystem({ autoStart: false });
  system.setKeyboardAction('moveRight', true);
  system.press('dash', 'keyboard');
  system.press('ultimate', 'keyboard');

  assert.deepEqual(system.snapshot(), {
    moveX: 1,
    moveY: 0,
    dashPressed: true,
    ultimatePressed: true,
    inputDevice: 'keyboard',
  });
  assert.deepEqual(system.snapshot(), {
    moveX: 1,
    moveY: 0,
    dashPressed: false,
    ultimatePressed: false,
    inputDevice: 'keyboard',
  });
  system.dispose();
});

test('last active device owns movement without combining unlike device vectors', () => {
  const system = createInputSystem({ autoStart: false });
  system.setKeyboardAction('moveRight', true);
  system.setTouchVector(0, 1);
  assert.deepEqual(system.snapshot(), {
    moveX: 0,
    moveY: 1,
    dashPressed: false,
    ultimatePressed: false,
    inputDevice: 'touch',
  });
  system.setGamepadState({ axes: [-1, 0], buttons: [] });
  assert.deepEqual(system.snapshot(), {
    moveX: -1,
    moveY: 0,
    dashPressed: false,
    ultimatePressed: false,
    inputDevice: 'gamepad',
  });
  system.dispose();
});

test('gamepad disconnect zeros movement and button history then relinquishes ownership', () => {
  let pads = [{ connected: true, axes: [0.8, 0], buttons: [{ pressed: true }] }];
  const system = createInputSystem({ autoStart: false, navigator: { getGamepads: () => pads } });
  const active = system.snapshot();
  assert.equal(active.inputDevice, 'gamepad');
  assert.ok(active.moveX > 0);
  assert.equal(active.dashPressed, true);

  pads = [];
  const disconnected = system.snapshot();
  assert.deepEqual(disconnected, {
    moveX: 0,
    moveY: 0,
    dashPressed: false,
    ultimatePressed: false,
    inputDevice: 'keyboard',
  });
  pads = [{ connected: true, axes: [0, 0], buttons: [{ pressed: true }] }];
  assert.equal(system.snapshot().dashPressed, true, 'fresh reconnect press must not inherit stale history');
  system.disconnectGamepad();
  system.setGamepadState({ connected: true, axes: [0, 0], buttons: [{ pressed: true }] });
  system.disconnectGamepad();
  pads = [];
  assert.equal(system.snapshot().dashPressed, false, 'disconnect must discard an unconsumed gamepad edge');
  system.dispose();
});

test('blur and explicit reset clear buffered edges as well as held vectors', () => {
  const system = createInputSystem({ autoStart: false });
  system.setKeyboardAction('moveRight', true);
  system.press('dash', 'keyboard');
  system.press('ultimate', 'keyboard');
  system.reset();
  assert.deepEqual(system.snapshot(), {
    moveX: 0,
    moveY: 0,
    dashPressed: false,
    ultimatePressed: false,
    inputDevice: 'keyboard',
  });
  system.dispose();
});

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener));
  }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this, detail: 0, ...event });
  }
  closest() { return null; }
}

test('native button provenance never erases held keyboard movement', () => {
  const hostWindow = new FakeTarget();
  const dashButton = new FakeTarget();
  const ultimateButton = new FakeTarget();
  const system = createInputSystem({ window: hostWindow, dashButton, ultimateButton });
  system.setKeyboardAction('moveRight', true);

  dashButton.emit('pointerdown', { pointerType: 'touch' });
  dashButton.emit('click', { detail: 1 });
  const touchActivated = system.snapshot();
  assert.equal(touchActivated.moveX, 1);
  assert.equal(touchActivated.inputDevice, 'touch');
  assert.equal(touchActivated.dashPressed, true);
  assert.equal(system.getLastPressDevice(), 'touch');
  assert.equal(system.snapshot().inputDevice, 'keyboard');

  ultimateButton.emit('click', { detail: 0 });
  const assistiveActivated = system.snapshot();
  assert.equal(assistiveActivated.moveX, 1);
  assert.equal(assistiveActivated.inputDevice, 'keyboard');
  assert.equal(assistiveActivated.ultimatePressed, true);
  assert.equal(system.getLastPressDevice(), 'keyboard');

  system.setKeyboardAction('moveRight', false);
  system.setTouchVector(0, 1);
  assert.equal(system.snapshot().inputDevice, 'touch');
  dashButton.emit('click', { detail: 0 });
  const switchAfterTouch = system.snapshot();
  assert.deepEqual(switchAfterTouch, {
    moveX: 0,
    moveY: 1,
    dashPressed: true,
    ultimatePressed: false,
    inputDevice: 'keyboard',
  });
  assert.equal(system.getLastPressDevice(), 'keyboard');
  assert.deepEqual(system.snapshot(), {
    moveX: 0,
    moveY: 1,
    dashPressed: false,
    ultimatePressed: false,
    inputDevice: 'touch',
  }, 'one native activation must yield one edge without stealing held touch movement');

  system.setGamepadState({ connected: true, axes: [-1, 0], buttons: [] });
  assert.equal(system.snapshot().inputDevice, 'gamepad');
  ultimateButton.emit('click', { detail: 0 });
  const enterAfterGamepad = system.snapshot();
  assert.deepEqual(enterAfterGamepad, {
    moveX: -1,
    moveY: 0,
    dashPressed: false,
    ultimatePressed: true,
    inputDevice: 'keyboard',
  });
  assert.equal(system.getLastPressDevice(), 'keyboard');
  assert.deepEqual(system.snapshot(), {
    moveX: -1,
    moveY: 0,
    dashPressed: false,
    ultimatePressed: false,
    inputDevice: 'gamepad',
  }, 'keyboard click must not double-fire or steal held gamepad movement');
  system.dispose();
});
