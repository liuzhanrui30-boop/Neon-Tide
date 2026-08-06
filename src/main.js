import * as THREE from "three";
import "./style.css";
import NeonAudio, { createLaserAudioEvents } from "./game/audio.js";
import {
  ENEMY_TYPES,
  GAME,
  STAGES,
  UPGRADES,
  computeFrameDeltas,
  computeRank,
  computeReward,
  computeSpawnBudget,
  capActiveCount,
  beamHitsCircle,
  clampFinite,
  finiteOr,
  getMineDetonationFrame,
  projectileHitsCircle,
  pickUpgradeOptions,
} from "./game/gameplay.js";
import { COMBAT, FORMATION_TEMPLATES } from "./game/config.js";
import {
  getCurrentForce,
  getDataLanePenalty,
  getEnvironmentDelay,
  getEnvironmentFrame,
  getGravityForce,
} from "./game/environment.js";
import {
  LASER_RULES,
  gainWeaponEnergy,
  canFireLaser,
  getLaserPhase,
  laserHitsCircle,
  selectLaserTargets,
} from "./game/skill.js";
import { REALMS } from "./game/realms.js";
import {
  chooseFormation,
  getActiveEnemyCap,
  getFormationBudget,
  getFormationSlots,
  getPressureTarget,
  getSpawnBurstLimit,
  getSpawnInterval,
  getStageIndex,
} from "./game/director.js";
import { createPostProcessing, selectRenderQuality } from "./game/render-quality.js";
import { createRealmBackgrounds } from "./game/realm-backgrounds.js";

const TAU = Math.PI * 2;
const WORLD_HEIGHT = 14;
const STORAGE_KEY = "neon-tide-high-score";
const BASE_MAX_HEALTH = 3;
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
const MAX_MINES = 8;
const BOSS_DASH_DAMAGE = 5;
const BOSS_TELEGRAPH_TIME = 0.68;
const TRAUMA_DECAY = 1.35;
const PLAYER_VISUAL_SCALE = 0.88;
const MAX_TRAIL_NODES = GAME.maxTrailNodes;
const MAX_PARTICLES = GAME.maxParticles;
const MAX_RIPPLES = 64;
const MAX_FLOATING_TEXTS = 24;
const PROJECTILE_POOL_SIZE = COMBAT.projectilePoolSize;
const MAX_ENVIRONMENT_STEPS_PER_FRAME = 64;
const enemyScratch = {
  toPlayer: new THREE.Vector2(),
  nearMissDirection: new THREE.Vector2(),
  steering: new THREE.Vector2(),
  perpendicular: new THREE.Vector2(),
  target: new THREE.Vector2(),
};

function getEnemyCap() {
  return getActiveEnemyCap({
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    viewportWidth: window.innerWidth,
  });
}
const STAGE_PALETTES = Object.freeze([
  { background: 0x030b18, grid: 0x124b63, fog: 0x0d5477, ring: 0x36e0ff, primary: 0x36e0ff, secondary: 0x6677ff },
  { background: 0x0b061b, grid: 0x49306c, fog: 0x4e1f75, ring: 0xa56bff, primary: 0xa56bff, secondary: 0xff4fd8 },
  { background: 0x15050f, grid: 0x6c244a, fog: 0x7b1f3a, ring: 0xff4fba, primary: 0xff4fba, secondary: 0xff9f43 },
  { background: 0x06131a, grid: 0x477a86, fog: 0x3b8996, ring: 0xe7ffff, primary: 0xe7ffff, secondary: 0x64f5ff },
]);
const FEEDBACK_TIERS = Object.freeze({
  small: { trauma: 0.13, slowScale: 1, slowDuration: 0, zoom: 0 },
  nearMiss: { trauma: 0.18, slowScale: 0.72, slowDuration: 0.1, zoom: 0.012 },
  medium: { trauma: 0.38, slowScale: 0.72, slowDuration: 0.045, zoom: 0.018 },
  large: { trauma: 0.78, slowScale: 0.5, slowDuration: 0.1, zoom: 0.045 },
});
const BOSS_CORE_IDLE_COLOR = new THREE.Color(0xff506f);
const BOSS_CORE_HIT_COLOR = new THREE.Color(0xe7ffff);
const PLAYER_CORE_IDLE_COLOR = new THREE.Color(0xe7ffff);
const PLAYER_CORE_HIT_COLOR = new THREE.Color(0xffffff);
const REALM_PRESENTATION = Object.freeze([
  { title: "第一境 · 深渊潮界", environment: "ABYSS // 沟壑水母与焦散暗流" },
  { title: "第二境 · 数据都市", environment: "DATA CITY // 透视车道与封包天际线" },
  { title: "第三境 · 星铸熔炉", environment: "STAR FORGE // 日冕裂隙与灼热碎片" },
  { title: "终境 · 虚空圣堂", environment: "VOID CATHEDRAL // 八角棱镜与逆流光束" },
]);
const STAGE_LABELS = REALM_PRESENTATION.map((realm) => realm.title);
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
  timeLabel: document.querySelector(".time-card > span"),
  time: document.querySelector("#time-value"),
  health: document.querySelector("#health-pips"),
  weaponEnergy: document.querySelector("#weapon-energy-value"),
  weaponEnergyFill: document.querySelector("#weapon-energy-fill"),
  laserStatus: document.querySelector("#laser-status"),
  stageName: document.querySelector("#stage-name"),
  stageProgress: document.querySelector("#stage-progress"),
  stageTrack: document.querySelector(".stage-track"),
  formationLabel: document.querySelector("#formation-label"),
  stageBanner: document.querySelector("#stage-banner"),
  stageBannerLabel: document.querySelector("#stage-banner span"),
  stageBannerTitle: document.querySelector("#stage-banner strong"),
  dashPips: Array.from(document.querySelectorAll("#dash-pips i")),
  muteButton: document.querySelector("#mute-button"),
  pauseButton: document.querySelector("#pause-button"),
  hud: document.querySelector("#hud"),
  missionPanel: document.querySelector("#mission-panel"),
  missionObjective: document.querySelector("#mission-objective"),
  bossPanel: document.querySelector("#boss-panel"),
  bossTrack: document.querySelector(".boss-track"),
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
  laserButton: document.querySelector("#laser-button"),
  journeyStrip: document.querySelector("#journey-strip"),
};

dom.floatingLayer = document.createElement("div");
dom.floatingLayer.id = "floating-text-layer";
dom.floatingLayer.setAttribute("aria-hidden", "true");
dom.root.parentElement.appendChild(dom.floatingLayer);

dom.healthPips = [];

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050816);

const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 100);
camera.position.set(0, 0, 20);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
let renderQuality = null;
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.domElement.tabIndex = -1;
renderer.domElement.setAttribute("aria-label", "Neon Tide 游戏画布");
dom.root.appendChild(renderer.domElement);
let postProcessing = null;

const world = new THREE.Group();
scene.add(world);

const view = {
  halfWidth: 10,
  halfHeight: WORLD_HEIGHT / 2,
};

const reducedMotionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
renderQuality = selectRenderQuality({
  coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
  reducedMotion: reducedMotionPreference?.matches ?? false,
  viewportWidth: window.innerWidth,
  devicePixelRatio: window.devicePixelRatio || 1,
});
renderer.setPixelRatio(renderQuality.pixelRatio);
document.documentElement.dataset.renderQuality = renderQuality.tier;

const realmBackgrounds = createRealmBackgrounds({
  scene,
  quality: renderQuality,
  width: window.innerWidth,
  height: window.innerHeight,
});

const state = {
  mode: "menu",
  elapsed: 0,
  timeLeft: GAME.bossStart,
  score: 0,
  highScore: Number.parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10),
  health: BASE_MAX_HEALTH,
  maxHealth: BASE_MAX_HEALTH,
  weaponEnergy: 0,
  laserState: "idle",
  laserElapsed: 0,
  laserSequence: 0,
  laserSequenceTargets: 0,
  laserDirection: new THREE.Vector2(0, 1),
  combo: 0,
  comboTimer: 0,
  stageIndex: 0,
  spawnSequence: 0,
  enemySpawnTimer: 1.1,
  formationTimer: 4.8,
  environmentTimer: Infinity,
  environmentElapsed: 0,
  environmentSeed: 0x4e544944,
  environmentSequence: 0,
  environmentActive: false,
  combatFrame: 0,
  lastFormation: null,
  lastFormationAt: -Infinity,
  shardSpawnTimer: 1.8,
  dashCharges: [1, 1],
  dashTimer: 0,
  dashInvulnTimer: 0,
  dashSequence: 0,
  hurtInvuln: 0,
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
  stageQueue: [],
  upgradeTriggered: [false, false],
  bossTriggered: false,
  bossSpawned: false,
  bossStart: null,
  bossDeadline: null,
  terminalReason: null,
  muted: false,
  ownedUpgrades: [],
  upgradeOptions: [],
  stats: {
    maxCombo: 0,
    nearMisses: 0,
    breaks: 0,
    enemyPeak: 0,
    formationCount: 0,
    formationLog: [],
    roles: {},
    beamPeak: 0,
    activeHazards: 0,
    chainBreaks: 0,
    activeCleanupCount: 0,
    bossPhase: 1,
    bossAttackLog: [],
    bossAttackTelegraphs: [],
    laserShots: 0,
    laserHits: 0,
    laserInterrupts: 0,
    laserPeakTargets: 0,
    projectilePeak: 0,
    environmentEvents: 0,
    environmentActiveFrames: 0,
    realmAttackRoles: {},
  },
  cameraLookAhead: new THREE.Vector2(),
  reducedMotion: reducedMotionPreference?.matches ?? false,
};

const input = {
  keys: new Set(),
  dashBuffer: 0,
  laserBuffer: 0,
  touch: new THREE.Vector2(),
  joystickPointerId: null,
};

const audio = new NeonAudio();
const laserAudio = createLaserAudioEvents(audio, {
  maxEnergy: LASER_RULES.maxEnergy,
  maxTargets: LASER_RULES.maxTargets,
});
let activeDialog = null;
let restoreFocusTarget = null;
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const shards = [];
const enemies = [];
const projectiles = [];
const particles = [];
const particlePool = [];
const ripples = [];
const trails = [];
const trailPool = [];
const floatingTexts = [];
const inputListeners = [];
let inputBound = false;
const runtimeStats = {
  inputSetupCount: 0,
  composerRefreshCount: 0,
  composerDisposeCount: 0,
  finiteGuards: 0,
  orphanGuards: 0,
};

