import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { LDrawService } from "../src/core/ldrawService.js";
import { checkPieceCollision, computeTransformedWorldBox } from "../src/builder/collision.js";
import { findBestMechanicalMatch } from "../src/builder/connectors.js";

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

function makePlacedEntry(group, localBox) {
  group.updateMatrixWorld(true);
  return {
    mesh: group,
    localBox,
    worldBox: computeTransformedWorldBox(
      group.userData.collisionBoxes,
      group.position,
      group.quaternion
    ),
  };
}

test("Sistema unificado de conectores acopla y valida colisión en bisagras, manos+herramientas, clips+barras, axles y ball joints", async (t) => {
  if (!fs.existsSync(path.join(LDRAW_ROOT, "LDConfig.ldr"))) {
    t.skip("Biblioteca local LDraw no presente en data/ldraw/ldraw");
    return;
  }

  await withLocalLDraw(async () => {
    const svc = new LDrawService();
    svc.loader.setPartsLibraryPath("http://localhost/ldraw/");
    svc._materialsReady = svc.loader.preloadMaterials("http://localhost/ldraw/LDConfig.ldr");
    const q0 = new THREE.Quaternion();

    // 1. Hinge Brick 1x2 Base (3937) + Hinge Brick 2x2 Top Plate Thin (6134)
    const hBase = await svc.createPartInstance({ ldraw_part_id: "3937", ldraw_color_code: 15 });
    const hTop = await svc.createPartInstance({ ldraw_part_id: "6134", ldraw_color_code: 14 });
    hBase.group.position.set(0, 24, 0);
    const placedHBase = [makePlacedEntry(hBase.group, hBase.localBox)];

    for (const deg of [0, 15, 45, 75, 90]) {
      const match = findBestMechanicalMatch({
        carriedMesh: hTop.group,
        carriedQuat: q0,
        autoOrient: true,
        manualTiltApplied: false,
        spinAngle: (deg * Math.PI) / 180,
        hit: {
          kind: "placed",
          object: hBase.group,
          point: new THREE.Vector3(0, 16, 0),
          normal: new THREE.Vector3(0, 1, 0),
        },
        cardN: new THREE.Vector3(0, 1, 0),
        placedPieces: placedHBase,
        ignoreMesh: null,
      });
      assert.ok(match, `Debe detectar encastre hinge 3937+6134 a ${deg}°`);
      assert.equal(match.kind, "hinge");
      assert.equal(
        checkPieceCollision(
          hTop.group.userData.collisionBoxes,
          match.position,
          match.quaternion,
          placedHBase,
          null,
          0.052,
          hTop.group.userData.collisionMeshData
        ),
        false,
        `Hinge 6134 sobre 3937 a ${deg}° no debe chocar`
      );
    }

    // Al girar hacia atrás (-30°), la pared trasera de 3937 sí debe bloquear
    const matchBack = findBestMechanicalMatch({
      carriedMesh: hTop.group,
      carriedQuat: q0,
      autoOrient: true,
      manualTiltApplied: false,
      spinAngle: (-30 * Math.PI) / 180,
      hit: {
        kind: "placed",
        object: hBase.group,
        point: new THREE.Vector3(0, 16, 0),
        normal: new THREE.Vector3(0, 1, 0),
      },
      cardN: new THREE.Vector3(0, 1, 0),
      placedPieces: placedHBase,
      ignoreMesh: null,
    });
    assert.ok(matchBack);
    assert.equal(
      checkPieceCollision(
        hTop.group.userData.collisionBoxes,
        matchBack.position,
        matchBack.quaternion,
        placedHBase,
        null,
        0.052,
        hTop.group.userData.collisionMeshData
      ),
      true
    );

    // 2. Locking Hinge 50340 (2 fingers) + 44301b (1 finger)
    const lockDual = await svc.createPartInstance({ ldraw_part_id: "50340", ldraw_color_code: 71 });
    const lockSingle = await svc.createPartInstance({ ldraw_part_id: "44301b", ldraw_color_code: 15 });
    lockDual.group.position.set(0, 8, 0);
    const placedLock = [makePlacedEntry(lockDual.group, lockDual.localBox)];
    const matchLock = findBestMechanicalMatch({
      carriedMesh: lockSingle.group,
      carriedQuat: q0,
      autoOrient: true,
      manualTiltApplied: false,
      spinAngle: 0,
      hit: {
        kind: "placed",
        object: lockDual.group,
        point: new THREE.Vector3(0, 6, 22),
        normal: new THREE.Vector3(0, 0, 1),
      },
      cardN: new THREE.Vector3(0, 0, 1),
      placedPieces: placedLock,
      ignoreMesh: null,
    });
    assert.ok(matchLock, "Debe detectar encastre locking hinge 50340 + 44301b");
    assert.equal(matchLock.kind, "hinge");
    assert.equal(
      checkPieceCollision(
        lockSingle.group.userData.collisionBoxes,
        matchLock.position,
        matchLock.quaternion,
        placedLock,
        null,
        0.052,
        lockSingle.group.userData.collisionMeshData
      ),
      false
    );

    // 3. Minifig Torso + Manos (76382) + Herramientas (24086 Red, 30374 Lightsaber, 18787 Sword)
    const torso = await svc.createPartInstance({ ldraw_part_id: "76382", ldraw_color_code: 15 });
    torso.group.position.set(0, 42, 0);
    const placedTorso = [makePlacedEntry(torso.group, torso.localBox)];
    const rightHandApprox = new THREE.Vector3(24.78, 42 - 33.09, 17.48);

    for (const toolId of ["24086", "30374", "18787"]) {
      const tool = await svc.createPartInstance({ ldraw_part_id: toolId, ldraw_color_code: 14 });
      const matchHand = findBestMechanicalMatch({
        carriedMesh: tool.group,
        carriedQuat: q0,
        autoOrient: true,
        manualTiltApplied: false,
        spinAngle: 0,
        hit: {
          kind: "placed",
          object: torso.group,
          point: rightHandApprox,
          normal: new THREE.Vector3(0, 0, 1),
        },
        cardN: new THREE.Vector3(0, 0, 1),
        placedPieces: placedTorso,
        ignoreMesh: null,
      });
      assert.ok(matchHand, `Mano minifig 76382 debe acoplar herramienta ${toolId}`);
      assert.equal(matchHand.kind, "bar");
      assert.equal(
        checkPieceCollision(
          tool.group.userData.collisionBoxes,
          matchHand.position,
          matchHand.quaternion,
          placedTorso,
          null,
          0.052,
          tool.group.userData.collisionMeshData
        ),
        false,
        `Herramienta ${toolId} encastrada en mano minifig no debe chocar`
      );
    }

    // 4. Clip Horizontal (61252) + Plate Handle (2540) y Barra (30374)
    const clip = await svc.createPartInstance({ ldraw_part_id: "61252", ldraw_color_code: 0 });
    const bar = await svc.createPartInstance({ ldraw_part_id: "30374", ldraw_color_code: 14 });
    clip.group.position.set(0, 8, 0);
    const placedClip = [makePlacedEntry(clip.group, clip.localBox)];
    const matchClipBar = findBestMechanicalMatch({
      carriedMesh: bar.group,
      carriedQuat: q0,
      autoOrient: true,
      manualTiltApplied: false,
      spinAngle: 0,
      hit: {
        kind: "placed",
        object: clip.group,
        point: new THREE.Vector3(0, 6, 20),
        normal: new THREE.Vector3(0, 0, 1),
      },
      cardN: new THREE.Vector3(0, 0, 1),
      placedPieces: placedClip,
      ignoreMesh: null,
    });
    assert.ok(matchClipBar, "Clip 61252 debe acoplar barra 30374");
    assert.equal(
      checkPieceCollision(
        bar.group.userData.collisionBoxes,
        matchClipBar.position,
        matchClipBar.quaternion,
        placedClip,
        null,
        0.052,
        bar.group.userData.collisionMeshData
      ),
      false
    );

    // 5. Axle Hole (32064a) + Axle 4 (3705)
    const axBrick = await svc.createPartInstance({ ldraw_part_id: "32064a", ldraw_color_code: 15 });
    const axle = await svc.createPartInstance({ ldraw_part_id: "3705", ldraw_color_code: 0 });
    axBrick.group.position.set(0, 24, 0);
    const placedAx = [makePlacedEntry(axBrick.group, axBrick.localBox)];
    const matchAxle = findBestMechanicalMatch({
      carriedMesh: axle.group,
      carriedQuat: q0,
      autoOrient: true,
      manualTiltApplied: false,
      spinAngle: 0,
      hit: {
        kind: "placed",
        object: axBrick.group,
        point: new THREE.Vector3(0, 14, 10),
        normal: new THREE.Vector3(0, 0, 1),
      },
      cardN: new THREE.Vector3(0, 0, 1),
      placedPieces: placedAx,
      ignoreMesh: null,
    });
    assert.ok(matchAxle, "Axle 3705 debe acoplar en 32064a");
    assert.equal(matchAxle.kind, "axle");
    assert.equal(
      checkPieceCollision(
        axle.group.userData.collisionBoxes,
        matchAxle.position,
        matchAxle.quaternion,
        placedAx,
        null,
        0.052,
        axle.group.userData.collisionMeshData
      ),
      false
    );

    // 6. Ball Socket (14418) + Towball Axle (2736)
    const sock = await svc.createPartInstance({ ldraw_part_id: "14418", ldraw_color_code: 71 });
    const ball = await svc.createPartInstance({ ldraw_part_id: "2736", ldraw_color_code: 71 });
    sock.group.position.set(0, 20, 0);
    const placedSock = [makePlacedEntry(sock.group, sock.localBox)];
    const matchBall = findBestMechanicalMatch({
      carriedMesh: ball.group,
      carriedQuat: q0,
      autoOrient: true,
      manualTiltApplied: false,
      spinAngle: 0,
      hit: {
        kind: "placed",
        object: sock.group,
        point: new THREE.Vector3(30, 16, 0),
        normal: new THREE.Vector3(1, 0, 0),
      },
      cardN: new THREE.Vector3(1, 0, 0),
      placedPieces: placedSock,
      ignoreMesh: null,
    });
    assert.ok(matchBall, "Ball 2736 debe acoplar en Socket 14418");
    assert.equal(matchBall.kind, "ball");
    assert.equal(
      checkPieceCollision(
        ball.group.userData.collisionBoxes,
        matchBall.position,
        matchBall.quaternion,
        placedSock,
        null,
        0.052,
        ball.group.userData.collisionMeshData
      ),
      false
    );
  });
});
