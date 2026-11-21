import * as THREE from "three";

const MAX_LEAF_TRIANGLES = 12;
const MIN_PENETRATION_LDU = 0.32;
const INTERIOR_MARGIN_LDU = 0.55;

const _scratchMatA = new THREE.Matrix4();
const _scratchMatB = new THREE.Matrix4();
const _scratchMatBtoA = new THREE.Matrix4();
const _scratchMatAtoB = new THREE.Matrix4();
const _scratchVec = new THREE.Vector3();
const _unitScale = new THREE.Vector3(1, 1, 1);

function countRayHitsAxis(px, py, pz, node, axis, dirSign = 1) {
  if (!node) return 0;
  if (axis === 0) {
    if (
      py < node.minY ||
      py > node.maxY ||
      pz < node.minZ ||
      pz > node.maxZ ||
      (dirSign > 0 ? px > node.maxX : px < node.minX)
    ) {
      return 0;
    }
  } else if (axis === 1) {
    if (
      px < node.minX ||
      px > node.maxX ||
      pz < node.minZ ||
      pz > node.maxZ ||
      (dirSign > 0 ? py > node.maxY : py < node.minY)
    ) {
      return 0;
    }
  } else if (
    px < node.minX ||
    px > node.maxX ||
    py < node.minY ||
    py > node.maxY ||
    (dirSign > 0 ? pz > node.maxZ : pz < node.minZ)
  ) {
    return 0;
  }

  if (node.tris) {
    let hits = 0;
    const u = axis === 0 ? py : px;
    const v = axis === 2 ? py : pz;
    const w = axis === 0 ? px : axis === 1 ? py : pz;

    for (let i = 0; i < node.tris.length; i += 1) {
      const t = node.tris[i];
      if (axis === 0) {
        if (
          py < t.minY ||
          py > t.maxY ||
          pz < t.minZ ||
          pz > t.maxZ ||
          (dirSign > 0 ? px > t.maxX : px < t.minX)
        ) {
          continue;
        }
      } else if (axis === 1) {
        if (
          px < t.minX ||
          px > t.maxX ||
          pz < t.minZ ||
          pz > t.maxZ ||
          (dirSign > 0 ? py > t.maxY : py < t.minY)
        ) {
          continue;
        }
      } else if (
        px < t.minX ||
        px > t.maxX ||
        py < t.minY ||
        py > t.maxY ||
        (dirSign > 0 ? pz > t.maxZ : pz < t.minZ)
      ) {
        continue;
      }

      const au = axis === 0 ? t.ay : t.ax;
      const bu = axis === 0 ? t.by : t.bx;
      const cu = axis === 0 ? t.cy : t.cx;
      const av = axis === 2 ? t.ay : t.az;
      const bv = axis === 2 ? t.by : t.bz;
      const cv = axis === 2 ? t.cy : t.cz;

      const d1 = (u - bu) * (av - bv) - (au - bu) * (v - bv);
      const d2 = (u - cu) * (bv - cv) - (bu - cu) * (v - cv);
      const d3 = (u - au) * (cv - av) - (cu - au) * (v - av);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (hasNeg && hasPos) continue;

      const denom = (bv - cv) * (au - cu) + (cu - bu) * (av - cv);
      if (Math.abs(denom) < 1e-8) continue;

      const w1 = ((bv - cv) * (u - cu) + (cu - bu) * (v - cv)) / denom;
      const w2 = ((cv - av) * (u - cu) + (au - cu) * (v - cv)) / denom;
      const w3 = 1 - w1 - w2;
      const aw = axis === 0 ? t.ax : axis === 1 ? t.ay : t.az;
      const bw = axis === 0 ? t.bx : axis === 1 ? t.by : t.bz;
      const cw = axis === 0 ? t.cx : axis === 1 ? t.cy : t.cz;
      const hitW = w1 * aw + w2 * bw + w3 * cw;
      if (dirSign > 0 ? hitW > w + 0.05 : hitW < w - 0.05) hits += 1;
    }
    return hits;
  }

  return (
    countRayHitsAxis(px, py, pz, node.left, axis, dirSign) +
    countRayHitsAxis(px, py, pz, node.right, axis, dirSign)
  );
}

/**
 * Comprueba paridad impar en los 3 ejes (+-X, +-Y, +-Z) para distinguir plástico sólido
 * real de huecos/túneles pasantes o caras abiertas de LDraw.
 */
