import test from 'node:test';
import assert from 'node:assert/strict';

import NeonAudio from '../src/game/audio.js';

class MockParam {
  constructor() {
    this.value = 0;
  }

  setValueAtTime(value) {
    this.value = value;
  }

  setTargetAtTime(value) {
    this.value = value;
  }

  exponentialRampToValueAtTime(value) {
    this.value = value;
  }
}

class MockNode {
  connect() {}
}

class MockGain extends MockNode {
  constructor() {
    super();
    this.gain = new MockParam();
  }
}

class MockOscillator extends MockNode {
  constructor(context) {
    super();
    this.context = context;
    this.frequency = new MockParam();
    this.type = 'sine';
  }

  start(time) {
    this.context.starts.push(time);
  }

  stop() {}
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new MockNode();
    this.starts = [];
  }

  createGain() {
    return new MockGain();
  }

  createOscillator() {
    return new MockOscillator(this);
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

test('mute then resume rephases beats without a stale catch-up burst', () => {
  const audio = new NeonAudio({ contextFactory: MockAudioContext });
  assert.equal(audio.unlock(), true);

  audio.update(0, 0.5, 'playing');
  const beforeMute = audio.context.starts.length;

  audio.setMuted(true);
  audio.context.currentTime = 10;
  for (let i = 0; i < 5; i += 1) audio.update(10 + i / 60, 0.5, 'playing');
  assert.equal(audio.context.starts.length, beforeMute);

  audio.setMuted(false);
  audio.update(10, 0.5, 'playing');
  const resumedStarts = audio.context.starts.slice(beforeMute);
  assert.ok(resumedStarts.length <= 1);
  assert.ok(resumedStarts.every((time) => time >= audio.context.currentTime));

  audio.update(10.01, 0.5, 'playing');
  assert.ok(audio.context.starts.length - beforeMute <= 1);
});
