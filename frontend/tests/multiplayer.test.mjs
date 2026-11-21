import assert from "node:assert/strict";
import test from "node:test";
import { ChunkAccumulator } from "../src/net/bundleTransfer.js";
import {
  ADMIN_ONLY_CONTROLS,
  MAX_ROOM_PLAYERS,
  RoomDirectory,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from "../src/net/roomManager.js";

test("Códigos de sala de 7 dígitos y normalización", () => {
  for (let i = 0; i < 20; i += 1) {
    const code = generateRoomCode();
    assert.equal(code.length, 7);
    assert.equal(isValidRoomCode(code), true);
  }
  assert.equal(normalizeRoomCode("482-91 03ab"), "4829103");
  assert.equal(isValidRoomCode("123456"), false);
  assert.equal(isValidRoomCode("1234567"), true);
});

test("RoomDirectory respeta máximo de 4 jugadores, colores distintos, renombres y expulsión", () => {
  const dir = new RoomDirectory("host-1", "Facu");
  assert.equal(MAX_ROOM_PLAYERS, 4);
  assert.equal(dir.canAcceptPeer(), true);

  const g1 = dir.addGuest("g-1", "Lucas");
  const g2 = dir.addGuest("g-2", "Sofía");
  const g3 = dir.addGuest("g-3", "");
  assert.ok(g1 && g2 && g3);
  assert.equal(g3.name, "Amigo 3");

  // Colores únicos para los 4
  const colors = new Set(dir.getRosterArray().map((p) => p.color));
  assert.equal(colors.size, 4);

  // 5ta persona rechazada
  assert.equal(dir.canAcceptPeer(), false);
  assert.equal(dir.addGuest("g-4", "Extra"), null);

  // Admin no puede ser expulsado
  assert.equal(dir.removePlayer("host-1"), false);

  // Bloqueo y renombre sincronizan el nombre en locks activos
  assert.equal(dir.acquireLocks("g-1", ["p_10"]).ok, true);
  dir.renamePlayer("g-1", "Luqui");
  assert.equal(dir.locks.get("p_10")?.name, "Luqui");

  // Expulsar libera locks y libera el lugar
  assert.equal(dir.removePlayer("g-1"), true);
  assert.equal(dir.locks.has("p_10"), false);
  assert.equal(dir.canAcceptPeer(), true);
});

test("Reserva atómica por pieza bloquea conflictos y evita bloqueos parciales en grupo", () => {
  const dir = new RoomDirectory("host-1", "Admin");
  dir.addGuest("g-1", "Lucas");
  dir.addGuest("g-2", "Mati");

  assert.equal(dir.acquireLocks("g-1", ["p_1"]).ok, true);

  const conflict = dir.acquireLocks("g-2", ["p_2", "p_1"]);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.blockedBy?.peerId, "g-1");
  // p_2 no debe quedar bloqueado parcialmente si falló p_1
  assert.equal(dir.locks.has("p_2"), false);

  dir.releaseLocks("g-1", ["p_1"]);
  assert.equal(dir.acquireLocks("g-2", ["p_2", "p_1"]).ok, true);
});

test("ChunkAccumulator reensambla chunks desordenados sin pérdida", () => {
  const acc = new ChunkAccumulator();
  const c0 = new Uint8Array([1, 2, 3]);
  const c1 = new Uint8Array([4, 5, 6]);
  const c2 = new Uint8Array([7, 8]);

  assert.equal(acc.push({ transferId: "t1", chunkIndex: 2, totalChunks: 3, data: c2.buffer }), null);
  assert.equal(acc.push({ transferId: "t1", chunkIndex: 0, totalChunks: 3, data: c0.buffer }), null);
  const done = acc.push({ transferId: "t1", chunkIndex: 1, totalChunks: 3, kind: "manifest", data: c1.buffer });

  assert.ok(done);
  assert.deepEqual(Array.from(done.bytes), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("Controles exclusivos de Admin coinciden con el diseño", () => {
  assert.deepEqual(
    [...ADMIN_ONLY_CONTROLS],
    ["sticker", "multiplayer", "undo", "clear", "export", "import", "save"]
  );
});