function isPointInsideBvh(px, py, pz, bvh) {
  return (
    countRayHitsAxis(px, py, pz, bvh, 1, 1) % 2 === 1 &&
    countRayHitsAxis(px, py, pz, bvh, 1, -1) % 2 === 1 &&
    countRayHitsAxis(px, py, pz, bvh, 0, 1) % 2 === 1 &&
    countRayHitsAxis(px, py, pz, bvh, 0, -1) % 2 === 1 &&
    countRayHitsAxis(px, py, pz, bvh, 2, 1) % 2 === 1 &&
    countRayHitsAxis(px, py, pz, bvh, 2, -1) % 2 === 1
  );
}

/**
 * Tucks radially protruding Technic pin retention lips / friction ribs (5.90..6.65 LDU)
 * inward to 5.90 LDU so slotted pins can slide smoothly inside 6.00 LDU pin holes without
 * relaxing collision checks for solid parts or stop collars (r > 6.65).
 */
function compressPinRetentionLip(pt, pinBarrels, tmpDiff) {
  if (!pinBarrels || !pinBarrels.length) return;
  for (let i = 0; i < pinBarrels.length; i += 1) {
    const b = pinBarrels[i];
    tmpDiff.subVectors(pt, b.pos);
    const proj = tmpDiff.dot(b.dir);
    if (proj < b.minProj || proj > b.maxProj) continue;
    const radSq = tmpDiff.lengthSq() - proj * proj;
    if (radSq <= 5.9 * 5.9 || radSq > 6.65 * 6.65) continue;
    const r = Math.sqrt(radSq);
    const scale = 5.9 / r;
    const perpX = tmpDiff.x - b.dir.x * proj;
    const perpY = tmpDiff.y - b.dir.y * proj;
    const perpZ = tmpDiff.z - b.dir.z * proj;
    pt.x = b.pos.x + b.dir.x * proj + perpX * scale;
    pt.y = b.pos.y + b.dir.y * proj + perpY * scale;
    pt.z = b.pos.z + b.dir.z * proj + perpZ * scale;
    return;
  }
}

/**
 * Construye una BVH de triángulos (sin studs) y puntos interiores sólidos para refinar
 * colisiones cuando las cajas OBB de fase amplia reportan contacto en piezas curvas/diagonales.
 */
