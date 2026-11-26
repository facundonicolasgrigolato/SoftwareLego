import * as THREE from "three";
import { checkMeshBvhCollision } from "./meshCollision.js";

const _cA = new THREE.Vector3();
const _cB = new THREE.Vector3();
const _halfA = new Float64Array(3);
const _halfB = new Float64Array(3);
const _axesA = new Float64Array(9);
const _axesB = new Float64Array(9);
const _mat = new Float64Array(9);
const _absR = new Float64Array(9);
const _tA = new Float64Array(3);
const _zeroPos = new THREE.Vector3();
const _subPos = new THREE.Vector3();
const _subQuat = new THREE.Quaternion();
const _memberWorldBox = new THREE.Box3();

/**
 * Margen proporcional (~5.2% por cara = ~10.4% entre piezas iguales, con mínimo
 * para voxeles de 4 LDU y tope de 2.2 LDU en piezas grandes) para tolerar encastres
 * muy justos sin permitir que piezas delgadas (4-8 LDU) sean atravesadas.
 */
function computeAxisMargin(size, tolerance) {
  if (tolerance <= 0) return 0;
  if (tolerance >= 0.4) return tolerance;
  return Math.min(2.2, Math.max(0.42, size * tolerance));
}

function writeQuaternionBasis(q, out) {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = xy - wz;
  out[4] = 1 - (xx + zz);
  out[5] = yz + wx;
  out[6] = xz + wy;
  out[7] = yz - wx;
  out[8] = 1 - (xx + yy);
}

function writeWorldOBB(localBox, pos, quat, tolerance, centerOut, halfOut, axesOut) {
  const sx = Math.max(0.5, localBox.max.x - localBox.min.x);
  const sy = Math.max(0.5, localBox.max.y - localBox.min.y);
  const sz = Math.max(0.5, localBox.max.z - localBox.min.z);
  halfOut[0] = Math.max(0.25, sx * 0.5 - computeAxisMargin(sx, tolerance));
  halfOut[1] = Math.max(0.25, sy * 0.5 - computeAxisMargin(sy, tolerance));
  halfOut[2] = Math.max(0.25, sz * 0.5 - computeAxisMargin(sz, tolerance));

  const lx = (localBox.min.x + localBox.max.x) * 0.5;
  const ly = (localBox.min.y + localBox.max.y) * 0.5;
  const lz = (localBox.min.z + localBox.max.z) * 0.5;
  writeQuaternionBasis(quat, axesOut);
  centerOut.set(
    pos.x + axesOut[0] * lx + axesOut[3] * ly + axesOut[6] * lz,
    pos.y + axesOut[1] * lx + axesOut[4] * ly + axesOut[7] * lz,
    pos.z + axesOut[2] * lx + axesOut[5] * ly + axesOut[8] * lz
  );
}

/**
 * Test exacto OBB vs OBB mediante Teorema de Ejes Separadores (SAT).
 * Usa tolerancia proporcional por defecto (`0.052` por cara ≈ `10%` entre piezas)
 * respetando geometrías delgadas como faldones de brackets (4 LDU) o clips (8 LDU).
 */
export function obbOverlap(boxA, posA, quatA, boxB, posB, quatB, tolerance = 0.052) {
  writeWorldOBB(boxA, posA, quatA, tolerance, _cA, _halfA, _axesA);
  writeWorldOBB(boxB, posB, quatB, tolerance, _cB, _halfB, _axesB);

  const tx = _cB.x - _cA.x;
  const ty = _cB.y - _cA.y;
  const tz = _cB.z - _cA.z;
  const EPS = 1e-6;

  for (let i = 0; i < 3; i += 1) {
    const ai = i * 3;
    const ax = _axesA[ai];
    const ay = _axesA[ai + 1];
    const az = _axesA[ai + 2];
    _tA[i] = tx * ax + ty * ay + tz * az;
    for (let j = 0; j < 3; j += 1) {
      const bj = j * 3;
      const dot = ax * _axesB[bj] + ay * _axesB[bj + 1] + az * _axesB[bj + 2];
      const idx = i * 3 + j;
      _mat[idx] = dot;
      _absR[idx] = (dot < 0 ? -dot : dot) + EPS;
    }
  }

  for (let i = 0; i < 3; i += 1) {
    const r = i * 3;
    const ra = _halfA[i];
    const rb = _halfB[0] * _absR[r] + _halfB[1] * _absR[r + 1] + _halfB[2] * _absR[r + 2];
    if (Math.abs(_tA[i]) > ra + rb) return false;
  }

  for (let j = 0; j < 3; j += 1) {
    const bj = j * 3;
    const ra = _halfA[0] * _absR[j] + _halfA[1] * _absR[3 + j] + _halfA[2] * _absR[6 + j];
    const rb = _halfB[j];
    const dist = Math.abs(tx * _axesB[bj] + ty * _axesB[bj + 1] + tz * _axesB[bj + 2]);
    if (dist > ra + rb) return false;
  }

  for (let i = 0; i < 3; i += 1) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j += 1) {
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const ra = _halfA[i1] * _absR[i2 * 3 + j] + _halfA[i2] * _absR[i1 * 3 + j];
      const rb = _halfB[j1] * _absR[i * 3 + j2] + _halfB[j2] * _absR[i * 3 + j1];
      const dist = Math.abs(_tA[i2] * _mat[i1 * 3 + j] - _tA[i1] * _mat[i2 * 3 + j]);
      if (dist > ra + rb) return false;
    }
  }

  return true;
}

/**
 * Calcula la AABB envolvente en mundo de un conjunto de cajas locales transformadas.
 * Soporta tanto `THREE.Box3` directos como entradas compuestas `{ box, localPos, localQuat }`.
 */
