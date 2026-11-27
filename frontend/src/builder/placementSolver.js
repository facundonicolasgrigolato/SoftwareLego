import * as THREE from "three";
import {
  LDU_HALF_PLATE,
  LDU_HALF_STUD,
  LDU_PLATE,
  LDU_STUD,
} from "../core/constants.js";
import { isIgnoredObject } from "../core/threeHelpers.js";
import {
  checkPieceCollision,
  computeTransformedWorldBox,
  findCollidingPieces,
} from "./collision.js";
import { findBestMechanicalMatch } from "./connectors.js";
import {
  computeSnappedPlacementY,
  computeStudCoordParityOffset,
  computeSupportDistanceAlongDir,
  computeSupportedSurfaceY,
  computeSurfaceY,
  computeWallParityOffset,
  snapNormalToCardinal,
  snapToReferenceCoord,
  snapValue,
  snapXZ,
} from "./gridSnap.js";

const WORLD_Y = new THREE.Vector3(0, 1, 0);

/**
 * Busca el stud ("circulito") destino más coherente cercano al punto de impacto,
 * explorando tanto la pieza impactada como piezas vecinas dentro de 22 LDU.
 * Filtra por cara visible para no enganchar el stud del lado opuesto en anillos
 * finos (ej. 4081b) o faldones de brackets (44728).
 */
export function findBestConnectionStud(bc, hit, cardN, ignoreMesh = null) {
  if (!hit || hit.kind !== "placed") return null;
  const pt = hit.point;
  const rawN = (hit.normal || cardN).clone().normalize();
  const camPos = bc.sceneManager.camera.position;

  let best = null;
  let bestScore = Infinity;

  const worldPos = new THREE.Vector3();
  const worldUp = new THREE.Vector3();
  const toHit = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const rayVec = new THREE.Vector3().subVectors(pt, camPos);
  const studFront = new THREE.Vector3();
  const enterPt = new THREE.Vector3();

  const considerPiece = (mesh) => {
    const studs = mesh?.userData?.topStuds;
    if (!studs || !studs.length) return;
    mesh.updateMatrixWorld(true);
    const onHitObj = mesh === hit.object;
    const isMinifigHead =
      onHitObj &&
      Boolean(mesh.userData?.connectors?.some((c) => c.kind === "minifig_neck" && c.role === "socket"));
    const carryingHeadgear = Boolean(bc.carry?.mesh?.userData?.antiStuds?.length);

    for (const s of studs) {
      worldPos.copy(s.pos).applyMatrix4(mesh.matrixWorld);
      worldUp.copy(s.up).transformDirection(mesh.matrixWorld).normalize();

      toCam.subVectors(camPos, worldPos);
      if (toCam.dot(worldUp) < -0.15) continue;

      toHit.subVectors(pt, worldPos);
      const sideProj = toHit.dot(worldUp);
      const distSq = worldPos.distanceToSquared(pt);
      const sameFace = worldUp.dot(cardN) > 0.72;
      const radialSq = Math.max(0, distSq - sideProj * sideProj);
      let matched = false;
      let effectiveDistSq = distSq;

      // Si el rayo atravesó el hueco de un stud abierto (`stud2a`) e impactó en la pared
      // trasera interna de la misma pieza, recuperamos el stud por el que entró el cursor.
      if (onHitObj && sideProj < -0.5 && toCam.dot(worldUp) > 0.15) {
        const denom = rayVec.dot(worldUp);
        if (denom < -0.1) {
          studFront.copy(worldPos).addScaledVector(worldUp, (s.height || 4) * 0.5);
          const t = enterPt.subVectors(studFront, camPos).dot(worldUp) / denom;
          if (t > 0 && t < 0.999) {
            enterPt.copy(camPos).addScaledVector(rayVec, t);
            const enterDistSq = enterPt.distanceToSquared(studFront);
            if (enterDistSq <= 5.5 * 5.5) {
              matched = true;
              effectiveDistSq = enterDistSq;
            }
          }
        }
      }

      if (!matched && isMinifigHead && carryingHeadgear && sideProj >= -27.5 && radialSq <= 14.5 * 14.5) {
        matched = true;
        effectiveDistSq = radialSq;
      }

      if (!matched && sideProj >= -2.5) {
        if (sameFace && distSq <= 22 * 22) {
          matched = true;
        } else if (
          onHitObj &&
          sideProj >= -0.8 &&
          sideProj <= (s.height || 4) + 1.5 &&
          radialSq <= 7.0 * 7.0 &&
          worldUp.dot(rawN) >= -0.08
        ) {
          // Golpe directo sobre el borde o pared cilíndrica del stud saliente
          matched = true;
          effectiveDistSq = radialSq;
        } else if (
          (Math.abs(worldUp.y) < 0.5 || rawN.y > 0.25) &&
          sideProj <= (s.height || 4) + 3.0 &&
          worldUp.dot(rawN) > 0.1
        ) {
          if (radialSq <= 10.5 * 10.5) {
            matched = true;
          }
        }
      } else if (
        !matched &&
        isMinifigHead &&
        sideProj >= -4.5 &&
        worldUp.dot(rawN) > 0.2 &&
        radialSq <= 13.8 * 13.8
      ) {
        matched = true;
        effectiveDistSq = radialSq;
      }

      if (!matched) continue;
      const score = effectiveDistSq - (onHitObj ? 9 : 0) - (sameFace ? 16 : 0);
      if (score < bestScore) {
        bestScore = score;
        const sc = snapNormalToCardinal(worldUp.x, worldUp.y, worldUp.z);
        best = {
          studPos: worldPos.clone(),
          studUp: new THREE.Vector3(sc.x, sc.y, sc.z),
          ownerMesh: mesh,
        };
      }
    }
  };

  const isIgnored = (m) => isIgnoredObject(ignoreMesh, m);

  if (hit.object && !isIgnored(hit.object)) {
    considerPiece(hit.object);
  }

  for (const p of bc.placedPieces) {
    if (isIgnored(p.mesh) || p.mesh === hit.object) continue;
    const wb = p.worldBox;
    if (
      wb &&
      (pt.x < wb.min.x - 22 ||
        pt.x > wb.max.x + 22 ||
        pt.y < wb.min.y - 22 ||
        pt.y > wb.max.y + 22 ||
        pt.z < wb.min.z - 22 ||
        pt.z > wb.max.z + 22)
    ) {
      continue;
    }
    considerPiece(p.mesh);
  }

  return best;
}