export function buildCollisionMeshData(
  wrapper,
  topStuds = [],
  collisionBoxes = [],
  pinBarrels = []
) {
  wrapper.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(wrapper.matrixWorld).invert();
  const relMat = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const center = new THREE.Vector3();
  const diff = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();

  // Exigimos altura > 0.08 LDU para no borrar caras superiores planas (ej. rect.dat en y=0 de 6541)
  const isStudPt = (pt) => {
    for (let i = 0; i < topStuds.length; i += 1) {
      const s = topStuds[i];
      diff.subVectors(pt, s.pos);
      const proj = diff.dot(s.up);
      if (proj >= 0.08 && proj <= (s.height || 4) + 0.7) {
        if (diff.lengthSq() - proj * proj <= 6.35 * 6.35) return true;
      }
    }
    return false;
  };

  const tris = [];
  wrapper.traverse((child) => {
    if (!child.isMesh || !child.geometry || child.userData?.isSticker) return;
    const posAttr = child.geometry.attributes?.position;
    if (!posAttr) return;
    relMat.multiplyMatrices(invRoot, child.matrixWorld);
    const idxAttr = child.geometry.index;
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);

    for (let i = 0; i < triCount; i += 1) {
      const i0 = idxAttr ? idxAttr.getX(i * 3) : i * 3;
      const i1 = idxAttr ? idxAttr.getX(i * 3 + 1) : i * 3 + 1;
      const i2 = idxAttr ? idxAttr.getX(i * 3 + 2) : i * 3 + 2;

      a.fromBufferAttribute(posAttr, i0).applyMatrix4(relMat);
      b.fromBufferAttribute(posAttr, i1).applyMatrix4(relMat);
      c.fromBufferAttribute(posAttr, i2).applyMatrix4(relMat);
      center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      if (isStudPt(center)) continue;

      if (pinBarrels.length) {
        compressPinRetentionLip(a, pinBarrels, diff);
        compressPinRetentionLip(b, pinBarrels, diff);
        compressPinRetentionLip(c, pinBarrels, diff);
      }

      ab.subVectors(b, a);
      ac.subVectors(c, a);
      if (ab.cross(ac).lengthSq() < 1e-8) continue;

      tris.push({
        ax: a.x,
        ay: a.y,
        az: a.z,
        bx: b.x,
        by: b.y,
        bz: b.z,
        cx: c.x,
        cy: c.y,
        cz: c.z,
        minX: Math.min(a.x, b.x, c.x),
        maxX: Math.max(a.x, b.x, c.x),
        minY: Math.min(a.y, b.y, c.y),
        maxY: Math.max(a.y, b.y, c.y),
        minZ: Math.min(a.z, b.z, c.z),
        maxZ: Math.max(a.z, b.z, c.z),
        sortX: center.x,
        sortY: center.y,
        sortZ: center.z,
      });
    }
  });

  if (!tris.length) {
    return { bvh: null, interiorPts: [] };
  }

  const buildCleanNode = (list) => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      if (t.minX < minX) minX = t.minX;
      if (t.maxX > maxX) maxX = t.maxX;
      if (t.minY < minY) minY = t.minY;
      if (t.maxY > maxY) maxY = t.maxY;
      if (t.minZ < minZ) minZ = t.minZ;
      if (t.maxZ > maxZ) maxZ = t.maxZ;
    }
    if (list.length <= MAX_LEAF_TRIANGLES) {
      return { minX, minY, minZ, maxX, maxY, maxZ, tris: list };
    }
    const sx = maxX - minX;
    const sy = maxY - minY;
    const sz = maxZ - minZ;
    const axis = sx >= sy && sx >= sz ? "sortX" : sy >= sz ? "sortY" : "sortZ";
    list.sort((u, v) => u[axis] - v[axis]);
    const mid = list.length >> 1;
    return {
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      left: buildCleanNode(list.slice(0, mid)),
      right: buildCleanNode(list.slice(mid)),
    };
  };

  const bvh = buildCleanNode(tris);
  // Exigimos paridad impar en los 3 ejes para que huecos/túneles o caras abiertas nunca cuenten como sólido
  const isDeepInterior = (px, py, pz) =>
    isPointInsideBvh(px, py, pz, bvh) &&
    countRayHitsAxis(px - INTERIOR_MARGIN_LDU, py, pz, bvh, 1, 1) % 2 === 1 &&
    countRayHitsAxis(px + INTERIOR_MARGIN_LDU, py, pz, bvh, 1, 1) % 2 === 1 &&
    countRayHitsAxis(px, py, pz - INTERIOR_MARGIN_LDU, bvh, 1, 1) % 2 === 1 &&
    countRayHitsAxis(px, py, pz + INTERIOR_MARGIN_LDU, bvh, 1, 1) % 2 === 1;

  const interiorPts = [];
  for (let i = 0; i < collisionBoxes.length; i += 1) {
    const box = collisionBoxes[i].box || collisionBoxes[i];
    const px = (box.min.x + box.max.x) * 0.5;
    const py = (box.min.y + box.max.y) * 0.5;
    const pz = (box.min.z + box.max.z) * 0.5;
    if (isDeepInterior(px, py, pz)) {
      interiorPts.push({ x: px, y: py, z: pz });
      if (interiorPts.length >= 16) break;
    }
  }

  return { bvh, interiorPts };
}

function pointDistSqToSeg(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const lenSq = abx * abx + aby * aby + abz * abz;
  if (lenSq < 1e-10) return apx * apx + apy * apy + apz * apz;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / lenSq));
  const rx = apx - abx * t;
  const ry = apy - aby * t;
  const rz = apz - abz * t;
  return rx * rx + ry * ry + rz * rz;
}

