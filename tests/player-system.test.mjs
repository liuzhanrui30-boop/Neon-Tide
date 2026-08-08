import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createEventQueue } from '../src/game/events.js';
import {
  FIXED_PLAYER_STEP,
  PERFECT_PHASE_REFUND,
  createPlayerState,
  resolvePlayerHit,
  selectAutomaticTarget,
  updatePlayer,
  updatePlayerState,
} from '../src/systems/player-system.js';

const input = (patch = {}) => ({
  moveX: 0,
  moveY: 0,
  dashPressed: false,
  ultimatePressed: false,
  inputDevice: 'keyboard',
  ...patch,
});

test('player accelerates, turns and damps without teleporting velocity', () => {
  const player = createPlayerState();
  updatePlayerState(player, input({ moveX: 1 }), FIXED_PLAYER_STEP);
  assert.ok(player.velocity.x > 0 && player.velocity.x < player.maxSpeed);
  const before = player.velocity.x;
  updatePlayerState(player, input({ moveX: -1 }), FIXED_PLAYER_STEP);
  assert.ok(player.velocity.x < before);
  assert.ok(player.velocity.x > -player.maxSpeed);

  for (let step = 0; step < 600; step += 1) updatePlayerState(player, input({ moveX: 1 }), FIXED_PLAYER_STEP);
  assert.ok(Math.hypot(player.velocity.x, player.velocity.y) <= player.maxSpeed + 1e-9);
  const moving = player.velocity.x;
  updatePlayerState(player, input(), FIXED_PLAYER_STEP);
  assert.ok(player.velocity.x < moving && player.velocity.x > 0);
});

test('fixed 1/60 simulation is render-rate independent', () => {
  const sixty = createPlayerState();
  const thirty = createPlayerState();
  for (let frame = 0; frame < 120; frame += 1) {
    updatePlayerState(sixty, input({ moveX: frame < 70 ? 1 : -0.5, moveY: 0.35 }), FIXED_PLAYER_STEP);
  }
  for (let frame = 0; frame < 60; frame += 1) {
    for (let fixed = 0; fixed < 2; fixed += 1) {
      const step = frame * 2 + fixed;
      updatePlayerState(thirty, input({ moveX: step < 70 ? 1 : -0.5, moveY: 0.35 }), FIXED_PLAYER_STEP);
    }
  }
  assert.ok(Math.hypot(sixty.position.x - thirty.position.x, sixty.position.y - thirty.position.y) <= 1e-12);
});

test('phase dash consumes exactly one of two charges and recharges both boundedly', () => {
  const player = createPlayerState();
  const emitted = [];
  updatePlayerState(player, input({ moveX: 1, dashPressed: true }), FIXED_PLAYER_STEP, {
    emit(type, payload) { emitted.push({ type, payload }); },
  });
  assert.deepEqual(player.dashCharges, [0, 1]);
  assert.ok(player.dashTimer > 0);
  assert.ok(player.phaseTimer > 0);
  assert.ok(player.perfectPhaseWindow > 0 && player.perfectPhaseWindow <= 0.12);
  assert.equal(emitted[0].type, 'player:dash');

  updatePlayerState(player, input({ dashPressed: true }), FIXED_PLAYER_STEP);
  assert.ok(player.dashCharges[0] > 0 && player.dashCharges[0] < 0.02);
  assert.equal(player.dashCharges[1], 1);
  for (let step = 0; step < 300; step += 1) updatePlayerState(player, input(), FIXED_PLAYER_STEP);
  assert.deepEqual(player.dashCharges, [1, 1]);
});

