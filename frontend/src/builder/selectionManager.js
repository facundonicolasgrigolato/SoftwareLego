import * as THREE from "three";
import { computeSupportDistanceAlongDir } from "./gridSnap.js";
import { transformConnector } from "./connectors.js";
import { refreshPlacedWorldBox } from "./worldTransitions.js";

const WORLD_Y = new THREE.Vector3(0, 1, 0);

export function collectSelectedLockIds(sel) {
  if (!sel) return [];
  if (sel.kind === "placed" && sel.item?.instanceId) return [sel.item.instanceId];
  if (sel.kind === "pile" && sel.item?.instanceId) return [sel.item.instanceId];
  if (sel.kind === "group" && Array.isArray(sel.items)) {
    return sel.items.map((p) => p.instanceId).filter(Boolean);
  }
  return [];
}

export function collectCarryLockIds(c) {
  if (!c) return [];
  if (c.source === "pile" && c.origEntry?.instanceId) return [c.origEntry.instanceId];
  if (c.source === "placed" && c.origPlaced?.instanceId) return [c.origPlaced.instanceId];
  if (c.source === "group" && Array.isArray(c.origGroup)) {
    return c.origGroup.map((e) => e.piece.instanceId).filter(Boolean);
  }
  return [];
}

export function clearSelectionState(bc) {
  const oldIds = !bc._keepLockOnSelectionClear ? collectSelectedLockIds(bc.selected) : [];
  bc.selected = null;
  bc.sceneManager.setSelectionBox(null);
  if (oldIds.length && bc.roomManager?.isOpen()) {
    bc.roomManager.releaseLocks(oldIds);
  }
  bc._emitStatus();
}

export function selectPlacedPiece(bc, piece) {
  if (!bc._ensureNotLocked([piece.instanceId])) return;
  const oldIds = collectSelectedLockIds(bc.selected);
  if (oldIds.length) bc.roomManager?.releaseLocks(oldIds);
  bc.selected = { kind: "placed", item: piece };
  bc.sceneManager.setSelectionBox(piece.mesh);
  bc.roomManager?.requestLock([piece.instanceId]);
  bc._emitStatus();
}

export function selectPlacedGroup(bc, items) {
  const unique = [];
  const seen = new Set();
  for (const p of items) {
    if (p && !seen.has(p.instanceId) && !bc._getLockOwner(p.instanceId)) {
      seen.add(p.instanceId);
      unique.push(p);
    }
  }
  if (!unique.length) {
    clearSelectionState(bc);
    return;
  }
  if (unique.length === 1) {
    selectPlacedPiece(bc, unique[0]);
    return;
  }
  const oldIds = collectSelectedLockIds(bc.selected);
  if (oldIds.length) bc.roomManager?.releaseLocks(oldIds);
  bc.selected = { kind: "group", items: unique };
  bc.sceneManager.setSelectionBox(unique.map((p) => p.mesh));
  bc.roomManager?.requestLock(unique.map((p) => p.instanceId));
  bc._emitStatus();
}

export function selectPileEntry(bc, entry) {
  if (!bc._ensureNotLocked([entry.instanceId])) return;
  const oldIds = collectSelectedLockIds(bc.selected);
  if (oldIds.length) bc.roomManager?.releaseLocks(oldIds);
  bc.selected = { kind: "pile", item: entry };
  bc.sceneManager.setSelectionBox(entry.mesh);
  bc.roomManager?.requestLock([entry.instanceId]);
  bc._emitStatus();
}

/**
 * Selecciona TODAS las piezas colocadas cuyo volumen 3D caiga dentro del frustum del recuadro.
 */
