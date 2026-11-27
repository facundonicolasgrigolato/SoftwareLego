import * as THREE from "three";
import { isIgnoredObject } from "../core/threeHelpers.js";
import { extractPartFeatures, snapDirToClean } from "./connectorExtractor.js";

export { extractPartFeatures };
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
  const isIgnored = (m) => isIgnoredObject(ignoreMesh, m);

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
  const isIgnored = (m) => isIgnoredObject(ignoreMesh, m);

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
