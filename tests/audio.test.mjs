import test from 'node:test';
import assert from 'node:assert/strict';

import NeonAudio, * as audioModule from '../src/game/audio.js';

class MockParam {
  constructor(context, defaultValue = 0) {
    this.context = context;
    this.value = defaultValue;
    this.events = [];
  }

  setValueAtTime(value, time = 0) {
    if (time <= (this.context?.currentTime ?? 0)) this.value = value;
    this.events.push({ method: 'setValueAtTime', value, time });
  }

  setTargetAtTime(value, time = 0, constant = 0) {
    this.events.push({ method: 'setTargetAtTime', value, time, constant });
  }

  cancelScheduledValues(time = 0) {
    this.events = this.events.filter((event) => !Number.isFinite(event.time) || event.time < time);
    this.events.push({ method: 'cancelScheduledValues', time });
  }

  cancelAndHoldAtTime(time = 0) {
    this.events = this.events.filter((event) => !Number.isFinite(event.time) || event.time < time);
    this.events.push({ method: 'cancelAndHoldAtTime', time, value: this.value });
  }

  exponentialRampToValueAtTime(value, time = 0) {
    if (time <= (this.context?.currentTime ?? 0)) this.value = value;
    this.events.push({ method: 'exponentialRampToValueAtTime', value, time });
  }
}

class MockNode {
  constructor(context, kind = 'node') {
    this.context = context;
    this.kind = kind;
    this.connections = [];
    this.disconnected = false;
  }

  connect(target) {
    this.connections.push(target);
    this.context?.connections.push({ from: this, to: target });
    return target;
  }

  disconnect() {
    this.disconnected = true;
  }
}

class MockGain extends MockNode {
  constructor(context) {
    super(context, 'gain');
    this.gain = new MockParam(context, 1);
  }
}

class MockCompressor extends MockNode {
  constructor(context) {
    super(context, 'compressor');
    this.threshold = new MockParam(context);
    this.knee = new MockParam(context);
    this.ratio = new MockParam(context);
    this.attack = new MockParam(context);
    this.release = new MockParam(context);
  }
}

class MockOscillator extends MockNode {
  constructor(context) {
    super(context, 'oscillator');
    this.frequency = new MockParam(context);
    this.detune = new MockParam(context);
    this.type = 'sine';
    this.startTime = null;
    this.started = false;
    this.stopTime = null;
    this.stopCalls = [];
    this.onended = null;
  }

  start(time = 0) {
    this.startTime = time;
    this.started = true;
    this.context.starts.push(time);
    this.context.startedSources.push(this);
  }

  stop(time = 0) {
    if (!this.started) throw new Error('InvalidStateError: stop before start()');
    this.stopTime = time;
    this.stopCalls.push(time);
  }
}

class MockBuffer {
  constructor(numberOfChannels, length, sampleRate) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel) {
    return this.channels[channel];
  }
}

class MockBufferSource extends MockNode {
  constructor(context) {
    super(context, 'buffer-source');
    this.buffer = null;
    this.playbackRate = new MockParam(context);
    this.startTime = null;
    this.started = false;
    this.stopTime = null;
    this.stopCalls = [];
    this.onended = null;
  }

  start(time = 0) {
    this.startTime = time;
    this.started = true;
    this.context.starts.push(time);
    this.context.startedSources.push(this);
  }

  stop(time = 0) {
    if (!this.started) throw new Error('InvalidStateError: stop before start()');
    this.stopTime = time;
    this.stopCalls.push(time);
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.connections = [];
    this.destination = new MockNode(this, 'destination');
    this.starts = [];
    this.startedSources = [];
    this.gains = [];
    this.compressors = [];
  }

  createGain() {
    const gain = new MockGain(this);
    this.gains.push(gain);
    return gain;
  }

  createDynamicsCompressor() {
    const compressor = new MockCompressor(this);
    this.compressors.push(compressor);
    return compressor;
  }

  createOscillator() {
    return new MockOscillator(this);
  }

  createBuffer(numberOfChannels, length, sampleRate) {
    return new MockBuffer(numberOfChannels, length, sampleRate);
  }

