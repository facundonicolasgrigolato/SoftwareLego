import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  computeSnappedPlacementY,
  computeStudCoordParityOffset,
  computeStudParityOffset,
  computeSupportDistanceAlongDir,
  computeSupportedSurfaceY,
  computeSurfaceY,
  computeWallParityOffset,
  snapAngle,
  snapNormalToCardinal,
  snapToReferenceCoord,
  snapXZ,
} from "../src/builder/gridSnap.js";

test("snapNormalToCardinal y snapToReferenceCoord alinean piezas en studs laterales", () => {
  assert.deepEqual(snapNormalToCardinal(-0.92, 0.1, 0.2), { x: -1, y: 0, z: 0 });
  assert.deepEqual(snapNormalToCardinal(0.1, 0.95, -0.1), { x: 0, y: 1, z: 0 });
  // Stud lateral en z=10, pieza 1x4 con refStud en +10 -> origen en múltiplos de 20
  assert.equal(snapToReferenceCoord(13, 10, 10, 20), 20);
  assert.equal(snapToReferenceCoord(-4, 10, 10, 20), 0);
});

test("computeStudCoordParityOffset alinea studs reales aunque haya salientes laterales", () => {
  // Bracket 44728: stud superior en x=+-10, z=0 -> offsetX=0, offsetZ=10
  assert.equal(computeStudCoordParityOffset(10), 0);
  assert.equal(computeStudCoordParityOffset(0), 10);
  assert.equal(computeStudCoordParityOffset(-20), 10);
});

test("computeWallParityOffset alinea tanto simétricas (1x6) como desplazadas (3660)", () => {
  assert.equal(computeWallParityOffset(-10), 10);  // 1x6 lado impar (-10..+10)
  assert.equal(computeWallParityOffset(-60), 0);   // 1x6 lado par (-60..+60)
  assert.equal(computeWallParityOffset(-30), 10);  // 3660 Slope Inverted 2x2 (-30..+10)
  assert.equal(computeWallParityOffset(-20), 0);   // 2x4 / 3660 ancho (-20..+20)
  assert.equal(computeWallParityOffset(-14), 10);  // Bracket 44728 (-14..+10)
});

test("computeStudParityOffset devuelve 10 LDU para anchos impares y 0 para pares", () => {
  assert.equal(computeStudParityOffset(20), 10); // 1 stud
  assert.equal(computeStudParityOffset(40), 0);  // 2 studs
  assert.equal(computeStudParityOffset(60), 10); // 3 studs
  assert.equal(computeStudParityOffset(120), 0); // 6 studs
  assert.equal(computeStudParityOffset(280), 0); // 14 studs
});

test("snapXZ alinea pieza 1x6 (impar x par) sobre studs de pieza 2x14 (par x par)", () => {
  // 2x14 centrada en (0, 0) tiene studs en x = ..., -30, -10, +10, +30, ...
  const pos2x14 = snapXZ(4, -3, { offsetX: 0, offsetZ: 0 });
  assert.deepEqual(pos2x14, { x: 0, z: 0 });

  // 1x6 orientada a lo largo de Z tiene 1 stud en X (offsetX=10) y 6 en Z (offsetZ=0):
  // su stud en X queda en x=10, -10, +30, coincidiendo exacto con los studs de la 2x14
  const pos1x6 = snapXZ(11, 2, { offsetX: 10, offsetZ: 0 });
  assert.deepEqual(pos1x6, { x: 10, z: 0 });

  // En modo fino (10 LDU) permite colocar tanto sobre studs como entre medio
  assert.deepEqual(snapXZ(19, -29, { fineGrid: true }), { x: 20, z: -30 });
});

test("computeSurfaceY ignora la altura del stud (4 LDU) al apilar", () => {
  assert.equal(computeSurfaceY(0, true), 0);
  assert.equal(computeSurfaceY(24, false), 24);
  assert.equal(computeSurfaceY(28, false), 24); // Punta de stud de brick 1x1
  assert.equal(computeSurfaceY(12, false), 8); // Punta de stud de plate 1x1
});

