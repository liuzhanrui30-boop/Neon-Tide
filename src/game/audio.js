import { REALMS } from './realms.js';

const MASTER_LEVEL = 0.708;
const MUSIC_LEVEL = 0.42;
const SFX_LEVEL = 0.72;
const AMBIENCE_LEVEL = 0.28;
const UI_LEVEL = 0.5;
const MAX_LAYER_GAIN = 0.12;
const GRID_STEPS_PER_BAR = 16;
const MAX_STARTS_PER_UPDATE = 8;
const MUSIC_REPHASE_FADE = 0.03;
const DUCK_EVENTS = new Set(['dash', 'hurt', 'laserFire', 'bossHit', 'victory', 'defeat']);

const EVENT_RECIPES = Object.freeze({
  start: Object.freeze({ frequencies: [220, 330], duration: 0.22, type: 'sine', gain: 0.055, bus: 'ui' }),
  pickup: Object.freeze({ frequencies: [660], duration: 0.12, type: 'triangle', gain: 0.06, bus: 'sfx' }),
  nearMiss: Object.freeze({ frequencies: [520, 780], duration: 0.15, type: 'sawtooth', gain: 0.045, bus: 'sfx' }),
  dash: Object.freeze({ frequencies: [180, 420], duration: 0.2, type: 'square', gain: 0.04, bus: 'sfx' }),
  break: Object.freeze({ frequencies: [110, 220], duration: 0.28, type: 'triangle', gain: 0.05, bus: 'sfx' }),
  hurt: Object.freeze({ frequencies: [95], duration: 0.24, type: 'sawtooth', gain: 0.06, bus: 'sfx' }),
  overdrive: Object.freeze({ frequencies: [300, 600], duration: 0.35, type: 'sine', gain: 0.05, bus: 'sfx' }),
  upgrade: Object.freeze({ frequencies: [440, 660], duration: 0.24, type: 'triangle', gain: 0.05, bus: 'ui' }),
  bossHit: Object.freeze({ frequencies: [70, 140], duration: 0.3, type: 'square', gain: 0.045, bus: 'sfx' }),
  victory: Object.freeze({ frequencies: [523, 659], duration: 0.5, type: 'sine', gain: 0.055, bus: 'ui' }),
  defeat: Object.freeze({ frequencies: [160, 100], duration: 0.42, type: 'sawtooth', gain: 0.05, bus: 'ui' }),
  laserCharge: Object.freeze({ frequencies: [180, 270], duration: 0.32, type: 'sawtooth', gain: 0.07, bus: 'sfx' }),
  laserReady: Object.freeze({ frequencies: [660, 990], duration: 0.18, type: 'triangle', gain: 0.075, bus: 'ui' }),
  laserFire: Object.freeze({ frequencies: [90, 360], duration: 0.28, type: 'sawtooth', gain: 0.08, bus: 'sfx' }),
  laserHit: Object.freeze({ frequencies: [130, 520], duration: 0.18, type: 'square', gain: 0.065, bus: 'sfx' }),
  environment: Object.freeze({ frequencies: [80, 120], duration: 0.42, type: 'sine', gain: 0.05, bus: 'ambience' }),
  realmShift: Object.freeze({ frequencies: [220, 330, 495], duration: 0.48, type: 'triangle', gain: 0.065, bus: 'ui' }),
});

