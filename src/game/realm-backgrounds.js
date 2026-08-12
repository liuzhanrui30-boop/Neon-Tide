import * as THREE from 'three';

const TAU = Math.PI * 2;
const BASE_HALF_HEIGHT = 8;
const BASE_HALF_WIDTH = 11.4;
const BACKDROP_Z = -4;
const REALM_TRANSITION_DURATION = 0.9;
const REALM_AUDIT_INTERVAL = 1;
const DEVELOPMENT_AUDITS = Boolean(import.meta.env?.DEV);

const clampRealm = (index) => Math.min(3, Math.max(0, Math.trunc(Number(index) || 0)));
const positiveModulo = (value, divisor = 1) => ((value % divisor) + divisor) % divisor;
const isReducedBudget = (quality) => quality?.tier === 'mobile' || quality?.tier === 'compact';

function getLayout(width, height) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  return {
    width: safeWidth,
    height: safeHeight,
    halfWidth: Math.max(BASE_HALF_HEIGHT * (safeWidth / safeHeight), 10.7),
    halfHeight: BASE_HALF_HEIGHT,
  };
}

function ownMaterial(materials, material) {
  material.userData.realmBaseOpacity = Number.isFinite(material.opacity) ? material.opacity : 1;
  material.userData.realmBaseTransparent = material.transparent;
  materials.add(material);
  return material;
}

function setMaterialBaseOpacity(material, opacity) {
  material.userData.realmBaseOpacity = opacity;
  material.opacity = opacity;
}

function meshMaterial(materials, parameters) {
  return ownMaterial(materials, new THREE.MeshBasicMaterial({
    depthWrite: false,
    ...parameters,
  }));
}

function lineMaterial(materials, parameters) {
  return ownMaterial(materials, new THREE.LineBasicMaterial({
    depthWrite: false,
    ...parameters,
  }));
}

function pointsMaterial(materials, parameters) {
  return ownMaterial(materials, new THREE.PointsMaterial({
    depthWrite: false,
    sizeAttenuation: true,
    ...parameters,
  }));
}

