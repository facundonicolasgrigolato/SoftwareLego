import * as THREE from "three";

const TOP_STUD_FILE_RE = /(?:^|[\\/])stud(?!3\b|4)[0-9a-z]*\.dat$/i;
const TECH_PIN_HOLE_RE = /(?:^|[\\/])peghole\.dat$/i;
const TECH_PIN_BARREL_RE = /(?:^|[\\/])(connect(?!hole|collar|slit|ring)\w*|confric(?!rib)\w*)\.dat$/i;
const TECH_PIN_LIP_RE = /(?:^|[\\/])(connectcollar\w*|confricrib\w*)\.dat$/i;
const AXLE_PLUG_RE = /(?:^|[\\/])(axleend\w*|axles\w*|axle)\.dat$/i;
const AXLE_HOLE_RE = /(?:^|[\\/])axlehol\d*\.dat$/i;
const MINIFIG_HAND_RE = /(?:^|[\\/])3820\.dat$/i;
const CLIP_PRIM_RE = /(?:^|[\\/])clip\d+\.dat$/i;
const CLH_HINGE_RE = /(?:^|[\\/])clh(\d+)\.dat$/i;
const BALL_SOCKET_RE = /(?:^|[\\/])joint\d*socket\d*\.dat$/i;
const BALL_SPHERE_RE = /(?:^|[\\/])(?:8-8|4-8)sphe\.dat$/i;
const BAR_CYL_RE = /(?:^|[\\/])4-4cyl[ico]\.dat$/i;
const HINGE_FORK_PIN_RE = /(?:^|[\\/])2-4cylo\.dat$/i;
const HINGE_TOP_KNUCKLE_RE = /(?:^|[\\/])4-4cylo\.dat$/i;
const CLIP_CURVE_RE = /(?:^|[\\/])(?:\d+-\d+(?:cylo|cyli|ndis))\.dat$/i;

const GRIP_HAND_ANGLE_RAD = (14.5 * Math.PI) / 180;
const _tmpColY = new THREE.Vector3();

function snapDirToClean(v) {
  return v.clone().normalize();
}

/** Fuerza signo canónico positivo en la componente dominante para ejes no orientados (bisagras). */
function canonicalAxis(v) {
  const n = v.clone().normalize();
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ax >= ay && ax >= az && n.x < 0) n.negate();
  else if (ay >= ax && ay >= az && n.y < 0) n.negate();
  else if (az > ax && az > ay && n.z < 0) n.negate();
  return n;
}

function getMatrixAxes(mat) {
  const e = mat.elements;
  const x = new THREE.Vector3(e[0], e[1], e[2]);
  const y = new THREE.Vector3(e[4], e[5], e[6]);
  const z = new THREE.Vector3(e[8], e[9], e[10]);
  return { x, y, z };
}

/**
 * Extrae centro y eje del canal r≈4 dentro de primitivas `clip*.dat` usando parseCache.
 */
