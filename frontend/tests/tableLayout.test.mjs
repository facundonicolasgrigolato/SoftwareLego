import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { computeTableLayout } from "../src/core/tableLayout.js";
import { MAX_SUPPORTED_PIECES } from "../src/core/constants.js";
import { PilePhysics } from "../src/physics/pilePhysics.js";

test("computeTableLayout mantiene buildZone 800x800 compatible para sets chicos (1 bolsa)", () => {
  const layout = computeTableLayout({
    stats: { resolved_pieces: 123 },
    bags: [{ bag_number: 1, label: "Bolsa 1", piece_count: 123 }],
  });
  assert.equal(layout.buildZone.minX, -120);
  assert.equal(layout.buildZone.width, 800);
  assert.equal(layout.buildZone.depth, 800);
  assert.equal(layout.bagZones.length, 1);
  assert.ok(layout.bagZones[0].maxX < layout.buildZone.minX);
});

test("computeTableLayout dispone 3 bolsas en 2 columnas a la izquierda sin superposición", () => {
  const layout = computeTableLayout({
    stats: { resolved_pieces: 420 },
    bags: [
      { bag_number: 1, label: "Bolsa 1", piece_count: 140 },
      { bag_number: 2, label: "Bolsa 2", piece_count: 140 },
      { bag_number: 3, label: "Bolsa 3", piece_count: 140 },
    ],
  });
  assert.equal(layout.bagZones.length, 3);
  const [b1, b2, b3] = layout.bagZones;
  assert.equal(b1.col, 0);
  assert.equal(b2.col, 0);
  assert.equal(b3.col, 1);
  assert.ok(b2.minZ > b1.maxZ);
  assert.ok(b3.maxX < b1.minX);
  assert.ok(layout.buildZone.width >= 1000);
});

test("computeTableLayout escala mesa grande para 12 bolsas (10352)", () => {
  const bags = Array.from({ length: 12 }, (_, i) => ({
    bag_number: i + 1,
    label: `Bolsa ${i + 1}`,
    piece_count: 136,
  }));
  const layout = computeTableLayout({
    stats: { resolved_pieces: 1637 },
    bags,
    table_layout: { build_zone: { width_ldu: 1400, depth_ldu: 1200 } },
  });
  assert.equal(layout.buildZone.width, 1400);
  assert.equal(layout.buildZone.depth, 1200);
  assert.equal(layout.bagZones.length, 12);
  // Verificamos que ninguna bolsa se solapa con otra ni con la Mesa de Juego
  for (let i = 0; i < layout.bagZones.length; i += 1) {
    const a = layout.bagZones[i];
    assert.ok(a.maxX < layout.buildZone.minX);
    for (let j = i + 1; j < layout.bagZones.length; j += 1) {
      const b = layout.bagZones[j];
      const overlapX = a.minX < b.maxX && a.maxX > b.minX;
      const overlapZ = a.minZ < b.maxZ && a.maxZ > b.minZ;
      assert.equal(overlapX && overlapZ, false);
    }
  }
});

test("MAX_SUPPORTED_PIECES define límite seguro de piezas 3D", () => {
  assert.equal(MAX_SUPPORTED_PIECES, 3500);
});

test("PilePhysics contiene piezas dentro de su caja ante impulsos extremos", () => {
  const physics = new PilePhysics();
  const bz = { bagNumber: 1, minX: -480, maxX: -200, minZ: -180, maxZ: 180 };
  physics.setBagZones([bz]);

  const mesh = new THREE.Group();
  const localBox = new THREE.Box3(
    new THREE.Vector3(-10, -24, -10),
    new THREE.Vector3(10, 4, 10)
  );
  const entry = physics.addPiece("p1", "e1", mesh, localBox, null, false, 1);

  entry.body.wakeUp();
  entry.body.velocity.set(-5000, 3000, 5000);
  for (let i = 0; i < 15; i += 1) {
    physics.step(1 / 30);
    assert.ok(entry.body.position.x >= bz.minX && entry.body.position.x <= bz.maxX);
    assert.ok(entry.body.position.z >= bz.minZ && entry.body.position.z <= bz.maxZ);
    assert.ok(entry.body.position.y >= 0 && entry.body.position.y <= 220);
  }
});
