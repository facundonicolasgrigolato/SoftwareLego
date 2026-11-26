import * as THREE from "three";

const TOP_STUD_FILE_RE = /(?:^|[\\/])stud(?!3\b|4|16)[0-9a-z]*\.dat$/i;
const ANTI_STUD_FILE_RE = /(?:^|[\\/])(?:stud4(?:o|od|oda|s|s2|h)?|stud16od)\.dat$/i;
const TECH_PIN_HOLE_RE = /(?:^|[\\/])peghole\.dat$/i;
const TECH_PIN_BARREL_RE = /(?:^|[\\/])(connect(?!hole|collar|slit|ring)\w*|confric(?!rib)\w*)\.dat$/i;
const TECH_PIN_LIP_RE = /(?:^|[\\/])(connectcollar\w*|confricrib\w*)\.dat$/i;
const AXLE_PLUG_RE = /(?:^|[\\/])(axleend\w*|axles\w*|axle)\.dat$/i;
const AXLE_HOLE_RE = /(?:^|[\\/])(?:axle|axl[2345])hol(?:e|[4568]\d*)\.dat$/i;
const MINIFIG_HAND_RE = /(?:^|[\\/])3820\.dat$/i;
const CLIP_PRIM_RE = /(?:^|[\\/])clip\d+\.dat$/i;
const CLH_HINGE_RE = /(?:^|[\\/])clh(\d+)\.dat$/i;
const BALL_SOCKET_RE = /(?:^|[\\/])joint\d*socket\d*\.dat$/i;
const BALL_SPHERE_RE = /(?:^|[\\/])(?:8-8|4-8)sphe\.dat$/i;
const BAR_CYL_RE = /(?:^|[\\/])4-4cyl[ico]\.dat$/i;
const BAR_HOLE_CYL_RE = /(?:^|[\\/])4-4cyl[ico]\.dat$/i;
const BAR_HOLE_CLOSED_RE = /(?:^|[\\/])4-4cylc\.dat$/i;
const OPEN_STUD_FILE_RE = /(?:^|[\\/])stud2a\.dat$/i;
const INLINE_CLIP_CYL_RE = /(?:^|[\\/])(?:5-8|3-4)cyl[io]\.dat$/i;
const HINGE_FORK_PIN_RE = /(?:^|[\\/])2-4cylo\.dat$/i;
const HINGE_TOP_KNUCKLE_RE = /(?:^|[\\/])4-4cylo\.dat$/i;
const CLIP_CURVE_RE = /(?:^|[\\/])(?:\d+-\d+(?:cylo|cyli|ndis))\.dat$/i;
const MINIFIG_HIP_STUD_RE = /(?:^|[\\/])hipstud\.dat$/i;
const MINIFIG_TORSO_SUB_RE = /(?:^|[\\/])s[\\/]973s01\.dat$/i;
const MINIFIG_HIPWEAR_SUB_RE = /(?:^|[\\/])s[\\/]24779s02\.dat$/i;
const NECK_BORE_CYL_RE = /(?:^|[\\/])(?:4-4|2-4)cyl[ico]\.dat$/i;
const MINIDOLL_WAIST_CYL_RE = /(?:^|[\\/])2-4cyl[co]\.dat$/i;
const WPIN_PLUG_RE = /(?:^|[\\/])(?:wpin|wpin4|wpin5[ae])\.dat$/i;
const WPIN_HOLE_RE = /(?:^|[\\/])wpinhol[a-z0-9]*\.dat$/i;
const RIM_TYRE_CYL_RE = /(?:^|[\\/])(?:4-4|1-4|2-4|48[/\\]4-4)cyl[ico]\.dat$/i;

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
function buildMergedBarConnectors(rawBars, localBox = null) {
  if (!rawBars.length) return [];
  const boxCenter = localBox ? localBox.getCenter(new THREE.Vector3()) : null;
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
        g.hasClosed = g.hasClosed || Boolean(seg.isClosed);
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
        hasClosed: Boolean(seg.isClosed),
      });
    }
  }

  const out = [];
  const boxHalfSize = localBox ? localBox.getSize(new THREE.Vector3()).multiplyScalar(0.5) : null;
  for (const g of groups) {
    const totalLen = g.maxS - g.minS;
    if (totalLen < (g.hasClosed ? 4.8 : 6.0)) continue;
    const pMin = g.origin.clone().addScaledVector(g.axis, g.minS);
    const pMax = g.origin.clone().addScaledVector(g.axis, g.maxS);
    const freeTips = [];
    if (boxCenter && boxHalfSize) {
      const boxCenterProj = boxCenter.dot(g.axis);
      const halfSpan =
        Math.abs(g.axis.x) * boxHalfSize.x +
        Math.abs(g.axis.y) * boxHalfSize.y +
        Math.abs(g.axis.z) * boxHalfSize.z;
      const boxMinProj = boxCenterProj - halfSpan;
      const boxMaxProj = boxCenterProj + halfSpan;
      if (pMin.dot(g.axis) - boxMinProj <= 1.5) {
        freeTips.push({ endPos: pMin, tipDir: g.axis.clone().negate() });
      }
      if (boxMaxProj - pMax.dot(g.axis) <= 1.5) {
        freeTips.push({ endPos: pMax, tipDir: g.axis.clone() });
      }
    } else {
      const midPos = g.origin.clone().addScaledVector(g.axis, (g.minS + g.maxS) * 0.5);
      const centerShift = midPos.dot(g.axis);
      if (totalLen <= 28 && Math.abs(centerShift) > 1.0) {
        const sgn = Math.sign(centerShift);
        freeTips.push({
          endPos: sgn > 0 ? pMax : pMin,
          tipDir: g.axis.clone().multiplyScalar(sgn),
        });
      }
    }

    // Para barras cortas (<=28 LDU, manijas/clips) centro único; para mangos largos, 3 puntos a lo largo
    const fracs = totalLen <= 28 ? [0.5] : [0.22, 0.5, 0.78];
    const barMidPos = g.origin.clone().addScaledVector(g.axis, (g.minS + g.maxS) * 0.5);
    for (const f of fracs) {
      const s = g.minS + totalLen * f;
      const pos = g.origin.clone().addScaledVector(g.axis, s);
      const tipDir =
        totalLen <= 28 && freeTips.length === 1 ? freeTips[0].tipDir.clone() : null;
      out.push({
        kind: "bar",
        role: "plug",
        pos,
        ...(totalLen > 28 ? { barMidPos: barMidPos.clone() } : {}),
        dir: g.axis.clone(),
        ...(tipDir ? { tipDir } : {}),
        halfLength: totalLen * 0.5,
      });
    }
    if (totalLen > 28 && freeTips.length > 0) {
      const tipHalfLen = Math.min(totalLen * 0.5, 5);
      for (const ft of freeTips) {
        out.push({
          kind: "bar",
          role: "plug",
          isAxialBoreTipOnly: true,
          pos: ft.endPos.clone().addScaledVector(ft.tipDir, -tipHalfLen),
          dir: g.axis.clone(),
          tipDir: ft.tipDir.clone(),
          halfLength: tipHalfLen,
        });
      }
    }
  }
  return out;
}

