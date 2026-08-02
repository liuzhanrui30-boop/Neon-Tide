import * as THREE from "three";
import "./style.css";

const TAU = Math.PI * 2;
const GAME_DURATION = 45;
const WORLD_HEIGHT = 14;
const STORAGE_KEY = "neon-tide-high-score";

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
  pauseButton: document.querySelector("#pause-button"),
  flash: document.querySelector("#flash"),
  toast: document.querySelector("#toast"),
  combo: document.querySelector("#combo"),
  joystick: document.querySelector("#joystick"),
  joystickKnob: document.querySelector("#joystick-knob"),
  dashButton: document.querySelector("#dash-button"),
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
  timeLeft: GAME_DURATION,
  score: 0,
  highScore: Number.parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10),
  health: 3,
  energy: 0,
  combo: 0,
  comboTimer: 0,
  enemySpawnTimer: 1.1,
  shardSpawnTimer: 1.8,
  dashCooldown: 0,
  dashTimer: 0,
  playerInvuln: 0,
  shakeTime: 0,
  shakeStrength: 0,
  toastTimer: 0,
  reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
};

const input = {
  keys: new Set(),
  dashQueued: false,
  touch: new THREE.Vector2(),
  joystickPointerId: null,
};

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

function spawnEnemy() {
  const margin = 0.5;
  const xBound = view.halfWidth + margin;
  const yBound = view.halfHeight + margin;
  const edge = Math.floor(Math.random() * 4);
  let x = 0;
  let y = 0;
  if (edge === 0) { x = -xBound; y = (Math.random() - 0.5) * yBound * 2; }
  if (edge === 1) { x = xBound; y = (Math.random() - 0.5) * yBound * 2; }
  if (edge === 2) { x = (Math.random() - 0.5) * xBound * 2; y = -yBound; }
  if (edge === 3) { x = (Math.random() - 0.5) * xBound * 2; y = yBound; }

  const group = new THREE.Group();
  group.position.set(x, y, 2);
  const glow = new THREE.Mesh(shared.enemyGlowGeometry, shared.enemyGlowMaterial);
  const body = new THREE.Mesh(shared.enemyGeometry, shared.enemyMaterial);
  const eye = new THREE.Mesh(
    new THREE.CircleGeometry(0.08, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd9e5 })
  );
  eye.position.set(0, 0.09, 0.06);
  group.add(glow, body, eye);
  world.add(group);

  const enemy = {
    group,
    velocity: new THREE.Vector2(),
    speed: 0.92 + state.elapsed * 0.024 + Math.random() * 0.42,
    radius: 0.34,
    wobble: Math.random() * TAU,
  };
  enemies.push(enemy);
  return enemy;
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
  state.timeLeft = GAME_DURATION;
  state.score = 0;
  state.health = 3;
  state.energy = 0;
  state.combo = 0;
  state.comboTimer = 0;
  state.enemySpawnTimer = 1.1;
  state.shardSpawnTimer = 1.8;
  state.dashCooldown = 0;
  state.dashTimer = 0;
  state.playerInvuln = 0;
  state.shakeTime = 0;
  state.shakeStrength = 0;
  player.position.set(0, -1.2);
  player.velocity.set(0, 0);
  player.facing.set(0, 1);
  player.group.scale.set(1, 1, 1);
  player.group.rotation.z = 0;
  player.shield.visible = false;
  syncPlayerTransform();
  seedShards();
}

function startGame() {
  unlockAudio();
  resetState();
  state.mode = "playing";
  dom.overlay.classList.remove("visible");
  dom.pauseButton.textContent = "Ⅱ";
  dom.pauseButton.style.visibility = "visible";
  toast("潮汐已接入", "cyan");
  tone(240, 0.12, "sine", 0.045, 520);
}

function pauseGame() {
  if (state.mode !== "playing") return;
  state.mode = "paused";
  showOverlay(
    "SIGNAL HOLD // PAUSED",
    "SIGNAL<br /><em>PAUSED</em>",
    "潮汐暂时冻结。准备好后继续收集光核。",
    "继续潮汐",
    false
  );
  tone(180, 0.12, "triangle", 0.03, 120);
}

function resumeGame() {
  if (state.mode !== "paused") return;
  unlockAudio();
  state.mode = "playing";
  dom.overlay.classList.remove("visible");
  toast("信号恢复", "cyan");
  tone(360, 0.1, "triangle", 0.03, 600);
}

function showOverlay(kicker, title, copy, label, showResult) {
  dom.overlayKicker.textContent = kicker;
  dom.overlayTitle.innerHTML = title;
  dom.overlayCopy.innerHTML = copy;
  dom.primaryLabel.textContent = label;
  dom.resultGrid.hidden = !showResult;
  if (showResult) {
    dom.resultScore.textContent = String(state.score);
    dom.resultHigh.textContent = String(state.highScore);
  }
  dom.overlay.classList.add("visible");
}

