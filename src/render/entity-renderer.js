import * as THREE from 'three';
import {
  DEFAULT_ENTITY_CAPACITIES,
  ENTITY_KINDS,
} from '../game/entity-world.js';

const PROJECTILE_KINDS = new Set(['friendlyProjectile', 'enemyProjectile']);
const DEFAULT_COLORS = Object.freeze({
  player: 0xe7ffff,
  enemy: 0xff4fba,
  friendlyProjectile: 0x64f5ff,
  enemyProjectile: 0xff506f,
  pickup: 0xffd166,
  objective: 0x36e0ff,
  bossPart: 0xff9f43,
});
const BASE_SIZES = Object.freeze({
  player: 0.72,
  enemy: 0.72,
  friendlyProjectile: 0.16,
  enemyProjectile: 0.19,
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

function resourceReferencedElsewhere(scene, ignoredObject, resource, key) {
  let referenced = false;
  scene.traverse((object) => {
    if (referenced || object === ignoredObject) return;
    const value = object[key];
    if (Array.isArray(value) ? value.includes(resource) : value === resource) referenced = true;
  });
  return referenced;
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

  let disposed = false;
  let active = 0;
  let syncs = 0;
  let resets = 0;
  let audits = 0;
  let corrections = 0;
  let clippedEntities = 0;

  function syncInstanced(pool, query, alpha) {
    const { object, capacity } = pool;
    const count = Math.min(query.length, capacity);
    if (count === 0) {
      object.count = 0;
      return 0;
    }
    for (let index = 0; index < count; index += 1) {
      const entity = query.at(index);
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
      const scale = clampFinite(entity.scale, 0, RENDER_SCALE_LIMIT, 1);
      const baseSize = BASE_SIZES[pool.kind];
      scratch.position.set(x, y, z);
      scratch.rotation.set(0, 0, rotation);
      scratch.scale.set(
        clampFinite(entity.scaleX, 0, RENDER_SCALE_LIMIT, 1) * scale * baseSize,
        clampFinite(entity.scaleY, 0, RENDER_SCALE_LIMIT, 1) * scale * baseSize,
        clampFinite(entity.scaleZ, 0, RENDER_SCALE_LIMIT, 1) * scale * baseSize,
      );
      scratch.updateMatrix();
      object.setMatrixAt(index, scratch.matrix);
      color.setHex(Number.isFinite(entity.color) ? entity.color : DEFAULT_COLORS[pool.kind]);
      setColorComponents(object.instanceColor.array, index * 3, color);
    }
    object.count = count;
    object.instanceMatrix.needsUpdate = true;
    object.instanceColor.needsUpdate = true;
    return count;
  }

  function syncPoints(pool, query, alpha) {
    const { object, geometry, capacity } = pool;
    const count = Math.min(query.length, capacity);
    if (count === 0) {
      geometry.setDrawRange(0, 0);
      object.visible = false;
      return 0;
    }
    const positions = pool.positionArray;
    const colors = pool.colorArray;
    for (let index = 0; index < count; index += 1) {
      const entity = query.at(index);
      const offset = index * 3;
      positions[offset] = interpolate(entity.previousX, entity.x, alpha);
      positions[offset + 1] = interpolate(entity.previousY, entity.y, alpha);
      positions[offset + 2] = interpolate(entity.previousZ, entity.z, alpha);
      color.setHex(Number.isFinite(entity.color) ? entity.color : DEFAULT_COLORS[pool.kind]);
      setColorComponents(colors, offset, color);
    }
    geometry.setDrawRange(0, count);
    pool.positionAttribute.needsUpdate = true;
    pool.colorAttribute.needsUpdate = true;
    object.visible = count > 0;
    return count;
  }

  function sync(world, interpolationAlpha = 0) {
    if (disposed) return false;
    if (!world || typeof world.query !== 'function') throw new TypeError('entity renderer sync requires an EntityWorld');
    const alpha = clampAlpha(interpolationAlpha);
    let nextActive = 0;
    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      const query = world.query(kind);
      const rendered = PROJECTILE_KINDS.has(kind)
        ? syncPoints(pool, query, alpha)
        : syncInstanced(pool, query, alpha);
      nextActive += rendered;
      if (query.length > pool.capacity) clippedEntities += query.length - pool.capacity;
    }
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
    if (root.parent !== scene) {
      scene.add(root);
      corrections += 1;
    }
    corrections += auditTransform(root, {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    });

    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      const { object, geometry, material, capacity } = pool;
      if (object.parent !== root) {
        root.add(object);
        corrections += 1;
      }
      if (object.geometry !== geometry) {
        const foreign = object.geometry;
        object.geometry = geometry;
        corrections += 1;
        if (foreign?.isBufferGeometry && !geometries.has(foreign)
          && !resourceReferencedElsewhere(scene, object, foreign, 'geometry')) markDisposed(foreign);
      }
      if (object.material !== material) {
        const foreign = object.material;
        object.material = material;
        corrections += 1;
        const foreignList = Array.isArray(foreign) ? foreign : [foreign];
        for (const candidate of foreignList) {
          if (candidate?.isMaterial && !materials.has(candidate)
            && !resourceReferencedElsewhere(scene, object, candidate, 'material')) markDisposed(candidate);
        }
      }
      corrections += auditTransform(object, {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      });

      if (PROJECTILE_KINDS.has(kind)) {
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

    const ownedObjects = new Set(ENTITY_KINDS.map((kind) => pools[kind].object));
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
    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      if (PROJECTILE_KINDS.has(kind)) {
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
    resets += 1;
    return true;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    for (const kind of ENTITY_KINDS) {
      const object = pools[kind].object;
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
      const count = PROJECTILE_KINDS.has(kind) ? pool.geometry.drawRange.count : pool.object.count;
      poolStats[kind] = Object.freeze({
        capacity: pool.capacity,
        count: Number.isFinite(count) ? count : 0,
        primitive: PROJECTILE_KINDS.has(kind) ? 'points' : 'instances',
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
      sceneChildren: scene.children.length,
      rootChildren: root.children.length,
      ownership: Object.freeze({
        objects: ENTITY_KINDS.length + 1,
        geometries: geometries.size,
        materials: materials.size,
      }),
      pools: Object.freeze(poolStats),
    });
  }

  return Object.freeze({ sync, reset, recoverCorruption, dispose, getStats });
}
