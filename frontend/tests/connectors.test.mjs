import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { LDrawService } from "../src/core/ldrawService.js";
import { checkPieceCollision, computeTransformedWorldBox } from "../src/builder/collision.js";
import { BuildController } from "../src/builder/buildController.js";
import {
  findBestMechanicalMatch,
  findMechanicalMatches,
  transformConnector,
} from "../src/builder/connectors.js";

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

    // 7. Minifig articulaciones: Piernas (37364 / 41879a) + Hipwear (5386) + Torso (76382) + Cabezas (105199 / 3626c)
    const mfLegsMed = await svc.createPartInstance({ ldraw_part_id: "37364", ldraw_color_code: 88 });
    const mfTorso = await svc.createPartInstance({ ldraw_part_id: "76382", ldraw_color_code: 14 });
    const mfHeadSpecial = await svc.createPartInstance({ ldraw_part_id: "105199", ldraw_color_code: 320 });
    const mfHeadStd = await svc.createPartInstance({ ldraw_part_id: "3626c", ldraw_color_code: 14 });
    const mfTail = await svc.createPartInstance({ ldraw_part_id: "5386", ldraw_color_code: 320 });

    mfLegsMed.group.position.set(0, 32, 0);
    const placedMinifig = [makePlacedEntry(mfLegsMed.group, mfLegsMed.localBox)];

    const matchTorso = findBestMechanicalMatch({
      carriedMesh: mfTorso.group,
      carriedQuat: q0,
      autoOrient: true,
      manualTiltApplied: false,
      spinAngle: 0,
      hit: {
        kind: "placed",
        object: mfLegsMed.group,
        point: new THREE.Vector3(0, 30, 8),
        normal: new THREE.Vector3(0, 1, 0),
      },
      cardN: new THREE.Vector3(0, 1, 0),
      placedPieces: placedMinifig,
      ignoreMesh: null,
    });
    assert.ok(matchTorso, "Torso 76382 debe acoplar en piernas 37364");
    assert.equal(matchTorso.kind, "minifig_hip");
    assert.ok(Math.abs(matchTorso.position.y - 64) < 0.05);
    assert.equal(
      checkPieceCollision(
        mfTorso.group.userData.collisionBoxes,
        matchTorso.position,
        matchTorso.quaternion,
        placedMinifig,
        null,
        0.052,
        mfTorso.group.userData.collisionMeshData
      ),
      false
    );

    mfTorso.group.position.copy(matchTorso.position);
    mfTorso.group.quaternion.copy(matchTorso.quaternion);
    placedMinifig.push(makePlacedEntry(mfTorso.group, mfTorso.localBox));

    for (const [label, headInst, expectedY] of [
      ["Poppy 105199", mfHeadSpecial, 64],
      ["Leif 3626c", mfHeadStd, 88],
    ]) {
      const matchHead = findBestMechanicalMatch({
        carriedMesh: headInst.group,
        carriedQuat: q0,
        autoOrient: true,
        manualTiltApplied: false,
        spinAngle: 0,
        hit: {
          kind: "placed",
          object: mfTorso.group,
          point: new THREE.Vector3(0, 68, 4),
          normal: new THREE.Vector3(0, 1, 0),
        },
        cardN: new THREE.Vector3(0, 1, 0),
        placedPieces: placedMinifig,
        ignoreMesh: null,
      });
      assert.ok(matchHead, `${label} debe acoplar en cuello de torso 76382`);
      assert.equal(matchHead.kind, "minifig_neck");
      assert.ok(Math.abs(matchHead.position.y - expectedY) < 0.05);
      assert.equal(
        checkPieceCollision(
          headInst.group.userData.collisionBoxes,
          matchHead.position,
          matchHead.quaternion,
          placedMinifig,
          null,
          0.052,
          headInst.group.userData.collisionMeshData
        ),
        false
      );
    }

    const matchTail = findBestMechanicalMatch({
      carriedMesh: mfTail.group,
      carriedQuat: q0,
      autoOrient: true,
      manualTiltApplied: false,
      spinAngle: 0,
      hit: {
        kind: "placed",
        object: mfLegsMed.group,
        point: new THREE.Vector3(0, 32, 0),
        normal: new THREE.Vector3(0, 1, 0),
      },
      cardN: new THREE.Vector3(0, 1, 0),
      placedPieces: [placedMinifig[0]],
      ignoreMesh: null,
    });
    assert.ok(matchTail, "Hipwear 5386 debe acoplar en caderas 37364");
    assert.equal(matchTail.kind, "minifig_hip");
    assert.ok(Math.abs(matchTail.position.y - 32) < 0.05);
    assert.equal(
      checkPieceCollision(
        mfTail.group.userData.collisionBoxes,
        matchTail.position,
        matchTail.quaternion,
        [placedMinifig[0]],
        null,
        0.052,
        mfTail.group.userData.collisionMeshData
      ),
      false
    );

    // 9. Plate Round 1x1 w/ Horizontal Bar 1L (32828) + Technic Brick 1x1 w/ Axle Hole (73230)
    if (
      fs.existsSync(path.join(LDRAW_ROOT, "parts", "32828.dat")) &&
      fs.existsSync(path.join(LDRAW_ROOT, "parts", "73230.dat"))
    ) {
      const barPlate = await svc.createPartInstance({ ldraw_part_id: "32828", ldraw_color_code: 0 });
      const axleBrick = await svc.createPartInstance({ ldraw_part_id: "73230", ldraw_color_code: 0 });
      axleBrick.group.position.set(0, 24, 0);
      const placedBrick = [makePlacedEntry(axleBrick.group, axleBrick.localBox)];

      const matchBarIntoAxle = findBestMechanicalMatch({
        carriedMesh: barPlate.group,
        carriedQuat: q0,
        autoOrient: true,
        manualTiltApplied: false,
        spinAngle: 0,
        hit: {
          kind: "placed",
          object: axleBrick.group,
          point: new THREE.Vector3(0, 14, 10),
          normal: new THREE.Vector3(0, 0, 1),
        },
        cardN: new THREE.Vector3(0, 0, 1),
        placedPieces: placedBrick,
        ignoreMesh: null,
      });
      assert.ok(matchBarIntoAxle, "Barra 1L de 32828 debe acoplar dentro del agujero axle de 73230");
      assert.equal(matchBarIntoAxle.kind, "bar_axle");
      assert.equal(
        checkPieceCollision(
          barPlate.group.userData.collisionBoxes,
          matchBarIntoAxle.position,
          matchBarIntoAxle.quaternion,
          placedBrick,
          null,
          0.052,
          barPlate.group.userData.collisionMeshData
        ),
        false,
        "Barra 32828 dentro de agujero axle 73230 no debe chocar"
      );

      barPlate.group.position.set(0, 16, 0);
      const placedBar = [makePlacedEntry(barPlate.group, barPlate.localBox)];
      const matchAxleOntoBar = findBestMechanicalMatch({
        carriedMesh: axleBrick.group,
        carriedQuat: q0,
        autoOrient: true,
        manualTiltApplied: false,
        spinAngle: 0,
        hit: {
          kind: "placed",
          object: barPlate.group,
          point: new THREE.Vector3(24, 14, 0),
          normal: new THREE.Vector3(0, 1, 0),
        },
        cardN: new THREE.Vector3(0, 1, 0),
        placedPieces: placedBar,
        ignoreMesh: null,
      });
      assert.ok(matchAxleOntoBar, "73230 debe encastrar sobre la barra 1L de 32828");
      assert.equal(matchAxleOntoBar.kind, "bar_axle");
      assert.ok(Math.abs(matchAxleOntoBar.position.x - 28.01) < 0.2);
      assert.equal(
        checkPieceCollision(
          axleBrick.group.userData.collisionBoxes,
          matchAxleOntoBar.position,
          matchAxleOntoBar.quaternion,
          placedBar,
          null,
          0.052,
          axleBrick.group.userData.collisionMeshData
        ),
        false
      );
    }

    // 10. Plate Special 1x2 Side Handle Closed Ends (48336) + 2x Tile 1x1 w/ Clip Rounded (15712)
    if (
      fs.existsSync(path.join(LDRAW_ROOT, "parts", "48336.dat")) &&
      fs.existsSync(path.join(LDRAW_ROOT, "parts", "15712.dat"))
    ) {
      const handlePlate = await svc.createPartInstance({ ldraw_part_id: "48336", ldraw_color_code: 0 });
      const clipA = await svc.createPartInstance({ ldraw_part_id: "15712", ldraw_color_code: 15 });
      const clipB = await svc.createPartInstance({ ldraw_part_id: "15712", ldraw_color_code: 15 });
      clipA.group.position.set(10, 16, -10);
      clipB.group.position.set(10, 16, 10);
      const placedDoubleClips = [
        makePlacedEntry(clipA.group, clipA.localBox),
        makePlacedEntry(clipB.group, clipB.localBox),
      ];

      // Al apuntar sobre cualquiera de los dos clips en postura vertical (270°), centra z=0 en ambos clips sin chocar
      const matchDoubleClip = findBestMechanicalMatch({
        carriedMesh: handlePlate.group,
        carriedQuat: q0,
        autoOrient: true,
        manualTiltApplied: false,
        spinAngle: (270 * Math.PI) / 180,
        hit: {
          kind: "placed",
          object: clipA.group,
          point: new THREE.Vector3(10, 22, -10),
          normal: new THREE.Vector3(0, 1, 0),
        },
        cardN: new THREE.Vector3(0, 1, 0),
        placedPieces: placedDoubleClips,
        ignoreMesh: null,
      });
      assert.ok(matchDoubleClip, "48336 debe centrarse entre los dos clips 15712 coaxiales");
      assert.equal(matchDoubleClip.kind, "bar");
      assert.ok(
        Math.abs(matchDoubleClip.position.z) < 0.05,
        `Posición Z esperada centrada en 0, obtuvo ${matchDoubleClip.position.z}`
      );
      assert.equal(
        checkPieceCollision(
          handlePlate.group.userData.collisionBoxes,
          matchDoubleClip.position,
          matchDoubleClip.quaternion,
          placedDoubleClips,
          null,
          0.052,
          handlePlate.group.userData.collisionMeshData
        ),
        false,
        "48336 centrado sobre ambos clips 15712 no debe colisionar"
      );

      // Dirección inversa: acoplar 2 clips 15712 en distintos puntos de la barra de 48336 ya colocada
      handlePlate.group.position.set(12, 42, 0);
      handlePlate.group.quaternion.copy(matchDoubleClip.quaternion);
      const placedHandle = [makePlacedEntry(handlePlate.group, handlePlate.localBox)];
      const matchClipOnLeft = findBestMechanicalMatch({
        carriedMesh: clipA.group,
        carriedQuat: q0,
        autoOrient: true,
        manualTiltApplied: false,
        spinAngle: 0,
        hit: {
          kind: "placed",
          object: handlePlate.group,
          point: new THREE.Vector3(10, 22, -10),
          normal: new THREE.Vector3(0, -1, 0),
        },
        cardN: new THREE.Vector3(0, -1, 0),
        placedPieces: placedHandle,
        ignoreMesh: null,
      });
      assert.ok(matchClipOnLeft, "Clip 15712 debe poder deslizar al extremo (-10) de 48336");
      assert.ok(
        Math.abs(matchClipOnLeft.position.z - -10) < 0.1,
        `Clip izquierdo esperado en z=-10, obtuvo ${matchClipOnLeft.position.z}`
      );
    }

    // 11. Hair Swept Left Tousled (23186) + Minifig Head (3626c) sobre Torso (76382)
    if (
      fs.existsSync(path.join(LDRAW_ROOT, "parts", "23186.dat")) &&
      fs.existsSync(path.join(LDRAW_ROOT, "parts", "3626c.dat"))
    ) {
      const hair = await svc.createPartInstance({ ldraw_part_id: "23186", ldraw_color_code: 0 });
      assert.equal(hair.group.userData.defaultSupportUndersideY, 0);
      assert.equal(hair.group.userData.bottomReceptors.length, 1);
      assert.ok(hair.group.userData.bottomReceptors[0].distanceTo(new THREE.Vector3(0, 0, 0)) < 0.05);

      mfHeadStd.group.position.set(0, 88, 0);
      const placedMinifigTop = [
        makePlacedEntry(mfTorso.group, mfTorso.localBox),
        makePlacedEntry(mfHeadStd.group, mfHeadStd.localBox),
      ];
      const studPos = mfHeadStd.group.userData.topStuds[0].pos.clone().add(mfHeadStd.group.position);
      const supportDist = -(hair.group.userData.defaultSupportUndersideY ?? 0);
      const refR = hair.group.userData.bottomReceptors[0];

      for (const deg of [0, 90, 180, 270]) {
        const qRot = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          (deg * Math.PI) / 180
        );
        const wRef = refR.clone().applyQuaternion(qRot);
        const cand = new THREE.Vector3(
          studPos.x - wRef.x,
          studPos.y + supportDist,
          studPos.z - wRef.z
        );
        assert.ok(cand.distanceTo(new THREE.Vector3(0, 88, 0)) < 0.05);
        assert.equal(
          checkPieceCollision(
            hair.group.userData.collisionBoxes,
            cand,
            qRot,
            placedMinifigTop,
            null,
            0.052,
            hair.group.userData.collisionMeshData
          ),
          false,
          `Pelo 23186 sobre cabeza 3626c a ${deg}° no debe colisionar`
        );
      }
    }

    // 12. Grupo múltiple (60478 + 24246 + 11477) conservando conector bar:plug al acoplar en 15712
    if (
      fs.existsSync(path.join(LDRAW_ROOT, "parts", "60478.dat")) &&
      fs.existsSync(path.join(LDRAW_ROOT, "parts", "15712.dat"))
    ) {
      const clipWall = await svc.createPartInstance({ ldraw_part_id: "15712", ldraw_color_code: 272 });
      clipWall.group.position.set(-10, 14, 18);
      clipWall.group.quaternion
        .setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));

      const grpHandle = await svc.createPartInstance({ ldraw_part_id: "60478", ldraw_color_code: 272 });
      const grpTile = await svc.createPartInstance({ ldraw_part_id: "24246", ldraw_color_code: 71 });
      const grpSlope = await svc.createPartInstance({ ldraw_part_id: "11477", ldraw_color_code: 30 });
      grpHandle.group.position.set(100, 8, 100);
      grpTile.group.position.set(110, 16, 100);
      grpSlope.group.position.set(90, 16, 100);

      const cam = new THREE.PerspectiveCamera(45, 1, 1, 5000);
      cam.position.set(-60, 140, 220);
      const bc = new BuildController(
        {
          camera: cam,
          scene: new THREE.Scene(),
          onFrame: () => {},
          setPieceSelected: () => {},
          setPlacedVisible: () => {},
          setSelectionBox: () => {},
        },
        svc
      );
      const wrapPlaced = (id, inst) => {
        inst.group.updateMatrixWorld(true);
        return {
          instanceId: id,
          elementId: id,
          mesh: inst.group,
          localBox: inst.localBox,
          worldBox: computeTransformedWorldBox(
            inst.group.userData.collisionBoxes,
            inst.group.position,
            inst.group.quaternion
          ),
        };
      };
      const pClip = wrapPlaced("clip", clipWall);
      const pH = wrapPlaced("60478", grpHandle);
      const pT = wrapPlaced("24246", grpTile);
      const pS = wrapPlaced("11477", grpSlope);
      bc.placedPieces = [pClip, pH, pT, pS];

      bc._liftGroupPieces([pH, pT, pS]);
      assert.ok(bc.carry.mesh.userData.connectors?.length >= 1, "El grupo debe heredar conectores");
      assert.equal(bc.carry.mesh.userData.collisionMeshData?.length, 3);

      bc._lastHit = {
        kind: "placed",
        object: clipWall.group,
        point: new THREE.Vector3(-10, 14, 24),
        normal: new THREE.Vector3(0, 0, 1),
      };
      bc._updateCarryTransform();
      assert.equal(bc.carry.activeMechKind, "bar", "El grupo debe encastrar como clip/barra");
      assert.equal(bc.carry.isColliding, false, "El grupo encastrado con BVH por miembro no debe chocar");
    }

    // 13. Primitivas LDraw ampliadas: axl3hole/axl3hol8, pines cortos cerrados 4-4cylc (37775) y neumáticos esculpidos (11209/92402)
    for (const axId of ["59443", "32123b", "25214"]) {
      const p = await svc.createPartInstance({ ldraw_part_id: axId, ldraw_color_code: 0 });
      assert.ok(
        p.group.userData.connectors?.some((c) => c.kind === "axle" && c.role === "hole"),
        `Pieza ${axId} debe detectar al menos un axle:hole`
      );
    }

    const flame = await svc.createPartInstance({ ldraw_part_id: "37775", ldraw_color_code: 4 });
    const candle = await svc.createPartInstance({ ldraw_part_id: "37762", ldraw_color_code: 19 });
    assert.ok(
      flame.group.userData.connectors?.some((c) => c.kind === "bar" && c.role === "plug"),
      "Llama 37775 (4-4cylc de 5 LDU) debe extraer conector bar:plug"
    );
    candle.group.position.set(0, 64, 0);
    const placedCandle = [makePlacedEntry(candle.group, candle.localBox)];
    const flameMatch = findBestMechanicalMatch({
      carriedMesh: flame.group,
      carriedQuat: q0,
      autoOrient: true,
      manualTiltApplied: false,
      spinAngle: 0,
      hit: {
        kind: "placed",
        object: candle.group,
        point: new THREE.Vector3(0, 96, 0),
        normal: new THREE.Vector3(0, 1, 0),
      },
      cardN: new THREE.Vector3(0, 1, 0),
      placedPieces: placedCandle,
      ignoreMesh: null,
    });
    assert.ok(flameMatch, "Llama 37775 debe acoplar en candelero 37762");
    assert.equal(
      checkPieceCollision(
        flame.group.userData.collisionBoxes,
        flameMatch.position,
        flameMatch.quaternion,
        placedCandle,
        null,
        0.052,
        flame.group.userData.collisionMeshData
      ),
      false
    );

    for (const tyreId of ["11209", "92402"]) {
      const tyre = await svc.createPartInstance({ ldraw_part_id: tyreId, ldraw_color_code: 0 });
      assert.ok(
        tyre.group.userData.connectors?.some((c) => c.kind === "wheel_tyre" && c.role === "socket"),
        `Neumático ${tyreId} debe detectar wheel_tyre:socket`
      );
    }
    for (const nonTyreId of ["27925", "3680"]) {
      const p = await svc.createPartInstance({ ldraw_part_id: nonTyreId, ldraw_color_code: 15 });
      assert.equal(
        p.group.userData.connectors?.some((c) => c.kind === "wheel_tyre"),
        false,
        `Pieza ${nonTyreId} no debe falsamente detectarse como wheel_tyre`
      );
    }

    // 14. Receptores rebajados multi-altura (+16 / +24 LDU) en arcos y brackets, excluyendo cuñas diagonales (3660)
    const arch4490 = await svc.createPartInstance({ ldraw_part_id: "4490", ldraw_color_code: 15 });
    const bracket11215 = await svc.createPartInstance({ ldraw_part_id: "11215", ldraw_color_code: 15 });
    const invSlope3660 = await svc.createPartInstance({ ldraw_part_id: "3660", ldraw_color_code: 15 });
    assert.ok(
      arch4490.group.userData.recessedReceptors?.some((r) => Math.abs(r.y - -8) < 0.5),
      "Arco 4490 (base -24) debe detectar receptor rebajado +16 en y=-8"
    );
    assert.ok(
      bracket11215.group.userData.recessedReceptors?.some((r) => Math.abs(r.y - -8) < 0.5),
      "Bracket 11215 (base -32) debe detectar ala superior +24 en y=-8"
    );
    assert.equal(
      invSlope3660.group.userData.recessedReceptors?.length || 0,
      0,
      "Slope invertido 3660 con cara diagonal no debe exponer falsos receptores rebajados"
    );

    // 15. findMechanicalMatches devuelve candidatos ordenados y BuildController hace fallback ante colisión
    const joiner = await svc.createPartInstance({ ldraw_part_id: "59443", ldraw_color_code: 71 });
    const axle3705 = await svc.createPartInstance({ ldraw_part_id: "3705", ldraw_color_code: 0 });
    const blocker = await svc.createPartInstance({ ldraw_part_id: "3003", ldraw_color_code: 4 });
    joiner.group.position.set(0, 30, 0);
    // Bloqueamos la boca +Z (z > 20) del joiner con un brick 2x2 para forzar el fallback hacia el eje alternativo
    blocker.group.position.set(0, 44, 30);
    const placedJoiner = [
      makePlacedEntry(joiner.group, joiner.localBox),
      makePlacedEntry(blocker.group, blocker.localBox),
    ];
    const hitJoiner = {
      kind: "placed",
      object: joiner.group,
      point: new THREE.Vector3(0, 30, 18),
      normal: new THREE.Vector3(0, 0, 1),
    };
    const ranked = findMechanicalMatches(
      {
        carriedMesh: axle3705.group,
        carriedQuat: q0,
        autoOrient: true,
        manualTiltApplied: false,
        spinAngle: 0,
        hit: hitJoiner,
        cardN: new THREE.Vector3(0, 0, 1),
        placedPieces: placedJoiner,
        ignoreMesh: null,
      },
      6
    );
    assert.ok(ranked.length >= 2, "Debe haber múltiples candidatos mecánicos alternativos");

    const cam = new THREE.PerspectiveCamera(45, 1, 1, 5000);
    cam.position.set(120, 120, 220);
    const bc = new BuildController(
      {
        camera: cam,
        scene: new THREE.Scene(),
        onFrame() {},
      },
      svc
    );
    bc.pilePhysics = { isPointInAnyBag: () => false };
    bc.placedPieces = placedJoiner;
    bc._lastHit = hitJoiner;
    bc.carry = {
      source: "pile",
      elementId: "3705",
      mesh: axle3705.group,
      ghost: axle3705.group.clone(),
      localBox: axle3705.localBox,
      quaternion: q0.clone(),
      ghostBox: axle3705.localBox.clone(),
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
      "Si el primer match mecánico colisiona con el blocker, BuildController debe probar altMatchTransforms"
    );
  });
});