function gameOver() {
  if (state.mode !== "playing") return;
  state.mode = "gameover";
  updateHighScore();
  showOverlay(
    "SIGNAL LOST // HULL BREACH",
    "SIGNAL<br /><em>LOST</em>",
    "追猎信号撕裂了你的护盾。再来一次，把潮汐变成你的舞台。",
    "重新接入",
    true
  );
  dom.pauseButton.style.visibility = "hidden";
  flash("#ff506f", 0.24);
  spawnParticleBurst(player.position, 0xff506f, 28, 4.8, 1.4);
  spawnRipple(player.position, 0xff506f, 2.4);
  tone(120, 0.34, "sawtooth", 0.04, 45);
}

function victory() {
  if (state.mode !== "playing") return;
  state.mode = "victory";
  state.score += Math.floor(state.timeLeft * 10) + 250;
  updateHighScore();
  showOverlay(
    "SIGNAL CLEAR // TIDE OUT",
    "TIDE<br /><em>OUT</em>",
    "你穿过了整片霓虹潮汐。光核已经记住了你的航线。",
    "再次出航",
    true
  );
  dom.pauseButton.style.visibility = "hidden";
  flash("#64f5ff", 0.28);
  spawnParticleBurst(player.position, 0x64f5ff, 36, 3.6, 1.5);
  spawnRipple(player.position, 0x64f5ff, 3.2);
  tone(270, 0.14, "sine", 0.04, 540);
  setTimeout(() => tone(540, 0.22, "sine", 0.035, 820), 130);
}

function updateHighScore() {
  state.highScore = Math.max(state.highScore, state.score);
  localStorage.setItem(STORAGE_KEY, String(state.highScore));
}

function updatePlayer(dt) {
  const direction = readMoveDirection();
  if (direction.lengthSq() > 0.01) player.facing.lerp(direction, 1 - Math.exp(-16 * dt)).normalize();

  if (input.dashQueued) {
    input.dashQueued = false;
    if (state.dashCooldown <= 0) {
      const dashDirection = direction.lengthSq() > 0.01 ? direction : player.facing;
      player.velocity.copy(dashDirection).multiplyScalar(15.8);
      state.dashCooldown = 1.25;
      state.dashTimer = 0.18;
      state.playerInvuln = Math.max(state.playerInvuln, 0.34);
      player.group.scale.set(1.25, 0.78, 1);
      spawnParticleBurst(player.position, 0x64f5ff, 15, 3.7, 0.85);
      spawnRipple(player.position, 0x64f5ff, 1.2);
      shake(0.08, 0.12);
      tone(390, 0.09, "square", 0.025, 850);
    }
  }

  if (state.dashTimer <= 0) {
    const target = direction.lengthSq() > 0.01 ? direction.multiplyScalar(5.6) : new THREE.Vector2();
    player.velocity.lerp(target, 1 - Math.exp(-11 * dt));
  } else {
    state.dashTimer -= dt;
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
  const targetScale = state.dashTimer > 0 ? 1.22 : 1;
  player.group.scale.x = THREE.MathUtils.lerp(player.group.scale.x, targetScale, 1 - Math.exp(-22 * dt));
  player.group.scale.y = THREE.MathUtils.lerp(player.group.scale.y, state.dashTimer > 0 ? 0.82 : 1, 1 - Math.exp(-22 * dt));
  player.flame.scale.setScalar(0.75 + Math.min(speed / 5, 1) * 0.7 + Math.sin(state.elapsed * 30) * 0.08);
  player.flame.material.opacity = 0.48 + Math.min(speed / 5, 1) * 0.45;
  player.shield.visible = state.playerInvuln > 0;
  player.shield.material.opacity = 0.48 + Math.sin(state.elapsed * 24) * 0.2;
  syncPlayerTransform();
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
    if (Math.hypot(dx, dy) < player.radius + 0.3) {
      collectShard(i);
    }
  }
}

function collectShard(index) {
  const shard = shards[index];
  const position = new THREE.Vector2(shard.group.position.x, shard.group.position.y);
  removeShard(index);
  state.score += 10 + Math.min(state.combo, 5) * 2;
  state.energy = Math.min(100, state.energy + 12);
  state.combo += 1;
  state.comboTimer = 2.8;
  spawnParticleBurst(position, 0xffd166, 16, 3.5, 0.9);
  spawnRipple(position, 0xffd166, 1.1);
  tone(420 + state.combo * 26, 0.08, "sine", 0.028, 720 + state.combo * 40);
  if (state.combo > 1) {
    dom.combo.innerHTML = `连击 ×<b>${state.combo}</b>`;
    dom.combo.classList.add("show");
  }
}

