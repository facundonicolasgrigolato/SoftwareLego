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
