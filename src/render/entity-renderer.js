import * as THREE from 'three';
import {
  createEntityReadTarget,
  DEFAULT_ENTITY_CAPACITIES,
  ENTITY_FLAG_HIDDEN,
  ENTITY_KINDS,
  getAuthoritativeContactRadius,
} from '../game/entity-world.js';

const PROJECTILE_KINDS = new Set(['friendlyProjectile', 'enemyProjectile']);
const INDEPENDENT_WARNING_KIND = 'warning';
const DEFAULT_COLORS = Object.freeze({
  player: 0xe7ffff,
  enemy: 0xff4fba,
  friendlyProjectile: 0x64f5ff,
  enemyProjectile: 0xff506f,
  warning: 0xff9f43,
  enemyHazard: 0xff506f,
  pickup: 0xffd166,
  objective: 0x36e0ff,
  bossPart: 0xff9f43,
});
const BASE_SIZES = Object.freeze({
  player: 0.72,
  enemy: 0.72,
  friendlyProjectile: 0.16,
  enemyProjectile: 0.19,
  warning: 1,
  enemyHazard: 1,
  pickup: 0.42,
  objective: 1,
  bossPart: 1,
});
const RENDER_POSITION_LIMIT = 1_000_000;
const RENDER_SCALE_LIMIT = 10_000;
const RENDER_ROTATION_LIMIT = 1_000_000;

const finiteOr = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clampAlpha = (alpha) => Math.min(1, Math.max(0, finiteOr(Number(alpha), 0)));
const clampFinite = (value, minimum, maximum, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
};
const interpolate = (previous, current, alpha) => {
  const safeCurrent = clampFinite(current, -RENDER_POSITION_LIMIT, RENDER_POSITION_LIMIT, 0);
  const safePrevious = clampFinite(previous, -RENDER_POSITION_LIMIT, RENDER_POSITION_LIMIT, safeCurrent);
  return clampFinite(
    safePrevious * (1 - alpha) + safeCurrent * alpha,
    -RENDER_POSITION_LIMIT,
    RENDER_POSITION_LIMIT,
    safeCurrent,
  );
};

function resolveCapacities(capacities) {
  if (!capacities || typeof capacities !== 'object' || Array.isArray(capacities)) {
    throw new TypeError('entity renderer capacities must be an object');
  }
  const result = {};
  for (const key of Object.keys(capacities)) {
    if (!ENTITY_KINDS.includes(key)) throw new RangeError(`unknown entity kind: ${key}`);
  }
  for (const kind of ENTITY_KINDS) {
    const value = capacities[kind] ?? DEFAULT_ENTITY_CAPACITIES[kind];
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
      throw new RangeError(`capacity for ${kind} must be an integer from 0 to 1000000`);
    }
    result[kind] = value;
  }
  return result;
}

function createGeometry(kind, capacity) {
  if (PROJECTILE_KINDS.has(kind)) {
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    const colors = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    geometry.setAttribute('color', colors);
    geometry.setDrawRange(0, 0);
    return geometry;
  }
  if (kind === 'warning') return new THREE.PlaneGeometry(1, 1);
  if (kind === 'enemyHazard') return new THREE.CircleGeometry(1, 12);
  if (kind === 'player') return new THREE.CircleGeometry(1, 3);
  if (kind === 'enemy') return new THREE.CircleGeometry(1, 4);
  if (kind === 'pickup') return new THREE.RingGeometry(0.5, 1, 8);
  if (kind === 'objective') return new THREE.RingGeometry(0.78, 1, 24);
  if (kind === 'bossPart') return new THREE.CircleGeometry(1, 6);
  return new THREE.CircleGeometry(1, 12);
}