const paletteState = {
  background: new THREE.Color(STAGE_PALETTES[0].background),
  primary: new THREE.Color(STAGE_PALETTES[0].primary),
  secondary: new THREE.Color(STAGE_PALETTES[0].secondary),
  target: STAGE_PALETTES[0],
  targetColors: {
    background: new THREE.Color(STAGE_PALETTES[0].background),
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
  flameSegments: [],
  hitReactTimer: 0,
  wings: [],
  trailTimer: 0,
  laser: null,
  position: new THREE.Vector2(0, -1.2),
  velocity: new THREE.Vector2(),
  facing: new THREE.Vector2(0, 1),
  radius: 0.37,
};

const shared = {
  shardGeometry: new THREE.OctahedronGeometry(0.24, 0),
  shardMaterial: new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true }),
  shardRingGeometry: new THREE.RingGeometry(0.31, 0.325, 24),
  shardRingMaterial: new THREE.MeshBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
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
  mineTickGeometry: new THREE.RingGeometry(1.12, 1.16, 32),
  lancerDiamondGeometry: new THREE.PlaneGeometry(0.62, 0.62),
  lancerReticleGeometry: new THREE.RingGeometry(0.3, 0.335, 4),
  strikerStabilizerGeometry: new THREE.PlaneGeometry(0.52, 0.055),
  eliteOuterGeometry: new THREE.RingGeometry(0.76, 0.83, 32),
  eliteShockGeometry: new THREE.RingGeometry(0.72, 0.88, 40),
  swarmWingGeometry: null,
  eliteShieldGeometry: new THREE.RingGeometry(0.94, 1.0, 36),
  bossOuterGeometry: new THREE.RingGeometry(2.28, 2.42, 64),
  bossMiddleGeometry: new THREE.RingGeometry(1.62, 1.76, 56),
  bossInnerGeometry: new THREE.RingGeometry(1.12, 1.24, 48),
  bossHaloGeometry: new THREE.RingGeometry(2.72, 2.77, 72),
  bossPulseGeometry: new THREE.RingGeometry(0.94, 1.02, 52),
  bossTriangleGeometry: null,
  beamGeometry: new THREE.PlaneGeometry(1, 18).translate(0, 9, 0),
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
  lancerTelegraphMaterial: new THREE.LineBasicMaterial({
    color: 0xff9f43, transparent: true, opacity: 0.64, depthWrite: false, blending: THREE.AdditiveBlending,
  }),
  lancerBeamMaterial: new THREE.LineBasicMaterial({
    color: 0xff506f, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending,
  }),
  lancerMaterial: new THREE.MeshBasicMaterial({ color: 0xffd166 }),
  hunterTrailMaterial: new THREE.LineBasicMaterial({
    color: 0xff7ae6, transparent: true, opacity: 0.76, depthWrite: false, blending: THREE.AdditiveBlending,
  }),
  swarmMaterial: new THREE.MeshBasicMaterial({ color: 0x9af6ff }),
  swarmGlowMaterial: new THREE.MeshBasicMaterial({
    color: 0x36e0ff, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending,
  }),
  dangerRingMaterial: new THREE.MeshBasicMaterial({
    color: 0xff9f43,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
  projectileCircleGeometry: new THREE.CircleGeometry(0.16, 10),
  projectileDiamondGeometry: new THREE.PlaneGeometry(0.3, 0.3),
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

function createTrianglePulseGeometry() {
  const shape = new THREE.Shape();
  const halfAngle = Math.PI / 6;
  shape.moveTo(0, 0);
  shape.lineTo(Math.cos(Math.PI / 2 - halfAngle) * 1.02, Math.sin(Math.PI / 2 - halfAngle) * 1.02);
  shape.lineTo(Math.cos(Math.PI / 2 + halfAngle) * 1.02, Math.sin(Math.PI / 2 + halfAngle) * 1.02);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

shared.enemyGeometry = createTriangleGeometry(0.43, 0.31, -0.3);
shared.strikerGeometry = createTriangleGeometry(0.72, 0.2, -0.58);
shared.swarmWingGeometry = createWingGeometry();
shared.bossTriangleGeometry = createTrianglePulseGeometry();

let environmentFrame = getEnvironmentFrame(REALMS[0].id, 999);

function makeEnvironmentMaterial(color, opacity = 0.35) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function createEnvironmentVisuals() {
  const currentGroup = new THREE.Group();
  const currentGeometry = new THREE.PlaneGeometry(24, 2.4);
  const currentMaterial = makeEnvironmentMaterial(0x36e0ff, 0.18);
  const currentBand = new THREE.Mesh(currentGeometry, currentMaterial);
  const arrowPoints = [];
  for (let x = -10; x <= 10; x += 2.5) {
    arrowPoints.push(
      new THREE.Vector3(x - 0.55, 0, 0), new THREE.Vector3(x + 0.55, 0, 0),
      new THREE.Vector3(x + 0.55, 0, 0), new THREE.Vector3(x + 0.22, 0.25, 0),
      new THREE.Vector3(x + 0.55, 0, 0), new THREE.Vector3(x + 0.22, -0.25, 0),
    );
  }
  const arrowGeometry = new THREE.BufferGeometry().setFromPoints(arrowPoints);
  const arrowMaterial = new THREE.LineBasicMaterial({ color: 0xe7ffff, transparent: true, opacity: 0.72, depthWrite: false });
  const arrows = new THREE.LineSegments(arrowGeometry, arrowMaterial);
  arrows.position.z = 0.02;
  currentGroup.add(currentBand, arrows);

  const dataGroup = new THREE.Group();
  const dataGeometry = new THREE.PlaneGeometry(24, 2);
  const dataMaterial = makeEnvironmentMaterial(0xa56bff, 0.2);
  const dataBand = new THREE.Mesh(dataGeometry, dataMaterial);
  const gridPoints = [];
  for (let x = -12; x <= 12; x += 1.2) gridPoints.push(new THREE.Vector3(x, -1, 0), new THREE.Vector3(x, 1, 0));
  for (let y = -1; y <= 1; y += 0.5) gridPoints.push(new THREE.Vector3(-12, y, 0), new THREE.Vector3(12, y, 0));
  const gridGeometry = new THREE.BufferGeometry().setFromPoints(gridPoints);
  const gridMaterial = new THREE.LineBasicMaterial({ color: 0xff4fd8, transparent: true, opacity: 0.62, depthWrite: false });
  const grid = new THREE.LineSegments(gridGeometry, gridMaterial);
  grid.position.z = 0.02;
  dataGroup.add(dataBand, grid);

  const gravityGroup = new THREE.Group();
  const gravityMaterials = [
    makeEnvironmentMaterial(0xff9f43, 0.55),
    makeEnvironmentMaterial(0xff4fba, 0.42),
    makeEnvironmentMaterial(0xe7ffff, 0.3),
  ];
  const gravityGeometries = [
    new THREE.RingGeometry(0.7, 0.82, 48),
    new THREE.RingGeometry(1.35, 1.45, 56),
    new THREE.RingGeometry(2.1, 2.18, 64),
  ];
  gravityGeometries.forEach((geometry, index) => gravityGroup.add(new THREE.Mesh(geometry, gravityMaterials[index])));

  const visuals = {
    current: { group: currentGroup, meshes: [currentBand, arrows], geometries: [currentGeometry, arrowGeometry], materials: [currentMaterial, arrowMaterial] },
    dataLane: { group: dataGroup, meshes: [dataBand, grid], geometries: [dataGeometry, gridGeometry], materials: [dataMaterial, gridMaterial] },
    gravity: { group: gravityGroup, meshes: [...gravityGroup.children], geometries: gravityGeometries, materials: gravityMaterials },
  };
  for (const visual of Object.values(visuals)) {
    visual.group.visible = false;
    visual.group.position.z = 1.1;
    world.add(visual.group);
  }
  return visuals;
}

const environmentVisual = createEnvironmentVisuals();

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

  const flameSegments = [
    { width: 0.1, length: 0.28, color: 0xfff4b3, x: 0, z: 0.08 },
    { width: 0.16, length: 0.42, color: 0xffd166, x: 0, z: 0.06 },
    { width: 0.23, length: 0.58, color: 0xff7a45, x: 0, z: 0.04 },
  ].map(({ width, length, color, x, z }, index) => {
    const segment = new THREE.Mesh(
      createTriangleGeometry(0.02, width, -length),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.72 - index * 0.12, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    segment.position.set(x, -0.45, z);
    return segment;
  });

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

  const laserGeometry = new THREE.PlaneGeometry(1, 1);
  laserGeometry.translate(0.5, 0, 0);
  const laserHaloMaterial = new THREE.MeshBasicMaterial({
    color: STAGE_PALETTES[0].primary,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const laserCoreMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const laserHalo = new THREE.Mesh(laserGeometry, laserHaloMaterial);
  const laserCore = new THREE.Mesh(laserGeometry, laserCoreMaterial);
  laserCore.position.z = 0.03;
  laserCore.scale.y = 0.28;
  const laserGroup = new THREE.Group();
  laserGroup.position.z = 3.35;
  laserGroup.visible = false;
  laserGroup.add(laserHalo, laserCore);
  world.add(laserGroup);

  group.add(glow, flameSegments[2], flameSegments[1], flameSegments[0], flame, leftWing, rightWing, body, outline, coreGlow, core, shield);
  world.add(group);

  player.group = group;
  player.body = body;
  player.glow = glow;
  player.flame = flame;
  player.shield = shield;
  player.core = core;
  player.coreGlow = coreGlow;
  player.flameSegments = flameSegments;
  player.wings = [leftWing, rightWing];
  player.laser = {
    group: laserGroup,
    halo: laserHalo,
    core: laserCore,
    geometry: laserGeometry,
    ownedMaterials: [laserHaloMaterial, laserCoreMaterial],
  };
  player.position.set(0, -1.2);
  syncPlayerTransform();
}

function syncPlayerTransform() {
  player.group.position.x = player.position.x;
  player.group.position.y = player.position.y;
}

function disposeLaserAssets() {
  if (!player.laser) return;
  renderer.setAnimationLoop(null);
  world.remove(player.laser.group);
  player.laser.ownedMaterials.forEach((material) => material.dispose());
  player.laser.geometry.dispose();
}

function createParticlePool(count = MAX_PARTICLES) {
  if (particlePool.length > 0) return particlePool.length;
  const requestedCount = count === Infinity ? MAX_PARTICLES : capActiveCount(count, MAX_PARTICLES);
  for (let i = 0; i < requestedCount; i += 1) {
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
  return particlePool.length;
}

function getProjectileActiveCap() {
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarsePointer || window.innerWidth < 700
    ? COMBAT.coarsePointerProjectileActiveCap
    : COMBAT.desktopProjectileActiveCap;
}

function repairProjectileEntry(projectile) {
  if (!projectile?.material?.isMaterial) return false;
  if (!projectile.velocity?.isVector2) projectile.velocity = new THREE.Vector2();
  if (!projectile.mesh?.isMesh) {
    projectile.mesh = new THREE.Mesh(shared.projectileCircleGeometry, projectile.material);
    projectile.mesh.position.z = 3.4;
    world.add(projectile.mesh);
  }
  projectile.mesh.material = projectile.material;
  if (!projectile.mesh.geometry?.isBufferGeometry) projectile.mesh.geometry = shared.projectileCircleGeometry;
  projectile.group = projectile.mesh;
  return true;
}

function resetProjectile(projectile) {
  if (!repairProjectileEntry(projectile)) return false;
  projectile.active = false;
  projectile.type = "none";
  projectile.life = 0;
  projectile.maxLife = 0;
  projectile.damage = 0;
  projectile.radius = 0;
  projectile.velocity.set(0, 0);
  projectile.mesh.visible = false;
  projectile.mesh.position.set(0, 0, 3.4);
  projectile.mesh.rotation.set(0, 0, 0);
  projectile.mesh.scale.set(1, 1, 1);
  projectile.mesh.material.opacity = 0;
  return true;
}

function createProjectilePool() {
  if (projectiles.length > 0) return projectiles.length;
  for (let index = 0; index < PROJECTILE_POOL_SIZE; index += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(shared.projectileCircleGeometry, material);
    mesh.visible = false;
    mesh.position.z = 3.4;
    world.add(mesh);
    projectiles.push({
      active: false,
      type: "none",
      mesh,
      material,
      group: mesh,
      velocity: new THREE.Vector2(),
      life: 0,
      maxLife: 0,
      damage: 0,
      radius: 0,
    });
  }
  return projectiles.length;
}

function spawnProjectile(type, origin, direction, overrides = {}) {
  if (!origin || !direction || ![origin.x, origin.y, direction.x, direction.y].every(Number.isFinite)) return null;
  const activeCount = projectiles.reduce((count, projectile) => count + Number(projectile.active), 0);
  if (activeCount >= getProjectileActiveCap()) return null;
  const projectile = projectiles.find((candidate) => !candidate.active);
  if (!projectile || !repairProjectileEntry(projectile)) return null;
  const normalizedDirection = projectile.velocity.set(direction.x, direction.y);
  if (normalizedDirection.lengthSq() <= 0) return null;
  normalizedDirection.normalize();
  const preset = type === "voidShard"
    ? { speed: 4.1, life: 2.8, damage: 1, radius: 0.18, color: 0xff4fba, geometry: shared.projectileDiamondGeometry }
    : { speed: 3.2, life: 2.4, damage: 1, radius: 0.19, color: 0xffd166, geometry: shared.projectileCircleGeometry };
  const speed = Math.max(0, finiteOr(overrides.speed, preset.speed));
  const life = Math.max(0.01, finiteOr(overrides.life, preset.life));
  const damage = Math.max(0, Math.trunc(finiteOr(overrides.damage, preset.damage)));
  const radius = Math.max(0.01, finiteOr(overrides.radius, preset.radius));
  projectile.active = true;
  projectile.type = type === "voidShard" ? "voidShard" : "lancerBolt";
  projectile.life = projectile.maxLife = life;
  projectile.damage = damage;
  projectile.radius = radius;
  projectile.velocity.multiplyScalar(speed);
  projectile.mesh.geometry = preset.geometry;
  projectile.mesh.position.set(origin.x, origin.y, 3.4);
  projectile.mesh.rotation.z = Math.atan2(direction.y, direction.x) + (projectile.type === "voidShard" ? Math.PI / 4 : 0);
  projectile.mesh.scale.setScalar(finiteOr(overrides.scale, 1));
  projectile.mesh.material.color.set(overrides.color ?? preset.color);
  projectile.mesh.material.opacity = 0.92;
  projectile.mesh.visible = true;
  const nextActiveCount = activeCount + 1;
  state.stats.projectilePeak = Math.max(state.stats.projectilePeak, nextActiveCount);
  return projectile;
}

function updateProjectiles(dt) {
  const step = Math.max(0, finiteOr(dt, 0));
  let activeCount = 0;
  for (const projectile of projectiles) {
    if (!projectile.active) continue;
    activeCount += 1;
    projectile.life -= step;
    projectile.mesh.position.x += projectile.velocity.x * step;
    projectile.mesh.position.y += projectile.velocity.y * step;
    if (!state.reducedMotion) projectile.mesh.rotation.z += step * (projectile.type === "voidShard" ? 4.8 : 1.8);
    projectile.mesh.material.opacity = THREE.MathUtils.clamp(projectile.life / Math.max(projectile.maxLife, 0.001), 0, 1) * 0.92;
    const hitPlayer = projectileHitsCircle({
      x: projectile.mesh.position.x,
      y: projectile.mesh.position.y,
      velocityX: projectile.velocity.x,
      velocityY: projectile.velocity.y,
      radius: projectile.radius,
    }, {
      x: player.position.x,
      y: player.position.y,
      radius: player.radius,
    });
    const outOfBounds = Math.abs(projectile.mesh.position.x) > view.halfWidth + 2
      || Math.abs(projectile.mesh.position.y) > view.halfHeight + 2;
    if (hitPlayer && !state.dashInvulnerable && state.hurtInvuln <= 0) {
      damagePlayer(projectile);
      resetProjectile(projectile);
    } else if (projectile.life <= 0 || outOfBounds) {
      resetProjectile(projectile);
    }
  }
  state.stats.projectilePeak = Math.max(state.stats.projectilePeak, activeCount);
  return activeCount;
}

function deterministicEnvironmentUnit(seed, sequence) {
  let value = (Math.trunc(finiteOr(seed, 0)) + Math.imul(Math.trunc(finiteOr(sequence, 0)) + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return (value >>> 0) / 0x100000000;
}

function hideEnvironmentVisuals() {
  Object.values(environmentVisual).forEach((visual) => { visual.group.visible = false; });
}

function scheduleEnvironmentForStage() {
  const realm = REALMS[state.stageIndex] ?? REALMS[0];
  state.environmentActive = false;
  state.environmentElapsed = 0;
  const seed = deterministicEnvironmentUnit(state.environmentSeed, state.environmentSequence);
  state.environmentSequence += 1;
  state.environmentTimer = getEnvironmentDelay(realm.id, seed);
  environmentFrame = getEnvironmentFrame(realm.id, 0);
  hideEnvironmentVisuals();
  return state.environmentTimer;
}

function updateEnvironmentVisual(frame) {
  hideEnvironmentVisuals();
  if (!frame || !["telegraph", "active"].includes(frame.phase)) return;
  const visual = frame.type === "current"
    ? environmentVisual.current
    : frame.type === "data-lane" ? environmentVisual.dataLane : environmentVisual.gravity;
  visual.group.visible = true;
  visual.group.position.set(frame.center?.x ?? 0, frame.type === "data-lane" ? frame.laneCenter ?? 0 : frame.center?.y ?? 0, 1.1);
  const telegraphProgress = frame.telegraph > 0 ? THREE.MathUtils.clamp(frame.elapsed / frame.telegraph, 0, 1) : 1;
  const pulse = state.reducedMotion ? 1 : 1 + Math.sin(frame.elapsed * 7) * 0.06;
  visual.group.scale.setScalar((frame.phase === "telegraph" ? 0.88 + telegraphProgress * 0.12 : 1) * pulse);
  visual.meshes.forEach((mesh) => {
    if (mesh.material) mesh.material.opacity = frame.phase === "telegraph" ? 0.2 + telegraphProgress * 0.35 : 0.68;
  });
  if (frame.type === "gravity-well" && !state.reducedMotion) {
    visual.group.children.forEach((ring, index) => {
      ring.rotation.z = frame.elapsed * (index % 2 ? -1 : 1) * (0.5 + index * 0.15);
    });
  }
}

function applyEnvironmentForce(frame, target, simulationDt) {
  if (!target?.velocity || !target?.position) return;
  const point = { x: target.position.x, y: target.position.y };
  const force = frame.type === "current" ? getCurrentForce(frame, point) : getGravityForce(frame, point);
  target.velocity.x += force.x * simulationDt;
  target.velocity.y += force.y * simulationDt;
}

function clearEnemyEnvironmentMotion() {
  for (const enemy of enemies) enemy?.environmentVelocity?.set(0, 0);
}

function applyEnemyEnvironmentMotion(frame, enemy, simulationDt) {
  if (!enemy?.group?.position || !enemy.environmentVelocity?.isVector2) return;
  const force = frame.type === "current"
    ? getCurrentForce(frame, enemy.group.position)
    : getGravityForce(frame, enemy.group.position);
  enemy.environmentVelocity.x += force.x * simulationDt;
  enemy.environmentVelocity.y += force.y * simulationDt;
  enemy.group.position.x += enemy.environmentVelocity.x * simulationDt;
  enemy.group.position.y += enemy.environmentVelocity.y * simulationDt;
}

function advanceEnvironmentTimeline(realm, wallDt) {
  let remaining = wallDt;
  let steps = 0;
  while (steps < MAX_ENVIRONMENT_STEPS_PER_FRAME) {
    steps += 1;
    if (!state.environmentActive) {
      if (state.environmentTimer === Infinity) break;
      const delayRemaining = Math.max(0, finiteOr(state.environmentTimer, 0));
      if (remaining < delayRemaining) {
        state.environmentTimer = delayRemaining - remaining;
        remaining = 0;
        break;
      }
      remaining = Math.max(0, remaining - delayRemaining);
      state.environmentActive = true;
      state.environmentElapsed = 0;
      state.environmentTimer = 0;
      state.stats.environmentEvents += 1;
      audio.event("environment");
      if (remaining <= 0) break;
    }

    const frame = getEnvironmentFrame(realm.id, state.environmentElapsed);
    const eventDuration = Math.max(0, finiteOr(frame.telegraph, 0) + finiteOr(frame.activeDuration, 0));
    const eventRemaining = Math.max(0, eventDuration - state.environmentElapsed);
    if (remaining < eventRemaining) {
      state.environmentElapsed += remaining;
      remaining = 0;
      break;
    }
    state.environmentElapsed = eventDuration;
    remaining = Math.max(0, remaining - eventRemaining);
    clearEnemyEnvironmentMotion();
    scheduleEnvironmentForStage();
    if (remaining <= 0) break;
  }
}

function applyEnvironment(dt, simulationDt = Math.min(Math.max(0, finiteOr(dt, 0)), 0.05)) {
  const wallDt = Math.max(0, finiteOr(dt, 0));
  const forceDt = Math.min(0.05, Math.max(0, finiteOr(simulationDt, 0)));
  const realm = REALMS[state.stageIndex] ?? REALMS[0];
  if (realm.environment.type === "none") {
    state.environmentTimer = Infinity;
    state.environmentActive = false;
    environmentFrame = getEnvironmentFrame(realm.id, 0);
    hideEnvironmentVisuals();
    clearEnemyEnvironmentMotion();
    return environmentFrame;
  }
  advanceEnvironmentTimeline(realm, wallDt);
  if (!state.environmentActive) {
    environmentFrame = getEnvironmentFrame(realm.id, 0);
    hideEnvironmentVisuals();
    clearEnemyEnvironmentMotion();
    return environmentFrame;
  }
  environmentFrame = getEnvironmentFrame(realm.id, state.environmentElapsed);
  updateEnvironmentVisual(environmentFrame);
  if (environmentFrame.phase === "active") {
    state.stats.environmentActiveFrames += 1;
    applyEnvironmentForce(environmentFrame, player, forceDt);
    for (const enemy of enemies) applyEnemyEnvironmentMotion(environmentFrame, enemy, forceDt);
    for (const shard of shards) applyEnvironmentForce(environmentFrame, { position: shard.group.position, velocity: shard.velocity }, forceDt);
  } else clearEnemyEnvironmentMotion();
  return environmentFrame;
}

function clearEnvironmentAndProjectiles() {
  projectiles.forEach(resetProjectile);
  clearEnemyEnvironmentMotion();
  state.environmentActive = false;
  state.environmentElapsed = 0;
  state.environmentTimer = Infinity;
  environmentFrame = getEnvironmentFrame((REALMS[state.stageIndex] ?? REALMS[0]).id, 999);
  hideEnvironmentVisuals();
  return true;
}

function disposeCombatAssets() {
  for (const projectile of projectiles) {
    world.remove(projectile.mesh);
    projectile.material.dispose();
  }
  projectiles.length = 0;
  shared.projectileCircleGeometry.dispose();
  shared.projectileDiamondGeometry.dispose();
  for (const visual of Object.values(environmentVisual)) {
    world.remove(visual.group);
    visual.geometries.forEach((geometry) => geometry.dispose());
    visual.materials.forEach((material) => material.dispose());
  }
}

function createTrailPool(count = MAX_TRAIL_NODES) {
  if (trailPool.length > 0) return trailPool.length;
  const bodyGeometry = createTriangleGeometry(0.58, 0.34, -0.38);
  const wingGeometry = createWingGeometry();
  const requestedCount = count === Infinity ? MAX_TRAIL_NODES : capActiveCount(count, MAX_TRAIL_NODES);
  for (let i = 0; i < requestedCount; i += 1) {
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
  return trailPool.length;
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
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)
    || !Number.isFinite(speed) || !Number.isFinite(size)) return 0;
  if (particles.length >= MAX_PARTICLES) return 0;
  const requested = capActiveCount(count, MAX_PARTICLES - particles.length);
  const safeSpeed = Math.max(0, speed);
  const safeSize = Math.max(0.01, size);
  let spawned = 0;
  for (let i = 0; i < requested; i += 1) {
    const particle = particlePool.find((candidate) => !candidate.mesh.visible);
    if (!particle) break;
    const angle = Math.random() * TAU;
    const force = safeSpeed * (0.38 + Math.random() * 0.8);
    particle.life = particle.maxLife = 0.28 + Math.random() * 0.42;
    particle.velocity.set(Math.cos(angle) * force, Math.sin(angle) * force);
    particle.mesh.position.set(position.x, position.y, 4.2);
    particle.mesh.scale.setScalar(safeSize * (0.65 + Math.random() * 0.95));
    particle.mesh.material.color.set(color);
    particle.mesh.material.opacity = 0.9;
    particle.mesh.visible = true;
    particles.push(particle);
    spawned += 1;
  }
  return spawned;
}

function spawnRipple(position, color, scale = 1) {
  if (state.reducedMotion) return null;
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  while (ripples.length >= MAX_RIPPLES) removeRippleAt(0);
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

function removeRippleAt(index) {
  const ripple = ripples[index];
  if (!ripple) return false;
  world.remove(ripple.mesh);
  ripple.mesh.material.dispose();
  ripples.splice(index, 1);
  return true;
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
  refreshRenderQuality();
  realmBackgrounds.setRealm(state.stageIndex, state.reducedMotion);
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
  for (const ripple of ripples.splice(0)) {
    world.remove(ripple.mesh);
    ripple.mesh.material.dispose();
  }
  for (const particle of particles.splice(0)) {
    particle.mesh.visible = false;
    particle.mesh.material.opacity = 0;
  }
}

function refreshRenderQuality() {
  const nextQuality = selectRenderQuality({
    coarsePointer: window.matchMedia?.("(pointer: coarse)").matches ?? false,
    reducedMotion: state.reducedMotion,
    viewportWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
  });
  const changed = renderQuality?.tier !== nextQuality.tier || renderQuality?.pixelRatio !== nextQuality.pixelRatio;
  renderQuality = nextQuality;
  renderer.setPixelRatio(renderQuality.pixelRatio);
  document.documentElement.dataset.renderQuality = renderQuality.tier;
  if (!changed && postProcessing) return renderQuality;
  if (postProcessing) {
    postProcessing.dispose();
    runtimeStats.composerDisposeCount += 1;
  }
  postProcessing = createPostProcessing({
    renderer,
    scene,
    camera,
    quality: renderQuality,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  runtimeStats.composerRefreshCount += 1;
  return renderQuality;
}

function getWarningStep(remaining, duration, stepCount = 4) {
  const progress = 1 - THREE.MathUtils.clamp(remaining / Math.max(duration, 0.001), 0, 1);
  return Math.min(stepCount - 1, Math.floor(progress * stepCount));
}

function applyDiscreteWarning(material, remaining, duration) {
  if (!material) return 0;
  const step = getWarningStep(remaining, duration);
  const colors = [0xffd166, 0xff9f43, 0xff6b5f, 0xff305f];
  const opacities = [0.3, 0.46, 0.64, 0.86];
  material.color?.set(colors[step]);
  material.opacity = opacities[step];
  return step;
}

function syncHealthPips() {
  while (dom.healthPips.length < state.maxHealth) {
    const pip = document.createElement("i");
    dom.health.appendChild(pip);
    dom.healthPips.push(pip);
  }
  while (dom.healthPips.length > state.maxHealth) {
    dom.healthPips.pop()?.remove();
  }
  dom.healthPips.forEach((pip, index) => pip.classList.toggle("empty", index >= state.health));
  dom.health.setAttribute("aria-valuemin", "0");
  dom.health.setAttribute("aria-valuemax", String(state.maxHealth));
  dom.health.setAttribute("aria-valuenow", String(state.health));
  dom.health.setAttribute("aria-valuetext", `船体 ${state.health} / ${state.maxHealth}`);
}

function syncBossProgress(boss = enemies.find((enemy) => enemy.type === "boss" && !enemy.dead)) {
  const percent = boss ? THREE.MathUtils.clamp((boss.hp / boss.maxHp) * 100, 0, 100) : 0;
  const totalHits = boss ? Math.ceil(boss.maxHp / BOSS_DASH_DAMAGE) : Math.ceil(ENEMY_TYPES.boss.hp / BOSS_DASH_DAMAGE);
  const remainingHits = boss ? Math.max(0, Math.ceil(boss.hp / BOSS_DASH_DAMAGE)) : 0;
  dom.bossPanel.hidden = !boss;
  dom.bossFill.style.width = `${percent}%`;
  dom.bossTrack.setAttribute("aria-valuemin", "0");
  dom.bossTrack.setAttribute("aria-valuemax", "100");
  dom.bossTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
  dom.bossTrack.setAttribute("aria-valuetext", `深潮主脑稳定度 ${remainingHits} / ${totalHits}`);
}

function showFloatingText(text, position, tone = "cyan", tier = "small") {
  if (!text || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  if (floatingTexts.length >= MAX_FLOATING_TEXTS) floatingTexts.shift().element.remove();
  const element = document.createElement("span");
  element.className = `floating-text ${tone} ${tier}`;
  element.textContent = text;
  dom.floatingLayer.appendChild(element);
  const item = {
    element,
    position: new THREE.Vector3(position.x, position.y, 4.8),
    life: tier === "large" ? 1.15 : tier === "medium" || tier === "nearMiss" ? 0.9 : 0.7,
    maxLife: tier === "large" ? 1.15 : tier === "medium" || tier === "nearMiss" ? 0.9 : 0.7,
    drift: Math.sin(state.elapsed * 17.3 + floatingTexts.length * 2.1) * 22,
  };
  floatingTexts.push(item);
  return item;
}

function showStageBanner(title, duration = 1.05, tone = "stage", label = "PHASE SHIFT") {
  dom.stageBannerLabel.textContent = label;
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
    paletteState.primary.set(palette.primary);
    paletteState.secondary.set(palette.secondary);
    applyPalette();
  }
  return palette;
}

function applyPalette() {
  scene.background.copy(paletteState.background);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--stage-primary", `#${paletteState.primary.getHexString()}`);
  rootStyle.setProperty("--stage-secondary", `#${paletteState.secondary.getHexString()}`);
}

function updatePalette(dt) {
  const blend = 1 - Math.exp(-2.6 * dt);
  paletteState.background.lerp(paletteState.targetColors.background, blend);
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
  const ring = new THREE.Mesh(shared.shardRingGeometry, shared.shardRingMaterial);
  group.add(glow, ring, gem);
  world.add(group);
  const shard = { group, gem, ring, baseX: position.x, baseY: position.y, velocity: new THREE.Vector2(), phase: Math.random() * TAU };
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
  if (enemies.length >= getEnemyCap()) return null;
  const config = ENEMY_TYPES[type] ?? ENEMY_TYPES.chaser;
  group.position.set(position.x, position.y, 2);
  world.add(group);
  const enemy = {
    type,
    group,
    velocity: new THREE.Vector2(),
    environmentVelocity: new THREE.Vector2(),
    speed: config.speed,
    radius: config.radius,
    hp: config.hp,
    maxHp: config.hp,
    state: initialState,
    stateTimer: 0,
    telegraph: 0,
    wobble: Math.random() * TAU,
    nearMissed: false,
    nearMissCandidate: false,
    nearMissMinDistance: Infinity,
    nearMissPreviousDistance: Infinity,
    nearMissResolved: false,
    dead: false,
    priority: 1,
    ...overrides,
  };
  enemies.push(enemy);
  state.stats.enemyPeak = Math.max(state.stats.enemyPeak, enemies.length);
  const role = config.role ?? type;
  state.stats.roles[role] = (state.stats.roles[role] ?? 0) + 1;
  return enemy;
}

function createChaser(position = randomEdgePosition()) {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.chaserGlowMaterial);
  glow.scale.setScalar(1.45);
  const body = new THREE.Mesh(shared.enemyGeometry, shared.chaserMaterial);
  const leftFin = new THREE.Mesh(shared.swarmWingGeometry, shared.chaserMaterial);
  const rightFin = new THREE.Mesh(shared.swarmWingGeometry, shared.chaserMaterial);
  leftFin.scale.set(-0.52, 0.52, 1);
  rightFin.scale.set(0.52, 0.52, 1);
  leftFin.position.set(-0.22, -0.16, -0.02);
  rightFin.position.set(0.22, -0.16, -0.02);
  const eye = new THREE.Mesh(shared.bossCoreGeometry, shared.bossMaterial);
  eye.scale.setScalar(0.095);
  eye.position.set(0, 0.1, 0.06);
  const chargeArc = new THREE.Group();
  for (let index = 0; index < 3; index += 1) {
    const segment = new THREE.Line(shared.telegraphLineGeometry, shared.hunterTrailMaterial);
    segment.position.set(0, 0.78 + index * 0.62, -0.04);
    segment.scale.set(0.26 + index * 0.14, 0.34 + index * 0.18, 1);
    segment.visible = false;
    chargeArc.add(segment);
  }
  chargeArc.visible = false;
  group.add(chargeArc, glow, leftFin, rightFin, body, eye);
  const intentTimer = 1.8 + Math.random() * 1.4;
  return registerEnemy("chaser", position, group, "chase", {
    speed: 2.0 + state.elapsed * 0.014 + Math.random() * 0.24,
    stateTimer: intentTimer,
    intentTimer,
    intentIndex: Math.floor(Math.random() * 3),
    dashDirection: new THREE.Vector2(),
    visuals: { glow, body, leftFin, rightFin, chargeArc },
  });
}

function createStriker(position = randomEdgePosition()) {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.strikerGlowMaterial);
  glow.scale.set(1.25, 1.8, 1);
  const body = new THREE.Mesh(shared.strikerGeometry, shared.strikerMaterial);
  const stabilizer = new THREE.Mesh(shared.strikerStabilizerGeometry, shared.strikerMaterial);
  stabilizer.position.set(0, -0.2, -0.02);
  stabilizer.rotation.z = Math.PI / 4;
  const lines = [-0.18, 0, 0.18].map((angle) => {
    const line = new THREE.Line(shared.telegraphLineGeometry, shared.telegraphMaterial);
    line.position.z = -0.08;
    line.rotation.z = angle;
    line.visible = false;
    return line;
  });
  group.add(...lines, glow, stabilizer, body);
  return registerEnemy("striker", position, group, "track", {
    speed: 2.0 + Math.random() * 0.22,
    stateTimer: 0.55 + Math.random() * 0.75,
    intentIndex: Math.floor(Math.random() * 3),
    selectedLane: 1,
    aimDirection: new THREE.Vector2(),
    dashDirection: new THREE.Vector2(),
    visuals: { glow, body, stabilizer, line: lines[1], lines },
    priority: 2,
  });
}

function createLancer(position = randomEdgePosition(1.2)) {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.mineGlowMaterial);
  glow.scale.set(1.2, 1.8, 1);
  const body = new THREE.Mesh(shared.lancerDiamondGeometry, shared.lancerMaterial);
  body.rotation.z = Math.PI / 4;
  body.scale.set(0.86, 1.2, 1);
  const spear = new THREE.Mesh(shared.strikerGeometry, shared.lancerMaterial);
  spear.scale.set(0.28, 0.58, 1);
  spear.position.y = -0.4;
  const reticle = new THREE.Mesh(shared.lancerReticleGeometry, shared.warningRingMaterial);
  reticle.position.z = 0.03;
  const lineMaterial = shared.lancerTelegraphMaterial.clone();
  const beamMaterial = shared.lancerBeamMaterial.clone();
  const line = new THREE.Mesh(shared.beamGeometry, lineMaterial);
  line.visible = true;
  line.scale.set(0.06, 1, 1);
  const beam = new THREE.Mesh(shared.beamGeometry, beamMaterial);
  beam.visible = false;
  beam.scale.set(0.2, 1, 1);
  group.add(line, beam, glow, reticle, spear, body);
  return registerEnemy("lancer", position, group, "lock", {
    speed: 0.35 + Math.random() * 0.2,
    stateTimer: 0.65 + Math.random() * 0.35,
    beamDirection: new THREE.Vector2(),
    beamWidth: 0.2,
    visuals: { glow, body, spear, reticle, line, beam },
    ownedMaterials: [lineMaterial, beamMaterial],
    priority: 2,
  });
}

function createSwarm(position = randomEdgePosition(0.7), wingSign = 0) {
  const group = new THREE.Group();
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.swarmGlowMaterial);
  glow.scale.setScalar(0.84);
  const body = new THREE.Mesh(shared.enemyGeometry, shared.swarmMaterial);
  body.scale.setScalar(0.55);
  const leftWing = new THREE.Mesh(shared.swarmWingGeometry, shared.swarmMaterial);
  const rightWing = new THREE.Mesh(shared.swarmWingGeometry, shared.swarmMaterial);
  leftWing.scale.set(0.42, 0.42, 1);
  rightWing.scale.set(-0.42, 0.42, 1);
  leftWing.position.set(-0.22, -0.08, -0.02);
  rightWing.position.set(0.22, -0.08, -0.02);
  group.add(glow, leftWing, rightWing, body);
  const ingress = new THREE.Vector2().subVectors(player.position, position).normalize();
  return registerEnemy("swarm", position, group, "ingress", {
    speed: 2.8 + Math.random() * 0.7,
    stateTimer: 0.65 + Math.random() * 0.35,
    wingSign: wingSign || (Math.random() < 0.5 ? -1 : 1),
    splitTimer: 0.72,
    dashDirection: ingress,
    visuals: { glow, body, leftWing, rightWing },
    priority: 1,
  });
}

function createMine(position = randomShardPosition()) {
  if (enemies.filter((enemy) => enemy.type === "mine" && !enemy.dead).length >= MAX_MINES) return null;
  const group = new THREE.Group();
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.mineGlowMaterial);
  glow.scale.setScalar(1.65);
  const body = new THREE.Mesh(shared.mineGeometry, shared.mineMaterial);
  const ringMaterial = shared.dangerRingMaterial.clone();
  const tickMaterial = shared.warningRingMaterial.clone();
  const ring = new THREE.Mesh(shared.mineRingGeometry, ringMaterial);
  const tick = new THREE.Mesh(shared.mineTickGeometry, tickMaterial);
  ring.position.z = -0.05;
  tick.position.z = -0.04;
  group.add(glow, tick, ring, body);
  return registerEnemy("mine", position, group, "arming", {
    stateTimer: 1.1,
    telegraph: 1.1,
    dangerRadius: 0,
    previousDangerRadius: 0,
    detonationStage: -1,
    pulseHit: false,
    chainDelay: 0,
    chainQueuedFrame: -1,
    chainTriggered: false,
    attackRecorded: false,
    visuals: { glow, body, ring, tick },
    ownedMaterials: [ringMaterial, tickMaterial],
    priority: 2,
  });
}

function createElite(position = randomEdgePosition(1.1), type = "elite") {
  const group = new THREE.Group();
  const shockMaterial = shared.dangerRingMaterial.clone();
  const shockwave = new THREE.Mesh(shared.eliteShockGeometry, shockMaterial);
  shockwave.visible = false;
  const outer = new THREE.Mesh(shared.eliteOuterGeometry, shared.bossMaterial);
  const shield = new THREE.Mesh(shared.eliteShieldGeometry, shared.warningRingMaterial);
  const body = new THREE.Mesh(shared.enemyGeometry, shared.eliteMaterial);
  body.scale.setScalar(1.75);
  group.add(shockwave, shield, outer, body);
  return registerEnemy(type, position, group, "chase", {
    speed: 1.4 + Math.random() * 0.4,
    stateTimer: 1.4 + Math.random() * 0.5,
    shockTimer: 2.6 + Math.random() * 1.2,
    shockRadius: 0,
    shockPreviousRadius: 0,
    pulseHit: false,
    dashCharges: 3,
    counterCooldown: 0,
    counterHitToken: null,
    visuals: { shockwave, shield, outer, body },
    ownedMaterials: [shockMaterial],
    priority: 3,
  });
}

function createBoss() {
  if (state.bossSpawned || enemies.some((enemy) => enemy.type === "boss" && !enemy.dead)) return null;
  const group = new THREE.Group();
  const outerRing = new THREE.Mesh(shared.bossOuterGeometry, shared.bossMaterial);
  const middleRing = new THREE.Mesh(shared.bossMiddleGeometry, shared.warningRingMaterial);
  const innerRing = new THREE.Mesh(shared.bossInnerGeometry, shared.dangerRingMaterial);
  const coreMaterial = shared.coreMaterial.clone();
  coreMaterial.color.copy(BOSS_CORE_IDLE_COLOR);
  const coreGlowMaterial = shared.bossCoreGlowMaterial.clone();
  coreGlowMaterial.opacity = 0.18;
  const haloRing = new THREE.Mesh(shared.bossHaloGeometry, shared.bossHaloMaterial);
  const core = new THREE.Mesh(shared.bossCoreGeometry, coreMaterial);
  core.scale.set(1.15, 0.72, 1);
  const coreGlow = new THREE.Mesh(shared.bossCoreGlowGeometry, coreGlowMaterial);
  coreGlow.scale.set(1.22, 0.76, 1);
  const lineMaterial = shared.telegraphMaterial.clone();
  const line = new THREE.Mesh(shared.beamGeometry, lineMaterial);
  line.visible = false;
  line.scale.set(0.08, 1, 1);
  const shardLines = new THREE.Group();
  [-0.28, -0.14, 0, 0.14, 0.28].forEach((angle) => {
    const shardLine = new THREE.Line(shared.telegraphLineGeometry, lineMaterial);
    shardLine.rotation.z = angle;
    shardLine.visible = false;
    shardLines.add(shardLine);
  });
  const pulseMaterial = shared.dangerRingMaterial.clone();
  const pulseRing = new THREE.Mesh(shared.bossPulseGeometry, pulseMaterial);
  pulseRing.visible = false;
  const triangleMaterial = shared.dangerRingMaterial.clone();
  const trianglePulse = new THREE.Mesh(shared.bossTriangleGeometry, triangleMaterial);
  trianglePulse.visible = false;
  const orbitNodes = new THREE.Group();
  for (let i = 0; i < 4; i += 1) {
    const node = new THREE.Mesh(shared.bossOrbitNodeGeometry, i % 2 ? shared.bossOrbitCyanMaterial : shared.bossOrbitDangerMaterial);
    const angle = (i / 4) * TAU;
    node.position.set(Math.cos(angle) * 2.72, Math.sin(angle) * 2.72, 0.04);
    orbitNodes.add(node);
  }
  group.add(line, shardLines, pulseRing, trianglePulse, haloRing, outerRing, middleRing, innerRing, orbitNodes, coreGlow, core);
  const enemy = registerEnemy("boss", new THREE.Vector2(0, view.halfHeight + 4.8), group, "enter", {
    stateTimer: 1.5,
    telegraph: 0,
    attackIndex: 0,
    attackKind: "charge",
    phase: 1,
    phase2Triggered: false,
    pulseIndex: -1,
    beamDirection: new THREE.Vector2(0, -1),
    beamWidth: 0.28,
    beamStartAngle: 0,
    beamEndAngle: 0,
    attackElapsed: 0,
    triangleDirection: new THREE.Vector2(0, 1),
    triangleHalfAngle: Math.PI / 6,
    triangleBaseAngle: 0,
    dashDirection: new THREE.Vector2(),
    dangerRadius: 0,
    previousDangerRadius: 0,
    pulseHit: false,
    hitReactTimer: 0,
    priority: 4,
    visuals: { haloRing, outerRing, middleRing, innerRing, orbitNodes, coreGlow, core, line, shardLines, pulseRing, trianglePulse },
    ownedMaterials: [lineMaterial, pulseMaterial, triangleMaterial, coreMaterial, coreGlowMaterial],
  });
  if (enemy) {
    state.bossSpawned = true;
    syncBossProgress(enemy);
  }
  return enemy;
}

function spawnEnemy(type = null, position = null, overrides = {}) {
  if (enemies.length >= getEnemyCap()) return null;
  let chosenType = type;
  if (!chosenType) {
    const roleCycles = [
      ["chaser", "chaser", "swarm", "chaser", "swarm"],
      ["striker", "lancer", "swarm", "chaser", "striker"],
      ["chaser", "striker", "lancer", "mine", "swarm", "elite"],
    ];
    const roles = roleCycles[Math.min(2, state.stageIndex)] ?? roleCycles[2];
    chosenType = roles[state.spawnSequence % roles.length];
    state.spawnSequence += 1;
  }
  const spawnPosition = position ?? (chosenType === "mine" ? randomShardPosition() : randomEdgePosition());
  if (chosenType === "striker") return createStriker(spawnPosition, overrides);
  if (chosenType === "lancer") return createLancer(spawnPosition, overrides);
  if (chosenType === "mine") return createMine(spawnPosition, overrides);
  if (chosenType === "swarm") return createSwarm(spawnPosition, overrides.wingSign);
  if (chosenType === "elite" || chosenType === "bulwark") return createElite(spawnPosition, chosenType);
  if (chosenType === "boss") return createBoss();
  return createChaser(spawnPosition, overrides);
}

function getNextEligibleSpawnType() {
  const roleCycles = [
    ["chaser", "chaser", "swarm", "chaser", "swarm"],
    ["striker", "lancer", "swarm", "chaser", "striker"],
    ["chaser", "striker", "lancer", "mine", "swarm", "elite"],
  ];
  const roles = roleCycles[Math.min(2, state.stageIndex)] ?? roleCycles[2];
  for (let offset = 0; offset < roles.length; offset += 1) {
    const type = roles[(state.spawnSequence + offset) % roles.length];
    if ((ENEMY_TYPES[type]?.minStage ?? 0) <= state.stageIndex) {
      state.spawnSequence += offset + 1;
      return type;
    }
  }
  return null;
}

function formationActiveCost() {
  return enemies.reduce((cost, enemy) => cost + (ENEMY_TYPES[enemy.type]?.threatCost ?? 1), 0);
}

function getFormationSpatialGap(templateName) {
  const slots = getFormationSlots(templateName, { width: view.halfWidth * 2, height: view.halfHeight * 2 });
  if (!slots.length) return Infinity;
  return Math.min(...slots.map((slot) => Math.hypot(slot.x - player.position.x, slot.y - player.position.y)));
}

function spawnFormation() {
  if (state.stageIndex >= 3 || state.bossTriggered) return false;
  const cap = getEnemyCap();
  const healthPercent = (state.health / Math.max(1, state.maxHealth)) * 100;
  const pressureTarget = getPressureTarget(state.stageIndex, { activeCap: cap, healthPercent });
  const populationCapacity = Math.max(0, pressureTarget - enemies.length);
  if (populationCapacity <= 0) return false;
  const activeCost = formationActiveCost();
  const cooldown = FORMATION_TEMPLATES[state.lastFormation]?.cooldown ?? 0;
  const cooldownRemaining = Number.isFinite(state.lastFormationAt)
    ? Math.max(0, state.lastFormationAt + cooldown - state.elapsed)
    : 0;
  const directorOptions = {
    stageIndex: state.stageIndex,
    elapsed: state.elapsed,
    lastFormation: state.lastFormation,
    cooldownRemaining,
    activeCost,
    maxEnemyCap: cap,
    safeGap: Infinity,
    seed: Math.floor(state.elapsed * 10) + state.stats.formationCount * 17,
  };
  let template = chooseFormation(directorOptions);
  // If every alternative is over budget, repeating the prior template is
  // allowed only after its declared cooldown. State.lastFormation is retained.
  if (!template && cooldownRemaining <= 0) template = chooseFormation({ ...directorOptions, lastFormation: null, seed: directorOptions.seed + 31 });
  if (!template) return false;
  const spatialGap = getFormationSpatialGap(template.name);
  if (spatialGap < template.minSafeGap) return false;
  const budget = getFormationBudget(state.stageIndex, state.elapsed, { activeCost, maxEnemyCap: cap });
  let remainingBudget = budget;
  let remainingCapacity = Math.min(populationCapacity, Math.max(0, cap - enemies.length));
  const slots = getFormationSlots(template.name, { width: view.halfWidth * 2, height: view.halfHeight * 2 });
  const spawnedRoles = [];
  let actualThreatCost = 0;
  for (let i = 0; i < slots.length && remainingCapacity > 0; i += 1) {
    const slot = slots[i];
    const unitCost = ENEMY_TYPES[slot.role]?.threatCost ?? 1;
    if (remainingBudget < unitCost) continue;
    const created = spawnEnemy(slot.role, new THREE.Vector2(slot.x, slot.y), {
      formation: template.name,
      formationIndex: i,
      wingSign: i % 2 ? 1 : -1,
    });
    if (!created) continue;
    spawnedRoles.push(created.type);
    remainingCapacity -= 1;
    remainingBudget -= unitCost;
    actualThreatCost += unitCost;
  }
  if (!spawnedRoles.length) return false;
  state.lastFormation = template.name;
  state.lastFormationAt = state.elapsed;
  state.stats.formationCount += 1;
  state.stats.formationLog.push({
    name: template.name,
    elapsed: Number(state.elapsed.toFixed(2)),
    roles: spawnedRoles,
    threatCost: actualThreatCost,
    budget,
    spatialGap: Number(spatialGap.toFixed(2)),
  });
  if (state.stats.formationLog.length > 24) state.stats.formationLog.shift();
  toast(`${template.name.toUpperCase()} 编队`, "danger");
  return true;
}

function removeShard(index) {
  const shard = shards[index];
  world.remove(shard.group);
  shards.splice(index, 1);
}

function removeEnemy(index) {
  const enemy = enemies[index];
  enemies.splice(index, 1);
  if (!enemy) return false;
  if (enemy.group?.isObject3D) world.remove(enemy.group);
  enemy.ownedMaterials?.forEach((material) => material?.dispose?.());
  state.stats.activeCleanupCount += 1;
  enemy.visuals?.chargeArc?.children.forEach((segment) => { segment.visible = false; });
  enemy.visuals?.chargeArc && (enemy.visuals.chargeArc.visible = false);
  if (enemy.type === "boss") syncBossProgress(null);
  return true;
}

function clearWorldEntities() {
  clearEnvironmentAndProjectiles();
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
  clearCombo();
  state.toastTimer = 0;
  dom.toast.classList.remove("show");
  dom.toast.textContent = "";
  dom.toast.removeAttribute("style");
  state.stageBannerTimer = 0;
  dom.stageBanner.classList.remove("show");
  dom.stageBannerLabel.textContent = "PHASE SHIFT";
  dom.stageBannerTitle.textContent = "";
  delete dom.stageBanner.dataset.tone;
  dom.upgradeOptions.replaceChildren();
  dom.upgradePanel.hidden = true;
  window.clearTimeout(flash.timeout);
  flash.timeout = null;
  dom.flash.style.opacity = "0";
  dom.combo.innerHTML = "连击 ×<b>2</b>";
  state.elapsed = 0;
  state.timeLeft = GAME.bossStart;
  state.score = 0;
  state.maxHealth = BASE_MAX_HEALTH;
  state.health = state.maxHealth;
  state.weaponEnergy = 0;
  state.laserSequence = 0;
  state.laserSequenceTargets = 0;
  state.laserDirection.set(0, 1);
  state.stageIndex = 0;
  state.spawnSequence = 0;
  state.enemySpawnTimer = 0.72;
  state.formationTimer = 4.8;
  state.environmentTimer = Infinity;
  state.environmentElapsed = 0;
  state.environmentSeed = 0x4e544944;
  state.environmentSequence = 0;
  state.environmentActive = false;
  state.combatFrame = 0;
  state.lastFormation = null;
  state.lastFormationAt = -Infinity;
  state.shardSpawnTimer = 1.8;
  state.dashCharges = [1, 1];
  state.dashTimer = 0;
  state.dashInvulnTimer = 0;
  state.dashSequence = 0;
  state.hurtInvuln = 0;
  state.runFinished = false;
  state.trauma = 0;
  state.traumaClock = 0;
  state.slowMotionScale = 1;
  state.slowMotionTimer = 0;
  state.zoomPunch = 0;
  state.upgradeTriggered = [false, false];
  state.stageQueue = [];
  state.bossTriggered = false;
  state.bossSpawned = false;
  state.bossStart = null;
  state.bossDeadline = null;
  state.terminalReason = null;
  player.hitReactTimer = 0;
  state.ownedUpgrades = [];
  state.upgradeOptions = [];
  state.stats.maxCombo = 0;
  state.stats.nearMisses = 0;
  state.stats.breaks = 0;
  state.stats.enemyPeak = 0;
  state.stats.formationCount = 0;
  state.stats.formationLog = [];
  state.stats.roles = {};
  state.stats.beamPeak = 0;
  state.stats.activeHazards = 0;
  state.stats.chainBreaks = 0;
  state.stats.activeCleanupCount = 0;
  state.stats.bossPhase = 1;
  state.stats.bossAttackLog = [];
  state.stats.bossAttackTelegraphs = [];
  state.stats.laserShots = 0;
  state.stats.laserHits = 0;
  state.stats.laserInterrupts = 0;
  state.stats.laserPeakTargets = 0;
  state.stats.projectilePeak = 0;
  state.stats.environmentEvents = 0;
  state.stats.environmentActiveFrames = 0;
  state.stats.realmAttackRoles = {};
  dom.missionObjective.textContent = `坚持 ${GAME.bossStart} 秒，定位深潮主脑`;
  dom.score.textContent = "0000";
  dom.timeLabel.textContent = "首领接入";
  dom.time.textContent = `00:${String(GAME.bossStart).padStart(2, "0")}`;
  dom.time.classList.remove("warning");
  dom.weaponEnergy.textContent = "0";
  dom.weaponEnergyFill.style.width = "0%";
  dom.laserStatus.classList.remove("ready", "charging");
  dom.laserStatus.textContent = "光矛 // 充能中 0%";
  dom.laserButton.classList.remove("ready", "charging");
  dom.laserButton.setAttribute("aria-disabled", "true");
  dom.laserButton.setAttribute("aria-label", "潮汐光矛充能中，能量 0");
  dom.laserButton.style.setProperty("--laser-progress", "0deg");
  dom.stageProgress.style.width = "0%";
  dom.stageName.textContent = STAGE_LABELS[0];
  dom.stageTrack.setAttribute("aria-valuenow", "0");
  state.cameraLookAhead.set(0, 0);
  input.dashBuffer = 0;
  input.laserBuffer = 0;
  input.keys.clear();
  resetJoystick();
  player.position.set(0, -1.2);
  player.velocity.set(0, 0);
  player.facing.set(0, 1);
  clearLaserState();
  player.group.scale.setScalar(PLAYER_VISUAL_SCALE);
  player.group.rotation.z = 0;
  player.group.rotation.y = 0;
  player.flame.scale.setScalar(1);
  player.core.scale.setScalar(1);
  player.coreGlow.scale.setScalar(1);
  player.shield.visible = false;
  player.trailTimer = 0;
  camera.position.set(0, 0, 20);
  camera.rotation.z = 0;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  realmBackgrounds.reset();
  syncPlayerTransform();
  syncHealthPips();
  syncBossProgress(null);
  seedShards();
  audio.suspendBeat();
  enterStage(0, false);
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
  if (!transitionTo("playing", { resumed: true })) return;
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

function getDialogFocusable(dialog) {
  if (!dialog || dialog.hidden) return [];
  return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => (
    !element.hidden && element.getAttribute("aria-hidden") !== "true" && !element.closest("[hidden]")
  ));
}

function trapDialogFocus(event) {
  if (event.key !== "Tab" || !activeDialog || activeDialog.hidden) return false;
  const focusable = getDialogFocusable(activeDialog);
  event.preventDefault();
  if (focusable.length === 0) {
    activeDialog.focus({ preventScroll: true });
    return true;
  }
  const currentIndex = focusable.indexOf(document.activeElement);
  const offset = event.shiftKey ? -1 : 1;
  const nextIndex = currentIndex < 0
    ? (event.shiftKey ? focusable.length - 1 : 0)
    : (currentIndex + offset + focusable.length) % focusable.length;
  focusable[nextIndex].focus({ preventScroll: true });
  return true;
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
  dialog.tabIndex = -1;
  dialog.setAttribute("aria-modal", "true");
  if (dialog === dom.overlay) dialog.classList.add("visible");
  setBackgroundInert(true);
  focusTarget?.focus({ preventScroll: true });
  window.requestAnimationFrame(() => {
    if (activeDialog === dialog) focusTarget?.focus({ preventScroll: true });
  });
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
  const target = candidate && candidate !== document.body && candidate.isConnected ? candidate : dom.pauseButton;
  target?.focus({ preventScroll: true });
  window.requestAnimationFrame(() => {
    if (!activeDialog) {
      target?.focus({ preventScroll: true });
    }
  });
}

function focusGameplaySurface() {
  if (state.mode !== "playing" || activeDialog) return;
  renderer.domElement.focus({ preventScroll: true });
}

function setBackgroundInert(inert) {
  [dom.root, dom.hud, dom.missionPanel, dom.bossPanel, dom.touchControls].forEach((element) => {
    if (element) element.inert = inert;
  });
  dom.pauseButton.disabled = inert;
  dom.muteButton.disabled = inert;
  dom.dashButton.disabled = inert;
  dom.laserButton.disabled = inert;
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
    input.laserBuffer = 0;
    if (nextMode !== "paused") clearLaserState();
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
    window.requestAnimationFrame(focusGameplaySurface);
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
      `在失控的数字海域中收集光核，为潮汐光矛充能并躲开追猎信号。<br />坚持 ${GAME.bossStart} 秒定位深潮主脑，并在 ${GAME.bossWindow} 秒内将其摧毁。`,
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
    const deadlineExpired = state.terminalReason === "bossDeadline";
    showOverlay(
      deadlineExpired ? "SIGNAL LOST // WINDOW CLOSED" : "SIGNAL LOST // HULL BREACH",
      "SIGNAL<br /><em>LOST</em>",
      deadlineExpired
        ? "终幕窗口已经关闭，深潮主脑仍保持稳定，信号链路已经崩解。"
        : "船体已经失效，未能完成终幕目标：定位并摧毁深潮主脑。",
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

function finishRun(outcome, reason = outcome === "victory" ? "bossDestroyed" : "hullBreach") {
  if (state.runFinished || state.mode !== "playing" || !["gameover", "victory"].includes(outcome)) return false;
  state.runFinished = true;
  state.terminalReason = reason;
  while (enemies.length) removeEnemy(enemies.length - 1);
  clearEnvironmentAndProjectiles();
  state.stats.activeHazards = 0;
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
    dashRecoveryMultiplier: 1,
    dashInvulnerability: DASH_ACTIVE_WINDOW,
    pickupWeaponEnergy: LASER_RULES.pickupEnergy,
  };
  for (const id of state.ownedUpgrades) {
    const upgrade = UPGRADES.find((candidate) => candidate.id === id);
    if (!upgrade) continue;
    if (id === "ion-drive") values.speedMultiplier += upgrade.effect;
    if (id === "prism-core") values.scoreMultiplier += upgrade.effect;
    if (id === "echo-shield") values.dashInvulnerability += upgrade.effect;
    if (id === "magnet-field") values.pickupRadiusMultiplier += upgrade.effect;
    if (id === "overclock") values.pickupWeaponEnergy = LASER_RULES.focusedPickupEnergy;
  }
  const lanePenalty = getDataLanePenalty(environmentFrame, player.position);
  if (lanePenalty > 0) values.dashRecoveryMultiplier *= 1 - lanePenalty;
  return values;
}

function addWeaponEnergyFromPickup() {
  const focused = getDerivedValues().pickupWeaponEnergy === LASER_RULES.focusedPickupEnergy;
  const previousWeaponEnergy = state.weaponEnergy;
  state.weaponEnergy = gainWeaponEnergy(state.weaponEnergy, focused);
  laserAudio.onEnergyChange(previousWeaponEnergy, state.weaponEnergy);
  if (canFireLaser(state.weaponEnergy) && !["charge", "active"].includes(state.laserState)) {
    state.laserState = "ready";
  }
  return state.weaponEnergy;
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
  advanceCombo(reward.combo);
  return reward;
}

function applyUpgrade(id) {
  const upgrade = UPGRADES.find((candidate) => candidate.id === id);
  if (!upgrade || state.ownedUpgrades.includes(id)) return false;
  state.ownedUpgrades.push(id);
  if (id === "repair-swarm") {
    state.maxHealth = Math.max(state.maxHealth, 4);
    state.health = Math.min(state.maxHealth, state.health + upgrade.effect);
    syncHealthPips();
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
    "echo-shield": "相位 +0.08 秒",
    "magnet-field": "拾取范围 +25%",
    overclock: "每枚光核充能 +2",
    "repair-swarm": "最大船体 4 · 立即修复 +1",
  };
  const displayNames = {
    "echo-shield": "相位外壳",
  };
  const displayDescriptions = {
    "echo-shield": "延长冲刺相位状态时间。",
  };
  const buttons = options.map((upgrade, index) => {
    const button = document.createElement("button");
    button.className = "upgrade-option";
    button.type = "button";
    button.dataset.upgradeId = upgrade.id;
    button.innerHTML = `<span class="upgrade-number" aria-hidden="true">${index + 1}</span><span class="upgrade-title">${displayNames[upgrade.id] ?? upgrade.name}</span><span class="upgrade-description">${displayDescriptions[upgrade.id] ?? upgrade.description}</span><strong class="upgrade-effect">${effectLabels[upgrade.id] ?? "信号强化"}</strong>`;
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
    const presentation = REALM_PRESENTATION[state.stageIndex];
    showStageBanner(
      presentation?.title ?? STAGES[state.stageIndex].name,
      1.05,
      "stage",
      presentation?.environment,
    );
  }
}

function updateHighScore() {
  state.highScore = Math.max(state.highScore, state.score);
  localStorage.setItem(STORAGE_KEY, String(state.highScore));
}

function updatePlayer(dt) {
  player.hitReactTimer = Math.max(0, player.hitReactTimer - dt);
  const direction = readMoveDirection();
  const derived = getDerivedValues();
  const laserMovementMultiplier = state.laserState === "charge" ? 0.8 : 1;
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
    player.velocity.clampLength(0, BASE_MAX_SPEED * derived.speedMultiplier * laserMovementMultiplier);
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
  const hitStrength = THREE.MathUtils.clamp(player.hitReactTimer / 0.18, 0, 1);
  if (state.reducedMotion) {
    player.group.scale.setScalar(PLAYER_VISUAL_SCALE);
    player.flame.scale.setScalar(1);
    player.core.scale.set(1, 0.72, 1);
    player.coreGlow.scale.set(1.22, 0.76, 1);
  } else {
    const targetScale = (state.dashTimer > 0 ? 1.22 : 1) * PLAYER_VISUAL_SCALE;
    player.group.scale.x = THREE.MathUtils.lerp(player.group.scale.x, targetScale, 1 - Math.exp(-22 * dt));
    player.group.scale.y = THREE.MathUtils.lerp(player.group.scale.y, (state.dashTimer > 0 ? 0.82 : 1) * PLAYER_VISUAL_SCALE, 1 - Math.exp(-22 * dt));
    player.flame.scale.setScalar(flameScale + Math.sin(state.elapsed * 30) * 0.08);
    const laserPrimed = canFireLaser(state.weaponEnergy) || ["charge", "active"].includes(state.laserState);
    const corePulse = 1 + Math.sin(state.elapsed * (laserPrimed ? 16 : 7)) * (laserPrimed ? 0.16 : 0.08);
    player.core.scale.set(1.12 * corePulse, 0.72 * corePulse, 1);
    player.coreGlow.scale.set(1.22 * corePulse * (laserPrimed ? 1.42 : 1.12), 0.76 * corePulse, 1);
  }
  player.flame.material.opacity = 0.48 + Math.min(speed / 5, 1) * 0.45;
  player.flameSegments.forEach((segment, index) => {
    const lengthScale = (0.72 + Math.min(speed / 5, 1) * 0.62) * (1 + (state.dashTimer > 0 ? 0.7 : 0));
    segment.scale.set(1, lengthScale * (1 - index * 0.08), 1);
    segment.material.opacity = (0.48 - index * 0.08) + Math.min(speed / 5, 1) * 0.32;
  });
  player.core.material.color.lerpColors(PLAYER_CORE_IDLE_COLOR, PLAYER_CORE_HIT_COLOR, hitStrength);
  player.coreGlow.material.color.lerpColors(paletteState.primary, PLAYER_CORE_HIT_COLOR, hitStrength * 0.8);
  player.coreGlow.material.opacity = (canFireLaser(state.weaponEnergy) ? 0.42 : 0.22) + hitStrength * 0.52;
  player.glow.material.opacity = canFireLaser(state.weaponEnergy) ? 0.36 : 0.18;
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
  if (state.mode !== "playing" || state.playerAttacking || ["charge", "active"].includes(state.laserState)) return false;
  const chargeIndex = state.dashCharges.findIndex((charge) => charge >= 0.999);
  if (chargeIndex < 0) return false;
  const dashDirection = direction.lengthSq() > 0.01 ? direction.clone().normalize() : player.facing.clone().normalize();
  state.dashCharges[chargeIndex] = 0;
  state.dashTimer = DASH_ACTIVE_WINDOW;
  state.dashInvulnTimer = getDerivedValues().dashInvulnerability;
  state.dashSequence += 1;
  player.facing.copy(dashDirection);
  player.velocity.copy(dashDirection).multiplyScalar(DASH_SPEED * getDerivedValues().speedMultiplier);
  if (state.reducedMotion) player.group.scale.setScalar(PLAYER_VISUAL_SCALE);
  else player.group.scale.set(1.25 * PLAYER_VISUAL_SCALE, 0.78 * PLAYER_VISUAL_SCALE, PLAYER_VISUAL_SCALE);
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
    shard.baseX += shard.velocity.x * dt;
    shard.baseY += shard.velocity.y * dt;
    shard.velocity.multiplyScalar(Math.exp(-2.8 * dt));
    shard.group.position.x = shard.baseX;
    shard.gem.rotation.z += dt * 1.8;
    shard.ring.rotation.z -= dt * 0.8;
    shard.group.position.y = state.reducedMotion
      ? shard.baseY
      : shard.baseY + Math.sin(state.elapsed * 2.5 + shard.phase) * 0.12;
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
  addWeaponEnergyFromPickup();
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

function syncLaserTransform() {
  if (!player.laser) return;
  const direction = state.laserDirection.lengthSq() > 0
    ? state.laserDirection
    : player.facing;
  player.laser.group.position.set(
    player.position.x + direction.x * player.radius,
    player.position.y + direction.y * player.radius,
    3.35,
  );
  player.laser.group.rotation.z = Math.atan2(direction.y, direction.x);
}

function clearLaserState() {
  state.laserElapsed = 0;
  state.laserSequenceTargets = 0;
  state.laserState = canFireLaser(state.weaponEnergy) ? "ready" : "idle";
  if (player.laser) {
    player.laser.group.visible = false;
    player.laser.group.scale.set(0.4, 0.08, 1);
    player.laser.halo.material.opacity = 0.34;
    player.laser.core.material.opacity = 0;
    syncLaserTransform();
  }
  return state.laserState;
}

function getLaserAvailability() {
  if (state.mode === "paused") return { canStart: false, reason: "paused" };
  if (state.mode !== "playing") return { canStart: false, reason: "locked" };
  if (state.laserState === "charge") return { canStart: false, reason: "charge" };
  if (state.laserState === "active") return { canStart: false, reason: "active" };
  if (!canFireLaser(state.weaponEnergy)) return { canStart: false, reason: "charging" };
  if (state.dashTimer > 0 || state.dashInvulnTimer > 0) return { canStart: false, reason: "dash" };
  if (!["idle", "ready"].includes(state.laserState)) return { canStart: false, reason: "conflict" };
  return { canStart: true, reason: "ready" };
}

function canStartLaser() {
  return getLaserAvailability().canStart;
}

function startLaserCharge() {
  if (!canStartLaser()) return false;
  state.weaponEnergy = 0;
  state.laserElapsed = 0;
  state.laserSequence += 1;
  state.laserSequenceTargets = 0;
  state.laserDirection.copy(player.facing);
  if (state.laserDirection.lengthSq() <= 0) state.laserDirection.set(0, 1);
  else state.laserDirection.normalize();
  state.laserState = "charge";
  state.stats.laserShots += 1;
  player.laser.group.visible = true;
  player.laser.group.scale.set(0.4, 0.08, 1);
  player.laser.halo.material.color.copy(paletteState.primary);
  player.laser.halo.material.opacity = 0.34;
  player.laser.core.material.color.set(0xffffff);
  player.laser.core.material.opacity = 0.24;
  syncLaserTransform();
  spawnRipple(player.position, paletteState.primary.getHex(), 0.72);
  toast("光矛蓄力", "cyan");
  laserAudio.onChargeStarted();
  return true;
}

function attemptLaser() {
  input.laserBuffer = 0;
  return startLaserCharge();
}

function interruptLaserTarget(enemy) {
  if (enemy.type === "boss" || typeof enemy.state !== "string") return false;
  const interruptible = ["telegraph", "chargeTelegraph", "shockTelegraph"]
    .some((stateName) => enemy.state.includes(stateName));
  if (!interruptible) return false;
  enemy.visuals?.line && (enemy.visuals.line.visible = false);
  enemy.visuals?.chargeArc && (enemy.visuals.chargeArc.visible = false);
  enemy.visuals?.chargeArc?.children.forEach((segment) => { segment.visible = false; });
  enemy.visuals?.shockwave && (enemy.visuals.shockwave.visible = false);
  enemy.visuals?.body?.scale?.setScalar(1);
  setEnemyState(enemy, "recover", 0.5);
  state.stats.laserInterrupts += 1;
  return true;
}

function isEnemyAttackExecuting(enemy) {
  if (!enemy || typeof enemy.state !== "string") return false;
  if (enemy.type === "boss") return enemy.state === "execute";
  return ["active", "detonate", "charge", "dash", "shockExecute", "armorCounterExecute"].includes(enemy.state);
}

function deferOrDestroyLaserTarget(enemy) {
  if (enemy.hp > 0) return false;
  if (isEnemyAttackExecuting(enemy)) {
    enemy.pendingLaserDeath = true;
    enemy.pendingDeathSource = "laser";
    return true;
  }
  destroyEnemy(enemy, "laser");
  return true;
}

function resolveLaserHits() {
  if (state.laserState !== "active") return 0;
  const remainingTargets = Math.max(0, LASER_RULES.maxTargets - state.laserSequenceTargets);
  const originX = player.position.x + state.laserDirection.x * player.radius;
  const originY = player.position.y + state.laserDirection.y * player.radius;
  const beam = {
    originX,
    originY,
    directionX: state.laserDirection.x,
    directionY: state.laserDirection.y,
  };
  const candidates = enemies
    .filter((enemy) => enemy && !enemy.dead && !enemy.pendingLaserDeath && enemy.lastLaserSequence !== state.laserSequence)
    .filter((enemy) => laserHitsCircle(beam, {
      x: enemy.group.position.x,
      y: enemy.group.position.y,
      radius: enemy.radius,
    }))
    .map((enemy) => ({
      enemy,
      along: ((enemy.group.position.x - originX) * state.laserDirection.x)
        + ((enemy.group.position.y - originY) * state.laserDirection.y),
    }));
  const ordinaryTargets = selectLaserTargets(candidates.filter(({ enemy }) => enemy.type !== "boss")).slice(0, remainingTargets);
  const bossTargets = candidates
    .filter(({ enemy }) => enemy.type === "boss")
    .sort((left, right) => left.along - right.along)
    .slice(0, 1);
  const targets = [...ordinaryTargets, ...bossTargets].sort((left, right) => left.along - right.along);
  for (const { enemy } of targets) {
    enemy.lastLaserSequence = state.laserSequence;
    enemy.hp -= ENEMY_TYPES[enemy.type]?.laserDamage ?? 1;
    state.stats.laserHits += 1;
    if (enemy.type !== "boss") state.laserSequenceTargets += 1;
    interruptLaserTarget(enemy);
    enemy.hitReactTimer = 0.18;
    if (enemy.type === "boss") {
      syncBossProgress(enemy);
      if (enemy.hp > 0 && enemy.state === "execute" && enemy.hp < enemy.maxHp * 0.5) {
        enemy.laserPhaseTwoPending = true;
      } else if (enemy.hp > 0) {
        enterBossPhaseTwo(enemy);
      }
    }
    tryStartBulwarkArmorCounter(enemy, "laser", state.laserSequence);
    const hitPosition = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
    spawnParticleBurst(hitPosition, enemy.type === "boss" ? 0xe7ffff : paletteState.primary.getHex(), enemy.type === "boss" ? 10 : 6, 3.2, 0.78);
    deferOrDestroyLaserTarget(enemy);
  }
  if (targets.length > 0) {
    state.stats.laserPeakTargets = Math.max(state.stats.laserPeakTargets, state.laserSequenceTargets);
    const feedbackPosition = player.position.clone().addScaledVector(state.laserDirection, Math.min(LASER_RULES.length, 4.2));
    showFloatingText(`PIERCE ×${state.laserSequenceTargets}`, feedbackPosition, "cyan", "medium");
  }
  return targets.length;
}

function updateLaser(dt) {
  if (!["charge", "active"].includes(state.laserState)) return state.laserState;
  const previousPhase = state.laserState;
  state.laserElapsed += Math.max(0, Number.isFinite(dt) ? dt : 0);
  const phase = getLaserPhase(state.laserElapsed);
  if (phase === "done") {
    clearLaserState();
    return state.laserState;
  }
  state.laserState = phase;
  laserAudio.onPhaseChange(previousPhase, phase);
  syncLaserTransform();
  player.laser.group.visible = true;
  player.laser.halo.material.color.copy(paletteState.primary);
  if (phase === "charge") {
    const progress = THREE.MathUtils.clamp(state.laserElapsed / LASER_RULES.chargeDuration, 0, 1);
    player.laser.group.scale.set(
      THREE.MathUtils.lerp(0.4, LASER_RULES.length, progress),
      THREE.MathUtils.lerp(0.08, LASER_RULES.width, progress),
      1,
    );
    player.laser.core.material.opacity = 0.18 + progress * 0.34;
    player.velocity.clampLength(0, BASE_MAX_SPEED * getDerivedValues().speedMultiplier * 0.8);
  } else {
    const activeElapsed = Math.max(0, state.laserElapsed - LASER_RULES.chargeDuration);
    player.laser.group.scale.set(LASER_RULES.length, LASER_RULES.width, 1);
    player.laser.core.material.opacity = 0.18 + Math.max(0, 1 - activeElapsed / 0.08) * 0.82;
    laserAudio.onHits(resolveLaserHits());
  }
  return state.laserState;
}

function setEnemyState(enemy, nextState, duration = 0, telegraph = 0) {
  enemy.state = nextState;
  enemy.stateTimer = duration;
  enemy.telegraph = telegraph;
}

function recordRealmAttack(role) {
  state.stats.realmAttackRoles[role] = (state.stats.realmAttackRoles[role] ?? 0) + 1;
  return state.stats.realmAttackRoles[role];
}

function steerEnemy(enemy, toPlayer, dt, speed = enemy.speed, response = 2.8, wobbleStrength = 0.2) {
  const laneResponse = getDataLanePenalty(environmentFrame, enemy.group.position) > 0 ? 1.15 : 1;
  const steering = enemyScratch.steering.copy(toPlayer).multiplyScalar(speed);
  if (wobbleStrength > 0) {
    enemyScratch.perpendicular.set(-toPlayer.y, toPlayer.x)
      .multiplyScalar(Math.sin(state.elapsed * 2.2 + enemy.wobble) * wobbleStrength);
    steering.add(enemyScratch.perpendicular);
  }
  enemy.velocity.lerp(steering, 1 - Math.exp(-response * laneResponse * dt));
}

function updateChaser(enemy, dt, toPlayer) {
  enemy.stateTimer -= dt;
  if (enemy.state === "chase") {
    steerEnemy(enemy, toPlayer, dt, enemy.speed, 3.4, 0.16);
    if (enemy.stateTimer <= 0) {
      enemy.intentIndex = (enemy.intentIndex + 1) % 3;
      if (enemy.intentIndex === 1) setEnemyState(enemy, "flank", 1.35);
      else if (enemy.intentIndex === 2) {
        enemy.dashDirection.copy(toPlayer);
        setEnemyState(enemy, "chargeTelegraph", 0.52, 0.52);
      } else setEnemyState(enemy, "chase", 2.0 + Math.random() * 0.8);
    }
  } else if (enemy.state === "flank") {
    const flankTarget = enemyScratch.target.copy(toPlayer);
    enemyScratch.perpendicular.set(-toPlayer.y, toPlayer.x)
      .multiplyScalar((enemy.intentIndex % 2 ? 1 : -1) * 0.9);
    flankTarget.add(enemyScratch.perpendicular).normalize();
    steerEnemy(enemy, flankTarget, dt, enemy.speed * 1.05, 3.5, 0.05);
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "chase", 1.4 + Math.random() * 0.8);
  } else if (enemy.state === "chargeTelegraph") {
    enemy.velocity.multiplyScalar(Math.exp(-10 * dt));
    enemy.group.rotation.z = Math.atan2(enemy.dashDirection.y, enemy.dashDirection.x) - Math.PI / 2;
    const warning = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 30) * 0.1;
    enemy.visuals.body.scale.setScalar(warning);
    enemy.visuals.chargeArc.visible = true;
    const progress = 1 - THREE.MathUtils.clamp(enemy.stateTimer / 0.52, 0, 1);
    enemy.visuals.chargeArc.children.forEach((segment, index) => {
      segment.visible = state.reducedMotion ? index === Math.min(2, Math.floor(progress * 3)) : true;
      segment.material.opacity = state.reducedMotion ? 0.72 : 0.3 + progress * (0.22 + index * 0.08);
      segment.scale.y = (0.34 + index * 0.18) * (0.8 + progress * 0.65);
    });
    if (state.reducedMotion) applyDiscreteWarning(enemy.visuals.chargeArc.children[Math.min(2, Math.floor(progress * 3))]?.material, enemy.stateTimer, 0.52);
    if (enemy.stateTimer <= 0) {
      enemy.visuals.body.scale.setScalar(1);
      enemy.visuals.chargeArc.visible = false;
      enemy.visuals.chargeArc.children.forEach((segment) => { segment.visible = false; });
      enemy.velocity.copy(enemy.dashDirection).multiplyScalar(8.8 + state.elapsed * 0.035);
      setEnemyState(enemy, "charge", 0.36);
    }
  } else if (enemy.state === "charge") {
    enemy.visuals.chargeArc.visible = false;
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "chase", 2.1 + Math.random() * 0.7);
  } else if (enemy.state === "recover") {
    enemy.velocity.multiplyScalar(Math.exp(-5.5 * dt));
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "chase", 1.4 + Math.random() * 0.8);
  }
  const pulse = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 4 + enemy.wobble) * 0.08;
  enemy.visuals.glow.scale.setScalar(1.45 * pulse);
}

function updateStriker(enemy, dt, toPlayer) {
  enemy.stateTimer -= dt;
  if (enemy.state === "track") {
    steerEnemy(enemy, toPlayer, dt, enemy.speed, 3.8, 0.14);
    if (enemy.stateTimer <= 0) {
      enemy.selectedLane = Math.abs(Math.trunc(enemy.intentIndex ?? 0)) % 3;
      enemy.aimDirection.copy(toPlayer);
      enemy.dashDirection.copy(enemy.aimDirection).rotateAround(new THREE.Vector2(0, 0), [-0.18, 0, 0.18][enemy.selectedLane]);
      enemy.visuals.lines.forEach((line) => { line.visible = true; });
      setEnemyState(enemy, "telegraph", 0.55, 0.55);
    }
  } else if (enemy.state === "telegraph") {
    enemy.telegraph = Math.max(0, enemy.stateTimer);
    enemy.velocity.multiplyScalar(Math.exp(-10 * dt));
    enemy.group.rotation.z = Math.atan2(enemy.aimDirection.y, enemy.aimDirection.x) - Math.PI / 2;
    if (state.reducedMotion) enemy.visuals.lines.forEach((line) => applyDiscreteWarning(line.material, enemy.telegraph, 0.55));
    else {
      enemy.visuals.lines.forEach((line) => {
        line.material.color.set(0xff7ae6);
        line.material.opacity = 0.72;
      });
    }
    const telegraphScale = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 32) * 0.12;
    enemy.visuals.body.scale.setScalar(telegraphScale);
    if (enemy.stateTimer <= 0) {
      enemy.visuals.lines.forEach((line, index) => { line.visible = index === 1; });
      enemy.visuals.body.scale.setScalar(1);
      enemy.velocity.copy(enemy.dashDirection).multiplyScalar(18 + Math.min(2, state.elapsed * 0.01));
      enemy.group.rotation.z = Math.atan2(enemy.dashDirection.y, enemy.dashDirection.x) - Math.PI / 2;
      enemy.intentIndex = (enemy.intentIndex + 1) % 3;
      recordRealmAttack("Striker");
      setEnemyState(enemy, "dash", 0.44);
    }
  } else if (enemy.state === "dash") {
    if (enemy.stateTimer <= 0) {
      enemy.visuals.lines.forEach((line) => { line.visible = false; });
      setEnemyState(enemy, "recover", 0.54);
    }
  } else if (enemy.state === "recover") {
    enemy.velocity.multiplyScalar(Math.exp(-5.5 * dt));
    if (enemy.stateTimer <= 0) {
      enemy.visuals.lines.forEach((line) => { line.visible = false; });
      setEnemyState(enemy, "track", 0.7 + Math.random() * 0.6);
    }
  }
}

function updateLancer(enemy, dt, toPlayer) {
  enemy.stateTimer -= dt;
  enemy.visuals.reticle.rotation.z += state.reducedMotion ? 0 : dt * 1.7;
  enemy.visuals.reticle.scale.setScalar(state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 5 + enemy.wobble) * 0.08);
  if (enemy.state === "lock") {
    steerEnemy(enemy, toPlayer, dt, enemy.speed, 1.5, 0);
    if (enemy.stateTimer <= 0) {
      enemy.beamDirection.copy(toPlayer);
      enemy.group.rotation.z = Math.atan2(enemy.beamDirection.y, enemy.beamDirection.x) - Math.PI / 2;
      enemy.visuals.line.visible = true;
      setEnemyState(enemy, "telegraph", 0.7, 0.7);
    }
  } else if (enemy.state === "telegraph") {
    enemy.velocity.multiplyScalar(Math.exp(-12 * dt));
    enemy.telegraph = Math.max(0, enemy.stateTimer);
    const progress = 1 - enemy.telegraph / 0.7;
    enemy.visuals.line.scale.set(0.06 + progress * 0.1, 1, 1);
    if (state.reducedMotion) applyDiscreteWarning(enemy.visuals.line.material, enemy.telegraph, 0.7);
    else {
      enemy.visuals.line.material.color.set(0xff9f43);
      enemy.visuals.line.material.opacity = 0.55 + progress * 0.3;
    }
    if (enemy.stateTimer <= 0) {
      enemy.visuals.line.visible = false;
      enemy.visuals.beam.visible = true;
      enemy.visuals.beam.scale.set(0.2, 1, 1);
      enemy.beamWidth = 0.2;
      setEnemyState(enemy, "active", 0.7);
    }
  } else if (enemy.state === "active") {
    enemy.visuals.beam.visible = true;
    const progress = 1 - Math.max(0, enemy.stateTimer / 0.7);
    enemy.beamWidth = 0.2 + progress * 0.5;
    enemy.visuals.beam.scale.set(enemy.beamWidth, 1, 1);
    enemy.visuals.beam.material.color.set(state.reducedMotion ? 0xff9f43 : 0xff506f);
    enemy.visuals.beam.material.opacity = state.reducedMotion ? 0.7 : 0.84 + progress * 0.12;
    state.stats.activeHazards += 1;
    if (enemy.stateTimer <= 0) {
      enemy.visuals.beam.visible = false;
      if (state.stageIndex >= 1) {
        for (const angle of [-0.18, 0, 0.18]) {
          spawnProjectile("lancerBolt", enemy.group.position, enemy.beamDirection.clone().rotateAround(new THREE.Vector2(0, 0), angle), {
            speed: 3.2,
            life: 2.4,
            damage: 1,
          });
        }
        recordRealmAttack("Lancer");
      }
      setEnemyState(enemy, "recover", 0.85);
    }
  } else if (enemy.state === "recover") {
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "lock", 1.3 + Math.random() * 0.7);
  }
}