test("computeSnappedPlacementY apoya la base local sobre surfaceY y permite brackets colgantes", () => {
  assert.equal(computeSnappedPlacementY(0, -24), 24);
  assert.equal(computeSnappedPlacementY(24, -24), 48);
  assert.equal(computeSnappedPlacementY(24, -8), 32);
  // Bracket 44728: localMinY = -40, supportUndersideY = -8 sobre Brick (surfaceY=32) -> Y=40
  assert.equal(computeSnappedPlacementY(32, -40, 0, -8), 40);
  assert.equal(computeSnappedPlacementY(0, -40, 0, -8), 40);
});

test("snapAngle normaliza rotaciones en [0, 2*PI)", () => {
  const halfPi = Math.PI / 2;
  assert.ok(Math.abs(snapAngle(halfPi * 4) - 0) < 1e-6);
  assert.ok(Math.abs(snapAngle(-halfPi) - halfPi * 3) < 1e-6);
});

test("computeSupportDistanceAlongDir y snapToReferenceCoord soportan grosores exactos y desfases 0.20 / 0.50", () => {
  const brick1x1 = [new THREE.Box3(new THREE.Vector3(-10, -24, -10), new THREE.Vector3(10, 0, 10))];
  const qUp = new THREE.Quaternion();
  const qSideX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);

  // Brick normal en +Y apoya a 24 LDU; girado 90° apoya sobre su costado de ancho 10 LDU en +Y y 24 LDU en +X
  assert.ok(Math.abs(computeSupportDistanceAlongDir(brick1x1, qUp, new THREE.Vector3(0, 1, 0)) - 24) < 1e-6);
  assert.ok(Math.abs(computeSupportDistanceAlongDir(brick1x1, qSideX, new THREE.Vector3(0, 1, 0)) - 10) < 1e-6);
  assert.ok(Math.abs(computeSupportDistanceAlongDir(brick1x1, qSideX, new THREE.Vector3(1, 0, 0)) - 24) < 1e-6);

  // Plate 1x4 sobre stud desplazado 4 LDU (0.20 studs en z=+14) con receptor en -30 -> alinea exacto en +14
  const snappedBracket = snapToReferenceCoord(6, -30, 14, 20);
  assert.equal(snappedBracket, 4); // receptores en 4 + [-30,-10,10,30] = [-26,-6,+14,+34]

  // Grupo compuesto: caja inferior en localPos(0,-8,0) + superior en localPos(0,+8,0)
  const plateBox = new THREE.Box3(new THREE.Vector3(-20, -8, -10), new THREE.Vector3(20, 0, 10));
  const comp = [
    { box: plateBox, localPos: new THREE.Vector3(0, 0, 0), localQuat: qUp },
    { box: plateBox, localPos: new THREE.Vector3(0, 8, 0), localQuat: qUp },
  ];
  assert.ok(Math.abs(computeSupportDistanceAlongDir(comp, qUp, new THREE.Vector3(0, 1, 0)) - 8) < 1e-6);
});

test("computeSupportedSurfaceY evita piezas flotando por tocar solo una esquina", () => {
  const placed = [
    // Cabeza alta en [0..40, 0..80, 0..40]
    { minX: 0, maxX: 40, minY: 0, maxY: 80, minZ: 0, maxZ: 40 },
    // Base más ancha en [-20..60, 0..8, -20..60]
    { minX: -20, maxX: 60, minY: 0, maxY: 8, minZ: -20, maxZ: 60 },
  ];

  // Pieza fuera de la esquina alta (solo roza en x=40 por 0 LDU) -> cae al soporte real debajo (y=8)
  assert.equal(computeSupportedSurfaceY(40, 60, 20, 40, placed, 82, 4), 8);
  // Pieza aún más afuera de toda base -> cae a la mesa (y=0)
  assert.equal(computeSupportedSurfaceY(60, 80, 20, 40, placed, 82, 4), 0);
  // Pieza apoyada claramente encima del bloque alto (solapa 20x20 LDU) -> queda en y=80
  assert.equal(computeSupportedSurfaceY(20, 40, 20, 40, placed, 82, 4), 80);
});