/**
 * Fusiona cavidades colineales r≈4 (ej. cilindros invertidos `4-4cyl[ico]` + `stud2a.dat` en
 * plates/bricks con open stud como `35480`, `85861` o `86996`) y emite receptores `bar:grip`.
 */
function buildMergedBarBoreConnectors(rawBores, localBox = null) {
  if (!rawBores.length) return [];
  const boxCenter = localBox ? localBox.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);
  const groups = [];

  for (const seg of rawBores) {
    let matched = null;
    for (const g of groups) {
      if (Math.abs(g.axis.dot(seg.axis)) < 0.98) continue;
      const diff = new THREE.Vector3().subVectors(seg.p0, g.origin);
      const proj = diff.dot(g.axis);
      const perpSq = Math.max(0, diff.lengthSq() - proj * proj);
      if (perpSq > 0.6 * 0.6) continue;
      const s0 = proj;
      const s1 = proj + seg.axis.dot(g.axis) * seg.length;
      const segMin = Math.min(s0, s1);
      const segMax = Math.max(s0, s1);
      const gapTol = seg.isOpenStud || g.hasOpenStud ? 4.5 : 1.5;
      if (segMax >= g.minS - gapTol && segMin <= g.maxS + gapTol) {
        const sameSpan = Math.abs(segMin - g.minS) < 0.2 && Math.abs(segMax - g.maxS) < 0.2;
        g.minS = Math.min(g.minS, segMin);
        g.maxS = Math.max(g.maxS, segMax);
        if (!sameSpan) g.segCount += 1;
        if (seg.isOpenStud) g.hasOpenStud = true;
        if (seg.isClosed && !g.closedEndPos) {
          g.closedEndPos = seg.p0.clone();
        }
        matched = g;
        break;
      }
    }
    if (!matched) {
      groups.push({
        origin: seg.p0.clone(),
        axis: seg.axis.clone(),
        crossAxis: seg.crossAxis.clone(),
        minS: 0,
        maxS: seg.length,
        segCount: 1,
        hasOpenStud: Boolean(seg.isOpenStud),
        closedEndPos: seg.isClosed ? seg.p0.clone() : null,
      });
    }
  }

  const boxHalfSize = localBox ? localBox.getSize(new THREE.Vector3()).multiplyScalar(0.5) : null;
  const out = [];
  for (const g of groups) {
    const totalLen = g.maxS - g.minS;
    const isThroughOpenStud = g.hasOpenStud && g.segCount >= 2 && totalLen >= 7.0;
    if (!isThroughOpenStud && totalLen < 9.0) continue;

    let minS = g.minS;
    let maxS = g.maxS;
    if (isThroughOpenStud && boxHalfSize) {
      const boxCenterProj = boxCenter.dot(g.axis);
      const halfSpan =
        Math.abs(g.axis.x) * boxHalfSize.x +
        Math.abs(g.axis.y) * boxHalfSize.y +
        Math.abs(g.axis.z) * boxHalfSize.z;
      const originProj = g.origin.dot(g.axis);
      const boxMinProj = boxCenterProj - halfSpan - originProj;
      const boxMaxProj = boxCenterProj + halfSpan - originProj;
      if (minS - boxMinProj > 0.1 && minS - boxMinProj <= 5.5) minS = boxMinProj;
      if (boxMaxProj - maxS > 0.1 && boxMaxProj - maxS <= 5.5) maxS = boxMaxProj;
    }

    const pMin = g.origin.clone().addScaledVector(g.axis, minS);
    const pMax = g.origin.clone().addScaledVector(g.axis, maxS);
    const pos = pMin.clone().add(pMax).multiplyScalar(0.5);
    const boreHalfLen = (maxS - minS) * 0.5;
    const dir = canonicalAxis(g.axis);
    const crossAxis = canonicalAxis(g.crossAxis);

    if (isThroughOpenStud) {
      out.push({
        kind: "bar",
        role: "grip",
        isAxialBore: true,
        boreHalfLen,
        mouthPos: pMin,
        outwardDir: g.axis.clone().negate(),
        pos,
        dir,
        crossAxis,
      });
      out.push({
        kind: "bar",
        role: "grip",
        isAxialBore: true,
        boreHalfLen,
        mouthPos: pMax,
        outwardDir: g.axis.clone(),
        pos: pos.clone(),
        dir: dir.clone(),
        crossAxis: crossAxis.clone(),
      });
    } else {
      let mouthPos = pMax;
      if (g.closedEndPos) {
        mouthPos =
          pMin.distanceToSquared(g.closedEndPos) < pMax.distanceToSquared(g.closedEndPos)
            ? pMax
            : pMin;
      } else {
        const dMin = Math.abs(pMin.dot(g.axis) - boxCenter.dot(g.axis));
        const dMax = Math.abs(pMax.dot(g.axis) - boxCenter.dot(g.axis));
        mouthPos = dMax >= dMin ? pMax : pMin;
      }
      const outwardDir = mouthPos.clone().sub(pos).normalize();
      out.push({
        kind: "bar",
        role: "grip",
        isAxialBore: true,
        boreHalfLen,
        mouthPos,
        outwardDir,
        pos,
        dir,
        crossAxis,
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
export function extractPartFeatures(datFileName, parseCache, localBox = null) {
  if (!parseCache) {
    return { topStuds: [], antiStuds: [], pinBarrels: [], connectors: [] };
  }
  const boxCenter = localBox ? localBox.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);

  const topStuds = [];
  const antiStuds = [];
  const pinBarrels = [];
  const connectors = [];
  const collarRibTips = [];
  const rawBars = [];
  const rawBarBores = [];
  const hingeCyls = [];
  const hipStuds = [];
  const rimCyls = [];
  const invTyreBores = [];
  const outerTreads = [];
  const minidollNeckSockets = [];
  let minidollWaistCylCount = 0;
  const flipMat = new THREE.Matrix4().makeRotationX(Math.PI);
  const partUp = new THREE.Vector3(0, -1, 0).transformDirection(flipMat).normalize();
  const partRight = new THREE.Vector3(1, 0, 0).transformDirection(flipMat).normalize();

  const walk = (fileName, parentMatrix, depth, parentInverted = false) => {
    if (depth > 8) return;
    const info = parseCache.getData(fileName, false);
    if (!info || !Array.isArray(info.subobjects)) return;

    for (const sub of info.subobjects) {
      const nextMat = parentMatrix.clone().multiply(sub.matrix);
      const cleanName = (sub.fileName || "").toLowerCase();
      const isInverted = parentInverted !== Boolean(sub.inverted || sub.invertNext);

      if (ANTI_STUD_FILE_RE.test(cleanName)) {
        const up = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        // En LDraw, un anti-stud invertido (`up.y < -0.85`, ej. pelos/cascos `stud4o`/`stud16od`)
        // tiene su boca de encastre en local (0, -4, 0) sobre el stud receptor.
        if (up.y < -0.85) {
          const mouthPos = new THREE.Vector3(0, -4, 0).applyMatrix4(nextMat);
          antiStuds.push({ pos: mouthPos, dir: up });
        }
        continue;
      }

      if (TOP_STUD_FILE_RE.test(cleanName)) {
        const { x } = getMatrixAxes(nextMat);
        _tmpColY.set(nextMat.elements[4], nextMat.elements[5], nextMat.elements[6]);
        const studHeight = Math.min(9.5, 4 * _tmpColY.length());
        const up = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        topStuds.push({ pos, up, height: studHeight });
        if (OPEN_STUD_FILE_RE.test(cleanName) && studHeight >= 2.0) {
          rawBarBores.push({
            p0: pos.clone(),
            axis: up.clone(),
            length: studHeight,
            isClosed: false,
            isOpenStud: true,
            crossAxis: x.clone().normalize(),
          });
        }
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
          // Ampliamos ligeramente las esquinas internas (+-2,+-2, r=2.83) de los agujeros en cruz
          // hasta r=4.35 para que barras estándar de 3.18 mm (r=4.0, ej. 32828) encastren sin falso choque.
          pinBarrels.push({
            pos: origin.clone(),
            dir: axis.clone(),
            minProj: -0.25,
            maxProj: len + 0.25,
            minR: 2.0,
            maxR: 4.3,
            targetR: 4.35,
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

      if (BAR_CYL_RE.test(cleanName)) {
        const { x, y, z } = getMatrixAxes(nextMat);
        const rx = x.length();
        const rz = z.length();
        const len = y.length();
        if (rx >= 3.7 && rx <= 4.35 && rz >= 3.7 && rz <= 4.35) {
          const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
          const axis = y.clone().normalize();
          if (!isInverted && len >= 2.0) {
            rawBars.push({
              p0,
              axis,
              length: len,
              isClosed: BAR_HOLE_CLOSED_RE.test(cleanName),
            });
          } else if (isInverted && BAR_HOLE_CYL_RE.test(cleanName) && len >= 2.5) {
            rawBarBores.push({
              p0,
              axis,
              length: len,
              isClosed: BAR_HOLE_CLOSED_RE.test(cleanName),
              isOpenStud: false,
              crossAxis: x.clone().normalize(),
            });
          }
        }
      }

      if (isInverted && INLINE_CLIP_CYL_RE.test(cleanName)) {
        const { x, y, z } = getMatrixAxes(nextMat);
        const rx = x.length();
        const rz = z.length();
        const len = y.length();
        if (rx >= 3.7 && rx <= 4.35 && rz >= 3.7 && rz <= 4.35 && len >= 5.5 && len <= 10.5) {
          const axis = y.clone().normalize();
          const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat).addScaledVector(axis, len * 0.5);
          const dup = connectors.some(
            (c) => c.kind === "bar" && c.role === "grip" && c.pos.distanceToSquared(pos) < 1.0
          );
          if (!dup) {
            connectors.push({
              kind: "bar",
              role: "grip",
              pos,
              dir: canonicalAxis(axis),
              crossAxis: canonicalAxis(x),
            });
          }
        }
      }

      if (MINIFIG_HIP_STUD_RE.test(cleanName)) {
        const dir = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        const crossAxis = new THREE.Vector3(1, 0, 0).transformDirection(parentMatrix).normalize();
        hipStuds.push({ pos, dir, crossAxis });
        continue;
      }

      if (MINIFIG_TORSO_SUB_RE.test(cleanName)) {
        const rightAxis = new THREE.Vector3(1, 0, 0).transformDirection(nextMat).normalize();
        const neckPos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        const neckDir = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        connectors.push({
          kind: "minifig_neck",
          role: "plug",
          variant: "classic",
          pos: neckPos,
          dir: neckDir,
          crossAxis: rightAxis.clone(),
        });
        const hipPos = new THREE.Vector3(0, 32, 0).applyMatrix4(nextMat);
        const hipDir = new THREE.Vector3(0, 1, 0).transformDirection(nextMat).normalize();
        connectors.push({
          kind: "minifig_hip",
          role: "socket",
          pos: hipPos,
          dir: hipDir,
          crossAxis: rightAxis.clone(),
        });
      }

      if (MINIFIG_HIPWEAR_SUB_RE.test(cleanName)) {
        const rightAxis = new THREE.Vector3(1, 0, 0).transformDirection(nextMat).normalize();
        const socketPos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        const socketDir = new THREE.Vector3(0, 1, 0).transformDirection(nextMat).normalize();
        connectors.push({
          kind: "minifig_hip",
          role: "socket",
          pos: socketPos,
          dir: socketDir,
          crossAxis: rightAxis.clone(),
        });
        const plugPos = new THREE.Vector3(0, -3, 0).applyMatrix4(nextMat);
        const plugDir = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        connectors.push({
          kind: "minifig_hip",
          role: "plug",
          pos: plugPos,
          dir: plugDir,
          crossAxis: rightAxis.clone(),
        });
      }

      if (isInverted && MINIDOLL_WAIST_CYL_RE.test(cleanName)) {
        const { x, y } = getMatrixAxes(nextMat);
        const rx = x.length();
        const len = y.length();
        const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        if (rx >= 3.5 && rx <= 4.5 && len >= 7.5 && Math.abs(Math.abs(p0.x) - 4.0) <= 0.7) {
          minidollWaistCylCount += 1;
        }
      }

      if (isInverted && NECK_BORE_CYL_RE.test(cleanName)) {
        const { x, y, z } = getMatrixAxes(nextMat);
        const rx = x.length();
        const rz = z.length();
        const len = y.length();
        if (rx >= 5.5 && rx <= 8.0 && rz >= 5.5 && rz <= 8.0 && len >= 15.0) {
          const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
          const p1 = new THREE.Vector3(0, 1, 0).applyMatrix4(nextMat);
          const p0Lower = p0.dot(partUp) <= p1.dot(partUp);
          const mouthPos = p0Lower ? p0 : p1;
          const otherPos = p0Lower ? p1 : p0;
          const dir = mouthPos.clone().sub(otherPos).normalize();
          const dup = connectors.some(
            (c) =>
              c.kind === "minifig_neck" &&
              c.role === "socket" &&
              c.pos.distanceToSquared(mouthPos) < 1.0 &&
              c.dir.dot(dir) > 0.95
          );
          if (!dup) {
            connectors.push({
              kind: "minifig_neck",
              role: "socket",
              variant: "classic",
              pos: mouthPos,
              dir,
              crossAxis: partRight.clone(),
            });
          }
        } else if (
          rx >= 3.7 &&
          rx <= 4.35 &&
          rz >= 3.7 &&
          rz <= 4.35 &&
          len >= 7.0 &&
          len <= 12.5 &&
          Math.abs(y.clone().normalize().dot(partUp)) > 0.95
        ) {
          const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
          const p1 = new THREE.Vector3(0, 1, 0).applyMatrix4(nextMat);
          const p0Lower = p0.dot(partUp) <= p1.dot(partUp);
          const mouthPos = p0Lower ? p0 : p1;
          const otherPos = p0Lower ? p1 : p0;
          if (Math.abs(mouthPos.x) <= 1.0) {
            minidollNeckSockets.push({
              pos: mouthPos,
              dir: mouthPos.clone().sub(otherPos).normalize(),
            });
          }
        }
      }

      if (WPIN_PLUG_RE.test(cleanName)) {
        const dir = new THREE.Vector3(0, -1, 0).transformDirection(nextMat).normalize();
        const pos = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        connectors.push({ kind: "wheel_pin", role: "plug", pos, dir });
        pinBarrels.push({
          pos: pos.clone(),
          dir: dir.clone(),
          minProj: 0,
          maxProj: 12.2,
          minR: 3.8,
          maxR: 4.85,
          targetR: 3.8,
          capProj: 11.75,
        });
        continue;
      }

      if (WPIN_HOLE_RE.test(cleanName)) {
        const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
        const p1 = new THREE.Vector3(0, -1, 0).applyMatrix4(nextMat);
        const dir = p1.clone().sub(p0).normalize();
        connectors.push({ kind: "wheel_pin", role: "hole", pos: p1, dir });
        continue;
      }

      if (RIM_TYRE_CYL_RE.test(cleanName)) {
        const { x, y, z } = getMatrixAxes(nextMat);
        const rx = x.length();
        const rz = z.length();
        const len = y.length();
        if (rx >= 6.8 && rx <= 26.0 && rz >= 6.8 && rz <= 26.0 && len >= 1.5) {
          const axis = y.clone().normalize();
          const p0 = new THREE.Vector3(0, 0, 0).applyMatrix4(nextMat);
          const mid = p0.clone().addScaledVector(axis, len * 0.5);
          if (isInverted) {
            invTyreBores.push({ mid, axis: canonicalAxis(axis), r: (rx + rz) * 0.5, len });
          } else {
            rimCyls.push({ mid, axis: canonicalAxis(axis), r: (rx + rz) * 0.5, len });
            if (rx >= 12.0) outerTreads.push({ mid, axis: canonicalAxis(axis), r: rx });
          }
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

      walk(sub.fileName, nextMat, depth + 1, isInverted);
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

  for (const bar of buildMergedBarConnectors(rawBars, localBox)) {
    connectors.push(bar);
  }
  for (const bore of buildMergedBarBoreConnectors(rawBarBores, localBox)) {
    const dup = connectors.some(
      (c) =>
        c.kind === "bar" &&
        c.role === "grip" &&
        c.pos.distanceToSquared(bore.pos) < 1.0 &&
        Math.abs(c.dir.dot(bore.dir)) > 0.95 &&
        (!c.outwardDir || c.outwardDir.dot(bore.outwardDir) > 0.95)
    );
    if (!dup) connectors.push(bore);
  }
  for (const hc of buildClassicHingeConnectors(hingeCyls)) {
    connectors.push(hc);
  }
  const usedHip = new Set();
  for (let i = 0; i < hipStuds.length; i += 1) {
    if (usedHip.has(i)) continue;
    const a = hipStuds[i];
    for (let j = i + 1; j < hipStuds.length; j += 1) {
      if (usedHip.has(j)) continue;
      const b = hipStuds[j];
      const dist = a.pos.distanceTo(b.pos);
      if (dist >= 18 && dist <= 22 && a.dir.dot(b.dir) > 0.95) {
        usedHip.add(i);
        usedHip.add(j);
        connectors.push({
          kind: "minifig_hip",
          role: "plug",
          pos: a.pos.clone().add(b.pos).multiplyScalar(0.5),
          dir: a.dir.clone(),
          crossAxis: a.crossAxis.clone(),
        });
        break;
      }
    }
  }

  // Ruedas (`wheel_pin` hole o `axle` hole con aro cilíndrico exterior r>=7) -> `wheel_tyre:plug`
  const wheelHoles = connectors.filter(
    (c) => c.kind === "wheel_pin" || (c.kind === "axle" && c.role === "hole")
  );
  if (wheelHoles.length && rimCyls.length) {
    for (const wh of wheelHoles) {
      const aligned = rimCyls.filter((rc) => Math.abs(rc.axis.dot(wh.dir)) > 0.92);
      if (!aligned.length) continue;
      // Centro a lo largo del eje del rin (entre borde trasero y frente, o promedio)
      const projVals = aligned.map((rc) => rc.mid.dot(wh.dir));
      const minP = Math.min(...projVals);
      const maxP = Math.max(...projVals);
      const center = wh.pos
        .clone()
        .addScaledVector(wh.dir, ((minP + maxP) * 0.5) - wh.pos.dot(wh.dir));
      // En rines con frente cerrado (`74967`), el centro real del aro está centrado en `(0,0,0)` si los cilindros cubren [-10..+2] -> desplazamos al centro simétrico cuando el eje cruza origen
      const originProj = new THREE.Vector3(0, 0, 0).dot(wh.dir);
      const wheelCenter =
        Math.abs(originProj - (minP + maxP) * 0.5) <= 6
          ? wh.pos.clone().addScaledVector(wh.dir, originProj - wh.pos.dot(wh.dir))
          : center;
      const dup = connectors.some(
        (c) =>
          c.kind === "wheel_tyre" &&
          c.role === "plug" &&
          c.pos.distanceToSquared(wheelCenter) < 4
      );
      if (!dup) {
        connectors.push({
          kind: "wheel_tyre",
          role: "plug",
          pos: wheelCenter,
          dir: canonicalAxis(wh.dir),
        });
      }
    }
  } else if (!topStuds.length && !connectors.length && invTyreBores.length) {
    const axis = invTyreBores[0].axis;
    let hasTyreOuterBody = outerTreads.length > 0;
    if (!hasTyreOuterBody && localBox && invTyreBores.length >= 2) {
      const sz = localBox.getSize(new THREE.Vector3());
      const radialHalf = Math.max(
        Math.abs(axis.x) < 0.5 ? sz.x * 0.5 : 0,
        Math.abs(axis.y) < 0.5 ? sz.y * 0.5 : 0,
        Math.abs(axis.z) < 0.5 ? sz.z * 0.5 : 0
      );
      const maxBoreR = Math.max(...invTyreBores.map((b) => b.r));
      hasTyreOuterBody = radialHalf - maxBoreR >= 5.0;
    }
    if (hasTyreOuterBody) {
      // Neumáticos (`30028`, `58090`, `61481`, `11209`, `92402`, etc.): cilindro hueco interno + banda exterior
      const sum = new THREE.Vector3();
      let count = 0;
      for (const b of invTyreBores) {
        if (Math.abs(b.axis.dot(axis)) > 0.92) {
          sum.add(b.mid);
          count += 1;
        }
      }
      if (count > 0) {
        connectors.push({
          kind: "wheel_tyre",
          role: "socket",
          pos: sum.divideScalar(count),
          dir: axis.clone(),
        });
      }
    }
  }

  if (minidollNeckSockets.length > 0 && topStuds.length === 1 && !antiStuds.length) {
    for (const sock of minidollNeckSockets) {
      connectors.push({
        kind: "minifig_neck",
        role: "socket",
        variant: "minidoll",
        pos: sock.pos,
        dir: sock.dir,
        crossAxis: partRight.clone(),
      });
    }
  }

  if (minidollWaistCylCount >= 2 && !topStuds.length && !antiStuds.length) {
    let bestNeckTip = null;
    for (const seg of rawBars) {
      if (seg.length < 12.0 || seg.length > 17.5) continue;
      if (Math.abs(seg.axis.dot(partUp)) < 0.95) continue;
      if (Math.abs(seg.p0.x) > 1.0) continue;
      const tip =
        seg.axis.dot(partUp) >= 0
          ? seg.p0.clone().addScaledVector(seg.axis, seg.length)
          : seg.p0.clone();
      if (tip.dot(partUp) >= 24.0 && (!bestNeckTip || tip.dot(partUp) > bestNeckTip.dot(partUp))) {
        bestNeckTip = tip;
      }
    }
    if (bestNeckTip) {
      connectors.push({
        kind: "minifig_neck",
        role: "plug",
        variant: "minidoll",
        pos: bestNeckTip.clone().addScaledVector(partUp, -8.0),
        dir: partUp.clone(),
        crossAxis: partRight.clone(),
      });
    }
  }

  const axlePlugs = connectors.filter((c) => c.kind === "axle" && c.role === "plug");
  const minidollNeckSocketList = !rawBars.length
    ? connectors.filter(
        (c) => c.kind === "minifig_neck" && c.role === "socket" && c.variant === "minidoll"
      )
    : [];
  const filteredConnectors = connectors.filter((c) => {
    if (axlePlugs.length > 0 && c.kind === "axle" && c.role === "hole") {
      const blockedByPlug = axlePlugs.some((p) => {
        if (Math.abs(p.dir.dot(c.dir)) < 0.95) return false;
        const d = new THREE.Vector3().subVectors(c.pos, p.pos);
        const proj = d.dot(p.dir);
        return d.lengthSq() - proj * proj < 1.0;
      });
      if (blockedByPlug) return false;
    }
    if (minidollNeckSocketList.length > 0 && c.kind === "bar" && c.role === "grip" && c.isAxialBore) {
      const blockedByNeck = minidollNeckSocketList.some(
        (n) => Math.abs(n.dir.dot(c.dir)) > 0.95 && n.pos.distanceToSquared(c.mouthPos || c.pos) < 16
      );
      if (blockedByNeck) return false;
    }
    return true;
  });

  return { topStuds, antiStuds, pinBarrels, connectors: filteredConnectors };
}

function isPairCompatible(a, b) {
  if (
    (a.kind === "bar" &&
      a.role === "plug" &&
      b.kind === "axle" &&
      b.role === "hole" &&
      (Boolean(a.tipDir) || (a.halfLength || 6) <= 14)) ||
    (a.kind === "axle" &&
      a.role === "hole" &&
      b.kind === "bar" &&
      b.role === "plug" &&
      (Boolean(b.tipDir) || (b.halfLength || 6) <= 14))
  ) {
    return true;
  }
  if (a.kind !== b.kind) return false;
  if (a.kind === "pin" || a.kind === "axle") {
    return (a.role === "hole" && b.role === "plug") || (a.role === "plug" && b.role === "hole");
  }
  if (a.kind === "bar") {
    const grip = a.role === "grip" ? a : b.role === "grip" ? b : null;
    const plug = a.role === "plug" ? a : b.role === "plug" ? b : null;
    if (!grip || !plug) return false;
    if (grip.isAxialBore) {
      return Boolean(plug.tipDir) || (plug.halfLength || 6) <= 14;
    }
    return !plug.isAxialBoreTipOnly;
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
  if (a.kind === "minifig_hip" || a.kind === "minifig_neck" || a.kind === "wheel_pin") {
    if (a.kind === "minifig_neck" && (a.variant || "classic") !== (b.variant || "classic")) {
      return false;
    }
    return (
      (a.role === "socket" && b.role === "plug") ||
      (a.role === "plug" && b.role === "socket") ||
      (a.role === "hole" && b.role === "plug") ||
      (a.role === "plug" && b.role === "hole")
    );
  }
  if (a.kind === "wheel_tyre") {
    return (a.role === "socket" && b.role === "plug") || (a.role === "plug" && b.role === "socket");
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
  const { targetPos, targetDir, targetCrossAxis, kind, localConn, axialAlign } = match;
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
    } else if (kind === "bar" || kind === "wheel_tyre") {
      if (axialAlign) {
        const desired =
          axialAlign.bidirectional && axialAlign.localVec.dot(axialAlign.targetVec) < 0
            ? axialAlign.targetVec.clone().negate()
            : axialAlign.targetVec;
        const qAxis = rotateVectorTo(axialAlign.localVec, desired);
        const qRoll = new THREE.Quaternion().setFromAxisAngle(targetDir, spinAngle);
        quat = qRoll.multiply(qAxis).normalize();
      } else {
        const barDir = localConn.dir.dot(targetDir) < 0 ? targetDir.clone().negate() : targetDir;
        const qAxis = rotateVectorTo(localConn.dir, barDir);
        const qRoll = new THREE.Quaternion().setFromAxisAngle(targetDir, spinAngle);
        quat = qRoll.multiply(qAxis).normalize();
      }
    } else if (kind === "bar_axle") {
      if (axialAlign) {
        const desired =
          axialAlign.bidirectional && axialAlign.localVec.dot(axialAlign.targetVec) < 0
            ? axialAlign.targetVec.clone().negate()
            : axialAlign.targetVec;
        const qAxis = rotateVectorTo(axialAlign.localVec, desired);
        const qRoll = new THREE.Quaternion().setFromAxisAngle(targetDir, spinAngle);
        quat = qRoll.multiply(qAxis).normalize();
      } else {
        let desiredDir = targetDir;
        if (localConn.kind === "bar") {
          // Orientamos la punta libre de la barra hacia el interior del agujero (-targetDir)
          const baseDot = localConn.pos.dot(localConn.dir);
          desiredDir = baseDot > 1 ? targetDir.clone().negate() : targetDir;
        }
        const qAxis = rotateVectorTo(localConn.dir, desiredDir);
        const qRoll = new THREE.Quaternion().setFromAxisAngle(targetDir, spinAngle);
        quat = qRoll.multiply(qAxis).normalize();
      }
    } else if (kind === "axle" || kind === "minifig_hip" || kind === "minifig_neck") {
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
      // Ejes en cruz encajan cada 90°; articulaciones minifig giran libremente con spinAngle
      const roll =
        kind === "axle"
          ? Math.round(spinAngle / (Math.PI / 2)) * (Math.PI / 2)
          : spinAngle;
      const qRoll = new THREE.Quaternion().setFromAxisAngle(targetDir, roll);
      quat = qRoll.multiply(qBase).normalize();
    } else {
      // `pin` / `ball` / `wheel_pin`: inserta `dirB` opuesto a `dirA` (`pin` sale del agujero, barra/pin entra)
      const intoDir = kind === "pin" || kind === "wheel_pin" ? targetDir.clone().negate() : targetDir.clone();
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
    } else if (kind === "bar" || kind === "wheel_tyre" || kind === "bar_axle") {
      if (axialAlign) {
        const worldVec = axialAlign.localVec.clone().applyQuaternion(quat).normalize();
        const dot = worldVec.dot(axialAlign.targetVec);
        if ((axialAlign.bidirectional ? Math.abs(dot) : dot) < 0.85) return null;
      } else if (Math.abs(worldDir.dot(targetDir)) < 0.85) {
        return null;
      }
    } else if (
      kind === "pin" ||
      kind === "axle" ||
      kind === "wheel_pin" ||
      kind === "minifig_hip" ||
      kind === "minifig_neck"
    ) {
      if (worldDir.dot(targetDir) > -0.85) return null;
    }
  }

  const rotatedOffset = localConn.pos.clone().applyQuaternion(quat);
  const position = targetPos.clone().sub(rotatedOffset);
  return { quaternion: quat, position };
}

function resolveCoaxialMultiClipTarget(wPosA, matchDir, meshA, barHalfLen, pt, placedPieces, ignoreMesh) {
  const maxSpan = Math.max(12, barHalfLen * 2);
  const coaxial = [{ pos: wPosA.clone(), axial: 0 }];
  const tmpPos = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  const diff = new THREE.Vector3();
  const isIgnored = (m) => (ignoreMesh instanceof Set ? ignoreMesh.has(m) : m === ignoreMesh);

  for (const p of placedPieces) {
    const m = p?.mesh;
    if (!m || isIgnored(m)) continue;
    const conns = m.userData?.connectors;
    if (!conns?.length) continue;
    m.updateMatrixWorld(true);
    for (const c of conns) {
      if (c.kind !== "bar" || c.role !== "grip") continue;
      tmpPos.copy(c.pos).applyMatrix4(m.matrixWorld);
      if (m === meshA && tmpPos.distanceToSquared(wPosA) < 0.01) continue;
      tmpDir.copy(c.dir).transformDirection(m.matrixWorld).normalize();
      if (Math.abs(tmpDir.dot(matchDir)) < 0.98) continue;
      diff.subVectors(tmpPos, wPosA);
      const axial = diff.dot(matchDir);
      if (Math.abs(axial) < 4 || Math.abs(axial) > maxSpan) continue;
      const perpSq = Math.max(0, diff.lengthSq() - axial * axial);
      if (perpSq > 2.25) continue;
      coaxial.push({ pos: tmpPos.clone(), axial });
    }
  }

  if (coaxial.length < 2) return null;

  coaxial.sort((u, v) => u.axial - v.axial);
  let bestMid = null;
  let bestSpan = Infinity;
  let bestPtDistSq = Infinity;
  const candidateMid = new THREE.Vector3();
  for (let i = 0; i < coaxial.length; i += 1) {
    for (let j = i + 1; j < coaxial.length; j += 1) {
      if (coaxial[i].axial > 0.01 || coaxial[j].axial < -0.01) continue;
      const span = coaxial[j].axial - coaxial[i].axial;
      if (span < 6 || span > maxSpan) continue;
      candidateMid.copy(coaxial[i].pos).add(coaxial[j].pos).multiplyScalar(0.5);
      const ptDistSq = candidateMid.distanceToSquared(pt);
      if (span < bestSpan - 0.1 || (Math.abs(span - bestSpan) <= 0.1 && ptDistSq < bestPtDistSq)) {
        bestSpan = span;
        bestPtDistSq = ptDistSq;
        bestMid = candidateMid.clone();
      }
    }
  }
  return bestMid;
}

/**
 * Busca los mejores encastres mecánicos (`pin`, `axle`, `bar`, `hinge`, `ball`, `minifig`)
 * ordenados por proximidad/ajuste para que el motor pueda validar colisión sobre alternativas.
 */
export function findMechanicalMatches(
  {
    carriedMesh,
    carriedQuat,
    autoOrient,
    manualTiltApplied,
    spinAngle,
    hit,
    cardN,
    placedPieces,
    ignoreMesh,
  },
  maxResults = 8
) {
  const carriedConns = carriedMesh?.userData?.connectors;
  if (!carriedConns?.length || !hit?.point) return [];

  const pt = hit.point;
  const isIgnored = (m) => (ignoreMesh instanceof Set ? ignoreMesh.has(m) : m === ignoreMesh);

  const rawScored = [];

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
      let effectiveDistSq = distSq;
      if (a.kind === "pin" || a.kind === "axle") {
        const axial = toHit.dot(wDirA);
        const radialSq = Math.max(0, distSq - axial * axial);
        const sameFace = wDirA.dot(cardN) > 0.65 && Math.abs(axial) <= 4.0 && radialSq <= 12 * 12;
        const inBore = onHitObj && radialSq <= 9.5 * 9.5 && axial >= -21 && axial <= 4;
        inRange = sameFace || inBore;
      } else if (a.kind === "bar" && a.role === "plug" && (a.halfLength || 6) >= 10) {
        const axial = toHit.dot(wDirA);
        const radialSq = Math.max(0, distSq - axial * axial);
        const maxR = onHitObj ? 22 : 16;
        inRange = Math.abs(axial) <= a.halfLength + 8 && radialSq <= maxR * maxR;
        const clampedAxial = Math.max(-a.halfLength, Math.min(a.halfLength, axial));
        effectiveDistSq = radialSq + (axial - clampedAxial) * (axial - clampedAxial);
      } else {
        const maxR =
          a.kind === "minifig_hip" || a.kind === "minifig_neck"
            ? onHitObj
              ? 36
              : 22
            : onHitObj
              ? 22
              : 16;
        inRange = distSq <= maxR * maxR;
      }
      if (!inRange) continue;

      for (const b of carriedConns) {
        if (!isPairCompatible(a, b)) continue;

        const isBarAxle = a.kind !== b.kind;
        const barConn = a.kind === "bar" ? a : b.kind === "bar" ? b : null;
        let matchKind = isBarAxle ? "bar_axle" : a.kind;
        let matchPos = wPosA.clone();
        let matchDir = snapDirToClean(wDirA);
        let altTargetPositions = null;
        let altBarSlideOffsets = null;
        let axialAlign = null;

        if (isBarAxle && barConn) {
          const insertDepth = Math.min(Math.max(0, (barConn.halfLength || 6) - 0.15), 9.8);
          if (a.kind === "axle") {
            matchPos.addScaledVector(matchDir, -insertDepth);
            if (b.tipDir) {
              axialAlign = {
                localVec: b.tipDir,
                targetVec: matchDir.clone().negate(),
                bidirectional: false,
              };
            }
          } else {
            // `a` es la barra colocada: orientamos el eje de inserción hacia su punta libre
            if (a.isAxialBoreTipOnly && a.tipDir) {
              const worldTipDir = snapDirToClean(
                a.tipDir.clone().transformDirection(mesh.matrixWorld).normalize()
              );
              matchDir = worldTipDir.clone().negate();
              matchPos.addScaledVector(worldTipDir, -insertDepth);
            } else {
              const baseDot = a.pos.dot(a.dir);
              const tipSign = baseDot > 1 ? 1 : baseDot < -1 ? -1 : 1;
              const worldTipDir = snapDirToClean(wDirA.clone().multiplyScalar(tipSign));
              matchDir = worldTipDir.clone().negate();
              matchPos.addScaledVector(worldTipDir, -insertDepth);
            }
          }
        } else if (a.kind === "bar" && b.kind === "bar") {
          if (a.role === "grip" && b.role === "plug") {
            const barHalfLen = b.halfLength || 6;
            if (a.isAxialBore && a.outwardDir && a.mouthPos) {
              const wOutwardA = snapDirToClean(
                a.outwardDir.clone().transformDirection(mesh.matrixWorld).normalize()
              );
              const wMouthA = a.mouthPos.clone().applyMatrix4(mesh.matrixWorld);
              const targetIntoDir = wOutwardA.clone().negate();
              matchDir = wOutwardA;
              if (b.tipDir || barHalfLen <= 14) {
                const insertLen = Math.min(2 * barHalfLen, 2 * a.boreHalfLen);
                matchPos = wMouthA.clone().addScaledVector(targetIntoDir, insertLen - barHalfLen);
              }
              axialAlign = {
                localVec: b.tipDir || b.dir,
                targetVec: b.tipDir ? targetIntoDir : matchDir,
                bidirectional: !b.tipDir,
              };
            } else {
              const coaxialMid =
                barHalfLen >= 10
                  ? resolveCoaxialMultiClipTarget(
                      wPosA,
                      matchDir,
                      mesh,
                      barHalfLen,
                      pt,
                      placedPieces,
                      ignoreMesh
                    )
                  : null;
              if (coaxialMid) {
                altTargetPositions = [matchPos.clone()];
                matchPos = coaxialMid;
              } else if (barHalfLen >= 10) {
                const maxSlide = Math.max(0, barHalfLen - 4);
                if (maxSlide >= 8) {
                  const offs = [0];
                  for (let stepOff = 8; stepOff <= maxSlide - 0.5; stepOff += 8) {
                    offs.push(-stepOff, stepOff);
                  }
                  if (maxSlide >= 8) {
                    offs.push(-maxSlide, maxSlide);
                  }
                  altBarSlideOffsets = offs;
                }
              }
            }
          } else if (a.role === "plug" && b.role === "grip") {
            if (b.isAxialBore && b.outwardDir) {
              const wTipDirA = a.tipDir
                ? snapDirToClean(a.tipDir.clone().transformDirection(mesh.matrixWorld).normalize())
                : null;
              if (wTipDirA) {
                const barHalfLen = a.halfLength || 6;
                const insertLen = Math.min(2 * barHalfLen, 2 * b.boreHalfLen);
                const wTipPosA = wPosA.clone().addScaledVector(wTipDirA, barHalfLen);
                matchPos = wTipPosA.clone().addScaledVector(wTipDirA, b.boreHalfLen - insertLen);
                matchDir = wTipDirA.clone().negate();
                axialAlign = {
                  localVec: b.outwardDir,
                  targetVec: matchDir,
                  bidirectional: false,
                };
              } else {
                axialAlign = {
                  localVec: b.outwardDir,
                  targetVec: matchDir,
                  bidirectional: true,
                };
              }
            } else if ((a.halfLength || 6) >= 10) {
              const maxSlide = Math.max(0, a.halfLength - 4);
              const stepMax = Math.floor(maxSlide / 10) * 10;
              if (stepMax >= 10) {
                const rawProj = toHit.dot(matchDir);
                const stops = [];
                for (let off = -stepMax; off <= stepMax; off += 10) {
                  stops.push(off);
                }
                stops.sort((o1, o2) => Math.abs(o1 - rawProj) - Math.abs(o2 - rawProj));
                const orderedTargets = stops.map((off) =>
                  wPosA.clone().addScaledVector(matchDir, off)
                );
                matchPos = orderedTargets[0];
                altTargetPositions = orderedTargets.slice(1);
              }
            }
          }
        }

        const candidate = {
          kind: matchKind,
          targetPos: matchPos,
          targetDir: matchDir,
          targetCrossAxis: a.crossAxis ? snapDirToClean(wCrossA) : null,
          ownerMesh: mesh,
          localConn: b,
          ...(axialAlign ? { axialAlign } : {}),
        };

        const resolved = computeMatchTransform(
          candidate,
          carriedQuat,
          spinAngle,
          autoOrient,
          manualTiltApplied
        );
        if (!resolved) continue;

        let altPositions = null;
        if (altTargetPositions?.length) {
          const rotatedOffset = b.pos.clone().applyQuaternion(resolved.quaternion);
          altPositions = altTargetPositions.map((tp) => tp.clone().sub(rotatedOffset));
        } else if (altBarSlideOffsets?.length) {
          const baseAnchor = b.barMidPos || b.pos;
          altPositions = altBarSlideOffsets.map((off) =>
            wPosA
              .clone()
              .sub(baseAnchor.clone().addScaledVector(b.dir, off).applyQuaternion(resolved.quaternion))
          );
        }

        let orientBonus = 0;
        if (axialAlign && !axialAlign.bidirectional) {
          const curDot = axialAlign.localVec
            .clone()
            .applyQuaternion(carriedQuat)
            .dot(axialAlign.targetVec);
          orientBonus = (curDot + 1) * 1.5;
        }
        let multiFitBonus = 0;
        if (a.kind === "bar" && b.kind === "bar" && b.isAxialBore && carriedConns.length >= 2) {
          const otherBPos = new THREE.Vector3();
          const otherAPos = new THREE.Vector3();
          for (const b2 of carriedConns) {
            if (b2 === b || b2.kind !== "bar" || !b2.isAxialBore) continue;
            if (b2.outwardDir && b.outwardDir && b2.outwardDir.dot(b.outwardDir) < 0.95) continue;
            otherBPos.copy(b2.pos).applyQuaternion(resolved.quaternion).add(resolved.position);
            for (const p of placedPieces) {
              if (!p?.mesh || isIgnored(p.mesh) || p.mesh === mesh) continue;
              const connsP = p.mesh.userData?.connectors;
              if (!connsP?.length) continue;
              for (const a2 of connsP) {
                if (a2.kind !== "bar" || a2.role !== "plug") continue;
                otherAPos.copy(a2.pos).applyMatrix4(p.mesh.matrixWorld);
                const d2 = otherBPos.distanceToSquared(otherAPos);
                if (d2 <= (b2.boreHalfLen + (a2.halfLength || 6) + 2) ** 2) {
                  const rad = otherBPos.clone().sub(otherAPos);
                  const wB = b2.dir.clone().applyQuaternion(resolved.quaternion).normalize();
                  const ax = rad.dot(wB);
                  if (rad.lengthSq() - ax * ax <= 2.25) {
                    multiFitBonus += 10;
                    break;
                  }
                }
              }
            }
          }
        }
        const bonus =
          (onHitObj ? 12 : 0) +
          (a.kind === "hinge" || a.kind === "ball" || a.kind === "minifig_neck" ? 4 : 0) +
          orientBonus +
          multiFitBonus;
        const score = effectiveDistSq - bonus;
        rawScored.push({
          score,
          match: {
            ...candidate,
            spinAxis:
              a.kind === "hinge"
                ? candidate.targetCrossAxis
                : candidate.targetDir,
            ...resolved,
            ...(altPositions ? { altPositions } : {}),
          },
        });
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
      (pt.x < wb.min.x - 34 ||
        pt.x > wb.max.x + 34 ||
        pt.y < wb.min.y - 34 ||
        pt.y > wb.max.y + 34 ||
        pt.z < wb.min.z - 34 ||
        pt.z > wb.max.z + 34)
    ) {
      continue;
    }
    evaluatePiece(p.mesh);
  }

  rawScored.sort((u, v) => u.score - v.score);
  const deduped = [];
  for (const entry of rawScored) {
    const m = entry.match;
    const seen = deduped.some(
      (prev) =>
        prev.kind === m.kind &&
        prev.position.distanceToSquared(m.position) < 0.04 &&
        prev.quaternion.angleTo(m.quaternion) < 0.02
    );
    if (!seen) {
      deduped.push(m);
      if (deduped.length >= maxResults) break;
    }
  }
  return deduped;
}

/**
 * Busca el mejor encastre mecánico (`pin`, `axle`, `bar`, `hinge`, `ball`) cerca del cursor,
 * adjuntando hasta `7` alternativas ordenadas (`altMatchTransforms`) por si la primera colisiona.
 */
export function findBestMechanicalMatch(opts) {
  const matches = findMechanicalMatches(opts, 8);
  if (!matches.length) return null;
  const best = matches[0];
  if (matches.length > 1) {
    best.altMatchTransforms = matches.slice(1);
  }
  return best;
}

const CONNECTOR_POINT_FIELDS = ["pos", "mouthPos", "barMidPos"];
const CONNECTOR_DIR_FIELDS = ["dir", "crossAxis", "outwardDir", "tipDir"];

/**
 * Clona un conector y transforma todas sus coordenadas y direcciones locales al espacio de un grupo.
 */
export function transformConnector(conn, relQuat, relPos) {
  const out = { ...conn };
  for (const field of CONNECTOR_POINT_FIELDS) {
    if (conn[field]) {
      out[field] = conn[field].clone().applyQuaternion(relQuat).add(relPos);
    }
  }
  for (const field of CONNECTOR_DIR_FIELDS) {
    if (conn[field]) {
      out[field] = conn[field].clone().applyQuaternion(relQuat).normalize();
    }
  }
  return out;
}