/**
 * Devuelve la distancia exacta desde el origen de la pieza llevada hasta su cara
 * de apoyo en dirección `-dirNormal`, y los offsets de sus receptores hembra rotados.
 */
export function resolveCarryConnectionGeometry(bc, dirNormal) {
  const quat = bc.carry.quaternion;
  const boxes = bc.carry.mesh.userData.collisionBoxes || [bc.carry.localBox];
  const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
  const isStandardBaseDown = localUp.dot(dirNormal) > 0.85;

  const { supportDist, worldReceptors, receptorsCenter } = (() => {
    if (isStandardBaseDown) {
      const defUnderside =
        bc.carry.mesh.userData.defaultSupportUndersideY ?? bc.carry.localBox.min.y;
      const dist = -defUnderside;
      const localReceptors = bc.carry.mesh.userData.bottomReceptors || [
        new THREE.Vector3(0, defUnderside, 0),
      ];
      const recs = localReceptors.map((r) => r.clone().applyQuaternion(quat));
      const rc = new THREE.Vector3();
      for (const r of recs) rc.add(r);
      rc.divideScalar(Math.max(1, recs.length));
      return { supportDist: dist, worldReceptors: recs, receptorsCenter: rc };
    }

    // Brackets y piezas SNOT rotadas para que un ala con studs mire hacia +Y:
    // detectamos el techo inferior real bajo esos studs para apoyar el ala al ras
    // dejando colgar el faldón vertical sin sumar holgura artificial.
    if (dirNormal.y > 0.85) {
      const alignedStuds = (bc.carry.mesh.userData.topStuds || []).filter((s) => {
        const up = s.up.clone().applyQuaternion(quat).normalize();
        return up.dot(dirNormal) > 0.85;
      });
      if (alignedStuds.length > 0) {
        const zero = new THREE.Vector3(0, 0, 0);
        const rotBoxes = boxes.map((b) => computeTransformedWorldBox([b], zero, quat));
        const flangeRecs = [];
        let flangeMinY = Infinity;
        for (const s of alignedStuds) {
          const sw = s.pos.clone().applyQuaternion(quat);
          let localUnderY = Infinity;
          for (const rb of rotBoxes) {
            if (
              rb.max.x >= sw.x - 8.5 &&
              rb.min.x <= sw.x + 8.5 &&
              rb.max.z >= sw.z - 8.5 &&
              rb.min.z <= sw.z + 8.5 &&
              rb.max.y <= sw.y + 0.5 &&
              rb.min.y >= sw.y - 9.0
            ) {
              if (rb.min.y < localUnderY) localUnderY = rb.min.y;
            }
          }
          if (localUnderY < Infinity) {
            flangeRecs.push(new THREE.Vector3(sw.x, localUnderY, sw.z));
            if (localUnderY < flangeMinY) flangeMinY = localUnderY;
          }
        }
        if (flangeRecs.length === alignedStuds.length && flangeMinY > bc.carry.ghostBox.min.y + 1.0) {
          const rc = new THREE.Vector3();
          for (const r of flangeRecs) rc.add(r);
          rc.divideScalar(flangeRecs.length);
          return { supportDist: -flangeMinY, worldReceptors: flangeRecs, receptorsCenter: rc };
        }
      }
    }

    const dist = computeSupportDistanceAlongDir(boxes, quat, dirNormal);
    const center = new THREE.Vector3();
    bc.carry.ghostBox.getCenter(center);
    const recs = [center.addScaledVector(dirNormal, -dist - center.dot(dirNormal))];
    return { supportDist: dist, worldReceptors: recs, receptorsCenter: recs[0].clone() };
  })();
  return { supportDist, worldReceptors, receptorsCenter };
}

/**
 * Genera candidatos alineados contra una pared lateral o techo sin studs (`cardN`),
 * respetando la grilla de la pieza tocada para encastrar en huecos cerrados.
 */
export function buildWallPocketCandidates(bc, hit, cardN) {
  if (!hit || hit.kind !== "placed") return [];
  const pt = hit.point;
  const step = bc.fineGrid ? LDU_HALF_STUD : LDU_STUD;
  const minAllowedY = -bc.carry.ghostBox.min.y;
  const boxes = bc.carry.mesh.userData.collisionBoxes || [bc.carry.localBox];
  const ghostBox = bc.carry.ghostBox;

  const normalAxis =
    Math.abs(cardN.x) > 0.5 ? "x" : Math.abs(cardN.y) > 0.5 ? "y" : "z";
  const tangentAxes =
    normalAxis === "y" ? ["x", "z"] : normalAxis === "x" ? ["y", "z"] : ["x", "y"];
  const [ax0, ax1] = tangentAxes;

  const wallDist = computeSupportDistanceAlongDir(boxes, bc.carry.quaternion, cardN);
  const center = new THREE.Vector3();
  ghostBox.getCenter(center);
  const desired = new THREE.Vector3().subVectors(pt, center);

  const basePiece = bc.placedPieces.find((p) => p.mesh === hit.object);
  const baseWb = basePiece?.worldBox || hit.object?.userData?.worldBox;

  const snapAxisToPiece = (ax, val) => {
    if (!baseWb) {
      return ax === "y"
        ? Math.round(val / LDU_PLATE) * LDU_PLATE
        : Math.round(val / step) * step;
    }
    return snapToReferenceCoord(val, ghostBox.min[ax], baseWb.min[ax], step);
  };

  const rawN = hit.normal || cardN;
  const isFlatCardinalWall = rawN.dot(cardN) > 0.98;
  const rawPlane = pt[normalAxis] + cardN[normalAxis] * wallDist;
  const normalPlane = isFlatCardinalWall
    ? Math.round(rawPlane * 100) / 100
    : Math.round(rawPlane / 4) * 4;

  const baseCand = new THREE.Vector3();
  baseCand[normalAxis] = normalPlane;
  baseCand[ax0] = snapAxisToPiece(ax0, desired[ax0]);
  baseCand[ax1] = snapAxisToPiece(ax1, desired[ax1]);

  const cands = [];
  const pushIfValidY = (v) => {
    if (v.y < minAllowedY - 0.01) return;
    if (v.y < minAllowedY) v.y = minAllowedY;
    cands.push(v);
  };

  pushIfValidY(baseCand);

  const offsets = [];
  for (const ax of [ax0, ax1]) {
    for (const delta of [-step, step]) {
      const alt = baseCand.clone();
      alt[ax] += delta;
      offsets.push(alt);
    }
  }
  if (normalAxis !== "y") {
    for (const dy of [-LDU_PLATE, LDU_PLATE]) {
      const alt = baseCand.clone();
      alt.y += dy;
      offsets.push(alt);
    }
  }
  offsets.sort((a, b) => a.distanceToSquared(desired) - b.distanceToSquared(desired));
  for (const o of offsets) pushIfValidY(o);
  return cands;
}