function updateSwarm(enemy, dt, toPlayer) {
  enemy.stateTimer -= dt;
  if (enemy.state === "ingress") {
    steerEnemy(enemy, toPlayer, dt, enemy.speed, 4.2, 0.08);
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "split", 0.78);
  } else if (enemy.state === "split") {
    const target = enemyScratch.target.copy(toPlayer);
    enemyScratch.perpendicular.set(-toPlayer.y, toPlayer.x).multiplyScalar(enemy.wingSign * 0.85);
    target.add(enemyScratch.perpendicular).normalize();
    steerEnemy(enemy, target, dt, enemy.speed * 1.08, 4.4, 0.04);
    enemy.group.rotation.z += enemy.wingSign * dt * 1.7;
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "pursuit", 1.6 + Math.random() * 1.2);
  } else if (enemy.state === "pursuit") {
    steerEnemy(enemy, toPlayer, dt, enemy.speed * 1.12, 4.2, 0.12);
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "ingress", 0.6 + Math.random() * 0.6);
  }
  const pulse = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 12 + enemy.wobble) * 0.12;
  enemy.visuals.glow.scale.setScalar(0.84 * pulse);
}

function updateMine(enemy, dt) {
  if (!(enemy.state === "chainTelegraph" && enemy.chainQueuedFrame === state.combatFrame)) enemy.stateTimer -= dt;
  enemy.group.rotation.z += dt * (enemy.state === "arming" ? 0.8 : 2.5);
  if (enemy.state === "arming" || enemy.state === "chainTelegraph") {
    enemy.telegraph = Math.max(0, enemy.stateTimer);
    const telegraphDuration = enemy.state === "chainTelegraph" ? Math.max(0.45, enemy.chainDelay) : 1.1;
    if (state.reducedMotion) applyDiscreteWarning(enemy.visuals.ring.material, enemy.telegraph, telegraphDuration);
    else {
      enemy.visuals.ring.material.color.set(0xff9f43);
      enemy.visuals.ring.material.opacity = 0.62;
    }
    const progress = 1 - THREE.MathUtils.clamp(enemy.telegraph / telegraphDuration, 0, 1);
    enemy.visuals.ring.scale.setScalar(0.85 + progress * 0.3);
    enemy.visuals.tick.scale.setScalar(0.8 + progress * 0.55);
    enemy.visuals.tick.material.opacity = state.reducedMotion ? 0.55 : 0.32 + progress * 0.44;
    if (enemy.stateTimer <= 0) {
      enterMineDetonate(enemy);
    }
  } else if (enemy.state === "detonate") {
    const frame = getMineDetonationFrame(enemy.stateTimer, state.reducedMotion);
    enemy.previousDangerRadius = enemy.dangerRadius;
    if (frame.stage !== enemy.detonationStage) {
      enemy.detonationStage = frame.stage;
      enemy.pulseHit = false;
    }
    enemy.dangerRadius = frame.radius;
    enemy.visuals.ring.scale.setScalar(enemy.dangerRadius / 0.9);
    enemy.visuals.tick.scale.setScalar(1.4 + frame.stage * 0.85 + frame.stageProgress * 0.35);
    enemy.visuals.ring.material.color.set([0xff9f43, 0xff6f61, 0xff506f][frame.stage]);
    enemy.visuals.ring.material.opacity = state.reducedMotion ? 0.72 : 0.64 + frame.stageProgress * 0.2;
    enemy.visuals.tick.material.color.set([0xffd166, 0xff9f43, 0xff506f][frame.stage]);
    enemy.visuals.tick.material.opacity = state.reducedMotion ? 0.68 : 0.46 + frame.stageProgress * 0.32;
    const glowScale = state.reducedMotion ? 1.55 + frame.stage * 0.38 : 1.45 + frame.stage * 0.42 + frame.stageProgress * 0.28;
    enemy.visuals.glow.scale.setScalar(glowScale);
    state.stats.activeHazards += 1;
    if (enemy.stateTimer <= 0) {
      if (enemy.pendingLaserDeath) setEnemyState(enemy, "spent", 0);
      else enemy.dead = true;
    }
  }
}

