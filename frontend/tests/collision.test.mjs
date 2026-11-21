import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { checkPieceCollision, obbOverlap } from "../src/builder/collision.js";

test("obbOverlap permite piezas apiladas o adyacentes sin falso positivo", () => {
  const plate = new THREE.Box3(
    new THREE.Vector3(-40, -8, -20),
    new THREE.Vector3(40, 0, 20)
  );
  const brick = new THREE.Box3(
    new THREE.Vector3(-40, -24, -20),
    new THREE.Vector3(40, 0, 20)
  );
  const q = new THREE.Quaternion();

  // Plate en y=8 (ocupa 0..8), brick en y=32 (ocupa 8..32) -> tocan en y=8 sin invadirse
  assert.equal(
    obbOverlap(plate, new THREE.Vector3(0, 8, 0), q, brick, new THREE.Vector3(0, 32, 0), q),
    false
  );

  // Brick movido dentro del plate (y=16 -> ocupa -8..16) -> colisiona
  assert.equal(
    obbOverlap(plate, new THREE.Vector3(0, 8, 0), q, brick, new THREE.Vector3(0, 16, 0), q),
    true
  );
});

test("checkPieceCollision permite encastrar piezas dentro del hueco L de un bracket 44728", () => {
  // Bracket en y=40: pestaña superior en y=[32..40], faldón vertical en z=[-14..-10], y=[0..32]
  const bracketBoxes = [
    new THREE.Box3(new THREE.Vector3(-20, -8, -14), new THREE.Vector3(20, 0, 10)),
    new THREE.Box3(new THREE.Vector3(-20, -40, -14), new THREE.Vector3(20, -8, -10)),
  ];
  const q = new THREE.Quaternion();
  const placed = [
    {
      mesh: {
        position: new THREE.Vector3(0, 40, 0),
        quaternion: q,
        userData: { collisionBoxes: bracketBoxes },
      },
    },
  ];

  // Ladrillo blanco debajo de la pestaña superior (y=[8..32], z=[-10..+30]) -> NO choca
  const whiteBrick = [
    new THREE.Box3(new THREE.Vector3(-20, -24, -20), new THREE.Vector3(20, 0, 20)),
  ];
  assert.equal(
    checkPieceCollision(whiteBrick, new THREE.Vector3(0, 32, 10), q, placed),
    false
  );

  // Placa gris 1x4 pegada al frente del faldón (z=[-22..-14], y=[0..20]) -> NO choca
  const frontPlate = [
    new THREE.Box3(new THREE.Vector3(-40, -8, -10), new THREE.Vector3(40, 0, 10)),
  ];
  const qFront = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  assert.equal(
    checkPieceCollision(frontPlate, new THREE.Vector3(0, 10, -22), qFront, placed),
    false
  );

  // Placa metida dentro del faldón (z=[-15..-7]) -> SÍ choca
  assert.equal(
    checkPieceCollision(frontPlate, new THREE.Vector3(0, 10, -15), qFront, placed),
    true
  );
});

test("obbOverlap tolera margen proporcional ~10% pero bloquea invasiones y protege anillos finos (4081b)", () => {
  const plateA = new THREE.Box3(
    new THREE.Vector3(-40, -8, -10),
    new THREE.Vector3(40, 0, 10)
  );
  const plateB = new THREE.Box3(
    new THREE.Vector3(-40, -8, -10),
    new THREE.Vector3(40, 0, 10)
  );
  const q = new THREE.Quaternion();

  // Roce marginal de 2 LDU en Z (10% del ancho de 20 LDU: centros a 18 LDU) -> permitido
  assert.equal(
    obbOverlap(plateA, new THREE.Vector3(0, 8, 0), q, plateB, new THREE.Vector3(0, 8, 18), q),
    false
  );

  // Solapamiento del 20% (4 LDU: centros a 16 LDU) -> bloqueado
  assert.equal(
    obbOverlap(plateA, new THREE.Vector3(0, 8, 0), q, plateB, new THREE.Vector3(0, 8, 16), q),
    true
  );

  // Anillo fino 4081b de 8 LDU de espesor (X=[-4..+4], Z=[+10..+30]):
  // Un brick 1x1 (X=[-10..+10]) apoyado al ras en X=+14 (ocupa [+4..+24]) NO choca,
  // pero metido dentro del anillo (X=+10 -> ocupa [0..+20]) SÍ choca.
  const ring4081b = [
    new THREE.Box3(new THREE.Vector3(-4, -10, 12), new THREE.Vector3(4, 6, 28)),
  ];
  const brick1x1 = [
    new THREE.Box3(new THREE.Vector3(-10, -24, -10), new THREE.Vector3(10, 0, 10)),
  ];
  const placedRing = [
    {
      mesh: {
        position: new THREE.Vector3(0, 8, 0),
        quaternion: q,
        userData: { collisionBoxes: ring4081b },
      },
    },
  ];
  assert.equal(
    checkPieceCollision(brick1x1, new THREE.Vector3(14, 14, 20), q, placedRing),
    false
  );
  assert.equal(
    checkPieceCollision(brick1x1, new THREE.Vector3(10, 14, 20), q, placedRing),
    true
  );
});

test("findCollidingPieces y checkPieceCollision soportan grupos compuestos y ignoreSet", () => {
  const plateBox = new THREE.Box3(
    new THREE.Vector3(-20, -8, -10),
    new THREE.Vector3(20, 0, 10)
  );
  const q = new THREE.Quaternion();
  const q90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const meshA = { position: new THREE.Vector3(0, 8, 0), quaternion: q, userData: { collisionBoxes: [plateBox] } };
  const meshB = { position: new THREE.Vector3(10, 16, 0), quaternion: q90, userData: { collisionBoxes: [plateBox] } };
  const meshWall = { position: new THREE.Vector3(60, 24, 0), quaternion: q, userData: { collisionBoxes: [plateBox] } };
  const placed = [
    { mesh: meshA, localBox: plateBox },
    { mesh: meshB, localBox: plateBox },
    { mesh: meshWall, localBox: plateBox },
  ];

  // Grupo compuesto por meshA (en 0,0,0) y meshB (en 10,8,0 rotado 90°), ignorando el propio grupo
  const groupBoxes = [
    { box: plateBox, localPos: new THREE.Vector3(0, 0, 0), localQuat: q },
    { box: plateBox, localPos: new THREE.Vector3(10, 8, 0), localQuat: q90 },
  ];
  const ignoreSet = new Set([meshA, meshB]);

  // En (0, 8, 0) no choca consigo mismo ni con meshWall en X=60
  assert.equal(
    checkPieceCollision(groupBoxes, new THREE.Vector3(0, 8, 0), q, placed, ignoreSet),
    false
  );
  // Movido a (45, 24, 0) choca contra meshWall en (60, 24, 0)
  assert.equal(
    checkPieceCollision(groupBoxes, new THREE.Vector3(45, 24, 0), q, placed, ignoreSet),
    true
  );
});