  createBufferSource() {
    return new MockBufferSource(this);
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

function sourcesRoutedTo(context, bus) {
  return context.startedSources.filter((source) => source.connections[0]?.connections[0] === bus);
}

test('audio creates four buses, audible music layers and safe master headroom', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  const snapshot = audio.getDebugSnapshot();
  assert.deepEqual(snapshot.buses, ['Music', 'SFX', 'Ambience', 'UI']);
  assert.ok(snapshot.masterGain > 0.68 && snapshot.masterGain < 0.76);
  assert.equal(audio.context.compressors.length, 1);
  for (const bus of [audio.musicGain, audio.sfxGain, audio.ambienceGain, audio.uiGain]) {
    assert.equal(bus.connections[0], audio.compressor);
  }
  assert.equal(audio.compressor.connections[0], audio.masterGain);
  assert.equal(audio.masterGain.connections[0], audio.context.destination);
  audio.update(0, 0.8, 'playing', { laserReady: false, bossPhase: 1 });
  assert.ok(audio.context.starts.length >= 2);
});

test('initial stage setup is immediate and strong sfx ducks then releases music', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.setStage(1);
  assert.equal(audio.getDebugSnapshot().stageIndex, 1);
  assert.equal(audio.getDebugSnapshot().pendingStageIndex, null);
  audio.update(30, 0.7, 'playing', { laserReady: true, bossPhase: 1 });
  assert.equal(audio.getDebugSnapshot().gridStep, 0);
  audio.event('laserFire', 1);
  const snapshot = audio.getDebugSnapshot();
  assert.ok(snapshot.musicTarget < snapshot.musicBase);
  const duckEvents = audio.musicGain.gain.events.filter((event) => event.method === 'setTargetAtTime').slice(-2);
  assert.equal(duckEvents[0].constant, 0.025);
  assert.equal(duckEvents[1].constant, 0.34);
  assert.ok(duckEvents[1].time > duckEvents[0].time);
});

test('an active realm change waits for the next old-realm bar and crossfades at the boundary', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.update(0, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  audio.event('laserReady', 1);
  audio.event('pickup', 1);
  const oldGridInterval = 60 / 92 / 4;
  const oldBarDuration = oldGridInterval * 16;
  const oldMusic = sourcesRoutedTo(audio.context, audio.musicGain);
  const oldPad = oldMusic.reduce((longest, source) => (
    !longest || source.stopTime > longest.stopTime ? source : longest
  ), null);
  const nonMusicSources = [
    ...sourcesRoutedTo(audio.context, audio.uiGain),
    ...sourcesRoutedTo(audio.context, audio.sfxGain),
  ];
  const oldMusicStopCounts = oldMusic.map((source) => source.stopCalls.length);
  const nonMusicStopCounts = nonMusicSources.map((source) => source.stopCalls.length);

  audio.context.currentTime = 0.05;
  audio.setStage(1);

  assert.ok(oldMusic.length >= 2);
  oldMusic.forEach((source, index) => assert.equal(source.stopCalls.length, oldMusicStopCounts[index]));
  assert.equal(audio.getDebugSnapshot().stageIndex, 0);
  assert.equal(audio.getDebugSnapshot().pendingStageIndex, 1);

  for (let step = 1; step < 16; step += 1) {
    audio.context.currentTime = oldGridInterval * step;
    audio.update(audio.context.currentTime, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  }
  assert.equal(audio.getDebugSnapshot().stageIndex, 0);

  const startsBeforeBoundary = audio.context.starts.length;
  audio.context.currentTime = oldBarDuration;
  audio.update(oldBarDuration, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  const boundaryStarts = audio.context.starts.slice(startsBeforeBoundary);

  assert.equal(audio.getDebugSnapshot().stageIndex, 1);
  assert.equal(audio.getDebugSnapshot().pendingStageIndex, null);
  assert.ok(boundaryStarts.length >= 2);
  assert.ok(boundaryStarts.length <= 8);
  assert.ok(boundaryStarts.every((time) => Math.abs(time - oldBarDuration) < 1e-9));
  assert.ok(oldPad.stopTime > oldBarDuration);
  assert.ok(oldPad.connections[0].gain.events.some((event) => (
    event.method === 'setTargetAtTime'
    && event.value === 0.0001
    && Math.abs(event.time - oldBarDuration) < 1e-9
  )));
  assert.ok(oldPad.stopTime <= oldBarDuration + 0.031);

  const newMusic = sourcesRoutedTo(audio.context, audio.musicGain).filter((source) => (
    Math.abs(source.startTime - oldBarDuration) < 1e-9
  ));
  assert.ok(newMusic.length >= 2);
  for (const source of newMusic) {
    const fadeIn = source.connections[0].gain.events.find((event) => event.method === 'exponentialRampToValueAtTime' && event.value > 0.0001);
    assert.ok(fadeIn);
    assert.ok(fadeIn.time >= oldBarDuration + 0.029);
  }
  nonMusicSources.forEach((source, index) => assert.equal(source.stopCalls.length, nonMusicStopCounts[index]));
  const newGridInterval = 60 / 116 / 4;
  assert.ok(Math.abs(audio.nextBeatTime - (oldBarDuration + newGridInterval)) < 1e-12);
});

test('late bar-boundary realm commit rephases from the actual schedule time', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext, random: () => 0.5 });
  const stageTwoGrid = 60 / 132 / 4;
  audio.unlock();
  audio.setStage(2);
  audio.update(64, 0.8, 'playing', { laserReady: false, bossPhase: 1 });

  // Establish active Stage 2 music and advance to its next real bar boundary.
  for (let step = 1; step < 16; step += 1) {
    audio.context.currentTime = stageTwoGrid * step;
    audio.update(64 + audio.context.currentTime, 0.8, 'playing', { laserReady: false, bossPhase: 1 });
  }
  audio.setStage(3);
  const queued = audio.getDebugSnapshot();
  const boundary = queued.pendingBoundary;
  assert.deepEqual({ stage: queued.stageIndex, pending: queued.pendingStageIndex, gridStep: audio._gridStep }, {
    stage: 2,
    pending: 3,
    gridStep: 0,
  });
  assert.ok(queued.activeMusicSources > 0);
  assert.ok(Math.abs(boundary - stageTwoGrid * 16) < 1e-12);

  // 110 ms is late for the boundary but stays inside Stage 2's stale-clock window.
  audio.context.currentTime = boundary + 0.11;
  audio.update(64 + audio.context.currentTime, 0.8, 'playing', { laserReady: false, bossPhase: 1 });
  const snapshot = audio.getDebugSnapshot();
  const newGrid = 60 / 140 / 4;
  assert.equal(snapshot.stageIndex, 3);
  assert.ok(Math.abs(snapshot.nextBeatTime - (audio.context.currentTime + newGrid)) < 1e-12);
});