function inferClipGripLocal(clipFileName, parseCache) {
  const info = parseCache.getData(clipFileName, false);
  if (!info?.subobjects?.length) {
    return { pos: new THREE.Vector3(0, 0, 0), axis: new THREE.Vector3(0, 1, 0) };
  }

  const cylHits = [];
  const ringHits = [];
  for (const sub of info.subobjects) {
    const clean = (sub.fileName || "").toLowerCase();
    if (!CLIP_CURVE_RE.test(clean)) continue;
    const { x, y, z } = getMatrixAxes(sub.matrix);
    const lx = x.length();
    const ly = y.length();
    const lz = z.length();
    const origin = new THREE.Vector3().setFromMatrixPosition(sub.matrix);

    if (/(?:cylo|cyli)\.dat$/i.test(clean)) {
      // Excluimos cuellos excéntricos (ej. 3-16cylo rx≈3.55 en clip6): el agarre real tiene r≈3.7..4.3
      if (lx >= 3.68 && lx <= 4.35 && lz >= 3.68 && lz <= 4.35 && ly >= 4.0) {
        const axis = y.clone().normalize();
        cylHits.push({ mid: origin.clone().addScaledVector(axis, ly * 0.5), axis });
      }
    } else if (/ndis\.dat$/i.test(clean)) {
      // Un disco/anillo r≈4 tiene dos ejes de radio ~4 y un eje normal ~1
      const lens = [
        { len: lx, vec: x },
        { len: ly, vec: y },
        { len: lz, vec: z },
      ].sort((u, v) => u.len - v.len);
      if (lens[1].len >= 3.7 && lens[1].len <= 4.3 && lens[2].len >= 3.7 && lens[2].len <= 4.3) {
        ringHits.push({ mid: origin, axis: lens[0].vec.clone().normalize() });
      }
    }
  }

  const hits = cylHits.length ? cylHits : ringHits;
  if (!hits.length) {
    return { pos: new THREE.Vector3(0, 0, 0), axis: new THREE.Vector3(0, 1, 0) };
  }

  const sumPos = new THREE.Vector3();
  for (const h of hits) {
    sumPos.add(h.mid);
  }
  sumPos.divideScalar(hits.length);
  return { pos: sumPos, axis: canonicalAxis(hits[0].axis) };
}

/**
 * Fusiona segmentos colineales de barras `4-4cyli`/`4-4cylo` r≈4 (ej. hojas/empuñaduras por tramos)
 * y genera puntos de agarre útiles a lo largo de mangos largos.
 */
function buildMergedBarConnectors(rawBars) {
  if (!rawBars.length) return [];
  const groups = [];

  for (const seg of rawBars) {
    let matched = null;
    for (const g of groups) {
      if (Math.abs(g.axis.dot(seg.axis)) < 0.98) continue;
      // Distancia perpendicular entre ejes de los dos tramos
      const diff = new THREE.Vector3().subVectors(seg.p0, g.origin);
      const proj = diff.dot(g.axis);
      const perpSq = Math.max(0, diff.lengthSq() - proj * proj);
      if (perpSq > 0.6 * 0.6) continue;
      const s0 = proj;
      const s1 = proj + seg.axis.dot(g.axis) * seg.length;
      const segMin = Math.min(s0, s1);
      const segMax = Math.max(s0, s1);
      if (segMax >= g.minS - 1.5 && segMin <= g.maxS + 1.5) {
        g.minS = Math.min(g.minS, segMin);
        g.maxS = Math.max(g.maxS, segMax);
        matched = g;
        break;
      }
    }
    if (!matched) {
      groups.push({
        origin: seg.p0.clone(),
        axis: seg.axis.clone(),
        minS: 0,
        maxS: seg.length,
      });
    }
  }

  const out = [];
  for (const g of groups) {
    const totalLen = g.maxS - g.minS;
    if (totalLen < 6.0) continue;
    // Para barras cortas (<=28 LDU, manijas/clips) centro único; para mangos largos, 3 puntos a lo largo
    const fracs = totalLen <= 28 ? [0.5] : [0.22, 0.5, 0.78];
    for (const f of fracs) {
      const s = g.minS + totalLen * f;
      out.push({
        kind: "bar",
        role: "plug",
        pos: g.origin.clone().addScaledVector(g.axis, s),
        dir: g.axis.clone(),
        halfLength: totalLen * 0.5,
      });
    }
  }
  return out;
}

/**
 * Detecta pivotes clásicos de bisagra (p.ej. horquilla base `3937` vs muñones top `6134`)
 * buscando cilindros simétricos horizontales de bisagra en el subárbol LDraw.
 */
