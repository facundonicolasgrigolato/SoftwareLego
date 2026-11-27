import * as THREE from "three";
import {
  attachStickerToPiece,
  detachStickerFromPiece,
  movePlacedPieceToPile,
  refreshPlacedWorldBox,
  restoreRemovedPieceEntry,
} from "./worldTransitions.js";

function finiteOrZero(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function toVec3(v) {
  return new THREE.Vector3(finiteOrZero(v?.x), finiteOrZero(v?.y), finiteOrZero(v?.z));
}

function toEuler(v) {
  const order = typeof (v?.order ?? v?._order) === "string" ? (v.order ?? v._order) : "XYZ";
  return new THREE.Euler(
    finiteOrZero(v?.x ?? v?._x),
    finiteOrZero(v?.y ?? v?._y),
    finiteOrZero(v?.z ?? v?._z),
    order
  );
}

/**
 * Rehidrata la pila de Undo serializada al cargar un slot guardado.
 */
export function deserializeSavedHistory(savedHistory) {
  if (!Array.isArray(savedHistory) || !savedHistory.length) return [];
  return savedHistory.map((act) => {
    if (act.type === "add" || act.type === "remove") {
      return { ...act, position: toVec3(act.position), rotation: toEuler(act.rotation) };
    }
    if (act.type === "move") {
      return {
        ...act,
        prevState: {
          position: toVec3(act.prevState?.position),
          rotation: toEuler(act.prevState?.rotation),
        },
        newState: {
          position: toVec3(act.newState?.position),
          rotation: toEuler(act.newState?.rotation),
        },
      };
    }
    if (act.type === "move-group") {
      return {
        type: "move-group",
        items: (act.items || []).map((rec) => ({
          instanceId: rec.instanceId,
          prevState: {
            position: toVec3(rec.prevState?.position),
            rotation: toEuler(rec.prevState?.rotation),
          },
          newState: {
            position: toVec3(rec.newState?.position),
            rotation: toEuler(rec.newState?.rotation),
          },
        })),
      };
    }
    if (act.type === "remove-group") {
      return {
        type: "remove-group",
        items: (act.items || []).map((e) => ({
          ...e,
          position: toVec3(e.position),
          rotation: toEuler(e.rotation),
        })),
      };
    }
    return act;
  });
}

/**
 * Revierte una entrada de la pila de Undo sobre `bc` (`BuildController`).
 */
export async function executeUndoAction(bc, action) {
  if (!action) return;

  if (action.type === "add") {
    const piece = bc.placedPieces.find((p) => p.instanceId === action.instanceId);
    if (piece) {
      if (
        bc.selected?.item === piece ||
        (bc.selected?.kind === "group" && bc.selected.items.includes(piece))
      ) {
        bc.clearSelection();
      }
      movePlacedPieceToPile(bc, piece, { randomTilt: true });
    }
    return;
  }

  if (action.type === "move") {
    const piece = bc.placedPieces.find((p) => p.instanceId === action.instanceId);
    if (piece) {
      piece.mesh.position.copy(action.prevState.position);
      piece.mesh.rotation.copy(action.prevState.rotation);
      refreshPlacedWorldBox(bc, piece);
      bc.sceneManager.refreshSelectionBox();
    }
    return;
  }

  if (action.type === "move-group") {
    const restoredPieces = [];
    for (const rec of action.items) {
      const piece = bc.placedPieces.find((p) => p.instanceId === rec.instanceId);
      if (piece) {
        piece.mesh.position.copy(rec.prevState.position);
        piece.mesh.rotation.copy(rec.prevState.rotation);
        refreshPlacedWorldBox(bc, piece);
        restoredPieces.push(piece);
      }
    }
    if (restoredPieces.length) {
      bc._selectGroup(restoredPieces);
    }
    return;
  }

  if (action.type === "remove") {
    await restoreRemovedPieceEntry(bc, action);
    return;
  }

  if (action.type === "remove-group") {
    const restoredPieces = [];
    for (const entry of action.items) {
      const restored = await restoreRemovedPieceEntry(bc, entry);
      if (restored) restoredPieces.push(restored);
    }
    if (restoredPieces.length) {
      bc._selectGroup(restoredPieces);
    }
    return;
  }

  if (action.type === "sticker-add") {
    const piece = bc.placedPieces.find((p) => p.instanceId === action.instanceId);
    if (piece) {
      detachStickerFromPiece(bc, piece, action.faceKey);
      if (action.prevSticker?.dataUrl) {
        attachStickerToPiece(bc, piece, action.prevSticker);
      }
    }
    return;
  }

  if (action.type === "sticker-remove") {
    const piece = bc.placedPieces.find((p) => p.instanceId === action.instanceId);
    if (piece && action.sticker?.dataUrl) {
      attachStickerToPiece(bc, piece, action.sticker);
    }
  }
}
