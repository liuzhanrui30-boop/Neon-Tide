import * as THREE from "three";
import "./style.css";
import NeonAudio from "./game/audio.js";
import {
  ENEMY_TYPES,
  GAME,
  STAGES,
  computeRank,
  computeReward,
  computeSpawnBudget,
  getStageIndex,
  pickUpgradeOptions,
} from "./game/gameplay.js";

const TAU = Math.PI * 2;
const WORLD_HEIGHT = 14;
const STORAGE_KEY = "neon-tide-high-score";
const MAX_HEALTH = 3;
const MOVE_ACCELERATION = 17.5;
const TURN_ACCELERATION = 31;
const MOVE_DAMPING = 4.4;
const COAST_DAMPING = 6.2;
const BASE_MAX_SPEED = 6.15;
const DASH_SPEED = 16.2;
const DASH_ACTIVE_WINDOW = 0.19;
const DASH_BUFFER_WINDOW = 0.16;
const DASH_RECOVERY_TIME = 1.45;
const MAX_MINES = 4;
const BOSS_DASH_DAMAGE = 5;
const BOSS_TELEGRAPH_TIME = 0.68;
const STAGE_LABELS = ["第一幕 · 深潮接入", "第二幕 · 信号涌升", "第三幕 · 交叉流", "终幕 · 事件视界"];
const MODES = new Set(["menu", "playing", "upgrade", "paused", "gameover", "victory"]);
const ALLOWED_TRANSITIONS = Object.freeze({
  menu: new Set(["playing"]),
  playing: new Set(["upgrade", "paused", "gameover", "victory"]),
  upgrade: new Set(["playing"]),
  paused: new Set(["playing"]),
  gameover: new Set(["playing"]),
  victory: new Set(["playing"]),
});

const dom = {
  root: document.querySelector("#canvas-root"),
  overlay: document.querySelector("#overlay"),
  overlayKicker: document.querySelector("#overlay-kicker"),
  overlayTitle: document.querySelector("#overlay-title"),
  overlayCopy: document.querySelector("#overlay-copy"),
  primaryButton: document.querySelector("#primary-button"),
  primaryLabel: document.querySelector("#primary-label"),
  resultGrid: document.querySelector("#result-grid"),
  resultScore: document.querySelector("#result-score"),
  resultHigh: document.querySelector("#result-high"),
  score: document.querySelector("#score-value"),
  time: document.querySelector("#time-value"),
  health: document.querySelector("#health-pips"),
  energy: document.querySelector("#energy-value"),
  energyFill: document.querySelector("#energy-fill"),
  overdriveLabel: document.querySelector("#overdrive-label"),
  stageName: document.querySelector("#stage-name"),
  stageProgress: document.querySelector("#stage-progress"),
  stageTrack: document.querySelector(".stage-track"),
  stageBanner: document.querySelector("#stage-banner"),
  stageBannerTitle: document.querySelector("#stage-banner strong"),
  dashPips: Array.from(document.querySelectorAll("#dash-pips i")),
  muteButton: document.querySelector("#mute-button"),
  pauseButton: document.querySelector("#pause-button"),
  hud: document.querySelector("#hud"),
  missionPanel: document.querySelector("#mission-panel"),
  bossPanel: document.querySelector("#boss-panel"),
  bossFill: document.querySelector("#boss-fill"),
  flash: document.querySelector("#flash"),
  toast: document.querySelector("#toast"),
  combo: document.querySelector("#combo"),
  upgradePanel: document.querySelector("#upgrade-panel"),
  upgradeOptions: document.querySelector("#upgrade-options"),
  resultRank: document.querySelector("#result-rank"),
  resultCombo: document.querySelector("#result-combo"),
  resultNear: document.querySelector("#result-near"),
  resultBreaks: document.querySelector("#result-breaks"),
  touchControls: document.querySelector("#touch-controls"),
  joystick: document.querySelector("#joystick"),
  joystickKnob: document.querySelector("#joystick-knob"),
  dashButton: document.querySelector("#dash-button"),
  dashRing: document.querySelector("#dash-ring"),
};

dom.healthPips = Array.from({ length: 3 }, () => {
  const pip = document.createElement("i");
  dom.health.appendChild(pip);
  return pip;
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050816);

const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 100);
camera.position.set(0, 0, 20);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.setAttribute("aria-label", "Neon Tide 游戏画布");
dom.root.appendChild(renderer.domElement);

const world = new THREE.Group();
scene.add(world);

const backgroundGroup = new THREE.Group();
backgroundGroup.position.z = -3;
scene.add(backgroundGroup);

const starsGroup = new THREE.Group();
starsGroup.position.z = -2.4;
scene.add(starsGroup);

const decorGroup = new THREE.Group();
decorGroup.position.z = -1.8;
scene.add(decorGroup);

const view = {
  halfWidth: 10,
  halfHeight: WORLD_HEIGHT / 2,
};

const state = {
  mode: "menu",
  elapsed: 0,
  timeLeft: GAME.duration,
  score: 0,
  highScore: Number.parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10),
  health: MAX_HEALTH,
  energy: 0,
  combo: 0,
  comboTimer: 0,
  stageIndex: 0,
  enemySpawnTimer: 1.1,
  shardSpawnTimer: 1.8,
  dashCharges: [1, 1],
  dashTimer: 0,
  dashSequence: 0,
  hurtInvuln: 0,
  get playerAttacking() {
    return this.dashTimer > 0;
  },
  get dashInvulnerable() {
    return this.dashTimer > 0;
  },
  runFinished: false,
  shakeTime: 0,
  shakeStrength: 0,
  toastTimer: 0,
  stageBannerTimer: 0,
  upgradeTriggered: [false, false],
  bossTriggered: false,
  bossSpawned: false,
  muted: false,
  ownedUpgrades: [],
  upgradeOptions: [],
  modifiers: {
    speed: 1,
    score: 1,
    pickupRadius: 1,
    energy: 1,
    hurtInvuln: 0.95,
  },
  stats: {
    maxCombo: 0,
    nearMisses: 0,
    breaks: 0,
  },
  cameraLookAhead: new THREE.Vector2(),
  reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
};

const input = {
  keys: new Set(),
  dashBuffer: 0,
  touch: new THREE.Vector2(),
  joystickPointerId: null,
};

const audio = new NeonAudio();
let activeDialog = null;
let restoreFocusTarget = null;

const shards = [];
const enemies = [];
const particles = [];
const particlePool = [];
const ripples = [];

const player = {
  group: null,
  body: null,
  glow: null,
  flame: null,
  shield: null,
  position: new THREE.Vector2(0, -1.2),
  velocity: new THREE.Vector2(),
  facing: new THREE.Vector2(0, 1),
  radius: 0.42,
};

