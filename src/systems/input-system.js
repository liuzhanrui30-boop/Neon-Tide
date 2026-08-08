const MOVE_ACTIONS = Object.freeze(['moveLeft', 'moveRight', 'moveDown', 'moveUp']);
const PRESS_ACTIONS = Object.freeze(['dash', 'ultimate']);
const DEVICE_NAMES = new Set(['keyboard', 'touch', 'gamepad']);
const DEFAULT_DEADZONE = 0.2;

function finiteAxis(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(-1, Math.min(1, number)) : 0;
}

export function normalizeMoveVector(x, y) {
  const safeX = finiteAxis(x);
  const safeY = finiteAxis(y);
  const length = Math.hypot(safeX, safeY);
  if (length <= 1 || length === 0) return { x: safeX, y: safeY };
  return { x: safeX / length, y: safeY / length };
}

export function applyRadialDeadzone(x, y, deadzone = DEFAULT_DEADZONE) {
  const safeDeadzone = Number.isFinite(deadzone) ? Math.max(0, Math.min(0.95, deadzone)) : DEFAULT_DEADZONE;
  const vector = normalizeMoveVector(x, y);
  const magnitude = Math.hypot(vector.x, vector.y);
  if (magnitude <= safeDeadzone) return { x: 0, y: 0 };
  const scaledMagnitude = Math.min(1, (magnitude - safeDeadzone) / (1 - safeDeadzone));
  return {
    x: (vector.x / magnitude) * scaledMagnitude,
    y: vector.y === 0 ? 0 : (vector.y / magnitude) * scaledMagnitude,
  };
}

function keyboardVector(keyboard = {}) {
  return normalizeMoveVector(
    Number(Boolean(keyboard.right ?? keyboard.moveRight)) - Number(Boolean(keyboard.left ?? keyboard.moveLeft)),
    Number(Boolean(keyboard.up ?? keyboard.moveUp)) - Number(Boolean(keyboard.down ?? keyboard.moveDown)),
  );
}

function touchVector(touch = {}) {
  return normalizeMoveVector(touch.x, touch.y);
}

function gamepadVector(gamepad = {}, deadzone = DEFAULT_DEADZONE) {
  const axes = Array.isArray(gamepad.axes) ? gamepad.axes : [];
  return applyRadialDeadzone(axes[0], -(axes[1] ?? 0), deadzone);
}

function freezeSnapshot(move, dashPressed, ultimatePressed, inputDevice) {
  return Object.freeze({
    moveX: move.x,
    moveY: move.y,
    dashPressed: Boolean(dashPressed),
    ultimatePressed: Boolean(ultimatePressed),
    inputDevice: DEVICE_NAMES.has(inputDevice) ? inputDevice : 'keyboard',
  });
}

export function normalizeActionSnapshot(devices = {}, options = {}) {
  const deadzone = options.deadzone ?? DEFAULT_DEADZONE;
  const hasTouch = devices.touch != null;
  const hasGamepad = devices.gamepad != null;
  const hasKeyboard = devices.keyboard != null;
  const requestedDevice = DEVICE_NAMES.has(devices.inputDevice) ? devices.inputDevice : null;
  const inputDevice = requestedDevice ?? (hasGamepad ? 'gamepad' : hasTouch ? 'touch' : 'keyboard');
  let move = { x: 0, y: 0 };
  let dashPressed = false;
  let ultimatePressed = false;

  if (inputDevice === 'gamepad' && hasGamepad) {
    move = gamepadVector(devices.gamepad, deadzone);
    dashPressed = Boolean(devices.gamepad.dash);
    ultimatePressed = Boolean(devices.gamepad.ultimate);
  } else if (inputDevice === 'touch' && hasTouch) {
    move = touchVector(devices.touch);
    dashPressed = Boolean(devices.touch.dash);
    ultimatePressed = Boolean(devices.touch.ultimate);
  } else if (hasKeyboard) {
    move = keyboardVector(devices.keyboard);
    dashPressed = Boolean(devices.keyboard.dash);
    ultimatePressed = Boolean(devices.keyboard.ultimate);
  }
  return freezeSnapshot(move, dashPressed, ultimatePressed, inputDevice);
}

function pressedButton(buttons, index) {
  const button = buttons?.[index];
  return Boolean(typeof button === 'number' ? button > 0.5 : button?.pressed || button?.value > 0.5);
}

