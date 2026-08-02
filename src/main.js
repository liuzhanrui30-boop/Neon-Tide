import * as THREE from "three";
import "./style.css";
import NeonAudio from "./game/audio.js";
import {
  ENEMY_TYPES,
  GAME,
  STAGES,
  UPGRADES,
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
const HURT_INVULNERABILITY = 0.95;
const UPGRADE_GRACE_PERIOD = 0.8;
const MAX_MINES = 4;
const BOSS_DASH_DAMAGE = 5;
const BOSS_TELEGRAPH_TIME = 0.68;
const TRAUMA_DECAY = 1.35;
const MAX_TRAIL_NODES = Math.min(GAME.maxTrailNodes, 36);
const MAX_PARTICLES = Math.min(GAME.maxParticles, 220);
const MAX_ENEMIES = Math.min(GAME.maxEnemies, 24);
const STAGE_PALETTES = Object.freeze([
  { background: 0x030b18, grid: 0x124b63, fog: 0x0d5477, ring: 0x36e0ff, primary: 0x36e0ff, secondary: 0x6677ff },
  { background: 0x0b061b, grid: 0x49306c, fog: 0x4e1f75, ring: 0xa56bff, primary: 0xa56bff, secondary: 0xff4fd8 },
  { background: 0x15050f, grid: 0x6c244a, fog: 0x7b1f3a, ring: 0xff4fba, primary: 0xff4fba, secondary: 0xff9f43 },
  { background: 0x06131a, grid: 0x477a86, fog: 0x3b8996, ring: 0xe7ffff, primary: 0xe7ffff, secondary: 0x64f5ff },
]);
const FEEDBACK_TIERS = Object.freeze({
  small: { trauma: 0.13, slowScale: 1, slowDuration: 0, zoom: 0 },
  medium: { trauma: 0.38, slowScale: 0.72, slowDuration: 0.045, zoom: 0.018 },
  large: { trauma: 0.78, slowScale: 0.5, slowDuration: 0.1, zoom: 0.045 },
});
const BOSS_CORE_IDLE_COLOR = new THREE.Color(0xff506f);
const BOSS_CORE_HIT_COLOR = new THREE.Color(0xe7ffff);
const OVERDRIVE_MODIFIERS = Object.freeze({
  speed: 1.18,
  score: 1.5,
  pickupRadius: 1.55,
  dashRecovery: 1.4,
});
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
  missionObjective: document.querySelector("#mission-objective"),
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

dom.floatingLayer = document.createElement("div");
dom.floatingLayer.id = "floating-text-layer";
dom.floatingLayer.setAttribute("aria-hidden", "true");
dom.root.parentElement.appendChild(dom.floatingLayer);

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

const reducedMotionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;

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
  dashInvulnTimer: 0,
  dashSequence: 0,
  hurtInvuln: 0,
  overdriveTimer: 0,
  get playerAttacking() {
    return this.dashTimer > 0;
  },
  get dashInvulnerable() {
    return this.dashInvulnTimer > 0;
  },
  runFinished: false,
  trauma: 0,
  traumaClock: 0,
  slowMotionScale: 1,
  slowMotionTimer: 0,
  zoomPunch: 0,
  toastTimer: 0,
  stageBannerTimer: 0,
  upgradeTriggered: [false, false],
  bossTriggered: false,
  bossSpawned: false,
  bossDeadline: null,
  muted: false,
  ownedUpgrades: [],
  upgradeOptions: [],
  stats: {
    maxCombo: 0,
    nearMisses: 0,
    breaks: 0,
  },
  cameraLookAhead: new THREE.Vector2(),
  reducedMotion: reducedMotionPreference?.matches ?? false,
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
const trails = [];
const trailPool = [];
const floatingTexts = [];
const flowLines = [];

const scenery = {
  backdrop: null,
  grid: null,
  glow: null,
  boundary: null,
  decorMaterials: [],
};

const paletteState = {
  background: new THREE.Color(STAGE_PALETTES[0].background),
  grid: new THREE.Color(STAGE_PALETTES[0].grid),
  fog: new THREE.Color(STAGE_PALETTES[0].fog),
  ring: new THREE.Color(STAGE_PALETTES[0].ring),
  primary: new THREE.Color(STAGE_PALETTES[0].primary),
  secondary: new THREE.Color(STAGE_PALETTES[0].secondary),
  target: STAGE_PALETTES[0],
  targetColors: {
    background: new THREE.Color(STAGE_PALETTES[0].background),
    grid: new THREE.Color(STAGE_PALETTES[0].grid),
    fog: new THREE.Color(STAGE_PALETTES[0].fog),
    ring: new THREE.Color(STAGE_PALETTES[0].ring),
    primary: new THREE.Color(STAGE_PALETTES[0].primary),
    secondary: new THREE.Color(STAGE_PALETTES[0].secondary),
  },
};

const player = {
  group: null,
  body: null,
  glow: null,
  flame: null,
  shield: null,
  core: null,
  coreGlow: null,
  wings: [],
  trailTimer: 0,
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
  bossCoreGlowGeometry: new THREE.CircleGeometry(1.14, 36),
  bossOrbitNodeGeometry: new THREE.CircleGeometry(0.11, 12),
  mineRingGeometry: new THREE.RingGeometry(0.86, 0.94, 40),
  eliteOuterGeometry: new THREE.RingGeometry(0.76, 0.83, 32),
  eliteShieldGeometry: new THREE.RingGeometry(0.94, 1.0, 36),
  bossOuterGeometry: new THREE.RingGeometry(2.28, 2.42, 64),
  bossMiddleGeometry: new THREE.RingGeometry(1.62, 1.76, 56),
  bossInnerGeometry: new THREE.RingGeometry(1.12, 1.24, 48),
  bossHaloGeometry: new THREE.RingGeometry(2.72, 2.77, 72),
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
  bossHaloMaterial: new THREE.MeshBasicMaterial({
    color: 0xff7ae6,
    transparent: true,
    opacity: 0.34,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  bossCoreGlowMaterial: new THREE.MeshBasicMaterial({
    color: 0xff506f,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  bossOrbitCyanMaterial: new THREE.MeshBasicMaterial({ color: 0x64f5ff }),
  bossOrbitDangerMaterial: new THREE.MeshBasicMaterial({ color: 0xff506f }),
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

function createWingGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0.08, 0.25);
  shape.lineTo(0.7, -0.06);
  shape.lineTo(0.88, -0.38);
  shape.lineTo(0.3, -0.26);
  shape.lineTo(0.02, -0.08);
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
  scenery.backdrop = backdrop;

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
  scenery.grid = grid;

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
  scenery.glow = glow;

  for (let layer = 0; layer < 2; layer += 1) {
    for (let lineIndex = 0; lineIndex < 5; lineIndex += 1) {
      const points = [];
      const phase = lineIndex * 0.83 + layer * 1.7;
      for (let pointIndex = 0; pointIndex <= 48; pointIndex += 1) {
        const x = -18 + (pointIndex / 48) * 36;
        const y = Math.sin(pointIndex * 0.22 + phase) * (0.58 + layer * 0.22);
        points.push(new THREE.Vector3(x, y, 0));
      }
      const material = new THREE.LineBasicMaterial({
        color: layer === 0 ? 0x36e0ff : 0x6677ff,
        transparent: true,
        opacity: layer === 0 ? 0.075 : 0.12,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material);
      line.position.set((lineIndex - 2) * 6.8, -5.2 + lineIndex * 2.55 + layer * 0.7, -3.45 + layer * 0.08);
      line.rotation.z = layer === 0 ? -0.08 : 0.11;
      backgroundGroup.add(line);
      flowLines.push({ line, material, layer, phase, baseX: line.position.x, baseY: line.position.y });
    }
  }

  const boundaryPoints = [
    new THREE.Vector3(-9, -6.25, 0),
    new THREE.Vector3(9, -6.25, 0),
    new THREE.Vector3(9, 6.25, 0),
    new THREE.Vector3(-9, 6.25, 0),
  ];
  const boundary = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(boundaryPoints),
    new THREE.LineBasicMaterial({
      color: 0x36e0ff,
      transparent: true,
      opacity: 0.08,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  boundary.position.z = -3.25;
  backgroundGroup.add(boundary);
  scenery.boundary = boundary;

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
    scenery.decorMaterials.push(ring.material);
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

  const wingGeometry = createWingGeometry();
  const wingMaterial = new THREE.MeshBasicMaterial({ color: 0x4aaeff, transparent: true, opacity: 0.92 });
  const rightWing = new THREE.Mesh(wingGeometry, wingMaterial);
  const leftWing = new THREE.Mesh(wingGeometry, wingMaterial.clone());
  rightWing.position.set(0.13, -0.02, -0.01);
  leftWing.position.set(-0.13, -0.02, -0.01);
  leftWing.scale.x = -1;

  const coreGlow = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 20),
    new THREE.MeshBasicMaterial({
      color: 0x64f5ff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  coreGlow.position.set(0, 0.03, 0.05);
  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.095, 16),
    new THREE.MeshBasicMaterial({ color: 0xe7ffff })
  );
  core.position.set(0, 0.03, 0.07);

  group.add(glow, flame, leftWing, rightWing, body, outline, coreGlow, core, shield);
  world.add(group);

  player.group = group;
  player.body = body;
  player.glow = glow;
  player.flame = flame;
  player.shield = shield;
  player.core = core;
  player.coreGlow = coreGlow;
  player.wings = [leftWing, rightWing];
  player.position.set(0, -1.2);
  syncPlayerTransform();
}

function syncPlayerTransform() {
  player.group.position.x = player.position.x;
  player.group.position.y = player.position.y;
}

function createParticlePool(count = MAX_PARTICLES) {
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

function createTrailPool(count = MAX_TRAIL_NODES) {
  const bodyGeometry = createTriangleGeometry(0.58, 0.34, -0.38);
  const wingGeometry = createWingGeometry();
  for (let i = 0; i < count; i += 1) {
    const group = new THREE.Group();
    const makeMaterial = () => new THREE.MeshBasicMaterial({
      color: 0x64f5ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const body = new THREE.Mesh(bodyGeometry, makeMaterial());
    const rightWing = new THREE.Mesh(wingGeometry, makeMaterial());
    const leftWing = new THREE.Mesh(wingGeometry, makeMaterial());
    rightWing.position.set(0.13, -0.02, -0.01);
    leftWing.position.set(-0.13, -0.02, -0.01);
    leftWing.scale.x = -1;
    group.add(leftWing, rightWing, body);
    group.visible = false;
    group.position.z = 2.65;
    world.add(group);
    trailPool.push({ group, meshes: [body, leftWing, rightWing], life: 0, maxLife: 0 });
  }
}

function spawnTrail(force = false) {
  if (state.reducedMotion || state.mode !== "playing") return null;
  const speed = player.velocity.length();
  if (!force && speed < 2.2) return null;
  const node = trailPool.find((candidate) => !candidate.group.visible);
  if (!node || trails.length >= MAX_TRAIL_NODES) return null;
  node.life = node.maxLife = state.dashTimer > 0 ? 0.34 : 0.2;
  node.group.visible = true;
  node.group.position.set(player.position.x, player.position.y, 2.65);
  node.group.rotation.copy(player.group.rotation);
  node.group.scale.copy(player.group.scale);
  const dashMix = state.dashTimer > 0 ? 1 : 0.35;
  node.meshes.forEach((mesh, index) => {
    mesh.material.color.copy(index === 0 ? paletteState.primary : paletteState.secondary);
    mesh.material.opacity = (index === 0 ? 0.28 : 0.2) + dashMix * 0.16;
  });
  trails.push(node);
  return node;
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

function addTrauma(amount) {
  if (state.reducedMotion || !Number.isFinite(amount) || amount <= 0) return state.trauma;
  state.trauma = THREE.MathUtils.clamp(state.trauma + amount, 0, 1);
  return state.trauma;
}

function triggerSlowMotion(scale, duration) {
  if (state.reducedMotion) {
    state.slowMotionScale = 1;
    state.slowMotionTimer = 0;
    return false;
  }
  if (!Number.isFinite(scale) || !Number.isFinite(duration) || scale <= 0 || duration <= 0) return false;
  state.slowMotionScale = Math.min(state.slowMotionScale, THREE.MathUtils.clamp(scale, 0.25, 1));
  state.slowMotionTimer = Math.max(state.slowMotionTimer, duration);
  return true;
}

function applyReducedMotionPreference(matches) {
  state.reducedMotion = Boolean(matches);
  if (!state.reducedMotion) return;
  state.trauma = 0;
  state.slowMotionScale = 1;
  state.slowMotionTimer = 0;
  state.zoomPunch = 0;
  camera.zoom = 1;
  camera.rotation.z = 0;
  camera.updateProjectionMatrix();
  for (const trail of trails.splice(0)) {
    trail.group.visible = false;
    trail.meshes.forEach((mesh) => { mesh.material.opacity = 0; });
  }
}

function showFloatingText(text, position, tone = "cyan", tier = "small") {
  if (!text || !position) return null;
  if (floatingTexts.length >= 32) floatingTexts.shift().element.remove();
  const element = document.createElement("span");
  element.className = `floating-text ${tone} ${tier}`;
  element.textContent = text;
  dom.floatingLayer.appendChild(element);
  const item = {
    element,
    position: new THREE.Vector3(position.x, position.y, 4.8),
    life: tier === "large" ? 1.15 : tier === "medium" ? 0.9 : 0.7,
    maxLife: tier === "large" ? 1.15 : tier === "medium" ? 0.9 : 0.7,
    drift: Math.sin(state.elapsed * 17.3 + floatingTexts.length * 2.1) * 22,
  };
  floatingTexts.push(item);
  return item;
}

function showStageBanner(title, duration = 1.6, tone = "stage") {
  dom.stageBannerTitle.textContent = title;
  dom.stageBanner.dataset.tone = tone;
  dom.stageBanner.classList.remove("show");
  void dom.stageBanner.offsetWidth;
  dom.stageBanner.classList.add("show");
  state.stageBannerTimer = Math.max(0.4, duration);
}

function setPalette(stageIndex, immediate = false) {
  const palette = STAGE_PALETTES[THREE.MathUtils.clamp(stageIndex, 0, STAGE_PALETTES.length - 1)];
  paletteState.target = palette;
  Object.entries(paletteState.targetColors).forEach(([key, color]) => color.set(palette[key]));
  if (immediate) {
    paletteState.background.set(palette.background);
    paletteState.grid.set(palette.grid);
    paletteState.fog.set(palette.fog);
    paletteState.ring.set(palette.ring);
    paletteState.primary.set(palette.primary);
    paletteState.secondary.set(palette.secondary);
    applyPalette();
  }
  return palette;
}

function applyPalette() {
  scene.background.copy(paletteState.background);
  scenery.backdrop?.material.color.copy(paletteState.background);
  scenery.grid?.material.color.copy(paletteState.grid);
  scenery.glow?.material.color.copy(paletteState.fog);
  scenery.boundary?.material.color.copy(paletteState.ring);
  scenery.decorMaterials.forEach((material, index) => {
    material.color.copy(index % 2 ? paletteState.secondary : paletteState.ring);
  });
  flowLines.forEach(({ material, layer }) => {
    material.color.copy(layer === 0 ? paletteState.primary : paletteState.secondary);
  });
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--stage-primary", `#${paletteState.primary.getHexString()}`);
  rootStyle.setProperty("--stage-secondary", `#${paletteState.secondary.getHexString()}`);
}

function updatePalette(dt) {
  const blend = 1 - Math.exp(-2.6 * dt);
  paletteState.background.lerp(paletteState.targetColors.background, blend);
  paletteState.grid.lerp(paletteState.targetColors.grid, blend);
  paletteState.fog.lerp(paletteState.targetColors.fog, blend);
  paletteState.ring.lerp(paletteState.targetColors.ring, blend);
  paletteState.primary.lerp(paletteState.targetColors.primary, blend);
  paletteState.secondary.lerp(paletteState.targetColors.secondary, blend);
  applyPalette();
}

function triggerFeedback(tierName, options = {}) {
  const tier = FEEDBACK_TIERS[tierName] ?? FEEDBACK_TIERS.small;
  addTrauma(tier.trauma);
  if (tier.slowDuration > 0) triggerSlowMotion(tier.slowScale, tier.slowDuration);
  if (!state.reducedMotion) state.zoomPunch = Math.max(state.zoomPunch, tier.zoom);
  if (options.flashColor) flash(options.flashColor, options.flashOpacity ?? 0.1);
  if (options.position && options.color && options.particles) {
    spawnParticleBurst(options.position, options.color, options.particles, options.speed ?? 3.2, options.size ?? 1);
  }
  if (options.position && options.color && options.rippleScale) {
    spawnRipple(options.position, options.color, options.rippleScale);
  }
  if (options.text && options.position) {
    showFloatingText(options.text, options.position, options.tone ?? "cyan", tierName);
  }
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
  if (enemies.length >= MAX_ENEMIES) return null;
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
  shared.coreMaterial.color.copy(BOSS_CORE_IDLE_COLOR);
  shared.bossCoreGlowMaterial.opacity = 0.18;
  const haloRing = new THREE.Mesh(shared.bossHaloGeometry, shared.bossHaloMaterial);
  const core = new THREE.Mesh(shared.bossCoreGeometry, shared.coreMaterial);
  core.scale.set(1.15, 0.72, 1);
  const coreGlow = new THREE.Mesh(shared.bossCoreGlowGeometry, shared.bossCoreGlowMaterial);
  coreGlow.scale.set(1.22, 0.76, 1);
  const line = new THREE.Line(shared.telegraphLineGeometry, shared.telegraphMaterial);
  line.visible = false;
  const pulseRing = new THREE.Mesh(shared.bossPulseGeometry, shared.dangerRingMaterial);
  pulseRing.visible = false;
  const orbitNodes = new THREE.Group();
  for (let i = 0; i < 4; i += 1) {
    const node = new THREE.Mesh(
      shared.bossOrbitNodeGeometry,
      i % 2 ? shared.bossOrbitCyanMaterial : shared.bossOrbitDangerMaterial
    );
    const angle = (i / 4) * TAU;
    node.position.set(Math.cos(angle) * 2.72, Math.sin(angle) * 2.72, 0.04);
    orbitNodes.add(node);
  }
  group.add(line, pulseRing, haloRing, outerRing, middleRing, innerRing, orbitNodes, coreGlow, core);
  const enemy = registerEnemy("boss", new THREE.Vector2(0, view.halfHeight + 4.8), group, "enter", {
    stateTimer: 1.5,
    telegraph: 0,
    attackIndex: 0,
    attackKind: "charge",
    dashDirection: new THREE.Vector2(),
    dangerRadius: 0,
    previousDangerRadius: 0,
    pulseHit: false,
    hitReactTimer: 0,
    priority: 4,
    visuals: { haloRing, outerRing, middleRing, innerRing, orbitNodes, coreGlow, core, line, pulseRing },
  });
  if (enemy) state.bossSpawned = true;
  return enemy;
}

function spawnEnemy(type = null, position = null) {
  if (enemies.length >= MAX_ENEMIES) return null;
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
  for (const trail of trailPool) {
    trail.group.visible = false;
    trail.meshes.forEach((mesh) => { mesh.material.opacity = 0; });
  }
  trails.length = 0;
  floatingTexts.splice(0).forEach((item) => item.element.remove());
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
  state.dashInvulnTimer = 0;
  state.dashSequence = 0;
  state.hurtInvuln = 0;
  state.overdriveTimer = 0;
  state.runFinished = false;
  state.trauma = 0;
  state.traumaClock = 0;
  state.slowMotionScale = 1;
  state.slowMotionTimer = 0;
  state.zoomPunch = 0;
  state.stageBannerTimer = 0;
  state.upgradeTriggered = [false, false];
  state.bossTriggered = false;
  state.bossSpawned = false;
  state.bossDeadline = null;
  state.ownedUpgrades = [];
  state.upgradeOptions = [];
  state.stats.maxCombo = 0;
  state.stats.nearMisses = 0;
  state.stats.breaks = 0;
  dom.missionObjective.textContent = `坚持 ${STAGES[3].start} 秒，定位深潮主脑`;
  state.cameraLookAhead.set(0, 0);
  input.dashBuffer = 0;
  player.position.set(0, -1.2);
  player.velocity.set(0, 0);
  player.facing.set(0, 1);
  player.group.scale.set(1, 1, 1);
  player.group.rotation.z = 0;
  player.group.rotation.y = 0;
  player.shield.visible = false;
  player.trailTimer = 0;
  syncPlayerTransform();
  seedShards();
  audio.setStage(0);
  setPalette(0, true);
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
      `在失控的数字海域中收集光核，躲开追猎信号。<br />坚持 ${STAGES[3].start} 秒定位深潮主脑，并在 18 秒内将其摧毁。`,
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
      "船体已经失效，未能完成终幕目标：定位并摧毁深潮主脑。",
      "重新接入",
      true
    );
  } else if (mode === "victory") {
    showOverlay(
      "SIGNAL CLEAR // TIDE OUT",
      "TIDE<br /><em>OUT</em>",
      "终幕目标完成：深潮主脑已被摧毁，霓虹潮汐正在退去。",
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
    triggerFeedback("large", {
      position: player.position,
      color: 0x64f5ff,
      particles: 36,
      speed: 3.6,
      size: 1.5,
      rippleScale: 3.2,
      flashColor: "#64f5ff",
      flashOpacity: 0.28,
      text: "TIDE CLEARED",
      tone: "cyan",
    });
    audio.event("victory");
  } else {
    triggerFeedback("large", {
      position: player.position,
      color: 0xff506f,
      particles: 28,
      speed: 4.8,
      size: 1.4,
      rippleScale: 2.4,
      flashColor: "#ff506f",
      flashOpacity: 0.24,
      text: "SIGNAL LOST",
      tone: "danger",
    });
    audio.event("defeat");
  }
  return true;
}

function getDerivedValues() {
  const values = {
    speedMultiplier: 1,
    scoreMultiplier: 1,
    pickupRadiusMultiplier: 1,
    energyMultiplier: 1,
    dashRecoveryMultiplier: 1,
    dashInvulnerability: DASH_ACTIVE_WINDOW,
  };
  for (const id of state.ownedUpgrades) {
    const upgrade = UPGRADES.find((candidate) => candidate.id === id);
    if (!upgrade) continue;
    if (id === "ion-drive") values.speedMultiplier += upgrade.effect;
    if (id === "prism-core") values.scoreMultiplier += upgrade.effect;
    if (id === "echo-shield") values.dashInvulnerability += upgrade.effect;
    if (id === "magnet-field") values.pickupRadiusMultiplier += upgrade.effect;
    if (id === "overclock") values.energyMultiplier += upgrade.effect;
  }
  if (state.overdriveTimer > 0) {
    values.speedMultiplier *= OVERDRIVE_MODIFIERS.speed;
    values.scoreMultiplier *= OVERDRIVE_MODIFIERS.score;
    values.pickupRadiusMultiplier *= OVERDRIVE_MODIFIERS.pickupRadius;
    values.dashRecoveryMultiplier *= OVERDRIVE_MODIFIERS.dashRecovery;
  }
  return values;
}

function addEnergy(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return state.energy;
  state.energy = Math.min(GAME.overdriveEnergy, state.energy + amount);
  if (state.energy >= GAME.overdriveEnergy) triggerOverdrive();
  return state.energy;
}

function triggerOverdrive() {
  state.energy = 0;
  state.overdriveTimer = GAME.overdriveDuration;
  toast("潮汐超载", "cyan");
  triggerFeedback("large", {
    position: player.position,
    color: 0x64f5ff,
    particles: 30,
    speed: 4.2,
    size: 1.2,
    rippleScale: 2,
    flashColor: "#64f5ff",
    flashOpacity: 0.2,
    text: "OVERDRIVE",
    tone: "cyan",
  });
  audio.event("overdrive");
}

function advanceCombo(amount = 1) {
  state.combo += amount;
  state.comboTimer = 2.8;
  state.stats.maxCombo = Math.max(state.stats.maxCombo, state.combo);
  if (state.combo > 1) {
    dom.combo.innerHTML = `连击 ×<b>${state.combo}</b>`;
    dom.combo.classList.add("show");
  }
}

function clearCombo() {
  state.combo = 0;
  state.comboTimer = 0;
  dom.combo.classList.remove("show");
}

function awardReward(kind) {
  const derived = getDerivedValues();
  const reward = computeReward(kind, state.combo, 1);
  state.score += Math.round(reward.score * derived.scoreMultiplier);
  addEnergy(reward.energy * derived.energyMultiplier);
  advanceCombo(reward.combo);
  return reward;
}

function applyUpgrade(id) {
  const upgrade = UPGRADES.find((candidate) => candidate.id === id);
  if (!upgrade || state.ownedUpgrades.includes(id)) return false;
  state.ownedUpgrades.push(id);
  if (id === "repair-swarm") state.health = Math.min(MAX_HEALTH, state.health + upgrade.effect);
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
  if (!upgrade || !applyUpgrade(upgrade.id)) return;
  state.upgradeOptions = [];
  state.hurtInvuln = Math.max(state.hurtInvuln, UPGRADE_GRACE_PERIOD);
  audio.event("upgrade");
  if (transitionTo("playing", { upgraded: true })) {
    showStageBanner(STAGE_LABELS[state.stageIndex] ?? STAGES[state.stageIndex].name, 1.5, "stage");
  }
}

function updateHighScore() {
  state.highScore = Math.max(state.highScore, state.score);
  localStorage.setItem(STORAGE_KEY, String(state.highScore));
}

function updatePlayer(dt) {
  const direction = readMoveDirection();
  const derived = getDerivedValues();
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
    player.velocity.clampLength(0, BASE_MAX_SPEED * derived.speedMultiplier);
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
    player.flame.scale.setScalar(1);
    player.core.scale.setScalar(1);
    player.coreGlow.scale.setScalar(1);
  } else {
    const targetScale = state.dashTimer > 0 ? 1.22 : 1;
    player.group.scale.x = THREE.MathUtils.lerp(player.group.scale.x, targetScale, 1 - Math.exp(-22 * dt));
    player.group.scale.y = THREE.MathUtils.lerp(player.group.scale.y, state.dashTimer > 0 ? 0.82 : 1, 1 - Math.exp(-22 * dt));
    player.flame.scale.setScalar(flameScale + Math.sin(state.elapsed * 30) * 0.08);
    const corePulse = 1 + Math.sin(state.elapsed * (state.overdriveTimer > 0 ? 16 : 7)) * (state.overdriveTimer > 0 ? 0.16 : 0.08);
    player.core.scale.setScalar(corePulse);
    player.coreGlow.scale.setScalar(corePulse * (state.overdriveTimer > 0 ? 1.42 : 1.12));
  }
  player.flame.material.opacity = 0.48 + Math.min(speed / 5, 1) * 0.45;
  player.glow.material.opacity = state.overdriveTimer > 0 ? 0.36 : 0.18;
  player.coreGlow.material.opacity = state.overdriveTimer > 0 ? 0.42 : 0.22;
  player.wings.forEach((wing, index) => {
    wing.material.color.copy(index === 0 ? paletteState.secondary : paletteState.primary);
  });
  player.shield.visible = state.dashInvulnerable || state.hurtInvuln > 0;
  player.shield.material.opacity = state.reducedMotion ? 0.68 : 0.48 + Math.sin(state.elapsed * 24) * 0.2;
  player.trailTimer -= dt;
  const trailInterval = state.dashTimer > 0 ? 0.025 : 0.075;
  if (player.trailTimer <= 0 && (state.dashTimer > 0 || speed > 3.5)) {
    spawnTrail(state.dashTimer > 0);
    player.trailTimer = trailInterval;
  }
  syncPlayerTransform();
}

function attemptDash(direction) {
  if (state.mode !== "playing" || state.playerAttacking) return false;
  const chargeIndex = state.dashCharges.findIndex((charge) => charge >= 0.999);
  if (chargeIndex < 0) return false;
  const dashDirection = direction.lengthSq() > 0.01 ? direction.clone().normalize() : player.facing.clone().normalize();
  state.dashCharges[chargeIndex] = 0;
  state.dashTimer = DASH_ACTIVE_WINDOW;
  state.dashInvulnTimer = getDerivedValues().dashInvulnerability;
  state.dashSequence += 1;
  player.facing.copy(dashDirection);
  player.velocity.copy(dashDirection).multiplyScalar(DASH_SPEED * getDerivedValues().speedMultiplier);
  if (state.reducedMotion) player.group.scale.set(1, 1, 1);
  else player.group.scale.set(1.25, 0.78, 1);
  spawnTrail(true);
  spawnParticleBurst(player.position, 0x64f5ff, 10, 3.7, 0.85);
  spawnRipple(player.position, 0x64f5ff, 1.2);
  addTrauma(0.08);
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
  const pickupRadiusMultiplier = getDerivedValues().pickupRadiusMultiplier;
  for (const shard of shards) {
    shard.gem.rotation.z += dt * 1.8;
    shard.ring.rotation.z -= dt * 0.8;
    shard.group.position.y = shard.baseY + Math.sin(state.elapsed * 2.5 + shard.phase) * 0.12;
    const pulse = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 5 + shard.phase) * 0.09;
    shard.group.scale.setScalar(pulse);
  }

  for (let i = shards.length - 1; i >= 0; i -= 1) {
    const shard = shards[i];
    const dx = shard.group.position.x - player.position.x;
    const dy = shard.group.position.y - player.position.y;
    if (Math.hypot(dx, dy) < (player.radius + 0.3) * pickupRadiusMultiplier) {
      collectShard(i);
    }
  }
}

function collectShard(index) {
  const shard = shards[index];
  const position = new THREE.Vector2(shard.group.position.x, shard.group.position.y);
  removeShard(index);
  const previousScore = state.score;
  awardReward("pickup");
  triggerFeedback("small", {
    position,
    color: 0xffd166,
    particles: 5,
    speed: 3.2,
    size: 0.82,
    rippleScale: 0.82,
    text: `+${state.score - previousScore}`,
    tone: "gold",
  });
  audio.event("pickup", Math.min(1, state.combo / GAME.comboCap));
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
  const pulse = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 4 + enemy.wobble) * 0.08;
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
    const telegraphScale = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 32) * 0.12;
    enemy.visuals.body.scale.setScalar(telegraphScale);
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
    const pulse = state.reducedMotion
      ? 1.1
      : 0.9 + (1 - enemy.telegraph / 1.35) * 0.35 + Math.sin(state.elapsed * 22) * 0.05;
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
    const glowScale = state.reducedMotion ? 1.4 : 1.4 + progress * 1.2;
    enemy.visuals.glow.scale.setScalar(glowScale);
    if (enemy.stateTimer <= 0) enemy.dead = true;
  }
}

function updateElite(enemy, dt, toPlayer) {
  steerEnemy(enemy, toPlayer, dt, enemy.speed, 2.15, 0.08);
  enemy.visuals.shield.rotation.z += dt * 1.4;
  enemy.visuals.outer.rotation.z -= dt * 0.9;
  const shieldScale = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 5 + enemy.wobble) * 0.07;
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
    const availableSlots = Math.max(0, Math.min(2, MAX_ENEMIES - enemies.length));
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
  enemy.hitReactTimer = Math.max(0, enemy.hitReactTimer - dt);
  const ringMotion = state.reducedMotion ? 0 : 1;
  enemy.visuals.haloRing.rotation.z -= dt * 0.18 * ringMotion;
  enemy.visuals.outerRing.rotation.z += dt * 0.32 * ringMotion;
  enemy.visuals.middleRing.rotation.z -= dt * 0.58 * ringMotion;
  enemy.visuals.innerRing.rotation.z += dt * 0.9 * ringMotion;
  enemy.visuals.orbitNodes.rotation.z -= dt * 0.44 * ringMotion;
  const hitStrength = THREE.MathUtils.clamp(enemy.hitReactTimer / 0.18, 0, 1);
  enemy.visuals.core.material.color.lerpColors(BOSS_CORE_IDLE_COLOR, BOSS_CORE_HIT_COLOR, hitStrength);
  enemy.visuals.coreGlow.material.opacity = 0.18 + hitStrength * 0.48;
  if (state.reducedMotion) {
    enemy.visuals.core.scale.set(1.15, 0.72, 1);
    enemy.visuals.coreGlow.scale.set(1.22, 0.76, 1);
  } else {
    const corePulse = 1 + Math.sin(state.elapsed * 5) * 0.045 + hitStrength * 0.22;
    enemy.visuals.core.scale.set(1.15 * corePulse, 0.72 * corePulse, 1);
    enemy.visuals.coreGlow.scale.set(1.22 * corePulse, 0.76 * corePulse, 1);
  }
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
      const warningScale = state.reducedMotion
        ? 2.4
        : 1 + (1 - enemy.telegraph / BOSS_TELEGRAPH_TIME) * 2.1;
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
      const summonScale = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 18) * 0.18;
      enemy.visuals.pulseRing.scale.setScalar(summonScale);
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

function registerNearMiss(enemy) {
  if (enemy.nearMissed || enemy.type === "mine" || enemy.type === "boss") return;
  const toPlayer = player.position.clone().sub(enemy.group.position);
  const distance = Math.max(toPlayer.length(), 0.001);
  toPlayer.multiplyScalar(1 / distance);
  const collisionDistance = player.radius + enemy.radius;
  if (distance <= collisionDistance || distance >= collisionDistance + 0.62 || enemy.velocity.dot(toPlayer) <= 0) return;
  enemy.nearMissed = true;
  awardReward("nearMiss");
  state.stats.nearMisses += 1;
  audio.event("nearMiss");
}

function dashHitsEnemy(enemy, distance) {
  if (!state.playerAttacking || enemy.lastDashId === state.dashSequence) return false;
  const targetRadius = enemy.type === "boss" ? 0.95 : enemy.radius;
  return distance < player.radius + targetRadius;
}

function damageEnemy(enemy) {
  enemy.lastDashId = state.dashSequence;
  enemy.hp -= enemy.type === "boss" ? BOSS_DASH_DAMAGE : 1;
  const position = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
  if (enemy.hp <= 0) {
    destroyEnemy(enemy, "dash");
    return;
  }
  const away = position.clone().sub(player.position).normalize();
  enemy.velocity.addScaledVector(away, enemy.type === "elite" ? 2.4 : 1.2);
  enemy.hitReactTimer = 0.18;
  triggerFeedback("medium", {
    position,
    color: enemy.type === "boss" ? 0xe7ffff : 0xff506f,
    particles: enemy.type === "boss" ? 14 : 10,
    speed: 3.2,
    size: 0.9,
    rippleScale: enemy.type === "boss" ? 1.8 : 1.1,
    text: enemy.type === "boss" ? `-${BOSS_DASH_DAMAGE} STABILITY` : "ARMOR CRACK",
    tone: enemy.type === "boss" ? "cyan" : "danger",
  });
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
    if (dashHitsEnemy(enemy, distance)) damageEnemy(enemy);
  }

  for (let index = enemies.length - 1; index >= 0 && state.mode === "playing"; index -= 1) {
    const enemy = enemies[index];
    if (!enemy || enemy.dead) continue;
    const distance = Math.max(player.position.distanceTo(enemy.group.position), 0.001);
    registerNearMiss(enemy);
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

function destroyEnemy(enemy, source) {
  if (!enemy || enemy.dead) return false;
  const position = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
  enemy.dead = true;
  const index = enemies.indexOf(enemy);
  if (index >= 0) removeEnemy(index);
  if (source === "dash") {
    awardReward("break");
    state.stats.breaks += 1;
  }
  if (enemy.type !== "boss") {
    triggerFeedback("medium", {
      position,
      color: 0xff4fd8,
      particles: 16,
      speed: 4.5,
      size: 1.1,
      rippleScale: 1.5,
      text: "SIGNAL BREAK",
      tone: "magenta",
    });
  }
  audio.event("break");
  if (enemy.type === "boss") finishRun("victory");
  return true;
}

function damagePlayer(enemy) {
  state.health -= 1;
  state.hurtInvuln = HURT_INVULNERABILITY;
  clearCombo();
  player.velocity.multiplyScalar(-0.3);
  const hitPosition = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
  triggerFeedback("medium", {
    position: hitPosition,
    color: 0xff506f,
    particles: 18,
    speed: 4.2,
    size: 1.1,
    rippleScale: 1.5,
    flashColor: "#ff506f",
    flashOpacity: 0.13,
    text: "-1 HULL",
    tone: "danger",
  });
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
    const cappedBudget = Math.min(MAX_ENEMIES, spawnBudget);
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

function updateTrails(dt) {
  for (let i = trails.length - 1; i >= 0; i -= 1) {
    const trail = trails[i];
    trail.life -= dt;
    const ratio = Math.max(0, trail.life / trail.maxLife);
    trail.meshes.forEach((mesh, index) => {
      mesh.material.opacity = ratio * (index === 0 ? 0.42 : 0.28);
    });
    trail.group.scale.multiplyScalar(1 + dt * 0.45);
    if (trail.life <= 0) {
      trail.group.visible = false;
      trail.meshes.forEach((mesh) => { mesh.material.opacity = 0; });
      trails.splice(i, 1);
    }
  }
}

function updateFloatingTexts(dt) {
  camera.updateMatrixWorld();
  for (let i = floatingTexts.length - 1; i >= 0; i -= 1) {
    const item = floatingTexts[i];
    item.life -= dt;
    const progress = 1 - Math.max(0, item.life / item.maxLife);
    const projected = item.position.clone().project(camera);
    const x = (projected.x * 0.5 + 0.5) * window.innerWidth;
    const baseY = (-projected.y * 0.5 + 0.5) * window.innerHeight;
    const driftY = state.reducedMotion ? 0 : progress * 58;
    const driftX = state.reducedMotion ? 0 : Math.sin(progress * Math.PI) * item.drift;
    item.element.style.left = `${x + driftX}px`;
    item.element.style.top = `${baseY - driftY}px`;
    item.element.style.opacity = String(Math.sin(Math.min(1, progress) * Math.PI));
    item.element.style.setProperty("--float-scale", state.reducedMotion ? "1" : String(0.82 + Math.sin(progress * Math.PI) * 0.28));
    if (item.life <= 0) {
      item.element.remove();
      floatingTexts.splice(i, 1);
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

function sampleShakeAxis(seed, time) {
  return Math.sin(time * 17 + seed) * 0.62 + Math.sin(time * 29 + seed * 2.3) * 0.38;
}

function updateVisuals(dt) {
  updatePalette(dt);
  const visualSpeed = state.reducedMotion ? 0 : 1;
  decorGroup.rotation.z += dt * 0.004 * visualSpeed;
  starsGroup.rotation.z -= dt * 0.0015 * visualSpeed;
  const decorPulse = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 0.55) * 0.008;
  decorGroup.scale.setScalar(decorPulse);
  backgroundGroup.position.x = state.reducedMotion ? 0 : Math.sin(state.elapsed * 0.19) * 0.12;
  backgroundGroup.position.y = state.reducedMotion ? 0 : Math.cos(state.elapsed * 0.16) * 0.08;
  for (const flow of flowLines) {
    const speed = flow.layer === 0 ? 0.72 : -0.46;
    flow.line.position.x = state.reducedMotion
      ? flow.baseX
      : flow.baseX + Math.sin(state.elapsed * speed + flow.phase) * (flow.layer === 0 ? 2.2 : 3.1);
    flow.line.position.y = flow.baseY + (state.reducedMotion ? 0 : Math.sin(state.elapsed * 0.34 + flow.phase) * 0.22);
    flow.material.opacity = (flow.layer === 0 ? 0.065 : 0.105)
      + (state.reducedMotion ? 0 : Math.sin(state.elapsed * 0.8 + flow.phase) * 0.018);
  }
  if (scenery.boundary) {
    scenery.boundary.material.opacity = state.reducedMotion
      ? 0.13
      : 0.08 + (Math.sin(state.elapsed * 2.1) * 0.5 + 0.5) * 0.09;
  }
  const lookAheadTarget = player.position.clone().multiplyScalar(0.035).addScaledVector(player.velocity, 0.11);
  lookAheadTarget.clampLength(0, state.reducedMotion ? 0 : 0.72);
  state.cameraLookAhead.lerp(lookAheadTarget, 1 - Math.exp(-5.5 * dt));
  state.traumaClock += dt;
  state.trauma = state.reducedMotion ? 0 : Math.max(0, state.trauma - TRAUMA_DECAY * dt);
  const shakeAmount = state.reducedMotion ? 0 : state.trauma * state.trauma;
  const shakeX = sampleShakeAxis(1.7, state.traumaClock) * 0.22 * shakeAmount;
  const shakeY = sampleShakeAxis(4.1, state.traumaClock) * 0.15 * shakeAmount;
  camera.position.x = state.cameraLookAhead.x + shakeX;
  camera.position.y = state.cameraLookAhead.y + shakeY;
  camera.position.z = 20;
  const cameraBank = state.reducedMotion
    ? 0
    : THREE.MathUtils.clamp(-player.velocity.x * 0.0025, -0.012, 0.012)
      + sampleShakeAxis(7.3, state.traumaClock) * 0.012 * shakeAmount;
  camera.rotation.z = THREE.MathUtils.lerp(camera.rotation.z, cameraBank, 1 - Math.exp(-4 * dt));
  state.zoomPunch = state.reducedMotion ? 0 : Math.max(0, state.zoomPunch - dt * 0.42);
  const targetZoom = state.reducedMotion ? 1 : 1 + state.zoomPunch;
  camera.zoom = THREE.MathUtils.lerp(camera.zoom, targetZoom, 1 - Math.exp(-14 * dt));
  camera.updateProjectionMatrix();
  updateFloatingTexts(dt);
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
  const overdriveActive = state.overdriveTimer > 0;
  dom.overdriveLabel.classList.toggle("active", overdriveActive);
  dom.overdriveLabel.textContent = overdriveActive
    ? `OVERDRIVE // ${state.overdriveTimer.toFixed(1)}S`
    : "OVERDRIVE // 待机";
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
  const stageEnd = state.stageIndex === 3 && state.bossDeadline !== null
    ? state.bossDeadline
    : Number.isFinite(stage.end) ? stage.end : GAME.duration;
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
  setPalette(nextStageIndex);
  const bannerTitle = nextStageIndex === 3
    ? "终幕 · 潮汐守卫"
    : STAGE_LABELS[nextStageIndex] ?? STAGES[nextStageIndex].name;
  showStageBanner(bannerTitle, nextStageIndex === 3 ? 2.2 : 1.6, nextStageIndex === 3 ? "boss" : "stage");
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
  state.bossDeadline = state.elapsed + 18;
  state.timeLeft = 18;
  state.enemySpawnTimer = Infinity;
  dom.missionObjective.textContent = "在 18 秒内摧毁深潮主脑";
  toast("潮汐守卫已锁定", "danger");
  const entrancePosition = new THREE.Vector2(0, view.halfHeight - 0.6);
  triggerFeedback("large", {
    position: entrancePosition,
    color: 0xe7ffff,
    particles: 30,
    speed: 4.2,
    size: 1.25,
    rippleScale: 2.2,
    flashColor: "#e7ffff",
    flashOpacity: 0.16,
    text: "TIDAL GUARDIAN",
    tone: "cyan",
  });
  createBoss();
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
  if (scenery.boundary) scenery.boundary.scale.set(view.halfWidth / 9, view.halfHeight / 6.25, 1);
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
  const realDt = Math.min(clock.getDelta(), 0.05);
  const simulationScale = state.reducedMotion || state.slowMotionTimer <= 0 ? 1 : state.slowMotionScale;
  const dt = realDt * simulationScale;
  if (state.slowMotionTimer > 0) {
    state.slowMotionTimer = Math.max(0, state.slowMotionTimer - realDt);
    if (state.slowMotionTimer <= 0) state.slowMotionScale = 1;
  }
  if (state.mode === "playing") {
    state.elapsed += realDt;
    const runDeadline = state.bossDeadline ?? GAME.duration;
    state.timeLeft = Math.max(0, runDeadline - state.elapsed);
    state.dashTimer = Math.max(0, state.dashTimer - dt);
    state.dashInvulnTimer = Math.max(0, state.dashInvulnTimer - dt);
    state.hurtInvuln = Math.max(0, state.hurtInvuln - dt);
    state.overdriveTimer = Math.max(0, state.overdriveTimer - dt);
    input.dashBuffer = Math.max(0, input.dashBuffer - dt);
    const dashRecoveryMultiplier = getDerivedValues().dashRecoveryMultiplier;
    state.dashCharges = state.dashCharges.map((charge) => Math.min(1, charge + (dt * dashRecoveryMultiplier) / DASH_RECOVERY_TIME));
    state.comboTimer = Math.max(0, state.comboTimer - dt);
    if (state.comboTimer <= 0 && state.combo > 0) {
      clearCombo();
    }
    updateStage();
    if (state.mode === "playing" && state.timeLeft <= 0) finishRun("gameover");
    if (state.mode === "playing") {
      updatePlayer(dt);
      updateShards(dt);
      updateEnemies(dt);
      if (state.mode === "playing") updateSpawning(dt);
      updateParticles(dt);
      updateRipples(dt);
      updateTrails(dt);
    }
  } else {
    updateParticles(realDt);
    updateRipples(realDt);
    updateTrails(realDt);
  }
  const energyIntensity = state.overdriveTimer > 0 ? 1 : state.energy / GAME.overdriveEnergy;
  const intensity = THREE.MathUtils.clamp((enemies.length / MAX_ENEMIES) * 0.7 + energyIntensity * 0.3, 0, 1);
  audio.update(state.elapsed, intensity, state.mode);
  updateVisuals(realDt);
  renderer.render(scene, camera);
}

createBackground();
createPlayer();
createParticlePool();
createTrailPool();
setupInput();
updateBounds();
resetState();
renderMode("menu", null);
const clock = new THREE.Clock();
window.addEventListener("resize", resize);
reducedMotionPreference?.addEventListener?.("change", (event) => applyReducedMotionPreference(event.matches));
renderer.setAnimationLoop(animate);
