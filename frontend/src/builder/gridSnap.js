import {
  LDU_HALF_STUD,
  LDU_PLATE,
  LDU_STUD,
  ROTATION_STEP_90,
} from "../core/constants.js";

/**
 * Redondea un valor al múltiplo más cercano de `step`.
 */
export function snapValue(value, step) {
  if (!step || step <= 0) return value;
  const snapped = Math.round(value / step) * step;
  return Object.is(snapped, -0) ? 0 : snapped;
}

/**
 * Determina el desplazamiento de paridad (0 o 10 LDU) a partir del borde mínimo
 * (`box.min`) de la pieza rotada en el origen. Funciona tanto para piezas simétricas
 * (ej. `1x6` donde `min.x = -10`) como asimétricas/desplazadas (ej. `3660` Slope Inverted
 * 2x2 donde `min.z = -30` y `max.z = +10`), alineando los studs sobre la misma grilla.
 */
export function computeWallParityOffset(minLdu) {
  const halfStuds = Math.round(minLdu / LDU_HALF_STUD);
  return Math.abs(halfStuds) % 2 === 1 ? LDU_HALF_STUD : 0;
}

/**
 * Calcula el desplazamiento de paridad (0 o 10 LDU) a partir de la coordenada
 * real de un stud superior (`studCoordLdu`), para que dicho stud caiga siempre
 * en el centro del cuadrado de grilla (`20*k + 10`).
 */
export function computeStudCoordParityOffset(studCoordLdu) {
  const halfStuds = Math.round(studCoordLdu / LDU_HALF_STUD);
  return Math.abs(halfStuds) % 2 === 0 ? LDU_HALF_STUD : 0;
}

export function computeStudParityOffset(spanLdu) {
  const studs = Math.max(1, Math.round(spanLdu / LDU_STUD));
  return studs % 2 === 1 ? LDU_HALF_STUD : 0;
}

/**
 * Alinea una coordenada tangente para que `origin + refOffset` caiga exactamente
 * sobre `anchorCoord + step * k` (ideal para encastrar en studs laterales de brackets).
 */
export function snapToReferenceCoord(targetCoord, refOffset, anchorCoord, step = LDU_STUD) {
  const desiredOriginBase = anchorCoord - refOffset;
  return desiredOriginBase + snapValue(targetCoord - desiredOriginBase, step);
}

/**
 * Convierte cualquier normal 3D al eje cardinal más cercano (`±X`, `±Y`, `±Z`).
 */
export function snapNormalToCardinal(nx, ny, nz) {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  if (ay >= ax && ay >= az) {
    return { x: 0, y: ny >= 0 ? 1 : -1, z: 0 };
  }
  if (ax >= ay && ax >= az) {
    return { x: nx >= 0 ? 1 : -1, y: 0, z: 0 };
  }
  return { x: 0, y: 0, z: nz >= 0 ? 1 : -1 };
}

/**
 * Calcula la posición horizontal (X, Z) alineada a grilla LDU.
 * En modo estándar (20 LDU) aplica la paridad de studs para alinear stud-con-stud;
 * en modo fino (`fineGrid: true`, 10 LDU) permite también posiciones intermedias.
 * @param {number} x
 * @param {number} z
 * @param {{ fineGrid?: boolean, offsetX?: number, offsetZ?: number }} options
 */
export function snapXZ(x, z, options = {}) {
  if (options.fineGrid) {
    return {
      x: snapValue(x, LDU_HALF_STUD),
      z: snapValue(z, LDU_HALF_STUD),
    };
  }
  const ox = options.offsetX || 0;
  const oz = options.offsetZ || 0;
  return {
    x: snapValue(x - ox, LDU_STUD) + ox,
    z: snapValue(z - oz, LDU_STUD) + oz,
  };
}

/**
 * Estima la altura de superficie sobre la cual apoyar una nueva pieza.
 * Los studs sobresalen ~4 LDU; restar 2 LDU al impacto superior hace que
 * tanto la cara plana (ej. 24) como la punta del stud (28) caigan en 24.
 */
export function computeSurfaceY(hitY, isTableHit) {
  if (isTableHit || hitY <= 1) {
    return 0;
  }
  return Math.max(0, snapValue(hitY - 2, LDU_PLATE));
}