function enqueueMineChain(source) {
  if (!source || source.chainTriggered) return 0;
  source.chainTriggered = true;
  const neighbors = enemies
    .filter((enemy) => enemy !== source && enemy.type === "mine" && !enemy.dead && ["arming", "chainTelegraph"].includes(enemy.state))
    .map((enemy) => ({ enemy, distance: enemy.group.position.distanceTo(source.group.position) }))
    .filter(({ distance }) => distance <= 3.2)
    .sort((left, right) => left.distance - right.distance);
  neighbors.forEach(({ enemy }, chainIndex) => {
    const delay = 0.45 + chainIndex * 0.12;
    const existingDelay = enemy.state === "chainTelegraph" ? finiteOr(enemy.chainDelay, 0) : 0;
    enemy.chainDelay = Math.max(existingDelay, delay);
    enemy.chainQueuedFrame = state.combatFrame;
    enemy.chainTriggered = false;
    enemy.attackRecorded = false;
    if (enemy.state === "chainTelegraph") {
      enemy.stateTimer = Math.max(enemy.stateTimer, enemy.chainDelay);
      enemy.telegraph = Math.max(enemy.telegraph, enemy.chainDelay);
    } else {
      setEnemyState(enemy, "chainTelegraph", enemy.chainDelay, enemy.chainDelay);
    }
  });
  return neighbors.length;
}