function updateEnemies(dt) {
  for (const enemy of enemies) {
    const toPlayer = new THREE.Vector2(player.position.x - enemy.group.position.x, player.position.y - enemy.group.position.y);
    const distance = Math.max(toPlayer.length(), 0.001);
    toPlayer.multiplyScalar(1 / distance);
    const steering = toPlayer.clone().multiplyScalar(enemy.speed);
    const wobble = new THREE.Vector2(-toPlayer.y, toPlayer.x).multiplyScalar(Math.sin(state.elapsed * 2.2 + enemy.wobble) * 0.22);
    steering.add(wobble);
    enemy.velocity.lerp(steering, 1 - Math.exp(-2.8 * dt));
    enemy.group.position.x += enemy.velocity.x * dt;
    enemy.group.position.y += enemy.velocity.y * dt;
    enemy.group.rotation.z = Math.atan2(enemy.velocity.y, enemy.velocity.x) - Math.PI / 2;
    enemy.group.children[0].scale.setScalar(1 + Math.sin(state.elapsed * 4 + enemy.wobble) * 0.08);

    if (distance < player.radius + enemy.radius) {
      if (state.playerInvuln <= 0) damagePlayer(enemy);
      else enemy.velocity.addScaledVector(toPlayer, -2.1);
    }
  }
}

function damagePlayer(enemy) {
  state.health -= 1;
  state.energy = Math.max(0, state.energy - 18);
  state.playerInvuln = 0.95;
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
  tone(190, 0.16, "sawtooth", 0.035, 80);
  if (state.health <= 0) gameOver();
}

function updateSpawning(dt) {
  state.enemySpawnTimer -= dt;
  const enemyInterval = Math.max(0.44, 1.18 - state.elapsed * 0.014);
  if (state.enemySpawnTimer <= 0) {
    spawnEnemy();
    if (state.elapsed > 18 && Math.random() < 0.22) spawnEnemy();
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
  if (state.shakeTime > 0) {
    state.shakeTime -= dt;
    const falloff = Math.max(0, state.shakeTime / 0.3);
    camera.position.x = (Math.random() - 0.5) * state.shakeStrength * falloff;
    camera.position.y = (Math.random() - 0.5) * state.shakeStrength * falloff;
  } else {
    camera.position.x = 0;
    camera.position.y = 0;
  }
  camera.position.z = 20;
  updateHUD(dt);
}

function updateHUD(dt) {
  dom.score.textContent = String(state.score).padStart(4, "0");
  const seconds = Math.max(0, Math.ceil(state.timeLeft));
  dom.time.textContent = `00:${String(seconds).padStart(2, "0")}`;
  dom.time.classList.toggle("warning", state.timeLeft <= 10 && state.mode === "playing");
  dom.energy.textContent = String(Math.round(state.energy));
  dom.energyFill.style.width = `${state.energy}%`;
  dom.healthPips.forEach((pip, index) => pip.classList.toggle("empty", index >= state.health));
  dom.dashButton.classList.toggle("cooldown", state.dashCooldown > 0);
  if (state.toastTimer > 0) {
    state.toastTimer -= dt;
    if (state.toastTimer <= 0) dom.toast.classList.remove("show");
  }
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
  if (state.mode === "playing") input.dashQueued = true;
}

function onKeyDown(event) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
  input.keys.add(key);
  if (event.code === "Space") requestDash();
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
    unlockAudio();
    if (state.mode === "menu" || state.mode === "gameover" || state.mode === "victory") startGame();
    else if (state.mode === "paused") resumeGame();
  });
  dom.pauseButton.addEventListener("click", () => {
    if (state.mode === "playing") pauseGame();
    else if (state.mode === "paused") resumeGame();
  });
  dom.dashButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    requestDash();
  });
  dom.joystick.addEventListener("pointerdown", (event) => {
    event.preventDefault();
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

let audioContext = null;
function unlockAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === "suspended") audioContext.resume();
}

function tone(startFrequency, duration, type, volume, endFrequency) {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(startFrequency, audioContext.currentTime);
  if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, audioContext.currentTime + duration);
  gain.gain.setValueAtTime(volume, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + duration);
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
    state.timeLeft = Math.max(0, GAME_DURATION - state.elapsed);
    state.dashCooldown = Math.max(0, state.dashCooldown - dt);
    state.playerInvuln = Math.max(0, state.playerInvuln - dt);
    state.comboTimer = Math.max(0, state.comboTimer - dt);
    if (state.comboTimer <= 0 && state.combo > 0) {
      state.combo = 0;
      dom.combo.classList.remove("show");
    }
    updatePlayer(dt);
    updateShards(dt);
    updateEnemies(dt);
    updateSpawning(dt);
    updateParticles(dt);
    updateRipples(dt);
    if (state.timeLeft <= 0) victory();
  } else {
    updateParticles(dt);
    updateRipples(dt);
    player.group.rotation.z += dt * 0.15;
  }
  updateVisuals(dt);
  renderer.render(scene, camera);
}

createBackground();
createPlayer();
createParticlePool();
setupInput();
updateBounds();
resetState();
dom.pauseButton.style.visibility = "hidden";
showOverlay(
  "ARCADE SURVIVAL // THREE.JS",
  "NEON<br /><em>TIDE</em>",
  "在失控的数字海域中收集光核，躲开追猎信号。<br />坚持 45 秒，等到潮汐退去。",
  "进入潮汐",
  false
);
const clock = new THREE.Clock();
window.addEventListener("resize", resize);
renderer.setAnimationLoop(animate);