/**
 * Cuando la pieza apoyada no tiene studs útiles en la cara tocada (ej. 5095 con stud notch
 * o cara inferior de una pieza), busca receptores hembra / muescas del colocado compatibles
 * con los studs de la pieza llevada.
 */
export function findBestTargetReceptor(bc, hit, cardN, ignoreMesh) {
  if (!hit || hit.kind !== "placed" || !hit.object) return null;
  const isIgnored = (m) => isIgnoredObject(ignoreMesh, m);
  if (isIgnored(hit.object)) return null;

  const carriedStuds = bc.carry?.mesh?.userData?.topStuds;
  if (!carriedStuds?.length) return null;

  const placedMesh = hit.object;
  const baseRecs = placedMesh.userData?.bottomReceptors || [];
  const recRecs = placedMesh.userData?.recessedReceptors || [];
  if (!baseRecs.length && !recRecs.length) return null;

  placedMesh.updateMatrixWorld(true);
  const rawPlacedUp = new THREE.Vector3(0, 1, 0)
    .transformDirection(placedMesh.matrixWorld)
    .normalize();
  const uc = snapNormalToCardinal(rawPlacedUp.x, rawPlacedUp.y, rawPlacedUp.z);
  const placedUp = new THREE.Vector3(uc.x, uc.y, uc.z);

  const pt = hit.point;
  const camPos = bc.sceneManager.camera.position;
  const toCam = new THREE.Vector3();
  const worldPos = new THREE.Vector3();
  const undersideHits = placedUp.dot(cardN) < -0.72;

  let best = null;
  let bestScore = Infinity;

  const tryList = (list, isRecessed) => {
    for (const r of list) {
      worldPos.copy(r).applyMatrix4(placedMesh.matrixWorld);
      if (isRecessed) {
        const relAlongUp = new THREE.Vector3().subVectors(pt, worldPos).dot(placedUp);
        if (relAlongUp > 2.5) continue;
      } else {
        if (!undersideHits) continue;
        toCam.subVectors(camPos, worldPos);
        if (toCam.dot(placedUp) > 0.15) continue;
      }
      const distSq = worldPos.distanceToSquared(pt);
      if (distSq > 26 * 26) continue;
      const score = distSq - (isRecessed ? 12 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = {
          receptorPos: worldPos.clone(),
          studUp: placedUp.clone(),
          ownerMesh: placedMesh,
        };
      }
    }
  };

  tryList(recRecs, true);
  tryList(baseRecs, false);
  return best;
}

export function countStudSupports(bc, candidatePos, receptors, normalAxis, studUp, ignoreMesh) {
  if (!receptors?.length) return 0;
  const reqWorld = new THREE.Vector3();
  const sWorld = new THREE.Vector3();
  const sUp = new THREE.Vector3();
  const isIgnored = (m) => isIgnoredObject(ignoreMesh, m);
  let matches = 0;

  for (const r of receptors) {
    reqWorld.copy(candidatePos).add(r);
    let matchedThisRec = false;
    for (const p of bc.placedPieces) {
      if (isIgnored(p.mesh)) continue;
      const wb = p.worldBox;
      if (
        wb &&
        (reqWorld.x < wb.min.x - 12 ||
          reqWorld.x > wb.max.x + 12 ||
          reqWorld.y < wb.min.y - 12 ||
          reqWorld.y > wb.max.y + 12 ||
          reqWorld.z < wb.min.z - 12 ||
          reqWorld.z > wb.max.z + 12)
      ) {
        continue;
      }
      const studs = p.mesh.userData.topStuds;
      if (!studs?.length) continue;
      p.mesh.updateMatrixWorld(true);
      for (const s of studs) {
        sUp.copy(s.up).transformDirection(p.mesh.matrixWorld).normalize();
        if (sUp.dot(studUp) < 0.85) continue;
        sWorld.copy(s.pos).applyMatrix4(p.mesh.matrixWorld);
        if (Math.abs(sWorld[normalAxis] - reqWorld[normalAxis]) > 2.5) continue;
        const tanDistSq =
          (normalAxis !== "x" ? (reqWorld.x - sWorld.x) ** 2 : 0) +
          (normalAxis !== "y" ? (reqWorld.y - sWorld.y) ** 2 : 0) +
          (normalAxis !== "z" ? (reqWorld.z - sWorld.z) ** 2 : 0);
        if (tanDistSq <= 3.5 * 3.5) {
          matchedThisRec = true;
          break;
        }
      }
      if (matchedThisRec) break;
    }
    if (matchedThisRec) matches += 1;
  }
  return matches;
}

/**
 * Verifica que en `candidatePos` al menos un receptor de la pieza llevada conecte
 * con un stud real en el mismo plano `(planeCoord, studUp)` de la construcción.
 */