/**
 * Calcula la coordenada Y del origen de la pieza para que su superficie de apoyo
 * (`supportUndersideY`, igual a `localMinY` en ladrillos normales o al plano de la
 * pestaña en brackets colgantes) descanse sobre `surfaceY`, sin atravesar la mesa (y >= 0).
 */
export function computeSnappedPlacementY(
  surfaceY,
  localMinY,
  manualOffsetY = 0,
  supportUndersideY = localMinY
) {
  const tableMinLift = Math.ceil((-localMinY - 0.01) / LDU_PLATE) * LDU_PLATE;
  const supportLift = Math.ceil((-supportUndersideY - 0.01) / LDU_PLATE) * LDU_PLATE;
  return Math.max(tableMinLift, surfaceY + supportLift + manualOffsetY);
}

/**
 * Normaliza un ángulo en radianes al múltiplo más cercano de `step`.
 */
export function snapAngle(angleRad, step = ROTATION_STEP_90) {
  const full = Math.PI * 2;
  const snapped = snapValue(angleRad, step);
  const normalized = ((snapped % full) + full) % full;
  return Math.abs(normalized - full) < 1e-6 ? 0 : normalized;
}

/**
 * Calcula la distancia exacta desde el origen local de la pieza hasta su plano
 * de apoyo en dirección `-dirNormal` (proyectando todas sus cajas de colisión
 * rotadas por `quat`). Permite encastrar grosores arbitrarios (4 LDU, 8 LDU, 24 LDU)
 * sin redondear a múltiplos rígidos.
 */
export function computeSupportDistanceAlongDir(boxes, quat, dirNormal) {
  if (!boxes?.length) return 0;
  let minProj = Infinity;
  const nx = dirNormal.x;
  const ny = dirNormal.y;
  const nz = dirNormal.z;

  const rotateVec = (vx, vy, vz, q) => {
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    const qw = q.w;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return [
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    ];
  };

  for (const entry of boxes) {
    const box = entry.box || entry;
    const lp = entry.box ? entry.localPos : null;
    const lq = entry.box ? entry.localQuat : null;
    const xs = [box.min.x, box.max.x];
    const ys = [box.min.y, box.max.y];
    const zs = [box.min.z, box.max.z];
    for (let ix = 0; ix < 2; ix += 1) {
      for (let iy = 0; iy < 2; iy += 1) {
        for (let iz = 0; iz < 2; iz += 1) {
          let vx = xs[ix];
          let vy = ys[iy];
          let vz = zs[iz];
          if (lq && lp) {
            [vx, vy, vz] = rotateVec(vx, vy, vz, lq);
            vx += lp.x;
            vy += lp.y;
            vz += lp.z;
          }
          const [px, py, pz] = rotateVec(vx, vy, vz, quat);
          const proj = px * nx + py * ny + pz * nz;
          if (proj < minProj) minProj = proj;
        }
      }
    }
  }
  return Number.isFinite(minProj) ? -minProj : 0;
}

/**
 * Calcula la altura Y real más alta debajo de la huella horizontal `[minX..maxX, minZ..maxZ]`
 * exigiendo solapamiento mínimo (`minOverlapLdu`) para evitar que una pieza quede flotando
 * sostenida apenas por un borde o esquina sin soporte debajo.
 */
export function computeSupportedSurfaceY(
  minX,
  maxX,
  minZ,
  maxZ,
  placedBoxes,
  maxSurfaceY = Infinity,
  minOverlapLdu = 4
) {
  let bestY = 0;
  if (!placedBoxes?.length) return bestY;
  for (const box of placedBoxes) {
    if (!box) continue;
    const bMinX = box.min ? box.min.x : box.minX;
    const bMaxX = box.max ? box.max.x : box.maxX;
    const bMaxY = box.max ? box.max.y : box.maxY;
    const bMinZ = box.min ? box.min.z : box.minZ;
    const bMaxZ = box.max ? box.max.z : box.maxZ;
    if (bMaxY > maxSurfaceY + 2) continue;
    const overlapX = Math.min(maxX, bMaxX) - Math.max(minX, bMinX);
    const overlapZ = Math.min(maxZ, bMaxZ) - Math.max(minZ, bMinZ);
    if (overlapX >= minOverlapLdu && overlapZ >= minOverlapLdu && bMaxY > bestY) {
      bestY = bMaxY;
    }
  }
  return bestY;
}
