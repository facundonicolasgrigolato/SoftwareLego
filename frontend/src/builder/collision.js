import * as THREE from "three";
import { checkMeshBvhCollision } from "./meshCollision.js";

const UNIT_X = new THREE.Vector3(1, 0, 0);
const UNIT_Y = new THREE.Vector3(0, 1, 0);
const UNIT_Z = new THREE.Vector3(0, 0, 1);

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

/**
 * Construye los datos de un OBB (Oriented Bounding Box) en espacio mundo a partir
 * de una caja local `Box3`, posición, cuaternión y tolerancia proporcional (~10%).
 */
function toWorldOBB(localBox, pos, quat, tolerance) {
  const sx = Math.max(0.5, localBox.max.x - localBox.min.x);
  const sy = Math.max(0.5, localBox.max.y - localBox.min.y);
  const sz = Math.max(0.5, localBox.max.z - localBox.min.z);
  const half = new THREE.Vector3(
    Math.max(0.25, sx * 0.5 - computeAxisMargin(sx, tolerance)),
    Math.max(0.25, sy * 0.5 - computeAxisMargin(sy, tolerance)),
    Math.max(0.25, sz * 0.5 - computeAxisMargin(sz, tolerance))
  );
  const center = new THREE.Vector3(
    (localBox.min.x + localBox.max.x) * 0.5,
    (localBox.min.y + localBox.max.y) * 0.5,
    (localBox.min.z + localBox.max.z) * 0.5
  )
    .applyQuaternion(quat)
    .add(pos);

  const axes = [
    UNIT_X.clone().applyQuaternion(quat),
    UNIT_Y.clone().applyQuaternion(quat),
    UNIT_Z.clone().applyQuaternion(quat),
  ];

  return { center, half, axes };
}

/**
 * Test exacto OBB vs OBB mediante Teorema de Ejes Separadores (SAT).
 * Usa tolerancia proporcional por defecto (`0.052` por cara ≈ `10%` entre piezas)
 * respetando geometrías delgadas como faldones de brackets (4 LDU) o clips (8 LDU).
 */
export function obbOverlap(boxA, posA, quatA, boxB, posB, quatB, tolerance = 0.052) {
  const a = toWorldOBB(boxA, posA, quatA, tolerance);
  const b = toWorldOBB(boxB, posB, quatB, tolerance);

  const t = new THREE.Vector3().subVectors(b.center, a.center);
  const R = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  // Calculamos la matriz de rotación relativa R[i][j] = a.axes[i] · b.axes[j]
  const absR = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const mat = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const EPS = 1e-6;

  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const dot = a.axes[i].dot(b.axes[j]);
      mat[i][j] = dot;
      absR[i][j] = Math.abs(dot) + EPS;
    }
  }

  const tA = [t.dot(a.axes[0]), t.dot(a.axes[1]), t.dot(a.axes[2])];
  const halfA = [a.half.x, a.half.y, a.half.z];
  const halfB = [b.half.x, b.half.y, b.half.z];

  // 3 ejes de A
  for (let i = 0; i < 3; i += 1) {
    const ra = halfA[i];
    const rb = halfB[0] * absR[i][0] + halfB[1] * absR[i][1] + halfB[2] * absR[i][2];
    if (Math.abs(tA[i]) > ra + rb) return false;
  }

  // 3 ejes de B
  for (let j = 0; j < 3; j += 1) {
    const ra = halfA[0] * absR[0][j] + halfA[1] * absR[1][j] + halfA[2] * absR[2][j];
    const rb = halfB[j];
    const dist = Math.abs(t.dot(b.axes[j]));
    if (dist > ra + rb) return false;
  }

  // 9 productos cruzados Ai x Bj
  for (let i = 0; i < 3; i += 1) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j += 1) {
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const ra = halfA[i1] * absR[i2][j] + halfA[i2] * absR[i1][j];
      const rb = halfB[j1] * absR[i][j2] + halfB[j2] * absR[i][j1];
      const dist = Math.abs(tA[i2] * mat[i1][j] - tA[i1] * mat[i2][j]);
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

/**
 * Devuelve la lista de piezas colocadas que colisionan con la pieza candidata en `(pos, quat)`.
 * `ignoreMesh` puede ser un Object3D o un `Set` de Object3Ds (para grupos temporales).
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
  const subPos = new THREE.Vector3();
  const subQuat = new THREE.Quaternion();

  for (const piece of placedPieces) {
    if (isIgnored(piece.mesh)) continue;
    if (piece.worldBox && !candidateWorldBox.intersectsBox(piece.worldBox)) {
      continue;
    }

    const boxesB = piece.mesh.userData.collisionBoxes || [piece.localBox];
    let hitPiece = false;
    for (const entryA of candidateBoxes) {
      const boxA = entryA.box || entryA;
      let posA = candidatePos;
      let quatA = candidateQuat;
      if (entryA.box) {
        subPos.copy(entryA.localPos).applyQuaternion(candidateQuat).add(candidatePos);
        subQuat.copy(candidateQuat).multiply(entryA.localQuat);
        posA = subPos;
        quatA = subQuat;
      }

      for (const boxB of boxesB) {
        if (
          obbOverlap(
            boxA,
            posA,
            quatA,
            boxB,
            piece.mesh.position,
            piece.mesh.quaternion,
            tolerance
          )
        ) {
          hitPiece = true;
          break;
        }
      }
      if (hitPiece) break;
    }

    // Fase 2 (Narrowphase): si la pieza usa malla LDraw curva/irregular y OBB dio contacto,
    // refinamos con triángulos reales (BVH) para evitar falsos choques por escalones de voxeles.
    if (
      hitPiece &&
      candidateMeshData?.bvh &&
      piece.mesh.userData?.collisionMeshData?.bvh
    ) {
      hitPiece = checkMeshBvhCollision(
        candidateMeshData,
        candidatePos,
        candidateQuat,
        piece.mesh.userData.collisionMeshData,
        piece.mesh.position,
        piece.mesh.quaternion
      );
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