export function computeTransformedWorldBox(localBoxes, pos, quat) {
  const unitScale = new THREE.Vector3(1, 1, 1);
  const mat = new THREE.Matrix4().compose(pos, quat, unitScale);
  const subPos = new THREE.Vector3();
  const subQuat = new THREE.Quaternion();
  const subMat = new THREE.Matrix4();
  const out = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const entry of localBoxes) {
    if (entry.box) {
      subPos.copy(entry.localPos).applyQuaternion(quat).add(pos);
      subQuat.copy(quat).multiply(entry.localQuat);
      subMat.compose(subPos, subQuat, unitScale);
      tmp.copy(entry.box).applyMatrix4(subMat);
    } else {
      tmp.copy(entry).applyMatrix4(mat);
    }
    out.union(tmp);
  }
  return out;
}

function anyBoxPairOverlaps(boxesA, posA, quatA, boxesB, posB, quatB, tolerance) {
  for (const boxA of boxesA) {
    for (const boxB of boxesB) {
      if (obbOverlap(boxA, posA, quatA, boxB, posB, quatB, tolerance)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Devuelve la lista de piezas colocadas que colisionan con la pieza candidata en `(pos, quat)`.
 * `ignoreMesh` puede ser un Object3D o un `Set` de Object3Ds (para grupos temporales).
 * `candidateMeshData` puede ser el BVH de una pieza o un array de miembros de grupo.
 */
export function findCollidingPieces(
  candidateBoxes,
  candidatePos,
  candidateQuat,
  placedPieces,
  ignoreMesh = null,
  tolerance = 0.052,
  candidateMeshData = null
) {
  const hits = [];
  if (!candidateBoxes?.length || !placedPieces?.length) return hits;
  const isIgnored = (mesh) =>
    ignoreMesh instanceof Set ? ignoreMesh.has(mesh) : mesh === ignoreMesh;

  const candidateWorldBox = computeTransformedWorldBox(
    candidateBoxes,
    candidatePos,
    candidateQuat
  );
  const groupMembers = Array.isArray(candidateMeshData) ? candidateMeshData : null;
  let preparedMembers = null;

  for (const piece of placedPieces) {
    if (isIgnored(piece.mesh)) continue;
    if (piece.worldBox && !candidateWorldBox.intersectsBox(piece.worldBox)) {
      continue;
    }

    const boxesB = piece.mesh.userData.collisionBoxes || [piece.localBox];
    const placedBvh = piece.mesh.userData?.collisionMeshData;
    let hitPiece = false;

    if (groupMembers?.length) {
      if (!preparedMembers) {
        preparedMembers = groupMembers.map((member) => {
          const mPos = member.localPos.clone().applyQuaternion(candidateQuat).add(candidatePos);
          const mQuat = candidateQuat.clone().multiply(member.localQuat);
          const mBounds = member.boundsBox
            ? computeTransformedWorldBox([member.boundsBox], mPos, mQuat)
            : computeTransformedWorldBox(member.collisionBoxes || [], mPos, mQuat);
          return { member, pos: mPos, quat: mQuat, worldBox: mBounds };
        });
      }

      for (const item of preparedMembers) {
        if (piece.worldBox && !item.worldBox.intersectsBox(piece.worldBox)) {
          continue;
        }
        const member = item.member;
        const memberBoxes = member.collisionBoxes || [];
        if (
          !anyBoxPairOverlaps(
            memberBoxes,
            item.pos,
            item.quat,
            boxesB,
            piece.mesh.position,
            piece.mesh.quaternion,
            tolerance
          )
        ) {
          continue;
        }
        if (member.collisionMeshData?.bvh && placedBvh?.bvh) {
          if (
            checkMeshBvhCollision(
              member.collisionMeshData,
              item.pos,
              item.quat,
              placedBvh,
              piece.mesh.position,
              piece.mesh.quaternion
            )
          ) {
            hitPiece = true;
            break;
          }
        } else {
          hitPiece = true;
          break;
        }
      }
    } else {
      for (const entryA of candidateBoxes) {
        const boxA = entryA.box || entryA;
        let posA = candidatePos;
        let quatA = candidateQuat;
        if (entryA.box) {
          _subPos.copy(entryA.localPos).applyQuaternion(candidateQuat).add(candidatePos);
          _subQuat.copy(candidateQuat).multiply(entryA.localQuat);
          posA = _subPos;
          quatA = _subQuat;
        }

        if (
          anyBoxPairOverlaps(
            [boxA],
            posA,
            quatA,
            boxesB,
            piece.mesh.position,
            piece.mesh.quaternion,
            tolerance
          )
        ) {
          hitPiece = true;
          break;
        }
      }

      // Fase 2 (Narrowphase): si la pieza usa malla LDraw curva/irregular y OBB dio contacto,
      // refinamos con triángulos reales (BVH) para evitar falsos choques por escalones de voxeles.
      if (hitPiece && candidateMeshData?.bvh && placedBvh?.bvh) {
        hitPiece = checkMeshBvhCollision(
          candidateMeshData,
          candidatePos,
          candidateQuat,
          placedBvh,
          piece.mesh.position,
          piece.mesh.quaternion
        );
      }
    }

    if (hitPiece) hits.push(piece);
  }
  return hits;
}

/**
 * Verifica si una pieza candidata en `(pos, quat)` colisiona con alguna pieza colocada.
 */
export function checkPieceCollision(
  candidateBoxes,
  candidatePos,
  candidateQuat,
  placedPieces,
  ignoreMesh = null,
  tolerance = 0.052,
  candidateMeshData = null
) {
  return (
    findCollidingPieces(
      candidateBoxes,
      candidatePos,
      candidateQuat,
      placedPieces,
      ignoreMesh,
      tolerance,
      candidateMeshData
    ).length > 0
  );
}