test('look-ahead scheduling stays stable across consecutive pre-boundary frames', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.update(0, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  audio.setStage(1);

  const boundary = 1;
  audio._gridStep = 0;
  audio.nextBeatTime = boundary;
  audio._lastRealTime = boundary - 0.02;
  audio.context.currentTime = boundary - 0.013;
  audio.update(boundary - 0.013, 0.8, 'playing', { laserReady: true, bossPhase: 1 });

  const startsAfterLookAhead = audio.context.starts.length;
  const nextBeatAfterLookAhead = audio.nextBeatTime;
  const boundarySources = audio.context.startedSources.filter((source) => source.startTime === boundary);
  const boundaryStopCounts = boundarySources.map((source) => source.stopCalls.length);
  assert.ok(boundarySources.length >= 2);
  assert.equal(audio.getDebugSnapshot().stageIndex, 1);

  audio.context.currentTime = boundary - 0.008;
  audio.update(boundary - 0.008, 0.8, 'playing', { laserReady: true, bossPhase: 1 });

  assert.equal(audio.context.starts.length, startsAfterLookAhead);
  assert.equal(audio.nextBeatTime, nextBeatAfterLookAhead);
  boundarySources.forEach((source, index) => assert.equal(source.stopCalls.length, boundaryStopCounts[index]));
});