export function hasStudSupportOnPlane(bc, candidatePos, worldReceptors, normalAxis, studPlaneCoord, studUp, ignoreMesh) {
  const reqWorld = new THREE.Vector3();
  const sWorld = new THREE.Vector3();
  const sUp = new THREE.Vector3();
  const isIgnored = (m) => isIgnoredObject(ignoreMesh, m);

  for (const p of bc.placedPieces) {
    if (isIgnored(p.mesh)) continue;
    const wb = p.worldBox;
    if (
      wb &&
      (candidatePos.x < wb.min.x - 160 ||
        candidatePos.x > wb.max.x + 160 ||
        candidatePos.y < wb.min.y - 160 ||
        candidatePos.y > wb.max.y + 160 ||
        candidatePos.z < wb.min.z - 160 ||
        candidatePos.z > wb.max.z + 160)
    ) {
      continue;
    }
    const studs = p.mesh.userData.topStuds;
    if (!studs?.length) continue;
    p.mesh.updateMatrixWorld(true);

    for (const s of studs) {
      sUp.copy(s.up).transformDirection(p.mesh.matrixWorld).normalize();
      if (sUp.dot(studUp) < 0.85) continue;
      sWorld.copy(s.pos).applyMatrix4(p.mesh.matrixWorld);
      if (Math.abs(sWorld[normalAxis] - studPlaneCoord) > 2.5) continue;

      for (const r of worldReceptors) {
        reqWorld.copy(candidatePos).add(r);
        // Comparamos los 2 ejes tangentes al plano del stud
        const distSq =
          (normalAxis !== "x" ? (reqWorld.x - sWorld.x) ** 2 : 0) +
          (normalAxis !== "y" ? (reqWorld.y - sWorld.y) ** 2 : 0) +
          (normalAxis !== "z" ? (reqWorld.z - sWorld.z) ** 2 : 0);
        if (distSq <= 3.5 * 3.5) {
          return true;
        }
      }
    }
  }
  return false;
}

export function computeSupportedSurfaceAt(bc, candidateBoxes, x, z, maxSearchY, ignoreMesh, minOverlap = 4) {
  const isIgnored = (m) => isIgnoredObject(ignoreMesh, m);
  const probeBox = computeTransformedWorldBox(
    candidateBoxes,
    new THREE.Vector3(x, 0, z),
    bc.carry.quaternion
  );
  const placedBoxes = [];
  for (const p of bc.placedPieces) {
    if (isIgnored(p.mesh) || !p.worldBox) continue;
    placedBoxes.push(p.worldBox);
  }
  return computeSupportedSurfaceY(
    probeBox.min.x,
    probeBox.max.x,
    probeBox.min.z,
    probeBox.max.z,
    placedBoxes,
    maxSearchY,
    minOverlap
  );
}

export function isInPileZone(bc, x, z) {
  return bc.pilePhysics.isPointInAnyBag(x, z, 20);
}

export function saveCarryValidState(bc, pos) {
  bc.carry.lastValid = {
    position: pos.clone(),
    quaternion: bc.carry.quaternion.clone(),
    surfaceNormal: bc.carry.surfaceNormal.clone(),
    activeMechKind: bc.carry.activeMechKind || null,
    spinAngle: bc.carry.spinAngle,
    manualTiltApplied: bc.carry.manualTiltApplied,
    manualOffsetX: bc.carry.manualOffsetX,
    manualOffsetY: bc.carry.manualOffsetY,
    manualOffsetZ: bc.carry.manualOffsetZ,
  };
}

export function restoreCarryValidState(bc) {
  const lv = bc.carry?.lastValid;
  if (!lv) return false;
  const quatChanged = bc.carry.quaternion.angleTo(lv.quaternion) > 1e-4;
  bc.carry.quaternion.copy(lv.quaternion);
  bc.carry.surfaceNormal.copy(lv.surfaceNormal);
  bc.carry.activeMechKind = lv.activeMechKind || null;
  bc.carry.spinAngle = lv.spinAngle;
  bc.carry.manualTiltApplied = lv.manualTiltApplied;
  bc.carry.manualOffsetX = lv.manualOffsetX || 0;
  bc.carry.manualOffsetY = lv.manualOffsetY;
  bc.carry.manualOffsetZ = lv.manualOffsetZ || 0;
  if (quatChanged) {
    bc._recomputeCarryBounds();
  }
  bc.carry.ghost.position.copy(lv.position);
  bc.carry.ghost.quaternion.copy(lv.quaternion);
  return true;
}

function commitValidCarryPose(bc, pos, quat = bc.carry.quaternion) {
  bc.carry.ghost.position.copy(pos);
  bc.carry.ghost.quaternion.copy(quat);
  bc.carry.isColliding = false;
  saveCarryValidState(bc, pos);
  bc._emitStatus();
}

