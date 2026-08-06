import test from 'node:test';
import assert from 'node:assert/strict';

import NeonAudio from '../src/game/audio.js';

class MockParam {
  constructor(context) {
    this.context = context;
    this.value = 0;
    this.events = [];
  }

  setValueAtTime(value, time = 0) {
    this.value = value;
    this.events.push({ method: 'setValueAtTime', value, time });
  }

  setTargetAtTime(value, time = 0, constant = 0) {
    this.value = value;
    this.events.push({ method: 'setTargetAtTime', value, time, constant });
  }

  exponentialRampToValueAtTime(value, time = 0) {
    this.value = value;
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
    this.gain = new MockParam(context);
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
    this.stopTime = null;
    this.onended = null;
  }

  start(time = 0) {
    this.context.starts.push(time);
    this.context.startedSources.push(this);
  }

  stop(time = 0) {
    this.stopTime = time;
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
    this.stopTime = null;
    this.onended = null;
  }

  start(time = 0) {
    this.context.starts.push(time);
    this.context.startedSources.push(this);
  }

  stop(time = 0) {
    this.stopTime = time;
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

test('stage changes rephase at a bar and strong sfx ducks then releases music', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  audio.unlock();
  audio.setStage(1);
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