test('a queued realm change survives pause and safely retires future music before resume', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.event('pickup', 1);
  audio.event('laserReady', 1);
  const nonMusicSources = [
    ...sourcesRoutedTo(audio.context, audio.sfxGain),
    ...sourcesRoutedTo(audio.context, audio.uiGain),
  ];
  const nonMusicStopCounts = nonMusicSources.map((source) => source.stopCalls.length);
  audio._beatInitialized = true;
  audio._lastRealTime = 0;
  audio._gridStep = 0;
  audio.nextBeatTime = 0.015;
  audio.update(0.01, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  const futureMusic = sourcesRoutedTo(audio.context, audio.musicGain)
    .filter((source) => source.startTime > audio.context.currentTime);
  assert.ok(futureMusic.length >= 2);

  audio.context.currentTime = 0.005;
  assert.doesNotThrow(() => audio.setStage(1));
  for (const source of futureMusic) assert.equal(source.stopCalls.length, 1);
  assert.equal(audio.getDebugSnapshot().stageIndex, 0);
  assert.equal(audio.getDebugSnapshot().pendingStageIndex, 1);

  audio.update(0.005, 0.8, 'paused', { laserReady: true, bossPhase: 1 });

  for (const source of futureMusic) {
    const envelope = source.connections[0];
    assert.equal(envelope.gain.value, 0.0001);
    assert.ok(envelope.gain.events.some((event) => (
      event.method === 'setValueAtTime'
      && event.value === 0.0001
      && event.time === audio.context.currentTime
    )));
    assert.equal(source.stopTime, source.startTime);
  }
  nonMusicSources.forEach((source, index) => assert.equal(source.stopCalls.length, nonMusicStopCounts[index]));
  assert.equal(audio.getDebugSnapshot().activeMusicSources, 0);

  audio.context.currentTime = 4;
  const beforeResume = audio.context.starts.length;
  audio.update(4, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  const resumedStarts = audio.context.starts.slice(beforeResume);
  assert.equal(audio.getDebugSnapshot().stageIndex, 1);
  assert.equal(audio.getDebugSnapshot().pendingStageIndex, null);
  assert.ok(resumedStarts.length >= 2);
  assert.ok(resumedStarts.length <= 8);
  assert.ok(resumedStarts.every((time) => time >= audio.context.currentTime));
});

test('short mute preserves a queued realm and resumes without overlapping old voices', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.update(0, 0.5, 'playing', { laserReady: false, bossPhase: 1 });
  const oldMusic = sourcesRoutedTo(audio.context, audio.musicGain);
  const oldStopCounts = oldMusic.map((source) => source.stopCalls.length);

  audio.context.currentTime = 0.04;
  audio.setStage(1);
  audio.setMuted(true);
  oldMusic.forEach((source, index) => assert.equal(source.stopCalls.length, oldStopCounts[index] + 1));
  assert.equal(audio.getDebugSnapshot().pendingStageIndex, 1);
  audio.setMuted(false);
  audio.context.currentTime = 0.08;
  audio.update(0.08, 0.5, 'playing', { laserReady: false, bossPhase: 1 });

  const resumedMusic = sourcesRoutedTo(audio.context, audio.musicGain).filter((source) => !oldMusic.includes(source));
  assert.ok(resumedMusic.length >= 2);
  assert.equal(audio.getDebugSnapshot().stageIndex, 1);
  assert.equal(audio.getDebugSnapshot().pendingStageIndex, null);
  assert.equal(audio.getDebugSnapshot().activeMusicSources, resumedMusic.length);
});

test('a stale clock retires old voices and commits a queued realm without catch-up', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.update(0, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  const oldMusic = sourcesRoutedTo(audio.context, audio.musicGain);
  const oldStopCounts = oldMusic.map((source) => source.stopCalls.length);
  audio.setStage(1);

  audio.context.currentTime = 0.5;
  const startsBeforeRephase = audio.context.starts.length;
  audio.update(0.5, 0.8, 'playing', { laserReady: true, bossPhase: 1 });

  oldMusic.forEach((source, index) => assert.equal(source.stopCalls.length, oldStopCounts[index] + 1));
  const rephasedMusic = sourcesRoutedTo(audio.context, audio.musicGain).filter((source) => !oldMusic.includes(source));
  assert.ok(rephasedMusic.length >= 2);
  assert.ok(audio.context.starts.length - startsBeforeRephase <= 8);
  assert.equal(audio.getDebugSnapshot().stageIndex, 1);
  assert.equal(audio.getDebugSnapshot().pendingStageIndex, null);
  assert.equal(audio.getDebugSnapshot().activeMusicSources, rephasedMusic.length);
});

