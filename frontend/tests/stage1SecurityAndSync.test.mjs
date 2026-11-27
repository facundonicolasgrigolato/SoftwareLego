import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";
import {
  isAllowedLocalRequest,
  isPdfBuffer,
  isPngBuffer,
  isSafeLDrawRelPath,
  isValidLDrawContent,
  isValidManifestPayload,
  safeDecodeUriComponent,
  writeFileAtomicSync,
} from "../server/localSecurity.mjs";
import { serializeSlotHistory, validateImportedSave } from "../src/builder/storage.js";
import { BuildController } from "../src/builder/buildController.js";
import { applyGuestOpOnHost, applyWorldOpOnGuest } from "../src/net/worldSync.js";

test("localSecurity valida rutas, firmas binarias y contenido LDraw", () => {
  assert.equal(isSafeLDrawRelPath("parts/3001.dat"), true);
  assert.equal(isSafeLDrawRelPath("p/stud.dat"), true);
  assert.equal(isSafeLDrawRelPath("LDConfig.ldr"), true);
  assert.equal(isSafeLDrawRelPath("parts/evil.js"), false);
  assert.equal(isSafeLDrawRelPath("index.html"), false);

  assert.equal(isValidLDrawContent("0 Brick 2x4\r\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3001s01.dat\r\n"), true);
  assert.equal(isValidLDrawContent("<html><script>alert(1)</script></html>"), false);
  assert.equal(isValidLDrawContent("const x = 1;"), false);

  assert.equal(isPdfBuffer(Buffer.from("%PDF-1.7\n...")), true);
  assert.equal(isPdfBuffer(Buffer.from("MZ\x90\x00\x03")), false);

  assert.equal(isPngBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), true);
  assert.equal(isPngBuffer(Buffer.from("<html>")), false);

  assert.equal(isValidManifestPayload({ set_number: "40468", parts: [] }), true);
  assert.equal(isValidManifestPayload({ set_number: "40468" }), false);
  assert.equal(safeDecodeUriComponent("%E0%A4%A"), null);
  assert.equal(safeDecodeUriComponent("40468"), "40468");
});

test("isAllowedLocalRequest bloquea peticiones cross-site / CSRF y DNS rebinding", () => {
  assert.equal(
    isAllowedLocalRequest({
      method: "POST",
      headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" },
    }),
    true
  );
  assert.equal(
    isAllowedLocalRequest({
      method: "POST",
      headers: { host: "127.0.0.1:5173", origin: "https://evil.example" },
    }),
    false
  );
  assert.equal(
    isAllowedLocalRequest({
      method: "POST",
      headers: { host: "127.0.0.1:5173", "sec-fetch-site": "cross-site" },
    }),
    false
  );
  assert.equal(
    isAllowedLocalRequest({
      method: "GET",
      headers: { host: "evil.example:5173" },
    }),
    false
  );
});

test("writeFileAtomicSync escribe sin dejar archivos .tmp residuales", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-atomic-"));
  try {
    const target = path.join(dir, "slot_1.json");
    writeFileAtomicSync(target, '{"ok":true}', "utf-8");
    assert.equal(fs.readFileSync(target, "utf-8"), '{"ok":true}');
    assert.deepEqual(fs.readdirSync(dir), ["slot_1.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serializeSlotHistory y BuildController.loadManifest preservan rotaciones THREE.Euler en Undo", async () => {
  const rot = new THREE.Euler(Math.PI / 2, Math.PI / 4, 0, "XYZ");
  const pos = new THREE.Vector3(20, 8, -40);
  const serialized = serializeSlotHistory([
    {
      type: "move",
      instanceId: "p_1",
      prevState: { position: pos, rotation: rot },
      newState: { position: new THREE.Vector3(40, 8, -40), rotation: new THREE.Euler(0, 0, 0, "XYZ") },
    },
  ]);

  assert.equal(serialized[0].prevState.rotation.x, rot.x);
  assert.equal(serialized[0].prevState.rotation.y, rot.y);

  // Compatibilidad retroactiva con saves previos que guardaron _x/_y/_z de THREE.Euler
  const legacySavedHistory = JSON.parse(
    JSON.stringify([
      {
        type: "move",
        instanceId: "p_1",
        prevState: { position: pos, rotation: rot },
        newState: { position: new THREE.Vector3(40, 8, -40), rotation: new THREE.Euler(0, 0, 0, "XYZ") },
      },
    ])
  );
  assert.equal(legacySavedHistory[0].prevState.rotation.x, undefined);

  const fakeSceneManager = {
    onFrame: () => {},
    clearPieces: () => {},
    applyTableLayout: () => {},
    setSelectionBox: () => {},
    invalidateShadows: () => {},
  };
  const bc = new BuildController(fakeSceneManager, {});
  await bc.loadManifest({ parts: [], bags: [] }, null, legacySavedHistory);
  assert.ok(Math.abs(bc.history[0].prevState.rotation.x - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(bc.history[0].prevState.rotation.y - Math.PI / 4) < 1e-6);
});

test("validateImportedSave rechaza datos corruptos o pegatinas inseguras", () => {
  assert.throws(() => validateImportedSave({ pieces: [{ element_id: "3001", position: { x: "NaN", y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }] }));
  assert.throws(() =>
    validateImportedSave({
      pieces: [
        {
          element_id: "3001",
          position: { x: 0, y: 8, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          stickers: [{ faceKey: "top", dataUrl: "javascript:alert(1)" }],
        },
      ],
    })
  );
  const valid = validateImportedSave({
    pieces: [
      {
        element_id: "3001",
        position: { x: 0, y: 8, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        stickers: [{ faceKey: "top", dataUrl: "data:image/png;base64,AAAA" }],
      },
    ],
  });
  assert.equal(valid.pieces.length, 1);
});

test("worldSync spawnPileItem respeta quaternion del Host (sin randomTilt) y rechaza NaN en Host", async () => {
  const addCalls = [];
  const qHost = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
  const fakeBc = {
    nextInstanceSeq: 1,
    isLightweightSet: false,
    partsByElementId: new Map([["302401", { element_id: "302401", ldraw_part_id: "3024" }]]),
    ldrawService: {
      createPartInstance: async () => ({
        group: new THREE.Group(),
        localBox: new THREE.Box3(new THREE.Vector3(-10, -8, -10), new THREE.Vector3(10, 0, 10)),
      }),
    },
    pilePhysics: {
      items: [],
      addPiece: (...args) => addCalls.push(args),
    },
    sceneManager: { addPileMesh: () => {} },
    placedPieces: [{ instanceId: "p_1", mesh: { position: new THREE.Vector3(), rotation: new THREE.Euler() } }],
    _emitChange: () => {},
  };

  await applyWorldOpOnGuest(fakeBc, {
    type: "world:op",
    op: "spawn-pile",
    item: {
      instanceId: "pile_9",
      elementId: "302401",
      bagNumber: 1,
      position: { x: -300, y: 20, z: 10 },
      quaternion: { x: qHost.x, y: qHost.y, z: qHost.z, w: qHost.w },
    },
  });
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0][5], false, "randomTilt debe ser false cuando el Host envía quaternion");

  const nanOp = await applyGuestOpOnHost(fakeBc, {
    type: "guest:op",
    op: "move-placed",
    instanceId: "p_1",
    position: { x: Number.NaN, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  });
  assert.equal(nanOp, null);
});