function enterMineDetonate(enemy) {
  enemy.previousDangerRadius = 0;
  enemy.dangerRadius = 0;
  enemy.detonationStage = -1;
  setEnemyState(enemy, "detonate", 0.78);
  if (!enemy.attackRecorded) {
    enemy.attackRecorded = true;
    recordRealmAttack("Mine");
  }
  enqueueMineChain(enemy);
  return enemy;
}

function updateElite(enemy, dt, toPlayer) {
  enemy.stateTimer -= dt;
  enemy.shockTimer -= dt;
  enemy.counterCooldown = Math.max(0, finiteOr(enemy.counterCooldown, 0) - dt);
  if (enemy.state === "chase") {
    steerEnemy(enemy, toPlayer, dt, enemy.speed, 2.8, 0.08);
    if (enemy.stateTimer <= 0 && enemy.dashCharges > 0) {
      enemy.dashDirection.copy(toPlayer);
      enemy.velocity.copy(enemy.dashDirection).multiplyScalar(7.6);
      enemy.dashCharges -= 1;
      setEnemyState(enemy, "dash", 0.42);
    } else if (enemy.shockTimer <= 0) {
      enemy.shockPreviousRadius = 0;
      enemy.shockRadius = 0.3;
      enemy.pulseHit = false;
      enemy.visuals.shockwave.visible = true;
      setEnemyState(enemy, "shockTelegraph", 0.64, 0.64);
      enemy.shockTimer = 3.9 + Math.random() * 0.35;
    }
  } else if (enemy.state === "dash") {
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "chase", 1.0 + Math.random() * 0.7);
  } else if (enemy.state === "shockTelegraph") {
    enemy.velocity.multiplyScalar(Math.exp(-10 * dt));
    enemy.telegraph = Math.max(0, enemy.stateTimer);
    const progress = 1 - enemy.telegraph / 0.64;
    enemy.visuals.shockwave.scale.setScalar(0.65 + progress * 0.35);
    if (state.reducedMotion) applyDiscreteWarning(enemy.visuals.shockwave.material, enemy.telegraph, 0.64);
    else {
      enemy.visuals.shockwave.material.color.set(0xff9f43);
      enemy.visuals.shockwave.material.opacity = 0.48 + progress * 0.35;
    }
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "shockExecute", 0.72);
  } else if (enemy.state === "shockExecute") {
    const progress = 1 - Math.max(0, enemy.stateTimer / 0.72);
    enemy.shockPreviousRadius = enemy.shockRadius;
    enemy.shockRadius = THREE.MathUtils.lerp(0.6, 6.0, progress);
    enemy.visuals.shockwave.scale.setScalar(enemy.shockRadius / 0.88);
    enemy.visuals.shockwave.material.color.set(0xff506f);
    enemy.visuals.shockwave.material.opacity = state.reducedMotion ? 0.65 : 0.62 + (1 - progress) * 0.2;
    state.stats.activeHazards += 1;
    if (enemy.stateTimer <= 0) {
      enemy.visuals.shockwave.visible = false;
      setEnemyState(enemy, "chase", 1.1 + Math.random() * 0.7);
    }
  } else if (enemy.state === "armorCounterTelegraph") {
    enemy.velocity.multiplyScalar(Math.exp(-12 * dt));
    enemy.telegraph = Math.max(0, enemy.stateTimer);
    const progress = 1 - THREE.MathUtils.clamp(enemy.telegraph / 0.55, 0, 1);
    enemy.visuals.shockwave.visible = true;
    enemy.visuals.shockwave.scale.setScalar(0.62 + progress * 0.5);
    if (state.reducedMotion) applyDiscreteWarning(enemy.visuals.shockwave.material, enemy.telegraph, 0.55);
    else {
      enemy.visuals.shockwave.material.color.set(0x64f5ff);
      enemy.visuals.shockwave.material.opacity = 0.5 + progress * 0.36;
    }
    if (enemy.stateTimer <= 0) {
      enemy.shockPreviousRadius = 0;
      enemy.shockRadius = 0.45;
      enemy.pulseHit = false;
      setEnemyState(enemy, "armorCounterExecute", 0.32);
    }
  } else if (enemy.state === "armorCounterExecute") {
    const progress = 1 - THREE.MathUtils.clamp(enemy.stateTimer / 0.32, 0, 1);
    enemy.shockPreviousRadius = enemy.shockRadius;
    enemy.shockRadius = THREE.MathUtils.lerp(0.45, 3.8, progress);
    enemy.visuals.shockwave.visible = true;
    enemy.visuals.shockwave.scale.setScalar(enemy.shockRadius / 0.88);
    enemy.visuals.shockwave.material.color.set(0xe7ffff);
    enemy.visuals.shockwave.material.opacity = state.reducedMotion ? 0.7 : 0.78 - progress * 0.32;
    state.stats.activeHazards += 1;
    if (enemy.stateTimer <= 0) {
      enemy.visuals.shockwave.visible = false;
      enemy.counterCooldown = 0;
      setEnemyState(enemy, "recover", 0.4);
    }
  } else if (enemy.state === "recover") {
    enemy.velocity.multiplyScalar(Math.exp(-5.5 * dt));
    enemy.visuals.shockwave.visible = false;
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "chase", 1.1 + Math.random() * 0.7);
  }
  enemy.visuals.shield.rotation.z += dt * 1.4;
  enemy.visuals.outer.rotation.z -= dt * 0.9;
  const shieldScale = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 5 + enemy.wobble) * 0.07;
  enemy.visuals.shield.scale.setScalar(shieldScale);
}