function buildClassicHingeConnectors(hingeCyls) {
  const forks = [];
  const knuckles = [];
  for (const item of hingeCyls) {
    if (Math.abs(item.axis.y) > 0.25) continue;
    if (item.kind === "fork_pin") forks.push(item);
    else if (item.kind === "knuckle") knuckles.push(item);
  }

  const out = [];
  // Bisagra base con pin central horizontal r≈2 (ej. `3937`: len≈4 en ±0, y=-10, z=0)
  for (const f of forks) {
    if (f.r >= 1.8 && f.r <= 2.3 && f.len >= 3.5 && f.len <= 8.5 && Math.abs(f.mid.z) <= 2) {
      out.push({
        kind: "hinge",
        role: "classic_fork",
        pos: new THREE.Vector3(0, f.mid.y, f.mid.z),
        dir: new THREE.Vector3(0, 1, 0),
        crossAxis: canonicalAxis(f.axis),
      });
      break;
    }
  }

  // Bisagra superior con par simétrico de muñones r≈4 en lados opuestos (ej. `6134`)
  for (let i = 0; i < knuckles.length; i += 1) {
    const a = knuckles[i];
    if (a.r < 3.6 || a.r > 4.4 || a.len < 3.5 || a.len > 6.5) continue;
    for (let j = i + 1; j < knuckles.length; j += 1) {
      const b = knuckles[j];
      if (b.r < 3.6 || b.r > 4.4 || b.len < 3.5 || b.len > 6.5) continue;
      if (Math.abs(a.axis.dot(b.axis)) < 0.95) continue;
      const mid = new THREE.Vector3().addVectors(a.mid, b.mid).multiplyScalar(0.5);
      const span = a.mid.distanceTo(b.mid);
      if (span >= 24 && span <= 48 && Math.abs(a.mid.y - b.mid.y) < 0.5) {
        out.push({
          kind: "hinge",
          role: "classic_top",
          pos: mid,
          dir: new THREE.Vector3(0, 1, 0),
          crossAxis: canonicalAxis(a.axis),
        });
        return out;
      }
    }
  }

  return out;
}

/**
 * Recorre una única vez el árbol parseado de LDraw (`parseCache`) y extrae:
 * - `topStuds` (`stud*.dat`)
 * - `pinBarrels` (labios flexibles de pins para `meshCollision.js`)
 * - `connectors` unificados (`pin`, `axle`, `bar`, `hinge`, `ball`)
 */