function resolveCollisionOrEscape(
  bc,
  candList,
  primaryCand,
  { activeNormal, bestStud, bestMech, hit, cardN, candidateBoxes, candidateMeshData, ignoreMesh, minAllowedY }
) {
  if (!bc.collisionEnabled) {
    commitValidCarryPose(bc, primaryCand);
    return;
  }

  for (const cand of candList) {
    if (
      !checkPieceCollision(
        candidateBoxes,
        cand,
        bc.carry.quaternion,
        bc.placedPieces,
        ignoreMesh,
        0.052,
        candidateMeshData
      )
    ) {
      commitValidCarryPose(bc, cand);
      return;
    }
  }

  if (bestMech?.altMatchTransforms?.length) {
    for (const altMatch of bestMech.altMatchTransforms) {
      const altMinY = computeSupportDistanceAlongDir(
        candidateBoxes,
        altMatch.quaternion,
        WORLD_Y
      );
      const altLift =
        altMatch.kind === "bar_axle" || altMatch.kind === "bar" ? 6.0 : 0.01;
      const altPosList = [altMatch.position, ...(altMatch.altPositions || [])];
      for (const rawAltPos of altPosList) {
        const snapPos = rawAltPos.clone();
        if (bc.carry.manualOffsetX || bc.carry.manualOffsetY || bc.carry.manualOffsetZ) {
          snapPos.x += bc.carry.manualOffsetX;
          snapPos.y += bc.carry.manualOffsetY;
          snapPos.z += bc.carry.manualOffsetZ;
        }
        if (snapPos.y < altMinY && snapPos.y >= altMinY - altLift) {
          snapPos.y = altMinY;
        }
        if (snapPos.y < altMinY - 0.01) continue;
        if (
          !checkPieceCollision(
            candidateBoxes,
            snapPos,
            altMatch.quaternion,
            bc.placedPieces,
            ignoreMesh,
            0.052,
            candidateMeshData
          )
        ) {
          const quatChanged = altMatch.quaternion.angleTo(bc.carry.quaternion) > 0.001;
          bc.carry.quaternion.copy(altMatch.quaternion);
          bc.carry.surfaceNormal.copy(altMatch.targetDir || WORLD_Y);
          bc.carry.activeMechKind = altMatch.kind;
          if (quatChanged) {
            bc._recomputeCarryBounds();
          }
          commitValidCarryPose(bc, snapPos, altMatch.quaternion);
          return;
        }
      }
    }
  }

  // En modo horizontal sobre piezas/mesa, apoyamos sobre obstáculos bajos sin saltar desde paredes verticales
  if (activeNormal.y > 0.85 && (hit.kind === "table" || cardN.y > 0.5)) {
    const colliders = findCollidingPieces(
      candidateBoxes,
      primaryCand,
      bc.carry.quaternion,
      bc.placedPieces,
      ignoreMesh,
      0.052,
      candidateMeshData
    );
    if (colliders.length > 0) {
      const { supportDist } = resolveCarryConnectionGeometry(bc, WORLD_Y);
      const maxObsY = Math.max(...colliders.map((p) => p.worldBox.max.y));
      const liftedY = Math.max(minAllowedY, maxObsY + supportDist);
      const maxLiftStep = hit.kind === "table" ? 12 : 24;
      if (liftedY > primaryCand.y && liftedY - primaryCand.y <= maxLiftStep) {
        const liftedPos = new THREE.Vector3(primaryCand.x, liftedY, primaryCand.z);
        if (
          !checkPieceCollision(
            candidateBoxes,
            liftedPos,
            bc.carry.quaternion,
            bc.placedPieces,
            ignoreMesh,
            0.052,
            candidateMeshData
          )
        ) {
          commitValidCarryPose(bc, liftedPos);
          return;
        }
      }
    }
  }

  // Si está chocando contra una pared/pieza, retenemos la última pose válida solo si está contigua
  const lv = bc.carry.lastValid;
  if (
    lv &&
    lv.position.distanceTo(primaryCand) <= 20 &&
    lv.surfaceNormal.distanceToSquared(bc.carry.surfaceNormal) < 0.05 &&
    restoreCarryValidState(bc)
  ) {
    bc.carry.isColliding = false;
    bc._emitStatus();
    return;
  }

  // Vista previa no penetrante justo por fuera del obstáculo (sin permitir soltar adentro)
  const escapeDir = bestStud ? bestStud.studUp : WORLD_Y;
  const fallbackPos = primaryCand.clone();
  const isLargeGroup = bc.carry.source === "group" && (bc.carry.origGroup?.length || 0) >= 6;
  const escapeStep = isLargeGroup ? LDU_PLATE : LDU_HALF_PLATE;
  const maxEscapeSteps = isLargeGroup ? 7 : 14;
  for (let s = 1; s <= maxEscapeSteps; s += 1) {
    fallbackPos.copy(primaryCand).addScaledVector(escapeDir, s * escapeStep);
    if (
      !checkPieceCollision(
        candidateBoxes,
        fallbackPos,
        bc.carry.quaternion,
        bc.placedPieces,
        ignoreMesh,
        0.052,
        candidateMeshData
      )
    ) {
      break;
    }
  }
  bc.carry.ghost.position.copy(fallbackPos);
  bc.carry.ghost.quaternion.copy(bc.carry.quaternion);
  bc.carry.isColliding = true;
  bc._emitStatus();
}

