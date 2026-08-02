const EVENT_RECIPES = Object.freeze({
  start: Object.freeze({ frequencies: [220, 330], duration: 0.22, type: 'sine', gain: 0.055 }),
  pickup: Object.freeze({ frequencies: [660], duration: 0.12, type: 'triangle', gain: 0.06 }),
  nearMiss: Object.freeze({ frequencies: [520, 780], duration: 0.15, type: 'sawtooth', gain: 0.045 }),
  dash: Object.freeze({ frequencies: [180, 420], duration: 0.2, type: 'square', gain: 0.04 }),
  break: Object.freeze({ frequencies: [110, 220], duration: 0.28, type: 'triangle', gain: 0.05 }),
  hurt: Object.freeze({ frequencies: [95], duration: 0.24, type: 'sawtooth', gain: 0.06 }),
  overdrive: Object.freeze({ frequencies: [300, 600], duration: 0.35, type: 'sine', gain: 0.05 }),
  upgrade: Object.freeze({ frequencies: [440, 660], duration: 0.24, type: 'triangle', gain: 0.05 }),
  bossHit: Object.freeze({ frequencies: [70, 140], duration: 0.3, type: 'square', gain: 0.045 }),
  victory: Object.freeze({ frequencies: [523, 659], duration: 0.5, type: 'sine', gain: 0.055 }),
  defeat: Object.freeze({ frequencies: [160, 100], duration: 0.42, type: 'sawtooth', gain: 0.05 }),
});

const STAGE_BEAT_INTERVALS = Object.freeze([0.6, 0.5, 0.42, 0.34]);
const MAX_LAYER_GAIN = 0.079;

function clamp(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function setParam(param, method, ...args) {
  if (param && typeof param[method] === 'function') param[method](...args);
  else if (param) param.value = args[0];
}

/** Owns the game's Web Audio graph. Creation is deliberately deferred to unlock(). */
export class NeonAudio {
  constructor() {
    this.context = null;
    this.masterGain = null;
    this.muted = false;
    this.stageIndex = 0;
    this.nextBeatTime = 0;
    this._beatInitialized = false;
    this._unlocked = false;
  }

  unlock() {
    if (this.context) {
      if (this.context.state === 'suspended' && typeof this.context.resume === 'function') {
        Promise.resolve(this.context.resume()).catch(() => {});
      }
      return true;
    }
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof AudioContextClass !== 'function') return false;
    try {
      this.context = new AudioContextClass();
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);
      setParam(this.masterGain.gain, 'setValueAtTime', this.muted ? 0 : 0.7, this.context.currentTime || 0);
      this._unlocked = true;
      if (this.context.state === 'suspended' && typeof this.context.resume === 'function') {
        Promise.resolve(this.context.resume()).catch(() => {});
      }
      return true;
    } catch {
      this.context = null;
      this.masterGain = null;
      return false;
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.masterGain && this.context && this.context.state !== 'suspended') {
      setParam(this.masterGain.gain, 'setTargetAtTime', this.muted ? 0 : 0.7, this.context.currentTime || 0, 0.015);
    }
  }

  setStage(index) {
    this.stageIndex = Math.round(clamp(index, 0, STAGE_BEAT_INTERVALS.length - 1));
  }

  update(realTime = 0, intensity = 0, mode = 'playing') {
    if (mode !== 'playing') {
      this.suspendBeat();
      return;
    }
    if (!this._ready()) return;
    const now = Number(this.context.currentTime) || 0;
    const interval = STAGE_BEAT_INTERVALS[this.stageIndex];
    if (!this._beatInitialized) {
      const phase = Math.max(0, Number(realTime) || 0) % interval;
      this.nextBeatTime = now + (interval - phase) % interval;
      this._beatInitialized = true;
    }
    // Schedule at most one beat per update, keeping the beat phase tied to game time.
    if (this.nextBeatTime <= now + 0.02) {
      this._scheduleBeat(this.nextBeatTime, intensity);
      this.nextBeatTime += interval;
    }
  }

  event(name, strength = 1) {
    if (!this._ready()) return;
    const recipe = EVENT_RECIPES[name];
    if (!recipe) return;
    const amount = clamp(strength, 0, 1);
    const now = Number(this.context.currentTime) || 0;
    recipe.frequencies.forEach((frequency, layer) => {
      this._tone(frequency * (1 + amount * 0.04 * layer), recipe.duration, Math.min(MAX_LAYER_GAIN, recipe.gain * (0.45 + amount * 0.55)), recipe.type, now + layer * 0.008);
    });
  }

  suspendBeat() {
    this._beatInitialized = false;
    this.nextBeatTime = 0;
  }

  _ready() {
    return Boolean(this._unlocked && this.context && this.masterGain && !this.muted && this.context.state !== 'suspended' && this.context.state !== 'closed');
  }

  _scheduleBeat(time, intensity) {
    const level = Math.min(MAX_LAYER_GAIN, 0.018 + clamp(intensity, 0, 1) * 0.035);
    this._tone(110 + this.stageIndex * 18, 0.08, level, 'sine', time);
  }

  _tone(frequency, duration, gainAmount, type, time) {
    if (!this._ready()) return;
    try {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = type;
      setParam(oscillator.frequency, 'setValueAtTime', frequency, time);
      setParam(gain.gain, 'setValueAtTime', Math.min(MAX_LAYER_GAIN, gainAmount), time);
      setParam(gain.gain, 'exponentialRampToValueAtTime', 0.0001, time + duration);
      oscillator.connect(gain);
      gain.connect(this.masterGain);
      oscillator.start(time);
      oscillator.stop(time + duration + 0.01);
    } catch {
      // Browsers can reject scheduling when a context is being closed; audio is optional.
    }
  }
}

export default NeonAudio;
