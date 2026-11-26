import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { LDrawService } from "../src/core/ldrawService.js";
import { BatchedPieceLayer } from "../src/core/batchedPieceLayer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const LDRAW_ROOT = path.join(ROOT_DIR, "data", "ldraw", "ldraw");

function withLocalLDraw(run) {
  const prevFetch = globalThis.fetch;
  const prevProgressEvent = globalThis.ProgressEvent;
  globalThis.ProgressEvent = class {
    constructor(type, opts) {
      Object.assign(this, opts);
    }
  };
  globalThis.fetch = async (req) => {
    const url = typeof req === "string" ? req : req.url;
    const pathname = new URL(url).pathname;
    if (!pathname.startsWith("/ldraw/")) return new Response("Not Found", { status: 404 });
    const full = path.join(LDRAW_ROOT, pathname.slice("/ldraw/".length));
    if (!full.startsWith(LDRAW_ROOT) || !fs.existsSync(full)) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(fs.readFileSync(full), { status: 200 });
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = prevFetch;
      if (prevProgressEvent === undefined) delete globalThis.ProgressEvent;
      else globalThis.ProgressEvent = prevProgressEvent;
    });
}

test("BatchedPieceLayer agrupa proxies LDraw, soporta raycast, visibilidad, resize y makeGhostClone", async (t) => {
  if (!fs.existsSync(path.join(LDRAW_ROOT, "LDConfig.ldr"))) {
    t.skip("Biblioteca local LDraw no presente en data/ldraw/ldraw");
    return;
  }

  await withLocalLDraw(async () => {
    const svc = new LDrawService();
    svc.loader.setPartsLibraryPath("http://localhost/ldraw/");
    svc._materialsReady = svc.loader.preloadMaterials("http://localhost/ldraw/LDConfig.ldr");

    // Forzamos capacidad inicial baja para probar auto-crecimiento en caliente
    const layer = new BatchedPieceLayer({
      castShadow: false,
      receiveShadow: true,
      maxInstances: 2,
      maxMeshVerts: 200,
      maxEdgeVerts: 100,
    });

    const p1 = await svc.createPartInstance(
      { ldraw_part_id: "3003", ldraw_color_code: 14 },
      { lightweight: true, proxyOnly: true }
    );
    const p2 = await svc.createPartInstance(
      { ldraw_part_id: "6541", ldraw_color_code: 0 },
      { lightweight: true, proxyOnly: true }
    );
    const p3 = await svc.createPartInstance(
      { ldraw_part_id: "3003", ldraw_color_code: 14 },
      { lightweight: true, proxyOnly: true }
    );

    assert.equal(p1.group.children.length, 0);
    assert.ok(p1.group.userData.batchedMeshGeo);

    // makeGhostClone sobre un proxy sin hijos debe clonar las mallas reales desde visualTemplateGroup
    const ghost = LDrawService.makeGhostClone(p1.group);
    let ghostMeshes = 0;
    ghost.traverse((c) => {
      if (c.isMesh) ghostMeshes += 1;
    });
    assert.ok(ghostMeshes > 0, "Ghost clonado desde proxy debe tener mallas visibles");

    p1.group.position.set(0, 24, 0);
    p2.group.position.set(100, 24, 0);
    p3.group.position.set(200, 24, 0);

    assert.equal(layer.addPiece(p1.group), true);
    assert.equal(layer.addPiece(p2.group), true);
    assert.equal(layer.addPiece(p3.group), true);
    assert.equal(layer.meshBatch.instanceCount, 3);

    // Raycast directo sobre el BatchedMesh debe identificar exactamente p2 por batchId
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(100, 80, 0),
      new THREE.Vector3(0, -1, 0)
    );
    const hits = [];
    layer.meshBatch.raycast(raycaster, hits);
    assert.ok(hits.length > 0, "Raycast sobre BatchedMesh debe detectar pieza colocada");
    assert.equal(layer.resolveProxyByBatchId(hits[0].batchId), p2.group);

    // Al ocultar p2, raycast ya no la golpea
    layer.setVisible(p2.group, false);
    const hitsHidden = [];
    layer.meshBatch.raycast(raycaster, hitsHidden);
    assert.equal(hitsHidden.length, 0);

    // ensureVisualChildren materializa las mallas reales al promover para pegatina
    p1.group.userData.ensureVisualChildren();
    assert.ok(p1.group.children.length > 0);

    layer.dispose();
  });
});

function countDisagreeingWinding(geo) {
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const vn = new THREE.Vector3();
  let disagree = 0;
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    fn.crossVectors(e1, e2);
    vn.fromBufferAttribute(norm, i);
    if (fn.dot(vn) < 0) disagree += 1;
  }
  return disagree;
}

test("buildBatchedGeometries corrige winding de sub-mallas espejadas (det < 0, 7796 y minifiguras)", async (t) => {
  const wrapper = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x999999 });
  const mirrored = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), mat);
  mirrored.scale.set(-1, 1, 1);
  wrapper.add(mirrored);

  const { batchedMeshGeo } = LDrawService.buildBatchedGeometries(wrapper, false);
  assert.ok(batchedMeshGeo);
  assert.equal(
    countDisagreeingWinding(batchedMeshGeo),
    0,
    "Sub-malla espejada debe mantener triángulos CCW alineados a sus normales"
  );
  batchedMeshGeo.dispose();
  mirrored.geometry.dispose();
  mat.dispose();

  if (!fs.existsSync(path.join(LDRAW_ROOT, "parts", "7796.dat"))) {
    t.skip("Biblioteca local LDraw sin 7796.dat");
    return;
  }

  await withLocalLDraw(async () => {
    const svc = new LDrawService();
    svc.loader.setPartsLibraryPath("http://localhost/ldraw/");
    svc._materialsReady = svc.loader.preloadMaterials("http://localhost/ldraw/LDConfig.ldr");

    const p7796Raw = await svc.createPartInstance({ ldraw_part_id: "7796", ldraw_color_code: 72 });
    let rawDisagree = 0;
    p7796Raw.group.traverse((child) => {
      if (child.isMesh) rawDisagree += countDisagreeingWinding(child.geometry);
    });

    const p7796Batched = await svc.createPartInstance(
      { ldraw_part_id: "7796", ldraw_color_code: 72 },
      { lightweight: true, proxyOnly: true }
    );
    assert.ok(p7796Batched.group.userData.batchedMeshGeo);
    assert.equal(
      countDisagreeingWinding(p7796Batched.group.userData.batchedMeshGeo),
      rawDisagree,
      "Pieza 7796 en batch debe conservar exactamente el winding de todas sus subpartes espejadas"
    );

    for (const partId of ["76382", "37364", "105199"]) {
      const p = await svc.createPartInstance(
        { ldraw_part_id: partId, ldraw_color_code: 14 },
        { lightweight: true, proxyOnly: true }
      );
      const geo = p.group.userData.batchedMeshGeo;
      assert.ok(geo, `${partId} debe generar batchedMeshGeo`);
      assert.equal(
        countDisagreeingWinding(geo),
        0,
        `${partId} no debe tener triángulos con winding invertido`
      );
    }
  });
});