function tryStartBulwarkArmorCounter(enemy, source, attackId) {
  if (!enemy || enemy.type !== "bulwark" || enemy.hp <= 0) return false;
  const token = `${source}:${attackId}`;
  if (enemy.counterHitToken === token || enemy.counterCooldown > 0) return false;
  if (["shockExecute", "armorCounterTelegraph", "armorCounterExecute"].includes(enemy.state)) return false;
  enemy.counterHitToken = token;
  enemy.counterCooldown = 0.8;
  enemy.shockPreviousRadius = 0;
  enemy.shockRadius = 0.3;
  enemy.pulseHit = false;
  enemy.visuals.shockwave.visible = true;
  recordRealmAttack("Bulwark");
  setEnemyState(enemy, "armorCounterTelegraph", 0.55, 0.55);
  return true;
}

function recordBossAttack(enemy, kind) {
  const entry = Object.freeze({ kind, phase: enemy.phase, elapsed: Number(state.elapsed.toFixed(2)) });
  state.stats.bossAttackLog.push(entry);
  if (state.stats.bossAttackLog.length > 24) state.stats.bossAttackLog.shift();
  return entry;
}

function clearBossAttackVisuals(enemy) {
  enemy.visuals.line.visible = false;
  enemy.visuals.shardLines.children.forEach((line) => { line.visible = false; });
  enemy.visuals.pulseRing.visible = false;
  enemy.visuals.trianglePulse.visible = false;
  enemy.visuals.line.scale.set(0.08, 1, 1);
  enemy.dangerRadius = 0;
  enemy.previousDangerRadius = 0;
  enemy.pulseHit = false;
}

function spawnBossSwarm(enemy, flanks = false) {
  const availableSlots = Math.max(0, Math.min(flanks ? 4 : 3, getEnemyCap() - enemies.length));
  for (let index = 0; index < availableSlots; index += 1) {
    const side = index % 2 ? 1 : -1;
    const position = flanks
      ? new THREE.Vector2(side * (view.halfWidth - 1.5), 2.7 - Math.floor(index / 2) * 1.25)
      : new THREE.Vector2(
        enemy.group.position.x + Math.cos((index / Math.max(1, availableSlots)) * TAU + enemy.wobble) * 2.9,
        enemy.group.position.y + Math.sin((index / Math.max(1, availableSlots)) * TAU + enemy.wobble) * 1.9
      );
    createSwarm(position, side);
  }
}

function enterBossPhaseTwo(enemy) {
  if (!enemy || enemy.phase2Triggered || enemy.hp >= enemy.maxHp * 0.5) return false;
  enemy.phase = 2;
  enemy.phase2Triggered = true;
  enemy.attackIndex = 0;
  enemy.pulseHit = false;
  clearBossAttackVisuals(enemy);
  enemy.previousDangerRadius = 0;
  enemy.dangerRadius = 0;
  state.stats.bossPhase = 2;
  recordBossAttack(enemy, "phase2-enter");
  toast("守卫失稳 · 横扫协议启动", "danger");
  triggerFeedback("large", {
    position: new THREE.Vector2(enemy.group.position.x, enemy.group.position.y),
    color: 0xff7ae6,
    particles: 20,
    speed: 3.8,
    size: 1.12,
    rippleScale: 2.3,
    flashColor: "#ff7ae6",
    flashOpacity: 0.17,
    text: "PHASE II",
    tone: "danger",
  });
  setEnemyState(enemy, "recover", 0.74);
  return true;
}

function beginBossTelegraph(enemy) {
  const attackPool = enemy.phase === 2
    ? ["sweepBeam", "voidShards", "trianglePulse", "flankSwarm"]
    : ["charge", "doublePulse", "summonSwarm"];
  clearBossAttackVisuals(enemy);
  enemy.attackKind = attackPool[enemy.attackIndex % attackPool.length];
  enemy.attackIndex += 1;
  enemy.pulseHit = false;
  enemy.pulseIndex = -1;
  enemy.attackElapsed = 0;
  enemy.previousDangerRadius = 0;
  enemy.dangerRadius = 0;
  const lineAttack = enemy.attackKind === "charge" || enemy.attackKind === "sweepBeam";
  const shardAttack = enemy.attackKind === "voidShards";
  enemy.visuals.line.visible = lineAttack;
  enemy.visuals.shardLines.children.forEach((line) => { line.visible = shardAttack; });
  enemy.visuals.pulseRing.visible = !lineAttack && !shardAttack && enemy.attackKind !== "trianglePulse";
  enemy.visuals.trianglePulse.visible = enemy.attackKind === "trianglePulse";
  if (enemy.attackKind === "charge") enemy.dashDirection.copy(player.position).sub(enemy.group.position).normalize();
  if (enemy.attackKind === "sweepBeam") {
    enemy.beamDirection.copy(player.position).sub(enemy.group.position).normalize();
    enemy.beamStartAngle = Math.atan2(enemy.beamDirection.y, enemy.beamDirection.x) - 1.12;
    enemy.beamEndAngle = enemy.beamStartAngle + 2.24;
  }
  if (enemy.attackKind === "voidShards") {
    enemy.beamDirection.copy(player.position).sub(enemy.group.position).normalize();
    enemy.group.rotation.z = Math.atan2(enemy.beamDirection.y, enemy.beamDirection.x) - Math.PI / 2;
  }
  if (enemy.attackKind === "trianglePulse") {
    enemy.triangleBaseAngle = Math.atan2(
      player.position.y - enemy.group.position.y,
      player.position.x - enemy.group.position.x
    );
    enemy.triangleDirection.set(Math.cos(enemy.triangleBaseAngle), Math.sin(enemy.triangleBaseAngle));
  }
  recordBossAttack(enemy, enemy.attackKind);
  state.stats.bossAttackTelegraphs.push(BOSS_TELEGRAPH_TIME);
  if (state.stats.bossAttackTelegraphs.length > 24) state.stats.bossAttackTelegraphs.shift();
  setEnemyState(enemy, "telegraph", BOSS_TELEGRAPH_TIME, BOSS_TELEGRAPH_TIME);
}

function beginBossExecute(enemy) {
  const attack = enemy.attackKind;
  enemy.visuals.line.visible = attack === "sweepBeam";
  enemy.visuals.shardLines.children.forEach((line) => { line.visible = false; });
  if (attack === "charge") {
    enemy.velocity.copy(enemy.dashDirection).multiplyScalar(9.5);
    setEnemyState(enemy, "execute", 0.72);
  } else if (attack === "doublePulse" || attack === "pulse") {
    enemy.dangerRadius = 0.9;
    enemy.pulseIndex = -1;
    setEnemyState(enemy, "execute", 1.44);
  } else if (attack === "trianglePulse") {
    enemy.dangerRadius = 0.9;
    enemy.pulseIndex = -1;
    enemy.visuals.trianglePulse.visible = true;
    setEnemyState(enemy, "execute", 1.92);
  } else if (attack === "sweepBeam") {
    enemy.beamWidth = 0.3;
    setEnemyState(enemy, "execute", 1.16);
  } else if (attack === "voidShards") {
    for (const angle of [-0.28, -0.14, 0, 0.14, 0.28]) {
      spawnProjectile("voidShard", enemy.group.position, enemy.beamDirection.clone().rotateAround(new THREE.Vector2(0, 0), angle), {
        speed: 4.1,
        damage: 1,
      });
    }
    recordRealmAttack("Boss");
    setEnemyState(enemy, "execute", 0.64);
  } else {
    spawnBossSwarm(enemy, attack === "flankSwarm");
    setEnemyState(enemy, "execute", 0.64);
  }
}