test('adaptive scheduler adds drums and arp without ever starting more than eight sources per update', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();

  audio.update(0, 0.2, 'playing', { laserReady: false, bossPhase: 1 });
  const quietStarts = audio.context.starts.length;
  assert.ok(quietStarts >= 2);

  audio.suspendBeat();
  audio.context.currentTime = 1;
  const beforeLoud = audio.context.starts.length;
  audio.update(1, 0.9, 'playing', { laserReady: true, bossPhase: 1 });
  const loudStarts = audio.context.starts.length - beforeLoud;
  assert.ok(loudStarts > quietStarts);
  assert.ok(loudStarts <= 8);
  assert.ok(audio.context.startedSources.some((source) => source.kind === 'buffer-source'));
  assert.ok(audio.context.startedSources.every((source) => source.stopTime !== null));
});

test('sixteenth-note timing uses the realm bpm without accumulating ordinary frame lateness', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.update(0, 0.4, 'playing', { laserReady: false, bossPhase: 1 });
  const abyssSixteenth = 60 / 92 / 4;
  assert.ok(Math.abs(audio.nextBeatTime - abyssSixteenth) < 1e-12);

  audio.context.currentTime = abyssSixteenth + 0.01;
  audio.update(abyssSixteenth + 0.01, 0.4, 'playing', { laserReady: false, bossPhase: 1 });
  assert.ok(Math.abs(audio.nextBeatTime - abyssSixteenth * 2) < 1e-12);
});

test('a stale audio clock rephases instead of catching up an old grid event next frame', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.update(0, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  const abyssSixteenth = 60 / 92 / 4;
  audio.context.currentTime = abyssSixteenth * 2.25;
  const beforeRephase = audio.context.starts.length;
  audio.update(0.37, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  const afterRephase = audio.context.starts.length;
  assert.ok(afterRephase - beforeRephase <= 8);
  audio.update(0.371, 0.8, 'playing', { laserReady: true, bossPhase: 1 });
  assert.equal(audio.context.starts.length, afterRephase);
});

test('void cathedral boss phase two adds a detuned fifth layer', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.setStage(3);
  audio.update(100, 0.2, 'playing', { laserReady: false, bossPhase: 1 });
  const phaseOneStarts = audio.context.starts.length;

  audio.suspendBeat();
  audio.context.currentTime = 2;
  const beforePhaseTwo = audio.context.starts.length;
  audio.update(100, 0.2, 'playing', { laserReady: false, bossPhase: 2 });
  assert.equal(audio.context.starts.length - beforePhaseTwo, phaseOneStarts + 1);
  assert.ok(audio.context.startedSources.some((source) => source.detune?.events.some((event) => event.value !== 0)));
});

test('event recipes include the laser, environment and realm-shift cues with bounded pitch variation', () => {
  const lowPitchAudio = new NeonAudio({ contextFactory: MockAudioContext, random: () => 0 });
  const highPitchAudio = new NeonAudio({ contextFactory: MockAudioContext, random: () => 1 });
  lowPitchAudio.unlock();
  highPitchAudio.unlock();
  const eventNames = ['laserCharge', 'laserReady', 'laserFire', 'laserHit', 'environment', 'realmShift'];

  for (const eventName of eventNames) {
    const lowBefore = lowPitchAudio.context.startedSources.length;
    const highBefore = highPitchAudio.context.startedSources.length;
    lowPitchAudio.event(eventName, 1);
    highPitchAudio.event(eventName, 1);
    const lowSources = lowPitchAudio.context.startedSources.slice(lowBefore);
    const highSources = highPitchAudio.context.startedSources.slice(highBefore);
    assert.ok(lowSources.length >= 1, `${eventName} should start at least one source`);
    assert.ok(lowSources.length <= 8, `${eventName} should respect the per-call source cap`);
    const lowFrequencies = lowSources.filter((source) => source.frequency).map((source) => source.frequency.events[0].value);
    const highFrequencies = highSources.filter((source) => source.frequency).map((source) => source.frequency.events[0].value);
    assert.deepEqual(lowFrequencies.length, highFrequencies.length);
    for (let index = 0; index < lowFrequencies.length; index += 1) {
      assert.ok(lowFrequencies[index] > 0);
      assert.ok(highFrequencies[index] / lowFrequencies[index] >= 1);
      assert.ok(highFrequencies[index] / lowFrequencies[index] <= 1.084);
    }
  }
});

