import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { LDrawService } from "../src/core/ldrawService.js";
import { checkPieceCollision, computeTransformedWorldBox } from "../src/builder/collision.js";
import { findBestMechanicalMatch } from "../src/builder/connectors.js";
import { BuildController } from "../src/builder/buildController.js";

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

      // Pelucas LDD (21269, 62810) conectan coaxialmente sobre cabezas minifig (3626c, 28621) sin falsa colisión BVH, pero bloquean si se desplazan de costado
      const hairHeads = ["3626c", "28621"].filter((id) =>
        fs.existsSync(path.join(LDRAW_ROOT, "parts", `${id}.dat`))
      );
      const hairWigs = ["21269", "62810"].filter((id) =>
        fs.existsSync(path.join(LDRAW_ROOT, "parts", `${id}.dat`))
      );
      for (const hId of hairHeads) {
        const head = await svc.createPartInstance({ ldraw_part_id: hId, ldraw_color_code: 14 });
        assert.equal(head.group.userData.collisionMeshData.isMinifigHead, true);
        head.group.position.set(0, 24, 0);
        head.group.updateMatrixWorld(true);
        const headWb = computeTransformedWorldBox(
          head.group.userData.collisionBoxes,
          head.group.position,
          q0
        );
        const headPlaced = [
          { mesh: head.group, localBox: head.localBox, worldBox: headWb },
        ];

        for (const wId of hairWigs) {
          const wig = await svc.createPartInstance({ ldraw_part_id: wId, ldraw_color_code: 1 });
          assert.ok(wig.group.userData.antiStuds?.length > 0, `${wId} debe conservar antiStuds`);
          for (const deg of [0, 90, 180, 270]) {
            const qWig = new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              (deg * Math.PI) / 180
            );
            assert.equal(
              checkPieceCollision(
                wig.group.userData.collisionBoxes,
                new THREE.Vector3(0, 24, 0),
                qWig,
                headPlaced,
                null,
                0.052,
                wig.group.userData.collisionMeshData
              ),
              false,
              `${wId} en ${hId} rot=${deg}° debe conectar en (0, 24, 0)`
            );
          }
          assert.equal(
            checkPieceCollision(
              wig.group.userData.collisionBoxes,
              new THREE.Vector3(6, 24, 0),
              q0,
              headPlaced,
              null,
              0.052,
              wig.group.userData.collisionMeshData
            ),
            true,
            `${wId} descentrada sobre ${hId} debe seguir bloqueada`
          );
        }
      }

      // Minidoll Friends/Disney: torso (73141) <-> cabeza (92198) <-> pelo Ariel (15677)
      if (
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "73141.dat")) &&
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "92198.dat")) &&
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "15677.dat"))
      ) {
        const mdTorso = await svc.createPartInstance({ ldraw_part_id: "73141", ldraw_color_code: 14 });
        const mdHead = await svc.createPartInstance({ ldraw_part_id: "92198", ldraw_color_code: 14 });
        const mdHair = await svc.createPartInstance({ ldraw_part_id: "15677", ldraw_color_code: 4 });
        assert.equal(mdHead.group.userData.collisionMeshData.isMinifigHead, true);

        const tPos = new THREE.Vector3(0, -mdTorso.group.userData.defaultSupportUndersideY, 0);
        mdTorso.group.position.copy(tPos);
        mdTorso.group.updateMatrixWorld(true);
        const mdTorsoPlaced = [
          {
            mesh: mdTorso.group,
            localBox: mdTorso.localBox,
            worldBox: computeTransformedWorldBox(mdTorso.group.userData.collisionBoxes, tPos, q0),
          },
        ];

        const neckMatch = findBestMechanicalMatch({
          carriedMesh: mdHead.group,
          carriedQuat: q0,
          autoOrient: true,
          manualTiltApplied: false,
          spinAngle: 0,
          hit: { kind: "placed", object: mdTorso.group, point: new THREE.Vector3(0, tPos.y + 26, -3.9) },
          cardN: new THREE.Vector3(0, 1, 0),
          placedPieces: mdTorsoPlaced,
          ignoreMesh: null,
        });
        assert.equal(neckMatch?.kind, "minifig_neck");
        assert.equal(
          checkPieceCollision(
            mdHead.group.userData.collisionBoxes,
            neckMatch.position,
            neckMatch.quaternion,
            mdTorsoPlaced,
            null,
            0.052,
            mdHead.group.userData.collisionMeshData
          ),
          false,
          "Cabeza minidoll 92198 debe encastrar en cuello del torso 73141"
        );

        mdHead.group.position.copy(neckMatch.position);
        mdHead.group.quaternion.copy(neckMatch.quaternion);
        mdHead.group.updateMatrixWorld(true);
        const mdAssembled = [
          ...mdTorsoPlaced,
          {
            mesh: mdHead.group,
            localBox: mdHead.localBox,
            worldBox: computeTransformedWorldBox(
              mdHead.group.userData.collisionBoxes,
              mdHead.group.position,
              mdHead.group.quaternion
            ),
          },
        ];
        const studWorld = mdHead.group.userData.topStuds[0].pos
          .clone()
          .applyQuaternion(mdHead.group.quaternion)
          .add(mdHead.group.position);
        assert.equal(
          checkPieceCollision(
            mdHair.group.userData.collisionBoxes,
            studWorld,
            q0,
            mdAssembled,
            null,
            0.052,
            mdHair.group.userData.collisionMeshData
          ),
          false,
          "Pelo Ariel 15677 debe encastrar sobre cabeza 92198 montada en torso 73141"
        );
        assert.equal(
          checkPieceCollision(
            mdHair.group.userData.collisionBoxes,
            studWorld.clone().add(new THREE.Vector3(6, 0, 0)),
            q0,
            [mdAssembled[1]],
            null,
            0.052,
            mdHair.group.userData.collisionMeshData
          ),
          true,
          "Pelo Ariel 15677 descentrado debe seguir bloqueado"
        );
      }

      if (fs.existsSync(path.join(LDRAW_ROOT, "parts", "37762.dat"))) {
        const c1 = await svc.createPartInstance({ ldraw_part_id: "37762", ldraw_color_code: 14 });
        const c2 = await svc.createPartInstance({ ldraw_part_id: "37762", ldraw_color_code: 14 });
        c1.group.position.set(0, 0, 0);
        c1.group.quaternion.copy(q0);
        c1.group.updateMatrixWorld(true);
        const c1Placed = [
          {
            mesh: c1.group,
            localBox: c1.localBox,
            worldBox: computeTransformedWorldBox(c1.group.userData.collisionBoxes, c1.group.position, q0),
          },
        ];
        const stackMatch = findBestMechanicalMatch({
          carriedMesh: c2.group,
          carriedQuat: q0,
          autoOrient: true,
          manualTiltApplied: false,
          spinAngle: 0,
          hit: { kind: "placed", object: c1.group, point: new THREE.Vector3(0, 32, 0) },
          cardN: new THREE.Vector3(0, 1, 0),
          placedPieces: c1Placed,
          ignoreMesh: null,
        });
        assert.equal(stackMatch?.kind, "bar");
        assert.ok(
          Math.abs(stackMatch.position.y - 32) < 0.05,
          "Equipment Candlestick 37762 debe apilarse al ras en y=32 sin necesidad de flecha abajo"
        );
        assert.equal(
          checkPieceCollision(
            c2.group.userData.collisionBoxes,
            stackMatch.position,
            stackMatch.quaternion,
            c1Placed,
            null,
            0.052,
            c2.group.userData.collisionMeshData
          ),
          false,
          "Candlestick apilado al ras no debe colisionar"
        );
        assert.equal(
          checkPieceCollision(
            c2.group.userData.collisionBoxes,
            new THREE.Vector3(0, 25, 0),
            q0,
            c1Placed,
            null,
            0.052,
            c2.group.userData.collisionMeshData
          ),
          true,
          "Candlestick invadiendo el cuerpo inferior debe seguir bloqueado"
        );

        if (fs.existsSync(path.join(LDRAW_ROOT, "parts", "63965.dat"))) {
          const bar6 = await svc.createPartInstance({ ldraw_part_id: "63965", ldraw_color_code: 297 });
          const barMatch = findBestMechanicalMatch({
            carriedMesh: bar6.group,
            carriedQuat: q0,
            autoOrient: true,
            manualTiltApplied: false,
            spinAngle: 0,
            hit: { kind: "placed", object: c1.group, point: new THREE.Vector3(0, 32, 0) },
            cardN: new THREE.Vector3(0, 1, 0),
            placedPieces: c1Placed,
            ignoreMesh: null,
          });
          assert.equal(barMatch?.kind, "bar");
          assert.ok(
            Math.abs(barMatch.position.y - 40) < 0.05,
            "Bar 6L with Stop Ring 63965 debe insertar su punta inferior 10 LDU dentro de 37762 (y=40)"
          );
          assert.equal(
            checkPieceCollision(
              bar6.group.userData.collisionBoxes,
              barMatch.position,
              barMatch.quaternion,
              c1Placed,
              null,
              0.052,
              bar6.group.userData.collisionMeshData
            ),
            false,
            "Bar 63965 insertado en 37762 no debe colisionar"
          );
          const qFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
          const flippedBarMatch = findBestMechanicalMatch({
            carriedMesh: bar6.group,
            carriedQuat: qFlip,
            autoOrient: true,
            manualTiltApplied: false,
            spinAngle: 0,
            hit: { kind: "placed", object: c1.group, point: new THREE.Vector3(0, 32, 0) },
            cardN: new THREE.Vector3(0, 1, 0),
            placedPieces: c1Placed,
            ignoreMesh: null,
          });
          assert.equal(flippedBarMatch?.kind, "bar");
          assert.ok(
            Math.abs(flippedBarMatch.position.y - 124.5) < 0.05,
            "Bar 63965 invertido debe insertar la punta larga (+102.5) en 37762 (y=124.5)"
          );

          if (fs.existsSync(path.join(LDRAW_ROOT, "parts", "71752.dat"))) {
            const hay = await svc.createPartInstance({ ldraw_part_id: "71752", ldraw_color_code: 19 });
            hay.group.position.set(0, 20, 0);
            hay.group.quaternion.copy(q0);
            hay.group.updateMatrixWorld(true);
            const hayPlaced = [
              {
                mesh: hay.group,
                localBox: hay.localBox,
                worldBox: computeTransformedWorldBox(hay.group.userData.collisionBoxes, hay.group.position, q0),
              },
            ];
            const hayMatch = findBestMechanicalMatch({
              carriedMesh: bar6.group,
              carriedQuat: q0,
              autoOrient: true,
              manualTiltApplied: false,
              spinAngle: 0,
              hit: { kind: "placed", object: hay.group, point: new THREE.Vector3(0, 20, 0) },
              cardN: new THREE.Vector3(0, 1, 0),
              placedPieces: hayPlaced,
              ignoreMesh: null,
            });
            assert.equal(hayMatch?.kind, "bar_axle");
            assert.ok(
              hayMatch.position.y >= 18 && Math.abs(hayMatch.position.y - 20.15) < 0.2,
              "Bar 63965 debe encastrar su punta inferior en el axle hole de 71752 (y≈20.15)"
            );
            assert.equal(
              checkPieceCollision(
                bar6.group.userData.collisionBoxes,
                hayMatch.position,
                hayMatch.quaternion,
                hayPlaced,
                null,
                0.052,
                bar6.group.userData.collisionMeshData
              ),
              false,
              "Bar 63965 insertado en axle hole de 71752 no debe colisionar"
            );
          }
        }
      }
      if (
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "41682.dat")) &&
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "3004.dat"))
      ) {
        const brk = await svc.createPartInstance({ ldraw_part_id: "41682", ldraw_color_code: 19 });
        const brick = await svc.createPartInstance({ ldraw_part_id: "3004", ldraw_color_code: 14 });
        const qRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
        brick.group.position.set(0, 32, 0);
        brick.group.quaternion.copy(q0);
        brick.group.updateMatrixWorld(true);

        const bc = new BuildController(
          {
            camera: { position: new THREE.Vector3(100, 120, 220) },
            controls: { enablePan: true, enableRotate: true },
            onFrame() {},
          },
          {}
        );
        bc.pilePhysics = { isPointInAnyBag: () => false };
        bc.placedPieces = [
          {
            instanceId: "brick_3004",
            elementId: "3004",
            mesh: brick.group,
            localBox: brick.localBox,
            worldBox: computeTransformedWorldBox(brick.group.userData.collisionBoxes, brick.group.position, q0),
          },
        ];
        bc._lastHit = {
          kind: "placed",
          object: brick.group,
          point: new THREE.Vector3(0, 32, 0),
          normal: new THREE.Vector3(0, 1, 0),
        };
        const rotBox = computeTransformedWorldBox(brk.group.userData.collisionBoxes, new THREE.Vector3(), qRot);
        bc.carry = {
          source: "pile",
          elementId: "41682",
          mesh: brk.group,
          ghost: new THREE.Group(),
          localBox: brk.localBox,
          quaternion: qRot.clone(),
          ghostBox: rotBox,
          surfaceNormal: new THREE.Vector3(0, 1, 0),
          spinAngle: 0,
          manualTiltApplied: true,
          parityOffsetX: 0,
          parityOffsetZ: 0,
          manualOffsetX: 0,
          manualOffsetY: 0,
          manualOffsetZ: 0,
          isColliding: false,
        };
        bc._updateCarryTransform();
        assert.equal(bc.carry.isColliding, false, "Bracket 41682 rotado debe encastrar sobre brick 3004");
        assert.ok(
          Math.abs(bc.carry.ghost.position.x) < 0.05 &&
            Math.abs(bc.carry.ghost.position.y - 36) < 0.05 &&
            Math.abs(bc.carry.ghost.position.z - 10) < 0.05,
          "Bracket 41682 debe apoyar su ala 1x2 al ras sobre brick 3004 (y=36, z=10) dejando colgar el faldón"
        );
      }

      if (
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "35480.dat")) &&
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "20482.dat"))
      ) {
        const p35480 = await svc.createPartInstance({ ldraw_part_id: "35480", ldraw_color_code: 10015 });
        const t1 = await svc.createPartInstance({ ldraw_part_id: "20482", ldraw_color_code: 297 });
        const t2 = await svc.createPartInstance({ ldraw_part_id: "20482", ldraw_color_code: 297 });
        t1.group.position.set(-10, 8, 0);
        t1.group.updateMatrixWorld(true);
        t2.group.position.set(10, 8, 0);
        t2.group.updateMatrixWorld(true);

        const bc = new BuildController(
          {
            camera: { position: new THREE.Vector3(100, 120, 220) },
            controls: { enablePan: true, enableRotate: true },
            onFrame() {},
          },
          {}
        );
        bc.pilePhysics = { isPointInAnyBag: () => false };
        bc.placedPieces = [
          {
            instanceId: "t1",
            elementId: "20482",
            mesh: t1.group,
            localBox: t1.localBox,
            worldBox: computeTransformedWorldBox(t1.group.userData.collisionBoxes, t1.group.position, q0),
          },
          {
            instanceId: "t2",
            elementId: "20482",
            mesh: t2.group,
            localBox: t2.localBox,
            worldBox: computeTransformedWorldBox(t2.group.userData.collisionBoxes, t2.group.position, q0),
          },
        ];
        bc._lastHit = {
          kind: "placed",
          object: t1.group,
          point: new THREE.Vector3(-10, 12, 0),
          normal: new THREE.Vector3(0, 1, 0),
        };
        bc.carry = {
          source: "pile",
          elementId: "35480",
          mesh: p35480.group,
          ghost: new THREE.Group(),
          localBox: p35480.localBox,
          quaternion: q0.clone(),
          ghostBox: p35480.localBox.clone(),
          surfaceNormal: new THREE.Vector3(0, 1, 0),
          spinAngle: 0,
          manualTiltApplied: false,
          parityOffsetX: 0,
          parityOffsetZ: 0,
          manualOffsetX: 0,
          manualOffsetY: 0,
          manualOffsetZ: 0,
          isColliding: false,
        };
        bc._updateCarryTransform();
        assert.equal(bc.carry.isColliding, false, "Plate 35480 debe encastrar al ras sobre ambos 20482");
        assert.ok(
          Math.abs(bc.carry.ghost.position.x) < 0.05 &&
            Math.abs(bc.carry.ghost.position.y - 16) < 0.05 &&
            Math.abs(bc.carry.ghost.position.z) < 0.05,
          "Plate 35480 debe quedar en (0, 16, 0) alineando sus 2 open studs sobre ambos 20482"
        );
      }

      if (
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "30374.dat")) &&
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "15712.dat")) &&
        fs.existsSync(path.join(LDRAW_ROOT, "parts", "3022.dat"))
      ) {
        const bar4 = await svc.createPartInstance({ ldraw_part_id: "30374", ldraw_color_code: 10015 });
        const clip = await svc.createPartInstance({ ldraw_part_id: "15712", ldraw_color_code: 297 });
        const plate = await svc.createPartInstance({ ldraw_part_id: "3022", ldraw_color_code: 19 });
        const qClipFront = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
        plate.group.position.set(0, 8, 10);
        plate.group.updateMatrixWorld(true);
        clip.group.position.set(0, 20, 10);
        clip.group.quaternion.copy(qClipFront);
        clip.group.updateMatrixWorld(true);

        const bc = new BuildController(
          {
            camera: { position: new THREE.Vector3(100, 120, 220) },
            controls: { enablePan: true, enableRotate: true },
            onFrame() {},
          },
          {}
        );
        bc.pilePhysics = { isPointInAnyBag: () => false };
        bc.placedPieces = [
          {
            instanceId: "plate_3022",
            elementId: "3022",
            mesh: plate.group,
            localBox: plate.localBox,
            worldBox: computeTransformedWorldBox(plate.group.userData.collisionBoxes, plate.group.position, q0),
          },
          {
            instanceId: "clip_15712",
            elementId: "15712",
            mesh: clip.group,
            localBox: clip.localBox,
            worldBox: computeTransformedWorldBox(clip.group.userData.collisionBoxes, clip.group.position, qClipFront),
          },
        ];
        bc._lastHit = {
          kind: "placed",
          object: clip.group,
          point: new THREE.Vector3(0, 20, 16),
          normal: new THREE.Vector3(0, 0, 1),
        };
        bc.carry = {
          source: "pile",
          elementId: "30374",
          mesh: bar4.group,
          ghost: new THREE.Group(),
          localBox: bar4.localBox,
          quaternion: q0.clone(),
          ghostBox: bar4.localBox.clone(),
          surfaceNormal: new THREE.Vector3(0, 1, 0),
          spinAngle: 0,
          manualTiltApplied: false,
          parityOffsetX: 0,
          parityOffsetZ: 0,
          manualOffsetX: 0,
          manualOffsetY: 0,
          manualOffsetZ: 0,
          isColliding: false,
        };
        bc._updateCarryTransform();
        assert.equal(
          bc.carry.isColliding,
          false,
          "Bar 4L 30374 debe deslizarse a lo largo de la barra para encastrar en clip 15712 sin chocar con el plate inferior"
        );
        assert.ok(
          bc.carry.ghost.position.y >= 88 && bc.carry.ghost.position.y <= 96,
          "Bar 4L debe quedar sujeto cerca de su extremo inferior por encima del plate"
        );
      }
    }
  );
});
