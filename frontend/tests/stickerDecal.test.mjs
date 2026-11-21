import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { computeFaceStickerPlacement } from "../src/builder/stickerDecal.js";
import { serializeBuildState } from "../src/builder/storage.js";

function makeBrickWithStudMesh() {
  const root = new THREE.Group();
  const bodyGeom = new THREE.BoxGeometry(40, 24, 40);
  bodyGeom.translate(0, 12, 0);
  const body = new THREE.Mesh(bodyGeom, new THREE.MeshBasicMaterial());
  root.add(body);

  // Stud sobresaliendo por encima (y = 24..28) para verificar que la cara superior lo ignora
  const studGeom = new THREE.BoxGeometry(12, 4, 12);
  studGeom.translate(0, 26, 0);
  const stud = new THREE.Mesh(studGeom, new THREE.MeshBasicMaterial());
  root.add(stud);

  root.updateMatrixWorld(true);
  const localBox = new THREE.Box3(
    new THREE.Vector3(-20, 0, -20),
    new THREE.Vector3(20, 28, 20)
  );
  return { root, localBox };
}

test("computeFaceStickerPlacement genera 6 faceKey distintos y ajusta solo la cara clickeada", () => {
  const { root, localBox } = makeBrickWithStudMesh();
  const faces = [
    { name: "front", pt: new THREE.Vector3(0, 12, -20), n: new THREE.Vector3(0, 0, -1), w: 39.6, h: 23.6 },
    { name: "back", pt: new THREE.Vector3(0, 12, 20), n: new THREE.Vector3(0, 0, 1), w: 39.6, h: 23.6 },
    { name: "left", pt: new THREE.Vector3(-20, 12, 0), n: new THREE.Vector3(-1, 0, 0), w: 39.6, h: 23.6 },
    { name: "right", pt: new THREE.Vector3(20, 12, 0), n: new THREE.Vector3(1, 0, 0), w: 39.6, h: 23.6 },
    { name: "top", pt: new THREE.Vector3(12, 24, 12), n: new THREE.Vector3(0, 1, 0), w: 39.6, h: 39.6 },
    { name: "bottom", pt: new THREE.Vector3(0, 0, 0), n: new THREE.Vector3(0, -1, 0), w: 39.6, h: 39.6 },
  ];

  const keys = new Set();
  for (const f of faces) {
    const res = computeFaceStickerPlacement({
      pieceMesh: root,
      localBox,
      worldPoint: f.pt,
      worldNormal: f.n,
    });
    keys.add(res.faceKey);
    assert.ok(Math.abs(res.width - f.w) < 0.2, `${f.name} width=${res.width}`);
    assert.ok(Math.abs(res.height - f.h) < 0.2, `${f.name} height=${res.height}`);

    const u = new THREE.Vector3(res.uAxis.x, res.uAxis.y, res.uAxis.z);
    const v = new THREE.Vector3(res.vAxis.x, res.vAxis.y, res.vAxis.z);
    const n = new THREE.Vector3(res.normal.x, res.normal.y, res.normal.z);
    const cross = new THREE.Vector3().crossVectors(u, v);
    assert.ok(cross.distanceTo(n) < 1e-4, `base mano derecha válida en ${f.name}`);
  }
  assert.equal(keys.size, 6);
});

test("computeFaceStickerPlacement mantiene orientación vertical al rotar la pieza", () => {
  const { root, localBox } = makeBrickWithStudMesh();
  root.rotation.set(0, Math.PI / 2, 0);
  root.position.set(40, 0, 20);
  root.updateMatrixWorld(true);

  const worldNormal = new THREE.Vector3(0, 0, 1);
  const worldPoint = new THREE.Vector3(40, 12, 40);
  const res = computeFaceStickerPlacement({
    pieceMesh: root,
    localBox,
    worldPoint,
    worldNormal,
  });

  // vAxis en espacio mundo debe apuntar hacia +Y (arriba para el usuario)
  const vWorld = new THREE.Vector3(res.vAxis.x, res.vAxis.y, res.vAxis.z)
    .transformDirection(root.matrixWorld)
    .normalize();
  assert.ok(vWorld.y > 0.99);
});

test("serializeBuildState conserva stickers aplicados por cara", () => {
  const { root } = makeBrickWithStudMesh();
  const state = serializeBuildState("40858", [
    {
      instanceId: "p_1",
      elementId: "6253187",
      mesh: root,
      stickers: [{ faceKey: "0,0,-1@-20", dataUrl: "data:image/png;base64,abc" }],
    },
  ]);
  assert.equal(state.pieces.length, 1);
  assert.equal(state.pieces[0].stickers.length, 1);
  assert.equal(state.pieces[0].stickers[0].faceKey, "0,0,-1@-20");
});