export function extractPartFeatures(datFileName, parseCache) {
  if (!parseCache) {
    return { topStuds: [], pinBarrels: [], connectors: [] };
  }

  const topStuds = [];
  const pinBarrels = [];
  const connectors = [];
  const collarRibTips = [];
  const rawBars = [];
  const hingeCyls = [];
  const flipMat = new THREE.Matrix4().makeRotationX(Math.PI);

  const walk = (fileName, parentMatrix, depth) => {
    if (depth > 8) return;
    const info = parseCache.getData(fileName, false);
    if (!info || !Array.isArray(info.subobjects)) return;

    for (const sub of info.subobjects) {
      const nextMat = parentMatrix.clone().multiply(sub.matrix);
      const cleanName = (sub.fileName || "").toLowerCase();

      if (TOP_STUD_FILE_RE.test(cleanName)) {
        _tmpColY.set(nextMat.elements[4], nextMat.elements[5], nextMat.elements[6]);
        const studHeight = Math.min(9.5, 4 * _tmpColY.length());
        const up = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        topStuds.push({ pos, up, height: studHeight });
        continue;
      }

      if (TECH_PIN_HOLE_RE.test(cleanName)) {
        const dir = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        connectors.push({ kind: "pin", role: "hole", pos, dir });
        continue;
      }

      if (TECH_PIN_BARREL_RE.test(cleanName)) {
        const dir = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        connectors.push({ kind: "pin", role: "plug", pos, dir });
        pinBarrels.push({
          pos: pos.clone(),
          dir: dir.clone(),
          minProj: -0.05,
          maxProj: 40.5,
        });
        continue;
      }

      if (TECH_PIN_LIP_RE.test(cleanName)) {
        const dir = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        pinBarrels.push({
          pos: pos.clone(),
          dir: dir.clone(),
          minProj: -2.5,
          maxProj: 2.5,
        });
        if (/confricrib2\.dat$/i.test(cleanName)) {
          collarRibTips.push({ pos, dir });
        }
        continue;
      }

      if (MINIFIG_HAND_RE.test(cleanName)) {
        // En LDraw 3820.dat: centro de agarre en (0, -0.8229, -9.8948) y ángulo de mano 14.5°
        const pos = new THREE.Vector3(0, -0.8229, -9.8948).applyMatrix4(nextMat);
        const dir = new THREE.Vector3(
          0,
          Math.cos(GRIP_HAND_ANGLE_RAD),
          Math.sin(GRIP_HAND_ANGLE_RAD)
        )
          .transformDirection(nextMat)
          .normalize();
        const crossAxis = new THREE.Vector3(
          0,
          -Math.sin(GRIP_HAND_ANGLE_RAD),
          Math.cos(GRIP_HAND_ANGLE_RAD)
        )
          .transformDirection(nextMat)
          .normalize();
        connectors.push({ kind: "bar", role: "grip", pos, dir, crossAxis });
        continue;
      }

      if (CLIP_PRIM_RE.test(cleanName)) {
        const localGrip = inferClipGripLocal(sub.fileName, parseCache);
        const pos = localGrip.pos.clone().applyMatrix4(nextMat);
        const dir = localGrip.axis.clone().transformDirection(nextMat).normalize();
        const crossAxis = new THREE.Vector3(0, 0, 1).transformDirection(nextMat).normalize();
        connectors.push({ kind: "bar", role: "grip", pos, dir, crossAxis });
        continue;
      }

      if (AXLE_PLUG_RE.test(cleanName)) {
        const { x, y } = getMatrixAxes(nextMat);
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        const dir = y.clone().normalize().negate();
        const crossAxis = x.clone().normalize();
        connectors.push({ kind: "axle", role: "plug", pos, dir, crossAxis });
        continue;
      }

      if (AXLE_HOLE_RE.test(cleanName)) {
        const { x, y } = getMatrixAxes(nextMat);
        const len = y.length();
        if (len >= 4 && len <= 26) {
          const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
          const axis = y.clone().normalize();
          const crossAxis = x.clone().normalize();
          // Emitimos ambas bocas del túnel en cruz (inicio y fin)
          connectors.push({
            kind: "axle",
            role: "hole",
            pos: origin.clone(),
            dir: axis.clone().negate(),
            crossAxis: crossAxis.clone(),
          });
          connectors.push({
            kind: "axle",
            role: "hole",
            pos: origin.clone().addScaledVector(axis, len),
            dir: axis.clone(),
            crossAxis: crossAxis.clone(),
          });
        }
        continue;
      }

      const clhMatch = cleanName.match(CLH_HINGE_RE);
      if (clhMatch) {
        const { x, z } = getMatrixAxes(nextMat);
        const zDir = z.clone().normalize();
        const clhCode = Number(clhMatch[1]);
        // `clh6` (1 dedo) sobresale en -Z local; `clh10`/`clh11` (2 dedos) en +Z local
        const offsetSign = clhCode <= 6 ? -1 : 1;
        const pos = new THREE.Vector3(0, 0, 0)
          .applyMatrix4(nextMat)
          .addScaledVector(zDir, offsetSign * 10);
        const outDir = zDir.clone().multiplyScalar(offsetSign);
        const axis = canonicalAxis(x);
        const role = clhCode <= 6 ? "clh_single" : "clh_dual";
        const dup = connectors.some(
          (c) => c.kind === "hinge" && c.role === role && c.pos.distanceToSquared(pos) < 0.25
        );
        if (!dup) {
          connectors.push({
            kind: "hinge",
            role,
            pos,
            dir: outDir,
            crossAxis: axis,
          });
        }
        continue;
      }

      if (BALL_SOCKET_RE.test(cleanName)) {
        const { z } = getMatrixAxes(nextMat);
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        connectors.push({
          kind: "ball",
          role: "socket",
          pos,
          dir: z.clone().normalize().negate(),
        });
        continue;
      }

      if (BALL_SPHERE_RE.test(cleanName)) {
        const { x } = getMatrixAxes(nextMat);
        const r = x.length();
        if (r >= 7.0 && r <= 9.0) {
          const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
          connectors.push({
            kind: "ball",
            role: "plug",
            pos,
            dir: x.clone().normalize(),
          });
        }
        continue;
      }

      if (BAR_CYL_RE.test(cleanName) && !sub.invertNext) {
        const { x, y, z } = getMatrixAxes(nextMat);
        const rx = x.length();
        const rz = z.length();
        const len = y.length();
        if (rx >= 3.7 && rx <= 4.3 && rz >= 3.7 && rz <= 4.3 && len >= 2.0) {
          const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
          rawBars.push({ p0, axis: y.clone().normalize(), length: len });
        }
      }

      if (HINGE_FORK_PIN_RE.test(cleanName) || HINGE_TOP_KNUCKLE_RE.test(cleanName)) {
        const { x, y } = getMatrixAxes(nextMat);
        const r = x.length();
        const len = y.length();
        const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        const axis = y.clone().normalize();
        const mid = p0.clone().addScaledVector(axis, len * 0.5);
        hingeCyls.push({
          kind: HINGE_FORK_PIN_RE.test(cleanName) ? "fork_pin" : "knuckle",
          mid,
          axis,
          r,
          len,
        });
      }

      walk(sub.fileName, nextMat, depth + 1);
    }
  };

  walk(datFileName, flipMat, 0);

  if (collarRibTips.length > 0 && !connectors.some((c) => c.kind === "pin" && c.role === "plug")) {
    for (const tip of collarRibTips) {
      connectors.push({
        kind: "pin",
        role: "plug",
        pos: tip.pos.clone().addScaledVector(tip.dir, -2),
        dir: tip.dir.clone(),
      });
    }
  }

  for (const bar of buildMergedBarConnectors(rawBars)) {
    connectors.push(bar);
  }
  for (const hc of buildClassicHingeConnectors(hingeCyls)) {
    connectors.push(hc);
  }

  const axlePlugs = connectors.filter((c) => c.kind === "axle" && c.role === "plug");
  const filteredConnectors =
    axlePlugs.length > 0
      ? connectors.filter((c) => {
          if (c.kind !== "axle" || c.role !== "hole") return true;
          return !axlePlugs.some((p) => {
            if (Math.abs(p.dir.dot(c.dir)) < 0.95) return false;
            const d = new THREE.Vector3().subVectors(c.pos, p.pos);
            const proj = d.dot(p.dir);
            return d.lengthSq() - proj * proj < 1.0;
          });
        })
      : connectors;

  return { topStuds, pinBarrels, connectors: filteredConnectors };
}