function clamp(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function setParam(param, method, ...args) {
  if (param && typeof param[method] === 'function') param[method](...args);
  else if (param) param.value = args[0];
}

function midiToFrequency(note) {
  return 440 * (2 ** ((note - 69) / 12));
}

export function createLaserAudioEvents(audio, { maxEnergy = 100, maxTargets = 5 } = {}) {
  const readyThreshold = Math.max(0, Number(maxEnergy) || 100);
  const targetCap = Math.max(1, Number(maxTargets) || 5);
  let hitPlayedForShot = false;
  return Object.freeze({
    onEnergyChange(previousEnergy, nextEnergy) {
      const previous = Number(previousEnergy);
      const next = Number(nextEnergy);
      if (!Number.isFinite(previous) || !Number.isFinite(next) || previous >= readyThreshold || next < readyThreshold) return false;
      audio?.event?.('laserReady', 1);
      return true;
    },
    onChargeStarted() {
      hitPlayedForShot = false;
      audio?.event?.('laserCharge', 1);
      return true;
    },
    onPhaseChange(previousPhase, nextPhase) {
      if (previousPhase !== 'charge' || nextPhase !== 'active') return false;
      audio?.event?.('laserFire', 1);
      return true;
    },
    onHits(count) {
      const hits = Math.max(0, Number(count) || 0);
      if (hits <= 0 || hitPlayedForShot) return false;
      hitPlayedForShot = true;
      audio?.event?.('laserHit', clamp(hits / targetCap, 0, 1));
      return true;
    },
  });
}

/** Owns the game's optional Web Audio graph. Creation is deliberately deferred to unlock(). */
export class NeonAudio {
  constructor({ contextFactory = null, random = Math.random } = {}) {
    this.context = null;
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.ambienceGain = null;
    this.uiGain = null;
    this.compressor = null;
    this.muted = false;
    this.stageIndex = 0;
    this.nextBeatTime = 0;
    this._gridStep = 0;
    this._lastScheduledStep = 0;
    this._barIndex = 0;
    this._beatInitialized = false;
    this._lastRealTime = null;
    this._unlocked = false;
    this._noiseBuffer = null;
    this._musicSources = new Set();
    this._musicBase = MUSIC_LEVEL;
    this._musicTarget = MUSIC_LEVEL;
    this._duckActiveUntil = 0;
    this._contextFactory = contextFactory;
    this._random = typeof random === 'function' ? random : Math.random;
  }

  unlock() {
    if (this.context) {
      if (this.context.state === 'suspended' && typeof this.context.resume === 'function') {
        this.suspendBeat();
        Promise.resolve(this.context.resume()).then(() => this.suspendBeat()).catch(() => {});
      }
      return true;
    }
    const AudioContextClass = this._contextFactory || globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') return false;
    try {
      this.context = new AudioContextClass();
      this.musicGain = this.context.createGain();
      this.sfxGain = this.context.createGain();
      this.ambienceGain = this.context.createGain();
      this.uiGain = this.context.createGain();
      this.compressor = this.context.createDynamicsCompressor();
      this.masterGain = this.context.createGain();

      this.musicGain.connect(this.compressor);
      this.sfxGain.connect(this.compressor);
      this.ambienceGain.connect(this.compressor);
      this.uiGain.connect(this.compressor);
      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.context.destination);

      const now = Number(this.context.currentTime) || 0;
      setParam(this.musicGain.gain, 'setValueAtTime', MUSIC_LEVEL, now);
      setParam(this.sfxGain.gain, 'setValueAtTime', SFX_LEVEL, now);
      setParam(this.ambienceGain.gain, 'setValueAtTime', AMBIENCE_LEVEL, now);
      setParam(this.uiGain.gain, 'setValueAtTime', UI_LEVEL, now);
      setParam(this.masterGain.gain, 'setValueAtTime', this.muted ? 0 : MASTER_LEVEL, now);
      setParam(this.compressor.threshold, 'setValueAtTime', -12, now);
      setParam(this.compressor.knee, 'setValueAtTime', 18, now);
      setParam(this.compressor.ratio, 'setValueAtTime', 4, now);
      setParam(this.compressor.attack, 'setValueAtTime', 0.003, now);
      setParam(this.compressor.release, 'setValueAtTime', 0.25, now);

      this._musicBase = MUSIC_LEVEL;
      this._musicTarget = MUSIC_LEVEL;
      this._unlocked = true;
      if (this.context.state === 'suspended' && typeof this.context.resume === 'function') {
        this.suspendBeat();
        Promise.resolve(this.context.resume()).then(() => this.suspendBeat()).catch(() => {});
      }
      return true;
    } catch {
      this.context = null;
      this.masterGain = null;
      this.musicGain = null;
      this.sfxGain = null;
      this.ambienceGain = null;
      this.uiGain = null;
      this.compressor = null;
      this._unlocked = false;
      return false;
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    this.suspendBeat();
    if (this.masterGain && this.context && this.context.state !== 'closed') {
      try {
        setParam(this.masterGain.gain, 'setTargetAtTime', this.muted ? 0 : MASTER_LEVEL, this.context.currentTime || 0, 0.015);
      } catch {
        // Audio may close between a UI event and the gain update; mute state remains authoritative.
      }
    }
  }

  setStage(index) {
    const nextStageIndex = Math.round(clamp(index, 0, REALMS.length - 1));
    if (nextStageIndex !== this.stageIndex) this.suspendBeat();
    this.stageIndex = nextStageIndex;
  }

  update(realTime = 0, intensity = 0, mode = 'playing', context = {}) {
    const now = this.context ? Number(this.context.currentTime) || 0 : 0;
    this._refreshDuckState(now);
    if (mode !== 'playing') {
      this.suspendBeat();
      return;
    }
    if (!this._ready()) {
      this.suspendBeat();
      return;
    }

    const gameTime = Number(realTime);
    const realm = REALMS[this.stageIndex] || REALMS[0];
    const gridInterval = 60 / realm.music.bpm / 4;
    const staleGameClock = this._lastRealTime !== null
      && (!Number.isFinite(gameTime) || gameTime < this._lastRealTime - 0.001 || gameTime - this._lastRealTime > 1);
    const staleAudioClock = this._beatInitialized
      && (!Number.isFinite(this.nextBeatTime) || this.nextBeatTime < now - gridInterval);
    if (staleGameClock || staleAudioClock) this.suspendBeat();

    if (!this._beatInitialized) {
      this.nextBeatTime = now;
      this._gridStep = 0;
      this._barIndex = 0;
      this._beatInitialized = true;
    }
    this._lastRealTime = Number.isFinite(gameTime) ? gameTime : null;

    if (this.nextBeatTime <= now + 0.02) {
      const gridTime = this.nextBeatTime;
      const scheduleTime = Math.max(now, gridTime);
      this._lastScheduledStep = this._gridStep;
      this._scheduleGridEvent(scheduleTime, intensity, context, realm, gridInterval);
      this.nextBeatTime = gridTime + gridInterval;
      this._gridStep = (this._gridStep + 1) % GRID_STEPS_PER_BAR;
      if (this._gridStep === 0) this._barIndex += 1;
    }
  }

  event(name, strength = 1) {
    if (!this._ready()) return;
    const recipe = EVENT_RECIPES[name];
    if (!recipe) return;
    const amount = clamp(strength, 0, 1);
    const now = Number(this.context.currentTime) || 0;
    const pitch = 0.96 + clamp(this._random(), 0, 1) * 0.08;
    const bus = this._getBus(recipe.bus);
    recipe.frequencies.slice(0, MAX_STARTS_PER_UPDATE).forEach((frequency, layer) => {
      this._tone(
        frequency * pitch,
        recipe.duration,
        Math.min(MAX_LAYER_GAIN, recipe.gain * (0.45 + amount * 0.55)),
        recipe.type,
        now + layer * 0.008,
        bus,
      );
    });
    if (DUCK_EVENTS.has(name)) this.duck(-5, 0.34);
  }

  duck(amountDb, releaseSeconds) {
    if (!this._ready() || !this.musicGain) return;
    const now = Number(this.context.currentTime) || 0;
    const gainMultiplier = 10 ** (clamp(amountDb, -60, 0) / 20);
    const duckedLevel = this._musicBase * gainMultiplier;
    const release = Math.max(0.001, Number(releaseSeconds) || 0.34);
    try {
      if (typeof this.musicGain.gain.cancelScheduledValues === 'function') {
        this.musicGain.gain.cancelScheduledValues(now);
      }
      setParam(this.musicGain.gain, 'setTargetAtTime', duckedLevel, now, 0.025);
      setParam(this.musicGain.gain, 'setTargetAtTime', this._musicBase, now + 0.05, release);
      this._musicTarget = duckedLevel;
      this._duckActiveUntil = Math.max(this._duckActiveUntil, now + 0.05 + release);
    } catch {
      // Ducking is optional feedback; scheduling failures must never affect gameplay.
    }
  }

  getDebugSnapshot() {
    const now = this.context ? Number(this.context.currentTime) || 0 : 0;
    this._refreshDuckState(now);
    return {
      buses: ['Music', 'SFX', 'Ambience', 'UI'],
      masterGain: MASTER_LEVEL,
      musicBase: this._musicBase,
      musicTarget: this._musicTarget,
      stageIndex: this.stageIndex,
      bpm: REALMS[this.stageIndex]?.music.bpm ?? REALMS[0].music.bpm,
      gridStep: this._lastScheduledStep,
      schedulerReady: this._beatInitialized,
      activeMusicSources: this._musicSources.size,
    };
  }

  suspendBeat() {
    this._stopMusicSources();
    this._beatInitialized = false;
    this.nextBeatTime = 0;
    this._gridStep = 0;
    this._lastScheduledStep = 0;
    this._barIndex = 0;
    this._lastRealTime = null;
  }

  _ready() {
    return Boolean(
      this._unlocked
      && this.context
      && this.masterGain
      && this.musicGain
      && this.sfxGain
      && !this.muted
      && this.context.state !== 'suspended'
      && this.context.state !== 'closed',
    );
  }

  _refreshDuckState(now) {
    if (this._musicTarget !== this._musicBase && now >= this._duckActiveUntil) {
      this._musicTarget = this._musicBase;
      this._duckActiveUntil = 0;
    }
  }

  _getBus(busName) {
    if (busName === 'music') return this.musicGain;
    if (busName === 'ambience') return this.ambienceGain;
    if (busName === 'ui') return this.uiGain;
    return this.sfxGain;
  }

  _stopMusicSources() {
    if (!this.context || this._musicSources.size === 0) return;
    const now = Number(this.context.currentTime) || 0;
    for (const voice of this._musicSources) {
      try {
        if (typeof voice.envelope.gain.cancelScheduledValues === 'function') {
          voice.envelope.gain.cancelScheduledValues(now);
        }
        setParam(voice.envelope.gain, 'setTargetAtTime', 0.0001, now, 0.012);
        voice.source.stop(Math.max(now, Math.min(voice.stopTime, now + MUSIC_REPHASE_FADE)));
      } catch {
        // A source may finish between the rephase request and its shortened stop.
      }
    }
    this._musicSources.clear();
  }

  _trackMusicSource(source, envelope, stopTime, bus) {
    if (bus !== this.musicGain) return null;
    const voice = { source, envelope, stopTime };
    this._musicSources.add(voice);
    return voice;
  }

  _scheduleGridEvent(time, intensity, context, realm, gridInterval) {
    const level = clamp(intensity, 0, 1);
    const { root, scale } = realm.music;
    const step = this._gridStep;
    let starts = 0;
    const canStart = () => starts < MAX_STARTS_PER_UPDATE;
    const startTone = (...args) => {
      if (!canStart()) return;
      this._tone(...args);
      starts += 1;
    };

    if (step === 0) {
      const padDuration = gridInterval * GRID_STEPS_PER_BAR * 0.95;
      startTone(midiToFrequency(root), padDuration, 0.052 + level * 0.02, this._barIndex % 2 === 0 ? 'sine' : 'triangle', time, this.musicGain, 0, 0.08);
      if (this.stageIndex === 3 && Number(context?.bossPhase) === 2) {
        startTone(midiToFrequency(root + 7), padDuration, 0.036 + level * 0.014, 'triangle', time, this.musicGain, -7, 0.08);
      }
    }

    if (step === 0 || step === 8) {
      startTone(midiToFrequency(root - 12), gridInterval * 1.8, 0.055 + level * 0.025, 'triangle', time, this.musicGain, 0, 0.012);
    }

    if (level > 0.25 && step % 4 === 0) {
      startTone(70 + this.stageIndex * 9, 0.11, 0.045 + level * 0.025, 'sine', time, this.musicGain, 0, 0.003);
      if (canStart()) {
        this._noise(0.075, 0.026 + level * 0.022, time, this.musicGain, 0.92 + this.stageIndex * 0.06);
        starts += 1;
      }
    }

    if ((level > 0.55 || Boolean(context?.laserReady)) && step % 2 === 0) {
      const scaleIndex = (Math.floor(step / 2) + this._barIndex) % scale.length;
      startTone(midiToFrequency(root + 12 + scale[scaleIndex]), gridInterval * 0.72, 0.032 + level * 0.022, 'square', time, this.musicGain, 0, 0.006);
    }
  }

  _tone(frequency, duration, gainAmount, type, time, bus = this.sfxGain, detune = 0, attack = 0.004) {
    if (!this._ready() || !bus) return;
    let oscillator = null;
    let gain = null;
    let musicVoice = null;
    try {
      oscillator = this.context.createOscillator();
      gain = this.context.createGain();
      oscillator.type = type;
      setParam(oscillator.frequency, 'setValueAtTime', Math.max(1, frequency), time);
      setParam(oscillator.detune, 'setValueAtTime', detune, time);
      const peak = Math.min(MAX_LAYER_GAIN, Math.max(0.0001, gainAmount));
      setParam(gain.gain, 'setValueAtTime', 0.0001, time);
      setParam(gain.gain, 'exponentialRampToValueAtTime', peak, time + Math.min(attack, duration * 0.4));
      setParam(gain.gain, 'exponentialRampToValueAtTime', 0.0001, time + duration);
      oscillator.connect(gain);
      gain.connect(bus);
      const stopTime = time + duration + 0.01;
      musicVoice = this._trackMusicSource(oscillator, gain, stopTime, bus);
      oscillator.onended = () => {
        if (musicVoice) this._musicSources.delete(musicVoice);
        try { oscillator.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
        oscillator.onended = null;
      };
      oscillator.start(time);
      oscillator.stop(stopTime);
    } catch {
      if (musicVoice) this._musicSources.delete(musicVoice);
      try { oscillator?.disconnect(); } catch {}
      try { gain?.disconnect(); } catch {}
      // Browsers can reject scheduling while a context is closing; audio is optional.
    }
  }

  _noise(duration, gainAmount, time, bus, playbackRate = 1) {
    if (!this._ready() || !bus || typeof this.context.createBufferSource !== 'function') return;
    let source = null;
    let gain = null;
    let musicVoice = null;
    try {
      if (!this._noiseBuffer) this._noiseBuffer = this._createNoiseBuffer();
      if (!this._noiseBuffer) return;
      source = this.context.createBufferSource();
      gain = this.context.createGain();
      source.buffer = this._noiseBuffer;
      setParam(source.playbackRate, 'setValueAtTime', playbackRate, time);
      const peak = Math.min(MAX_LAYER_GAIN, Math.max(0.0001, gainAmount));
      setParam(gain.gain, 'setValueAtTime', peak, time);
      setParam(gain.gain, 'exponentialRampToValueAtTime', 0.0001, time + duration);
      source.connect(gain);
      gain.connect(bus);
      const stopTime = time + duration + 0.01;
      musicVoice = this._trackMusicSource(source, gain, stopTime, bus);
      source.onended = () => {
        if (musicVoice) this._musicSources.delete(musicVoice);
        try { source.disconnect(); } catch {}
        try { gain.disconnect(); } catch {}
        source.onended = null;
      };
      source.start(time);
      source.stop(stopTime);
    } catch {
      if (musicVoice) this._musicSources.delete(musicVoice);
      try { source?.disconnect(); } catch {}
      try { gain?.disconnect(); } catch {}
      // Noise is an optional layer and must not interrupt the render loop.
    }
  }

  _createNoiseBuffer() {
    if (!this.context || typeof this.context.createBuffer !== 'function') return null;
    const sampleRate = Number(this.context.sampleRate) || 44100;
    const buffer = this.context.createBuffer(1, Math.max(1, Math.floor(sampleRate * 0.12)), sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = clamp(this._random(), 0, 1) * 2 - 1;
    }
    return buffer;
  }
}

export default NeonAudio;