export function selectGroupInScreenRect(bc, rect, additive = false) {
  if (bc.carry) return;
  const cam = bc.sceneManager.camera;
  cam.updateMatrixWorld();
  const domRect = bc.sceneManager.renderer.domElement.getBoundingClientRect();
  if (!domRect.width || !domRect.height) return;

  const rLeft = Math.min(rect.left, rect.right);
  const rRight = Math.max(rect.left, rect.right);
  const rTop = Math.min(rect.top, rect.bottom);
  const rBottom = Math.max(rect.top, rect.bottom);
  const rArea = Math.max(1, (rRight - rLeft) * (rBottom - rTop));

  const nx0 = ((rLeft - domRect.left) / domRect.width) * 2 - 1;
  const nx1 = ((rRight - domRect.left) / domRect.width) * 2 - 1;
  const ny1 = -((rTop - domRect.top) / domRect.height) * 2 + 1;
  const ny0 = -((rBottom - domRect.top) / domRect.height) * 2 + 1;

  const nTL = new THREE.Vector3(nx0, ny1, -1).unproject(cam);
  const nTR = new THREE.Vector3(nx1, ny1, -1).unproject(cam);
  const nBL = new THREE.Vector3(nx0, ny0, -1).unproject(cam);
  const nBR = new THREE.Vector3(nx1, ny0, -1).unproject(cam);
  const fTL = new THREE.Vector3(nx0, ny1, 1).unproject(cam);
  const fTR = new THREE.Vector3(nx1, ny1, 1).unproject(cam);
  const fBL = new THREE.Vector3(nx0, ny0, 1).unproject(cam);
  const fBR = new THREE.Vector3(nx1, ny0, 1).unproject(cam);

  const interiorPt = new THREE.Vector3()
    .add(nTL)
    .add(nBR)
    .multiplyScalar(0.25)
    .addScaledVector(fTL, 0.25)
    .addScaledVector(fBR, 0.25);

  const makeInwardPlane = (a, b, c) => {
    const p = new THREE.Plane().setFromCoplanarPoints(a, b, c);
    if (p.distanceToPoint(interiorPt) < 0) p.negate();
    return p;
  };

  const frustum = new THREE.Frustum(
    makeInwardPlane(nTL, nBL, fTL),
    makeInwardPlane(nTR, fTR, nBR),
    makeInwardPlane(nTL, fTL, nTR),
    makeInwardPlane(nBL, nBR, fBL),
    makeInwardPlane(nTL, nTR, nBL),
    makeInwardPlane(fTL, fBL, fTR)
  );

  const hits = [];
  const sample = new THREE.Vector3();

  for (const piece of bc.placedPieces) {
    if (!piece.worldBox || piece.worldBox.isEmpty()) {
      refreshPlacedWorldBox(bc, piece);
    }
    const wb = piece.worldBox;
    if (!wb || wb.isEmpty()) continue;
    if (!frustum.intersectsBox(wb)) continue;

    const stepsX = 5;
    const stepsY = 3;
    const stepsZ = 5;
    let frontCount = 0;
    let insideCount = 0;
    let minSX = Infinity;
    let maxSX = -Infinity;
    let minSY = Infinity;
    let maxSY = -Infinity;

    for (let ix = 0; ix < stepsX; ix += 1) {
      const tx = ix / (stepsX - 1);
      const px = wb.min.x + (wb.max.x - wb.min.x) * tx;
      for (let iy = 0; iy < stepsY; iy += 1) {
        const ty = iy / (stepsY - 1);
        const py = wb.min.y + (wb.max.y - wb.min.y) * ty;
        for (let iz = 0; iz < stepsZ; iz += 1) {
          const tz = iz / (stepsZ - 1);
          const pz = wb.min.z + (wb.max.z - wb.min.z) * tz;
          sample.set(px, py, pz).project(cam);
          if (sample.z < -1 || sample.z > 1) continue;
          frontCount += 1;
          const sx = domRect.left + ((sample.x + 1) * 0.5) * domRect.width;
          const sy = domRect.top + ((-sample.y + 1) * 0.5) * domRect.height;
          if (sx >= rLeft && sx <= rRight && sy >= rTop && sy <= rBottom) {
            insideCount += 1;
          }
          if (sx < minSX) minSX = sx;
          if (sx > maxSX) maxSX = sx;
          if (sy < minSY) minSY = sy;
          if (sy > maxSY) maxSY = sy;
        }
      }
    }

    if (frontCount === 0) continue;

    let captured = insideCount / frontCount >= 0.08;
    if (!captured) {
      const iw = Math.max(0, Math.min(rRight, maxSX) - Math.max(rLeft, minSX));
      const ih = Math.max(0, Math.min(rBottom, maxSY) - Math.max(rTop, minSY));
      const interArea = iw * ih;
      const pArea = Math.max(1, (maxSX - minSX) * (maxSY - minSY));
      if (interArea / pArea >= 0.1 || interArea / rArea >= 0.1) {
        captured = true;
      }
    }

    if (captured) {
      hits.push(piece);
    }
  }

  if (additive) {
    const base =
      bc.selected?.kind === "group"
        ? bc.selected.items
        : bc.selected?.kind === "placed"
          ? [bc.selected.item]
          : [];
    selectPlacedGroup(bc, [...base, ...hits]);
  } else {
    selectPlacedGroup(bc, hits);
  }
}

export function toggleGroupPieceAtPoint(bc, clientX, clientY) {
  if (bc.carry) return;
  const hit = bc.sceneManager.raycastWorkspace(clientX, clientY);
  if (!hit || hit.kind !== "placed") return;
  const piece = bc.placedPieces.find((p) => p.mesh === hit.object);
  if (!piece) return;

  const current =
    bc.selected?.kind === "group"
      ? [...bc.selected.items]
      : bc.selected?.kind === "placed"
        ? [bc.selected.item]
        : [];
  const idx = current.findIndex((p) => p.instanceId === piece.instanceId);
  if (idx >= 0) {
    current.splice(idx, 1);
  } else {
    current.push(piece);
  }
  selectPlacedGroup(bc, current);
}

/**
 * Construye pivote, geometría compuesta, studs, receptores inferiores y sub-cajas OBB exactas.
 */