function segIntersectsTriStrict(
  p0x,
  p0y,
  p0z,
  p1x,
  p1y,
  p1z,
  ax,
  ay,
  az,
  bx,
  by,
  bz,
  cx,
  cy,
  cz
) {
  const e1x = bx - ax;
  const e1y = by - ay;
  const e1z = bz - az;
  const e2x = cx - ax;
  const e2y = cy - ay;
  const e2z = cz - az;
  const dx = p1x - p0x;
  const dy = p1y - p0y;
  const dz = p1z - p0z;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-8) return false;

  const invDet = 1 / det;
  const tx = p0x - ax;
  const ty = p0y - ay;
  const tz = p0z - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u <= 0.001 || u >= 0.999) return false;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v <= 0.001 || u + v >= 0.999) return false;

  const k = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  if (k <= 0.001 || k >= 0.999) return false;

  // Exige profundidad mínima real en LDU para ignorar roces de teselado poligonal (ej. eje en pin hole)
  const hx = p0x + dx * k;
  const hy = p0y + dy * k;
  const hz = p0z + dz * k;
  const d0Sq = (hx - p0x) ** 2 + (hy - p0y) ** 2 + (hz - p0z) ** 2;
  const d1Sq = (p1x - hx) ** 2 + (p1y - hy) ** 2 + (p1z - hz) ** 2;
  const minPenSq = MIN_PENETRATION_LDU * MIN_PENETRATION_LDU;
  if (d0Sq < minPenSq || d1Sq < minPenSq) return false;

  const edgeSq = Math.min(
    pointDistSqToSeg(hx, hy, hz, ax, ay, az, bx, by, bz),
    pointDistSqToSeg(hx, hy, hz, bx, by, bz, cx, cy, cz),
    pointDistSqToSeg(hx, hy, hz, cx, cy, cz, ax, ay, az)
  );
  if (edgeSq < minPenSq) return false;

  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const nLenSq = nx * nx + ny * ny + nz * nz;
  if (nLenSq < 1e-10) return false;
  const plane0 = ((p0x - ax) * nx + (p0y - ay) * ny + (p0z - az) * nz) ** 2 / nLenSq;
  const plane1 = ((p1x - ax) * nx + (p1y - ay) * ny + (p1z - az) * nz) ** 2 / nLenSq;
  return plane0 >= minPenSq && plane1 >= minPenSq;
}

function transformedBoxOverlapsNode(nodeA, nodeB, e) {
  const xs0 = nodeB.minX;
  const xs1 = nodeB.maxX;
  const ys0 = nodeB.minY;
  const ys1 = nodeB.maxY;
  const zs0 = nodeB.minZ;
  const zs1 = nodeB.maxZ;

  let bMinX = Infinity;
  let bMinY = Infinity;
  let bMinZ = Infinity;
  let bMaxX = -Infinity;
  let bMaxY = -Infinity;
  let bMaxZ = -Infinity;

  for (let ix = 0; ix < 2; ix += 1) {
    const x = ix === 0 ? xs0 : xs1;
    for (let iy = 0; iy < 2; iy += 1) {
      const y = iy === 0 ? ys0 : ys1;
      for (let iz = 0; iz < 2; iz += 1) {
        const z = iz === 0 ? zs0 : zs1;
        const tx = e[0] * x + e[4] * y + e[8] * z + e[12];
        const ty = e[1] * x + e[5] * y + e[9] * z + e[13];
        const tz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (tx < bMinX) bMinX = tx;
        if (tx > bMaxX) bMaxX = tx;
        if (ty < bMinY) bMinY = ty;
        if (ty > bMaxY) bMaxY = ty;
        if (tz < bMinZ) bMinZ = tz;
        if (tz > bMaxZ) bMaxZ = tz;
      }
    }
  }

  return !(
    bMaxX < nodeA.minX ||
    bMinX > nodeA.maxX ||
    bMaxY < nodeA.minY ||
    bMinY > nodeA.maxY ||
    bMaxZ < nodeA.minZ ||
    bMinZ > nodeA.maxZ
  );
}