function actionFromKey(event) {
  const key = event.key?.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === 'a' || key === 'ArrowLeft') return 'moveLeft';
  if (key === 'd' || key === 'ArrowRight') return 'moveRight';
  if (key === 's' || key === 'ArrowDown') return 'moveDown';
  if (key === 'w' || key === 'ArrowUp') return 'moveUp';
  if (event.code === 'Space') return 'dash';
  if (event.code === 'KeyE') return 'ultimate';
  return null;
}

export function createInputSystem(options = {}) {
  const hostWindow = options.window ?? globalThis.window ?? null;
  const hostDocument = options.document ?? globalThis.document ?? null;
  const hostNavigator = options.navigator ?? globalThis.navigator ?? null;
  const deadzone = options.deadzone ?? DEFAULT_DEADZONE;
  const keyboard = Object.fromEntries(MOVE_ACTIONS.map((action) => [action, false]));
  const touch = { x: 0, y: 0 };
  let gamepad = { axes: [0, 0], buttons: [] };
  let lastActiveDevice = 'keyboard';
  let dashBuffered = false;
  let ultimateBuffered = false;
  let dashBufferDevice = null;
  let ultimateBufferDevice = null;
  let previousGamepadDash = false;
  let previousGamepadUltimate = false;
  let gamepadConnected = false;
  let lastPressDevice = 'keyboard';
  let started = false;
  let disposed = false;
  const listeners = [];

  function remember(device) {
    if (DEVICE_NAMES.has(device)) lastActiveDevice = device;
  }

  function press(action, device = lastActiveDevice, { claimMovement = false } = {}) {
    if (!PRESS_ACTIONS.includes(action)) return false;
    const resolvedDevice = DEVICE_NAMES.has(device) ? device : lastActiveDevice;
    lastPressDevice = resolvedDevice;
    if (claimMovement) remember(resolvedDevice);
    if (action === 'dash') {
      dashBuffered = true;
      dashBufferDevice = resolvedDevice;
    } else {
      ultimateBuffered = true;
      ultimateBufferDevice = resolvedDevice;
    }
    return true;
  }

  function setKeyboardAction(action, held) {
    if (!MOVE_ACTIONS.includes(action)) return false;
    keyboard[action] = Boolean(held);
    if (held) remember('keyboard');
    return true;
  }

  function setTouchVector(x, y) {
    const vector = normalizeMoveVector(x, y);
    touch.x = vector.x;
    touch.y = vector.y;
    if (Math.hypot(vector.x, vector.y) > 0.001) remember('touch');
    return vector;
  }

  function setGamepadState(next = {}) {
    gamepadConnected = next.connected !== false;
    gamepad = {
      axes: Array.isArray(next.axes) ? [next.axes[0] ?? 0, next.axes[1] ?? 0] : [0, 0],
      buttons: Array.isArray(next.buttons) ? next.buttons : [],
    };
    const move = gamepadVector(gamepad, deadzone);
    const dash = pressedButton(gamepad.buttons, 0) || pressedButton(gamepad.buttons, 5);
    const ultimate = pressedButton(gamepad.buttons, 1) || pressedButton(gamepad.buttons, 4);
    if (Math.hypot(move.x, move.y) > 0.001) remember('gamepad');
    if (dash && !previousGamepadDash) press('dash', 'gamepad');
    if (ultimate && !previousGamepadUltimate) press('ultimate', 'gamepad');
    previousGamepadDash = dash;
    previousGamepadUltimate = ultimate;
    return move;
  }

  function fallbackMovementDevice() {
    const keyboardMove = keyboardVector(keyboard);
    if (Math.hypot(keyboardMove.x, keyboardMove.y) > 0.001) return 'keyboard';
    if (Math.hypot(touch.x, touch.y) > 0.001) return 'touch';
    return 'keyboard';
  }

  function disconnectGamepad() {
    const wasConnected = gamepadConnected || lastActiveDevice === 'gamepad';
    gamepadConnected = false;
    gamepad = { axes: [0, 0], buttons: [] };
    previousGamepadDash = false;
    previousGamepadUltimate = false;
    if (dashBufferDevice === 'gamepad') {
      dashBuffered = false;
      dashBufferDevice = null;
    }
    if (ultimateBufferDevice === 'gamepad') {
      ultimateBuffered = false;
      ultimateBufferDevice = null;
    }
    if (lastActiveDevice === 'gamepad') lastActiveDevice = fallbackMovementDevice();
    return wasConnected;
  }

  function pollGamepad() {
    if (typeof hostNavigator?.getGamepads !== 'function') return;
    const pads = hostNavigator.getGamepads();
    const active = pads ? Array.from(pads).find((pad) => pad?.connected !== false) : null;
    if (active) setGamepadState(active);
    else if (gamepadConnected || lastActiveDevice === 'gamepad') disconnectGamepad();
  }

  function snapshot() {
    if (disposed) return freezeSnapshot({ x: 0, y: 0 }, false, false, lastActiveDevice);
    pollGamepad();
    let move;
    if (lastActiveDevice === 'touch') move = touchVector(touch);
    else if (lastActiveDevice === 'gamepad') move = gamepadVector(gamepad, deadzone);
    else move = keyboardVector(keyboard);
    const actionDevice = dashBuffered || ultimateBuffered ? lastPressDevice : lastActiveDevice;
    const result = freezeSnapshot(move, dashBuffered, ultimateBuffered, actionDevice);
    dashBuffered = false;
    ultimateBuffered = false;
    dashBufferDevice = null;
    ultimateBufferDevice = null;
    return result;
  }

  function bind(target, type, listener, listenerOptions) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, listener, listenerOptions);
    listeners.push(() => target.removeEventListener(type, listener, listenerOptions));
  }

  function start() {
    if (started || disposed) return false;
    started = true;
    bind(hostWindow, 'keydown', (event) => {
      if (event.target?.closest?.("button,[role='button'],input,select,textarea,a,[contenteditable='true']")) return;
      const action = actionFromKey(event);
      if (!action) return;
      if (MOVE_ACTIONS.includes(action)) setKeyboardAction(action, true);
      else if (!event.repeat) press(action, 'keyboard');
    });
    bind(hostWindow, 'keyup', (event) => {
      const action = actionFromKey(event);
      if (MOVE_ACTIONS.includes(action)) setKeyboardAction(action, false);
    });
    bind(hostWindow, 'blur', resetHeld);
    const dashButton = options.dashButton ?? hostDocument?.querySelector?.('#dash-button');
    const ultimateButton = options.ultimateButton ?? hostDocument?.querySelector?.('#laser-button');
    // Click is deliberate: native buttons retain keyboard/switch activation and
    // pointer coordinates never enter the gameplay snapshot. A tracked touch
    // remains touch-only provenance; keyboard, mouse and switch-style clicks
    // report the keyboard action class without changing continuous movement.
    const bindNativeAction = (button, action) => {
      let pointerDevice = null;
      bind(button, 'pointerdown', (event) => {
        pointerDevice = event.pointerType === 'touch' ? 'touch' : null;
      });
      bind(button, 'click', (event) => {
        const device = event.detail === 0 ? 'keyboard' : (pointerDevice ?? 'keyboard');
        pointerDevice = null;
        press(action, device);
      });
    };
    bindNativeAction(dashButton, 'dash');
    bindNativeAction(ultimateButton, 'ultimate');
    bind(hostWindow, 'gamepaddisconnected', disconnectGamepad);
    return true;
  }

  function resetHeld() {
    for (const action of MOVE_ACTIONS) keyboard[action] = false;
    touch.x = 0;
    touch.y = 0;
    gamepadConnected = false;
    gamepad = { axes: [0, 0], buttons: [] };
    previousGamepadDash = false;
    previousGamepadUltimate = false;
    dashBuffered = false;
    ultimateBuffered = false;
    dashBufferDevice = null;
    ultimateBufferDevice = null;
    lastActiveDevice = 'keyboard';
    lastPressDevice = 'keyboard';
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    listeners.splice(0).forEach((remove) => remove());
    resetHeld();
    return true;
  }

  if (options.autoStart !== false) start();
  return Object.freeze({
    snapshot,
    press,
    setKeyboardAction,
    setTouchVector,
    setGamepadState,
    disconnectGamepad,
    resetHeld,
    reset: resetHeld,
    start,
    dispose,
    getLastActiveDevice: () => lastActiveDevice,
    getLastPressDevice: () => lastPressDevice,
  });
}