const shared = {
  shardGeometry: new THREE.OctahedronGeometry(0.24, 0),
  shardMaterial: new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true }),
  shardGlowGeometry: new THREE.CircleGeometry(0.42, 20),
  shardGlowMaterial: new THREE.MeshBasicMaterial({
    color: 0xff8f3f,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  enemyGeometry: null,
  enemyMaterial: new THREE.MeshBasicMaterial({ color: 0xff506f }),
  enemyGlowGeometry: new THREE.CircleGeometry(0.57, 20),
  enemyGlowMaterial: new THREE.MeshBasicMaterial({
    color: 0xff2a79,
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  particleGeometry: new THREE.CircleGeometry(0.055, 7),
  rippleGeometry: new THREE.RingGeometry(0.42, 0.46, 28),
  strikerGeometry: null,
  mineGeometry: new THREE.CircleGeometry(0.48, 6),
  bossCoreGeometry: new THREE.CircleGeometry(0.82, 28),
  mineRingGeometry: new THREE.RingGeometry(0.86, 0.94, 40),
  eliteOuterGeometry: new THREE.RingGeometry(0.76, 0.83, 32),
  eliteShieldGeometry: new THREE.RingGeometry(0.94, 1.0, 36),
  bossOuterGeometry: new THREE.RingGeometry(2.28, 2.42, 64),
  bossMiddleGeometry: new THREE.RingGeometry(1.62, 1.76, 56),
  bossInnerGeometry: new THREE.RingGeometry(1.12, 1.24, 48),
  bossPulseGeometry: new THREE.RingGeometry(0.94, 1.02, 52),
  telegraphLineGeometry: new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 18, 0),
  ]),
  chaserMaterial: new THREE.MeshBasicMaterial({ color: 0xff506f }),
  strikerMaterial: new THREE.MeshBasicMaterial({ color: 0xff4fd8 }),
  mineMaterial: new THREE.MeshBasicMaterial({ color: 0xff9f43 }),
  eliteMaterial: new THREE.MeshBasicMaterial({ color: 0xffedf4 }),
  bossMaterial: new THREE.MeshBasicMaterial({ color: 0xe7ffff }),
  coreMaterial: new THREE.MeshBasicMaterial({ color: 0xff506f }),
  warningRingMaterial: new THREE.MeshBasicMaterial({
    color: 0xff7ae6,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  chaserGlowMaterial: new THREE.MeshBasicMaterial({
    color: 0xff2a79,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  strikerGlowMaterial: new THREE.MeshBasicMaterial({
    color: 0xff4fd8,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  mineGlowMaterial: new THREE.MeshBasicMaterial({
    color: 0xff9f43,
    transparent: true,
    opacity: 0.17,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  telegraphMaterial: new THREE.LineBasicMaterial({
    color: 0xff7ae6,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  dangerRingMaterial: new THREE.MeshBasicMaterial({
    color: 0xff9f43,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
};

function createTriangleGeometry(nose, tailWidth, tailY) {
  const shape = new THREE.Shape();
  shape.moveTo(0, nose);
  shape.lineTo(-tailWidth, tailY);
  shape.lineTo(-tailWidth * 0.36, tailY * 0.82);
  shape.lineTo(0, tailY * 1.2);
  shape.lineTo(tailWidth * 0.36, tailY * 0.82);
  shape.lineTo(tailWidth, tailY);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

shared.enemyGeometry = createTriangleGeometry(0.43, 0.31, -0.3);
shared.strikerGeometry = createTriangleGeometry(0.72, 0.2, -0.58);

function createBackground() {
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(100, 100),
    new THREE.MeshBasicMaterial({ color: 0x050816 })
  );
  backdrop.position.z = -8;
  backgroundGroup.add(backdrop);

  const linePositions = [];
  const extent = 45;
  for (let x = -extent; x <= extent; x += 1) {
    linePositions.push(x, -extent, 0, x, extent, 0);
  }
  for (let y = -extent; y <= extent; y += 1) {
    linePositions.push(-extent, y, 0, extent, y, 0);
  }
  const gridGeometry = new THREE.BufferGeometry();
  gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
  const grid = new THREE.LineSegments(
    gridGeometry,
    new THREE.LineBasicMaterial({ color: 0x15304c, transparent: true, opacity: 0.24 })
  );
  grid.position.z = -4;
  backgroundGroup.add(grid);

  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(7.5, 48),
    new THREE.MeshBasicMaterial({
      color: 0x102b55,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  glow.position.set(7, 2.5, -3.7);
  backgroundGroup.add(glow);

  const starPositions = [];
  const starColors = [];
  const palette = [new THREE.Color(0x64f5ff), new THREE.Color(0x9e9cff), new THREE.Color(0xff70df)];
  for (let i = 0; i < 150; i += 1) {
    starPositions.push((Math.random() - 0.5) * 70, (Math.random() - 0.5) * 36, 0);
    const color = palette[i % palette.length];
    starColors.push(color.r, color.g, color.b);
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
  starGeometry.setAttribute("color", new THREE.Float32BufferAttribute(starColors, 3));
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
      size: 0.065,
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  starsGroup.add(stars);

  for (const [x, y, radius, color, opacity] of [
    [-10, 4.8, 1.6, 0x64f5ff, 0.12],
    [9.2, -3.7, 2.2, 0xff4fd8, 0.1],
    [4.4, 4.8, 0.9, 0xffd166, 0.12],
  ]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius, radius + 0.012, 64),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    ring.position.set(x, y, 0);
    decorGroup.add(ring);
  }
}

function createPlayer() {
  const group = new THREE.Group();
  group.position.z = 3;

  const bodyGeometry = createTriangleGeometry(0.58, 0.34, -0.38);
  const body = new THREE.Mesh(bodyGeometry, new THREE.MeshBasicMaterial({ color: 0x72f4ff }));
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(bodyGeometry),
    new THREE.LineBasicMaterial({ color: 0xe7ffff, transparent: true, opacity: 0.9 })
  );
  const glow = new THREE.Mesh(
    bodyGeometry,
    new THREE.MeshBasicMaterial({
      color: 0x31d7ff,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  glow.scale.setScalar(1.46);
  glow.position.z = -0.04;

  const flame = new THREE.Mesh(
    new THREE.CircleGeometry(0.11, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9 })
  );
  flame.position.set(0, -0.43, 0.04);

  const shield = new THREE.Mesh(
    new THREE.RingGeometry(0.57, 0.595, 36),
    new THREE.MeshBasicMaterial({
      color: 0x64f5ff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  shield.visible = false;

  group.add(glow, flame, body, outline, shield);
  world.add(group);

  player.group = group;
  player.body = body;
  player.glow = glow;
  player.flame = flame;
  player.shield = shield;
  player.position.set(0, -1.2);
  syncPlayerTransform();
}

function syncPlayerTransform() {
  player.group.position.x = player.position.x;
  player.group.position.y = player.position.y;
}

function createParticlePool(count = 150) {
  for (let i = 0; i < count; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(shared.particleGeometry, material);
    mesh.position.z = 4;
    mesh.visible = false;
    world.add(mesh);
    particlePool.push({ mesh, life: 0, maxLife: 0, velocity: new THREE.Vector2() });
  }
}

function spawnParticleBurst(position, color, count = 12, speed = 3.2, size = 1) {
  for (let i = 0; i < count; i += 1) {
    const particle = particlePool.find((candidate) => !candidate.mesh.visible);
    if (!particle) return;
    const angle = Math.random() * TAU;
    const force = speed * (0.38 + Math.random() * 0.8);
    particle.life = particle.maxLife = 0.28 + Math.random() * 0.42;
    particle.velocity.set(Math.cos(angle) * force, Math.sin(angle) * force);
    particle.mesh.position.set(position.x, position.y, 4.2);
    particle.mesh.scale.setScalar(size * (0.65 + Math.random() * 0.95));
    particle.mesh.material.color.set(color);
    particle.mesh.material.opacity = 0.9;
    particle.mesh.visible = true;
    particles.push(particle);
  }
}

function spawnRipple(position, color, scale = 1) {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(shared.rippleGeometry, material);
  mesh.position.set(position.x, position.y, 4);
  mesh.scale.setScalar(scale * 0.4);
  world.add(mesh);
  ripples.push({ mesh, life: 0.44, maxLife: 0.44, grow: scale * 2.7 });
}

function spawnShard(position) {
  const group = new THREE.Group();
  group.position.set(position.x, position.y, 1);
  const glow = new THREE.Mesh(shared.shardGlowGeometry, shared.shardGlowMaterial);
  glow.position.z = -0.05;
  const gem = new THREE.Mesh(shared.shardGeometry, shared.shardMaterial);
  gem.scale.set(0.86, 1.12, 0.7);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.31, 0.325, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  group.add(glow, ring, gem);
  world.add(group);
  const shard = { group, gem, ring, baseY: position.y, phase: Math.random() * TAU };
  shards.push(shard);
  return shard;
}

function randomEdgePosition(margin = 0.8) {
  const xBound = view.halfWidth + margin;
  const yBound = view.halfHeight + margin;
  const edge = Math.floor(Math.random() * 4);
  let x = 0;
  let y = 0;
  if (edge === 0) { x = -xBound; y = (Math.random() - 0.5) * yBound * 2; }
  if (edge === 1) { x = xBound; y = (Math.random() - 0.5) * yBound * 2; }
  if (edge === 2) { x = (Math.random() - 0.5) * xBound * 2; y = -yBound; }
  if (edge === 3) { x = (Math.random() - 0.5) * xBound * 2; y = yBound; }

  return new THREE.Vector2(x, y);
}

function registerEnemy(type, position, group, initialState, overrides = {}) {
  if (enemies.length >= GAME.maxEnemies) return null;
  const config = ENEMY_TYPES[type];
  group.position.set(position.x, position.y, 2);
  world.add(group);
  const enemy = {
    type,
    group,
    velocity: new THREE.Vector2(),
    speed: 0,
    radius: config.radius,
    hp: config.hp,
    maxHp: config.hp,
    state: initialState,
    stateTimer: 0,
    telegraph: 0,
    wobble: Math.random() * TAU,
    nearMissed: false,
    dead: false,
    priority: 1,
    ...overrides,
  };
  enemies.push(enemy);
  return enemy;
}

function createChaser(position = randomEdgePosition()) {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.chaserGlowMaterial);
  glow.scale.setScalar(1.45);
  const body = new THREE.Mesh(shared.enemyGeometry, shared.chaserMaterial);
  const eye = new THREE.Mesh(shared.bossCoreGeometry, shared.bossMaterial);
  eye.scale.setScalar(0.095);
  eye.position.set(0, 0.1, 0.06);
  group.add(glow, body, eye);
  return registerEnemy("chaser", position, group, "chase", {
    speed: 1.05 + state.elapsed * 0.012 + Math.random() * 0.35,
    visuals: { glow, body },
  });
}

function createStriker(position = randomEdgePosition()) {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.strikerGlowMaterial);
  glow.scale.set(1.25, 1.8, 1);
  const body = new THREE.Mesh(shared.strikerGeometry, shared.strikerMaterial);
  const line = new THREE.Line(shared.telegraphLineGeometry, shared.telegraphMaterial);
  line.position.z = -0.08;
  line.visible = false;
  group.add(line, glow, body);
  return registerEnemy("striker", position, group, "track", {
    speed: 1.25,
    stateTimer: 0.8 + Math.random() * 0.7,
    dashDirection: new THREE.Vector2(),
    visuals: { glow, body, line },
    priority: 2,
  });
}

function createMine(position = randomShardPosition()) {
  if (enemies.filter((enemy) => enemy.type === "mine" && !enemy.dead).length >= MAX_MINES) return null;
  const group = new THREE.Group();
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.mineGlowMaterial);
  glow.scale.setScalar(1.65);
  const body = new THREE.Mesh(shared.mineGeometry, shared.mineMaterial);
  const ring = new THREE.Mesh(shared.mineRingGeometry, shared.dangerRingMaterial);
  ring.position.z = -0.05;
  group.add(glow, ring, body);
  return registerEnemy("mine", position, group, "arming", {
    stateTimer: 1.35,
    telegraph: 1.35,
    dangerRadius: 0,
    previousDangerRadius: 0,
    pulseHit: false,
    visuals: { glow, body, ring },
    priority: 2,
  });
}

function createElite(position = randomEdgePosition(1.1)) {
  const group = new THREE.Group();
  const outer = new THREE.Mesh(shared.eliteOuterGeometry, shared.bossMaterial);
  const shield = new THREE.Mesh(shared.eliteShieldGeometry, shared.warningRingMaterial);
  const body = new THREE.Mesh(shared.enemyGeometry, shared.eliteMaterial);
  body.scale.setScalar(1.75);
  group.add(shield, outer, body);
  return registerEnemy("elite", position, group, "chase", {
    speed: 0.82 + Math.random() * 0.2,
    visuals: { shield, outer, body },
    priority: 3,
  });
}

function createBoss() {
  if (state.bossSpawned || enemies.some((enemy) => enemy.type === "boss" && !enemy.dead)) return null;
  const group = new THREE.Group();
  const outerRing = new THREE.Mesh(shared.bossOuterGeometry, shared.bossMaterial);
  const middleRing = new THREE.Mesh(shared.bossMiddleGeometry, shared.warningRingMaterial);
  const innerRing = new THREE.Mesh(shared.bossInnerGeometry, shared.dangerRingMaterial);
  const core = new THREE.Mesh(shared.bossCoreGeometry, shared.coreMaterial);
  core.scale.set(1.15, 0.72, 1);
  const line = new THREE.Line(shared.telegraphLineGeometry, shared.telegraphMaterial);
  line.visible = false;
  const pulseRing = new THREE.Mesh(shared.bossPulseGeometry, shared.dangerRingMaterial);
  pulseRing.visible = false;
  group.add(line, pulseRing, outerRing, middleRing, innerRing, core);
  const enemy = registerEnemy("boss", new THREE.Vector2(0, view.halfHeight + 4.8), group, "enter", {
    stateTimer: 1.5,
    telegraph: 0,
    attackIndex: 0,
    attackKind: "charge",
    dashDirection: new THREE.Vector2(),
    dangerRadius: 0,
    previousDangerRadius: 0,
    pulseHit: false,
    priority: 4,
    visuals: { outerRing, middleRing, innerRing, core, line, pulseRing },
  });
  if (enemy) state.bossSpawned = true;
  return enemy;
}

function spawnEnemy(type = null, position = null) {
  if (enemies.length >= GAME.maxEnemies) return null;
  let chosenType = type;
  if (!chosenType) {
    const roll = Math.random();
    if (state.stageIndex === 0) chosenType = "chaser";
    else if (state.stageIndex === 1) chosenType = roll < 0.34 ? "striker" : "chaser";
    else if (roll < 0.42) chosenType = "chaser";
    else if (roll < 0.7) chosenType = "striker";
    else if (roll < 0.9) chosenType = "mine";
    else chosenType = "elite";
  }
  const spawnPosition = position ?? (chosenType === "mine" ? randomShardPosition() : randomEdgePosition());
  if (chosenType === "striker") return createStriker(spawnPosition);
  if (chosenType === "mine") return createMine(spawnPosition);
  if (chosenType === "elite") return createElite(spawnPosition);
  if (chosenType === "boss") return createBoss();
  return createChaser(spawnPosition);
}

function removeShard(index) {
  const shard = shards[index];
  world.remove(shard.group);
  shard.ring.material.dispose();
  shards.splice(index, 1);
}

function removeEnemy(index) {
  const enemy = enemies[index];
  world.remove(enemy.group);
  enemies.splice(index, 1);
}

function clearWorldEntities() {
  while (shards.length) removeShard(shards.length - 1);
  while (enemies.length) removeEnemy(enemies.length - 1);
  for (const ripple of ripples) {
    world.remove(ripple.mesh);
    ripple.mesh.material.dispose();
  }
  ripples.length = 0;
  for (const particle of particlePool) {
    particle.mesh.visible = false;
    particle.mesh.material.opacity = 0;
  }
  particles.length = 0;
}

function seedShards() {
  const positions = [
    [-5.8, 3.6], [-2.1, 1.8], [2.6, 3.9], [6.3, 1.2],
    [-6.3, -2.6], [-2.7, -3.8], [1.5, -2.4], [5.3, -3.6],
  ];
  positions.forEach(([x, y]) => spawnShard(new THREE.Vector2(x, y)));
}

function randomShardPosition() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const point = new THREE.Vector2(
      THREE.MathUtils.randFloat(-view.halfWidth + 1, view.halfWidth - 1),
      THREE.MathUtils.randFloat(-view.halfHeight + 1, view.halfHeight - 1)
    );
    if (point.distanceTo(player.position) > 2.2) return point;
  }
  return new THREE.Vector2(0, 0);
}

function resetState() {
  clearWorldEntities();
  state.elapsed = 0;
  state.timeLeft = GAME.duration;
  state.score = 0;
  state.health = MAX_HEALTH;
  state.energy = 0;
  state.combo = 0;
  state.comboTimer = 0;
  state.stageIndex = 0;
  state.enemySpawnTimer = 1.1;
  state.shardSpawnTimer = 1.8;
  state.dashCharges = [1, 1];
  state.dashTimer = 0;
  state.dashSequence = 0;
  state.hurtInvuln = 0;
  state.runFinished = false;
  state.shakeTime = 0;
  state.shakeStrength = 0;
  state.stageBannerTimer = 0;
  state.upgradeTriggered = [false, false];
  state.bossTriggered = false;
  state.bossSpawned = false;
  state.ownedUpgrades = [];
  state.upgradeOptions = [];
  state.modifiers.speed = 1;
  state.modifiers.score = 1;
  state.modifiers.pickupRadius = 1;
  state.modifiers.energy = 1;
  state.modifiers.hurtInvuln = 0.95;
  state.stats.maxCombo = 0;
  state.stats.nearMisses = 0;
  state.stats.breaks = 0;
  state.cameraLookAhead.set(0, 0);
  input.dashBuffer = 0;
  player.position.set(0, -1.2);
  player.velocity.set(0, 0);
  player.facing.set(0, 1);
  player.group.scale.set(1, 1, 1);
  player.group.rotation.z = 0;
  player.group.rotation.y = 0;
  player.shield.visible = false;
  syncPlayerTransform();
  seedShards();
  audio.setStage(0);
}

function startGame() {
  audio.unlock();
  resetState();
  transitionTo("playing", { newRun: true });
  toast("潮汐已接入", "cyan");
  audio.event("start");
}

function pauseGame() {
  if (state.mode !== "playing") return;
  transitionTo("paused");
}

function resumeGame() {
  if (state.mode !== "paused") return;
  audio.unlock();
  transitionTo("playing", { resumed: true });
  toast("信号恢复", "cyan");
}

function showOverlay(kicker, title, copy, label, showResult = false) {
  dom.overlayKicker.textContent = kicker;
  dom.overlayTitle.innerHTML = title;
  dom.overlayCopy.innerHTML = copy;
  dom.primaryLabel.textContent = label;
  dom.resultGrid.hidden = !showResult;
  if (showResult) {
    dom.resultScore.textContent = String(state.score);
    dom.resultHigh.textContent = String(state.highScore);
    dom.resultRank.textContent = computeRank({ score: state.score });
    dom.resultCombo.textContent = String(state.stats.maxCombo);
    dom.resultNear.textContent = String(state.stats.nearMisses);
    dom.resultBreaks.textContent = String(state.stats.breaks);
  }
  openDialog(dom.overlay, dom.primaryButton);
}

function openDialog(dialog, focusTarget) {
  if (!activeDialog) restoreFocusTarget = document.activeElement;
  if (activeDialog && activeDialog !== dialog) {
    activeDialog.removeAttribute("aria-modal");
    activeDialog.hidden = true;
    activeDialog.classList?.remove("visible");
  }
  activeDialog = dialog;
  dialog.hidden = false;
  dialog.setAttribute("aria-modal", "true");
  if (dialog === dom.overlay) dialog.classList.add("visible");
  setBackgroundInert(true);
  window.requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
}

function closeDialogs({ restoreFocus = true } = {}) {
  if (!activeDialog) return;
  dom.overlay.classList.remove("visible");
  dom.overlay.removeAttribute("aria-modal");
  dom.upgradePanel.hidden = true;
  dom.upgradePanel.removeAttribute("aria-modal");
  activeDialog = null;
  setBackgroundInert(false);
  if (!restoreFocus) {
    restoreFocusTarget = null;
    return;
  }
  const candidate = restoreFocusTarget;
  restoreFocusTarget = null;
  window.requestAnimationFrame(() => {
    const target = candidate && candidate !== document.body && candidate.isConnected ? candidate : dom.pauseButton;
    target?.focus({ preventScroll: true });
  });
}

function setBackgroundInert(inert) {
  [dom.root, dom.hud, dom.missionPanel, dom.bossPanel, dom.touchControls].forEach((element) => {
    if (element) element.inert = inert;
  });
  dom.pauseButton.disabled = inert;
  dom.muteButton.disabled = inert;
  dom.dashButton.disabled = inert;
}

function transitionTo(nextMode, payload = {}) {
  if (!MODES.has(nextMode) || nextMode === state.mode) return false;
  const allowed = ALLOWED_TRANSITIONS[state.mode];
  if (!allowed?.has(nextMode)) return false;
  const previousMode = state.mode;
  state.mode = nextMode;
  if (nextMode !== "playing") {
    input.keys.clear();
    input.dashBuffer = 0;
    resetJoystick();
    audio.suspendBeat();
  }
  renderMode(nextMode, previousMode, payload);
  return true;
}

function renderMode(mode, previousMode, payload = {}) {
  dom.pauseButton.textContent = mode === "paused" ? "▶" : "Ⅱ";
  dom.pauseButton.style.visibility = ["menu", "gameover", "victory"].includes(mode) ? "hidden" : "visible";
  if (mode === "playing") {
    closeDialogs({ restoreFocus: previousMode !== "menu" || payload.newRun });
    return;
  }
  if (mode === "upgrade") {
    renderUpgradeOptions(payload.options ?? state.upgradeOptions);
    const firstOption = dom.upgradeOptions.querySelector("button");
    openDialog(dom.upgradePanel, firstOption);
    return;
  }
  if (mode === "menu") {
    showOverlay(
      "ARCADE SURVIVAL // THREE.JS",
      "NEON<br /><em>TIDE</em>",
      `在失控的数字海域中收集光核，躲开追猎信号。<br />坚持 ${GAME.duration} 秒，等到潮汐退去。`,
      "进入潮汐"
    );
  } else if (mode === "paused") {
    showOverlay(
      "SIGNAL HOLD // PAUSED",
      "SIGNAL<br /><em>PAUSED</em>",
      "潮汐暂时冻结。准备好后继续收集光核。",
      "继续潮汐"
    );
  } else if (mode === "gameover") {
    showOverlay(
      "SIGNAL LOST // HULL BREACH",
      "SIGNAL<br /><em>LOST</em>",
      "追猎信号撕裂了你的护盾。再来一次，把潮汐变成你的舞台。",
      "重新接入",
      true
    );
  } else if (mode === "victory") {
    showOverlay(
      "SIGNAL CLEAR // TIDE OUT",
      "TIDE<br /><em>OUT</em>",
      "你穿过了整片霓虹潮汐。光核已经记住了你的航线。",
      "再次出航",
      true
    );
  }
}

function finishRun(outcome) {
  if (state.runFinished || state.mode !== "playing" || !["gameover", "victory"].includes(outcome)) return false;
  state.runFinished = true;
  if (outcome === "victory") state.score += 250;
  updateHighScore();
  transitionTo(outcome);
  if (outcome === "victory") {
    flash("#64f5ff", 0.28);
    spawnParticleBurst(player.position, 0x64f5ff, 36, 3.6, 1.5);
    spawnRipple(player.position, 0x64f5ff, 3.2);
    audio.event("victory");
  } else {
    flash("#ff506f", 0.24);
    spawnParticleBurst(player.position, 0xff506f, 28, 4.8, 1.4);
    spawnRipple(player.position, 0xff506f, 2.4);
    audio.event("defeat");
  }
  return true;
}

function beginUpgrade(stageIndex) {
  if (state.mode !== "playing") return;
  state.upgradeOptions = [...pickUpgradeOptions(state.ownedUpgrades, Math.random, 3)];
  transitionTo("upgrade", { stageIndex, options: state.upgradeOptions });
}

function renderUpgradeOptions(options) {
  const effectLabels = {
    "ion-drive": "极速 +15%",
    "prism-core": "收益 +20%",
    "echo-shield": "防护 +0.08 秒",
    "magnet-field": "拾取范围 +25%",
    overclock: "充能 +20%",
    "repair-swarm": "修复船体 +1",
  };
  const buttons = options.map((upgrade, index) => {
    const button = document.createElement("button");
    button.className = "upgrade-option";
    button.type = "button";
    button.dataset.upgradeId = upgrade.id;
    button.innerHTML = `<span class="upgrade-number" aria-hidden="true">${index + 1}</span><span class="upgrade-title">${upgrade.name}</span><span class="upgrade-description">${upgrade.description}</span><strong class="upgrade-effect">${effectLabels[upgrade.id] ?? "信号强化"}</strong>`;
    return button;
  });
  dom.upgradeOptions.replaceChildren(...buttons);
}

function chooseUpgrade(upgradeId) {
  if (state.mode !== "upgrade") return;
  const upgrade = state.upgradeOptions.find((candidate) => candidate.id === upgradeId);
  if (!upgrade) return;
  state.ownedUpgrades.push(upgrade.id);
  if (upgrade.id === "ion-drive") state.modifiers.speed += upgrade.effect;
  if (upgrade.id === "prism-core") state.modifiers.score += upgrade.effect;
  if (upgrade.id === "echo-shield") state.modifiers.hurtInvuln += upgrade.effect;
  if (upgrade.id === "magnet-field") state.modifiers.pickupRadius += upgrade.effect;
  if (upgrade.id === "overclock") state.modifiers.energy += upgrade.effect;
  if (upgrade.id === "repair-swarm") state.health = Math.min(MAX_HEALTH, state.health + upgrade.effect);
  audio.event("upgrade");
  transitionTo("playing", { upgraded: true });
}

function updateHighScore() {
  state.highScore = Math.max(state.highScore, state.score);
  localStorage.setItem(STORAGE_KEY, String(state.highScore));
}

function updatePlayer(dt) {
  const direction = readMoveDirection();
  const hasDirection = direction.lengthSq() > 0.01;
  if (hasDirection) {
    player.facing.lerp(direction, 1 - Math.exp(-TURN_ACCELERATION * 0.5 * dt)).normalize();
  }

  if (input.dashBuffer > 0 && attemptDash(direction)) input.dashBuffer = 0;

  if (state.dashTimer <= 0) {
    if (hasDirection) {
      const speed = player.velocity.length();
      if (speed > 0.05) {
        const desiredVelocity = direction.clone().multiplyScalar(speed);
        const steering = desiredVelocity.sub(player.velocity);
        const maxSteering = TURN_ACCELERATION * dt;
        if (steering.lengthSq() > maxSteering * maxSteering) steering.setLength(maxSteering);
        player.velocity.add(steering);
      }
      player.velocity.addScaledVector(direction, MOVE_ACCELERATION * dt);
      player.velocity.multiplyScalar(Math.exp(-MOVE_DAMPING * 0.35 * dt));
    } else {
      player.velocity.multiplyScalar(Math.exp(-COAST_DAMPING * dt));
    }
    player.velocity.clampLength(0, BASE_MAX_SPEED * state.modifiers.speed);
  }

  player.position.addScaledVector(player.velocity, dt);
  const margin = 0.72;
  const maxX = view.halfWidth - margin;
  const maxY = view.halfHeight - margin;
  if (player.position.x < -maxX || player.position.x > maxX) {
    player.position.x = THREE.MathUtils.clamp(player.position.x, -maxX, maxX);
    player.velocity.x *= -0.25;
  }
  if (player.position.y < -maxY || player.position.y > maxY) {
    player.position.y = THREE.MathUtils.clamp(player.position.y, -maxY, maxY);
    player.velocity.y *= -0.25;
  }

  const speed = player.velocity.length();
  if (speed > 0.08) {
    player.group.rotation.z = Math.atan2(player.facing.y, player.facing.x) - Math.PI / 2;
  }
  const velocityDirection = speed > 0.08 ? player.velocity.clone().multiplyScalar(1 / speed) : player.facing;
  const bankInput = hasDirection ? THREE.MathUtils.clamp(velocityDirection.x * direction.y - velocityDirection.y * direction.x, -1, 1) : 0;
  const targetBank = state.reducedMotion ? 0 : bankInput * 0.42;
  player.group.rotation.y = THREE.MathUtils.lerp(player.group.rotation.y, targetBank, 1 - Math.exp(-10 * dt));
  const flameScale = 0.75 + Math.min(speed / 5, 1) * 0.7;
  if (state.reducedMotion) {
    player.group.scale.set(1, 1, 1);
    player.flame.scale.setScalar(flameScale);
  } else {
    const targetScale = state.dashTimer > 0 ? 1.22 : 1;
    player.group.scale.x = THREE.MathUtils.lerp(player.group.scale.x, targetScale, 1 - Math.exp(-22 * dt));
    player.group.scale.y = THREE.MathUtils.lerp(player.group.scale.y, state.dashTimer > 0 ? 0.82 : 1, 1 - Math.exp(-22 * dt));
    player.flame.scale.setScalar(flameScale + Math.sin(state.elapsed * 30) * 0.08);
  }
  player.flame.material.opacity = 0.48 + Math.min(speed / 5, 1) * 0.45;
  player.shield.visible = state.dashInvulnerable || state.hurtInvuln > 0;
  player.shield.material.opacity = 0.48 + Math.sin(state.elapsed * 24) * 0.2;
  syncPlayerTransform();
}

function attemptDash(direction) {
  if (state.mode !== "playing" || state.playerAttacking) return false;
  const chargeIndex = state.dashCharges.findIndex((charge) => charge >= 0.999);
  if (chargeIndex < 0) return false;
  const dashDirection = direction.lengthSq() > 0.01 ? direction.clone().normalize() : player.facing.clone().normalize();
  state.dashCharges[chargeIndex] = 0;
  state.dashTimer = DASH_ACTIVE_WINDOW;
  state.dashSequence += 1;
  player.facing.copy(dashDirection);
  player.velocity.copy(dashDirection).multiplyScalar(DASH_SPEED * state.modifiers.speed);
  if (state.reducedMotion) player.group.scale.set(1, 1, 1);
  else player.group.scale.set(1.25, 0.78, 1);
  spawnParticleBurst(player.position, 0x64f5ff, 15, 3.7, 0.85);
  spawnRipple(player.position, 0x64f5ff, 1.2);
  shake(0.08, 0.12);
  audio.event("dash");
  return true;
}

function readMoveDirection() {
  const direction = new THREE.Vector2();
  if (input.keys.has("ArrowLeft") || input.keys.has("a")) direction.x -= 1;
  if (input.keys.has("ArrowRight") || input.keys.has("d")) direction.x += 1;
  if (input.keys.has("ArrowDown") || input.keys.has("s")) direction.y -= 1;
  if (input.keys.has("ArrowUp") || input.keys.has("w")) direction.y += 1;
  direction.add(input.touch);
  if (direction.lengthSq() > 1) direction.normalize();
  return direction;
}

function updateShards(dt) {
  for (const shard of shards) {
    shard.gem.rotation.z += dt * 1.8;
    shard.ring.rotation.z -= dt * 0.8;
    shard.group.position.y = shard.baseY + Math.sin(state.elapsed * 2.5 + shard.phase) * 0.12;
    const pulse = 1 + Math.sin(state.elapsed * 5 + shard.phase) * 0.09;
    shard.group.scale.setScalar(pulse);
  }

  for (let i = shards.length - 1; i >= 0; i -= 1) {
    const shard = shards[i];
    const dx = shard.group.position.x - player.position.x;
    const dy = shard.group.position.y - player.position.y;
    if (Math.hypot(dx, dy) < (player.radius + 0.3) * state.modifiers.pickupRadius) {
      collectShard(i);
    }
  }
}

function collectShard(index) {
  const shard = shards[index];
  const position = new THREE.Vector2(shard.group.position.x, shard.group.position.y);
  removeShard(index);
  const reward = computeReward("pickup", state.combo, state.modifiers.score);
  state.score += reward.score;
  state.energy = Math.min(GAME.overdriveEnergy, state.energy + reward.energy * state.modifiers.energy);
  state.combo += 1;
  state.stats.maxCombo = Math.max(state.stats.maxCombo, state.combo);
  state.comboTimer = 2.8;
  spawnParticleBurst(position, 0xffd166, 16, 3.5, 0.9);
  spawnRipple(position, 0xffd166, 1.1);
  audio.event("pickup", Math.min(1, state.combo / GAME.comboCap));
  if (state.combo > 1) {
    dom.combo.innerHTML = `连击 ×<b>${state.combo}</b>`;
    dom.combo.classList.add("show");
  }
}

function setEnemyState(enemy, nextState, duration = 0, telegraph = 0) {
  enemy.state = nextState;
  enemy.stateTimer = duration;
  enemy.telegraph = telegraph;
}

function steerEnemy(enemy, toPlayer, dt, speed = enemy.speed, response = 2.8, wobbleStrength = 0.2) {
  const steering = toPlayer.clone().multiplyScalar(speed);
  if (wobbleStrength > 0) {
    steering.add(new THREE.Vector2(-toPlayer.y, toPlayer.x).multiplyScalar(
      Math.sin(state.elapsed * 2.2 + enemy.wobble) * wobbleStrength
    ));
  }
  enemy.velocity.lerp(steering, 1 - Math.exp(-response * dt));
}

function updateChaser(enemy, dt, toPlayer) {
  steerEnemy(enemy, toPlayer, dt);
  const pulse = 1 + Math.sin(state.elapsed * 4 + enemy.wobble) * 0.08;
  enemy.visuals.glow.scale.setScalar(1.45 * pulse);
}

function updateStriker(enemy, dt, toPlayer) {
  enemy.stateTimer -= dt;
  if (enemy.state === "track") {
    steerEnemy(enemy, toPlayer, dt, enemy.speed, 3.4, 0.12);
    if (enemy.stateTimer <= 0) {
      enemy.dashDirection.copy(toPlayer);
      enemy.visuals.line.visible = true;
      setEnemyState(enemy, "telegraph", 0.62, 0.62);
    }
  } else if (enemy.state === "telegraph") {
    enemy.telegraph = Math.max(0, enemy.stateTimer);
    enemy.velocity.multiplyScalar(Math.exp(-8 * dt));
    enemy.group.rotation.z = Math.atan2(enemy.dashDirection.y, enemy.dashDirection.x) - Math.PI / 2;
    enemy.visuals.body.scale.setScalar(1 + Math.sin(state.elapsed * 32) * 0.12);
    if (enemy.stateTimer <= 0) {
      enemy.visuals.line.visible = false;
      enemy.visuals.body.scale.setScalar(1);
      enemy.velocity.copy(enemy.dashDirection).multiplyScalar(12.5);
      setEnemyState(enemy, "dash", 0.42);
    }
  } else if (enemy.state === "dash") {
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "recover", 0.72);
  } else if (enemy.state === "recover") {
    enemy.velocity.multiplyScalar(Math.exp(-5.5 * dt));
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "track", 0.9 + Math.random() * 0.65);
  }
}

function updateMine(enemy, dt) {
  enemy.stateTimer -= dt;
  enemy.group.rotation.z += dt * (enemy.state === "arming" ? 0.8 : 2.5);
  if (enemy.state === "arming") {
    enemy.telegraph = Math.max(0, enemy.stateTimer);
    const pulse = 0.9 + (1 - enemy.telegraph / 1.35) * 0.35 + Math.sin(state.elapsed * 22) * 0.05;
    enemy.visuals.ring.scale.setScalar(pulse);
    if (enemy.stateTimer <= 0) {
      enemy.previousDangerRadius = 0;
      enemy.dangerRadius = 0;
      setEnemyState(enemy, "detonate", 0.78);
    }
  } else if (enemy.state === "detonate") {
    const progress = 1 - Math.max(0, enemy.stateTimer / 0.78);
    enemy.previousDangerRadius = enemy.dangerRadius;
    enemy.dangerRadius = THREE.MathUtils.lerp(0.55, 4.8, progress);
    enemy.visuals.ring.scale.setScalar(enemy.dangerRadius / 0.9);
    enemy.visuals.glow.scale.setScalar(1.4 + progress * 1.2);
    if (enemy.stateTimer <= 0) enemy.dead = true;
  }
}

function updateElite(enemy, dt, toPlayer) {
  steerEnemy(enemy, toPlayer, dt, enemy.speed, 2.15, 0.08);
  enemy.visuals.shield.rotation.z += dt * 1.4;
  enemy.visuals.outer.rotation.z -= dt * 0.9;
  const shieldScale = 1 + Math.sin(state.elapsed * 5 + enemy.wobble) * 0.07;
  enemy.visuals.shield.scale.setScalar(shieldScale);
}

function beginBossTelegraph(enemy) {
  enemy.attackKind = ["charge", "pulse", "summon"][enemy.attackIndex % 3];
  enemy.attackIndex += 1;
  enemy.pulseHit = false;
  enemy.previousDangerRadius = 0;
  enemy.dangerRadius = 0;
  enemy.visuals.line.visible = enemy.attackKind === "charge";
  enemy.visuals.pulseRing.visible = enemy.attackKind !== "charge";
  if (enemy.attackKind === "charge") enemy.dashDirection.copy(player.position).sub(enemy.group.position).normalize();
  setEnemyState(enemy, "telegraph", BOSS_TELEGRAPH_TIME, BOSS_TELEGRAPH_TIME);
}

function beginBossExecute(enemy) {
  enemy.visuals.line.visible = false;
  if (enemy.attackKind === "charge") {
    enemy.velocity.copy(enemy.dashDirection).multiplyScalar(9.5);
    setEnemyState(enemy, "execute", 0.72);
  } else if (enemy.attackKind === "pulse") {
    enemy.dangerRadius = 0.9;
    setEnemyState(enemy, "execute", 1.05);
  } else {
    const availableSlots = Math.max(0, Math.min(2, GAME.maxEnemies - enemies.length));
    for (let i = 0; i < availableSlots; i += 1) {
      const angle = (i / Math.max(1, availableSlots)) * TAU + enemy.wobble;
      createChaser(new THREE.Vector2(
        enemy.group.position.x + Math.cos(angle) * 2.8,
        enemy.group.position.y + Math.sin(angle) * 2.2
      ));
    }
    setEnemyState(enemy, "execute", 0.56);
  }
}

function updateBoss(enemy, dt) {
  enemy.stateTimer -= dt;
  enemy.visuals.outerRing.rotation.z += dt * 0.32;
  enemy.visuals.middleRing.rotation.z -= dt * 0.58;
  enemy.visuals.innerRing.rotation.z += dt * 0.9;
  if (enemy.state === "enter") {
    enemy.group.position.y = THREE.MathUtils.damp(enemy.group.position.y, 3.2, 3.2, dt);
    if (enemy.stateTimer <= 0 || Math.abs(enemy.group.position.y - 3.2) < 0.12) setEnemyState(enemy, "choose", 0.35);
    return;
  }
  if (enemy.state === "choose") {
    enemy.velocity.multiplyScalar(Math.exp(-5 * dt));
    if (enemy.stateTimer <= 0) beginBossTelegraph(enemy);
  } else if (enemy.state === "telegraph") {
    enemy.telegraph = Math.max(0, enemy.stateTimer);
    enemy.velocity.multiplyScalar(Math.exp(-7 * dt));
    if (enemy.attackKind === "charge") {
      enemy.group.rotation.z = Math.atan2(enemy.dashDirection.y, enemy.dashDirection.x) - Math.PI / 2;
    } else {
      const warningScale = 1 + (1 - enemy.telegraph / BOSS_TELEGRAPH_TIME) * 2.1;
      enemy.visuals.pulseRing.scale.setScalar(warningScale);
    }
    if (enemy.stateTimer <= 0) beginBossExecute(enemy);
  } else if (enemy.state === "execute") {
    if (enemy.attackKind === "pulse") {
      const progress = 1 - Math.max(0, enemy.stateTimer / 1.05);
      enemy.previousDangerRadius = enemy.dangerRadius;
      enemy.dangerRadius = THREE.MathUtils.lerp(0.9, Math.max(view.halfWidth, view.halfHeight) + 2, progress);
      enemy.visuals.pulseRing.scale.setScalar(enemy.dangerRadius);
    } else if (enemy.attackKind !== "charge") {
      enemy.visuals.pulseRing.scale.setScalar(1 + Math.sin(state.elapsed * 18) * 0.18);
    }
    if (enemy.stateTimer <= 0) {
      enemy.visuals.pulseRing.visible = false;
      setEnemyState(enemy, "recover", 0.82);
    }
  } else if (enemy.state === "recover") {
    enemy.velocity.multiplyScalar(Math.exp(-4.5 * dt));
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "choose", 0.28);
  }
}

function waveReachedPlayer(enemy, distance) {
  if (enemy.pulseHit || enemy.dangerRadius <= 0) return false;
  const band = player.radius + 0.34;
  return distance + band >= enemy.previousDangerRadius && distance - band <= enemy.dangerRadius;
}

function registerNearMiss(enemy, distance, toPlayer) {
  if (enemy.nearMissed || enemy.type === "mine" || enemy.type === "boss") return;
  const collisionDistance = player.radius + enemy.radius;
  if (distance >= collisionDistance + 0.62 || enemy.velocity.dot(toPlayer) <= 0) return;
  enemy.nearMissed = true;
  const reward = computeReward("nearMiss", state.combo, state.modifiers.score);
  state.score += reward.score;
  state.energy = Math.min(GAME.overdriveEnergy, state.energy + reward.energy * state.modifiers.energy);
  state.stats.nearMisses += 1;
  audio.event("nearMiss");
}

function dashHitsEnemy(enemy, distance) {
  if (!state.playerAttacking || enemy.lastDashId === state.dashSequence) return false;
  const targetRadius = enemy.type === "boss" ? 0.95 : enemy.radius;
  return distance < player.radius + targetRadius;
}

function damageEnemy(enemy, index) {
  enemy.lastDashId = state.dashSequence;
  enemy.hp -= enemy.type === "boss" ? BOSS_DASH_DAMAGE : 1;
  const position = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
  if (enemy.hp <= 0) {
    enemy.dead = true;
    breakEnemy(index, enemy);
    return;
  }
  const away = position.clone().sub(player.position).normalize();
  enemy.velocity.addScaledVector(away, enemy.type === "elite" ? 2.4 : 1.2);
  spawnParticleBurst(position, enemy.type === "boss" ? 0xe7ffff : 0xff506f, 12, 3.2, 0.9);
  spawnRipple(position, enemy.type === "boss" ? 0x64f5ff : 0xff506f, enemy.type === "boss" ? 1.8 : 1.1);
  audio.event(enemy.type === "boss" ? "bossHit" : "break", 0.65);
}

function updateEnemies(dt) {
  const initialCount = enemies.length;
  for (let index = initialCount - 1; index >= 0; index -= 1) {
    const enemy = enemies[index];
    if (!enemy || enemy.dead) continue;
    const toPlayer = player.position.clone().sub(enemy.group.position);
    const distance = Math.max(toPlayer.length(), 0.001);
    toPlayer.multiplyScalar(1 / distance);
    if (enemy.type === "striker") updateStriker(enemy, dt, toPlayer);
    else if (enemy.type === "mine") updateMine(enemy, dt);
    else if (enemy.type === "elite") updateElite(enemy, dt, toPlayer);
    else if (enemy.type === "boss") updateBoss(enemy, dt);
    else updateChaser(enemy, dt, toPlayer);
    if (enemy.dead) continue;
    if (enemy.type !== "mine" && enemy.state !== "enter") {
      enemy.group.position.x += enemy.velocity.x * dt;
      enemy.group.position.y += enemy.velocity.y * dt;
      if (enemy.velocity.lengthSq() > 0.01 && enemy.state !== "telegraph") {
        enemy.group.rotation.z = Math.atan2(enemy.velocity.y, enemy.velocity.x) - Math.PI / 2;
      }
    }
  }

  for (let index = enemies.length - 1; index >= 0; index -= 1) {
    const enemy = enemies[index];
    if (!enemy || enemy.dead) continue;
    const distance = player.position.distanceTo(enemy.group.position);
    if (dashHitsEnemy(enemy, distance)) damageEnemy(enemy, index);
  }

  for (let index = enemies.length - 1; index >= 0 && state.mode === "playing"; index -= 1) {
    const enemy = enemies[index];
    if (!enemy || enemy.dead) continue;
    const toPlayer = player.position.clone().sub(enemy.group.position);
    const distance = Math.max(toPlayer.length(), 0.001);
    toPlayer.multiplyScalar(1 / distance);
    registerNearMiss(enemy, distance, toPlayer);
    if (state.dashInvulnerable || state.hurtInvuln > 0) continue;
    const contactRadius = enemy.type === "boss" ? 2.25 : enemy.radius;
    const bodyContact = enemy.type !== "mine" && enemy.state !== "enter" && distance < player.radius + contactRadius;
    const waveContact = (enemy.type === "mine" || enemy.type === "boss") && waveReachedPlayer(enemy, distance);
    if (bodyContact || waveContact) {
      enemy.pulseHit = waveContact || enemy.pulseHit;
      damagePlayer(enemy);
    }
  }

  for (let index = enemies.length - 1; index >= 0; index -= 1) {
    if (enemies[index].dead) removeEnemy(index);
  }
}

function breakEnemy(index, enemy = enemies[index]) {
  if (!enemy) return;
  const position = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
  if (enemies[index] === enemy) removeEnemy(index);
  const reward = computeReward("break", state.combo, state.modifiers.score);
  state.score += reward.score;
  state.energy = Math.min(GAME.overdriveEnergy, state.energy + reward.energy * state.modifiers.energy);
  state.stats.breaks += 1;
  spawnParticleBurst(position, 0xff4fd8, 20, 4.5, 1.1);
  spawnRipple(position, 0xff4fd8, 1.5);
  audio.event("break");
  if (enemy.type === "boss") finishRun("victory");
}

function damagePlayer(enemy) {
  state.health -= 1;
  state.energy = Math.max(0, state.energy - 18);
  state.hurtInvuln = state.modifiers.hurtInvuln;
  state.combo = 0;
  state.comboTimer = 0;
  state.score = Math.max(0, state.score - 12);
  player.velocity.multiplyScalar(-0.3);
  const hitPosition = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
  spawnParticleBurst(hitPosition, 0xff506f, 22, 4.2, 1.1);
  spawnRipple(hitPosition, 0xff506f, 1.5);
  shake(0.2, 0.28);
  flash("#ff506f", 0.13);
  toast("船体受损", "danger");
  audio.event("hurt");
  if (state.health <= 0) finishRun("gameover");
}

function updateSpawning(dt) {
  state.enemySpawnTimer -= dt;
  const healthPercent = (state.health / MAX_HEALTH) * 100;
  const spawnBudget = computeSpawnBudget(state.elapsed, healthPercent, state.score);
  const stage = STAGES[state.stageIndex];
  const enemyInterval = Math.max(0.38, (1.18 - state.elapsed * 0.009) / stage.spawnRate);
  if (state.enemySpawnTimer <= 0 && state.stageIndex < 3) {
    const cappedBudget = Math.min(GAME.maxEnemies, spawnBudget);
    if (enemies.length < cappedBudget) spawnEnemy();
    if (enemies.length < cappedBudget && state.stageIndex === 2 && Math.random() < 0.22) spawnEnemy();
    state.enemySpawnTimer = enemyInterval;
  }

  state.shardSpawnTimer -= dt;
  if (state.shardSpawnTimer <= 0) {
    if (shards.length < 9) spawnShard(randomShardPosition());
    state.shardSpawnTimer = 2.15;
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const particle = particles[i];
    particle.life -= dt;
    particle.mesh.position.x += particle.velocity.x * dt;
    particle.mesh.position.y += particle.velocity.y * dt;
    particle.velocity.multiplyScalar(Math.exp(-3.4 * dt));
    const lifeRatio = Math.max(0, particle.life / particle.maxLife);
    particle.mesh.material.opacity = lifeRatio * 0.85;
    particle.mesh.scale.multiplyScalar(1 + dt * 1.8);
    if (particle.life <= 0) {
      particle.mesh.visible = false;
      particle.mesh.material.opacity = 0;
      particles.splice(i, 1);
    }
  }
}

function updateRipples(dt) {
  for (let i = ripples.length - 1; i >= 0; i -= 1) {
    const ripple = ripples[i];
    ripple.life -= dt;
    const progress = 1 - Math.max(0, ripple.life / ripple.maxLife);
    ripple.mesh.scale.setScalar(0.4 + progress * ripple.grow);
    ripple.mesh.material.opacity = (1 - progress) * 0.72;
    if (ripple.life <= 0) {
      world.remove(ripple.mesh);
      ripple.mesh.material.dispose();
      ripples.splice(i, 1);
    }
  }
}

function updateVisuals(dt) {
  const visualSpeed = state.reducedMotion ? 0.35 : 1;
  decorGroup.rotation.z += dt * 0.004 * visualSpeed;
  starsGroup.rotation.z -= dt * 0.0015 * visualSpeed;
  backgroundGroup.position.x = Math.sin(state.elapsed * 0.19) * 0.12;
  backgroundGroup.position.y = Math.cos(state.elapsed * 0.16) * 0.08;
  const lookAheadTarget = player.position.clone().multiplyScalar(0.035).addScaledVector(player.velocity, 0.11);
  lookAheadTarget.clampLength(0, state.reducedMotion ? 0.18 : 0.72);
  state.cameraLookAhead.lerp(lookAheadTarget, 1 - Math.exp(-5.5 * dt));
  let shakeX = 0;
  let shakeY = 0;
  if (state.shakeTime > 0) {
    state.shakeTime -= dt;
    const falloff = Math.max(0, state.shakeTime / 0.3);
    shakeX = (Math.random() - 0.5) * state.shakeStrength * falloff;
    shakeY = (Math.random() - 0.5) * state.shakeStrength * falloff;
  }
  camera.position.x = state.cameraLookAhead.x + shakeX;
  camera.position.y = state.cameraLookAhead.y + shakeY;
  camera.position.z = 20;
  const cameraBank = state.reducedMotion ? 0 : THREE.MathUtils.clamp(-player.velocity.x * 0.0025, -0.012, 0.012);
  camera.rotation.z = THREE.MathUtils.lerp(camera.rotation.z, cameraBank, 1 - Math.exp(-4 * dt));
  updateHUD(dt);
}

function updateHUD(dt) {
  dom.score.textContent = String(state.score).padStart(4, "0");
  const totalSeconds = Math.max(0, Math.ceil(state.timeLeft));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  dom.time.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  dom.time.classList.toggle("warning", state.timeLeft <= 10 && state.mode === "playing");
  dom.energy.textContent = String(Math.round(state.energy));
  const energyPercent = THREE.MathUtils.clamp((state.energy / GAME.overdriveEnergy) * 100, 0, 100);
  dom.energyFill.style.width = `${energyPercent}%`;
  dom.overdriveLabel.textContent = energyPercent >= 100 ? "OVERDRIVE // 已充能" : "OVERDRIVE // 待机";
  dom.healthPips.forEach((pip, index) => pip.classList.toggle("empty", index >= state.health));
  state.dashCharges.forEach((charge, index) => {
    const pip = dom.dashPips[index];
    pip.classList.toggle("spent", charge <= 0.001);
    pip.style.opacity = String(0.2 + charge * 0.8);
    pip.style.transform = `skewX(-22deg) scale(${0.78 + charge * 0.22})`;
  });
  const readyCharges = state.dashCharges.filter((charge) => charge >= 0.999).length;
  dom.dashButton.classList.toggle("cooldown", readyCharges === 0);
  dom.dashButton.setAttribute("aria-label", `冲刺，${readyCharges} 格可用`);
  dom.dashButton.setAttribute("aria-disabled", String(readyCharges === 0));
  const firstArc = Math.round(state.dashCharges[0] * 170);
  const secondArc = 190 + Math.round(state.dashCharges[1] * 170);
  dom.dashRing.style.background = `conic-gradient(from -90deg, #ff4fd8 0deg ${firstArc}deg, rgba(255,79,216,.14) ${firstArc}deg 170deg, transparent 170deg 190deg, #64f5ff 190deg ${secondArc}deg, rgba(100,245,255,.14) ${secondArc}deg 360deg)`;
  const stage = STAGES[state.stageIndex];
  const stageEnd = Number.isFinite(stage.end) ? stage.end : GAME.duration;
  const stageDuration = Math.max(0.001, stageEnd - stage.start);
  const stageProgress = THREE.MathUtils.clamp(((state.elapsed - stage.start) / stageDuration) * 100, 0, 100);
  dom.stageName.textContent = STAGE_LABELS[state.stageIndex] ?? stage.name;
  dom.stageProgress.style.width = `${stageProgress}%`;
  dom.stageTrack.setAttribute("aria-valuenow", String(Math.round(stageProgress)));
  const boss = enemies.find((enemy) => enemy.type === "boss" && !enemy.dead);
  dom.bossPanel.hidden = !boss;
  dom.bossFill.style.width = `${boss ? THREE.MathUtils.clamp((boss.hp / boss.maxHp) * 100, 0, 100) : 100}%`;
  if (state.toastTimer > 0) {
    state.toastTimer -= dt;
    if (state.toastTimer <= 0) dom.toast.classList.remove("show");
  }
  if (state.stageBannerTimer > 0) {
    state.stageBannerTimer -= dt;
    if (state.stageBannerTimer <= 0) dom.stageBanner.classList.remove("show");
  }
}

function updateStage() {
  const nextStageIndex = getStageIndex(state.elapsed);
  if (nextStageIndex === state.stageIndex) return;
  state.stageIndex = nextStageIndex;
  audio.setStage(nextStageIndex);
  dom.stageBannerTitle.textContent = nextStageIndex === 3
    ? "终幕 · 潮汐守卫"
    : STAGE_LABELS[nextStageIndex] ?? STAGES[nextStageIndex].name;
  dom.stageBanner.classList.add("show");
  state.stageBannerTimer = nextStageIndex === 3 ? 2.2 : 1.6;
  if ((nextStageIndex === 1 || nextStageIndex === 2) && !state.upgradeTriggered[nextStageIndex - 1]) {
    state.upgradeTriggered[nextStageIndex - 1] = true;
    beginUpgrade(nextStageIndex);
  } else if (nextStageIndex === 3 && !state.bossTriggered) {
    state.bossTriggered = true;
    beginBossStage();
  }
}

function beginBossStage() {
  for (let index = enemies.length - 1; index >= 0; index -= 1) {
    if (enemies[index].priority < 4) removeEnemy(index);
  }
  state.enemySpawnTimer = Infinity;
  toast("潮汐守卫已锁定", "danger");
  spawnParticleBurst(new THREE.Vector2(0, view.halfHeight - 0.6), 0xe7ffff, 28, 4.2, 1.25);
  createBoss();
}

function shake(strength, duration) {
  if (state.reducedMotion) return;
  state.shakeStrength = Math.max(state.shakeStrength, strength);
  state.shakeTime = Math.max(state.shakeTime, duration);
}

function flash(color, opacity = 0.16) {
  dom.flash.style.background = color;
  dom.flash.style.opacity = String(opacity);
  window.clearTimeout(flash.timeout);
  flash.timeout = window.setTimeout(() => {
    dom.flash.style.opacity = "0";
  }, 60);
}

function toast(message, color = "cyan") {
  dom.toast.textContent = message;
  dom.toast.style.color = color === "danger" ? "#ff506f" : "#64f5ff";
  dom.toast.style.borderColor = dom.toast.style.color;
  dom.toast.classList.add("show");
  state.toastTimer = 1.1;
}

function updateBounds() {
  const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
  view.halfHeight = WORLD_HEIGHT / 2;
  view.halfWidth = Math.max(view.halfHeight * aspect, 9.4);
  camera.left = -view.halfWidth;
  camera.right = view.halfWidth;
  camera.top = view.halfHeight;
  camera.bottom = -view.halfHeight;
  camera.updateProjectionMatrix();
}

function requestDash() {
  if (state.mode === "playing") input.dashBuffer = DASH_BUFFER_WINDOW;
}

function onKeyDown(event) {
  audio.unlock();
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
  input.keys.add(key);
  if (event.code === "Space") requestDash();
  if (state.mode === "upgrade" && /^[1-3]$/.test(key)) {
    const option = state.upgradeOptions[Number(key) - 1];
    if (option) chooseUpgrade(option.id);
  }
  if (key === "p" || event.key === "Escape") {
    if (state.mode === "playing") pauseGame();
    else if (state.mode === "paused") resumeGame();
  }
}

function onKeyUp(event) {
  input.keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key);
}

function setJoystickFromEvent(event) {
  const rect = dom.joystick.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const maxDistance = rect.width * 0.32;
  const vector = new THREE.Vector2(event.clientX - centerX, centerY - event.clientY);
  if (vector.length() > maxDistance) vector.setLength(maxDistance);
  input.touch.set(vector.x / maxDistance, vector.y / maxDistance);
  dom.joystickKnob.style.transform = `translate(calc(-50% + ${vector.x}px), calc(-50% - ${vector.y}px))`;
}

function resetJoystick() {
  input.joystickPointerId = null;
  input.touch.set(0, 0);
  dom.joystickKnob.style.transform = "translate(-50%, -50%)";
}

function setupInput() {
  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => {
    input.keys.clear();
    resetJoystick();
    if (state.mode === "playing") pauseGame();
  });
  dom.primaryButton.addEventListener("click", () => {
    audio.unlock();
    if (state.mode === "menu" || state.mode === "gameover" || state.mode === "victory") startGame();
    else if (state.mode === "paused") resumeGame();
  });
  dom.pauseButton.addEventListener("click", () => {
    audio.unlock();
    if (state.mode === "playing") pauseGame();
    else if (state.mode === "paused") resumeGame();
  });
  dom.muteButton.addEventListener("click", () => {
    audio.unlock();
    state.muted = !state.muted;
    audio.setMuted(state.muted);
    dom.muteButton.setAttribute("aria-pressed", String(state.muted));
    dom.muteButton.setAttribute("aria-label", state.muted ? "取消静音" : "静音");
    dom.muteButton.textContent = state.muted ? "×" : "♪";
  });
  dom.upgradeOptions.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-upgrade-id]");
    if (button) chooseUpgrade(button.dataset.upgradeId);
  });
  dom.dashButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    audio.unlock();
    requestDash();
  });
  dom.joystick.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    audio.unlock();
    input.joystickPointerId = event.pointerId;
    dom.joystick.setPointerCapture(event.pointerId);
    setJoystickFromEvent(event);
  });
  dom.joystick.addEventListener("pointermove", (event) => {
    if (event.pointerId === input.joystickPointerId) setJoystickFromEvent(event);
  });
  dom.joystick.addEventListener("pointerup", resetJoystick);
  dom.joystick.addEventListener("pointercancel", resetJoystick);
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  updateBounds();
}

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state.mode === "playing") {
    state.elapsed += dt;
    state.timeLeft = Math.max(0, GAME.duration - state.elapsed);
    state.dashTimer = Math.max(0, state.dashTimer - dt);
    state.hurtInvuln = Math.max(0, state.hurtInvuln - dt);
    input.dashBuffer = Math.max(0, input.dashBuffer - dt);
    state.dashCharges = state.dashCharges.map((charge) => Math.min(1, charge + dt / DASH_RECOVERY_TIME));
    state.comboTimer = Math.max(0, state.comboTimer - dt);
    if (state.comboTimer <= 0 && state.combo > 0) {
      state.combo = 0;
      dom.combo.classList.remove("show");
    }
    updateStage();
    if (state.mode === "playing") {
      updatePlayer(dt);
      updateShards(dt);
      updateEnemies(dt);
      if (state.mode === "playing") updateSpawning(dt);
      updateParticles(dt);
      updateRipples(dt);
      if (state.timeLeft <= 0) finishRun("gameover");
    }
  } else {
    updateParticles(dt);
    updateRipples(dt);
  }
  const intensity = THREE.MathUtils.clamp((enemies.length / GAME.maxEnemies) * 0.7 + (state.energy / GAME.overdriveEnergy) * 0.3, 0, 1);
  audio.update(state.elapsed, intensity, state.mode);
  updateVisuals(dt);
  renderer.render(scene, camera);
}

createBackground();
createPlayer();
createParticlePool();
setupInput();
updateBounds();
resetState();
renderMode("menu", null);
const clock = new THREE.Clock();
window.addEventListener("resize", resize);
renderer.setAnimationLoop(animate);