function updateBoss(enemy, dt) {
  if (enemy.laserPhaseTwoPending && enemy.state !== "execute") {
    enemy.laserPhaseTwoPending = false;
    if (enterBossPhaseTwo(enemy)) return;
  }
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
    if (enemy.attackKind === "charge" || enemy.attackKind === "sweepBeam") {
      if (enemy.attackKind === "sweepBeam") {
        enemy.group.rotation.z = Math.atan2(enemy.beamDirection.y, enemy.beamDirection.x) - Math.PI / 2;
      } else {
        enemy.group.rotation.z = Math.atan2(enemy.dashDirection.y, enemy.dashDirection.x) - Math.PI / 2;
      }
      if (state.reducedMotion) applyDiscreteWarning(enemy.visuals.line.material, enemy.telegraph, BOSS_TELEGRAPH_TIME);
      else {
        enemy.visuals.line.material.color.set(0xff7ae6);
        enemy.visuals.line.material.opacity = 0.72;
      }
      const lineProgress = 1 - enemy.telegraph / BOSS_TELEGRAPH_TIME;
      enemy.visuals.line.scale.set(enemy.attackKind === "sweepBeam" ? 0.08 + lineProgress * 0.12 : 0.08, 1, 1);
    } else if (enemy.attackKind === "voidShards") {
      const progress = 1 - enemy.telegraph / BOSS_TELEGRAPH_TIME;
      enemy.visuals.shardLines.children.forEach((line, index) => {
        line.visible = true;
        line.scale.y = 0.86 + progress * (0.2 + index * 0.035);
        if (state.reducedMotion) applyDiscreteWarning(line.material, enemy.telegraph, BOSS_TELEGRAPH_TIME);
        else {
          line.material.color.set(0xff4fba);
          line.material.opacity = 0.42 + progress * 0.42;
        }
      });
    } else {
      const warningScale = state.reducedMotion
        ? 1.85
        : 1 + (1 - enemy.telegraph / BOSS_TELEGRAPH_TIME) * 2.1;
      const warningMesh = enemy.attackKind === "trianglePulse" ? enemy.visuals.trianglePulse : enemy.visuals.pulseRing;
      warningMesh.scale.setScalar(warningScale);
      if (enemy.attackKind === "trianglePulse") warningMesh.rotation.z = Math.atan2(enemy.triangleDirection.y, enemy.triangleDirection.x) - Math.PI / 2;
      if (state.reducedMotion) applyDiscreteWarning(warningMesh.material, enemy.telegraph, BOSS_TELEGRAPH_TIME);
      else {
        warningMesh.material.color.set(0xff9f43);
        warningMesh.material.opacity = 0.72;
      }
    }
    if (enemy.stateTimer <= 0) beginBossExecute(enemy);
  } else if (enemy.state === "execute") {
    enemy.attackElapsed += dt;
    if (["doublePulse", "pulse", "trianglePulse"].includes(enemy.attackKind)) {
      const duration = enemy.attackKind === "trianglePulse" ? 1.92 : 1.44;
      const pulseCount = enemy.attackKind === "trianglePulse" ? 3 : 2;
      const progress = 1 - Math.max(0, enemy.stateTimer / duration);
      const pulseIndex = Math.min(pulseCount - 1, Math.floor(progress * pulseCount));
      if (pulseIndex !== enemy.pulseIndex) {
        enemy.pulseIndex = pulseIndex;
        enemy.pulseHit = false;
        enemy.previousDangerRadius = 0;
        enemy.dangerRadius = 0.9;
      }
      const segmentProgress = (progress * pulseCount) - pulseIndex;
      enemy.previousDangerRadius = enemy.dangerRadius;
      enemy.dangerRadius = THREE.MathUtils.lerp(0.9, Math.max(view.halfWidth, view.halfHeight) + 2, segmentProgress);
      const hazardMesh = enemy.attackKind === "trianglePulse" ? enemy.visuals.trianglePulse : enemy.visuals.pulseRing;
      hazardMesh.scale.setScalar(enemy.dangerRadius);
      if (enemy.attackKind === "trianglePulse") {
        const directionAngle = enemy.triangleBaseAngle + pulseIndex * (TAU / 3);
        enemy.triangleDirection.set(Math.cos(directionAngle), Math.sin(directionAngle));
        hazardMesh.rotation.z = directionAngle - Math.PI / 2;
      }
      state.stats.activeHazards += 1;
    } else if (enemy.attackKind === "sweepBeam") {
      const progress = 1 - Math.max(0, enemy.stateTimer / 1.16);
      const angle = THREE.MathUtils.lerp(enemy.beamStartAngle, enemy.beamEndAngle, progress);
      enemy.beamDirection.set(Math.cos(angle), Math.sin(angle));
      enemy.group.rotation.z = angle - Math.PI / 2;
      enemy.visuals.line.visible = true;
      enemy.beamWidth = 0.3 + progress * 0.34;
      enemy.visuals.line.scale.set(enemy.beamWidth, 1, 1);
      enemy.visuals.line.material.color.set(state.reducedMotion ? 0xff9f43 : 0xff506f);
      enemy.visuals.line.material.opacity = state.reducedMotion ? 0.72 : 0.84 + progress * 0.12;
      state.stats.activeHazards += 1;
    } else if (enemy.attackKind === "voidShards") {
      enemy.visuals.shardLines.children.forEach((line) => { line.visible = false; });
    } else if (enemy.attackKind !== "charge") {
      const summonScale = state.reducedMotion ? 1 : 1 + Math.sin(state.elapsed * 18) * 0.18;
      enemy.visuals.pulseRing.scale.setScalar(summonScale);
    }
    if (enemy.stateTimer <= 0) {
      clearBossAttackVisuals(enemy);
      setEnemyState(enemy, "recover", 0.82);
    }
  } else if (enemy.state === "recover") {
    enemy.velocity.multiplyScalar(Math.exp(-4.5 * dt));
    if (enemy.stateTimer <= 0) setEnemyState(enemy, "choose", 0.28);
  }
}

function waveReachedPlayer(enemy, distance) {
  const radius = enemy.dangerRadius ?? enemy.shockRadius ?? 0;
  const previousRadius = enemy.previousDangerRadius ?? enemy.shockPreviousRadius ?? 0;
  if (enemy.pulseHit || radius <= 0) return false;
  const band = player.radius + 0.34;
  return distance + band >= previousRadius && distance - band <= radius;
}

function beamHitsPlayer(enemy) {
  const lancerBeam = enemy.type === "lancer" && enemy.state === "active";
  const bossBeam = enemy.type === "boss" && enemy.state === "execute" && enemy.attackKind === "sweepBeam";
  if (!lancerBeam && !bossBeam) return false;
  return beamHitsCircle({
    originX: enemy.group.position.x,
    originY: enemy.group.position.y,
    directionX: enemy.beamDirection.x,
    directionY: enemy.beamDirection.y,
    width: enemy.beamWidth,
    length: 18,
  }, {
    x: player.position.x,
    y: player.position.y,
    radius: player.radius,
  });
}

function trianglePulseHitsPlayer(enemy) {
  if (enemy.type !== "boss" || enemy.state !== "execute" || enemy.attackKind !== "trianglePulse" || enemy.pulseHit) return false;
  const relative = player.position.clone().sub(enemy.group.position);
  const distance = relative.length();
  const radius = enemy.dangerRadius ?? 0;
  if (radius <= 0 || distance > radius + player.radius) return false;
  relative.normalize();
  const dot = THREE.MathUtils.clamp(relative.dot(enemy.triangleDirection), -1, 1);
  return Math.acos(dot) <= enemy.triangleHalfAngle && relative.dot(enemy.triangleDirection) > 0;
}

function registerNearMiss(enemy, distance, collided = false) {
  if (enemy.nearMissed || enemy.nearMissResolved || enemy.type === "mine" || enemy.type === "boss") return false;
  const toPlayer = enemyScratch.nearMissDirection.subVectors(player.position, enemy.group.position);
  toPlayer.multiplyScalar(1 / Math.max(distance, 0.001));
  const collisionDistance = player.radius + enemy.radius;
  const nearMissEdge = collisionDistance + 0.62;
  const previousDistance = enemy.nearMissPreviousDistance;
  const approachedSinceLastFrame = Number.isFinite(previousDistance) && distance < previousDistance - 0.006;
  const movingTowardPlayer = enemy.velocity.dot(toPlayer) > 0.02;

  if (collided || distance <= collisionDistance) {
    enemy.nearMissCandidate = false;
    enemy.nearMissResolved = true;
    enemy.nearMissPreviousDistance = distance;
    return false;
  }

  if (!enemy.nearMissCandidate && distance < nearMissEdge && (approachedSinceLastFrame || movingTowardPlayer)) {
    enemy.nearMissCandidate = true;
    enemy.nearMissMinDistance = distance;
  }

  let safelyPassed = false;
  if (enemy.nearMissCandidate) {
    enemy.nearMissMinDistance = Math.min(enemy.nearMissMinDistance, distance);
    const increasing = Number.isFinite(previousDistance) && distance > previousDistance + 0.012;
    const clearedCollisionBand = distance > collisionDistance + 0.04;
    const exitedNearMissBand = distance >= nearMissEdge && distance > enemy.nearMissMinDistance + 0.02;
    safelyPassed = (increasing && clearedCollisionBand) || exitedNearMissBand;
  }

  enemy.nearMissPreviousDistance = distance;
  if (!safelyPassed) return false;

  enemy.nearMissed = true;
  enemy.nearMissCandidate = false;
  enemy.nearMissResolved = true;
  const previousScore = state.score;
  awardReward("nearMiss");
  state.stats.nearMisses += 1;
  const position = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
  triggerFeedback("nearMiss", {
    position,
    color: 0xffd166,
    particles: 8,
    speed: 3.2,
    size: 0.9,
    rippleScale: 1.05,
    text: `NEAR MISS +${state.score - previousScore}`,
    tone: "gold",
  });
  audio.event("nearMiss", 0.8);
  return true;
}

function dashHitsEnemy(enemy, distance) {
  if (!state.playerAttacking || enemy.lastDashId === state.dashSequence) return false;
  const targetRadius = enemy.type === "boss" ? 0.95 : enemy.radius;
  return distance < player.radius + targetRadius;
}

