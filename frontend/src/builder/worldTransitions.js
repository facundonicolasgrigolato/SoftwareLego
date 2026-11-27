import { computeTransformedWorldBox } from "./collision.js";
import { createStickerMesh, disposeStickerMesh } from "./stickerDecal.js";

/**
 * Elimina todos los meshes de sticker adheridos a un mesh de pieza.
 */
export function clearStickersFromMesh(mesh) {
  if (!mesh) return;
  const toRemove = mesh.children.filter((c) => c.userData?.isSticker);
  for (const child of toRemove) {
    mesh.remove(child);
    disposeStickerMesh(child);
  }
}

/**
 * Quita el sticker de una cara específica y devuelve su descriptor guardado si existía.
 */
export function detachStickerFromPiece(bc, piece, faceKey) {
  if (!piece || !faceKey) return null;
  const existingData = Array.isArray(piece.stickers)
    ? piece.stickers.find((s) => s.faceKey === faceKey) || null
    : null;
  if (Array.isArray(piece.stickers)) {
    piece.stickers = piece.stickers.filter((s) => s.faceKey !== faceKey);
  }
  const existingMesh = piece.mesh.children.find(
    (c) => c.userData?.isSticker && c.userData.stickerFaceKey === faceKey
  );
  if (existingMesh) {
    piece.mesh.remove(existingMesh);
    disposeStickerMesh(existingMesh);
    bc.sceneManager.invalidateShadows();
  }
  return existingData ? structuredClone(existingData) : null;
}

/**
 * Adjunta o reemplaza un sticker en una cara de una pieza colocada.
 */
export function attachStickerToPiece(bc, piece, stickerData) {
  if (!piece || !stickerData?.faceKey || !stickerData?.dataUrl) return;
  bc.sceneManager.promotePlacedMeshToIndividual(piece.mesh);
  detachStickerFromPiece(bc, piece, stickerData.faceKey);
  const stickerMesh = createStickerMesh(stickerData);
  piece.mesh.add(stickerMesh);
  if (!Array.isArray(piece.stickers)) piece.stickers = [];
  piece.stickers.push(structuredClone(stickerData));
  bc.sceneManager.invalidateShadows();
}

/**
 * Recalcula la worldBox de una pieza colocada y sincroniza el batch de escena.
 */
export function refreshPlacedWorldBox(bc, piece) {
  const boxes = piece.mesh.userData.collisionBoxes || [piece.localBox];
  const nextBox = computeTransformedWorldBox(boxes, piece.mesh.position, piece.mesh.quaternion);
  if (piece.worldBox?.isBox3) {
    piece.worldBox.copy(nextBox);
  } else {
    piece.worldBox = nextBox;
  }
  piece.mesh.userData.worldBox = piece.worldBox;
  bc.sceneManager.syncPlacedTransform(piece.mesh);
}

/**
 * Desmonta una pieza colocada de escena y limpia sus stickers locales.
 */
export function detachPlacedPiece(bc, piece) {
  clearStickersFromMesh(piece.mesh);
  piece.stickers = [];
  bc.sceneManager.removePlacedMesh(piece.mesh);
}

