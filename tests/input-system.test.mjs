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