function bvhNodesOverlap(nodeA, nodeB, e) {
  if (!transformedBoxOverlapsNode(nodeA, nodeB, e)) {
    return false;
  }

  if (nodeA.tris && nodeB.tris) {
    for (let j = 0; j < nodeB.tris.length; j += 1) {
      const tb = nodeB.tris[j];
      const bax = e[0] * tb.ax + e[4] * tb.ay + e[8] * tb.az + e[12];
      const bay = e[1] * tb.ax + e[5] * tb.ay + e[9] * tb.az + e[13];
      const baz = e[2] * tb.ax + e[6] * tb.ay + e[10] * tb.az + e[14];
      const bbx = e[0] * tb.bx + e[4] * tb.by + e[8] * tb.bz + e[12];
      const bby = e[1] * tb.bx + e[5] * tb.by + e[9] * tb.bz + e[13];
      const bbz = e[2] * tb.bx + e[6] * tb.by + e[10] * tb.bz + e[14];
      const bcx = e[0] * tb.cx + e[4] * tb.cy + e[8] * tb.cz + e[12];
      const bcy = e[1] * tb.cx + e[5] * tb.cy + e[9] * tb.cz + e[13];
      const bcz = e[2] * tb.cx + e[6] * tb.cy + e[10] * tb.cz + e[14];

      const tMinX = Math.min(bax, bbx, bcx);
      const tMaxX = Math.max(bax, bbx, bcx);
      const tMinY = Math.min(bay, bby, bcy);
      const tMaxY = Math.max(bay, bby, bcy);
      const tMinZ = Math.min(baz, bbz, bcz);
      const tMaxZ = Math.max(baz, bbz, bcz);

      for (let i = 0; i < nodeA.tris.length; i += 1) {
        const ta = nodeA.tris[i];
        if (
          tMaxX < ta.minX ||
          tMinX > ta.maxX ||
          tMaxY < ta.minY ||
          tMinY > ta.maxY ||
          tMaxZ < ta.minZ ||
          tMinZ > ta.maxZ
        ) {
          continue;
        }
        if (
          segIntersectsTriStrict(ta.ax, ta.ay, ta.az, ta.bx, ta.by, ta.bz, bax, bay, baz, bbx, bby, bbz, bcx, bcy, bcz) ||
          segIntersectsTriStrict(ta.bx, ta.by, ta.bz, ta.cx, ta.cy, ta.cz, bax, bay, baz, bbx, bby, bbz, bcx, bcy, bcz) ||
          segIntersectsTriStrict(ta.cx, ta.cy, ta.cz, ta.ax, ta.ay, ta.az, bax, bay, baz, bbx, bby, bbz, bcx, bcy, bcz) ||
          segIntersectsTriStrict(bax, bay, baz, bbx, bby, bbz, ta.ax, ta.ay, ta.az, ta.bx, ta.by, ta.bz, ta.cx, ta.cy, ta.cz) ||
          segIntersectsTriStrict(bbx, bby, bbz, bcx, bcy, bcz, ta.ax, ta.ay, ta.az, ta.bx, ta.by, ta.bz, ta.cx, ta.cy, ta.cz) ||
          segIntersectsTriStrict(bcx, bcy, bcz, bax, bay, baz, ta.ax, ta.ay, ta.az, ta.bx, ta.by, ta.bz, ta.cx, ta.cy, ta.cz)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  if (!nodeA.tris) {
    return (
      bvhNodesOverlap(nodeA.left, nodeB, e) ||
      bvhNodesOverlap(nodeA.right, nodeB, e)
    );
  }
  return (
    bvhNodesOverlap(nodeA, nodeB.left, e) ||
    bvhNodesOverlap(nodeA, nodeB.right, e)
  );
}

/**
 * Comprueba colisión geométrica exacta (triángulos BVH + inclusión interior) entre dos piezas.
 */
export function checkMeshBvhCollision(meshDataA, posA, quatA, meshDataB, posB, quatB) {
  if (!meshDataA?.bvh || !meshDataB?.bvh) return true;

  _scratchMatA.compose(posA, quatA, _unitScale);
  _scratchMatB.compose(posB, quatB, _unitScale);
  _scratchMatBtoA.copy(_scratchMatA).invert().multiply(_scratchMatB);

  if (bvhNodesOverlap(meshDataA.bvh, meshDataB.bvh, _scratchMatBtoA.elements)) {
    return true;
  }

  _scratchMatAtoB.copy(_scratchMatBtoA).invert();
  for (let i = 0; i < meshDataA.interiorPts.length; i += 1) {
    const pt = meshDataA.interiorPts[i];
    _scratchVec.set(pt.x, pt.y, pt.z).applyMatrix4(_scratchMatAtoB);
    if (isPointInsideBvh(_scratchVec.x, _scratchVec.y, _scratchVec.z, meshDataB.bvh)) {
      return true;
    }
  }

  for (let i = 0; i < meshDataB.interiorPts.length; i += 1) {
    const pt = meshDataB.interiorPts[i];
    _scratchVec.set(pt.x, pt.y, pt.z).applyMatrix4(_scratchMatBtoA);
    if (isPointInsideBvh(_scratchVec.x, _scratchVec.y, _scratchVec.z, meshDataA.bvh)) {
      return true;
    }
  }

  return false;
}