function createLineGeometry(segments) {
  const positions = new Float32Array(segments.length * 6);
  let offset = 0;
  for (const [x1, y1, x2, y2] of segments) {
    positions[offset] = x1;
    positions[offset + 1] = y1;
    positions[offset + 2] = 0;
    positions[offset + 3] = x2;
    positions[offset + 4] = y2;
    positions[offset + 5] = 0;
    offset += 6;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function createPolylineGeometry(pointCount, sampler) {
  const positions = new Float32Array(pointCount * 3);
  for (let index = 0; index < pointCount; index += 1) {
    const [x, y] = sampler(index, pointCount);
    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function createShapeGeometry(points) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) shape.lineTo(points[index][0], points[index][1]);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function createBackdrop(materials, color) {
  const material = meshMaterial(materials, { color });
  material.depthTest = true;
  material.userData.realmBackdrop = true;
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 36),
    material,
  );
  backdrop.userData.realmBackdrop = true;
  backdrop.position.z = BACKDROP_Z;
  backdrop.renderOrder = -100;
  return backdrop;
}

function captureOwnership(group, materials) {
  const objects = [];
  const renderables = [];
  const geometries = [];
  const geometrySet = new Set();
  group.traverse((object) => {
    objects.push(object);
    if (object.isMesh || object.isLine || object.isLineSegments || object.isPoints) renderables.push(object);
    if (object.geometry && !geometrySet.has(object.geometry)) {
      geometrySet.add(object.geometry);
      geometries.push(object.geometry);
    }
  });
  const materialList = [...materials];
  return {
    objects,
    renderables,
    geometries,
    materials: materialList,
    materialSet: new Set(materialList),
  };
}

function createAbyss({ quality, width, height }) {
  const layout = getLayout(width, height);
  const reducedBudget = isReducedBudget(quality);
  const materials = new Set();
  const group = new THREE.Group();
  group.name = 'realm-abyss';
  group.userData.realm = 'abyss';
  group.add(createBackdrop(materials, 0x020b17));

  const trenchMaterial = meshMaterial(materials, {
    color: 0x061c2d,
    transparent: true,
    opacity: 0.96,
  });
  const trenchEdgeMaterial = lineMaterial(materials, {
    color: 0x18b9ca,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
  });
  const trenchGeometry = createShapeGeometry([
    [0, -7.5], [0, 7.5], [1.1, 6.8], [2.5, 5.7], [1.85, 4.35], [3.35, 3.0],
    [2.1, 1.25], [3.7, -0.55], [2.35, -2.4], [3.55, -4.1], [2.0, -5.55], [1.25, -7.5],
  ]);
  const trenchEdges = new THREE.EdgesGeometry(trenchGeometry, 10);
  const leftTrench = new THREE.Mesh(trenchGeometry, trenchMaterial);
  const rightTrench = new THREE.Mesh(trenchGeometry, trenchMaterial);
  const leftEdge = new THREE.LineSegments(trenchEdges, trenchEdgeMaterial);
  const rightEdge = new THREE.LineSegments(trenchEdges, trenchEdgeMaterial);
  leftTrench.position.z = -2.15;
  rightTrench.position.z = -2.15;
  leftEdge.position.z = -2.05;
  rightEdge.position.z = -2.05;
  rightTrench.scale.x = -1;
  rightEdge.scale.x = -1;
  group.add(leftTrench, rightTrench, leftEdge, rightEdge);

  const floorGeometry = createShapeGeometry([
    [-10.5, -7.4], [10.5, -7.4], [10.5, -5.7], [8.4, -5.15], [6.4, -5.85],
    [3.8, -5.25], [1.3, -6.0], [-1.1, -5.35], [-3.5, -5.95], [-6.0, -5.25], [-8.2, -5.8], [-10.5, -5.2],
  ]);
  const floor = new THREE.Mesh(floorGeometry, trenchMaterial);
  floor.position.z = -2.1;
  group.add(floor);

  const caustics = [];
  for (let layer = 0; layer < 3; layer += 1) {
    const geometry = createPolylineGeometry(65, (index, count) => {
      const t = index / (count - 1);
      return [-BASE_HALF_WIDTH + t * BASE_HALF_WIDTH * 2, Math.sin(t * TAU * (2.2 + layer * 0.45) + layer * 1.3) * (0.18 + layer * 0.08)];
    });
    const material = lineMaterial(materials, {
      color: layer === 0 ? 0x5af6f1 : layer === 1 ? 0x2ebad7 : 0x4f7bca,
      transparent: true,
      opacity: 0.14 - layer * 0.018,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geometry, material);
    line.position.set(0, 3.9 - layer * 2.55, -1.75 + layer * 0.08);
    line.rotation.z = -0.04 + layer * 0.05;
    group.add(line);
    caustics.push({ line, material, baseY: line.position.y, phase: layer * 1.7 });
  }

  const jellyCount = reducedBudget ? 6 : 10;
  const jellyHeadGeometry = new THREE.CircleGeometry(0.28, 14, 0, Math.PI);
  const jellyRingGeometry = new THREE.RingGeometry(0.22, 0.28, 14, 1, 0, Math.PI);
  const tentacleGeometry = createPolylineGeometry(8, (index, count) => {
    const t = index / (count - 1);
    return [Math.sin(t * Math.PI * 2.4) * 0.055, -0.08 - t * 0.58];
  });
  const jellyHeadMaterial = meshMaterial(materials, {
    color: 0x76fff4,
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const jellyRingMaterial = meshMaterial(materials, {
    color: 0x42cce6,
    transparent: true,
    opacity: 0.44,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const tentacleMaterial = lineMaterial(materials, {
    color: 0x6bdbe8,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
  });
  const jellies = [];
  for (let index = 0; index < jellyCount; index += 1) {
    const node = new THREE.Group();
    const head = new THREE.Mesh(jellyHeadGeometry, jellyHeadMaterial);
    const ring = new THREE.Mesh(jellyRingGeometry, jellyRingMaterial);
    const tentacle = new THREE.Line(tentacleGeometry, tentacleMaterial);
    ring.position.z = 0.02;
    tentacle.position.y = -0.02;
    node.add(head, ring, tentacle);
    node.position.z = -1.25 + (index % 3) * 0.06;
    node.scale.setScalar(0.7 + (index % 4) * 0.14);
    group.add(node);
    jellies.push({
      node,
      normalizedX: -0.88 + ((index * 0.37) % 1.76),
      baseX: 0,
      baseY: -4.9 + ((index * 2.17) % 9.8),
      phase: index * 1.71,
    });
  }

  const bubbleCount = reducedBudget ? 34 : 72;
  const bubbleGeometry = new THREE.BufferGeometry();
  const bubblePositions = new Float32Array(bubbleCount * 3);
  const bubbleNormalizedX = new Float32Array(bubbleCount);
  const bubbleBaseY = new Float32Array(bubbleCount);
  const bubbleSpeed = new Float32Array(bubbleCount);
  for (let index = 0; index < bubbleCount; index += 1) {
    bubbleNormalizedX[index] = -0.95 + positiveModulo(index * 0.61803398875, 1.9);
    bubbleBaseY[index] = -7 + positiveModulo(index * 2.371, 14);
    bubbleSpeed[index] = 0.12 + (index % 7) * 0.035;
    bubblePositions[index * 3 + 2] = -1.45;
  }
  bubbleGeometry.setAttribute('position', new THREE.BufferAttribute(bubblePositions, 3));
  const bubbles = new THREE.Points(
    bubbleGeometry,
    pointsMaterial(materials, {
      color: 0x71f6ff,
      size: 0.055,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    }),
  );
  group.add(bubbles);

  function resize(nextWidth, nextHeight) {
    Object.assign(layout, getLayout(nextWidth, nextHeight));
    leftTrench.position.x = -layout.halfWidth - 0.15;
    rightTrench.position.x = layout.halfWidth + 0.15;
    leftEdge.position.x = leftTrench.position.x;
    rightEdge.position.x = rightTrench.position.x;
    floor.scale.x = layout.halfWidth / BASE_HALF_WIDTH;
    for (const caustic of caustics) caustic.line.scale.x = layout.halfWidth / BASE_HALF_WIDTH;
    for (const jelly of jellies) jelly.baseX = jelly.normalizedX * layout.halfWidth;
    for (let index = 0; index < bubbleCount; index += 1) bubblePositions[index * 3] = bubbleNormalizedX[index] * layout.halfWidth;
    bubbleGeometry.attributes.position.needsUpdate = true;
  }

  function update(elapsed, _dt, reducedMotion) {
    const motion = reducedMotion ? 0 : 1;
    for (let index = 0; index < caustics.length; index += 1) {
      const caustic = caustics[index];
      caustic.line.position.x = motion * Math.sin(elapsed * (0.19 + index * 0.07) + caustic.phase) * (0.7 + index * 0.35);
      caustic.line.position.y = caustic.baseY + motion * Math.sin(elapsed * 0.31 + caustic.phase) * 0.16;
      setMaterialBaseOpacity(
        caustic.material,
        0.12 + index * 0.012 + motion * Math.sin(elapsed * 0.7 + caustic.phase) * 0.025,
      );
    }
    for (const jelly of jellies) {
      jelly.node.position.x = jelly.baseX + motion * Math.sin(elapsed * 0.21 + jelly.phase) * 0.36;
      jelly.node.position.y = jelly.baseY + motion * Math.sin(elapsed * 0.43 + jelly.phase) * 0.42;
      jelly.node.rotation.z = motion * Math.sin(elapsed * 0.26 + jelly.phase) * 0.12;
    }
    for (let index = 0; index < bubbleCount; index += 1) {
      bubblePositions[index * 3 + 1] = reducedMotion
        ? bubbleBaseY[index]
        : -7 + positiveModulo(bubbleBaseY[index] + 7 + elapsed * bubbleSpeed[index], 14);
    }
    bubbleGeometry.attributes.position.needsUpdate = true;
  }

  resize(width, height);
  update(0, 0, true);
  const ownership = captureOwnership(group, materials);
  return { group, update, resize, objectCount: ownership.renderables.length, ...ownership };
}

function createSkylineGeometry(layer) {
  const segments = [];
  const buildingCount = 13 - layer * 2;
  const step = (BASE_HALF_WIDTH * 2) / buildingCount;
  let x = -BASE_HALF_WIDTH;
  for (let index = 0; index < buildingCount; index += 1) {
    const width = step * (0.58 + ((index * 7 + layer * 3) % 5) * 0.065);
    const height = 1.2 + ((index * 5 + layer * 4) % 7) * (0.32 + layer * 0.06);
    segments.push([x, 0, x, height], [x, height, x + width, height], [x + width, height, x + width, 0]);
    if ((index + layer) % 3 === 0) segments.push([x + width * 0.5, height, x + width * 0.5, height + 0.55]);
    x += step;
  }
  segments.push([-BASE_HALF_WIDTH, 0, BASE_HALF_WIDTH, 0]);
  return createLineGeometry(segments);
}

function createDataCity({ quality, width, height }) {
  const layout = getLayout(width, height);
  const reducedBudget = isReducedBudget(quality);
  const materials = new Set();
  const group = new THREE.Group();
  group.name = 'realm-data-city';
  group.userData.realm = 'data-city';
  group.add(createBackdrop(materials, 0x060418));

  const skylineLayers = [];
  for (let layer = 0; layer < 3; layer += 1) {
    const material = lineMaterial(materials, {
      color: layer === 0 ? 0x42ffc6 : layer === 1 ? 0x2fbfe8 : 0x925bff,
      transparent: true,
      opacity: 0.14 + layer * 0.06,
      blending: THREE.AdditiveBlending,
    });
    const skyline = new THREE.LineSegments(createSkylineGeometry(layer), material);
    skyline.position.set(0, -5.7 + layer * 0.55, -2.45 + layer * 0.18);
    group.add(skyline);
    skylineLayers.push({ skyline, phase: layer * 2.2, baseY: skyline.position.y });
  }

  const laneSegments = [];
  const horizonY = 5.1;
  const floorY = -7.2;
  for (let lane = -5; lane <= 5; lane += 1) laneSegments.push([lane * 0.22, horizonY, lane * 1.95, floorY]);
  for (let row = 0; row < 11; row += 1) {
    const t = row / 10;
    const eased = t * t;
    const y = horizonY + (floorY - horizonY) * eased;
    const widthAtY = 0.9 + eased * 9.2;
    laneSegments.push([-widthAtY, y, widthAtY, y]);
  }
  const lanes = new THREE.LineSegments(
    createLineGeometry(laneSegments),
    lineMaterial(materials, {
      color: 0x46f7ff,
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
    }),
  );
  lanes.position.z = -1.85;
  group.add(lanes);

  const packetCount = reducedBudget ? 38 : 84;
  const packetGeometry = new THREE.BufferGeometry();
  const packetPositions = new Float32Array(packetCount * 3);
  const packetLane = new Float32Array(packetCount);
  const packetPhase = new Float32Array(packetCount);
  const packetSpeed = new Float32Array(packetCount);
  for (let index = 0; index < packetCount; index += 1) {
    packetLane[index] = -1 + positiveModulo(index * 0.754877666, 2);
    packetPhase[index] = positiveModulo(index * 0.381966011, 1);
    packetSpeed[index] = 0.09 + (index % 9) * 0.012;
    packetPositions[index * 3 + 2] = -1.35;
  }
  packetGeometry.setAttribute('position', new THREE.BufferAttribute(packetPositions, 3));
  const packets = new THREE.Points(
    packetGeometry,
    pointsMaterial(materials, {
      color: 0x7effd3,
      size: 0.075,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
    }),
  );
  group.add(packets);

  const hologramCount = reducedBudget ? 5 : 9;
  const hologramGeometry = new THREE.PlaneGeometry(0.8, 1.15, 1, 1);
  const hologramMaterial = meshMaterial(materials, {
    color: 0x9b62ff,
    wireframe: true,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
  });
  const holograms = [];
  for (let index = 0; index < hologramCount; index += 1) {
    const quad = new THREE.Mesh(hologramGeometry, hologramMaterial);
    quad.position.z = -0.95;
    quad.scale.set(0.6 + (index % 3) * 0.18, 0.75 + (index % 4) * 0.12, 1);
    group.add(quad);
    holograms.push({
      quad,
      normalizedX: index % 2 === 0 ? -0.78 + (index % 3) * 0.12 : 0.72 - (index % 3) * 0.1,
      baseX: 0,
      baseY: -3.7 + positiveModulo(index * 2.43, 8.2),
      phase: index * 1.37,
    });
  }

  function resize(nextWidth, nextHeight) {
    Object.assign(layout, getLayout(nextWidth, nextHeight));
    const horizontalScale = layout.halfWidth / BASE_HALF_WIDTH;
    for (const layer of skylineLayers) layer.skyline.scale.x = horizontalScale;
    lanes.scale.x = horizontalScale;
    for (const hologram of holograms) hologram.baseX = hologram.normalizedX * layout.halfWidth;
  }

  function update(elapsed, _dt, reducedMotion) {
    const motion = reducedMotion ? 0 : 1;
    for (let index = 0; index < skylineLayers.length; index += 1) {
      const layer = skylineLayers[index];
      layer.skyline.position.x = motion * Math.sin(elapsed * (0.08 + index * 0.035) + layer.phase) * (0.2 + index * 0.16);
      layer.skyline.position.y = layer.baseY + motion * Math.sin(elapsed * 0.19 + layer.phase) * 0.045;
    }
    for (let index = 0; index < packetCount; index += 1) {
      const t = reducedMotion ? packetPhase[index] : positiveModulo(packetPhase[index] + elapsed * packetSpeed[index], 1);
      const spread = 0.45 + t * layout.halfWidth * 0.93;
      packetPositions[index * 3] = packetLane[index] * spread;
      packetPositions[index * 3 + 1] = 5.1 - t * 12.3;
    }
    packetGeometry.attributes.position.needsUpdate = true;
    lanes.position.y = motion * positiveModulo(elapsed * 0.23, 0.22);
    for (const hologram of holograms) {
      hologram.quad.position.x = hologram.baseX + motion * Math.sin(elapsed * 0.31 + hologram.phase) * 0.22;
      hologram.quad.position.y = hologram.baseY + motion * Math.sin(elapsed * 0.77 + hologram.phase) * 0.18;
      hologram.quad.rotation.z = motion * Math.sin(elapsed * 0.29 + hologram.phase) * 0.08;
    }
  }

  resize(width, height);
  update(0, 0, true);
  const ownership = captureOwnership(group, materials);
  return { group, update, resize, objectCount: ownership.renderables.length, ...ownership };
}

function createRadialCrackGeometry(layer) {
  const segments = [];
  const rayCount = 11 - layer * 2;
  for (let ray = 0; ray < rayCount; ray += 1) {
    const angle = (ray / rayCount) * TAU + layer * 0.31;
    let radius = 1.2 + layer * 0.25;
    let previousX = Math.cos(angle) * radius;
    let previousY = Math.sin(angle) * radius;
    const steps = 3 + (ray % 3);
    for (let step = 0; step < steps; step += 1) {
      radius += 0.65 + ((ray + step + layer) % 3) * 0.22;
      const jaggedAngle = angle + Math.sin(ray * 3.1 + step * 2.7) * 0.12;
      const nextX = Math.cos(jaggedAngle) * radius;
      const nextY = Math.sin(jaggedAngle) * radius;
      segments.push([previousX, previousY, nextX, nextY]);
      previousX = nextX;
      previousY = nextY;
    }
  }
  return createLineGeometry(segments);
}

function createStarForge({ quality, width, height }) {
  const layout = getLayout(width, height);
  const reducedBudget = isReducedBudget(quality);
  const materials = new Set();
  const group = new THREE.Group();
  group.name = 'realm-star-forge';
  group.userData.realm = 'star-forge';
  group.add(createBackdrop(materials, 0x160609));

  const forgeRoot = new THREE.Group();
  forgeRoot.position.z = -1.8;
  group.add(forgeRoot);
  const coronaMaterial = meshMaterial(materials, {
    color: 0xffa33c,
    transparent: true,
    opacity: 0.26,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const coronaRings = [];
  for (let index = 0; index < 4; index += 1) {
    const radius = 1.35 + index * 0.82;
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.045 + index * 0.012, 48), coronaMaterial);
    ring.scale.y = 0.86 + index * 0.025;
    forgeRoot.add(ring);
    coronaRings.push({ ring, phase: index * 1.19, baseScaleY: ring.scale.y });
  }

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(1.02, 40),
    meshMaterial(materials, {
      color: 0xff5b2b,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
    }),
  );
  core.position.z = -0.05;
  forgeRoot.add(core);

  const crackLayers = [];
  for (let layer = 0; layer < 3; layer += 1) {
    const material = lineMaterial(materials, {
      color: layer === 0 ? 0xffd066 : layer === 1 ? 0xff6f3f : 0xff305f,
      transparent: true,
      opacity: 0.18 - layer * 0.025,
      blending: THREE.AdditiveBlending,
    });
    const cracks = new THREE.LineSegments(createRadialCrackGeometry(layer), material);
    cracks.position.z = -0.12 + layer * 0.04;
    forgeRoot.add(cracks);
    crackLayers.push({ cracks, material, phase: layer * 2.03 });
  }

  const heatLensMaterial = meshMaterial(materials, {
    color: 0xffc36b,
    wireframe: true,
    transparent: true,
    opacity: 0.09,
    blending: THREE.AdditiveBlending,
  });
  const heatLenses = [];
  for (let index = 0; index < 2; index += 1) {
    const lens = new THREE.Mesh(new THREE.CircleGeometry(2.15 + index * 1.4, 32), heatLensMaterial);
    lens.position.z = -0.35 - index * 0.04;
    lens.scale.y = 0.62 + index * 0.09;
    forgeRoot.add(lens);
    heatLenses.push({ lens, baseScaleY: lens.scale.y, phase: index * 2.6 });
  }

  const debrisCount = reducedBudget ? 48 : 96;
  const debrisGeometry = new THREE.BufferGeometry();
  const debrisPositions = new Float32Array(debrisCount * 3);
  const debrisRadius = new Float32Array(debrisCount);
  const debrisAngle = new Float32Array(debrisCount);
  const debrisSpeed = new Float32Array(debrisCount);
  for (let index = 0; index < debrisCount; index += 1) {
    debrisRadius[index] = 1.4 + positiveModulo(index * 0.713, 4.8);
    debrisAngle[index] = positiveModulo(index * 2.39996323, TAU);
    debrisSpeed[index] = 0.025 + (index % 11) * 0.004;
    debrisPositions[index * 3 + 2] = 0.08;
  }
  debrisGeometry.setAttribute('position', new THREE.BufferAttribute(debrisPositions, 3));
  const debris = new THREE.Points(
    debrisGeometry,
    pointsMaterial(materials, {
      color: 0xffbc64,
      size: 0.075,
      transparent: true,
      opacity: 0.68,
      blending: THREE.AdditiveBlending,
    }),
  );
  forgeRoot.add(debris);

  const flareCount = reducedBudget ? 4 : 8;
  const flareGeometry = createShapeGeometry([[0, 0.08], [1.8, 0], [0, -0.08]]);
  const flareMaterial = meshMaterial(materials, {
    color: 0xff6a35,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const flares = [];
  for (let index = 0; index < flareCount; index += 1) {
    const flare = new THREE.Mesh(flareGeometry, flareMaterial);
    const angle = (index / flareCount) * TAU;
    flare.rotation.z = angle;
    flare.position.z = -0.08;
    forgeRoot.add(flare);
    flares.push({ flare, angle, phase: index * 0.83 });
  }

  function resize(nextWidth, nextHeight) {
    Object.assign(layout, getLayout(nextWidth, nextHeight));
    forgeRoot.position.x = layout.halfWidth * 0.48;
    forgeRoot.position.y = 2.1;
    const wideScale = Math.min(1.12, 0.94 + (layout.halfWidth - 9.4) * 0.025);
    forgeRoot.scale.setScalar(wideScale);
  }

  function update(elapsed, _dt, reducedMotion) {
    const motion = reducedMotion ? 0 : 1;
    for (let index = 0; index < coronaRings.length; index += 1) {
      const corona = coronaRings[index];
      corona.ring.rotation.z = motion * elapsed * (index % 2 === 0 ? 0.018 + index * 0.004 : -0.016 - index * 0.004);
      corona.ring.scale.y = corona.baseScaleY + motion * Math.sin(elapsed * 0.43 + corona.phase) * 0.025;
    }
    core.scale.setScalar(1 + motion * Math.sin(elapsed * 0.72) * 0.06);
    for (let index = 0; index < crackLayers.length; index += 1) {
      const layer = crackLayers[index];
      layer.cracks.rotation.z = motion * Math.sin(elapsed * (0.09 + index * 0.02) + layer.phase) * 0.12;
      setMaterialBaseOpacity(
        layer.material,
        0.13 + index * 0.018 + motion * Math.sin(elapsed * 0.8 + layer.phase) * 0.035,
      );
    }
    for (const heatLens of heatLenses) {
      heatLens.lens.rotation.z = motion * Math.sin(elapsed * 0.14 + heatLens.phase) * 0.1;
      heatLens.lens.scale.y = heatLens.baseScaleY + motion * Math.sin(elapsed * 0.22 + heatLens.phase) * 0.035;
    }
    for (let index = 0; index < debrisCount; index += 1) {
      const angle = debrisAngle[index] + motion * elapsed * debrisSpeed[index];
      debrisPositions[index * 3] = Math.cos(angle) * debrisRadius[index];
      debrisPositions[index * 3 + 1] = Math.sin(angle) * debrisRadius[index] * 0.72;
    }
    debrisGeometry.attributes.position.needsUpdate = true;
    for (const flare of flares) {
      const pulse = 0.86 + motion * (Math.sin(elapsed * 0.65 + flare.phase) * 0.5 + 0.5) * 0.34;
      flare.flare.scale.set(pulse, 0.8 + pulse * 0.15, 1);
      flare.flare.rotation.z = flare.angle + motion * Math.sin(elapsed * 0.11 + flare.phase) * 0.04;
    }
  }

  resize(width, height);
  update(0, 0, true);
  const ownership = captureOwnership(group, materials);
  return { group, update, resize, objectCount: ownership.renderables.length, ...ownership };
}

function createVoidCathedral({ quality, width, height }) {
  const layout = getLayout(width, height);
  const reducedBudget = isReducedBudget(quality);
  const materials = new Set();
  const group = new THREE.Group();
  group.name = 'realm-void-cathedral';
  group.userData.realm = 'void-cathedral';
  group.add(createBackdrop(materials, 0x080710));

  const cathedralRoot = new THREE.Group();
  cathedralRoot.position.set(0, 0.6, -1.95);
  group.add(cathedralRoot);
  const ringMaterial = meshMaterial(materials, {
    color: 0xd8e7ff,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const octagonalRings = [];
  for (let index = 0; index < 5; index += 1) {
    const radius = 1.25 + index * 1.15;
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.035, 8), ringMaterial);
    ring.scale.y = 0.82 + index * 0.035;
    ring.rotation.z = Math.PI / 8;
    cathedralRoot.add(ring);
    octagonalRings.push({ ring, baseScaleY: ring.scale.y, phase: index * 1.47 });
  }

  const prismCount = reducedBudget ? 5 : 8;
  const prismGeometry = createShapeGeometry([[0, 0.72], [-0.42, -0.38], [0.42, -0.38]]);
  const prismMaterial = meshMaterial(materials, {
    color: 0xac82ff,
    wireframe: true,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const prisms = [];
  for (let index = 0; index < prismCount; index += 1) {
    const prism = new THREE.Mesh(prismGeometry, prismMaterial);
    prism.position.z = -0.15 + (index % 2) * 0.05;
    prism.scale.setScalar(0.7 + (index % 3) * 0.22);
    group.add(prism);
    prisms.push({
      prism,
      side: index % 2 === 0 ? -1 : 1,
      row: Math.floor(index / 2),
      baseX: 0,
      baseY: -4.5 + Math.floor(index / 2) * 2.6,
      phase: index * 1.29,
    });
  }

  const beamSegments = [];
  for (let index = 0; index < 7; index += 1) {
    const x = -8.4 + index * 2.8;
    beamSegments.push([0, 6.9, x, -6.8]);
  }
  beamSegments.push([-9.4, -5.8, 0, 6.9], [9.4, -5.8, 0, 6.9]);
  const crackMaterial = lineMaterial(materials, {
    color: 0xb98aff,
    transparent: true,
    opacity: 0.12,
    blending: THREE.AdditiveBlending,
  });
  const crackBeams = new THREE.LineSegments(createLineGeometry(beamSegments), crackMaterial);
  crackBeams.position.z = -1.35;
  group.add(crackBeams);

  const flowCount = reducedBudget ? 44 : 92;
  const flowGeometry = new THREE.BufferGeometry();
  const flowPositions = new Float32Array(flowCount * 3);
  const flowNormalizedX = new Float32Array(flowCount);
  const flowPhase = new Float32Array(flowCount);
  const flowSpeed = new Float32Array(flowCount);
  for (let index = 0; index < flowCount; index += 1) {
    const column = (index % 9) - 4;
    flowNormalizedX[index] = column / 5.1 + Math.sin(index * 2.7) * 0.025;
    flowPhase[index] = positiveModulo(index * 0.414213562, 1);
    flowSpeed[index] = 0.055 + (index % 8) * 0.009;
    flowPositions[index * 3 + 2] = -0.92;
  }
  flowGeometry.setAttribute('position', new THREE.BufferAttribute(flowPositions, 3));
  const reverseFlow = new THREE.Points(
    flowGeometry,
    pointsMaterial(materials, {
      color: 0xe2f2ff,
      size: 0.052,
      transparent: true,
      opacity: 0.66,
      blending: THREE.AdditiveBlending,
    }),
  );
  group.add(reverseFlow);

  function resize(nextWidth, nextHeight) {
    Object.assign(layout, getLayout(nextWidth, nextHeight));
    const horizontalScale = layout.halfWidth / BASE_HALF_WIDTH;
    crackBeams.scale.x = horizontalScale;
    cathedralRoot.scale.x = Math.min(1.12, 0.94 + horizontalScale * 0.08);
    for (const prism of prisms) prism.baseX = prism.side * (layout.halfWidth * (0.73 - prism.row * 0.035));
  }

  function update(elapsed, _dt, reducedMotion) {
    const motion = reducedMotion ? 0 : 1;
    for (let index = 0; index < octagonalRings.length; index += 1) {
      const octagon = octagonalRings[index];
      octagon.ring.rotation.z = Math.PI / 8 + motion * elapsed * (index % 2 === 0 ? 0.008 + index * 0.002 : -0.007 - index * 0.002);
      octagon.ring.scale.y = octagon.baseScaleY + motion * Math.sin(elapsed * 0.22 + octagon.phase) * 0.018;
    }
    for (const prism of prisms) {
      prism.prism.position.x = prism.baseX + motion * Math.sin(elapsed * 0.17 + prism.phase) * 0.24;
      prism.prism.position.y = prism.baseY + motion * Math.sin(elapsed * 0.31 + prism.phase) * 0.34;
      prism.prism.rotation.z = (prism.side < 0 ? -Math.PI / 2 : Math.PI / 2)
        + motion * Math.sin(elapsed * 0.13 + prism.phase) * 0.13;
    }
    for (let index = 0; index < flowCount; index += 1) {
      const t = reducedMotion ? flowPhase[index] : positiveModulo(flowPhase[index] - elapsed * flowSpeed[index], 1);
      flowPositions[index * 3] = flowNormalizedX[index] * layout.halfWidth;
      flowPositions[index * 3 + 1] = -7 + t * 14;
    }
    flowGeometry.attributes.position.needsUpdate = true;
    setMaterialBaseOpacity(
      crackMaterial,
      0.11 + motion * (Math.sin(elapsed * 0.46) * 0.5 + 0.5) * 0.07,
    );
  }

  resize(width, height);
  update(0, 0, true);
  const ownership = captureOwnership(group, materials);
  return { group, update, resize, objectCount: ownership.renderables.length, ...ownership };
}

/**
 * Owns four fixed realm scene graphs. Builders allocate once; frame updates only
 * mutate transforms, material values, and existing position buffers.
 */
export function createRealmBackgrounds({ scene, quality, width, height }) {
  if (!scene?.add || !scene?.remove) throw new TypeError('createRealmBackgrounds requires a Three.js scene');

  const root = new THREE.Group();
  root.name = 'realm-backgrounds';
  root.userData.realmBackgroundRoot = true;
  root.position.z = -5;
  scene.add(root);

  const builders = [createAbyss, createDataCity, createStarForge, createVoidCathedral].map((build) => build({
    quality,
    width,
    height,
  }));
  builders.forEach((builder, index) => {
    builder.group.visible = index === 0;
    root.add(builder.group);
  });

  let activeRealm = 0;
  let transition = null;
  let queuedRealm = null;
  let disposed = false;
  let lastElapsed = 0;
  let lastReducedMotion = true;
  let animationDirtyMask = 0;
  let auditDirtyMask = 0;
  let nextRealmAuditAt = REALM_AUDIT_INTERVAL;
  const realmWeights = [1, 0, 0, 0];
  const updateCounts = [0, 0, 0, 0];
  const objectCounts = builders.map((builder) => builder.objectCount);
  const debug = {
    updateCalls: 0,
    stableSkips: 0,
    rootGuards: 0,
    realmAudits: 0,
    allRealmAudits: 0,
    objectChecks: 0,
    materialChecks: 0,
    corrections: 0,
  };

  function sanitizeObjectTransform(object, rootObject = false) {
    let corrected = false;
    const position = object.position;
    if (!Number.isFinite(position.x)) { position.x = 0; corrected = true; }
    if (!Number.isFinite(position.y)) { position.y = 0; corrected = true; }
    if (!Number.isFinite(position.z)) { position.z = rootObject ? -5 : 0; corrected = true; }
    const rotation = object.rotation;
    if (!Number.isFinite(rotation.x)) { rotation.x = 0; corrected = true; }
    if (!Number.isFinite(rotation.y)) { rotation.y = 0; corrected = true; }
    if (!Number.isFinite(rotation.z)) { rotation.z = 0; corrected = true; }
    const scale = object.scale;
    if (!Number.isFinite(scale.x)) { scale.x = 1; corrected = true; }
    if (!Number.isFinite(scale.y)) { scale.y = 1; corrected = true; }
    if (!Number.isFinite(scale.z)) { scale.z = 1; corrected = true; }
    return corrected;
  }

  function sanitizeMaterial(material) {
    if (!material) return false;
    debug.materialChecks += 1;
    let corrected = false;
    let baseOpacity = material.userData.realmBaseOpacity;
    if (!Number.isFinite(baseOpacity)) {
      baseOpacity = Number.isFinite(material.opacity) ? material.opacity : 1;
      material.userData.realmBaseOpacity = THREE.MathUtils.clamp(baseOpacity, 0, 1);
      corrected = true;
    }
    if (!Number.isFinite(material.opacity)) {
      material.opacity = material.userData.realmBaseOpacity;
      corrected = true;
    } else {
      const opacity = THREE.MathUtils.clamp(material.opacity, 0, 1);
      if (opacity !== material.opacity) corrected = true;
      material.opacity = opacity;
    }
    return corrected;
  }

  function sanitizeRoot() {
    debug.rootGuards += 1;
    const corrected = sanitizeObjectTransform(root, true);
    if (corrected) debug.corrections += 1;
    return corrected;
  }

  function sanitizeBuilder(builder) {
    debug.realmAudits += 1;
    let corrected = false;
    for (const object of builder.objects) {
      debug.objectChecks += 1;
      if (sanitizeObjectTransform(object)) corrected = true;
    }
    for (const material of builder.materials) {
      if (sanitizeMaterial(material)) corrected = true;
    }
    for (const renderable of builder.renderables) {
      const currentMaterials = renderable.material;
      if (Array.isArray(currentMaterials)) {
        for (const material of currentMaterials) {
          if (!builder.materialSet.has(material) && sanitizeMaterial(material)) corrected = true;
        }
      } else if (!builder.materialSet.has(currentMaterials) && sanitizeMaterial(currentMaterials)) {
        corrected = true;
      }
    }
    if (corrected) debug.corrections += 1;
    return corrected;
  }

  function auditAllRealms() {
    if (disposed) return false;
    debug.allRealmAudits += 1;
    let corrected = sanitizeRoot();
    for (const builder of builders) {
      if (sanitizeBuilder(builder)) corrected = true;
    }
    auditDirtyMask = 0;
    nextRealmAuditAt = Number.isFinite(lastElapsed)
      ? lastElapsed + REALM_AUDIT_INTERVAL
      : REALM_AUDIT_INTERVAL;
    return corrected;
  }

  function shouldAuditRealms(safeElapsed, animationChanged, relevantDirty) {
    if (relevantDirty) return true;
    if (!animationChanged) return false;
    if (DEVELOPMENT_AUDITS) return true;
    return safeElapsed < lastElapsed || safeElapsed >= nextRealmAuditAt;
  }

  function setTransparent(material, transparent) {
    if (material.transparent === transparent) return;
    material.transparent = transparent;
    material.needsUpdate = true;
  }

  function restoreBuilderMaterials(builder) {
    for (const material of builder.materials) {
      material.opacity = material.userData.realmBaseOpacity ?? 1;
      setTransparent(material, material.userData.realmBaseTransparent ?? false);
    }
    const backdrop = builder.group.children[0];
    backdrop.renderOrder = -100;
  }

  function applyBuilderPresentation(builder, weight, realmIndex) {
    const safeWeight = THREE.MathUtils.clamp(weight, 0, 1);
    for (const material of builder.materials) {
      if (material.userData.realmBackdrop) continue;
      setTransparent(material, true);
      material.opacity = (material.userData.realmBaseOpacity ?? 1) * safeWeight;
    }
    const direction = realmIndex % 2 === 0 ? -1 : 1;
    builder.group.scale.setScalar(0.94 + safeWeight * 0.06);
    builder.group.position.set(direction * (1 - safeWeight) * 0.32, (1 - safeWeight) * 0.08, 0);
  }

  function applyBackdropPresentation(outgoingRealm, incomingRealm, incomingWeight) {
    const outgoing = builders[outgoingRealm].group.children[0];
    const incoming = builders[incomingRealm].group.children[0];
    outgoing.material.opacity = outgoing.material.userData.realmBaseOpacity ?? 1;
    setTransparent(outgoing.material, false);
    outgoing.renderOrder = -102;
    incoming.material.opacity = THREE.MathUtils.clamp(incomingWeight, 0, 1);
    setTransparent(incoming.material, true);
    incoming.renderOrder = -101;
  }

  function normalizeBuilder(builder, visible = false) {
    restoreBuilderMaterials(builder);
    builder.group.position.set(0, 0, 0);
    builder.group.scale.set(1, 1, 1);
    builder.group.visible = visible;
  }

  function finishTransition(realm = activeRealm) {
    activeRealm = clampRealm(realm);
    transition = null;
    queuedRealm = null;
    builders.forEach((builder, index) => {
      realmWeights[index] = index === activeRealm ? 1 : 0;
      normalizeBuilder(builder, index === activeRealm);
    });
  }

  function beginTransition(nextRealm) {
    const outgoingRealm = activeRealm;
    activeRealm = clampRealm(nextRealm);
    queuedRealm = null;
    animationDirtyMask |= (1 << outgoingRealm) | (1 << activeRealm);
    auditDirtyMask |= (1 << outgoingRealm) | (1 << activeRealm);
    builders.forEach((builder, builderIndex) => {
      normalizeBuilder(builder, builderIndex === outgoingRealm || builderIndex === activeRealm);
    });
    realmWeights[outgoingRealm] = 1;
    realmWeights[activeRealm] = 0;
    transition = {
      outgoingRealm,
      incomingRealm: activeRealm,
      elapsed: 0,
    };
    applyBuilderPresentation(builders[outgoingRealm], 1, outgoingRealm);
    applyBuilderPresentation(builders[activeRealm], 0, activeRealm);
    applyBackdropPresentation(outgoingRealm, activeRealm, 0);
  }

  function completeTransition() {
    const completedRealm = transition.incomingRealm;
    const nextRealm = queuedRealm;
    finishTransition(completedRealm);
    if (nextRealm !== null && nextRealm !== completedRealm) beginTransition(nextRealm);
  }

  function setRealm(index, immediate = false) {
    if (disposed) return activeRealm;
    const nextRealm = clampRealm(index);
    if (immediate) {
      finishTransition(nextRealm);
      builders[activeRealm].update(0, 0, true);
      restoreBuilderMaterials(builders[activeRealm]);
      auditDirtyMask |= 1 << activeRealm;
      lastElapsed = Number.NaN;
      lastReducedMotion = true;
      return activeRealm;
    }
    if (transition) {
      queuedRealm = nextRealm === activeRealm ? null : nextRealm;
      return activeRealm;
    }
    if (nextRealm === activeRealm) return activeRealm;
    beginTransition(nextRealm);
    return activeRealm;
  }

  function update({ elapsed = 0, dt = 0, reducedMotion = false } = {}) {
    if (disposed) return false;
    debug.updateCalls += 1;
    sanitizeRoot();
    const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;
    const safeDt = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const motionReduced = Boolean(reducedMotion);
    const animationChanged = safeElapsed !== lastElapsed || motionReduced !== lastReducedMotion;

    if (transition && motionReduced) finishTransition(queuedRealm ?? activeRealm);
    if (!transition) {
      const realmDirty = (animationDirtyMask & (1 << activeRealm)) !== 0;
      if (!animationChanged && !realmDirty) {
        debug.stableSkips += 1;
        return true;
      }
      const builder = builders[activeRealm];
      builder.update(safeElapsed, safeDt, motionReduced);
      restoreBuilderMaterials(builder);
      animationDirtyMask &= ~(1 << activeRealm);
      updateCounts[activeRealm] += 1;
      if (shouldAuditRealms(safeElapsed, animationChanged, (auditDirtyMask & (1 << activeRealm)) !== 0)) {
        sanitizeBuilder(builder);
        auditDirtyMask &= ~(1 << activeRealm);
        nextRealmAuditAt = safeElapsed + REALM_AUDIT_INTERVAL;
      }
      lastElapsed = safeElapsed;
      lastReducedMotion = motionReduced;
      return true;
    }

    const { outgoingRealm, incomingRealm } = transition;
    const outgoingDirty = (animationDirtyMask & (1 << outgoingRealm)) !== 0;
    const incomingDirty = (animationDirtyMask & (1 << incomingRealm)) !== 0;
    const transitionAdvances = safeDt > 0;
    if (!animationChanged && !outgoingDirty && !incomingDirty && !transitionAdvances) {
      debug.stableSkips += 1;
      return true;
    }
    if (animationChanged || outgoingDirty) {
      builders[outgoingRealm].update(safeElapsed, safeDt, false);
      animationDirtyMask &= ~(1 << outgoingRealm);
      updateCounts[outgoingRealm] += 1;
    }
    if (animationChanged || incomingDirty) {
      builders[incomingRealm].update(safeElapsed, safeDt, false);
      animationDirtyMask &= ~(1 << incomingRealm);
      updateCounts[incomingRealm] += 1;
    }
    transition.elapsed = Math.min(REALM_TRANSITION_DURATION, transition.elapsed + safeDt);
    const progress = transition.elapsed / REALM_TRANSITION_DURATION;
    const eased = progress * progress * (3 - 2 * progress);
    realmWeights[outgoingRealm] = 1 - eased;
    realmWeights[incomingRealm] = eased;
    applyBuilderPresentation(builders[outgoingRealm], realmWeights[outgoingRealm], outgoingRealm);
    applyBuilderPresentation(builders[incomingRealm], realmWeights[incomingRealm], incomingRealm);
    applyBackdropPresentation(outgoingRealm, incomingRealm, realmWeights[incomingRealm]);
    const relevantAuditDirty = (auditDirtyMask & ((1 << outgoingRealm) | (1 << incomingRealm))) !== 0;
    if (shouldAuditRealms(safeElapsed, animationChanged, relevantAuditDirty)) {
      sanitizeBuilder(builders[outgoingRealm]);
      sanitizeBuilder(builders[incomingRealm]);
      auditDirtyMask &= ~((1 << outgoingRealm) | (1 << incomingRealm));
      nextRealmAuditAt = safeElapsed + REALM_AUDIT_INTERVAL;
    }
    if (transition.elapsed >= REALM_TRANSITION_DURATION) completeTransition();
    lastElapsed = safeElapsed;
    lastReducedMotion = motionReduced;
    return true;
  }

  function resize(nextWidth, nextHeight) {
    if (disposed) return false;
    for (const builder of builders) builder.resize(nextWidth, nextHeight);
    animationDirtyMask = (1 << builders.length) - 1;
    auditDirtyMask = animationDirtyMask;
    auditAllRealms();
    return true;
  }

  function reset() {
    if (disposed) return false;
    builders.forEach((builder, index) => {
      builder.update(0, 0, true);
      realmWeights[index] = index === 0 ? 1 : 0;
      normalizeBuilder(builder, index === 0);
    });
    activeRealm = 0;
    transition = null;
    queuedRealm = null;
    lastElapsed = 0;
    lastReducedMotion = true;
    animationDirtyMask = 0;
    auditDirtyMask = 0;
    nextRealmAuditAt = REALM_AUDIT_INTERVAL;
    updateCounts.fill(0);
    auditAllRealms();
    return true;
  }

  function dispose() {
    if (disposed) return false;
    auditAllRealms();
    disposed = true;
    scene.remove(root);
    const disposedGeometries = new Set();
    const disposedMaterials = new Set();
    for (const builder of builders) {
      for (const geometry of builder.geometries) {
        if (disposedGeometries.has(geometry)) continue;
        disposedGeometries.add(geometry);
        geometry.dispose();
      }
      for (const material of builder.materials) {
        if (disposedMaterials.has(material)) continue;
        disposedMaterials.add(material);
        material.dispose();
      }
    }
    return true;
  }

  function recoverCorruption() {
    return auditAllRealms();
  }

  function getStats() {
    return {
      activeRealm,
      visibleGroups: builders.reduce((count, builder) => count + (builder.group.visible ? 1 : 0), 0),
      updateCounts: [...updateCounts],
      objectCounts: [...objectCounts],
      ownership: {
        objectCounts: builders.map((builder) => builder.objects.length),
        renderableCounts: builders.map((builder) => builder.renderables.length),
        materialCounts: builders.map((builder) => builder.materials.length),
        geometryCounts: builders.map((builder) => builder.geometries.length),
      },
      debug: { ...debug },
      disposed,
    };
  }

  return Object.freeze({ setRealm, update, resize, reset, recoverCorruption, dispose, getStats });
}
