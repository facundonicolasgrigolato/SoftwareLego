import * as THREE from "three";
import { LIGHTWEIGHT_RENDER_THRESHOLD, MAX_SUPPORTED_PIECES, PILE_BATCH_SIZE } from "../core/constants.js";
import { computeTableLayout } from "../core/tableLayout.js";
import {
  clearStickersFromMesh,
  detachPlacedPiece,
  movePlacedPieceToPile,
  refreshPlacedWorldBox,
  spawnPileItemFromData,
  spawnPlacedPieceFromData,
} from "../builder/worldTransitions.js";

function serializeVec3(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function serializeQuat(q) {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function isFiniteVec3(v) {
  return Boolean(v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
}

function isFiniteQuat(q) {
  return Boolean(
    q &&
      Number.isFinite(q.x) &&
      Number.isFinite(q.y) &&
      Number.isFinite(q.z) &&
      Number.isFinite(q.w)
  );
}

export function exportWorldSnapshot(bc) {
  return {
    nextInstanceSeq: bc.nextInstanceSeq,
    customBoxCount: bc.customBoxCount ?? null,
    pendingPool: bc.pendingPool.map((it) => ({
      elementId: it.elementId,
      bagNumber: it.bagNumber || 1,
      origBagNumber: it.origBagNumber ?? it.bagNumber ?? 1,
    })),
    placed: bc.placedPieces.map((p) => ({
      instanceId: p.instanceId,
      elementId: p.elementId,
      bagNumber: p.mesh.userData.bagNumber || 1,
      origBagNumber: p.mesh.userData.origBagNumber ?? p.mesh.userData.bagNumber ?? 1,
      position: serializeVec3(p.mesh.position),
      rotation: serializeVec3(p.mesh.rotation),
      ...(Array.isArray(p.stickers) && p.stickers.length
        ? { stickers: structuredClone(p.stickers) }
        : {}),
    })),
    pile: bc.pilePhysics.items.map((it) => ({
      instanceId: it.instanceId,
      elementId: it.elementId,
      bagNumber: it.bagNumber || 1,
      origBagNumber: it.origBagNumber ?? it.mesh?.userData?.origBagNumber ?? it.bagNumber ?? 1,
      position: serializeVec3(it.mesh.position),
      quaternion: serializeQuat(it.mesh.quaternion),
    })),
  };
}

export async function loadWorldSnapshot(
  bc,
  manifest,
  snapshot,
  { passivePhysics = true } = {}
) {
  bc.clearWorkspace(false);
  bc.manifest = manifest;
  bc.customBoxCount = bc.normalizeCustomBoxCount(snapshot?.customBoxCount);
  const resolvedParts = (manifest.parts || []).filter(
    (p) => p.status !== "unresolved" && p.ldraw_part_id
  );
  const totalCount = resolvedParts.reduce((acc, p) => acc + p.quantity, 0);
  if (totalCount > MAX_SUPPORTED_PIECES) {
    throw new Error(`El set supera el límite seguro de ${MAX_SUPPORTED_PIECES} piezas.`);
  }

  bc.partsByElementId.clear();
  bc._partOrderMap?.clear();
  bc.failedElementIds.clear();
  bc.pendingPool = Array.isArray(snapshot?.pendingPool)
    ? snapshot.pendingPool.map((it) => ({ ...it }))
    : [];
  bc.isLightweightSet = totalCount >= LIGHTWEIGHT_RENDER_THRESHOLD;
  bc.nextInstanceSeq = Number(snapshot?.nextInstanceSeq) || 1;

  resolvedParts.forEach((part, idx) => {
    bc.partsByElementId.set(part.element_id, part);
    bc._partOrderMap?.set(part.element_id, idx);
  });

  const placedList = Array.isArray(snapshot?.placed) ? snapshot.placed : [];
  const pileList = Array.isArray(snapshot?.pile) ? snapshot.pile : [];
  if (bc.customBoxCount != null) {
    bc.effectiveManifest = bc._buildBalancedEffectiveManifest(
      manifest,
      bc.customBoxCount,
      [...pileList, ...bc.pendingPool]
    );
  } else {
    bc.effectiveManifest = manifest;
  }

  bc.tableLayout = computeTableLayout(bc.effectiveManifest);
  bc.sceneManager.applyTableLayout(bc.tableLayout);
  bc.pilePhysics.passiveMode = Boolean(passivePhysics);
  bc.pilePhysics.setBagZones(bc.tableLayout.bagZones);
  const grandTotal = placedList.length + pileList.length;
  let loadedCount = 0;

  // 1. Cargamos piezas colocadas
  for (const item of placedList) {
    const part = bc.partsByElementId.get(item.elementId);
    if (!part) continue;
    try {
      const { group, localBox } = await bc.ldrawService.createPartInstance(part, {
        lightweight: bc.isLightweightSet,
        proxyOnly: true,
      });
      group.position.set(item.position.x, item.position.y, item.position.z);
      group.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
      group.userData.instanceId = item.instanceId;
      group.userData.elementId = item.elementId;
      group.userData.bagNumber = item.bagNumber || bc._getDefaultBagForElement(item.elementId);

      const piece = {
        instanceId: item.instanceId,
        elementId: item.elementId,
        mesh: group,
        localBox,
        stickers: [],
      };
      if (Array.isArray(item.stickers)) {
        for (const st of item.stickers) {
          if (st?.faceKey && st?.dataUrl) {
            bc._attachStickerToPiece(piece, st);
          }
        }
      }
      bc.sceneManager.addPlacedMesh(group);
      bc._refreshPlacedWorldBox(piece);
      bc.placedPieces.push(piece);
    } catch {
      bc.failedElementIds.add(part.element_id);
    }
    loadedCount += 1;
    if (loadedCount % 25 === 0 || loadedCount === grandTotal) {
      bc.callbacks.onProgress?.(loadedCount, grandTotal, `Sincronizando mesa (${loadedCount}/${grandTotal})...`);
    }
  }

  // 2. Cargamos piezas en cajas por tandas para no trabar el hilo UI
  const CHUNK = 60;
  for (let start = 0; start < pileList.length; start += CHUNK) {
    const slice = pileList.slice(start, start + CHUNK);
    await Promise.all(
      slice.map(async (item) => {
        const part = bc.partsByElementId.get(item.elementId);
        if (!part) return;
        try {
          const { group, localBox } = await bc.ldrawService.createPartInstance(part, {
            lightweight: bc.isLightweightSet,
            proxyOnly: true,
          });
          const bagNum = item.bagNumber || bc._getDefaultBagForElement(item.elementId);
          const origBag = item.origBagNumber ?? bagNum;
          group.userData.instanceId = item.instanceId;
          group.userData.elementId = item.elementId;
          group.userData.bagNumber = bagNum;
          group.userData.origBagNumber = origBag;
          group.position.set(item.position.x, item.position.y, item.position.z);
          if (item.quaternion) {
            group.quaternion.set(
              item.quaternion.x,
              item.quaternion.y,
              item.quaternion.z,
              item.quaternion.w
            );
          }
          bc.pilePhysics.addPiece(
            item.instanceId,
            item.elementId,
            group,
            localBox,
            item.position,
            true,
            bagNum,
            origBag
          );
          const addedEntry = bc.pilePhysics.items[bc.pilePhysics.items.length - 1];
          if (addedEntry && item.quaternion) {
            addedEntry.body.quaternion.set(
              item.quaternion.x,
              item.quaternion.y,
              item.quaternion.z,
              item.quaternion.w
            );
            addedEntry.mesh.quaternion.copy(group.quaternion);
          }
          bc.sceneManager.addPileMesh(group);
        } catch {
          bc.failedElementIds.add(part.element_id);
        }
        loadedCount += 1;
      })
    );
    bc.callbacks.onProgress?.(loadedCount, grandTotal, `Sincronizando bolsas (${loadedCount}/${grandTotal})...`);
    if (start + CHUNK < pileList.length) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  bc.callbacks.onProgress?.(0, 0, "");
  bc._emitChange();
}

function removeFromPool(bc, elementId) {
  const idx = bc.pendingPool.findIndex((it) => it.elementId === elementId);
  if (idx === -1) return null;
  const [entry] = bc.pendingPool.splice(idx, 1);
  return entry;
}

/**
 * Ejecuta en el Host autoritativo una operación solicitada por un invitado.
 * Devuelve el evento `world:op` (o `null`) para retransmitir a todos los invitados.
 */
export async function applyGuestOpOnHost(bc, msg) {
  if (!msg || !msg.op) return null;

  if (msg.op === "shake") {
    bc.pilePhysics.shakeAll();
    return null;
  }

  if (msg.op === "pile-drag") {
    const entry = bc.pilePhysics.items.find((it) => it.instanceId === msg.instanceId);
    if (entry && Number.isFinite(msg.x) && Number.isFinite(msg.y) && Number.isFinite(msg.z)) {
      bc.pilePhysics.dragBodyToward(entry, msg.x, msg.y, msg.z);
    }
    return null;
  }

  if (msg.op === "drop-batch") {
    await bc.dropNextBatch(msg.count || PILE_BATCH_SIZE);
    return null;
  }

  if (msg.op === "place-pool") {
    if (!isFiniteVec3(msg.position) || (!msg.intoPile && !isFiniteVec3(msg.rotation))) return null;
    const part = bc.partsByElementId.get(msg.elementId);
    if (!part || bc.getRemainingCount(msg.elementId) <= 0) return null;
    const poolEntry = removeFromPool(bc, msg.elementId);
    const { group, localBox } = await bc.ldrawService.createPartInstance(part, {
      lightweight: bc.isLightweightSet,
      proxyOnly: true,
    });
    const bagNum = poolEntry?.bagNumber || bc._getDefaultBagForElement(msg.elementId);

    if (msg.intoPile) {
      const pileId = `pile_${bc.nextInstanceSeq++}`;
      group.userData.instanceId = pileId;
      group.userData.elementId = msg.elementId;
      group.userData.bagNumber = bagNum;
      bc.pilePhysics.addPiece(
        pileId,
        msg.elementId,
        group,
        localBox,
        { x: msg.position.x, y: Math.max(30, msg.position.y), z: msg.position.z },
        false,
        bagNum
      );
      bc.sceneManager.addPileMesh(group);
      bc._emitChange();
      return {
        type: "world:op",
        op: "spawn-pile",
        nextInstanceSeq: bc.nextInstanceSeq,
        consumePoolElementId: poolEntry ? msg.elementId : null,
        item: {
          instanceId: pileId,
          elementId: msg.elementId,
          bagNumber: bagNum,
          position: serializeVec3(group.position),
          quaternion: serializeQuat(group.quaternion),
        },
      };
    }

    const instanceId = `p_${bc.nextInstanceSeq++}`;
    group.position.set(msg.position.x, msg.position.y, msg.position.z);
    group.rotation.set(msg.rotation.x, msg.rotation.y, msg.rotation.z);
    group.userData.instanceId = instanceId;
    group.userData.elementId = msg.elementId;
    group.userData.bagNumber = bagNum;
    bc.sceneManager.addPlacedMesh(group);
    const placed = { instanceId, elementId: msg.elementId, mesh: group, localBox };
    bc._refreshPlacedWorldBox(placed);
    bc.placedPieces.push(placed);
    bc.history.push({
      type: "add",
      instanceId,
      elementId: msg.elementId,
      position: group.position.clone(),
      rotation: group.rotation.clone(),
    });
    bc._emitChange();
    return {
      type: "world:op",
      op: "add-placed",
      nextInstanceSeq: bc.nextInstanceSeq,
      consumePoolElementId: poolEntry ? msg.elementId : null,
      piece: {
        instanceId,
        elementId: msg.elementId,
        bagNumber: bagNum,
        position: serializeVec3(group.position),
        rotation: serializeVec3(group.rotation),
      },
    };
  }

  if (msg.op === "pile-to-placed") {
    if (!isFiniteVec3(msg.position) || !isFiniteVec3(msg.rotation)) return null;
    const removed = bc.pilePhysics.removePiece(msg.pileInstanceId);
    if (!removed) return null;
    bc.sceneManager.removePileMesh(removed.mesh);
    bc.pilePhysics.wakeNearby(removed.mesh.position, 110);

    const instanceId = `p_${bc.nextInstanceSeq++}`;
    removed.mesh.position.set(msg.position.x, msg.position.y, msg.position.z);
    removed.mesh.rotation.set(msg.rotation.x, msg.rotation.y, msg.rotation.z);
    removed.mesh.visible = true;
    removed.mesh.userData.instanceId = instanceId;
    removed.mesh.userData.elementId = removed.elementId;
    bc.sceneManager.addPlacedMesh(removed.mesh);
    const placed = {
      instanceId,
      elementId: removed.elementId,
      mesh: removed.mesh,
      localBox: removed.localBox,
    };
    bc._refreshPlacedWorldBox(placed);
    bc.placedPieces.push(placed);
    bc.history.push({
      type: "add",
      instanceId,
      elementId: removed.elementId,
      position: removed.mesh.position.clone(),
      rotation: removed.mesh.rotation.clone(),
    });
    bc._emitChange();
    return {
      type: "world:op",
      op: "pile-to-placed",
      nextInstanceSeq: bc.nextInstanceSeq,
      pileInstanceId: msg.pileInstanceId,
      piece: {
        instanceId,
        elementId: removed.elementId,
        bagNumber: removed.bagNumber || 1,
        position: serializeVec3(removed.mesh.position),
        rotation: serializeVec3(removed.mesh.rotation),
      },
    };
  }

  if (msg.op === "move-pile-drop") {
    if (!isFiniteVec3(msg.position)) return null;
    const entry = bc.pilePhysics.items.find((it) => it.instanceId === msg.pileInstanceId);
    if (!entry) return null;
    entry.body.position.set(msg.position.x, Math.max(30, msg.position.y), msg.position.z);
    entry.body.velocity.set(0, 0, 0);
    entry.body.angularVelocity.set(0, 0, 0);
    entry.body.wakeUp();
    return null;
  }

  if (msg.op === "move-placed") {
    if (!isFiniteVec3(msg.position) || !isFiniteVec3(msg.rotation)) return null;
    const piece = bc.placedPieces.find((p) => p.instanceId === msg.instanceId);
    if (!piece) return null;
    const prevState = {
      position: piece.mesh.position.clone(),
      rotation: piece.mesh.rotation.clone(),
    };
    piece.mesh.position.set(msg.position.x, msg.position.y, msg.position.z);
    piece.mesh.rotation.set(msg.rotation.x, msg.rotation.y, msg.rotation.z);
    bc.sceneManager.setPlacedVisible(piece.mesh, true);
    bc._refreshPlacedWorldBox(piece);
    if (bc.selected?.item === piece) bc.sceneManager.refreshSelectionBox();
    bc.history.push({
      type: "move",
      instanceId: piece.instanceId,
      prevState,
      newState: { position: piece.mesh.position.clone(), rotation: piece.mesh.rotation.clone() },
    });
    bc._emitChange();
    return {
      type: "world:op",
      op: "move-placed",
      instanceId: piece.instanceId,
      position: serializeVec3(piece.mesh.position),
      rotation: serializeVec3(piece.mesh.rotation),
    };
  }

  if (msg.op === "move-group") {
    const moveRecords = [];
    const outItems = [];
    for (const rec of msg.items || []) {
      if (!isFiniteVec3(rec?.position) || !isFiniteVec3(rec?.rotation)) continue;
      const p = bc.placedPieces.find((x) => x.instanceId === rec.instanceId);
      if (!p) continue;
      const origPos = p.mesh.position.clone();
      const origRot = p.mesh.rotation.clone();
      p.mesh.position.set(rec.position.x, rec.position.y, rec.position.z);
      p.mesh.rotation.set(rec.rotation.x, rec.rotation.y, rec.rotation.z);
      bc.sceneManager.setPlacedVisible(p.mesh, true);
      bc._refreshPlacedWorldBox(p);
      moveRecords.push({
        instanceId: p.instanceId,
        prevState: { position: origPos, rotation: origRot },
        newState: { position: p.mesh.position.clone(), rotation: p.mesh.rotation.clone() },
      });
      outItems.push({
        instanceId: p.instanceId,
        position: serializeVec3(p.mesh.position),
        rotation: serializeVec3(p.mesh.rotation),
      });
    }
    if (!outItems.length) return null;
    if (bc.selected?.kind === "group") bc.sceneManager.refreshSelectionBox();
    bc.history.push({ type: "move-group", items: moveRecords });
    bc._emitChange();
    return { type: "world:op", op: "move-group", items: outItems };
  }

  if (msg.op === "to-pile") {
    const target = bc.placedPieces.find((p) => p.instanceId === msg.instanceId);
    if (!target) return null;
    if (bc.selected?.item === target) bc.clearSelection();
    const dropPos = msg.position
      ? { x: msg.position.x, y: Math.max(30, msg.position.y), z: msg.position.z }
      : null;
    const { undoEntry, netPileItem } = movePlacedPieceToPile(bc, target, { dropPos });

    bc.history.push({ type: "remove", ...undoEntry });
    bc._emitChange();
    return {
      type: "world:op",
      op: "placed-to-pile",
      nextInstanceSeq: bc.nextInstanceSeq,
      removedInstanceId: target.instanceId,
      pileItem: netPileItem,
    };
  }

  if (msg.op === "to-pile-group") {
    const items = (msg.instanceIds || [])
      .map((id) => bc.placedPieces.find((p) => p.instanceId === id))
      .filter(Boolean);
    if (!items.length) return null;
    const removedIds = new Set(items.map((p) => p.instanceId));
    if (bc.selected?.kind === "group" && bc.selected.items.some((p) => removedIds.has(p.instanceId))) {
      bc.clearSelection();
    } else if (bc.selected?.item && removedIds.has(bc.selected.item.instanceId)) {
      bc.clearSelection();
    }
    bc.placedPieces = bc.placedPieces.filter((p) => !removedIds.has(p.instanceId));

    const dropPos = msg.position
      ? { x: msg.position.x, y: Math.max(30, msg.position.y), z: msg.position.z }
      : null;
    const undoItems = [];
    const pileItems = [];
    for (const target of items) {
      const { undoEntry, netPileItem } = movePlacedPieceToPile(bc, target, {
        dropPos,
        filterPlaced: false,
      });
      undoItems.push(undoEntry);
      pileItems.push(netPileItem);
    }
    bc.history.push({ type: "remove-group", items: undoItems });
    bc._emitChange();
    return {
      type: "world:op",
      op: "placed-group-to-pile",
      nextInstanceSeq: bc.nextInstanceSeq,
      removedInstanceIds: [...removedIds],
      pileItems,
    };
  }

  return null;
}

/**
 * Aplica en el Invitado una operación confirmada/emitida por el Host.
 */
export async function applyWorldOpOnGuest(bc, msg) {
  if (!msg || msg.type !== "world:op") return;
  if (Number(msg.nextInstanceSeq) > bc.nextInstanceSeq) {
    bc.nextInstanceSeq = Number(msg.nextInstanceSeq);
  }

  if (msg.consumePoolElementId) {
    removeFromPool(bc, msg.consumePoolElementId);
  }

  const spawnPlacedPiece = (pData) => spawnPlacedPieceFromData(bc, pData);
  const spawnPileItem = (itData) => spawnPileItemFromData(bc, itData, isFiniteQuat);

  switch (msg.op) {
    case "add-placed":
      await spawnPlacedPiece(msg.piece);
      break;

    case "spawn-pile":
      await spawnPileItem(msg.item);
      break;

    case "pile-to-placed": {
      const removed = bc.pilePhysics.removePiece(msg.pileInstanceId);
      if (removed) {
        bc.sceneManager.removePileMesh(removed.mesh);
      }
      await spawnPlacedPiece(msg.piece);
      break;
    }

    case "move-placed": {
      const piece = bc.placedPieces.find((p) => p.instanceId === msg.instanceId);
      if (piece) {
        piece.mesh.position.set(msg.position.x, msg.position.y, msg.position.z);
        piece.mesh.rotation.set(msg.rotation.x, msg.rotation.y, msg.rotation.z);
        bc.sceneManager.setPlacedVisible(piece.mesh, true);
        refreshPlacedWorldBox(bc, piece);
        if (bc.selected?.item === piece) bc.sceneManager.refreshSelectionBox();
      }
      break;
    }

    case "move-group": {
      for (const rec of msg.items || []) {
        const piece = bc.placedPieces.find((p) => p.instanceId === rec.instanceId);
        if (!piece) continue;
        piece.mesh.position.set(rec.position.x, rec.position.y, rec.position.z);
        piece.mesh.rotation.set(rec.rotation.x, rec.rotation.y, rec.rotation.z);
        bc.sceneManager.setPlacedVisible(piece.mesh, true);
        refreshPlacedWorldBox(bc, piece);
      }
      if (bc.selected?.kind === "group") bc.sceneManager.refreshSelectionBox();
      break;
    }

    case "placed-to-pile": {
      const target = bc.placedPieces.find((p) => p.instanceId === msg.removedInstanceId);
      if (target) {
        if (bc.selected?.item === target) bc.clearSelection();
        detachPlacedPiece(bc, target);
        bc.placedPieces = bc.placedPieces.filter((p) => p.instanceId !== target.instanceId);
      }
      await spawnPileItem(msg.pileItem);
      break;
    }

    case "placed-group-to-pile": {
      const remSet = new Set(msg.removedInstanceIds || []);
      if (bc.selected?.kind === "group" && bc.selected.items.some((p) => remSet.has(p.instanceId))) {
        bc.clearSelection();
      } else if (bc.selected?.item && remSet.has(bc.selected.item.instanceId)) {
        bc.clearSelection();
      }
      for (const target of bc.placedPieces) {
        if (!remSet.has(target.instanceId)) continue;
        detachPlacedPiece(bc, target);
      }
      bc.placedPieces = bc.placedPieces.filter((p) => !remSet.has(p.instanceId));
      for (const it of msg.pileItems || []) {
        await spawnPileItem(it);
      }
      break;
    }

    case "pile-drop-batch": {
      if (Array.isArray(msg.pendingPool)) {
        bc.pendingPool = msg.pendingPool.map((it) => ({ ...it }));
      }
      for (const it of msg.spawned || []) {
        await spawnPileItem(it);
      }
      break;
    }

    case "sticker-add": {
      const piece = bc.placedPieces.find((p) => p.instanceId === msg.instanceId);
      if (piece && msg.sticker) bc._attachStickerToPiece(piece, msg.sticker);
      break;
    }

    case "sticker-remove": {
      const piece = bc.placedPieces.find((p) => p.instanceId === msg.instanceId);
      if (piece && msg.faceKey) bc._detachStickerFromPiece(piece, msg.faceKey);
      break;
    }
  }

  bc._emitChange();
}