export function buildGroupCompositeData(items) {
  const groupWorldBox = new THREE.Box3();
  for (const p of items) {
    if (p.worldBox) groupWorldBox.union(p.worldBox);
  }
  const gCenter = new THREE.Vector3();
  groupWorldBox.getCenter(gCenter);

  const minWorldY = groupWorldBox.min.y;
  let anchor = items[0];
  let bestScore = Infinity;
  for (const p of items) {
    const wb = p.worldBox || new THREE.Box3().setFromObject(p.mesh);
    const isBase = wb.min.y <= minWorldY + 6;
    const dx = p.mesh.position.x - gCenter.x;
    const dz = p.mesh.position.z - gCenter.z;
    const score = (isBase ? 0 : 1e6) + dx * dx + dz * dz;
    if (score < bestScore) {
      bestScore = score;
      anchor = p;
    }
  }

  const pivotPos = anchor.mesh.position.clone();
  const compositeBoxes = [];
  const compositeStuds = [];
  const compositeAntiStuds = [];
  const compositeConnectors = [];
  const compositeMeshData = [];
  const localBox = new THREE.Box3();
  const tmpBox = new THREE.Box3();
  const entries = [];
  const supportList = [];
  const tmpUp = new THREE.Vector3();

  for (const p of items) {
    const relPos = p.mesh.position.clone().sub(pivotPos);
    const relQuat = p.mesh.quaternion.clone();
    const boxes = p.mesh.userData.collisionBoxes || [p.localBox];
    const mat = new THREE.Matrix4().compose(relPos, relQuat, new THREE.Vector3(1, 1, 1));

    for (const b of boxes) {
      compositeBoxes.push({
        box: b.clone(),
        localPos: relPos.clone(),
        localQuat: relQuat.clone(),
      });
    }
    compositeMeshData.push({
      boundsBox: p.localBox.clone(),
      collisionBoxes: boxes,
      collisionMeshData: p.mesh.userData.collisionMeshData || null,
      localPos: relPos.clone(),
      localQuat: relQuat.clone(),
    });
    tmpBox.copy(p.localBox).applyMatrix4(mat);
    localBox.union(tmpBox);

    for (const s of p.mesh.userData.topStuds || []) {
      compositeStuds.push({
        pos: s.pos.clone().applyQuaternion(relQuat).add(relPos),
        up: s.up.clone().applyQuaternion(relQuat).normalize(),
        height: s.height,
      });
    }

    for (const a of p.mesh.userData.antiStuds || []) {
      compositeAntiStuds.push({
        pos: a.pos.clone().applyQuaternion(relQuat).add(relPos),
        dir: a.dir.clone().applyQuaternion(relQuat).normalize(),
      });
    }

    for (const conn of p.mesh.userData.connectors || []) {
      compositeConnectors.push(transformConnector(conn, relQuat, relPos));
    }

    tmpUp.set(0, 1, 0).applyQuaternion(relQuat);
    let supportDistY;
    let pieceReceptors;
    if (tmpUp.y > 0.85) {
      const defY = p.mesh.userData.defaultSupportUndersideY ?? p.localBox.min.y;
      supportDistY = -defY;
      const recs = p.mesh.userData.bottomReceptors || [new THREE.Vector3(0, defY, 0)];
      pieceReceptors = recs.map((r) => r.clone().applyQuaternion(relQuat).add(relPos));
    } else {
      supportDistY = computeSupportDistanceAlongDir(boxes, relQuat, WORLD_Y);
      const pc = new THREE.Vector3();
      tmpBox.getCenter(pc);
      pieceReceptors = [new THREE.Vector3(pc.x, relPos.y - supportDistY, pc.z)];
    }
    const supportLocalY = relPos.y - supportDistY;
    supportList.push({ supportLocalY, pieceReceptors });

    entries.push({
      piece: p,
      relPos,
      relQuat,
      origPos: p.mesh.position.clone(),
      origRot: p.mesh.rotation.clone(),
      origQuat: p.mesh.quaternion.clone(),
    });
  }

  const minSupportLocalY = Math.min(...supportList.map((s) => s.supportLocalY));
  const bottomReceptors = [];
  for (const s of supportList) {
    if (s.supportLocalY <= minSupportLocalY + 2.5) {
      for (const r of s.pieceReceptors) {
        bottomReceptors.push(new THREE.Vector3(r.x, minSupportLocalY, r.z));
      }
    }
  }
  if (!bottomReceptors.length) {
    bottomReceptors.push(new THREE.Vector3(0, minSupportLocalY, 0));
  }

  return {
    pivotPos,
    groupWorldBox,
    entries,
    localBox,
    compositeBoxes,
    compositeStuds,
    compositeAntiStuds,
    compositeConnectors,
    compositeMeshData,
    bottomReceptors,
    defaultSupportUndersideY: minSupportLocalY,
  };
}