export function updateCarryTransform(bc) {
  if (!bc.carry || !bc._lastHit) return;
  const hit = bc._lastHit;
  const pt = hit.point;

  if (isInPileZone(bc, pt.x, pt.z)) {
    bc.carry.ghost.position.set(pt.x, Math.max(20, pt.y + 18), pt.z);
    bc.carry.ghost.quaternion.copy(bc.carry.quaternion);
    bc.carry.isColliding = false;
    return;
  }

  const ignoreMesh = bc.carry.ignoreSet || bc.carry.origPlaced?.mesh || null;
  const candidateBoxes = bc.carry.mesh.userData.collisionBoxes || [bc.carry.localBox];
  const rawN = hit.normal || WORLD_Y;
  const c = snapNormalToCardinal(rawN.x, rawN.y, rawN.z);
  const cardN = new THREE.Vector3(c.x, c.y, c.z);

  // 1. Conexión realista por circulitos ("studs") o encastre mecánico (pin/axle/clip/mano/bisagra/bola/minifig)
  const rawBestStud = findBestConnectionStud(bc, hit, cardN, ignoreMesh);
  const rawBestMech = findBestMechanicalMatch({
    carriedMesh: bc.carry.mesh,
    carriedQuat: bc.carry.quaternion,
    autoOrient: bc.autoOrient,
    manualTiltApplied: bc.carry.manualTiltApplied,
    spinAngle: bc.carry.spinAngle,
    hit,
    cardN,
    placedPieces: bc.placedPieces,
    ignoreMesh,
  });
  const preferMech =
    rawBestMech &&
    (!rawBestStud ||
      ((rawBestMech.kind === "minifig_hip" ||
        rawBestMech.kind === "minifig_neck" ||
        rawBestMech.kind === "wheel_pin" ||
        rawBestMech.kind === "wheel_tyre" ||
        rawBestMech.kind === "bar_axle" ||
        rawBestMech.kind === "bar") &&
        rawBestMech.ownerMesh === hit.object &&
        (rawBestStud.ownerMesh !== hit.object ||
          (rawBestMech.kind === "minifig_neck" &&
            !(bc.carry?.mesh?.userData?.antiStuds?.length)))));
  const bestStud = preferMech ? null : rawBestStud;
  const bestMech = preferMech ? rawBestMech : rawBestStud ? null : rawBestMech;
  const bestTargetReceptor =
    !bestStud && !bestMech ? findBestTargetReceptor(bc, hit, cardN, ignoreMesh) : null;

  if (bc.autoOrient && !bc.carry.manualTiltApplied) {
    if (bestMech) {
      if (!bc.carry.activeMechKind) {
        bc.carry.manualOffsetX = 0;
        bc.carry.manualOffsetY = 0;
        bc.carry.manualOffsetZ = 0;
      }
      bc.carry.activeMechKind = bestMech.kind;
      if (bestMech.quaternion.angleTo(bc.carry.quaternion) > 0.001) {
        bc.carry.quaternion.copy(bestMech.quaternion);
        bc._recomputeCarryBounds();
      }
    } else {
      const carriedSideStud =
        bestTargetReceptor && Math.abs(bestTargetReceptor.studUp.y) < 0.5
          ? (bc.carry.mesh.userData.topStuds || []).find(
              (s) => s.up && Math.abs(s.up.y) < 0.5
            )
          : null;
      if (carriedSideStud) {
        const localSideUp = carriedSideStud.up.clone();
        localSideUp.y = 0;
        if (localSideUp.lengthSq() > 0.01) {
          localSideUp.normalize();
          const targetQuat = new THREE.Quaternion().setFromUnitVectors(
            localSideUp,
            bestTargetReceptor.studUp
          );
          bc.carry.activeMechKind = null;
          bc.carry.surfaceNormal.copy(WORLD_Y);
          if (targetQuat.angleTo(bc.carry.quaternion) > 0.001) {
            bc.carry.manualOffsetX = 0;
            bc.carry.manualOffsetY = 0;
            bc.carry.manualOffsetZ = 0;
            bc.carry.quaternion.copy(targetQuat);
            bc._recomputeCarryBounds();
          }
        }
      } else {
        const targetN = bestStud
          ? bestStud.studUp
          : bestTargetReceptor
            ? bestTargetReceptor.studUp
            : WORLD_Y;
        if (
          bc.carry.activeMechKind ||
          targetN.distanceToSquared(bc.carry.surfaceNormal) > 0.01
        ) {
          bc.carry.activeMechKind = null;
          bc.carry.surfaceNormal.copy(targetN);
          bc.carry.manualOffsetX = 0;
          bc.carry.manualOffsetY = 0;
          bc.carry.manualOffsetZ = 0;
          bc._applyAutoOrientation(targetN);
          bc._recomputeCarryBounds();
        }
      }
    }
  } else if (!bestMech) {
    bc.carry.activeMechKind = null;
  } else {
    bc.carry.activeMechKind = bestMech.kind;
  }

  const step = bc.fineGrid ? LDU_HALF_STUD : LDU_STUD;
  const minAllowedY = -bc.carry.ghostBox.min.y;
  const candList = [];
  let activeNormal = WORLD_Y;

  if (bestStud) {
    activeNormal = bestStud.studUp;
    const normalAxis =
      Math.abs(activeNormal.x) > 0.5 ? "x" : Math.abs(activeNormal.y) > 0.5 ? "y" : "z";
    const tangentAxes =
      normalAxis === "y" ? ["x", "z"] : normalAxis === "x" ? ["y", "z"] : ["x", "y"];

    const { supportDist, worldReceptors, receptorsCenter } =
      resolveCarryConnectionGeometry(bc, activeNormal);
    const [ax0, ax1] = tangentAxes;
    const desiredOrigin = new THREE.Vector3().subVectors(pt, receptorsCenter);

    // Agrupa receptores por paridad distinta (ej. esquinas +-10 y centro (0,0) en Dish/Jumper)
    const mod20 = (val) => ((Math.round(val) % 20) + 20) % 20;
    const uniqueReceptors = [];
    const seenMod = new Set();
    for (const r of worldReceptors) {
      const key = `${mod20(r[ax0])}_${mod20(r[ax1])}`;
      if (!seenMod.has(key)) {
        seenMod.add(key);
        uniqueReceptors.push(r);
      }
    }

    const span0 = bc.carry.ghostBox.max[ax0] - bc.carry.ghostBox.min[ax0];
    const span1 = bc.carry.ghostBox.max[ax1] - bc.carry.ghostBox.min[ax1];
    const multiAxes = [];
    if (span0 > LDU_STUD + 2) multiAxes.push(ax0);
    if (span1 > LDU_STUD + 2) multiAxes.push(ax1);

    const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(bc.carry.quaternion);
    const isStandardBaseDown = localUp.dot(activeNormal) > 0.85;
    const recessedY = isStandardBaseDown
      ? bc.carry.mesh.userData.recessedSupportUndersideY
      : null;
    const perCellRecessed = isStandardBaseDown
      ? bc.carry.mesh.userData.recessedReceptors || []
      : [];

    const distChoices = recessedY != null ? [-recessedY, supportDist] : [supportDist];
    const primaryChoicesByDist = [];
    for (const distOpt of distChoices) {
      const groupChoices = [];
      for (const refR of uniqueReceptors) {
        const cand = new THREE.Vector3();
        cand[normalAxis] =
          bestStud.studPos[normalAxis] + activeNormal[normalAxis] * distOpt;
        cand[ax0] =
          span0 <= LDU_STUD + 2 || worldReceptors.length === 1
            ? bestStud.studPos[ax0] - refR[ax0]
            : snapToReferenceCoord(desiredOrigin[ax0], refR[ax0], bestStud.studPos[ax0], step);
        cand[ax1] =
          span1 <= LDU_STUD + 2 || worldReceptors.length === 1
            ? bestStud.studPos[ax1] - refR[ax1]
            : snapToReferenceCoord(desiredOrigin[ax1], refR[ax1], bestStud.studPos[ax1], step);
        if (cand.y >= minAllowedY - 0.01) {
          if (cand.y < minAllowedY) cand.y = minAllowedY;
          groupChoices.push(cand);
        }
      }
      groupChoices.sort(
        (a, b) => a.distanceToSquared(desiredOrigin) - b.distanceToSquared(desiredOrigin)
      );
      primaryChoicesByDist.push(groupChoices);
    }

    if (recessedY == null && perCellRecessed.length > 0) {
      const boxCenter = new THREE.Vector3();
      bc.carry.ghostBox.getCenter(boxCenter);
      const desiredBoxOrigin = new THREE.Vector3().subVectors(pt, boxCenter);
      const scoredChoices = [];
      const seenPos = new Set();
      const worldRecessed = perCellRecessed.map((r) =>
        r.clone().applyQuaternion(bc.carry.quaternion)
      );
      const allRecs = worldReceptors.concat(worldRecessed);
      const pushScored = (cand, isRecessed) => {
        const k = `${Math.round(cand.x * 10)}_${Math.round(cand.y * 10)}_${Math.round(cand.z * 10)}`;
        if (seenPos.has(k)) return;
        seenPos.add(k);
        const recsToCheck = isRecessed ? allRecs : worldReceptors;
        const matches = countStudSupports(bc, 
          cand,
          recsToCheck,
          normalAxis,
          activeNormal,
          ignoreMesh
        );
        const d2 = cand.distanceToSquared(desiredBoxOrigin);
        const score = d2 - (matches >= 2 ? 120 : 0) - (isRecessed ? 10 : 0);
        scoredChoices.push({ cand, score });
      };

      for (const cand of primaryChoicesByDist[0] || []) {
        pushScored(cand, false);
      }
      for (const rr of perCellRecessed) {
        const worldRR = rr.clone().applyQuaternion(bc.carry.quaternion);
        const recCand = new THREE.Vector3(
          bestStud.studPos.x - worldRR.x,
          bestStud.studPos.y - worldRR.y,
          bestStud.studPos.z - worldRR.z
        );
        if (recCand.y >= minAllowedY - 0.01) {
          if (recCand.y < minAllowedY) recCand.y = minAllowedY;
          pushScored(recCand, true);
        }
      }
      scoredChoices.sort((a, b) => a.score - b.score);
      for (const entry of scoredChoices) {
        candList.push(entry.cand);
      }
    } else {
      for (const groupChoices of primaryChoicesByDist) {
        for (const p of groupChoices) {
          candList.push(p);
        }
      }
    }

    const primary =
      primaryChoicesByDist[primaryChoicesByDist.length - 1]?.[0] ||
      primaryChoicesByDist[0]?.[0] ||
      candList[0] ||
      desiredOrigin.clone();

    // Si choca ligeramente al buscar un hueco justo, probamos deslizar 1 paso en ejes de >1 stud
    // manteniendo conexión real con algún stud del mismo plano
    if (multiAxes.length > 0 && bc.collisionEnabled) {
      const neighborOffsets = [];
      for (const ax of multiAxes) {
        for (const dir of [-step, step]) {
          const p = primary.clone();
          p[ax] += dir;
          if (p.y < minAllowedY - 0.01) continue;
          if (p.y < minAllowedY) p.y = minAllowedY;
          neighborOffsets.push(p);
        }
      }
      if (multiAxes.length === 2) {
        const [ma0, ma1] = multiAxes;
        for (const d0 of [-step, step]) {
          for (const d1 of [-step, step]) {
            const p = primary.clone();
            p[ma0] += d0;
            p[ma1] += d1;
            if (p.y < minAllowedY - 0.01) continue;
            if (p.y < minAllowedY) p.y = minAllowedY;
            neighborOffsets.push(p);
          }
        }
      }
      neighborOffsets.sort(
        (a, b) => a.distanceToSquared(desiredOrigin) - b.distanceToSquared(desiredOrigin)
      );
      for (const np of neighborOffsets) {
        if (
          hasStudSupportOnPlane(bc, 
            np,
            worldReceptors,
            normalAxis,
            bestStud.studPos[normalAxis],
            activeNormal,
            ignoreMesh
          )
        ) {
          candList.push(np);
        }
      }
    }

    // Si el stud más cercano ya está ocupado/bloqueado en un hueco lateral, probamos la pared tocada
    if (hit.kind === "placed" && (Math.abs(cardN.y) < 0.5 || cardN.y < -0.5)) {
      for (const wc of buildWallPocketCandidates(bc, hit, cardN)) {
        candList.push(wc);
      }
    }
  } else if (bestMech) {
    activeNormal = bestMech.targetDir;
    const mechPositions = [bestMech.position, ...(bestMech.altPositions || [])];
    const maxFloorLift =
      bestMech.kind === "bar_axle" || bestMech.kind === "bar" ? 6.0 : 0.01;
    for (const rawPos of mechPositions) {
      const snapPos = rawPos.clone();
      if (snapPos.y < minAllowedY && snapPos.y >= minAllowedY - maxFloorLift) {
        snapPos.y = minAllowedY;
      }
      if (snapPos.y >= minAllowedY - 0.01) {
        candList.push(snapPos);
      }
    }
  } else if (bestTargetReceptor) {
    activeNormal = bestTargetReceptor.studUp;
    const carriedStuds = bc.carry.mesh.userData.topStuds || [];
    const sWorldList = [];
    const tmpUp = new THREE.Vector3();
    for (const s of carriedStuds) {
      tmpUp.copy(s.up).applyQuaternion(bc.carry.quaternion).normalize();
      if (tmpUp.dot(activeNormal) > 0.85) {
        sWorldList.push(s.pos.clone().applyQuaternion(bc.carry.quaternion));
      }
    }
    if (sWorldList.length) {
      const studsCenter = new THREE.Vector3();
      for (const sw of sWorldList) studsCenter.add(sw);
      studsCenter.divideScalar(sWorldList.length);
      const desiredOrigin = new THREE.Vector3().subVectors(pt, studsCenter);

      const targetMesh = bestTargetReceptor.ownerMesh;
      targetMesh.updateMatrixWorld(true);
      const targetRecs = [
        bestTargetReceptor.receptorPos,
        ...[
          ...(targetMesh.userData?.recessedReceptors || []),
          ...(targetMesh.userData?.bottomReceptors || []),
        ].map((r) => r.clone().applyMatrix4(targetMesh.matrixWorld)),
      ];

      const seenCand = new Set();
      const scored = [];
      for (let rIdx = 0; rIdx < targetRecs.length; rIdx += 1) {
        const recW = targetRecs[rIdx];
        for (const sw of sWorldList) {
          const cand = new THREE.Vector3().subVectors(recW, sw);
          if (cand.y < minAllowedY - 0.01) continue;
          if (cand.y < minAllowedY) cand.y = minAllowedY;
          const k = `${Math.round(cand.x * 10)}_${Math.round(cand.y * 10)}_${Math.round(cand.z * 10)}`;
          if (seenCand.has(k)) continue;
          seenCand.add(k);
          const d2 = cand.distanceToSquared(desiredOrigin) + (rIdx > 0 ? 150 : 0);
          scored.push({ cand, d2 });
        }
      }
      scored.sort((a, b) => a.d2 - b.d2);
      for (const item of scored) candList.push(item.cand);
    }
  } else {
    // 2. Superficie sin studs: mesa libre, cara superior lisa o borde lateral sin stud
    const { supportDist, worldReceptors, receptorsCenter } =
      resolveCarryConnectionGeometry(bc, WORLD_Y);
    const refR = worldReceptors[0];

    if (hit.kind === "placed" && cardN.y > 0.5 && hit.object) {
      // Relativo a las celdas de la pieza lisa tocada (respeta desfases de brackets/jumpers)
      const basePiece = bc.placedPieces.find((p) => p.mesh === hit.object);
      const baseWb = basePiece?.worldBox || hit.object.userData.worldBox;
      const baseCellX = baseWb ? baseWb.min.x + LDU_HALF_STUD : hit.object.position.x;
      const baseCellZ = baseWb ? baseWb.min.z + LDU_HALF_STUD : hit.object.position.z;
      const desired = new THREE.Vector3().subVectors(pt, receptorsCenter);
      let x = snapToReferenceCoord(desired.x, refR.x, baseCellX, step);
      let z = snapToReferenceCoord(desired.z, refR.z, baseCellZ, step);

      if (baseWb) {
        const probe = computeTransformedWorldBox(
          candidateBoxes,
          new THREE.Vector3(x, 0, z),
          bc.carry.quaternion
        );
        const ovX = Math.min(probe.max.x, baseWb.max.x) - Math.max(probe.min.x, baseWb.min.x);
        const ovZ = Math.min(probe.max.z, baseWb.max.z) - Math.max(probe.min.z, baseWb.min.z);
        if (ovX < 4) {
          const centerX = (baseWb.min.x + baseWb.max.x) * 0.5;
          x += x > centerX ? -step : step;
        }
        if (ovZ < 4) {
          const centerZ = (baseWb.min.z + baseWb.max.z) * 0.5;
          z += z > centerZ ? -step : step;
        }
      }

      const supportedY = computeSupportedSurfaceAt(bc, 
        candidateBoxes,
        x,
        z,
        (baseWb?.max.y ?? pt.y) + 2,
        ignoreMesh
      );
      const y = Math.max(minAllowedY, supportedY + supportDist);
      candList.push(new THREE.Vector3(x, y, z));
    } else {
      const snapped = snapXZ(pt.x, pt.z, {
        fineGrid: bc.fineGrid,
        offsetX: bc.carry.parityOffsetX,
        offsetZ: bc.carry.parityOffsetZ,
      });
      // En paredes/esquinas sin stud no dejamos flotar la pieza en el aire a altura `pt.y`:
      // buscamos soporte sólido real debajo `(x, z)` o bajamos a la mesa.
      const surfaceY =
        hit.kind === "table"
          ? computeSurfaceY(pt.y, true)
          : computeSupportedSurfaceAt(bc, 
              candidateBoxes,
              snapped.x,
              snapped.z,
              pt.y + 2,
              ignoreMesh
            );
      const y = Math.max(minAllowedY, surfaceY + supportDist);
      const floorCand = new THREE.Vector3(snapped.x, y, snapped.z);

      const isWallOrCeiling = hit.kind === "placed" && (Math.abs(cardN.y) < 0.5 || cardN.y < -0.5);
      if (isWallOrCeiling) {
        const wallCands = buildWallPocketCandidates(bc, hit, cardN);
        const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(bc.carry.quaternion);
        const baseFacesWall =
          localUp.dot(cardN) > 0.7 || cardN.y < -0.5 || Math.abs(floorCand.y - pt.y) > 16;
        if (baseFacesWall) {
          for (const wc of wallCands) candList.push(wc);
          candList.push(floorCand);
        } else {
          candList.push(floorCand);
          for (const wc of wallCands) candList.push(wc);
        }
      } else {
        candList.push(floorCand);
      }
    }
  }

  if (bc.carry.manualOffsetX || bc.carry.manualOffsetY || bc.carry.manualOffsetZ) {
    for (const cand of candList) {
      cand.x += bc.carry.manualOffsetX;
      cand.y = Math.max(minAllowedY, cand.y + bc.carry.manualOffsetY);
      cand.z += bc.carry.manualOffsetZ;
    }
  }

  const primaryCand =
    candList[0] ||
    new THREE.Vector3(
      pt.x + bc.carry.manualOffsetX,
      Math.max(minAllowedY, pt.y + bc.carry.manualOffsetY),
      pt.z + bc.carry.manualOffsetZ
    );

  const candidateMeshData = bc.carry.mesh.userData.collisionMeshData || null;
  resolveCollisionOrEscape(bc, candList, primaryCand, {
    activeNormal,
    bestStud,
    bestMech,
    hit,
    cardN,
    candidateBoxes,
    candidateMeshData,
    ignoreMesh,
    minAllowedY,
  });
}