function createMaterial(kind, quality) {
  const reduced = quality?.tier === 'mobile' || quality?.tier === 'compact';
  if (PROJECTILE_KINDS.has(kind)) {
    return new THREE.PointsMaterial({
      color: 0xffffff,
      vertexColors: true,
      size: BASE_SIZES[kind] * (reduced ? 1.7 : 2),
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: kind === 'objective' ? 0.72 : 0.92,
    depthWrite: false,
    blending: kind === 'player' || kind === 'objective' ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
}

function createRenderPool({ kind, capacity, quality, root, geometries, materials, hiddenMatrix }) {
  if (kind === INDEPENDENT_WARNING_KIND) {
    const geometry = createGeometry(kind, capacity);
    geometry.userData.entityRendererOwned = true;
    geometries.add(geometry);
    const object = new THREE.Group();
    object.name = `entity-${kind}`;
    object.userData.entityKind = kind;
    object.frustumCulled = false;
    object.renderOrder = 30;
    const warningMeshes = [];
    const warningMaterials = [];
    for (let slot = 0; slot < capacity; slot += 1) {
      const material = createMaterial(kind, quality);
      material.userData.entityRendererOwned = true;
      material.opacity = 0;
      materials.add(material);
      warningMaterials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 30;
      object.add(mesh);
      warningMeshes.push(mesh);
    }
    object.geometry = geometry;
    object.material = warningMaterials[0] ?? createMaterial(kind, quality);
    root.add(object);
    return {
      kind, capacity, geometry, material: warningMaterials[0] ?? null, object,
      warningMeshes, warningMaterials, visibleCount: 0,
      instanceMatrix: null, instanceMatrixArray: null, instanceColor: null, instanceColorArray: null,
      positionAttribute: null, positionArray: null, colorAttribute: null, colorArray: null,
      readTarget: createEntityReadTarget(),
    };
  }
  const geometry = createGeometry(kind, capacity);
  const material = createMaterial(kind, quality);
  geometry.userData.entityRendererOwned = true;
  material.userData.entityRendererOwned = true;
  geometries.add(geometry);
  materials.add(material);

  let object;
  if (PROJECTILE_KINDS.has(kind)) {
    object = new THREE.Points(geometry, material);
  } else {
    object = new THREE.InstancedMesh(geometry, material, capacity);
    object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    object.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    object.instanceColor.setUsage(THREE.DynamicDrawUsage);
    for (let slot = 0; slot < capacity; slot += 1) object.setMatrixAt(slot, hiddenMatrix);
    object.count = 0;
  }
  object.name = `entity-${kind}`;
  object.userData.entityKind = kind;
  object.frustumCulled = false;
  object.renderOrder = kind === 'objective' ? 5 : kind.includes('Projectile') ? 20 : 10;
  root.add(object);
  return Object.freeze({
    kind,
    capacity,
    geometry,
    material,
    object,
    instanceMatrix: object.isInstancedMesh ? object.instanceMatrix : null,
    instanceMatrixArray: object.isInstancedMesh ? object.instanceMatrix.array : null,
    instanceColor: object.isInstancedMesh ? object.instanceColor : null,
    instanceColorArray: object.isInstancedMesh ? object.instanceColor.array : null,
    positionAttribute: object.isPoints ? geometry.attributes.position : null,
    positionArray: object.isPoints ? geometry.attributes.position.array : null,
    colorAttribute: object.isPoints ? geometry.attributes.color : null,
    colorArray: object.isPoints ? geometry.attributes.color.array : null,
    readTarget: createEntityReadTarget(),
  });
}

function setColorComponents(array, offset, color) {
  array[offset] = color.r;
  array[offset + 1] = color.g;
  array[offset + 2] = color.b;
}

function markDisposed(resource) {
  resource.userData ??= {};
  resource.userData.entityRendererDisposed = true;
  resource.dispose?.();
}

function repairFiniteArray(array, fillValue = 0) {
  let repaired = 0;
  for (let index = 0; index < array.length; index += 1) {
    if (!Number.isFinite(array[index])) {
      array[index] = fillValue;
      repaired += 1;
    }
  }
  return repaired;
}

export function createEntityRenderer({ scene, quality = { tier: 'desktop' }, capacities = {} } = {}) {
  if (!scene?.isObject3D || typeof scene.add !== 'function' || typeof scene.remove !== 'function') {
    throw new TypeError('entity renderer requires a Three.js scene');
  }
  const resolvedCapacities = resolveCapacities(capacities);
  const totalCapacity = ENTITY_KINDS.reduce((total, kind) => total + resolvedCapacities[kind], 0);
  const root = new THREE.Group();
  root.name = 'v3-entity-renderer';
  root.userData.entityRendererRoot = true;
  const geometries = new Set();
  const materials = new Set();
  const scratch = new THREE.Object3D();
  const color = new THREE.Color();
  const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const identityMatrix = new THREE.Matrix4();
  const pools = {};
  let mountParent = scene;
  scene.add(root);

  for (const kind of ENTITY_KINDS) {
    pools[kind] = createRenderPool({
      kind,
      capacity: resolvedCapacities[kind],
      quality,
      root,
      geometries,
      materials,
      hiddenMatrix,
    });
  }
  const hazardBoxGeometry = new THREE.PlaneGeometry(1, 1);
  const hazardBoxMaterial = createMaterial('enemyHazard', quality);
  hazardBoxGeometry.userData.entityRendererOwned = true;
  hazardBoxMaterial.userData.entityRendererOwned = true;
  geometries.add(hazardBoxGeometry);
  materials.add(hazardBoxMaterial);
  const hazardBoxObject = new THREE.InstancedMesh(
    hazardBoxGeometry,
    hazardBoxMaterial,
    resolvedCapacities.enemyHazard,
  );
  hazardBoxObject.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hazardBoxObject.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(resolvedCapacities.enemyHazard * 3),
    3,
  );
  hazardBoxObject.instanceColor.setUsage(THREE.DynamicDrawUsage);
  for (let slot = 0; slot < resolvedCapacities.enemyHazard; slot += 1) {
    hazardBoxObject.setMatrixAt(slot, hiddenMatrix);
  }
  hazardBoxObject.count = 0;
  hazardBoxObject.name = 'entity-enemyHazard-oriented-box';
  hazardBoxObject.userData.entityKind = 'enemyHazard';
  hazardBoxObject.userData.entityShape = 'oriented-box';
  hazardBoxObject.frustumCulled = false;
  hazardBoxObject.renderOrder = 10;
  root.add(hazardBoxObject);
  const hazardBoxPool = Object.freeze({
    kind: 'enemyHazard',
    shape: 'oriented-box',
    capacity: resolvedCapacities.enemyHazard,
    geometry: hazardBoxGeometry,
    material: hazardBoxMaterial,
    object: hazardBoxObject,
    instanceMatrix: hazardBoxObject.instanceMatrix,
    instanceMatrixArray: hazardBoxObject.instanceMatrix.array,
    instanceColor: hazardBoxObject.instanceColor,
    instanceColorArray: hazardBoxObject.instanceColor.array,
    positionAttribute: null,
    positionArray: null,
    colorAttribute: null,
    colorArray: null,
    readTarget: createEntityReadTarget(),
  });
  const renderPools = [...ENTITY_KINDS.map((kind) => pools[kind]), hazardBoxPool];

  let disposed = false;
  let active = 0;
  let syncs = 0;
  let resets = 0;
  let audits = 0;
  let corrections = 0;
  let clippedEntities = 0;
  let worldWarningCount = 0;
  const observedEnemyRoles = new Set();
  const previewOwners = new Float64Array(8);
  const previewX = new Float64Array(8);
  const previewY = new Float64Array(8);
  const previewCos = new Float64Array(8);
  const previewSin = new Float64Array(8);
  const previewHalfLength = new Float64Array(8);
  const previewHalfWidth = new Float64Array(8);
  let previewCursor = 0;
  let lancerPreviewsRendered = 0;
  let lancerBeamNodesRendered = 0;
  let lancerBeamNodesOutsidePreview = 0;
  let wardenGapRenderedRadius = 0;
  let wardenWallRenderedRadius = 0;
  let lancerSafeRenderedRadius = 0;
  const warningFrameOwners = new Float64Array(8);
  const warningFrameProgress = new Float64Array(8);
  let maxSimultaneousWarningOwners = 0;
  let maxIndependentWarningProgress = 0;
  let maxHiddenActiveWarnings = 0;

  function previewSlot(ownerId, create = false) {
    for (let index = 0; index < previewOwners.length; index += 1) {
      if (previewOwners[index] === ownerId) return index;
    }
    if (!create) return -1;
    const slot = previewCursor++ % previewOwners.length;
    previewOwners[slot] = ownerId;
    return slot;
  }

  function recordLancerPreview(entity, renderedScaleX, renderedScaleY) {
    const slot = previewSlot(entity.ownerId, true);
    previewX[slot] = entity.x;
    previewY[slot] = entity.y;
    previewCos[slot] = Math.cos(entity.rotation);
    previewSin[slot] = Math.sin(entity.rotation);
    previewHalfLength[slot] = renderedScaleX * 0.5;
    previewHalfWidth[slot] = renderedScaleY * 0.5;
    lancerPreviewsRendered += 1;
  }

  function recordLancerNode(entity, renderedRadius) {
    const slot = previewSlot(entity.ownerId);
    if (slot < 0) return;
    const dx = entity.x - previewX[slot];
    const dy = entity.y - previewY[slot];
    const along = dx * previewCos[slot] + dy * previewSin[slot];
    const across = -dx * previewSin[slot] + dy * previewCos[slot];
    lancerBeamNodesRendered += 1;
    if (Math.abs(along) + renderedRadius > previewHalfLength[slot] + 1e-6
      || Math.abs(across) + renderedRadius > previewHalfWidth[slot] + 1e-6) {
      lancerBeamNodesOutsidePreview += 1;
    }
  }

  function syncInstanced(pool, query, world, alpha, shapeFilter = null) {
    const { object, capacity } = pool;
    const candidateCount = Math.min(query.length, capacity);
    if (candidateCount === 0) {
      object.count = 0;
      return 0;
    }
    let count = 0;
    for (let index = 0; index < candidateCount; index += 1) {
      const entity = world.readInto(query.at(index), pool.readTarget);
      if (!entity || (entity.flags & ENTITY_FLAG_HIDDEN) !== 0) continue;
      if (shapeFilter === 'oriented-box' && entity.variant !== 'oriented-box') continue;
      if (shapeFilter === 'circle' && entity.variant === 'oriented-box') continue;
      const x = interpolate(entity.previousX, entity.x, alpha);
      const y = interpolate(entity.previousY, entity.y, alpha);
      const z = interpolate(entity.previousZ, entity.z, alpha);
      const previousRotation = clampFinite(
        entity.previousRotation,
        -RENDER_ROTATION_LIMIT,
        RENDER_ROTATION_LIMIT,
        0,
      );
      const currentRotation = clampFinite(
        entity.rotation,
        -RENDER_ROTATION_LIMIT,
        RENDER_ROTATION_LIMIT,
        previousRotation,
      );
      const rotation = previousRotation * (1 - alpha) + currentRotation * alpha;
      const orientedBox = pool.kind === 'enemyHazard' && pool.shape === 'oriented-box';
      const hazardFootprint = pool.kind === 'enemyHazard' && !orientedBox
        ? getAuthoritativeContactRadius(entity)
        : 0;
      const scale = pool.kind === 'enemyHazard'
        ? 1
        : clampFinite(entity.scale, 0, RENDER_SCALE_LIMIT, 1);
      const baseSize = BASE_SIZES[pool.kind];
      scratch.position.set(x, y, z);
      scratch.rotation.set(0, 0, rotation);
      const authoritativeScaleX = orientedBox
        ? entity.scaleX
        : pool.kind === 'enemyHazard' ? hazardFootprint : entity.scaleX;
      const authoritativeScaleY = orientedBox
        ? entity.scaleY
        : pool.kind === 'enemyHazard' ? hazardFootprint : entity.scaleY;
      const renderedScaleX = clampFinite(authoritativeScaleX, 0, RENDER_SCALE_LIMIT, 1) * scale * baseSize;
      const renderedScaleY = clampFinite(authoritativeScaleY, 0, RENDER_SCALE_LIMIT, 1) * scale * baseSize;
      scratch.scale.set(
        renderedScaleX,
        renderedScaleY,
        clampFinite(entity.scaleZ, 0, RENDER_SCALE_LIMIT, 1) * scale * baseSize,
      );
      scratch.updateMatrix();
      object.setMatrixAt(count, scratch.matrix);
      color.setHex(Number.isFinite(entity.color) ? entity.color : DEFAULT_COLORS[pool.kind]);
      setColorComponents(object.instanceColor.array, count * 3, color);
      if (pool.kind === 'enemy' && entity.role) observedEnemyRoles.add(entity.role);
      if (pool.kind === 'enemyHazard' && !orientedBox) {
        if (entity.type === 'lancer-beam-node') recordLancerNode(entity, renderedScaleX);
        if (entity.role === 'warden-gap') wardenGapRenderedRadius = Math.max(wardenGapRenderedRadius, renderedScaleX);
        else if (entity.role === 'warden-wall') wardenWallRenderedRadius = Math.max(wardenWallRenderedRadius, renderedScaleX);
        else if (entity.role === 'safe-sector') lancerSafeRenderedRadius = Math.max(lancerSafeRenderedRadius, renderedScaleX);
      }
      count += 1;
    }
    object.count = count;
    object.instanceMatrix.needsUpdate = true;
    object.instanceColor.needsUpdate = true;
    return count;
  }

  function syncPoints(pool, query, world, alpha) {
    const { object, geometry, capacity } = pool;
    const candidateCount = Math.min(query.length, capacity);
    if (candidateCount === 0) {
      geometry.setDrawRange(0, 0);
      object.visible = false;
      return 0;
    }
    const positions = pool.positionArray;
    const colors = pool.colorArray;
    let count = 0;
    for (let index = 0; index < candidateCount; index += 1) {
      const entity = world.readInto(query.at(index), pool.readTarget);
      if (!entity || (entity.flags & ENTITY_FLAG_HIDDEN) !== 0) continue;
      const offset = count * 3;
      positions[offset] = interpolate(entity.previousX, entity.x, alpha);
      positions[offset + 1] = interpolate(entity.previousY, entity.y, alpha);
      positions[offset + 2] = interpolate(entity.previousZ, entity.z, alpha);
      color.setHex(Number.isFinite(entity.color) ? entity.color : DEFAULT_COLORS[pool.kind]);
      setColorComponents(colors, offset, color);
      count += 1;
    }
    geometry.setDrawRange(0, count);
    pool.positionAttribute.needsUpdate = true;
    pool.colorAttribute.needsUpdate = true;
    object.visible = count > 0;
    return count;
  }

  function syncWarnings(pool, query, world, alpha) {
    const candidateCount = Math.min(query.length, pool.capacity);
    let count = 0;
    let frameOwnerCount = 0;
    warningFrameOwners.fill(0);
    for (let index = 0; index < candidateCount; index += 1) {
      const entity = world.readInto(query.at(index), pool.readTarget);
      if (!entity || (entity.flags & ENTITY_FLAG_HIDDEN) !== 0 || entity.opacity <= 0) continue;
      const mesh = pool.warningMeshes[count];
      const material = pool.warningMaterials[count];
      mesh.position.set(
        interpolate(entity.previousX, entity.x, alpha),
        interpolate(entity.previousY, entity.y, alpha),
        interpolate(entity.previousZ, entity.z, alpha),
      );
      mesh.rotation.set(0, 0, clampFinite(entity.rotation, -RENDER_ROTATION_LIMIT, RENDER_ROTATION_LIMIT, 0));
      const scale = clampFinite(entity.scale, 0, RENDER_SCALE_LIMIT, 1);
      mesh.scale.set(
        clampFinite(entity.scaleX, 0, RENDER_SCALE_LIMIT, 1) * scale,
        clampFinite(entity.scaleY, 0, RENDER_SCALE_LIMIT, 1) * scale,
        1,
      );
      if (entity.type === 'lancer-beam') recordLancerPreview(entity, mesh.scale.x, mesh.scale.y);
      let ownerSlot = -1;
      for (let ownerIndex = 0; ownerIndex < frameOwnerCount; ownerIndex += 1) {
        if (warningFrameOwners[ownerIndex] === entity.ownerId) { ownerSlot = ownerIndex; break; }
      }
      if (ownerSlot < 0 && frameOwnerCount < warningFrameOwners.length) {
        ownerSlot = frameOwnerCount++;
        warningFrameOwners[ownerSlot] = entity.ownerId;
        warningFrameProgress[ownerSlot] = entity.progress;
      }
      material.color.setHex(Number.isFinite(entity.color) ? entity.color : DEFAULT_COLORS.warning);
      material.opacity = clampFinite(entity.opacity, 0, 1, 0.72);
      mesh.visible = true;
      count += 1;
    }
    let distinctProgress = 0;
    for (let ownerIndex = 0; ownerIndex < frameOwnerCount; ownerIndex += 1) {
      let duplicate = false;
      for (let previous = 0; previous < ownerIndex; previous += 1) {
        if (Math.abs(warningFrameProgress[ownerIndex] - warningFrameProgress[previous]) <= 1e-4) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) distinctProgress += 1;
    }
    maxSimultaneousWarningOwners = Math.max(maxSimultaneousWarningOwners, frameOwnerCount);
    maxIndependentWarningProgress = Math.max(maxIndependentWarningProgress, distinctProgress);
    for (let index = count; index < pool.visibleCount; index += 1) {
      pool.warningMeshes[index].visible = false;
      pool.warningMaterials[index].opacity = 0;
    }
    pool.visibleCount = count;
    return count;
  }

  function sync(world, interpolationAlpha = 0) {
    if (disposed) return false;
    if (!world || typeof world.query !== 'function' || typeof world.readInto !== 'function') {
      throw new TypeError('entity renderer sync requires an EntityWorld');
    }
    const alpha = clampAlpha(interpolationAlpha);
    let nextActive = 0;
    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      const query = world.query(kind);
      const rendered = kind === INDEPENDENT_WARNING_KIND
        ? syncWarnings(pool, query, world, alpha)
        : PROJECTILE_KINDS.has(kind)
          ? syncPoints(pool, query, world, alpha)
          : syncInstanced(pool, query, world, alpha, kind === 'enemyHazard' ? 'circle' : null);
      nextActive += rendered;
      if (kind === 'enemyHazard') {
        nextActive += syncInstanced(hazardBoxPool, query, world, alpha, 'oriented-box');
      }
      if (query.length > pool.capacity) clippedEntities += query.length - pool.capacity;
    }
    worldWarningCount = world.query('warning').length;
    maxHiddenActiveWarnings = Math.max(maxHiddenActiveWarnings,
      Math.max(0, worldWarningCount - (pools.warning?.visibleCount ?? 0)));
    active = nextActive;
    syncs += 1;
    return true;
  }

  function auditTransform(object, defaults) {
    let repaired = 0;
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isFinite(object.position[axis])) {
        object.position[axis] = defaults.position[axis];
        repaired += 1;
      }
      if (!Number.isFinite(object.rotation[axis])) {
        object.rotation[axis] = defaults.rotation[axis];
        repaired += 1;
      }
      if (!Number.isFinite(object.scale[axis])) {
        object.scale[axis] = defaults.scale[axis];
        repaired += 1;
      }
    }
    return repaired;
  }

  function recoverCorruption() {
    if (disposed) return false;
    audits += 1;
    if (root.parent !== mountParent) {
      mountParent.add(root);
      corrections += 1;
    }
    corrections += auditTransform(root, {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });

    for (const pool of renderPools) {
      const kind = pool.kind;
      const { object, geometry, material, capacity } = pool;
      if (object.parent !== root) {
        root.add(object);
        corrections += 1;
      }
      if (object.geometry !== geometry) {
        object.geometry = geometry;
        corrections += 1;
      }
      if (object.material !== material) {
        object.material = material;
        corrections += 1;
      }
      corrections += auditTransform(object, {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });

      if (kind === INDEPENDENT_WARNING_KIND) {
        for (let slot = 0; slot < capacity; slot += 1) {
          const mesh = pool.warningMeshes[slot];
          const ownedMaterial = pool.warningMaterials[slot];
          if (mesh.parent !== object) { object.add(mesh); corrections += 1; }
          if (mesh.geometry !== geometry) { mesh.geometry = geometry; corrections += 1; }
          if (mesh.material !== ownedMaterial) { mesh.material = ownedMaterial; corrections += 1; }
          corrections += auditTransform(mesh, {
            position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
          });
          if (!Number.isFinite(ownedMaterial.opacity)) { ownedMaterial.opacity = 0; corrections += 1; }
        }
        if (!Number.isInteger(pool.visibleCount) || pool.visibleCount < 0 || pool.visibleCount > capacity) {
          pool.visibleCount = 0; corrections += 1;
        }
      } else if (PROJECTILE_KINDS.has(kind)) {
        if (geometry.attributes.position !== pool.positionAttribute) {
          geometry.setAttribute('position', pool.positionAttribute);
          corrections += 1;
        }
        if (geometry.attributes.color !== pool.colorAttribute) {
          geometry.setAttribute('color', pool.colorAttribute);
          corrections += 1;
        }
        if (pool.positionAttribute.array !== pool.positionArray) {
          pool.positionAttribute.array = pool.positionArray;
          pool.positionAttribute.count = pool.positionArray.length / 3;
          corrections += 1;
        }
        if (pool.colorAttribute.array !== pool.colorArray) {
          pool.colorAttribute.array = pool.colorArray;
          pool.colorAttribute.count = pool.colorArray.length / 3;
          corrections += 1;
        }
        corrections += repairFiniteArray(pool.positionArray);
        corrections += repairFiniteArray(pool.colorArray);
        const drawCount = geometry.drawRange.count;
        if (!Number.isFinite(drawCount) || drawCount < 0 || drawCount > capacity) {
          geometry.setDrawRange(0, 0);
          corrections += 1;
        }
      } else {
        if (object.instanceMatrix !== pool.instanceMatrix) {
          object.instanceMatrix = pool.instanceMatrix;
          corrections += 1;
        }
        if (pool.instanceMatrix.array !== pool.instanceMatrixArray) {
          pool.instanceMatrix.array = pool.instanceMatrixArray;
          pool.instanceMatrix.count = pool.instanceMatrixArray.length / 16;
          corrections += 1;
        }
        if (object.instanceColor !== pool.instanceColor) {
          object.instanceColor = pool.instanceColor;
          corrections += 1;
        }
        if (pool.instanceColor.array !== pool.instanceColorArray) {
          pool.instanceColor.array = pool.instanceColorArray;
          pool.instanceColor.count = pool.instanceColorArray.length / 3;
          corrections += 1;
        }
        const matrixArray = pool.instanceMatrixArray;
        for (let slot = 0; slot < capacity; slot += 1) {
          let finite = true;
          const offset = slot * 16;
          for (let component = 0; component < 16; component += 1) {
            if (!Number.isFinite(matrixArray[offset + component])) {
              finite = false;
              break;
            }
          }
          if (!finite) {
            object.setMatrixAt(slot, identityMatrix);
            corrections += 1;
          }
        }
        corrections += repairFiniteArray(pool.instanceColorArray, 1);
        if (!Number.isInteger(object.count) || object.count < 0 || object.count > capacity) {
          object.count = 0;
          corrections += 1;
        }
      }
    }

    const ownedObjects = new Set(renderPools.map((pool) => pool.object));
    for (let index = root.children.length - 1; index >= 0; index -= 1) {
      if (!ownedObjects.has(root.children[index])) {
        root.remove(root.children[index]);
        corrections += 1;
      }
    }
    return true;
  }

  function reset() {
    if (disposed) return false;
    recoverCorruption();
    for (const pool of renderPools) {
      const kind = pool.kind;
      if (kind === INDEPENDENT_WARNING_KIND) {
        for (let slot = 0; slot < pool.capacity; slot += 1) {
          pool.warningMeshes[slot].visible = false;
          pool.warningMaterials[slot].opacity = 0;
        }
        pool.visibleCount = 0;
      } else if (PROJECTILE_KINDS.has(kind)) {
        pool.positionArray.fill(0);
        pool.colorArray.fill(0);
        pool.geometry.setDrawRange(0, 0);
        pool.positionAttribute.needsUpdate = true;
        pool.colorAttribute.needsUpdate = true;
        pool.object.visible = false;
      } else {
        for (let slot = 0; slot < pool.capacity; slot += 1) pool.object.setMatrixAt(slot, hiddenMatrix);
        pool.object.instanceColor.array.fill(0);
        pool.object.count = 0;
        pool.object.instanceMatrix.needsUpdate = true;
        pool.object.instanceColor.needsUpdate = true;
      }
    }
    active = 0;
    observedEnemyRoles.clear();
    previewOwners.fill(0);
    previewCursor = 0;
    lancerPreviewsRendered = 0;
    lancerBeamNodesRendered = 0;
    lancerBeamNodesOutsidePreview = 0;
    wardenGapRenderedRadius = 0;
    wardenWallRenderedRadius = 0;
    lancerSafeRenderedRadius = 0;
    maxSimultaneousWarningOwners = 0;
    maxIndependentWarningProgress = 0;
    maxHiddenActiveWarnings = 0;
    resets += 1;
    return true;
  }

  function mount(parent) {
    if (disposed) return false;
    if (!parent?.isObject3D || typeof parent.add !== 'function') {
      throw new TypeError('entity renderer mount requires a Three.js Object3D');
    }
    mountParent = parent;
    if (root.parent !== mountParent) mountParent.add(root);
    return true;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    for (const pool of renderPools) {
      const object = pool.object;
      object.removeFromParent();
      object.dispose?.();
    }
    root.removeFromParent();
    for (const geometry of geometries) markDisposed(geometry);
    for (const material of materials) markDisposed(material);
    root.clear();
    active = 0;
    return true;
  }

  function getStats() {
    const poolStats = {};
    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      const count = kind === INDEPENDENT_WARNING_KIND
        ? pool.visibleCount
        : PROJECTILE_KINDS.has(kind) ? pool.geometry.drawRange.count
          : kind === 'enemyHazard' ? pool.object.count + hazardBoxPool.object.count
            : pool.object.count;
      poolStats[kind] = Object.freeze({
        capacity: pool.capacity,
        count: Number.isFinite(count) ? count : 0,
        primitive: kind === INDEPENDENT_WARNING_KIND ? 'independent-meshes' : PROJECTILE_KINDS.has(kind) ? 'points' : 'instances',
      });
    }
    return Object.freeze({
      quality: quality?.tier ?? 'desktop',
      capacity: totalCapacity,
      active,
      syncs,
      resets,
      audits,
      corrections,
      clippedEntities,
      disposed,
      sceneChildren: root.parent ? 1 : 0,
      hostSceneChildren: scene.children.length,
      mounted: root.parent === mountParent,
      rootChildren: root.children.length,
      warningVisibility: Object.freeze({
        visible: pools.warning?.visibleCount ?? 0,
        hiddenActive: Math.max(0, (pools.warning ? worldWarningCount : 0) - (pools.warning?.visibleCount ?? 0)),
      }),
      observations: Object.freeze({
        enemyRoles: Object.freeze([...observedEnemyRoles]),
        lancerPreviewsRendered,
        lancerBeamNodesRendered,
        lancerBeamNodesOutsidePreview,
        wardenGapRenderedRadius,
        wardenWallRenderedRadius,
        lancerSafeRenderedRadius,
        maxSimultaneousWarningOwners,
        maxIndependentWarningProgress,
        maxHiddenActiveWarnings,
      }),
      ownership: Object.freeze({
        objects: renderPools.length + 1 + (pools.warning?.capacity ?? 0),
        geometries: geometries.size,
        materials: materials.size,
      }),
      pools: Object.freeze(poolStats),
    });
  }

  return Object.freeze({ sync, mount, reset, recoverCorruption, dispose, getStats });
}