test('perfect phase is a discrete event with bounded refund and fire-rate buff', () => {
  const player = createPlayerState({ dashCharges: [0, 1], perfectPhaseWindow: 0.1, phaseTimer: 0.1 });
  const emitted = [];
  let damage = 0;
  const session = { damageHull(amount) { damage += amount; return true; } };
  const events = { emit(type, payload) { emitted.push({ type, payload }); return true; } };

  assert.equal(resolvePlayerHit(player, session, events), false);
  assert.equal(damage, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'perfectPhase');
  assert.equal(player.dashCharges[0], PERFECT_PHASE_REFUND);
  assert.ok(player.autoFireRateBuffTimer > 0);
  assert.equal(player.perfectPhaseWindow, 0);
  assert.equal(resolvePlayerHit(player, session, events), true);
  assert.equal(damage, 1);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].type, 'player:damaged');
});

test('camera lead updates after movement, has a deadzone, and never changes body position', () => {
  const player = createPlayerState();
  updatePlayerState(player, input({ moveX: 1 }), FIXED_PLAYER_STEP);
  const positionAfterMove = { ...player.position };
  assert.ok(player.cameraLead.x > 0);
  assert.deepEqual(player.position, positionAfterMove);

  const idle = createPlayerState({ position: { x: 0.02, y: -0.02 } });
  updatePlayerState(idle, input(), FIXED_PLAYER_STEP);
  assert.ok(Math.hypot(idle.cameraLead.x, idle.cameraLead.y) < 1e-9);
});

test('updatePlayer uses numeric EntityWorld ids and writes immutable snapshots', () => {
  const world = createEntityWorld();
  const id = world.spawn('player', {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: Math.PI / 2,
    dashCharges: [1, 1],
    maxSpeed: 6.15,
  });
  const events = createEventQueue();
  const session = { snapshot: () => ({ mode: 'playing' }) };
  assert.equal(updatePlayer(world, session, input({ moveX: 1 }), FIXED_PLAYER_STEP, events), id);
  const snapshot = world.get(id);
  assert.ok(snapshot.x > 0);
  assert.ok(snapshot.vx > 0);
  assert.ok(snapshot.cameraLeadX > 0);
  assert.ok(Object.isFrozen(snapshot));
  world.dispose();
});


test('automatic target selection prioritizes visible weak points and is deterministic', () => {
  const candidates = [
    { id: 30, x: 1, y: 0, visible: true, type: 'chaser', threat: 1 },
    { id: 20, x: 5, y: 0, visible: true, type: 'boss', threat: 8 },
    { id: 10, x: 7, y: 1, visible: true, type: 'bossPart', weakPoint: true, threat: 4 },
    { id: 5, x: 0.2, y: 0, visible: false, type: 'bossPart', weakPoint: true, threat: 20 },
  ];
  const selected = selectAutomaticTarget(candidates, { x: 0, y: 0 });
  assert.equal(selected.target.id, 10);
  assert.equal(selected.mode, 'target');
  assert.ok(Math.abs(Math.hypot(selected.direction.x, selected.direction.y) - 1) < 1e-9);

  const nearest = selectAutomaticTarget([
    { id: 2, x: 3, y: 0, visible: true },
    { id: 1, x: 2, y: 0, visible: true },
  ], { x: 0, y: 0 });
  assert.equal(nearest.target.id, 1);
  assert.equal(selectAutomaticTarget([], { x: 0, y: 0 }), null);
});

test('perfect-phase buff measurably shortens automatic pulse cadence', () => {
  const collectIntervals = (buffSeconds) => {
    const player = createPlayerState({ autoFireRateBuffTimer: buffSeconds });
    const times = [];
    let elapsed = 0;
    const events = {
      emit(type) {
        if (type === 'player:autoPulse') times.push(elapsed);
        return true;
      },
    };
    while (times.length < 3) {
      elapsed += FIXED_PLAYER_STEP;
      updatePlayerState(player, input(), FIXED_PLAYER_STEP, events);
    }
    return times[1] - times[0];
  };
  const base = collectIntervals(0);
  const buffed = collectIntervals(2);
  assert.ok(base > buffed, JSON.stringify({ base, buffed }));
  assert.ok(Math.abs(buffed / base - 0.75) < 0.08, JSON.stringify({ base, buffed }));
});