test('production laser audio bridge emits ready, charge, fire and one aggregated hit cue per shot', () => {
  assert.equal(typeof audioModule.createLaserAudioEvents, 'function');
  const audio = new NeonAudio({ contextFactory: MockAudioContext, random: () => 0.5 });
  audio.unlock();
  const laserAudio = audioModule.createLaserAudioEvents(audio, { maxEnergy: 100, maxTargets: 5 });

  assert.equal(laserAudio.onEnergyChange(95, 100), true);
  const afterFirstReady = audio.context.starts.length;
  assert.equal(laserAudio.onEnergyChange(100, 100), false);
  assert.equal(audio.context.starts.length, afterFirstReady);
  assert.equal(laserAudio.onEnergyChange(95, 100), true);

  const beforeCharge = audio.context.starts.length;
  laserAudio.onChargeStarted();
  assert.ok(audio.context.starts.length > beforeCharge);
  assert.equal(laserAudio.onPhaseChange('charge', 'charge'), false);
  const beforeFire = audio.context.starts.length;
  assert.equal(laserAudio.onPhaseChange('charge', 'active'), true);
  assert.ok(audio.context.starts.length > beforeFire);
  assert.ok(audio.getDebugSnapshot().musicTarget < audio.getDebugSnapshot().musicBase);

  const beforeHit = audio.context.starts.length;
  assert.equal(laserAudio.onHits(3), true);
  const afterHit = audio.context.starts.length;
  assert.ok(afterHit > beforeHit);
  assert.equal(laserAudio.onHits(1), false);
  assert.equal(audio.context.starts.length, afterHit);

  laserAudio.onChargeStarted();
  assert.equal(laserAudio.onHits(1), true);
  assert.ok(audio.context.starts.length > afterHit);
});

test('ducking events lower music while ordinary pickup sfx leaves its target unchanged', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  const duckingEvents = ['dash', 'hurt', 'laserFire', 'bossHit', 'victory', 'defeat'];

  for (const eventName of duckingEvents) {
    audio.event(eventName, 1);
    assert.ok(audio.getDebugSnapshot().musicTarget < audio.getDebugSnapshot().musicBase, eventName);
  }

  audio.context.currentTime = 10;
  audio.update(10, 0, 'menu', {});
  assert.equal(audio.getDebugSnapshot().musicTarget, audio.getDebugSnapshot().musicBase);
  audio.event('pickup', 1);
  assert.equal(audio.getDebugSnapshot().musicTarget, audio.getDebugSnapshot().musicBase);
});

test('mute then resume rephases music without a stale catch-up burst', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  assert.equal(audio.unlock(), true);

  audio.update(0, 0.5, 'playing', { laserReady: false, bossPhase: 1 });
  const beforeMute = audio.context.starts.length;

  audio.setMuted(true);
  audio.context.currentTime = 10;
  for (let i = 0; i < 5; i += 1) audio.update(10 + i / 60, 0.5, 'playing', { laserReady: false, bossPhase: 1 });
  assert.equal(audio.context.starts.length, beforeMute);

  audio.setMuted(false);
  audio.update(10, 0.5, 'playing', { laserReady: false, bossPhase: 1 });
  const resumedStarts = audio.context.starts.slice(beforeMute);
  assert.ok(resumedStarts.length <= 8);
  assert.ok(resumedStarts.every((time) => time >= audio.context.currentTime));

  audio.update(10.01, 0.5, 'playing', { laserReady: false, bossPhase: 1 });
  assert.ok(audio.context.starts.length - beforeMute <= 8);
});

test('suspended or unavailable audio remains a no-op for core game calls', () => {
  class UnavailableAudioContext {
    constructor() {
      throw new Error('audio unavailable');
    }
  }
  const unavailable = new NeonAudio({ contextFactory: UnavailableAudioContext });
  assert.equal(unavailable.unlock(), false);
  assert.doesNotThrow(() => unavailable.update(100, 1, 'playing', { laserReady: true, bossPhase: 2 }));
  assert.doesNotThrow(() => unavailable.event('laserFire', 1));

  const suspended = new NeonAudio({ contextFactory: MockAudioContext });
  suspended.unlock();
  suspended.context.state = 'suspended';
  suspended.update(100, 1, 'playing', { laserReady: true, bossPhase: 2 });
  suspended.event('laserFire', 1);
  assert.equal(suspended.context.starts.length, 0);
});