function isPairCompatible(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "pin" || a.kind === "axle") {
    return (a.role === "hole" && b.role === "plug") || (a.role === "plug" && b.role === "hole");
  }
  if (a.kind === "bar") {
    return (a.role === "grip" && b.role === "plug") || (a.role === "plug" && b.role === "grip");
  }
  if (a.kind === "ball") {
    return (a.role === "socket" && b.role === "plug") || (a.role === "plug" && b.role === "socket");
  }
  if (a.kind === "hinge") {
    return (
      (a.role === "clh_single" && b.role === "clh_dual") ||
      (a.role === "clh_dual" && b.role === "clh_single") ||
      (a.role === "classic_fork" && b.role === "classic_top") ||
      (a.role === "classic_top" && b.role === "classic_fork")
    );
  }
  return false;
}

function rotateVectorTo(fromVec, toVec) {
  const from = fromVec.clone().normalize();
  const to = toVec.clone().normalize();
  const dot = from.dot(to);
  if (dot < -0.999) {
    const ortho =
      Math.abs(from.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    ortho.crossVectors(from, ortho).normalize();
    return new THREE.Quaternion().setFromAxisAngle(ortho, Math.PI);
  }
  return new THREE.Quaternion().setFromUnitVectors(from, to);
}

/**
 * Calcula el cuaternión objetivo y la posición exacta para acoplar `match`.
 */
export function computeMatchTransform(match, currentQuat, spinAngle, autoOrient, manualTiltApplied) {
  const { targetPos, targetDir, targetCrossAxis, kind, localConn } = match;
  let quat = currentQuat.clone();

  if (autoOrient && !manualTiltApplied) {
    if (kind === "hinge") {
      // Alineamos eje bisagra y normal de soporte; `spinAngle` pivota sobre el eje bisagra real
      const desiredDir = localConn.role.startsWith("clh_")
        ? targetDir.clone().negate()
        : targetDir;
      const qAxis = rotateVectorTo(localConn.crossAxis, targetCrossAxis);
      const curDir = localConn.dir.clone().applyQuaternion(qAxis).normalize();
      const qDir = rotateVectorTo(curDir, desiredDir);
      const qBase = qDir.multiply(qAxis).normalize();
      const qPivotSpin = new THREE.Quaternion().setFromAxisAngle(targetCrossAxis, spinAngle);
      quat = qPivotSpin.multiply(qBase).normalize();
    } else if (kind === "bar") {
      const qAxis = rotateVectorTo(localConn.dir, targetDir);
      const qRoll = new THREE.Quaternion().setFromAxisAngle(targetDir, spinAngle);
      quat = qRoll.multiply(qAxis).normalize();
    } else if (kind === "axle") {
      const intoDir = targetDir.clone().negate();
      const qDir = rotateVectorTo(localConn.dir, intoDir);
      let qBase = qDir;
      if (localConn.crossAxis && targetCrossAxis) {
        const curCross = localConn.crossAxis.clone().applyQuaternion(qDir).normalize();
        const projCur = curCross.addScaledVector(intoDir, -curCross.dot(intoDir));
        const projTgt = targetCrossAxis
          .clone()
          .addScaledVector(intoDir, -targetCrossAxis.dot(intoDir));
        if (projCur.lengthSq() > 0.01 && projTgt.lengthSq() > 0.01) {
          qBase = rotateVectorTo(projCur.normalize(), projTgt.normalize()).multiply(qDir);
        }
      }
      // Los ejes en cruz solo encajan cada 90° alrededor del túnel
      const snappedRoll = Math.round(spinAngle / (Math.PI / 2)) * (Math.PI / 2);
      const qRoll = new THREE.Quaternion().setFromAxisAngle(targetDir, snappedRoll);
      quat = qRoll.multiply(qBase).normalize();
    } else {
      // `pin` / `ball`: inserta `dirB` opuesto a `dirA` (`pin` sale del agujero, barra/pin entra)
      const intoDir = kind === "pin" ? targetDir.clone().negate() : targetDir.clone();
      const qBase = rotateVectorTo(localConn.dir, intoDir);
      const qSpin = new THREE.Quaternion().setFromAxisAngle(targetDir, spinAngle);
      quat = qSpin.multiply(qBase).normalize();
    }
  } else {
    // Orientación manual: solo engancha si el eje ya está alineado (evita robar piezas rotadas a otra pared)
    const worldDir = localConn.dir.clone().applyQuaternion(quat).normalize();
    if (kind === "hinge") {
      const worldAxis = localConn.crossAxis.clone().applyQuaternion(quat).normalize();
      if (Math.abs(worldAxis.dot(targetCrossAxis)) < 0.85) return null;
    } else if (kind === "bar") {
      if (Math.abs(worldDir.dot(targetDir)) < 0.85) return null;
    } else if (kind === "pin" || kind === "axle") {
      if (worldDir.dot(targetDir) > -0.85) return null;
    }
  }

  const rotatedOffset = localConn.pos.clone().applyQuaternion(quat);
  const position = targetPos.clone().sub(rotatedOffset);
  return { quaternion: quat, position };
}

/**
 * Busca el mejor encastre mecánico (`pin`, `axle`, `bar`, `hinge`, `ball`) cerca del cursor.
 */
export function findBestMechanicalMatch({
  carriedMesh,
  carriedQuat,
  autoOrient,
  manualTiltApplied,
  spinAngle,
  hit,
  cardN,
  placedPieces,
  ignoreMesh,
}) {
  const carriedConns = carriedMesh?.userData?.connectors;
  if (!carriedConns?.length || !hit?.point) return null;

  const pt = hit.point;
  const isIgnored = (m) => (ignoreMesh instanceof Set ? ignoreMesh.has(m) : m === ignoreMesh);

  let best = null;
  let bestScore = Infinity;

  const wPosA = new THREE.Vector3();
  const wDirA = new THREE.Vector3();
  const wCrossA = new THREE.Vector3();
  const toHit = new THREE.Vector3();

  const evaluatePiece = (mesh) => {
    const connsA = mesh?.userData?.connectors;
    if (!connsA?.length) return;
    mesh.updateMatrixWorld(true);

    for (const a of connsA) {
      wPosA.copy(a.pos).applyMatrix4(mesh.matrixWorld);
      wDirA.copy(a.dir).transformDirection(mesh.matrixWorld).normalize();
      if (a.crossAxis) {
        wCrossA.copy(a.crossAxis).transformDirection(mesh.matrixWorld).normalize();
      }

      toHit.subVectors(pt, wPosA);
      const distSq = toHit.lengthSq();
      const onHitObj = mesh === hit.object;

      // Rango según geometría: agujeros/clips/manos aceptan apuntar al túnel o a la cara cercana
      let inRange = false;
      if (a.kind === "pin" || a.kind === "axle") {
        const axial = toHit.dot(wDirA);
        const radialSq = Math.max(0, distSq - axial * axial);
        const sameFace = wDirA.dot(cardN) > 0.65 && Math.abs(axial) <= 4.0 && radialSq <= 12 * 12;
        const inBore = onHitObj && radialSq <= 9.5 * 9.5 && axial >= -21 && axial <= 4;
        inRange = sameFace || inBore;
      } else {
        const maxR = onHitObj ? 22 : 16;
        inRange = distSq <= maxR * maxR;
      }
      if (!inRange) continue;

      for (const b of carriedConns) {
        if (!isPairCompatible(a, b)) continue;

        const candidate = {
          kind: a.kind,
          targetPos: wPosA.clone(),
          targetDir: snapDirToClean(wDirA),
          targetCrossAxis: a.crossAxis ? snapDirToClean(wCrossA) : null,
          ownerMesh: mesh,
          localConn: b,
        };

        const resolved = computeMatchTransform(
          candidate,
          carriedQuat,
          spinAngle,
          autoOrient,
          manualTiltApplied
        );
        if (!resolved) continue;

        const bonus = (onHitObj ? 12 : 0) + (a.kind === "hinge" || a.kind === "ball" ? 4 : 0);
        const score = distSq - bonus;
        if (score < bestScore) {
          bestScore = score;
          best = {
            ...candidate,
            spinAxis:
              a.kind === "hinge"
                ? candidate.targetCrossAxis
                : candidate.targetDir,
            ...resolved,
          };
        }
      }
    }
  };

  if (hit.object && !isIgnored(hit.object)) {
    evaluatePiece(hit.object);
  }
  for (const p of placedPieces) {
    if (isIgnored(p.mesh) || p.mesh === hit.object) continue;
    const wb = p.worldBox;
    if (
      wb &&
      (pt.x < wb.min.x - 26 ||
        pt.x > wb.max.x + 26 ||
        pt.y < wb.min.y - 26 ||
        pt.y > wb.max.y + 26 ||
        pt.z < wb.min.z - 26 ||
        pt.z > wb.max.z + 26)
    ) {
      continue;
    }
    evaluatePiece(p.mesh);
  }

  return best;
}
