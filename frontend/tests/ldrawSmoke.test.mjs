import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { LDrawService } from "../src/core/ldrawService.js";
import { checkPieceCollision } from "../src/builder/collision.js";
import { computeTransformedWorldBox } from "../src/builder/collision.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const LDRAW_ROOT = path.join(ROOT_DIR, "data", "ldraw", "ldraw");

function withMockedLDrawFetch(resolverFn, run) {
  const prevFetch = globalThis.fetch;
  const prevProgressEvent = globalThis.ProgressEvent;
  globalThis.ProgressEvent = class {
    constructor(type, opts) {
      Object.assign(this, opts);
    }
  };
  globalThis.fetch = async (req) => {
    const url = typeof req === "string" ? req : req.url;
    const body = resolverFn(new URL(url).pathname);
    if (body == null) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(body, { status: 200 });
  };
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = prevFetch;
      if (prevProgressEvent === undefined) delete globalThis.ProgressEvent;
      else globalThis.ProgressEvent = prevProgressEvent;
    });
}

test("LDrawService carga una pieza inline con saltos LF y CRLF sin errores", async () => {
  const files = {
    "/ldraw/LDConfig.ldr": "0 !COLOUR Yellow CODE 14 VALUE #F2CD37 EDGE #333333\n",
    "/ldraw/parts/99901.dat": [
      "0 Test Brick",
      "3 16 0 0 0 10 0 0 10 0 10",
      "3 16 0 0 0 10 0 10 0 0 10",
    ].join("\r\n"),
  };
  await withMockedLDrawFetch(
    (pathname) => files[pathname] ?? null,
    async () => {
      const svc = new LDrawService();
      svc.loader.setPartsLibraryPath("http://localhost/ldraw/");
      svc._materialsReady = svc.loader.preloadMaterials("http://localhost/ldraw/LDConfig.ldr");
      const res = await svc.createPartInstance({
        element_id: "9990101",
        part_num: "99901",
        part_name: "Test Brick",
        ldraw_part_id: "99901",
        ldraw_color_code: 14,
      });
      assert.ok(res.localBox.max.x >= 9.9);
      assert.ok(res.group.userData.collisionBoxes.length >= 1);
    }
  );
});

test("LDrawService carga piezas locales descargadas sin errores de parseo (24086, 19900, 5443, 3003)", async (t) => {
  if (!fs.existsSync(path.join(LDRAW_ROOT, "LDConfig.ldr"))) {
    t.skip("Biblioteca local LDraw no presente en data/ldraw/ldraw");
    return;
  }
  await withMockedLDrawFetch(
    (pathname) => {
      if (!pathname.startsWith("/ldraw/")) return null;
      const rel = pathname.slice("/ldraw/".length);
      const full = path.join(LDRAW_ROOT, rel);
      if (!full.startsWith(LDRAW_ROOT) || !fs.existsSync(full)) return null;
      return fs.readFileSync(full);
    },
    async () => {
      const svc = new LDrawService();
      svc.loader.setPartsLibraryPath("http://localhost/ldraw/");
      svc._materialsReady = svc.loader.preloadMaterials("http://localhost/ldraw/LDConfig.ldr");
      for (const ldrawId of ["3003", "24086", "19900", "5443"]) {
        if (!fs.existsSync(path.join(LDRAW_ROOT, "parts", `${ldrawId}.dat`))) continue;
        const res = await svc.createPartInstance({
          element_id: `smoke_${ldrawId}`,
          part_num: ldrawId,
          part_name: ldrawId,
          ldraw_part_id: ldrawId,
          ldraw_color_code: 14,
        });
        assert.ok(!res.localBox.isEmpty(), `Box vacía para ${ldrawId}`);
      }
    }
  );
});

test("makeGhostClone mantiene depthWrite, opacidad legible y bordes estructurales visibles", () => {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(20, 24, 20),
    new THREE.MeshStandardMaterial({ color: 0xf2cd37 })
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x111827 })
  );
  edges.visible = true;
  group.add(mesh, edges);

  const ghost = LDrawService.makeGhostClone(group);
  const ghostMesh = ghost.children.find((c) => c.isMesh);
  const ghostEdges = ghost.children.find((c) => c.isLineSegments);

  assert.equal(ghostMesh.material.transparent, true);
  assert.equal(ghostMesh.material.depthWrite, true);
  assert.equal(ghostMesh.material.opacity, 0.78);
  assert.equal(ghostEdges.visible, true);

  LDrawService.setGhostColliding(ghost, true);
  assert.equal(ghostMesh.material.opacity, 0.82);
  assert.equal(ghostEdges.material.opacity, 0.9);
});