export function serializePileItemPayload(pileId, elementId, bagNumber, mesh) {
  return {
    instanceId: pileId,
    elementId,
    bagNumber,
    position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
    quaternion: { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
  };
}

/**
 * Transiciona una pieza colocada hacia la pila física (local o disparada por Host).
 */
export function movePlacedPieceToPile(
  bc,
  target,
  { dropPos = null, randomTilt = !dropPos, filterPlaced = true, origPos = null, origRot = null } = {}
) {
  const savedStickers = Array.isArray(target.stickers) ? structuredClone(target.stickers) : [];
  detachPlacedPiece(bc, target);
  if (filterPlaced) {
    bc.placedPieces = bc.placedPieces.filter((p) => p.instanceId !== target.instanceId);
  }

  target.mesh.visible = true;
  const pileId = `pile_${bc.nextInstanceSeq++}`;
  target.mesh.userData.instanceId = pileId;
  const bagNum = target.mesh.userData.bagNumber || bc._getDefaultBagForElement(target.elementId);
  bc.pilePhysics.addPiece(pileId, target.elementId, target.mesh, target.localBox, dropPos, randomTilt, bagNum);
  bc.sceneManager.addPileMesh(target.mesh);

  return {
    pileId,
    bagNum,
    undoEntry: {
      instanceId: target.instanceId,
      pileInstanceId: pileId,
      elementId: target.elementId,
      position: (origPos || target.mesh.position).clone(),
      rotation: (origRot || target.mesh.rotation).clone(),
      stickers: savedStickers,
    },
    netPileItem: serializePileItemPayload(pileId, target.elementId, bagNum, target.mesh),
  };
}

/**
 * Restaura una pieza eliminada/devuelta a la pila hacia su posición colocada original (Undo).
 */
export async function restoreRemovedPieceEntry(bc, entry) {
  let removedFromPile = entry.pileInstanceId
    ? bc.pilePhysics.removePiece(entry.pileInstanceId)
    : null;
  if (!removedFromPile) {
    const match = bc.pilePhysics.items.find((it) => it.elementId === entry.elementId);
    if (match) removedFromPile = bc.pilePhysics.removePiece(match.instanceId);
  }
  let mesh = removedFromPile?.mesh;
  let localBox = removedFromPile?.localBox;
  if (mesh) {
    bc.sceneManager.removePileMesh(mesh);
  } else {
    const poolIdx = bc.pendingPool.findIndex((it) => it.elementId === entry.elementId);
    if (poolIdx !== -1) bc.pendingPool.splice(poolIdx, 1);
    const part = bc.partsByElementId.get(entry.elementId);
    if (!part) return null;
    const created = await bc.ldrawService.createPartInstance(part, {
      lightweight: bc.isLightweightSet,
      proxyOnly: true,
    });
    mesh = created.group;
    localBox = created.localBox;
  }
  mesh.position.copy(entry.position);
  mesh.rotation.copy(entry.rotation);
  mesh.visible = true;
  mesh.userData.instanceId = entry.instanceId;
  const restored = {
    instanceId: entry.instanceId,
    elementId: entry.elementId,
    mesh,
    localBox,
    stickers: [],
  };
  if (Array.isArray(entry.stickers)) {
    for (const st of entry.stickers) {
      if (st?.faceKey && st?.dataUrl) {
        attachStickerToPiece(bc, restored, st);
      }
    }
  }
  bc.sceneManager.addPlacedMesh(mesh);
  refreshPlacedWorldBox(bc, restored);
  bc.placedPieces.push(restored);
  return restored;
}

/**
 * Instancia una pieza colocada en cliente a partir de datos sincronizados del Host.
 */
export async function spawnPlacedPieceFromData(bc, pData) {
  const part = bc.partsByElementId.get(pData.elementId);
  if (!part) return;
  if (bc.placedPieces.some((x) => x.instanceId === pData.instanceId)) return;
  const { group, localBox } = await bc.ldrawService.createPartInstance(part, {
    lightweight: bc.isLightweightSet,
    proxyOnly: true,
  });
  group.position.set(pData.position.x, pData.position.y, pData.position.z);
  group.rotation.set(pData.rotation.x, pData.rotation.y, pData.rotation.z);
  group.userData.instanceId = pData.instanceId;
  group.userData.elementId = pData.elementId;
  group.userData.bagNumber = pData.bagNumber || 1;
  bc.sceneManager.addPlacedMesh(group);
  const placed = { instanceId: pData.instanceId, elementId: pData.elementId, mesh: group, localBox, stickers: [] };
  refreshPlacedWorldBox(bc, placed);
  bc.placedPieces.push(placed);
}

/**
 * Instancia una pieza suelta en la pila física del cliente a partir de datos del Host.
 */
export async function spawnPileItemFromData(bc, itData, isFiniteQuat) {
  const part = bc.partsByElementId.get(itData.elementId);
  if (!part) return;
  if (bc.pilePhysics.items.some((x) => x.instanceId === itData.instanceId)) return;
  const { group, localBox } = await bc.ldrawService.createPartInstance(part, {
    lightweight: bc.isLightweightSet,
    proxyOnly: true,
  });
  const bagNum = itData.bagNumber || 1;
  const hasQuat = isFiniteQuat(itData.quaternion);
  group.userData.instanceId = itData.instanceId;
  group.userData.elementId = itData.elementId;
  group.userData.bagNumber = bagNum;
  group.position.set(itData.position.x, itData.position.y, itData.position.z);
  if (hasQuat) {
    group.quaternion.set(itData.quaternion.x, itData.quaternion.y, itData.quaternion.z, itData.quaternion.w);
  }
  bc.pilePhysics.addPiece(
    itData.instanceId,
    itData.elementId,
    group,
    localBox,
    itData.position,
    !hasQuat,
    bagNum
  );
  bc.sceneManager.addPileMesh(group);
}