function damageEnemy(enemy) {
  enemy.lastDashId = state.dashSequence;
  enemy.hp -= enemy.type === "boss" ? BOSS_DASH_DAMAGE : 1;
  if (enemy.type === "boss") {
    syncBossProgress(enemy);
    if (enemy.hp > 0) enterBossPhaseTwo(enemy);
  }
  const position = new THREE.Vector2(enemy.group.position.x, enemy.group.position.y);
  if (enemy.hp <= 0) {
    destroyEnemy(enemy, "dash");
    return;
  }
  if (enemy.type === "boss") awardReward("bossHit");
  tryStartBulwarkArmorCounter(enemy, "dash", state.dashSequence);
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
  state.stats.activeHazards = 0;
  state.combatFrame += 1;
  const initialCount = enemies.length;
  for (let index = initialCount - 1; index >= 0; index -= 1) {
    const enemy = enemies[index];
    if (!enemy || enemy.dead) continue;
    const toPlayer = enemyScratch.toPlayer.subVectors(player.position, enemy.group.position);
    const distance = Math.max(toPlayer.length(), 0.001);
    toPlayer.multiplyScalar(1 / distance);
    if (enemy.type === "striker") updateStriker(enemy, dt, toPlayer);
    else if (enemy.type === "lancer") updateLancer(enemy, dt, toPlayer);
    else if (enemy.type === "swarm") updateSwarm(enemy, dt, toPlayer);
    else if (enemy.type === "mine") updateMine(enemy, dt);
    else if (enemy.type === "elite" || enemy.type === "bulwark") updateElite(enemy, dt, toPlayer);
    else if (enemy.type === "boss") updateBoss(enemy, dt);
    else updateChaser(enemy, dt, toPlayer);
    if (enemy.dead) continue;
    if (enemy.pendingLaserDeath && !isEnemyAttackExecuting(enemy)) {
      destroyEnemy(enemy, enemy.pendingDeathSource ?? "laser");
      continue;
    }
    const stationary = ["enter", "telegraph", "active", "shockTelegraph", "shockExecute", "armorCounterTelegraph", "armorCounterExecute", "detonate", "chainTelegraph", "chargeTelegraph"].includes(enemy.state);
    if (enemy.type !== "mine" && !stationary) {
      enemy.group.position.x += enemy.velocity.x * dt;
      enemy.group.position.y += enemy.velocity.y * dt;
      if (enemy.velocity.lengthSq() > 0.01) enemy.group.rotation.z = Math.atan2(enemy.velocity.y, enemy.velocity.x) - Math.PI / 2;
    }
  }
  state.stats.beamPeak = Math.max(state.stats.beamPeak, enemies.filter((enemy) => enemy.type === "lancer" && enemy.state === "active").length);

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
    const contactRadius = enemy.type === "boss" ? 2.25 : enemy.radius;
    const bodyContact = !["mine", "lancer"].includes(enemy.type) && enemy.state !== "enter" && distance < player.radius + contactRadius;
    const waveContact = ["mine", "boss", "elite", "bulwark"].includes(enemy.type)
      && enemy.attackKind !== "trianglePulse" && waveReachedPlayer(enemy, distance);
    const triangleContact = trianglePulseHitsPlayer(enemy);
    const beamContact = beamHitsPlayer(enemy);
    registerNearMiss(enemy, distance, bodyContact || waveContact || triangleContact || beamContact);
    if (state.dashInvulnerable || state.hurtInvuln > 0) continue;
    if (bodyContact || waveContact || triangleContact || beamContact) {
      enemy.pulseHit = waveContact || triangleContact || enemy.pulseHit;
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
  if (enemy.type === "swarm") {
    state.stats.chainBreaks += 1;
    spawnParticleBurst(position, 0x64f5ff, 5, 2.4, 0.72);
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
  state.health = Math.max(0, state.health - 1);
  enemy.nearMissCandidate = false;
  enemy.nearMissResolved = true;
  syncHealthPips();
  state.hurtInvuln = HURT_INVULNERABILITY;
  player.hitReactTimer = 0.18;
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
  if (state.health <= 0) finishRun("gameover", "hullBreach");
}

function updateSpawning(dt) {
  if (state.stageIndex >= 3 || state.bossTriggered) return;
  state.enemySpawnTimer -= dt;
  state.formationTimer -= dt;
  const healthPercent = (state.health / Math.max(1, state.maxHealth)) * 100;
  const reliefBudget = computeSpawnBudget(state.elapsed, healthPercent, state.score);
  const cap = getEnemyCap();
  const easedTarget = getPressureTarget(state.stageIndex, { activeCap: cap, healthPercent });

  if (state.formationTimer <= 0) {
    spawnFormation();
    state.formationTimer = COMBAT.formationCooldown.min
      + Math.random() * (COMBAT.formationCooldown.max - COMBAT.formationCooldown.min);
  }

  if (state.enemySpawnTimer <= 0) {
    const remaining = Math.max(0, Math.min(cap, easedTarget) - enemies.length);
    const burstLimit = Math.min(remaining, getSpawnBurstLimit(state.stageIndex));
    let threatBudget = Math.max(1, reliefBudget + state.stageIndex);
    for (let index = 0; index < burstLimit; index += 1) {
      const type = getNextEligibleSpawnType();
      if (!type) break;
      const threatCost = ENEMY_TYPES[type]?.threatCost ?? 1;
      if (threatCost > threatBudget || enemies.length >= cap) break;
      const created = spawnEnemy(type);
      if (!created) break;
      threatBudget -= threatCost;
    }
    state.enemySpawnTimer = getSpawnInterval(state.stageIndex, state.elapsed);
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
    if (!state.reducedMotion) particle.mesh.scale.multiplyScalar(1 + dt * 1.8);
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
      removeRippleAt(i);
    }
  }
}

function retireTrailAt(index, { discard = false } = {}) {
  const trail = trails[index];
  if (!trail) {
    trails.splice(index, 1);
    return;
  }
  if (trail.group?.isObject3D) {
    trail.group.visible = false;
    trail.group.position.set(0, 0, 2.65);
    trail.group.rotation.set(0, 0, 0);
    trail.group.scale.set(1, 1, 1);
  }
  trail.life = 0;
  trail.maxLife = 0;
  if (Array.isArray(trail.meshes)) {
    trail.meshes.forEach((mesh) => {
      if (mesh?.material?.isMaterial) mesh.material.opacity = 0;
    });
  }
  trails.splice(index, 1);
  if (!discard) return;
  const poolIndex = trailPool.indexOf(trail);
  if (poolIndex >= 0) trailPool.splice(poolIndex, 1);
  if (trail.group?.isObject3D) world.remove(trail.group);
  trail.meshes?.forEach((mesh) => mesh?.material?.dispose?.());
}

function sanitizeRuntimeState() {
  let corrected = false;
  const finite = (value, fallback) => {
    if (Number.isFinite(value)) return value;
    corrected = true;
    return fallback;
  };
  const finiteOrInfinity = (value, fallback) => {
    if (value === Infinity) return value;
    return finite(value, fallback);
  };
  state.elapsed = Math.max(0, finite(state.elapsed, 0));
  state.timeLeft = Math.max(0, finite(state.timeLeft, GAME.bossStart));
  // Infinity is an intentional sentinel during the boss window.
  state.enemySpawnTimer = finiteOrInfinity(state.enemySpawnTimer, 0);
  state.formationTimer = finite(state.formationTimer, 0);
  state.shardSpawnTimer = finite(state.shardSpawnTimer, 0);
  state.environmentTimer = finiteOrInfinity(state.environmentTimer, Infinity);
  state.environmentElapsed = Math.max(0, finite(state.environmentElapsed, 0));
  state.environmentSeed = Math.trunc(finite(state.environmentSeed, 0x4e544944));
  state.environmentSequence = Math.max(0, Math.trunc(finite(state.environmentSequence, 0)));
  state.combatFrame = Math.max(0, Math.trunc(finite(state.combatFrame, 0)));
  state.dashTimer = Math.max(0, finite(state.dashTimer, 0));
  state.dashInvulnTimer = Math.max(0, finite(state.dashInvulnTimer, 0));
  state.hurtInvuln = Math.max(0, finite(state.hurtInvuln, 0));
  state.weaponEnergy = clampFinite(state.weaponEnergy, 0, LASER_RULES.maxEnergy, 0);
  state.laserElapsed = Math.max(0, finite(state.laserElapsed, 0));
  state.laserSequence = Math.max(0, Math.trunc(finite(state.laserSequence, 0)));
  state.laserSequenceTargets = clampFinite(state.laserSequenceTargets, 0, LASER_RULES.maxTargets, 0);
  state.trauma = clampFinite(state.trauma, 0, 1, 0);
  state.slowMotionScale = clampFinite(state.slowMotionScale, 0.25, 1, 1);
  state.slowMotionTimer = Math.max(0, finite(state.slowMotionTimer, 0));
  state.zoomPunch = Math.max(0, finite(state.zoomPunch, 0));
  state.dashCharges.forEach((charge, index) => {
    state.dashCharges[index] = clampFinite(charge, 0, 1, 0);
  });
  [player.position, player.velocity, player.facing, state.laserDirection].forEach((vector) => {
    vector.x = finite(vector.x, 0);
    vector.y = finite(vector.y, 0);
  });

  for (let index = enemies.length - 1; index >= 0; index -= 1) {
    const enemy = enemies[index];
    if (!enemy || enemy.dead || !enemy.group?.isObject3D || !enemy.velocity?.isVector2) {
      removeEnemy(index);
      runtimeStats.orphanGuards += 1;
      corrected = true;
      continue;
    }
    const position = enemy.group.position;
    const velocity = enemy.velocity;
    if (!enemy.environmentVelocity?.isVector2) {
      enemy.environmentVelocity = new THREE.Vector2();
      runtimeStats.orphanGuards += 1;
      corrected = true;
    }
    const environmentVelocity = enemy.environmentVelocity;
    if (!Number.isFinite(environmentVelocity.x) || !Number.isFinite(environmentVelocity.y)) {
      environmentVelocity.set(0, 0);
      runtimeStats.orphanGuards += 1;
      corrected = true;
    }
    const valid = Number.isFinite(position.x) && Number.isFinite(position.y)
      && Number.isFinite(velocity.x) && Number.isFinite(velocity.y)
      && Number.isFinite(enemy.hp) && Number.isFinite(enemy.stateTimer);
    if (!valid) {
      enemy.dead = true;
      runtimeStats.orphanGuards += 1;
      removeEnemy(index);
      corrected = true;
      continue;
    }
    position.x = finite(position.x, 0);
    position.y = finite(position.y, 0);
    velocity.x = finite(velocity.x, 0);
    velocity.y = finite(velocity.y, 0);
    enemy.hp = finite(enemy.hp, 0);
    enemy.stateTimer = finite(enemy.stateTimer, 0);
  }
  const cap = getEnemyCap();
  while (enemies.length > cap) {
    removeEnemy(enemies.length - 1);
    runtimeStats.orphanGuards += 1;
    corrected = true;
  }
  let activeProjectiles = 0;
  const projectileCap = getProjectileActiveCap();
  for (const projectile of projectiles) {
    const needsRepair = !projectile?.mesh?.isMesh || projectile.mesh.material !== projectile.material || !projectile.velocity?.isVector2;
    if (needsRepair) {
      if (repairProjectileEntry(projectile)) resetProjectile(projectile);
      corrected = true;
      runtimeStats.orphanGuards += 1;
      continue;
    }
    const structurallyValid = Boolean(projectile.mesh.material?.isMaterial);
    const runtimeValid = structurallyValid && Number.isFinite(projectile.life) && Number.isFinite(projectile.maxLife)
      && Number.isFinite(projectile.damage) && Number.isFinite(projectile.radius)
      && Number.isFinite(projectile.velocity.x) && Number.isFinite(projectile.velocity.y)
      && Number.isFinite(projectile.mesh.position.x) && Number.isFinite(projectile.mesh.position.y)
      && Number.isFinite(projectile.mesh.material.opacity);
    if (!runtimeValid) {
      if (structurallyValid) resetProjectile(projectile);
      corrected = true;
      runtimeStats.orphanGuards += 1;
      continue;
    }
    if (!projectile.active) continue;
    activeProjectiles += 1;
    if (activeProjectiles > projectileCap) {
      resetProjectile(projectile);
      corrected = true;
    }
  }
  for (let index = particles.length - 1; index >= 0; index -= 1) {
    const particle = particles[index];
    const mesh = particle?.mesh;
    const velocity = particle?.velocity;
    if (!particle || !mesh?.isObject3D || !mesh.material?.isMaterial || !velocity?.isVector2 || !Number.isFinite(particle.life)
      || !Number.isFinite(particle.maxLife) || !Number.isFinite(velocity.x) || !Number.isFinite(velocity.y)) {
      if (mesh?.isObject3D) {
        mesh.visible = false;
        world.remove(mesh);
        mesh.material?.dispose?.();
      }
      const poolIndex = particlePool.indexOf(particle);
      if (poolIndex >= 0) particlePool.splice(poolIndex, 1);
      particles.splice(index, 1);
      corrected = true;
      runtimeStats.orphanGuards += 1;
      continue;
    }
    const invalidTransform = !Number.isFinite(mesh.position.x) || !Number.isFinite(mesh.position.y)
      || !Number.isFinite(mesh.position.z) || !Number.isFinite(mesh.scale.x)
      || !Number.isFinite(mesh.scale.y) || !Number.isFinite(mesh.scale.z);
    const invalidOpacity = !Number.isFinite(mesh.material?.opacity);
    if (invalidTransform) {
      mesh.position.set(0, 0, 4.2);
      mesh.scale.setScalar(1);
      corrected = true;
    }
    if (invalidOpacity) {
      if (mesh.material) mesh.material.opacity = 0;
      corrected = true;
    } else if (mesh.material) {
      const opacity = THREE.MathUtils.clamp(mesh.material.opacity, 0, 1);
      if (opacity !== mesh.material.opacity) corrected = true;
      mesh.material.opacity = opacity;
    }
  }
  while (particles.length > MAX_PARTICLES) {
    const particle = particles.pop();
    if (particle?.mesh) particle.mesh.visible = false;
    corrected = true;
  }
  for (let index = trails.length - 1; index >= 0; index -= 1) {
    const trail = trails[index];
    const group = trail?.group;
    const meshes = trail?.meshes;
    const structurallyValid = Boolean(trail && group?.isObject3D && Array.isArray(meshes) && meshes.length > 0
      && meshes.every((mesh) => mesh?.isMesh && mesh.material?.isMaterial));
    if (!structurallyValid) {
      retireTrailAt(index, { discard: true });
      corrected = true;
      runtimeStats.orphanGuards += 1;
      continue;
    }
    const transformValues = [
      group.position.x, group.position.y, group.position.z,
      group.rotation.x, group.rotation.y, group.rotation.z,
      group.scale.x, group.scale.y, group.scale.z,
    ];
    const validRuntime = Number.isFinite(trail.life) && Number.isFinite(trail.maxLife)
      && trail.maxLife > 0 && transformValues.every(Number.isFinite)
      && meshes.every((mesh) => Number.isFinite(mesh.material.opacity));
    if (!validRuntime) {
      retireTrailAt(index);
      corrected = true;
      runtimeStats.orphanGuards += 1;
      continue;
    }
    meshes.forEach((mesh) => {
      const opacity = THREE.MathUtils.clamp(mesh.material.opacity, 0, 1);
      if (opacity !== mesh.material.opacity) corrected = true;
      mesh.material.opacity = opacity;
    });
  }
  while (trails.length > MAX_TRAIL_NODES) {
    retireTrailAt(trails.length - 1);
    corrected = true;
  }
  state.stats.activeHazards = Math.max(0, finite(state.stats.activeHazards, 0));
  state.stats.enemyPeak = Math.max(0, finite(state.stats.enemyPeak, enemies.length));
  state.stats.projectilePeak = Math.max(0, finite(state.stats.projectilePeak, 0));
  state.stats.environmentEvents = Math.max(0, finite(state.stats.environmentEvents, 0));
  state.stats.environmentActiveFrames = Math.max(0, finite(state.stats.environmentActiveFrames, 0));
  if (corrected) runtimeStats.finiteGuards += 1;
  return corrected;
}

function sampleShakeAxis(seed, time) {
  return Math.sin(time * 17 + seed) * 0.62 + Math.sin(time * 29 + seed * 2.3) * 0.38;
}

function updateVisuals(dt) {
  updatePalette(dt);
  realmBackgrounds.update({ elapsed: state.elapsed, dt, reducedMotion: state.reducedMotion });
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

function updateLaserHUD() {
  const energy = THREE.MathUtils.clamp(state.weaponEnergy, 0, LASER_RULES.maxEnergy);
  const energyPercent = (energy / LASER_RULES.maxEnergy) * 100;
  const availability = getLaserAvailability();
  const ready = availability.canStart;
  const charging = state.laserState === "charge";
  const active = state.laserState === "active";
  const roundedEnergy = Math.round(energy);
  dom.weaponEnergy.textContent = String(roundedEnergy);
  dom.weaponEnergyFill.style.width = `${energyPercent}%`;
  dom.laserStatus.classList.toggle("ready", ready);
  dom.laserStatus.classList.toggle("charging", charging || active || (!ready && energy > 0));
  const statusByReason = {
    ready: "光矛 // READY",
    charge: "光矛 // 蓄力",
    active: "光矛 // 发射",
    dash: "光矛 // 相位冲刺中",
    conflict: "光矛 // 状态冲突",
    paused: "光矛 // 已暂停",
    locked: "光矛 // 不可用",
  };
  dom.laserStatus.textContent = statusByReason[availability.reason] ?? `光矛 // 充能中 ${roundedEnergy}%`;
  dom.laserButton.classList.toggle("ready", ready);
  dom.laserButton.classList.toggle("charging", charging || active || (!ready && energy > 0));
  dom.laserButton.setAttribute("aria-disabled", String(!availability.canStart));
  const labelByReason = {
    ready: "潮汐光矛 READY，按 E 发射",
    charge: "潮汐光矛蓄力",
    active: "潮汐光矛发射",
    dash: "潮汐光矛暂不可用，相位冲刺中",
    conflict: "潮汐光矛暂不可用，状态冲突",
    paused: "潮汐光矛已暂停，继续游戏后可发射",
    locked: "潮汐光矛当前状态不可用",
  };
  dom.laserButton.setAttribute("aria-label", labelByReason[availability.reason] ?? `潮汐光矛充能中，能量 ${roundedEnergy}`);
  dom.laserButton.style.setProperty("--laser-progress", `${Math.round(energyPercent * 3.6)}deg`);
}

function renderJourneyStrip() {
  const items = REALMS.map((realm) => {
    const item = document.createElement("li");
    item.dataset.realm = realm.id;
    const name = realm.id.replaceAll("-", " ").toUpperCase();
    item.innerHTML = `<span>${String(realm.index + 1).padStart(2, "0")}</span><strong>${name}</strong><small>${realm.start}–${realm.end} 秒</small>`;
    return item;
  });
  dom.journeyStrip.replaceChildren(...items);
}

function updateHUD(dt) {
  dom.score.textContent = String(state.score).padStart(4, "0");
  const totalSeconds = Math.max(0, Math.ceil(state.timeLeft));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  dom.timeLabel.textContent = state.bossDeadline === null ? "首领接入" : "首领窗口";
  dom.time.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  dom.time.classList.toggle("warning", state.timeLeft <= 10 && state.mode === "playing");
  updateLaserHUD();
  syncHealthPips();
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
    : Number.isFinite(stage.end) ? stage.end : GAME.bossStart + GAME.bossWindow;
  const stageDuration = Math.max(0.001, stageEnd - stage.start);
  const stageProgress = THREE.MathUtils.clamp(((state.elapsed - stage.start) / stageDuration) * 100, 0, 100);
  dom.stageName.textContent = STAGE_LABELS[state.stageIndex] ?? stage.name;
  dom.stageProgress.style.width = `${stageProgress}%`;
  dom.stageTrack.setAttribute("aria-valuenow", String(Math.round(stageProgress)));
  const formationVisible = state.lastFormation && state.elapsed - state.lastFormationAt < 2.6;
  dom.formationLabel.textContent = formationVisible
    ? `FORMATION // ${state.lastFormation.toUpperCase()}`
    : `SECTOR // ${String(state.stageIndex + 1).padStart(2, "0")} / 04`;
  dom.formationLabel.classList.toggle("active", Boolean(formationVisible));
  const boss = enemies.find((enemy) => enemy.type === "boss" && !enemy.dead);
  syncBossProgress(boss ?? null);
  if (state.toastTimer > 0) {
    state.toastTimer -= dt;
    if (state.toastTimer <= 0) dom.toast.classList.remove("show");
  }
  if (state.stageBannerTimer > 0) {
    state.stageBannerTimer -= dt;
    if (state.stageBannerTimer <= 0) dom.stageBanner.classList.remove("show");
  }
}

function enterStage(nextStageIndex, showBanner = true) {
  const realmIndex = THREE.MathUtils.clamp(Math.trunc(Number(nextStageIndex) || 0), 0, REALMS.length - 1);
  const realm = REALMS[realmIndex] ?? REALMS[0];
  const presentation = REALM_PRESENTATION[realmIndex];
  clearEnvironmentAndProjectiles();
  state.stageIndex = realmIndex;
  scheduleEnvironmentForStage();
  realmBackgrounds.setRealm(realmIndex, state.reducedMotion);
  document.documentElement.dataset.realm = realm.cssTheme;
  audio.setStage(realmIndex);
  setPalette(realmIndex, state.reducedMotion || !showBanner);
  if (showBanner) {
    showStageBanner(
      presentation?.title ?? STAGES[realmIndex].name,
      realmIndex === 3 ? 1.25 : 1.05,
      realmIndex === 3 ? "boss" : "stage",
      presentation?.environment,
    );
  }
  return realmIndex;
}

function updateStage() {
  const targetStageIndex = getStageIndex(state.elapsed);
  const queuedThrough = state.stageQueue.at(-1) ?? state.stageIndex;
  for (let index = Math.max(state.stageIndex, queuedThrough) + 1; index <= targetStageIndex; index += 1) {
    state.stageQueue.push(index);
  }
  if (state.mode !== "playing" || state.stageQueue.length === 0) return;

  const nextStageIndex = state.stageQueue.shift();
  enterStage(nextStageIndex);
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
  state.bossStart = GAME.bossStart;
  state.bossDeadline = state.bossStart + GAME.bossWindow;
  state.timeLeft = Math.max(0, state.bossDeadline - state.elapsed);
  state.enemySpawnTimer = Infinity;
  dom.missionObjective.textContent = `在 ${GAME.bossWindow} 秒内摧毁深潮主脑`;
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
}

function requestDash() {
  if (state.mode === "playing") input.dashBuffer = DASH_BUFFER_WINDOW;
}

function requestLaser() {
  if (canStartLaser()) input.laserBuffer = 0.14;
}

function isControlTarget(target) {
  return Boolean(target?.closest?.("button,[role='button'],input,select,textarea,a,[contenteditable='true']"));
}

function onKeyDown(event) {
  if (trapDialogFocus(event)) return;
  if (!event.repeat) audio.unlock();
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const controlTarget = isControlTarget(event.target);
  const gameplayControlKey = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key);
  if (state.mode === "playing" && gameplayControlKey && !controlTarget) event.preventDefault();
  if (state.mode === "playing") input.keys.add(key);
  if (!event.repeat && !controlTarget && event.code === "Space") requestDash();
  if (!event.repeat && !controlTarget && event.code === "KeyE") {
    event.preventDefault();
    requestLaser();
  }
  if (!event.repeat && state.mode === "upgrade" && /^[1-3]$/.test(key)) {
    const option = state.upgradeOptions[Number(key) - 1];
    if (option) chooseUpgrade(option.id);
  }
  if (!event.repeat && (key === "p" || event.key === "Escape")) {
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

function bindInputListener(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  inputListeners.push(() => target.removeEventListener(type, listener, options));
}

function teardownInput() {
  inputListeners.splice(0).forEach((remove) => remove());
  inputBound = false;
}

function setupInput() {
  if (inputBound) return false;
  inputBound = true;
  runtimeStats.inputSetupCount += 1;
  bindInputListener(window, "keydown", onKeyDown, { passive: false });
  bindInputListener(window, "keyup", onKeyUp);
  bindInputListener(window, "blur", () => {
    input.keys.clear();
    resetJoystick();
    if (state.mode === "playing") pauseGame();
  });
  bindInputListener(document, "visibilitychange", () => {
    if (document.hidden && state.mode === "playing") pauseGame();
  });
  bindInputListener(window, "pagehide", () => {
    if (state.mode === "playing") pauseGame();
  });
  bindInputListener(dom.primaryButton, "click", () => {
    audio.unlock();
    if (state.mode === "menu" || state.mode === "gameover" || state.mode === "victory") startGame();
    else if (state.mode === "paused") resumeGame();
  });
  bindInputListener(dom.pauseButton, "click", () => {
    audio.unlock();
    if (state.mode === "playing") pauseGame();
    else if (state.mode === "paused") resumeGame();
  });
  bindInputListener(dom.muteButton, "click", () => {
    audio.unlock();
    state.muted = !state.muted;
    audio.setMuted(state.muted);
    dom.muteButton.setAttribute("aria-pressed", String(state.muted));
    dom.muteButton.setAttribute("aria-label", state.muted ? "取消静音" : "静音");
    dom.muteButton.textContent = state.muted ? "×" : "♪";
  });
  bindInputListener(dom.upgradeOptions, "click", (event) => {
    const button = event.target.closest("button[data-upgrade-id]");
    if (button) chooseUpgrade(button.dataset.upgradeId);
  });
  bindInputListener(dom.dashButton, "pointerdown", (event) => {
    event.preventDefault();
    audio.unlock();
    requestDash();
  });
  bindInputListener(dom.laserButton, "pointerdown", (event) => {
    event.preventDefault();
    audio.unlock();
    requestLaser();
  });
  bindInputListener(dom.joystick, "pointerdown", (event) => {
    event.preventDefault();
    audio.unlock();
    input.joystickPointerId = event.pointerId;
    dom.joystick.setPointerCapture(event.pointerId);
    setJoystickFromEvent(event);
  });
  bindInputListener(dom.joystick, "pointermove", (event) => {
    if (event.pointerId === input.joystickPointerId) setJoystickFromEvent(event);
  });
  bindInputListener(dom.joystick, "pointerup", resetJoystick);
  bindInputListener(dom.joystick, "pointercancel", resetJoystick);
  return true;
}

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  refreshRenderQuality();
  postProcessing?.resize(window.innerWidth, window.innerHeight, renderQuality.pixelRatio);
  updateBounds();
  realmBackgrounds.resize(window.innerWidth, window.innerHeight);
}

function animate() {
  const rawWallDt = clock.getDelta();
  const simulationScale = state.reducedMotion || state.slowMotionTimer <= 0 ? 1 : state.slowMotionScale;
  const { wallDt, simDt } = computeFrameDeltas(rawWallDt, simulationScale);
  sanitizeRuntimeState();
  if (state.mode !== "paused" && state.slowMotionTimer > 0) {
    state.slowMotionTimer = Math.max(0, state.slowMotionTimer - wallDt);
    if (state.slowMotionTimer <= 0) state.slowMotionScale = 1;
  }
  if (state.mode === "playing") {
    state.elapsed += wallDt;
    state.dashTimer = Math.max(0, state.dashTimer - simDt);
    state.dashInvulnTimer = Math.max(0, state.dashInvulnTimer - simDt);
    state.hurtInvuln = Math.max(0, state.hurtInvuln - simDt);
    input.dashBuffer = Math.max(0, input.dashBuffer - simDt);
    input.laserBuffer = Math.max(0, input.laserBuffer - simDt);
    state.comboTimer = Math.max(0, state.comboTimer - simDt);
    if (state.comboTimer <= 0 && state.combo > 0) {
      clearCombo();
    }
    updateStage();
    if (state.mode === "playing") applyEnvironment(wallDt, simDt);
    const dashRecoveryMultiplier = getDerivedValues().dashRecoveryMultiplier;
    state.dashCharges = state.dashCharges.map((charge) => Math.min(1, charge + (simDt * dashRecoveryMultiplier) / DASH_RECOVERY_TIME));
    const countdownTarget = state.bossDeadline ?? GAME.bossStart;
    state.timeLeft = Math.max(0, countdownTarget - state.elapsed);
    if (state.mode === "playing" && state.timeLeft <= 0) finishRun("gameover", "bossDeadline");
    if (state.mode === "playing") {
      if (input.laserBuffer > 0) attemptLaser();
      updatePlayer(simDt);
      updateLaser(simDt);
      updateShards(simDt);
      updateEnemies(simDt);
      updateProjectiles(simDt);
      if (state.mode === "playing") updateSpawning(simDt);
      updateParticles(simDt);
      updateRipples(simDt);
      updateTrails(simDt);
    }
  } else if (state.mode !== "paused") {
    const idleSimDt = Math.min(wallDt, 0.05);
    updateParticles(idleSimDt);
    updateRipples(idleSimDt);
    updateTrails(idleSimDt);
  }
  const energyIntensity = ["charge", "active"].includes(state.laserState) ? 1 : state.weaponEnergy / LASER_RULES.maxEnergy;
  const intensity = THREE.MathUtils.clamp((enemies.length / getEnemyCap()) * 0.7 + energyIntensity * 0.3, 0, 1);
  audio.update(state.elapsed, intensity, state.mode, {
    laserReady: canStartLaser(),
    bossPhase: state.stats.bossPhase,
  });
  updateVisuals(state.mode === "paused" ? 0 : wallDt);
  sanitizeRuntimeState();
  postProcessing?.render();
}

if (import.meta.env.DEV) {
  Object.defineProperty(globalThis, "__NEON_TIDE_RUNTIME_HOOKS__", {
    configurable: true,
    value: Object.freeze({
      createParticlePool,
      createTrailPool,
      setupInput,
      applyReducedMotionPreference,
      resize,
    }),
  });
}

createPlayer();
createParticlePool();
createProjectilePool();
createTrailPool();
setupInput();
renderJourneyStrip();
updateBounds();
refreshRenderQuality();
resetState();
renderMode("menu", null);
const clock = new THREE.Clock();
window.addEventListener("resize", resize);
window.addEventListener("beforeunload", () => {
  realmBackgrounds.dispose();
  disposeLaserAssets();
  disposeCombatAssets();
}, { once: true });
reducedMotionPreference?.addEventListener?.("change", (event) => applyReducedMotionPreference(event.matches));
renderer.setAnimationLoop(animate);