test("Colisión 2 fases (OBB + BVH) permite encajar piezas curvas reales (27925 y 79491 alrededor de 18674) y bloquea invasiones", async (t) => {
  if (!fs.existsSync(path.join(LDRAW_ROOT, "LDConfig.ldr"))) {
    t.skip("Biblioteca local LDraw no presente en data/ldraw/ldraw");
    return;
  }
  await withMockedLDrawFetch(
    (pathname) => {
      if (!pathname.startsWith("/ldraw/")) return null;
      const rel = pathname.slice("/ldraw/".length);
      const full = path.join(LDRAW_ROOT, rel);
      if (!full.startsWith(LDRAW_ROOT) || !fs.existsSync(full)) return null;
      return fs.readFileSync(full);
    },
    async () => {
      const svc = new LDrawService();
      svc.loader.setPartsLibraryPath("http://localhost/ldraw/");
      svc._materialsReady = svc.loader.preloadMaterials("http://localhost/ldraw/LDConfig.ldr");

      const disc = await svc.createPartInstance({ ldraw_part_id: "18674", ldraw_color_code: 14 });
      const curve = await svc.createPartInstance({ ldraw_part_id: "27925", ldraw_color_code: 15 });
      const corner = await svc.createPartInstance({ ldraw_part_id: "79491", ldraw_color_code: 72 });
      const brick = await svc.createPartInstance({ ldraw_part_id: "3003", ldraw_color_code: 14 });

      disc.group.position.set(0, 0, 0);
      disc.group.updateMatrixWorld(true);
      const discWorldBox = computeTransformedWorldBox(
        disc.group.userData.collisionBoxes,
        disc.group.position,
        disc.group.quaternion
      );
      const placed = [{ mesh: disc.group, localBox: disc.localBox, worldBox: discWorldBox }];

      // 27925 en rot 270° rodea el disco sin invadirlo -> permitido con colisiones ON
      const q270 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (3 * Math.PI) / 2);
      const g270 = curve.group.clone();
      g270.quaternion.copy(q270);
      g270.updateMatrixWorld(true);
      const b270 = new THREE.Box3().setFromObject(g270);
      const posTangent = new THREE.Vector3(-40 - b270.min.x, 0, 0 - b270.min.z);
      assert.equal(
        checkPieceCollision(
          curve.group.userData.collisionBoxes,
          posTangent,
          q270,
          placed,
          null,
          0.052,
          curve.group.userData.collisionMeshData
        ),
        false
      );

      // 27925 rotado 0° invade el disco amarillo -> bloqueado
      const q0 = new THREE.Quaternion();
      assert.equal(
        checkPieceCollision(
          curve.group.userData.collisionBoxes,
          new THREE.Vector3(-30, 0, 10),
          q0,
          placed,
          null,
          0.052,
          curve.group.userData.collisionMeshData
        ),
        true
      );

      // 79491 (cutout curvo) rodeando esquina opuesta a 180° -> permitido; a 0° -> bloqueado
      const q180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      const g180 = corner.group.clone();
      g180.quaternion.copy(q180);
      g180.updateMatrixWorld(true);
      const b180 = new THREE.Box3().setFromObject(g180);
      assert.equal(
        checkPieceCollision(
          corner.group.userData.collisionBoxes,
          new THREE.Vector3(0 - b180.min.x, 0, -40 - b180.min.z),
          q180,
          placed,
          null,
          0.052,
          corner.group.userData.collisionMeshData
        ),
        false
      );
      const b0Corner = new THREE.Box3().setFromObject(corner.group);
      assert.equal(
        checkPieceCollision(
          corner.group.userData.collisionBoxes,
          new THREE.Vector3(0 - b0Corner.min.x, 0, -40 - b0Corner.min.z),
          q0,
          placed,
          null,
          0.052,
          corner.group.userData.collisionMeshData
        ),
        true
      );

      // Mismo molde exacto superpuesto en (0,0,0) -> bloqueado por inclusión interior
      const brickBox = computeTransformedWorldBox(
        brick.group.userData.collisionBoxes,
        new THREE.Vector3(0, 0, 0),
        q0
      );
      assert.equal(
        checkPieceCollision(
          brick.group.userData.collisionBoxes,
          new THREE.Vector3(0, 0, 0),
          q0,
          [{ mesh: brick.group, localBox: brick.localBox, worldBox: brickBox }],
          null,
          0.052,
          brick.group.userData.collisionMeshData
        ),
        true
      );

      // Dish 4740 apoya en -8 (no hundido en -4), incluye receptor central (0,0) y encaja en 18674
      const dish = await svc.createPartInstance({ ldraw_part_id: "4740", ldraw_color_code: 15 });
      const ring = await svc.createPartInstance({ ldraw_part_id: "4081b", ldraw_color_code: 71 });
      const bracket = await svc.createPartInstance({ ldraw_part_id: "44728", ldraw_color_code: 71 });
      assert.ok(Math.abs(dish.group.userData.defaultSupportUndersideY - -8) < 0.1);
      assert.ok(Math.abs(ring.group.userData.defaultSupportUndersideY - -8) < 0.1);
      assert.ok(Math.abs(bracket.group.userData.defaultSupportUndersideY - -8) < 0.1);
      assert.ok(
        dish.group.userData.bottomReceptors.some((r) => Math.abs(r.x) < 0.1 && Math.abs(r.z) < 0.1)
      );
      disc.group.position.set(0, 16, 0);
      disc.group.updateMatrixWorld(true);
      const discTopWb = computeTransformedWorldBox(
        disc.group.userData.collisionBoxes,
        disc.group.position,
        q0
      );
      assert.equal(
        checkPieceCollision(
          dish.group.userData.collisionBoxes,
          new THREE.Vector3(0, 24, 0),
          q0,
          [{ mesh: disc.group, localBox: disc.localBox, worldBox: discTopWb }],
          null,
          0.052,
          dish.group.userData.collisionMeshData
        ),
        false
      );

      // Technic Axle 6587 entra dentro del agujero de Technic Hub 27940 (a 0° y 45°), pero bloquea si choca pared
      const hub = await svc.createPartInstance({ ldraw_part_id: "27940", ldraw_color_code: 0 });
      const axle = await svc.createPartInstance({ ldraw_part_id: "6587", ldraw_color_code: 28 });
      hub.group.position.set(0, 10, 0);
      hub.group.updateMatrixWorld(true);
      const hubWb = computeTransformedWorldBox(
        hub.group.userData.collisionBoxes,
        hub.group.position,
        q0
      );
      const hubPlaced = [{ mesh: hub.group, localBox: hub.localBox, worldBox: hubWb }];

      const qAxle0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      const qAxle45 = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4)
        .multiply(qAxle0);

      for (const qa of [qAxle0, qAxle45]) {
        assert.equal(
          checkPieceCollision(
            axle.group.userData.collisionBoxes,
            new THREE.Vector3(0, 10, 0),
            qa,
            hubPlaced,
            null,
            0.052,
            axle.group.userData.collisionMeshData
          ),
          false
        );
      }

      assert.equal(
        checkPieceCollision(
          axle.group.userData.collisionBoxes,
          new THREE.Vector3(8, 10, 0),
          qAxle0,
          hubPlaced,
          null,
          0.052,
          axle.group.userData.collisionMeshData
        ),
        true
      );

      // Technic Pin 3673 (sin fricción) entra alineado en Technic Brick 1x1 6541 (ras y parcial), pero bloquea si desalinea o cruza pared
      const pinholeBrick = await svc.createPartInstance({ ldraw_part_id: "6541", ldraw_color_code: 0 });
      const pin3673 = await svc.createPartInstance({ ldraw_part_id: "3673", ldraw_color_code: 71 });
      assert.equal(pinholeBrick.group.userData.pinHoles.length, 2);
      assert.equal(pin3673.group.userData.pinConnectors.length, 2);

      pinholeBrick.group.position.set(0, 24, 0);
      pinholeBrick.group.updateMatrixWorld(true);
      const brick6541Wb = computeTransformedWorldBox(
        pinholeBrick.group.userData.collisionBoxes,
        pinholeBrick.group.position,
        q0
      );
      const brick6541Placed = [
        { mesh: pinholeBrick.group, localBox: pinholeBrick.localBox, worldBox: brick6541Wb },
      ];
      const qPinZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

      for (const zDepth of [10, 15, 18, 20, 22]) {
        assert.equal(
          checkPieceCollision(
            pin3673.group.userData.collisionBoxes,
            new THREE.Vector3(0, 14, zDepth),
            qPinZ,
            brick6541Placed,
            null,
            0.052,
            pin3673.group.userData.collisionMeshData
          ),
          false,
          `Pin 3673 alineado en z=${zDepth} debe entrar en 6541`
        );
      }

      assert.equal(
        checkPieceCollision(
          pin3673.group.userData.collisionBoxes,
          new THREE.Vector3(1.5, 14, 10),
          qPinZ,
          brick6541Placed,
          null,
          0.052,
          pin3673.group.userData.collisionMeshData
        ),
        true
      );
      assert.equal(
        checkPieceCollision(
          pin3673.group.userData.collisionBoxes,
          new THREE.Vector3(0, 14, 10),
          q0,
          brick6541Placed,
          null,
          0.052,
          pin3673.group.userData.collisionMeshData
        ),
        true
      );
    }
  );
});
