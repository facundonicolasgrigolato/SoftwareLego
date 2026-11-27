import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startLocalApiServer } from "../server/localApiServer.mjs";

function makeTempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "softwarelego-api-"));
  fs.mkdirSync(path.join(dir, "output", "sets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "output", "covers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data", "ldraw", "ldraw", "parts"), { recursive: true });
  return dir;
}

test("localApiServer endpoints, validations, and CSRF guard work on ephemeral port", async (t) => {
  const rootDir = makeTempRoot();
  const ldrawRoot = path.join(rootDir, "data", "ldraw", "ldraw");
  const { server, manualWorker } = await startLocalApiServer({
    rootDir,
    ldrawRoot,
    host: "127.0.0.1",
    port: 0,
  });

  t.after(async () => {
    manualWorker?.dispose?.();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // 1. CSRF Origin rejection on mutating API routes
  const csrfRes = await fetch(`${baseUrl}/api/saves/75300/1`, {
    method: "PUT",
    headers: {
      Origin: "http://evil.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ placed: [], pile: [], tray: [] }),
  });
  assert.equal(csrfRes.status, 403);

  // 2. Empty sets list
  const emptySetsRes = await fetch(`${baseUrl}/api/sets`);
  assert.equal(emptySetsRes.status, 200);
  assert.deepEqual(await emptySetsRes.json(), []);

  // 3. Bundle manifest save (invalid vs valid)
  const badManifestRes = await fetch(`${baseUrl}/api/bundle/save-manifest?set=75300`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: "not-an-array" }),
  });
  assert.equal(badManifestRes.status, 400);

  const validManifest = {
    set_number: "75300",
    name: "Test Set",
    parts: [{ element_id: "3001", part_id: "3001", ldraw_file: "parts/3001.dat", color_id: 4, qty: 2 }],
  };
  const okManifestRes = await fetch(`${baseUrl}/api/bundle/save-manifest?set=75300`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validManifest),
  });
  assert.equal(okManifestRes.status, 200);

  const setsRes = await fetch(`${baseUrl}/api/sets`);
  const sets = await setsRes.json();
  assert.equal(sets.length, 1);
  assert.equal(sets[0].set_number, "75300");

  // 4. Saves CRUD & slot bounds
  const badSlotRes = await fetch(`${baseUrl}/api/saves/75300/99`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ placed: [], pile: [], tray: [] }),
  });
  assert.equal(badSlotRes.status, 400);

  const savePayload = {
    name: "Mi Partida",
    pieces: [{ instanceId: "p1", elementId: "3001", pos: [0, 0.5, 0], quat: [0, 0, 0, 1], bag: 1, stickers: [] }],
    pile: [],
    history: [],
  };
  const putSaveRes = await fetch(`${baseUrl}/api/saves/75300/1`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(savePayload),
  });
  assert.equal(putSaveRes.status, 200);

  const getSaveRes = await fetch(`${baseUrl}/api/saves/75300/1`);
  assert.equal(getSaveRes.status, 200);
  const loadedSave = await getSaveRes.json();
  assert.equal(loadedSave.ok, true);
  assert.equal(loadedSave.save.set_number, "75300");
  assert.equal(loadedSave.save.placed_count, 1);

  const listSlotsRes = await fetch(`${baseUrl}/api/saves?set=75300`);
  const slotsBody = await listSlotsRes.json();
  assert.equal(slotsBody.slots.find((s) => s.slot === 1)?.exists, true);

  const delSaveRes = await fetch(`${baseUrl}/api/saves/75300/1`, { method: "DELETE" });
  assert.equal(delSaveRes.status, 200);
  const missingSaveRes = await fetch(`${baseUrl}/api/saves/75300/1`);
  assert.equal(missingSaveRes.status, 404);

  // 5. Cover PNG validation
  const badCoverRes = await fetch(`${baseUrl}/api/bundle/save-cover?set=75300`, {
    method: "POST",
    body: Buffer.from("NOT_A_PNG"),
  });
  assert.equal(badCoverRes.status, 400);

  const okCoverRes = await fetch(`${baseUrl}/api/bundle/save-cover?set=75300`, {
    method: "POST",
    body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  });
  assert.equal(okCoverRes.status, 200);
  assert.equal(fs.existsSync(path.join(rootDir, "output", "covers", "75300.png")), true);

  // 6. LDraw batch validation
  const batchRes = await fetch(`${baseUrl}/api/bundle/save-ldraw-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: [
        { path: "parts/evil.js", data: Buffer.from("alert(1)").toString("base64") },
        { path: "parts/html.dat", data: Buffer.from("<!DOCTYPE html><html></html>").toString("base64") },
        {
          path: "parts/3001.dat",
          data: Buffer.from("0 Brick 2x4\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3001s01.dat\n").toString("base64"),
        },
      ],
    }),
  });
  assert.equal(batchRes.status, 200);
  const batchJson = await batchRes.json();
  assert.equal(batchJson.saved, 1);
  assert.equal(batchJson.rejected, 2);
  assert.equal(fs.existsSync(path.join(ldrawRoot, "parts", "3001.dat")), true);
  assert.equal(fs.existsSync(path.join(ldrawRoot, "parts", "evil.js")), false);

  // 7. PDF chunk validation
  const badPdfRes = await fetch(`${baseUrl}/api/bundle/save-pdf-chunk?filename=75300.pdf&mode=start&done=1`, {
    method: "POST",
    body: Buffer.from("<html>not a pdf</html>"),
  });
  assert.equal(badPdfRes.status, 400);

  const okPdfRes = await fetch(`${baseUrl}/api/bundle/save-pdf-chunk?filename=75300.pdf&mode=start&done=1`, {
    method: "POST",
    body: Buffer.from("%PDF-1.4\n%%EOF\n"),
  });
  assert.equal(okPdfRes.status, 200);
  assert.equal(fs.existsSync(path.join(rootDir, "Sets", "75300.pdf")), true);
});