test("transformConnector transforma todos los puntos y direcciones sin mutar el origen", () => {
  const src = {
    kind: "bar",
    role: "plug",
    pos: new THREE.Vector3(10, 0, 0),
    mouthPos: new THREE.Vector3(12, 0, 0),
    barMidPos: new THREE.Vector3(15, 0, 0),
    dir: new THREE.Vector3(1, 0, 0),
    crossAxis: new THREE.Vector3(0, 0, 1),
    outwardDir: new THREE.Vector3(0, 1, 0),
    tipDir: new THREE.Vector3(1, 0, 0),
  };
  const q90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const relPos = new THREE.Vector3(5, 20, -10);
  const out = transformConnector(src, q90, relPos);
  assert.ok(out.pos.distanceTo(new THREE.Vector3(5, 20, -20)) < 1e-4);
  assert.ok(out.mouthPos.distanceTo(new THREE.Vector3(5, 20, -22)) < 1e-4);
  assert.ok(out.barMidPos.distanceTo(new THREE.Vector3(5, 20, -25)) < 1e-4);
  assert.ok(out.dir.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-4);
  assert.ok(out.crossAxis.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-4);
  assert.ok(out.outwardDir.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-4);
  assert.ok(out.tipDir.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-4);
  assert.deepEqual(src.pos.toArray(), [10, 0, 0], "No debe mutar el conector original");
});
