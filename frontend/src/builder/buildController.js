import * as THREE from "three";
import {
  LDU_HALF_PLATE,
  LDU_HALF_STUD,
  LDU_PLATE,
  LDU_STUD,
  LIGHTWEIGHT_RENDER_THRESHOLD,
  MAX_SUPPORTED_PIECES,
  PILE_BATCH_SIZE,
  ROTATE_DRAG_THRESHOLD_PX,
  ROTATION_STEP_15,
  ROTATION_STEP_90,
} from "../core/constants.js";
import { computeTableLayout } from "../core/tableLayout.js";
import { LDrawService } from "../core/ldrawService.js";
import { PilePhysics } from "../physics/pilePhysics.js";
import {
  checkPieceCollision,
  computeTransformedWorldBox,
  findCollidingPieces,
} from "./collision.js";
import { findBestMechanicalMatch } from "./connectors.js";
import {
  computeSnappedPlacementY,
  computeStudCoordParityOffset,
  computeSupportDistanceAlongDir,
  computeSupportedSurfaceY,
  computeSurfaceY,
  computeWallParityOffset,
  snapAngle,
  snapNormalToCardinal,
  snapToReferenceCoord,
  snapValue,
  snapXZ,
} from "./gridSnap.js";
import { createStickerMesh, disposeStickerMesh } from "./stickerDecal.js";
import {
  applyGuestOpOnHost,
  applyWorldOpOnGuest,
  exportWorldSnapshot,
  loadWorldSnapshot,
} from "../net/worldSync.js";

const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

/**
 * Controlador principal de la mesa virtual:
 * - Pila física realista de piezas sueltas (`cannon-es`)
 * - 1er click selecciona / confirma; 2do click o arrastre sobre seleccionada mueve
 * - Click derecho arrastrando rota con sensibilidad controlada (eje X horiz, eje Y vert)
 * - Zona de armado con snap LDU + lotes progresivos para sets grandes (Hito 3)
 */
export class BuildController {
  constructor(sceneManager, ldrawService, callbacks = {}) {
    this.sceneManager = sceneManager;
    this.ldrawService = ldrawService;
    this.callbacks = callbacks;

    this.pilePhysics = new PilePhysics();
    this.sceneManager.onFrame((dt) => this._onFrame(dt));

    this.manifest = null;
    this.tableLayout = computeTableLayout(null);
    this.partsByElementId = new Map();
    this.failedElementIds = new Set();
    this.placedPieces = []; // { instanceId, elementId, mesh, localBox }
    this.pendingPool = []; // { elementId, bagNumber } pendientes de soltar
    this.history = [];
    this.nextInstanceSeq = 1;
    this.isLightweightSet = false;

    // Selección actual: { kind: "placed" | "pile", item }
    this.selected = null;

    // Pieza actualmente levantada/en mano
    this.carry = null; // { source, elementId, mesh, ghost, localBox, rotation, manualOffsetY, origEntry }
    this._lastHit = null;

    // Arrastrar pieza física dentro de la pila
    this._draggingPileEntry = null;

    // Rotación controlada por click derecho
    this._rightDrag = null;

    this.fineGrid = false;
    this.fineRotation = false;
    this.autoOrient = true;
    this.collisionEnabled = true;
    this.roomManager = null;
    this._keepLockOnSelectionClear = false;
  }

  setRoomManager(roomManager) {
    this.roomManager = roomManager || null;
  }

  _isGuestRoom() {
    return Boolean(this.roomManager?.isGuest());
  }

  _isHostRoom() {
    return Boolean(this.roomManager?.isHost());
  }

  _getLockOwner(instanceId) {
    return this.roomManager?.isLockedByOther(instanceId) || null;
  }

  _ensureNotLocked(instanceIds, notify = true) {
    if (!this.roomManager?.isOpen()) return true;
    for (const id of instanceIds) {
      const owner = this._getLockOwner(id);
      if (owner) {
        if (notify) {
          this.callbacks.onToast?.(`Pieza en uso por ${owner.name || "otro jugador"}.`);
        }
        return false;
      }
    }
    return true;
  }

  _collectSelectedLockIds(sel = this.selected) {
    if (!sel) return [];
    if (sel.kind === "placed" && sel.item?.instanceId) return [sel.item.instanceId];
    if (sel.kind === "pile" && sel.item?.instanceId) return [sel.item.instanceId];
    if (sel.kind === "group" && Array.isArray(sel.items)) {
      return sel.items.map((p) => p.instanceId).filter(Boolean);
    }
    return [];
  }

  _collectCarryLockIds(c = this.carry) {
    if (!c) return [];
    if (c.source === "pile" && c.origEntry?.instanceId) return [c.origEntry.instanceId];
    if (c.source === "placed" && c.origPlaced?.instanceId) return [c.origPlaced.instanceId];
    if (c.source === "group" && Array.isArray(c.origGroup)) {
      return c.origGroup.map((e) => e.piece.instanceId).filter(Boolean);
    }
    return [];
  }

  async _acquireLockForCarry(ids, expectedCarry) {
    if (!ids.length || !this.roomManager?.isOpen()) return;
    const res = await this.roomManager.requestLock(ids);
    if (!res?.ok && this.carry === expectedCarry) {
      const who = res?.blockedBy?.name || "otro jugador";
      this.callbacks.onToast?.(`Pieza reservada por ${who}.`);
      this.cancelCarry();
    }
  }

  exportWorldSnapshot() {
    return exportWorldSnapshot(this);
  }

  async loadFromNetworkSnapshot(manifest, snapshot, opts = {}) {
    await loadWorldSnapshot(this, manifest, snapshot, opts);
  }

  async handleGuestNetworkOp(msg) {
    const out = await applyGuestOpOnHost(this, msg);
    if (out && this._isHostRoom()) {
      this.roomManager.broadcastWorldEvent(out);
    }
  }

  async handleHostNetworkOp(msg) {
    await applyWorldOpOnGuest(this, msg);
  }

  getCarryPreviewPayload() {
    if (!this.carry?.ghost) return { active: false };
    const p = this.carry.ghost.position;
    const r = this.carry.ghost.rotation;
    return {
      active: true,
      elementId: this.carry.elementId,
      position: { x: p.x, y: p.y, z: p.z },
      rotation: { x: r.x, y: r.y, z: r.z },
      isColliding: Boolean(this.carry.isColliding),
    };
  }

  _refreshPlacedWorldBox(piece) {
    const boxes = piece.mesh.userData.collisionBoxes || [piece.localBox];
    piece.worldBox = computeTransformedWorldBox(
      boxes,
      piece.mesh.position,
      piece.mesh.quaternion
    );
    piece.mesh.userData.worldBox = piece.worldBox;
    this.sceneManager.syncPlacedTransform(piece.mesh);
  }

  _onFrame(dt) {
    this.pilePhysics.step(dt, (item) => {
      this.sceneManager.syncPileTransform(item.mesh);
    });
    if (this.selected?.kind === "pile") {
      this.sceneManager.refreshSelectionBox();
    }
  }

  async loadManifest(manifest, savedState = null, savedHistory = null) {
    this.clearWorkspace(false);
    this.manifest = manifest;
    const resolvedParts = (manifest.parts || []).filter(
      (p) => p.status !== "unresolved" && p.ldraw_part_id
    );
    const totalCount = resolvedParts.reduce((acc, p) => acc + p.quantity, 0);
    if (totalCount > MAX_SUPPORTED_PIECES) {
      throw new Error(
        `No se pudo abrir el set (${totalCount} piezas): supera el límite seguro de ${MAX_SUPPORTED_PIECES} piezas simultáneas para evitar que se tilde el navegador.`
      );
    }

    this.tableLayout = computeTableLayout(manifest);
    this.sceneManager.applyTableLayout(this.tableLayout);
    this.pilePhysics.passiveMode = false;
    this.pilePhysics.setBagZones(this.tableLayout.bagZones);
    this.partsByElementId.clear();
    this.failedElementIds.clear();
    this.pendingPool = [];
    this.isLightweightSet = totalCount >= LIGHTWEIGHT_RENDER_THRESHOLD;

    for (const part of resolvedParts) {
      this.partsByElementId.set(part.element_id, part);
    }

    // 1. Restauramos piezas ya colocadas si existía progreso guardado
    let skippedRestored = 0;
    const restoredCounts = new Map();
    if (savedState?.pieces?.length) {
      let maxSeq = this.nextInstanceSeq;
      for (const item of savedState.pieces) {
        const part = this.partsByElementId.get(item.element_id);
        if (!part) continue;
        const already = restoredCounts.get(item.element_id) || 0;
        if (already >= part.quantity) continue;

        let loaded;
        try {
          loaded = await this.ldrawService.createPartInstance(part, {
            lightweight: this.isLightweightSet,
            proxyOnly: true,
          });
        } catch (err) {
          skippedRestored += 1;
          this.failedElementIds.add(part.element_id);
          console.warn(`No se pudo cargar la pieza ${part.ldraw_part_id}:`, err);
          continue;
        }
        const { group, localBox } = loaded;
        const instanceId = item.instance_id || `p_${this.nextInstanceSeq++}`;
        const m = /(\d+)$/.exec(instanceId);
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]) + 1);
        group.position.set(item.position.x, item.position.y, item.position.z);
        group.rotation.set(item.rotation.x, item.rotation.y, item.rotation.z);
        group.userData.instanceId = instanceId;
        group.userData.elementId = item.element_id;
        group.userData.bagNumber = this._getDefaultBagForElement(item.element_id);

        const restoredPiece = {
          instanceId,
          elementId: item.element_id,
          mesh: group,
          localBox,
          stickers: [],
        };
        if (Array.isArray(item.stickers)) {
          for (const st of item.stickers) {
            if (st?.faceKey && st?.dataUrl) {
              this._attachStickerToPiece(restoredPiece, st);
            }
          }
        }
        this.sceneManager.addPlacedMesh(group);
        this._refreshPlacedWorldBox(restoredPiece);
        this.placedPieces.push(restoredPiece);
        restoredCounts.set(item.element_id, already + 1);
      }
      this.nextInstanceSeq = Math.max(this.nextInstanceSeq, maxSeq);
    }

    // Restauramos historial persistido de Ctrl+Z si existe
    if (Array.isArray(savedHistory) && savedHistory.length) {
      const toVec = (v) => new THREE.Vector3(v?.x || 0, v?.y || 0, v?.z || 0);
      const toEul = (v) => new THREE.Euler(v?.x || 0, v?.y || 0, v?.z || 0);
      this.history = savedHistory.map((act) => {
        if (act.type === "add" || act.type === "remove") {
          return { ...act, position: toVec(act.position), rotation: toEul(act.rotation) };
        }
        if (act.type === "move") {
          return {
            ...act,
            prevState: {
              position: toVec(act.prevState?.position),
              rotation: toEul(act.prevState?.rotation),
            },
            newState: {
              position: toVec(act.newState?.position),
              rotation: toEul(act.newState?.rotation),
            },
          };
        }
        if (act.type === "move-group") {
          return {
            type: "move-group",
            items: (act.items || []).map((rec) => ({
              instanceId: rec.instanceId,
              prevState: {
                position: toVec(rec.prevState?.position),
                rotation: toEul(rec.prevState?.rotation),
              },
              newState: {
                position: toVec(rec.newState?.position),
                rotation: toEul(rec.newState?.rotation),
              },
            })),
          };
        }
        if (act.type === "remove-group") {
          return {
            type: "remove-group",
            items: (act.items || []).map((e) => ({
              ...e,
              position: toVec(e.position),
              rotation: toEul(e.rotation),
            })),
          };
        }
        return act;
      });
    }

    // 2. Armamos la cola ordenada por Bolsas (Bolsa 1..N) descontando piezas ya colocadas
    for (const part of resolvedParts) {
      let toSkip = restoredCounts.get(part.element_id) || 0;
      const bagEntries = Object.entries(part.bag_counts || {})
        .map(([k, q]) => [Number(k), Number(q)])
        .filter(([, q]) => q > 0)
        .sort((a, b) => a[0] - b[0]);

      if (!bagEntries.length) {
        const remaining = Math.max(0, part.quantity - toSkip);
        for (let i = 0; i < remaining; i += 1) {
          this.pendingPool.push({ elementId: part.element_id, bagNumber: 1 });
        }
      } else {
        for (const [bagNum, qty] of bagEntries) {
          const skipHere = Math.min(toSkip, qty);
          toSkip -= skipHere;
          const remHere = qty - skipHere;
          for (let i = 0; i < remHere; i += 1) {
            this.pendingPool.push({ elementId: part.element_id, bagNumber: bagNum });
          }
        }
      }
    }
    this.pendingPool.sort((a, b) => a.bagNumber - b.bagNumber);

    // 3. Soltamos todas las bolsas en sus respectivos cuadros de la mesa
    await this.dropNextBatch(this.pendingPool.length, skippedRestored);
    this._emitChange();
  }

  _getDefaultBagForElement(elementId) {
    const part = this.partsByElementId.get(elementId);
    const keys = Object.keys(part?.bag_counts || {}).map(Number).filter((n) => n > 0);
    if (keys.length) return Math.min(...keys);
    return this.tableLayout?.bagZones?.[0]?.bagNumber || 1;
  }

  getBagZones() {
    return this.tableLayout?.bagZones || [];
  }

  focusBag(bagNumber) {
    this.sceneManager.focusBagZone(bagNumber);
  }

  async dropNextBatch(count = PILE_BATCH_SIZE, priorSkipped = 0) {
    if (this._isGuestRoom()) {
      this.roomManager.sendGuestAction({ type: "guest:op", op: "drop-batch", count });
      return 0;
    }
    if (!this.pendingPool.length || count <= 0) {
      if (priorSkipped > 0) {
        this.callbacks.onToast?.(
          `Aviso: se omitieron ${priorSkipped} pieza(s) con archivo LDraw faltante o dañado.`
        );
      }
      return 0;
    }
    const beforeIds = this._isHostRoom()
      ? new Set(this.pilePhysics.items.map((it) => it.instanceId))
      : null;
    const batchItems = this.pendingPool.splice(0, count);
    const total = batchItems.length;
    let done = 0;
    let skipped = priorSkipped;

    // Contamos cuántas piezas van a cada bolsa para distribuirlas ordenadamente en su cuadro
    const bagCounters = new Map();
    const bagTotals = new Map();
    for (const item of batchItems) {
      bagTotals.set(item.bagNumber, (bagTotals.get(item.bagNumber) || 0) + 1);
    }

    this.callbacks.onProgress?.(0, total, `Organizando piezas en bolsas (0/${total})...`);

    const CHUNK_SIZE = 70;
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      const slice = batchItems.slice(start, start + CHUNK_SIZE);
      const tasks = slice.map(async ({ elementId, bagNumber }) => {
        const part = this.partsByElementId.get(elementId);
        if (!part) return;
        let loaded;
        try {
          loaded = await this.ldrawService.createPartInstance(part, {
            lightweight: this.isLightweightSet,
            proxyOnly: true,
          });
        } catch (err) {
          skipped += 1;
          done += 1;
          this.failedElementIds.add(part.element_id);
          console.warn(`No se pudo cargar la pieza ${part.ldraw_part_id}:`, err);
          return;
        }
        const { group, localBox } = loaded;
        const instanceId = `pile_${this.nextInstanceSeq++}`;
        group.userData.instanceId = instanceId;
        group.userData.elementId = elementId;
        group.userData.bagNumber = bagNumber;

        const bz = this.pilePhysics.getBagZone(bagNumber);
        const idxInBag = bagCounters.get(bagNumber) || 0;
        bagCounters.set(bagNumber, idxInBag + 1);
        const totalInBag = Math.max(1, bagTotals.get(bagNumber) || 1);

        // Distribución ordenada en cuadrícula dentro del recuadro de la bolsa (evita desbordes y acelera reposo)
        const marginX = 32;
        const marginZ = 32;
        const usableW = Math.max(40, bz.width - marginX * 2);
        const usableD = Math.max(40, bz.depth - marginZ * 2);
        const cols = Math.max(3, Math.ceil(Math.sqrt(Math.min(totalInBag, 48))));
        const cellIdx = idxInBag % (cols * cols);
        const layer = Math.floor(idxInBag / (cols * cols));
        const col = cellIdx % cols;
        const row = Math.floor(cellIdx / cols);
        const stepX = usableW / cols;
        const stepZ = usableD / cols;

        const dropPos = {
          x: bz.minX + marginX + (col + 0.25 + Math.random() * 0.5) * stepX,
          y: 16 + layer * 18 + Math.random() * 6,
          z: bz.minZ + marginZ + (row + 0.25 + Math.random() * 0.5) * stepZ,
        };

        this.pilePhysics.addPiece(
          instanceId,
          elementId,
          group,
          localBox,
          dropPos,
          true,
          bagNumber
        );
        this.sceneManager.addPileMesh(group);

        done += 1;
        if (done % 15 === 0 || done === total) {
          this.callbacks.onProgress?.(
            done,
            total,
            `Cargando Bolsa ${bagNumber} (${done}/${total})...`
          );
        }
      });

      await Promise.all(tasks);
      if (start + CHUNK_SIZE < total) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    this.callbacks.onProgress?.(0, 0, "");
    if (this._isHostRoom() && beforeIds) {
      const spawned = this.pilePhysics.items
        .filter((it) => !beforeIds.has(it.instanceId))
        .map((it) => ({
          instanceId: it.instanceId,
          elementId: it.elementId,
          bagNumber: it.bagNumber || 1,
          position: { x: it.mesh.position.x, y: it.mesh.position.y, z: it.mesh.position.z },
          quaternion: {
            x: it.mesh.quaternion.x,
            y: it.mesh.quaternion.y,
            z: it.mesh.quaternion.z,
            w: it.mesh.quaternion.w,
          },
        }));
      this.roomManager.broadcastWorldEvent({
        type: "world:op",
        op: "pile-drop-batch",
        nextInstanceSeq: this.nextInstanceSeq,
        pendingPool: this.pendingPool.map((it) => ({ ...it })),
        spawned,
      });
    }
    this._emitChange();
    if (skipped > 0) {
      this.callbacks.onToast?.(
        `Aviso: se omitieron ${skipped} pieza(s) con geometría LDraw faltante o dañada.`
      );
    }
    return total;
  }

  clearWorkspace(emit = true) {
    this.cancelCarry();
    this.clearSelection();
    for (const piece of this.placedPieces) {
      this._clearStickersFromMesh(piece.mesh);
    }
    this.sceneManager.clearPieces();
    this.pilePhysics.clear();
    this.placedPieces = [];
    this.pendingPool = [];
    this.failedElementIds.clear();
    this.history = [];
    if (emit) this._emitChange();
  }

  isPartFailed(elementId) {
    return this.failedElementIds.has(elementId);
  }

  getPlacedPieceByObject(rootObject) {
    return this.placedPieces.find((p) => p.mesh === rootObject) || null;
  }

  hasStickerOnFace(piece, faceKey) {
    if (!piece || !faceKey || !Array.isArray(piece.stickers)) return false;
    return piece.stickers.some((s) => s.faceKey === faceKey);
  }

  _clearStickersFromMesh(mesh) {
    if (!mesh) return;
    const toRemove = mesh.children.filter((c) => c.userData?.isSticker);
    for (const child of toRemove) {
      mesh.remove(child);
      disposeStickerMesh(child);
    }
  }

  _attachStickerToPiece(piece, stickerData) {
    if (!piece || !stickerData?.faceKey || !stickerData?.dataUrl) return;
    this.sceneManager.promotePlacedMeshToIndividual(piece.mesh);
    this._detachStickerFromPiece(piece, stickerData.faceKey);
    const stickerMesh = createStickerMesh(stickerData);
    piece.mesh.add(stickerMesh);
    if (!Array.isArray(piece.stickers)) piece.stickers = [];
    piece.stickers.push(structuredClone(stickerData));
    this.sceneManager.invalidateShadows();
  }

  _detachStickerFromPiece(piece, faceKey) {
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
    }
    return existingData;
  }

  applyStickerToPlacedPiece(piece, placement, dataUrl, { recordHistory = true } = {}) {
    if (!piece || !placement?.faceKey || !dataUrl || this._isGuestRoom()) return;
    const stickerData = { ...placement, dataUrl };
    const prevSticker = this._detachStickerFromPiece(piece, placement.faceKey);
    this._attachStickerToPiece(piece, stickerData);
    if (recordHistory) {
      this.history.push({
        type: "sticker-add",
        instanceId: piece.instanceId,
        faceKey: placement.faceKey,
        prevSticker,
      });
    }
    if (this._isHostRoom()) {
      this.roomManager.broadcastWorldEvent({
        type: "world:op",
        op: "sticker-add",
        instanceId: piece.instanceId,
        sticker: structuredClone(stickerData),
      });
    }
    this._emitChange();
  }

  removeStickerFromPlacedPiece(piece, faceKey, { recordHistory = true } = {}) {
    if (!piece || !faceKey || this._isGuestRoom()) return false;
    const removed = this._detachStickerFromPiece(piece, faceKey);
    if (!removed) return false;
    if (recordHistory) {
      this.history.push({
        type: "sticker-remove",
        instanceId: piece.instanceId,
        sticker: removed,
      });
    }
    if (this._isHostRoom()) {
      this.roomManager.broadcastWorldEvent({
        type: "world:op",
        op: "sticker-remove",
        instanceId: piece.instanceId,
        faceKey,
      });
    }
    this._emitChange();
    return true;
  }

  getPlacedCount(elementId) {
    let count = 0;
    for (const p of this.placedPieces) {
      if (p.elementId === elementId) count += 1;
    }
    return count;
  }

  getPileCount(elementId) {
    let count = 0;
    for (const item of this.pilePhysics.items) {
      if (item.elementId === elementId) count += 1;
    }
    return count;
  }

  getPendingCount(elementId) {
    let count = 0;
    for (const item of this.pendingPool) {
      if (item.elementId === elementId) count += 1;
    }
    return count;
  }

  getRemainingCount(elementId) {
    const part = this.partsByElementId.get(elementId);
    if (!part) return 0;
    return Math.max(0, part.quantity - this.getPlacedCount(elementId));
  }

  toggleFineGrid() {
    this.fineGrid = !this.fineGrid;
    this._updateCarryTransform();
    this._emitStatus();
    return this.fineGrid;
  }

  toggleFineRotation() {
    this.fineRotation = !this.fineRotation;
    this._emitStatus();
    return this.fineRotation;
  }

  toggleAutoOrient() {
    this.autoOrient = !this.autoOrient;
    if (this.carry) {
      this.carry.manualTiltApplied = !this.autoOrient;
      if (this.autoOrient) {
        this._updateCarryTransform();
      }
    }
    this._emitStatus();
    return this.autoOrient;
  }

  toggleCollision() {
    this.collisionEnabled = !this.collisionEnabled;
    if (this.carry) {
      this._updateCarryTransform();
    }
    this._emitStatus();
    return this.collisionEnabled;
  }

  shakePile() {
    if (this._isGuestRoom()) {
      this.roomManager.sendGuestAction({ type: "guest:op", op: "shake" });
      return;
    }
    this.pilePhysics.shakeAll();
  }

  clearSelection() {
    const oldIds = !this._keepLockOnSelectionClear ? this._collectSelectedLockIds() : [];
    this.selected = null;
    this.sceneManager.setSelectionBox(null);
    if (oldIds.length && this.roomManager?.isOpen()) {
      this.roomManager.releaseLocks(oldIds);
    }
    this._emitStatus();
  }

  _selectPlaced(piece) {
    if (!this._ensureNotLocked([piece.instanceId])) return;
    const oldIds = this._collectSelectedLockIds();
    if (oldIds.length) this.roomManager?.releaseLocks(oldIds);
    this.selected = { kind: "placed", item: piece };
    this.sceneManager.setSelectionBox(piece.mesh);
    this.roomManager?.requestLock([piece.instanceId]);
    this._emitStatus();
  }

  _selectGroup(items) {
    const unique = [];
    const seen = new Set();
    for (const p of items) {
      if (p && !seen.has(p.instanceId) && !this._getLockOwner(p.instanceId)) {
        seen.add(p.instanceId);
        unique.push(p);
      }
    }
    if (!unique.length) {
      this.clearSelection();
      return;
    }
    if (unique.length === 1) {
      this._selectPlaced(unique[0]);
      return;
    }
    const oldIds = this._collectSelectedLockIds();
    if (oldIds.length) this.roomManager?.releaseLocks(oldIds);
    this.selected = { kind: "group", items: unique };
    this.sceneManager.setSelectionBox(unique.map((p) => p.mesh));
    this.roomManager?.requestLock(unique.map((p) => p.instanceId));
    this._emitStatus();
  }

  _selectPile(entry) {
    if (!this._ensureNotLocked([entry.instanceId])) return;
    const oldIds = this._collectSelectedLockIds();
    if (oldIds.length) this.roomManager?.releaseLocks(oldIds);
    this.selected = { kind: "pile", item: entry };
    this.sceneManager.setSelectionBox(entry.mesh);
    this.roomManager?.requestLock([entry.instanceId]);
    this._emitStatus();
  }

  /**
   * Selecciona TODAS las piezas colocadas cuyo volumen 3D caiga al menos ~10%
   * dentro del frustum proyectado desde el recuadro de pantalla hacia adelante,
   * sin importar ángulo de cámara, oclusión detrás de otras piezas ni cantidad.
   */
  selectGroupInScreenRect(rect, additive = false) {
    if (this.carry) return;
    const cam = this.sceneManager.camera;
    cam.updateMatrixWorld();
    const domRect = this.sceneManager.renderer.domElement.getBoundingClientRect();
    if (!domRect.width || !domRect.height) return;

    const rLeft = Math.min(rect.left, rect.right);
    const rRight = Math.max(rect.left, rect.right);
    const rTop = Math.min(rect.top, rect.bottom);
    const rBottom = Math.max(rect.top, rect.bottom);
    const rArea = Math.max(1, (rRight - rLeft) * (rBottom - rTop));

    // Construimos el Frustum 3D real del recuadro ("desde el recuadro hacia adelante")
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
      makeInwardPlane(nTL, nBL, fTL), // Izquierda
      makeInwardPlane(nTR, fTR, nBR), // Derecha
      makeInwardPlane(nTL, fTL, nTR), // Arriba
      makeInwardPlane(nBL, nBR, fBL), // Abajo
      makeInwardPlane(nTL, nTR, nBL), // Cerca
      makeInwardPlane(fTL, fBL, fTR)  // Lejos
    );

    const hits = [];
    const sample = new THREE.Vector3();

    for (const piece of this.placedPieces) {
      if (!piece.worldBox || piece.worldBox.isEmpty()) {
        this._refreshPlacedWorldBox(piece);
      }
      const wb = piece.worldBox;
      if (!wb || wb.isEmpty()) continue;
      if (!frustum.intersectsBox(wb)) continue;

      // Muestreo 5x3x5 sin asignaciones GC para verificar >= 10% del volumen/área dentro
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
        this.selected?.kind === "group"
          ? this.selected.items
          : this.selected?.kind === "placed"
            ? [this.selected.item]
            : [];
      this._selectGroup([...base, ...hits]);
    } else {
      this._selectGroup(hits);
    }
  }

  /**
   * Ctrl + Click sobre una pieza colocada la agrega o quita del grupo temporal actual.
   */
  toggleGroupPieceAtPoint(clientX, clientY) {
    if (this.carry) return;
    const hit = this.sceneManager.raycastWorkspace(clientX, clientY);
    if (!hit || hit.kind !== "placed") return;
    const piece = this.placedPieces.find((p) => p.mesh === hit.object);
    if (!piece) return;

    const current =
      this.selected?.kind === "group"
        ? [...this.selected.items]
        : this.selected?.kind === "placed"
          ? [this.selected.item]
          : [];
    const idx = current.findIndex((p) => p.instanceId === piece.instanceId);
    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      current.push(piece);
    }
    this._selectGroup(current);
  }

  /**
   * Inicia el movimiento de una pieza tomada desde la bandeja (sacándola de la pila o pool).
   */
  async startCarryFromTray(elementId) {
    const part = this.partsByElementId.get(elementId);
    if (!part) return;
    if (this.getRemainingCount(elementId) <= 0) {
      this.callbacks.onToast?.("Ya colocaste todas las unidades de esa pieza.");
      return;
    }

    // Preferimos tomar una existente de la pila física que no esté reservada por otro jugador
    const inPile = this.pilePhysics.items.find(
      (item) => item.elementId === elementId && !this._getLockOwner(item.instanceId)
    );
    if (inPile) {
      await this._liftPileEntry(inPile);
      return;
    }

    // Si estaba en pendingPool, la sacamos del pool (en invitado mantenemos pendingPool autoritativo del Host hasta confirmar)
    const poolIdx = this.pendingPool.findIndex((item) => item.elementId === elementId);
    if (poolIdx === -1) {
      this.callbacks.onToast?.(
        `No se pudo cargar el modelo 3D de ${part.part_name || part.ldraw_part_id} (#${part.ldraw_part_id}).`
      );
      return;
    }
    const poolEntry = this._isGuestRoom()
      ? this.pendingPool[poolIdx]
      : this.pendingPool.splice(poolIdx, 1)[0];

    let loaded;
    try {
      loaded = await this.ldrawService.createPartInstance(part, {
        lightweight: this.isLightweightSet,
        proxyOnly: true,
      });
    } catch (err) {
      if (!this._isGuestRoom()) {
        this.pendingPool.splice(poolIdx, 0, poolEntry);
      }
      this.failedElementIds.add(part.element_id);
      this._emitChange();
      this.callbacks.onToast?.(
        `No se pudo cargar el modelo 3D de ${part.part_name || part.ldraw_part_id}: ${err.message}`
      );
      return;
    }
    const { group, localBox } = loaded;
    group.userData.bagNumber = poolEntry.bagNumber;
    this._activateCarry({
      source: "pool",
      elementId,
      mesh: group,
      localBox,
      rotation: new THREE.Euler(0, 0, 0, "XYZ"),
    });
  }

  async _liftPileEntry(entry) {
    if (!this._ensureNotLocked([entry.instanceId])) return;
    this._keepLockOnSelectionClear = true;
    this.clearSelection();
    this._keepLockOnSelectionClear = false;
    this.pilePhysics.removePiece(entry.instanceId);
    this.sceneManager.removePileMesh(entry.mesh);
    if (!this.pilePhysics.passiveMode) {
      this.pilePhysics.wakeNearby(entry.mesh.position, 110);
    }

    // Normalizamos rotación inicial al paso de 90° más cercano en Y para que quede cómoda al encastrar
    const euler = new THREE.Euler().setFromQuaternion(entry.mesh.quaternion, "XYZ");
    const cleanRot = new THREE.Euler(0, snapAngle(euler.y, ROTATION_STEP_90), 0, "XYZ");

    this._activateCarry({
      source: "pile",
      elementId: entry.elementId,
      mesh: entry.mesh,
      localBox: entry.localBox,
      rotation: cleanRot,
      origEntry: entry,
    });
    this._acquireLockForCarry([entry.instanceId], this.carry);
  }

  _liftPlacedPiece(piece) {
    if (!this._ensureNotLocked([piece.instanceId])) return;
    this._keepLockOnSelectionClear = true;
    this.clearSelection();
    this._keepLockOnSelectionClear = false;
    this.sceneManager.setPlacedVisible(piece.mesh, false);
    this._activateCarry({
      source: "placed",
      elementId: piece.elementId,
      mesh: piece.mesh,
      localBox: piece.localBox,
      rotation: piece.mesh.rotation.clone(),
      origPlaced: piece,
    });
    this._acquireLockForCarry([piece.instanceId], this.carry);
  }

  /**
   * Construye pivote, geometría compuesta, studs, receptores inferiores y sub-cajas
   * OBB exactas para operar un grupo de piezas como una pieza única temporal.
   */
  _buildGroupCompositeData(items) {
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
      tmpBox.copy(p.localBox).applyMatrix4(mat);
      localBox.union(tmpBox);

      for (const s of p.mesh.userData.topStuds || []) {
        compositeStuds.push({
          pos: s.pos.clone().applyQuaternion(relQuat).add(relPos),
          up: s.up.clone().applyQuaternion(relQuat).normalize(),
          height: s.height,
        });
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
      entries,
      localBox,
      compositeBoxes,
      compositeStuds,
      bottomReceptors,
      defaultSupportUndersideY: minSupportLocalY,
    };
  }

  _liftGroupPieces(items) {
    if (!items?.length) return;
    if (items.length === 1) {
      this._liftPlacedPiece(items[0]);
      return;
    }
    const ids = items.map((p) => p.instanceId).filter(Boolean);
    if (!this._ensureNotLocked(ids)) return;
    this._keepLockOnSelectionClear = true;
    this.clearSelection();
    this._keepLockOnSelectionClear = false;
    const meta = this._buildGroupCompositeData(items);

    const groupRoot = new THREE.Group();
    groupRoot.userData.collisionBoxes = meta.compositeBoxes;
    groupRoot.userData.topStuds = meta.compositeStuds;
    groupRoot.userData.bottomReceptors = meta.bottomReceptors;
    groupRoot.userData.defaultSupportUndersideY = meta.defaultSupportUndersideY;

    for (const entry of meta.entries) {
      this.sceneManager.setPlacedVisible(entry.piece.mesh, false);
      const src =
        entry.piece.mesh.children.length === 0 && entry.piece.mesh.userData?.visualTemplateGroup
          ? entry.piece.mesh.userData.visualTemplateGroup
          : entry.piece.mesh;
      const clone = src.clone(true);
      clone.visible = true;
      clone.position.copy(entry.relPos);
      clone.quaternion.copy(entry.relQuat);
      groupRoot.add(clone);
    }

    this._activateCarry({
      source: "group",
      elementId: meta.entries[0].piece.elementId,
      mesh: groupRoot,
      localBox: meta.localBox,
      rotation: new THREE.Euler(0, 0, 0, "XYZ"),
      origGroup: meta.entries,
      origGroupPivot: meta.pivotPos,
    });
    this._acquireLockForCarry(ids, this.carry);
  }

  _activateCarry({
    source,
    elementId,
    mesh,
    localBox,
    rotation,
    origEntry = null,
    origPlaced = null,
    origGroup = null,
    origGroupPivot = null,
  }) {
    this.cancelCarry();
    const ghost = LDrawService.makeGhostClone(mesh);
    const quaternion = new THREE.Quaternion().setFromEuler(rotation);
    ghost.quaternion.copy(quaternion);
    this.sceneManager.scene.add(ghost);

    const upVec = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    const isUpright = upVec.y > 0.85;
    const ignoreSet = origGroup
      ? new Set(origGroup.map((e) => e.piece.mesh))
      : origPlaced
        ? origPlaced.mesh
        : null;

    this.carry = {
      source,
      elementId,
      mesh,
      ghost,
      localBox,
      quaternion,
      spinAngle: isUpright ? snapAngle(rotation.y, ROTATION_STEP_90) : 0,
      surfaceNormal: WORLD_Y.clone(),
      manualTiltApplied: !this.autoOrient || !isUpright,
      manualOffsetX: 0,
      manualOffsetY: 0,
      manualOffsetZ: 0,
      ghostLocalMinY: 0,
      supportUndersideY: 0,
      parityOffsetX: 0,
      parityOffsetZ: 0,
      lastValid: null,
      origEntry,
      origPlaced,
      origGroup,
      ignoreSet,
    };
    this._recomputeCarryBounds();
    if (origPlaced) {
      this.carry.lastValid = {
        position: origPlaced.mesh.position.clone(),
        quaternion: quaternion.clone(),
        surfaceNormal: this.carry.surfaceNormal.clone(),
        spinAngle: this.carry.spinAngle,
        manualTiltApplied: this.carry.manualTiltApplied,
        manualOffsetX: 0,
        manualOffsetY: 0,
        manualOffsetZ: 0,
      };
    } else if (origGroup && origGroupPivot) {
      this.carry.lastValid = {
        position: origGroupPivot.clone(),
        quaternion: quaternion.clone(),
        surfaceNormal: this.carry.surfaceNormal.clone(),
        spinAngle: this.carry.spinAngle,
        manualTiltApplied: this.carry.manualTiltApplied,
        manualOffsetX: 0,
        manualOffsetY: 0,
        manualOffsetZ: 0,
      };
    }
    this._updateCarryTransform();
    this._emitStatus();
  }

  _applyAutoOrientation(normal) {
    if (!this.carry) return;
    const baseQuat = new THREE.Quaternion();
    if (normal.y < -0.99) {
      baseQuat.setFromAxisAngle(WORLD_X, Math.PI);
    } else {
      baseQuat.setFromUnitVectors(WORLD_Y, normal);
    }
    const spinQuat = new THREE.Quaternion().setFromAxisAngle(normal, this.carry.spinAngle);
    this.carry.quaternion.copy(spinQuat.multiply(baseQuat)).normalize();
  }

  cancelCarry() {
    if (!this.carry) return;
    const c = this.carry;
    const lockIds = this._collectCarryLockIds(c);
    this.sceneManager.scene.remove(c.ghost);
    this.carry = null;
    this.roomManager?.sendPresence?.({ type: "carry:preview", active: false });

    if (c.source === "group" && c.origGroup) {
      for (const entry of c.origGroup) {
        this.sceneManager.setPlacedVisible(entry.piece.mesh, true);
      }
      this._selectGroup(c.origGroup.map((e) => e.piece));
      this._emitStatus();
      return;
    } else if (c.source === "placed" && c.origPlaced) {
      this.sceneManager.setPlacedVisible(c.origPlaced.mesh, true);
    } else if (c.source === "pile" || c.source === "pool") {
      if (c.source === "pool" && this._isGuestRoom()) {
        if (lockIds.length) this.roomManager?.releaseLocks(lockIds);
        this._emitChange();
        return;
      }
      // Devolvemos la pieza a la caja de su bolsa correspondiente
      const id = c.origEntry?.instanceId || `pile_${this.nextInstanceSeq++}`;
      const bagNum =
        c.origEntry?.bagNumber ||
        c.mesh.userData.bagNumber ||
        this._getDefaultBagForElement(c.elementId);
      const restorePos = c.origEntry?.mesh?.position
        ? { x: c.origEntry.mesh.position.x, y: c.origEntry.mesh.position.y, z: c.origEntry.mesh.position.z }
        : null;
      this.pilePhysics.addPiece(id, c.elementId, c.mesh, c.localBox, restorePos, !restorePos, bagNum);
      this.sceneManager.addPileMesh(c.mesh);
      if (c.source === "pool" && this._isHostRoom()) {
        this.roomManager.broadcastWorldEvent({
          type: "world:op",
          op: "spawn-pile",
          nextInstanceSeq: this.nextInstanceSeq,
          consumePoolElementId: c.elementId,
          item: {
            instanceId: id,
            elementId: c.elementId,
            bagNumber: bagNum,
            position: { x: c.mesh.position.x, y: c.mesh.position.y, z: c.mesh.position.z },
            quaternion: {
              x: c.mesh.quaternion.x,
              y: c.mesh.quaternion.y,
              z: c.mesh.quaternion.z,
              w: c.mesh.quaternion.w,
            },
          },
        });
      }
    }
    if (lockIds.length) this.roomManager?.releaseLocks(lockIds);
    this._emitChange();
  }

  _recomputeCarryBounds() {
    if (!this.carry) return;
    const { ghost, quaternion, mesh } = this.carry;
    const prevPos = ghost.position.clone();
    ghost.position.set(0, 0, 0);
    ghost.quaternion.copy(quaternion);
    ghost.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(ghost);
    this.carry.ghostBox = box;
    this.carry.ghostLocalMinY = box.min.y;
    this.carry.supportUndersideY =
      this.carry.source === "group" && mesh.userData.defaultSupportUndersideY !== undefined
        ? mesh.userData.defaultSupportUndersideY
        : LDrawService.computeSupportUndersideY(ghost, box);

    // Si la pieza tiene studs superiores orientados hacia +Y, alineamos directamente por stud
    const studs = mesh.userData.topStuds || [];
    let refStudPos = null;
    const tmpPos = new THREE.Vector3();
    const tmpUp = new THREE.Vector3();
    for (const s of studs) {
      tmpUp.copy(s.up).applyQuaternion(ghost.quaternion);
      if (tmpUp.y > 0.85) {
        refStudPos = tmpPos.copy(s.pos).applyQuaternion(ghost.quaternion);
        break;
      }
    }

    if (refStudPos) {
      this.carry.parityOffsetX = computeStudCoordParityOffset(refStudPos.x);
      this.carry.parityOffsetZ = computeStudCoordParityOffset(refStudPos.z);
    } else {
      this.carry.parityOffsetX = computeWallParityOffset(box.min.x);
      this.carry.parityOffsetZ = computeWallParityOffset(box.min.z);
    }

    ghost.position.copy(prevPos);
  }

  /**
   * Busca el stud ("circulito") destino más coherente cercano al punto de impacto,
   * explorando tanto la pieza impactada como piezas vecinas dentro de 22 LDU.
   * Filtra por cara visible para no enganchar el stud del lado opuesto en anillos
   * finos (ej. 4081b) o faldones de brackets (44728).
   */
  _findBestConnectionStud(hit, cardN, ignoreMesh = null) {
    if (!hit || hit.kind !== "placed") return null;
    const pt = hit.point;
    const rawN = (hit.normal || cardN).clone().normalize();
    const camPos = this.sceneManager.camera.position;

    let best = null;
    let bestScore = Infinity;

    const worldPos = new THREE.Vector3();
    const worldUp = new THREE.Vector3();
    const toHit = new THREE.Vector3();
    const toCam = new THREE.Vector3();

    const considerPiece = (mesh) => {
      const studs = mesh?.userData?.topStuds;
      if (!studs || !studs.length) return;
      mesh.updateMatrixWorld(true);

      for (const s of studs) {
        worldPos.copy(s.pos).applyMatrix4(mesh.matrixWorld);
        worldUp.copy(s.up).transformDirection(mesh.matrixWorld).normalize();

        toHit.subVectors(pt, worldPos);
        const sideProj = toHit.dot(worldUp);
        if (sideProj < -2.5) continue;

        toCam.subVectors(camPos, worldPos);
        if (toCam.dot(worldUp) < -0.15) continue;

        const distSq = worldPos.distanceToSquared(pt);
        const sameFace = worldUp.dot(cardN) > 0.72;
        let matched = false;

        if (sameFace && distSq <= 22 * 22) {
          matched = true;
        } else if (
          (Math.abs(worldUp.y) < 0.5 || rawN.y > 0.25) &&
          sideProj <= (s.height || 4) + 3.0 &&
          worldUp.dot(rawN) > 0.1
        ) {
          const radialSq = distSq - sideProj * sideProj;
          if (radialSq <= 10.5 * 10.5) {
            matched = true;
          }
        }

        if (!matched) continue;
        const score = distSq - (mesh === hit.object ? 9 : 0) - (sameFace ? 16 : 0);
        if (score < bestScore) {
          bestScore = score;
          const sc = snapNormalToCardinal(worldUp.x, worldUp.y, worldUp.z);
          best = {
            studPos: worldPos.clone(),
            studUp: new THREE.Vector3(sc.x, sc.y, sc.z),
            ownerMesh: mesh,
          };
        }
      }
    };

    const isIgnored = (m) => (ignoreMesh instanceof Set ? ignoreMesh.has(m) : m === ignoreMesh);

    if (hit.object && !isIgnored(hit.object)) {
      considerPiece(hit.object);
    }

    for (const p of this.placedPieces) {
      if (isIgnored(p.mesh) || p.mesh === hit.object) continue;
      const wb = p.worldBox;
      if (
        wb &&
        (pt.x < wb.min.x - 22 ||
          pt.x > wb.max.x + 22 ||
          pt.y < wb.min.y - 22 ||
          pt.y > wb.max.y + 22 ||
          pt.z < wb.min.z - 22 ||
          pt.z > wb.max.z + 22)
      ) {
        continue;
      }
      considerPiece(p.mesh);
    }

    return best;
  }

  /**
   * Devuelve la distancia exacta desde el origen de la pieza llevada hasta su cara
   * de apoyo en dirección `-dirNormal`, y los offsets de sus receptores hembra rotados.
   */
  _resolveCarryConnectionGeometry(dirNormal) {
    const quat = this.carry.quaternion;
    const boxes = this.carry.mesh.userData.collisionBoxes || [this.carry.localBox];
    const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
    const isStandardBaseDown = localUp.dot(dirNormal) > 0.85;

    const { supportDist, worldReceptors, receptorsCenter } = (() => {
      if (isStandardBaseDown) {
        const defUnderside =
          this.carry.mesh.userData.defaultSupportUndersideY ?? this.carry.localBox.min.y;
        const dist = -defUnderside;
        const localReceptors = this.carry.mesh.userData.bottomReceptors || [
          new THREE.Vector3(0, defUnderside, 0),
        ];
        const recs = localReceptors.map((r) => r.clone().applyQuaternion(quat));
        const rc = new THREE.Vector3();
        for (const r of recs) rc.add(r);
        rc.divideScalar(Math.max(1, recs.length));
        return { supportDist: dist, worldReceptors: recs, receptorsCenter: rc };
      }
      const dist = computeSupportDistanceAlongDir(boxes, quat, dirNormal);
      const center = new THREE.Vector3();
      this.carry.ghostBox.getCenter(center);
      const recs = [center.addScaledVector(dirNormal, -dist - center.dot(dirNormal))];
      return { supportDist: dist, worldReceptors: recs, receptorsCenter: recs[0].clone() };
    })();
    return { supportDist, worldReceptors, receptorsCenter };
  }

  /**
   * Genera candidatos alineados contra una pared lateral o techo sin studs (`cardN`),
   * respetando la grilla de la pieza tocada para encastrar en huecos cerrados.
   */
  _buildWallPocketCandidates(hit, cardN) {
    if (!hit || hit.kind !== "placed") return [];
    const pt = hit.point;
    const step = this.fineGrid ? LDU_HALF_STUD : LDU_STUD;
    const minAllowedY = -this.carry.ghostBox.min.y;
    const boxes = this.carry.mesh.userData.collisionBoxes || [this.carry.localBox];
    const ghostBox = this.carry.ghostBox;

    const normalAxis =
      Math.abs(cardN.x) > 0.5 ? "x" : Math.abs(cardN.y) > 0.5 ? "y" : "z";
    const tangentAxes =
      normalAxis === "y" ? ["x", "z"] : normalAxis === "x" ? ["y", "z"] : ["x", "y"];
    const [ax0, ax1] = tangentAxes;

    const wallDist = computeSupportDistanceAlongDir(boxes, this.carry.quaternion, cardN);
    const center = new THREE.Vector3();
    ghostBox.getCenter(center);
    const desired = new THREE.Vector3().subVectors(pt, center);

    const basePiece = this.placedPieces.find((p) => p.mesh === hit.object);
    const baseWb = basePiece?.worldBox || hit.object?.userData?.worldBox;

    const snapAxisToPiece = (ax, val) => {
      if (!baseWb) {
        return ax === "y"
          ? Math.round(val / LDU_PLATE) * LDU_PLATE
          : Math.round(val / step) * step;
      }
      return snapToReferenceCoord(val, ghostBox.min[ax], baseWb.min[ax], step);
    };

    const rawN = hit.normal || cardN;
    const isFlatCardinalWall = rawN.dot(cardN) > 0.98;
    const rawPlane =
      pt[normalAxis] + cardN[normalAxis] * (wallDist + this.carry.manualOffsetY);
    const normalPlane = isFlatCardinalWall
      ? Math.round(rawPlane * 100) / 100
      : Math.round(rawPlane / 4) * 4;

    const baseCand = new THREE.Vector3();
    baseCand[normalAxis] = normalPlane;
    baseCand[ax0] = snapAxisToPiece(ax0, desired[ax0]);
    baseCand[ax1] = snapAxisToPiece(ax1, desired[ax1]);

    const cands = [];
    const pushIfValidY = (v) => {
      if (v.y < minAllowedY - 0.01) return;
      if (v.y < minAllowedY) v.y = minAllowedY;
      cands.push(v);
    };

    pushIfValidY(baseCand);

    const offsets = [];
    for (const ax of [ax0, ax1]) {
      for (const delta of [-step, step]) {
        const alt = baseCand.clone();
        alt[ax] += delta;
        offsets.push(alt);
      }
    }
    if (normalAxis !== "y") {
      for (const dy of [-LDU_PLATE, LDU_PLATE]) {
        const alt = baseCand.clone();
        alt.y += dy;
        offsets.push(alt);
      }
    }
    offsets.sort((a, b) => a.distanceToSquared(desired) - b.distanceToSquared(desired));
    for (const o of offsets) pushIfValidY(o);
    return cands;
  }

  /**
   * Verifica que en `candidatePos` al menos un receptor de la pieza llevada conecte
   * con un stud real en el mismo plano `(planeCoord, studUp)` de la construcción.
   */
  _hasStudSupportOnPlane(candidatePos, worldReceptors, normalAxis, studPlaneCoord, studUp, ignoreMesh) {
    const reqWorld = new THREE.Vector3();
    const sWorld = new THREE.Vector3();
    const sUp = new THREE.Vector3();
    const isIgnored = (m) => (ignoreMesh instanceof Set ? ignoreMesh.has(m) : m === ignoreMesh);

    for (const p of this.placedPieces) {
      if (isIgnored(p.mesh)) continue;
      const wb = p.worldBox;
      if (
        wb &&
        (candidatePos.x < wb.min.x - 160 ||
          candidatePos.x > wb.max.x + 160 ||
          candidatePos.y < wb.min.y - 160 ||
          candidatePos.y > wb.max.y + 160 ||
          candidatePos.z < wb.min.z - 160 ||
          candidatePos.z > wb.max.z + 160)
      ) {
        continue;
      }
      const studs = p.mesh.userData.topStuds;
      if (!studs?.length) continue;
      p.mesh.updateMatrixWorld(true);

      for (const s of studs) {
        sUp.copy(s.up).transformDirection(p.mesh.matrixWorld).normalize();
        if (sUp.dot(studUp) < 0.85) continue;
        sWorld.copy(s.pos).applyMatrix4(p.mesh.matrixWorld);
        if (Math.abs(sWorld[normalAxis] - studPlaneCoord) > 2.5) continue;

        for (const r of worldReceptors) {
          reqWorld.copy(candidatePos).add(r);
          // Comparamos los 2 ejes tangentes al plano del stud
          const distSq =
            (normalAxis !== "x" ? (reqWorld.x - sWorld.x) ** 2 : 0) +
            (normalAxis !== "y" ? (reqWorld.y - sWorld.y) ** 2 : 0) +
            (normalAxis !== "z" ? (reqWorld.z - sWorld.z) ** 2 : 0);
          if (distSq <= 3.5 * 3.5) {
            return true;
          }
        }
      }
    }
    return false;
  }

  _computeSupportedSurfaceAt(candidateBoxes, x, z, maxSearchY, ignoreMesh, minOverlap = 4) {
    const isIgnored = (m) => (ignoreMesh instanceof Set ? ignoreMesh.has(m) : m === ignoreMesh);
    const probeBox = computeTransformedWorldBox(
      candidateBoxes,
      new THREE.Vector3(x, 0, z),
      this.carry.quaternion
    );
    const placedBoxes = [];
    for (const p of this.placedPieces) {
      if (isIgnored(p.mesh) || !p.worldBox) continue;
      placedBoxes.push(p.worldBox);
    }
    return computeSupportedSurfaceY(
      probeBox.min.x,
      probeBox.max.x,
      probeBox.min.z,
      probeBox.max.z,
      placedBoxes,
      maxSearchY,
      minOverlap
    );
  }

  _isInPileZone(x, z) {
    return this.pilePhysics.isPointInAnyBag(x, z, 20);
  }

  _saveCarryValidState(pos) {
    this.carry.lastValid = {
      position: pos.clone(),
      quaternion: this.carry.quaternion.clone(),
      surfaceNormal: this.carry.surfaceNormal.clone(),
      activeMechKind: this.carry.activeMechKind || null,
      spinAngle: this.carry.spinAngle,
      manualTiltApplied: this.carry.manualTiltApplied,
      manualOffsetX: this.carry.manualOffsetX,
      manualOffsetY: this.carry.manualOffsetY,
      manualOffsetZ: this.carry.manualOffsetZ,
    };
  }

  _restoreCarryValidState() {
    const lv = this.carry?.lastValid;
    if (!lv) return false;
    this.carry.quaternion.copy(lv.quaternion);
    this.carry.surfaceNormal.copy(lv.surfaceNormal);
    this.carry.activeMechKind = lv.activeMechKind || null;
    this.carry.spinAngle = lv.spinAngle;
    this.carry.manualTiltApplied = lv.manualTiltApplied;
    this.carry.manualOffsetX = lv.manualOffsetX || 0;
    this.carry.manualOffsetY = lv.manualOffsetY;
    this.carry.manualOffsetZ = lv.manualOffsetZ || 0;
    this._recomputeCarryBounds();
    this.carry.ghost.position.copy(lv.position);
    this.carry.ghost.quaternion.copy(lv.quaternion);
    return true;
  }

  _updateCarryTransform() {
    if (!this.carry || !this._lastHit) return;
    const hit = this._lastHit;
    const pt = hit.point;

    if (this._isInPileZone(pt.x, pt.z)) {
      this.carry.ghost.position.set(pt.x, Math.max(20, pt.y + 18), pt.z);
      this.carry.ghost.quaternion.copy(this.carry.quaternion);
      this.carry.isColliding = false;
      return;
    }

    const ignoreMesh = this.carry.ignoreSet || this.carry.origPlaced?.mesh || null;
    const candidateBoxes = this.carry.mesh.userData.collisionBoxes || [this.carry.localBox];
    const rawN = hit.normal || WORLD_Y;
    const c = snapNormalToCardinal(rawN.x, rawN.y, rawN.z);
    const cardN = new THREE.Vector3(c.x, c.y, c.z);

    // 1. Conexión realista por circulitos ("studs") o encastre mecánico (pin/axle/clip/mano/bisagra/bola)
    const bestStud = this._findBestConnectionStud(hit, cardN, ignoreMesh);
    const bestMech =
      bestStud || this.carry.source === "group"
        ? null
        : findBestMechanicalMatch({
            carriedMesh: this.carry.mesh,
            carriedQuat: this.carry.quaternion,
            autoOrient: this.autoOrient,
            manualTiltApplied: this.carry.manualTiltApplied,
            spinAngle: this.carry.spinAngle,
            hit,
            cardN,
            placedPieces: this.placedPieces,
            ignoreMesh,
          });

    if (this.autoOrient && !this.carry.manualTiltApplied) {
      if (bestMech) {
        if (!this.carry.activeMechKind) {
          this.carry.manualOffsetX = 0;
          this.carry.manualOffsetY = 0;
          this.carry.manualOffsetZ = 0;
        }
        this.carry.activeMechKind = bestMech.kind;
        if (bestMech.quaternion.angleTo(this.carry.quaternion) > 0.001) {
          this.carry.quaternion.copy(bestMech.quaternion);
          this._recomputeCarryBounds();
        }
      } else {
        const targetN = bestStud ? bestStud.studUp : WORLD_Y;
        if (
          this.carry.activeMechKind ||
          targetN.distanceToSquared(this.carry.surfaceNormal) > 0.01
        ) {
          this.carry.activeMechKind = null;
          this.carry.surfaceNormal.copy(targetN);
          this.carry.manualOffsetX = 0;
          this.carry.manualOffsetY = 0;
          this.carry.manualOffsetZ = 0;
          this._applyAutoOrientation(targetN);
          this._recomputeCarryBounds();
        }
      }
    } else if (!bestMech) {
      this.carry.activeMechKind = null;
    } else {
      this.carry.activeMechKind = bestMech.kind;
    }

    const step = this.fineGrid ? LDU_HALF_STUD : LDU_STUD;
    const minAllowedY = -this.carry.ghostBox.min.y;
    const candList = [];
    let activeNormal = WORLD_Y;

    if (bestStud) {
      activeNormal = bestStud.studUp;
      const normalAxis =
        Math.abs(activeNormal.x) > 0.5 ? "x" : Math.abs(activeNormal.y) > 0.5 ? "y" : "z";
      const tangentAxes =
        normalAxis === "y" ? ["x", "z"] : normalAxis === "x" ? ["y", "z"] : ["x", "y"];

      const { supportDist, worldReceptors, receptorsCenter } =
        this._resolveCarryConnectionGeometry(activeNormal);
      const [ax0, ax1] = tangentAxes;
      const desiredOrigin = new THREE.Vector3().subVectors(pt, receptorsCenter);

      // Agrupa receptores por paridad distinta (ej. esquinas +-10 y centro (0,0) en Dish/Jumper)
      const mod20 = (val) => ((Math.round(val) % 20) + 20) % 20;
      const uniqueReceptors = [];
      const seenMod = new Set();
      for (const r of worldReceptors) {
        const key = `${mod20(r[ax0])}_${mod20(r[ax1])}`;
        if (!seenMod.has(key)) {
          seenMod.add(key);
          uniqueReceptors.push(r);
        }
      }

      const span0 = this.carry.ghostBox.max[ax0] - this.carry.ghostBox.min[ax0];
      const span1 = this.carry.ghostBox.max[ax1] - this.carry.ghostBox.min[ax1];
      const multiAxes = [];
      if (span0 > LDU_STUD + 2) multiAxes.push(ax0);
      if (span1 > LDU_STUD + 2) multiAxes.push(ax1);

      const primaryChoices = [];
      for (const refR of uniqueReceptors) {
        const cand = new THREE.Vector3();
        cand[normalAxis] =
          bestStud.studPos[normalAxis] +
          activeNormal[normalAxis] * (supportDist + this.carry.manualOffsetY);
        cand[ax0] =
          span0 <= LDU_STUD + 2
            ? bestStud.studPos[ax0] - refR[ax0]
            : snapToReferenceCoord(desiredOrigin[ax0], refR[ax0], bestStud.studPos[ax0], step);
        cand[ax1] =
          span1 <= LDU_STUD + 2
            ? bestStud.studPos[ax1] - refR[ax1]
            : snapToReferenceCoord(desiredOrigin[ax1], refR[ax1], bestStud.studPos[ax1], step);
        if (cand.y >= minAllowedY - 0.01) {
          if (cand.y < minAllowedY) cand.y = minAllowedY;
          primaryChoices.push(cand);
        }
      }
      primaryChoices.sort(
        (a, b) => a.distanceToSquared(desiredOrigin) - b.distanceToSquared(desiredOrigin)
      );
      const primary = primaryChoices[0] || desiredOrigin.clone();
      for (const p of primaryChoices) {
        candList.push(p);
      }

      // Si choca ligeramente al buscar un hueco justo, probamos deslizar 1 paso en ejes de >1 stud
      // manteniendo conexión real con algún stud del mismo plano
      if (multiAxes.length > 0 && this.collisionEnabled) {
        const neighborOffsets = [];
        for (const ax of multiAxes) {
          for (const dir of [-step, step]) {
            const p = primary.clone();
            p[ax] += dir;
            if (p.y < minAllowedY - 0.01) continue;
            if (p.y < minAllowedY) p.y = minAllowedY;
            neighborOffsets.push(p);
          }
        }
        neighborOffsets.sort(
          (a, b) => a.distanceToSquared(desiredOrigin) - b.distanceToSquared(desiredOrigin)
        );
        for (const np of neighborOffsets) {
          if (
            this._hasStudSupportOnPlane(
              np,
              worldReceptors,
              normalAxis,
              bestStud.studPos[normalAxis],
              activeNormal,
              ignoreMesh
            )
          ) {
            candList.push(np);
          }
        }
      }

      // Si el stud más cercano ya está ocupado/bloqueado en un hueco lateral, probamos la pared tocada
      if (hit.kind === "placed" && (Math.abs(cardN.y) < 0.5 || cardN.y < -0.5)) {
        for (const wc of this._buildWallPocketCandidates(hit, cardN)) {
          candList.push(wc);
        }
      }
    } else if (bestMech) {
      activeNormal = bestMech.targetDir;
      const snapPos = bestMech.position.clone();
      if (snapPos.y < minAllowedY && snapPos.y >= minAllowedY - 0.01) {
        snapPos.y = minAllowedY;
      }
      if (snapPos.y >= minAllowedY - 0.01) {
        candList.push(snapPos);
      }
    } else {
      // 2. Superficie sin studs: mesa libre, cara superior lisa o borde lateral sin stud
      const { supportDist, worldReceptors, receptorsCenter } =
        this._resolveCarryConnectionGeometry(WORLD_Y);
      const refR = worldReceptors[0];

      if (hit.kind === "placed" && cardN.y > 0.5 && hit.object) {
        // Relativo a las celdas de la pieza lisa tocada (respeta desfases de brackets/jumpers)
        const basePiece = this.placedPieces.find((p) => p.mesh === hit.object);
        const baseWb = basePiece?.worldBox || hit.object.userData.worldBox;
        const baseCellX = baseWb ? baseWb.min.x + LDU_HALF_STUD : hit.object.position.x;
        const baseCellZ = baseWb ? baseWb.min.z + LDU_HALF_STUD : hit.object.position.z;
        const desired = new THREE.Vector3().subVectors(pt, receptorsCenter);
        let x = snapToReferenceCoord(desired.x, refR.x, baseCellX, step);
        let z = snapToReferenceCoord(desired.z, refR.z, baseCellZ, step);

        if (baseWb) {
          const probe = computeTransformedWorldBox(
            candidateBoxes,
            new THREE.Vector3(x, 0, z),
            this.carry.quaternion
          );
          const ovX = Math.min(probe.max.x, baseWb.max.x) - Math.max(probe.min.x, baseWb.min.x);
          const ovZ = Math.min(probe.max.z, baseWb.max.z) - Math.max(probe.min.z, baseWb.min.z);
          if (ovX < 4) {
            const centerX = (baseWb.min.x + baseWb.max.x) * 0.5;
            x += x > centerX ? -step : step;
          }
          if (ovZ < 4) {
            const centerZ = (baseWb.min.z + baseWb.max.z) * 0.5;
            z += z > centerZ ? -step : step;
          }
        }

        const supportedY = this._computeSupportedSurfaceAt(
          candidateBoxes,
          x,
          z,
          (baseWb?.max.y ?? pt.y) + 2,
          ignoreMesh
        );
        const y = Math.max(minAllowedY, supportedY + supportDist + this.carry.manualOffsetY);
        candList.push(new THREE.Vector3(x, y, z));
      } else {
        const snapped = snapXZ(pt.x, pt.z, {
          fineGrid: this.fineGrid,
          offsetX: this.carry.parityOffsetX,
          offsetZ: this.carry.parityOffsetZ,
        });
        // En paredes/esquinas sin stud no dejamos flotar la pieza en el aire a altura `pt.y`:
        // buscamos soporte sólido real debajo `(x, z)` o bajamos a la mesa.
        const surfaceY =
          hit.kind === "table"
            ? computeSurfaceY(pt.y, true)
            : this._computeSupportedSurfaceAt(
                candidateBoxes,
                snapped.x,
                snapped.z,
                pt.y + 2,
                ignoreMesh
              );
        const y = Math.max(
          minAllowedY,
          surfaceY + supportDist + this.carry.manualOffsetY
        );
        const floorCand = new THREE.Vector3(snapped.x, y, snapped.z);

        const isWallOrCeiling = hit.kind === "placed" && (Math.abs(cardN.y) < 0.5 || cardN.y < -0.5);
        if (isWallOrCeiling) {
          const wallCands = this._buildWallPocketCandidates(hit, cardN);
          const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.carry.quaternion);
          const baseFacesWall = localUp.dot(cardN) > 0.7 || cardN.y < -0.5;
          if (baseFacesWall) {
            for (const wc of wallCands) candList.push(wc);
            candList.push(floorCand);
          } else {
            candList.push(floorCand);
            for (const wc of wallCands) candList.push(wc);
          }
        } else {
          candList.push(floorCand);
        }
      }
    }

    if (this.carry.manualOffsetX || this.carry.manualOffsetZ) {
      for (const cand of candList) {
        cand.x += this.carry.manualOffsetX;
        cand.z += this.carry.manualOffsetZ;
      }
    }

    const primaryCand =
      candList[0] ||
      new THREE.Vector3(
        pt.x + this.carry.manualOffsetX,
        Math.max(minAllowedY, pt.y),
        pt.z + this.carry.manualOffsetZ
      );

    const candidateMeshData =
      this.carry.source === "group" ? null : this.carry.mesh.userData.collisionMeshData || null;

    if (!this.collisionEnabled) {
      this.carry.ghost.position.copy(primaryCand);
      this.carry.ghost.quaternion.copy(this.carry.quaternion);
      this.carry.isColliding = false;
      this._saveCarryValidState(primaryCand);
      this._emitStatus();
      return;
    }

    for (const cand of candList) {
      if (
        !checkPieceCollision(
          candidateBoxes,
          cand,
          this.carry.quaternion,
          this.placedPieces,
          ignoreMesh,
          0.052,
          candidateMeshData
        )
      ) {
        this.carry.ghost.position.copy(cand);
        this.carry.ghost.quaternion.copy(this.carry.quaternion);
        this.carry.isColliding = false;
        this._saveCarryValidState(cand);
        this._emitStatus();
        return;
      }
    }

    // En modo horizontal sobre piezas, intentamos apoyar exactamente encima de obstáculos bajos (<= 24 LDU)
    if (activeNormal.y > 0.85) {
      const colliders = findCollidingPieces(
        candidateBoxes,
        primaryCand,
        this.carry.quaternion,
        this.placedPieces,
        ignoreMesh,
        0.052,
        candidateMeshData
      );
      if (colliders.length > 0) {
        const { supportDist } = this._resolveCarryConnectionGeometry(WORLD_Y);
        const maxObsY = Math.max(...colliders.map((p) => p.worldBox.max.y));
        const liftedY = Math.max(minAllowedY, maxObsY + supportDist);
        if (liftedY > primaryCand.y && liftedY - primaryCand.y <= 24) {
          const liftedPos = new THREE.Vector3(primaryCand.x, liftedY, primaryCand.z);
          if (
            !checkPieceCollision(
              candidateBoxes,
              liftedPos,
              this.carry.quaternion,
              this.placedPieces,
              ignoreMesh,
              0.052,
              candidateMeshData
            )
          ) {
            this.carry.ghost.position.copy(liftedPos);
            this.carry.ghost.quaternion.copy(this.carry.quaternion);
            this.carry.isColliding = false;
            this._saveCarryValidState(liftedPos);
            this._emitStatus();
            return;
          }
        }
      }
    }

    // Si está chocando contra una pared/pieza, retenemos la última pose válida solo si está contigua
    const lv = this.carry.lastValid;
    if (
      lv &&
      lv.position.distanceTo(primaryCand) <= 38 &&
      lv.surfaceNormal.distanceToSquared(this.carry.surfaceNormal) < 0.05 &&
      this._restoreCarryValidState()
    ) {
      this.carry.isColliding = false;
      this._emitStatus();
      return;
    }

    // Vista previa no penetrante justo por fuera del obstáculo (sin permitir soltar adentro)
    const escapeDir = bestStud ? bestStud.studUp : WORLD_Y;
    const fallbackPos = primaryCand.clone();
    for (let s = 1; s <= 6; s += 1) {
      fallbackPos.copy(primaryCand).addScaledVector(escapeDir, s * LDU_HALF_PLATE);
      if (
        !checkPieceCollision(
          candidateBoxes,
          fallbackPos,
          this.carry.quaternion,
          this.placedPieces,
          ignoreMesh,
          0.052,
          candidateMeshData
        )
      ) {
        break;
      }
    }
    this.carry.ghost.position.copy(fallbackPos);
    this.carry.ghost.quaternion.copy(this.carry.quaternion);
    this.carry.isColliding = true;
    this._emitStatus();
  }

  /**
   * Gestiona PointerDown izquierdo:
   * - En la zona de pila suelta, agarra la pieza DE UNA (click o arrastre directo).
   * - En la zona de armado, requiere estar seleccionada primero (1er click selecciona, 2do mueve).
   */
  handleLeftPointerDown(clientX, clientY) {
    const hit = this.sceneManager.raycastWorkspace(clientX, clientY);
    if (!hit) return false;

    const overBagZone = this.pilePhysics.isPointInAnyBag(hit.point.x, hit.point.z, 14);
    if (this.carry) {
      if (overBagZone) {
        this.sceneManager.controls.enabled = false;
        return true;
      }
      return false;
    }

    if (hit.kind === "pile") {
      const entry = this.pilePhysics.findByMesh(hit.object);
      if (!entry) return false;
      if (!this._ensureNotLocked([entry.instanceId])) return true;
      this.clearSelection();
      this._draggingPileEntry = entry;
      this.roomManager?.requestLock([entry.instanceId]);
      this.sceneManager.controls.enabled = false;
      return true;
    }

    // Evita que un click accidental en un hueco vacío dentro de las cajas rote la cámara
    if (overBagZone) {
      this.clearSelection();
      this.sceneManager.controls.enabled = false;
      return true;
    }

    if (hit.kind === "placed" && this.selected?.kind === "placed" && this.selected.item.mesh === hit.object) {
      // Levantamos la pieza seleccionada para arrastrarla inmediatamente
      this._liftPlacedPiece(this.selected.item);
      this._lastHit = this.sceneManager.raycastWorkspace(clientX, clientY, {
        ignoreObject: this.carry?.origPlaced?.mesh || null,
      });
      this._updateCarryTransform();
      this.sceneManager.controls.enabled = false;
      this._draggedCarryFromPress = true;
      return true;
    }

    if (
      hit.kind === "placed" &&
      this.selected?.kind === "group" &&
      this.selected.items.some((p) => p.mesh === hit.object)
    ) {
      // Levantamos el grupo temporal completo para moverlo como una única pieza
      this._liftGroupPieces(this.selected.items);
      this._lastHit = this.sceneManager.raycastWorkspace(clientX, clientY, {
        ignoreObject: this.carry?.ignoreSet || null,
      });
      this._updateCarryTransform();
      this.sceneManager.controls.enabled = false;
      this._draggedCarryFromPress = true;
      return true;
    }

    return false;
  }

  handlePointerMove(clientX, clientY) {
    if (this._rightDrag) {
      this._handleRightDragMove(clientX, clientY);
      return;
    }

    if (this._draggingPileEntry) {
      const hit = this.sceneManager.raycastWorkspace(clientX, clientY, {
        ignoreObject: this._draggingPileEntry.mesh,
        includePile: false,
      });
      if (!hit) return;

      // Si el usuario arrastró la pieza fuera de la pila hacia la zona de armado, la levantamos en modo ghost
      if (!this._isInPileZone(hit.point.x, hit.point.z)) {
        const entry = this._draggingPileEntry;
        this._draggingPileEntry = null;
        this._draggedCarryFromPress = true;
        this._liftPileEntry(entry);
        this._lastHit = hit;
        this._updateCarryTransform();
        return;
      }

      if (!this.pilePhysics.passiveMode) {
        this.pilePhysics.dragBodyToward(
          this._draggingPileEntry,
          hit.point.x,
          Math.max(18, hit.point.y + 12),
          hit.point.z
        );
      } else if (this._isGuestRoom()) {
        // En invitado delegamos el arrastre físico al Host para revolear/empujar con colisiones reales
        const now = performance.now();
        if (!this._lastGuestPileDragSentAt || now - this._lastGuestPileDragSentAt >= 32) {
          this._lastGuestPileDragSentAt = now;
          this.roomManager.sendGuestAction({
            type: "guest:op",
            op: "pile-drag",
            instanceId: this._draggingPileEntry.instanceId,
            x: Math.round(hit.point.x * 10) / 10,
            y: Math.round(Math.max(18, hit.point.y + 12) * 10) / 10,
            z: Math.round(hit.point.z * 10) / 10,
          });
        }
      }
      return;
    }

    if (this.carry) {
      const ignoreMesh = this.carry.ignoreSet || this.carry.origPlaced?.mesh || null;
      const hit = this.sceneManager.raycastWorkspace(clientX, clientY, {
        ignoreObject: ignoreMesh,
      });
      if (!hit) return;
      this._lastHit = hit;
      this._updateCarryTransform();
    }
  }

  async handleLeftPointerUp(clientX, clientY, wasClick) {
    this.sceneManager.controls.enabled = true;

    if (this._draggingPileEntry) {
      const entry = this._draggingPileEntry;
      this._draggingPileEntry = null;
      if (wasClick) {
        // 2do click rápido sin arrastrar sobre la pieza de la pila -> levantarla para armar
        await this._liftPileEntry(entry);
        const hit = this.sceneManager.raycastWorkspace(clientX, clientY);
        if (hit) {
          this._lastHit = hit;
          this._updateCarryTransform();
        }
      } else {
        this.roomManager?.releaseLocks([entry.instanceId]);
      }
      return;
    }

    if (this._draggedCarryFromPress && this.carry) {
      this._draggedCarryFromPress = false;
      // Si arrastró (>5px), suelta al liberar el mouse; si fue un 2do click rápido, queda levantada
      if (!wasClick) {
        this._commitCarry();
      }
      return;
    }
    this._draggedCarryFromPress = false;

    if (!wasClick) return;

    if (this.carry) {
      this._commitCarry();
      return;
    }

    const hit = this.sceneManager.raycastWorkspace(clientX, clientY);
    if (!hit || hit.kind === "table") {
      this.clearSelection();
      return;
    }

    if (hit.kind === "pile") {
      const entry = this.pilePhysics.findByMesh(hit.object);
      if (!entry) return;
      if (this.selected?.kind === "pile" && this.selected.item === entry) {
        await this._liftPileEntry(entry);
      } else {
        this._selectPile(entry);
      }
      return;
    }

    if (hit.kind === "placed") {
      const piece = this.placedPieces.find((p) => p.mesh === hit.object);
      if (!piece) return;
      if (
        this.selected?.kind === "group" &&
        this.selected.items.some((p) => p.mesh === hit.object)
      ) {
        this._liftGroupPieces(this.selected.items);
        this._lastHit = this.sceneManager.raycastWorkspace(clientX, clientY, {
          ignoreObject: this.carry?.ignoreSet || null,
        });
        this._updateCarryTransform();
      } else if (this.selected?.kind === "placed" && this.selected.item === piece) {
        this._lastHit = this.sceneManager.raycastWorkspace(clientX, clientY, {
          ignoreObject: piece.mesh,
        });
        this._liftPlacedPiece(piece);
      } else {
        this._selectPlaced(piece);
      }
    }
  }

  _broadcastMovePlaced(piece) {
    if (!this._isHostRoom() || !piece) return;
    this.roomManager.broadcastWorldEvent({
      type: "world:op",
      op: "move-placed",
      instanceId: piece.instanceId,
      position: { x: piece.mesh.position.x, y: piece.mesh.position.y, z: piece.mesh.position.z },
      rotation: { x: piece.mesh.rotation.x, y: piece.mesh.rotation.y, z: piece.mesh.rotation.z },
    });
  }

  _broadcastMoveGroup(pieces) {
    if (!this._isHostRoom() || !pieces?.length) return;
    this.roomManager.broadcastWorldEvent({
      type: "world:op",
      op: "move-group",
      items: pieces.map((p) => ({
        instanceId: p.instanceId,
        position: { x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z },
        rotation: { x: p.mesh.rotation.x, y: p.mesh.rotation.y, z: p.mesh.rotation.z },
      })),
    });
  }

  _commitCarry() {
    if (!this.carry) return;
    const c = this.carry;
    const pos = c.ghost.position.clone();
    const rot = c.ghost.rotation.clone();
    const quat = c.ghost.quaternion.clone();

    if (!this._isInPileZone(pos.x, pos.z) && c.isColliding && this.collisionEnabled) {
      this.callbacks.onToast?.("No se puede colocar: choca con otra pieza (K para ignorar)");
      return;
    }

    const lockIds = this._collectCarryLockIds(c);
    this.roomManager?.sendPresence?.({ type: "carry:preview", active: false });

    if (this._isGuestRoom()) {
      this.sceneManager.scene.remove(c.ghost);
      this.carry = null;
      if (this._isInPileZone(pos.x, pos.z)) {
        if (c.source === "group" && c.origGroup) {
          for (const entry of c.origGroup) this.sceneManager.setPlacedVisible(entry.piece.mesh, true);
          this.roomManager.sendGuestAction({
            type: "guest:op",
            op: "to-pile-group",
            instanceIds: c.origGroup.map((e) => e.piece.instanceId),
            position: { x: pos.x, y: pos.y, z: pos.z },
          });
        } else if (c.source === "placed" && c.origPlaced) {
          this.sceneManager.setPlacedVisible(c.origPlaced.mesh, true);
          this.roomManager.sendGuestAction({
            type: "guest:op",
            op: "to-pile",
            instanceId: c.origPlaced.instanceId,
            position: { x: pos.x, y: pos.y, z: pos.z },
          });
        } else if (c.source === "pile" && c.origEntry) {
          const id = c.origEntry.instanceId;
          const bagNum = c.origEntry.bagNumber || c.mesh.userData.bagNumber || 1;
          c.mesh.visible = true;
          this.pilePhysics.addPiece(id, c.elementId, c.mesh, c.localBox, { x: pos.x, y: Math.max(30, pos.y), z: pos.z }, false, bagNum);
          this.sceneManager.addPileMesh(c.mesh);
          this.roomManager.sendGuestAction({
            type: "guest:op",
            op: "move-pile-drop",
            pileInstanceId: id,
            position: { x: pos.x, y: pos.y, z: pos.z },
          });
        } else if (c.source === "pool") {
          this.roomManager.sendGuestAction({
            type: "guest:op",
            op: "place-pool",
            elementId: c.elementId,
            intoPile: true,
            position: { x: pos.x, y: pos.y, z: pos.z },
          });
        }
      } else if (c.source === "group" && c.origGroup) {
        const itemsPayload = [];
        const movedPieces = [];
        for (const entry of c.origGroup) {
          const p = entry.piece;
          const nextPos = entry.relPos.clone().applyQuaternion(quat).add(pos);
          const nextQuat = quat.clone().multiply(entry.relQuat);
          p.mesh.position.copy(nextPos);
          p.mesh.quaternion.copy(nextQuat);
          this.sceneManager.setPlacedVisible(p.mesh, true);
          this._refreshPlacedWorldBox(p);
          movedPieces.push(p);
          itemsPayload.push({
            instanceId: p.instanceId,
            position: { x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z },
            rotation: { x: p.mesh.rotation.x, y: p.mesh.rotation.y, z: p.mesh.rotation.z },
          });
        }
        this.roomManager.sendGuestAction({ type: "guest:op", op: "move-group", items: itemsPayload });
        this._selectGroup(movedPieces);
      } else if (c.source === "placed" && c.origPlaced) {
        const piece = c.origPlaced;
        piece.mesh.position.copy(pos);
        piece.mesh.rotation.copy(rot);
        this.sceneManager.setPlacedVisible(piece.mesh, true);
        this._refreshPlacedWorldBox(piece);
        this.roomManager.sendGuestAction({
          type: "guest:op",
          op: "move-placed",
          instanceId: piece.instanceId,
          position: { x: pos.x, y: pos.y, z: pos.z },
          rotation: { x: rot.x, y: rot.y, z: rot.z },
        });
        this._selectPlaced(piece);
      } else if (c.source === "pile" && c.origEntry) {
        this.roomManager.sendGuestAction({
          type: "guest:op",
          op: "pile-to-placed",
          pileInstanceId: c.origEntry.instanceId,
          position: { x: pos.x, y: pos.y, z: pos.z },
          rotation: { x: rot.x, y: rot.y, z: rot.z },
        });
      } else {
        this.roomManager.sendGuestAction({
          type: "guest:op",
          op: "place-pool",
          elementId: c.elementId,
          intoPile: false,
          position: { x: pos.x, y: pos.y, z: pos.z },
          rotation: { x: rot.x, y: rot.y, z: rot.z },
        });
      }
      if (lockIds.length) this.roomManager.releaseLocks(lockIds);
      this._emitChange();
      return;
    }

    // Si la soltamos en la zona de la pila, vuelve a ser pieza suelta con física
    if (this._isInPileZone(pos.x, pos.z)) {
      this.sceneManager.scene.remove(c.ghost);
      this.carry = null;
      if (c.source === "group" && c.origGroup) {
        const removedSet = new Set(c.origGroup.map((e) => e.piece.instanceId));
        this.placedPieces = this.placedPieces.filter((p) => !removedSet.has(p.instanceId));
        const undoItems = [];
        const netPileItems = [];
        for (const entry of c.origGroup) {
          const p = entry.piece;
          const savedStickers = Array.isArray(p.stickers) ? structuredClone(p.stickers) : [];
          this._clearStickersFromMesh(p.mesh);
          p.stickers = [];
          this.sceneManager.removePlacedMesh(p.mesh);
          p.mesh.visible = true;
          const id = `pile_${this.nextInstanceSeq++}`;
          p.mesh.userData.instanceId = id;
          const bagNum = p.mesh.userData.bagNumber || this._getDefaultBagForElement(p.elementId);
          this.pilePhysics.addPiece(
            id,
            p.elementId,
            p.mesh,
            p.localBox,
            { x: pos.x, y: Math.max(30, pos.y), z: pos.z },
            false,
            bagNum
          );
          this.sceneManager.addPileMesh(p.mesh);
          undoItems.push({
            instanceId: p.instanceId,
            pileInstanceId: id,
            elementId: p.elementId,
            position: entry.origPos.clone(),
            rotation: entry.origRot.clone(),
            stickers: savedStickers,
          });
          netPileItems.push({
            instanceId: id,
            elementId: p.elementId,
            bagNumber: bagNum,
            position: { x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z },
            quaternion: { x: p.mesh.quaternion.x, y: p.mesh.quaternion.y, z: p.mesh.quaternion.z, w: p.mesh.quaternion.w },
          });
        }
        this.history.push({ type: "remove-group", items: undoItems });
        if (this._isHostRoom()) {
          this.roomManager.broadcastWorldEvent({
            type: "world:op",
            op: "placed-group-to-pile",
            nextInstanceSeq: this.nextInstanceSeq,
            removedInstanceIds: [...removedSet],
            pileItems: netPileItems,
          });
        }
        if (lockIds.length) this.roomManager?.releaseLocks(lockIds);
        this._emitChange();
        return;
      }

      if (c.source === "placed" && c.origPlaced) {
        const orig = c.origPlaced;
        const savedStickers = Array.isArray(orig.stickers) ? structuredClone(orig.stickers) : [];
        this._clearStickersFromMesh(orig.mesh);
        orig.stickers = [];
        this.sceneManager.removePlacedMesh(orig.mesh);
        this.placedPieces = this.placedPieces.filter((p) => p.instanceId !== orig.instanceId);
        orig.mesh.visible = true;
        const id = `pile_${this.nextInstanceSeq++}`;
        orig.mesh.userData.instanceId = id;
        const bagNum = orig.mesh.userData.bagNumber || this._getDefaultBagForElement(orig.elementId);
        this.pilePhysics.addPiece(
          id,
          orig.elementId,
          orig.mesh,
          orig.localBox,
          { x: pos.x, y: Math.max(30, pos.y), z: pos.z },
          false,
          bagNum
        );
        this.sceneManager.addPileMesh(orig.mesh);
        this.history.push({
          type: "remove",
          instanceId: orig.instanceId,
          pileInstanceId: id,
          elementId: orig.elementId,
          position: orig.mesh.position.clone(),
          rotation: orig.mesh.rotation.clone(),
          stickers: savedStickers,
        });
        if (this._isHostRoom()) {
          this.roomManager.broadcastWorldEvent({
            type: "world:op",
            op: "placed-to-pile",
            nextInstanceSeq: this.nextInstanceSeq,
            removedInstanceId: orig.instanceId,
            pileItem: {
              instanceId: id,
              elementId: orig.elementId,
              bagNumber: bagNum,
              position: { x: orig.mesh.position.x, y: orig.mesh.position.y, z: orig.mesh.position.z },
              quaternion: { x: orig.mesh.quaternion.x, y: orig.mesh.quaternion.y, z: orig.mesh.quaternion.z, w: orig.mesh.quaternion.w },
            },
          });
        }
        if (lockIds.length) this.roomManager?.releaseLocks(lockIds);
        this._emitChange();
        return;
      }

      c.mesh.visible = true;
      const id = c.origEntry?.instanceId || `pile_${this.nextInstanceSeq++}`;
      const dropBag =
        this.pilePhysics.bagZones.find(
          (bz) =>
            pos.x >= bz.minX - 20 &&
            pos.x <= bz.maxX + 20 &&
            pos.z >= bz.minZ - 20 &&
            pos.z <= bz.maxZ + 20
        )?.bagNumber ||
        c.origEntry?.bagNumber ||
        c.mesh.userData.bagNumber ||
        this._getDefaultBagForElement(c.elementId);
      c.mesh.userData.bagNumber = dropBag;
      this.pilePhysics.addPiece(
        id,
        c.elementId,
        c.mesh,
        c.localBox,
        { x: pos.x, y: Math.max(30, pos.y), z: pos.z },
        false,
        dropBag
      );
      this.sceneManager.addPileMesh(c.mesh);
      if (c.source === "pool" && this._isHostRoom()) {
        this.roomManager.broadcastWorldEvent({
          type: "world:op",
          op: "spawn-pile",
          nextInstanceSeq: this.nextInstanceSeq,
          consumePoolElementId: c.elementId,
          item: {
            instanceId: id,
            elementId: c.elementId,
            bagNumber: dropBag,
            position: { x: c.mesh.position.x, y: c.mesh.position.y, z: c.mesh.position.z },
            quaternion: { x: c.mesh.quaternion.x, y: c.mesh.quaternion.y, z: c.mesh.quaternion.z, w: c.mesh.quaternion.w },
          },
        });
      }
      if (lockIds.length) this.roomManager?.releaseLocks(lockIds);
      this._emitChange();
      return;
    }

    this.sceneManager.scene.remove(c.ghost);
    this.carry = null;

    if (c.source === "group" && c.origGroup) {
      const moveRecords = [];
      const movedPieces = [];
      for (const entry of c.origGroup) {
        const p = entry.piece;
        const nextPos = entry.relPos.clone().applyQuaternion(quat).add(pos);
        const nextQuat = quat.clone().multiply(entry.relQuat);
        p.mesh.position.copy(nextPos);
        p.mesh.quaternion.copy(nextQuat);
        this.sceneManager.setPlacedVisible(p.mesh, true);
        this._refreshPlacedWorldBox(p);
        moveRecords.push({
          instanceId: p.instanceId,
          prevState: { position: entry.origPos.clone(), rotation: entry.origRot.clone() },
          newState: { position: p.mesh.position.clone(), rotation: p.mesh.rotation.clone() },
        });
        movedPieces.push(p);
      }
      this.history.push({ type: "move-group", items: moveRecords });
      this._broadcastMoveGroup(movedPieces);
      this._selectGroup(movedPieces);
      this._emitChange();
      return;
    }

    if (c.source === "placed" && c.origPlaced) {
      const piece = c.origPlaced;
      const prevState = {
        position: piece.mesh.position.clone(),
        rotation: piece.mesh.rotation.clone(),
      };
      piece.mesh.position.copy(pos);
      piece.mesh.rotation.copy(rot);
      this.sceneManager.setPlacedVisible(piece.mesh, true);
      this._refreshPlacedWorldBox(piece);
      this.history.push({
        type: "move",
        instanceId: piece.instanceId,
        prevState,
        newState: { position: pos.clone(), rotation: rot.clone() },
      });
      this._broadcastMovePlaced(piece);
      this._selectPlaced(piece);
      this._emitChange();
      return;
    }

    const instanceId = `p_${this.nextInstanceSeq++}`;
    c.mesh.position.copy(pos);
    c.mesh.rotation.copy(rot);
    c.mesh.visible = true;
    c.mesh.userData.instanceId = instanceId;
    c.mesh.userData.elementId = c.elementId;

    this.sceneManager.addPlacedMesh(c.mesh);
    const placed = {
      instanceId,
      elementId: c.elementId,
      mesh: c.mesh,
      localBox: c.localBox,
    };
    this._refreshPlacedWorldBox(placed);
    this.placedPieces.push(placed);
    this.history.push({
      type: "add",
      instanceId,
      elementId: c.elementId,
      position: pos.clone(),
      rotation: rot.clone(),
    });
    if (this._isHostRoom()) {
      const opMsg =
        c.source === "pile" && c.origEntry
          ? {
              type: "world:op",
              op: "pile-to-placed",
              nextInstanceSeq: this.nextInstanceSeq,
              pileInstanceId: c.origEntry.instanceId,
              piece: {
                instanceId,
                elementId: c.elementId,
                bagNumber: c.mesh.userData.bagNumber || 1,
                position: { x: pos.x, y: pos.y, z: pos.z },
                rotation: { x: rot.x, y: rot.y, z: rot.z },
              },
            }
          : {
              type: "world:op",
              op: "add-placed",
              nextInstanceSeq: this.nextInstanceSeq,
              consumePoolElementId: c.source === "pool" ? c.elementId : null,
              piece: {
                instanceId,
                elementId: c.elementId,
                bagNumber: c.mesh.userData.bagNumber || 1,
                position: { x: pos.x, y: pos.y, z: pos.z },
                rotation: { x: rot.x, y: rot.y, z: rot.z },
              },
            };
      this.roomManager.broadcastWorldEvent(opMsg);
    }
    if (lockIds.length) this.roomManager?.releaseLocks(lockIds);
    this._selectPlaced(placed);
    this._emitChange();
  }

  /**
   * Click derecho mantenido sobre pieza seleccionada/activa -> rotación suave con umbral de píxeles.
   */
  handleRightPointerDown(clientX, clientY) {
    if (!this.selected && !this.carry) return false;
    this.sceneManager.controls.enablePan = false;
    this.sceneManager.controls.enableRotate = false;
    this._rightDrag = {
      lastX: clientX,
      lastY: clientY,
      accumX: 0,
      accumY: 0,
    };
    return true;
  }

  _handleRightDragMove(clientX, clientY) {
    if (!this._rightDrag) return;
    this._rightDrag.accumX += clientX - this._rightDrag.lastX;
    this._rightDrag.accumY += clientY - this._rightDrag.lastY;
    this._rightDrag.lastX = clientX;
    this._rightDrag.lastY = clientY;

    if (Math.abs(this._rightDrag.accumX) >= ROTATE_DRAG_THRESHOLD_PX) {
      const dir = this._rightDrag.accumX > 0 ? 1 : -1;
      this.rotateActive("y", -dir);
      // Limita a un paso por gesto brusco y evita mezcla accidental con el eje perpendicular
      this._rightDrag.accumX = 0;
      this._rightDrag.accumY = 0;
    } else if (Math.abs(this._rightDrag.accumY) >= ROTATE_DRAG_THRESHOLD_PX) {
      const dir = this._rightDrag.accumY > 0 ? 1 : -1;
      this.rotateActive("x", dir);
      this._rightDrag.accumX = 0;
      this._rightDrag.accumY = 0;
    }
  }

  handleRightPointerUp() {
    if (!this._rightDrag) return;
    this._rightDrag = null;
    this.sceneManager.controls.enablePan = true;
    this.sceneManager.controls.enableRotate = true;
  }

  rotateActive(axis, direction = 1) {
    const step = this.fineRotation ? ROTATION_STEP_15 : ROTATION_STEP_90;
    const delta = step * direction;
    const worldAxis = axis === "x" ? WORLD_X : axis === "y" ? WORLD_Y : WORLD_Z;

    if (this.carry) {
      if (this.autoOrient && !this.carry.manualTiltApplied && axis === "y") {
        this.carry.spinAngle = snapAngle(this.carry.spinAngle + delta, step);
        if (!this.carry.activeMechKind) {
          this._applyAutoOrientation(this.carry.surfaceNormal);
        }
      } else {
        if (axis !== "y" || !this.autoOrient) {
          this.carry.manualTiltApplied = true;
        }
        const qDelta = new THREE.Quaternion().setFromAxisAngle(worldAxis, delta);
        this.carry.quaternion.premultiply(qDelta).normalize();
      }
      this._recomputeCarryBounds();
      this._updateCarryTransform();
      this._emitStatus();
      return;
    }

    if (this.selected?.kind === "group") {
      const items = this.selected.items;
      const meta = this._buildGroupCompositeData(items);
      const qDelta = new THREE.Quaternion().setFromAxisAngle(worldAxis, delta);
      const ignoreSet = new Set(items.map((p) => p.mesh));
      const nextOrigin = meta.pivotPos.clone();

      // Si al voltear el grupo alguna parte bajaría por debajo de la mesa, compensamos en Y
      const rotatedBox = computeTransformedWorldBox(meta.compositeBoxes, nextOrigin, qDelta);
      if (rotatedBox.min.y < -0.01) {
        nextOrigin.y += Math.ceil((-rotatedBox.min.y - 0.01) / LDU_PLATE) * LDU_PLATE;
      }

      if (
        this.collisionEnabled &&
        checkPieceCollision(meta.compositeBoxes, nextOrigin, qDelta, this.placedPieces, ignoreSet)
      ) {
        this.callbacks.onToast?.("No hay espacio para rotar el grupo ahí.");
        return;
      }

      const moveRecords = [];
      for (const entry of meta.entries) {
        const p = entry.piece;
        const nextPos = entry.relPos.clone().applyQuaternion(qDelta).add(nextOrigin);
        const nextQuat = qDelta.clone().multiply(entry.relQuat);
        p.mesh.position.copy(nextPos);
        p.mesh.quaternion.copy(nextQuat);
        this._refreshPlacedWorldBox(p);
        moveRecords.push({
          instanceId: p.instanceId,
          prevState: { position: entry.origPos.clone(), rotation: entry.origRot.clone() },
          newState: { position: p.mesh.position.clone(), rotation: p.mesh.rotation.clone() },
        });
      }
      this.history.push({ type: "move-group", items: moveRecords });
      if (this._isGuestRoom()) {
        this.roomManager.sendGuestAction({
          type: "guest:op",
          op: "move-group",
          items: items.map((p) => ({
            instanceId: p.instanceId,
            position: { x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z },
            rotation: { x: p.mesh.rotation.x, y: p.mesh.rotation.y, z: p.mesh.rotation.z },
          })),
        });
      } else {
        this._broadcastMoveGroup(items);
      }
      this.sceneManager.refreshSelectionBox();
      this._emitChange();
      return;
    }

    if (this.selected?.kind === "placed") {
      const piece = this.selected.item;
      const prevRot = piece.mesh.rotation.clone();
      const prevQuat = piece.mesh.quaternion.clone();
      const qDelta = new THREE.Quaternion().setFromAxisAngle(worldAxis, delta);
      piece.mesh.quaternion.premultiply(qDelta).normalize();

      const boxes = piece.mesh.userData.collisionBoxes || [piece.localBox];
      const meshData = piece.mesh.userData.collisionMeshData || null;
      if (
        this.collisionEnabled &&
        checkPieceCollision(
          boxes,
          piece.mesh.position,
          piece.mesh.quaternion,
          this.placedPieces,
          piece.mesh,
          0.052,
          meshData
        )
      ) {
        piece.mesh.quaternion.copy(prevQuat);
        this.callbacks.onToast?.("No hay espacio para rotar ahí.");
        return;
      }

      this._refreshPlacedWorldBox(piece);
      if (this._isGuestRoom()) {
        this.roomManager.sendGuestAction({
          type: "guest:op",
          op: "move-placed",
          instanceId: piece.instanceId,
          position: { x: piece.mesh.position.x, y: piece.mesh.position.y, z: piece.mesh.position.z },
          rotation: { x: piece.mesh.rotation.x, y: piece.mesh.rotation.y, z: piece.mesh.rotation.z },
        });
      } else {
        this.history.push({
          type: "move",
          instanceId: piece.instanceId,
          prevState: { position: piece.mesh.position.clone(), rotation: prevRot },
          newState: {
            position: piece.mesh.position.clone(),
            rotation: piece.mesh.rotation.clone(),
          },
        });
        this._broadcastMovePlaced(piece);
      }
      this.sceneManager.refreshSelectionBox();
      this._emitChange();
      return;
    }

    if (this.selected?.kind === "pile") {
      const entry = this.selected.item;
      const qDelta = new THREE.Quaternion().setFromAxisAngle(worldAxis, delta);
      entry.mesh.quaternion.premultiply(qDelta).normalize();
      entry.body.quaternion.set(
        entry.mesh.quaternion.x,
        entry.mesh.quaternion.y,
        entry.mesh.quaternion.z,
        entry.mesh.quaternion.w
      );
      entry.body.wakeUp();
      this.sceneManager.refreshSelectionBox();
    }
  }

  _nudgePlacedOrGroup(deltaVec) {
    if (this.selected?.kind === "group") {
      const items = this.selected.items;
      const meta = this._buildGroupCompositeData(items);
      const minGroupY = Math.min(...items.map((p) => p.worldBox?.min.y ?? p.mesh.position.y));
      const actualDelta = deltaVec.clone();
      if (minGroupY + actualDelta.y < 0) {
        actualDelta.y = -minGroupY;
      }
      if (actualDelta.lengthSq() < 1e-6) return;

      const ignoreSet = new Set(items.map((p) => p.mesh));
      const nextOrigin = meta.pivotPos.clone().add(actualDelta);

      if (
        this.collisionEnabled &&
        checkPieceCollision(
          meta.compositeBoxes,
          nextOrigin,
          new THREE.Quaternion(),
          this.placedPieces,
          ignoreSet
        )
      ) {
        this.callbacks.onToast?.("No hay espacio para mover el grupo ahí.");
        return;
      }

      const moveRecords = [];
      for (const entry of meta.entries) {
        const p = entry.piece;
        p.mesh.position.add(actualDelta);
        this._refreshPlacedWorldBox(p);
        moveRecords.push({
          instanceId: p.instanceId,
          prevState: { position: entry.origPos.clone(), rotation: entry.origRot.clone() },
          newState: { position: p.mesh.position.clone(), rotation: p.mesh.rotation.clone() },
        });
      }
      if (this._isGuestRoom()) {
        this.roomManager.sendGuestAction({
          type: "guest:op",
          op: "move-group",
          items: items.map((p) => ({
            instanceId: p.instanceId,
            position: { x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z },
            rotation: { x: p.mesh.rotation.x, y: p.mesh.rotation.y, z: p.mesh.rotation.z },
          })),
        });
      } else {
        this.history.push({ type: "move-group", items: moveRecords });
        this._broadcastMoveGroup(items);
      }
      this.sceneManager.refreshSelectionBox();
      this._emitChange();
      return;
    }

    if (this.selected?.kind === "placed") {
      const piece = this.selected.item;
      const prevPos = piece.mesh.position.clone();
      const minPieceY = piece.worldBox?.min.y ?? prevPos.y;
      const actualDelta = deltaVec.clone();
      if (minPieceY + actualDelta.y < 0) {
        actualDelta.y = -minPieceY;
      }
      if (actualDelta.lengthSq() < 1e-6) return;

      const nextPos = prevPos.clone().add(actualDelta);
      const boxes = piece.mesh.userData.collisionBoxes || [piece.localBox];
      const meshData = piece.mesh.userData.collisionMeshData || null;
      if (
        this.collisionEnabled &&
        checkPieceCollision(boxes, nextPos, piece.mesh.quaternion, this.placedPieces, piece.mesh, 0.052, meshData)
      ) {
        this.callbacks.onToast?.("No hay espacio para mover la pieza ahí.");
        return;
      }

      piece.mesh.position.copy(nextPos);
      this._refreshPlacedWorldBox(piece);
      if (this._isGuestRoom()) {
        this.roomManager.sendGuestAction({
          type: "guest:op",
          op: "move-placed",
          instanceId: piece.instanceId,
          position: { x: piece.mesh.position.x, y: piece.mesh.position.y, z: piece.mesh.position.z },
          rotation: { x: piece.mesh.rotation.x, y: piece.mesh.rotation.y, z: piece.mesh.rotation.z },
        });
      } else {
        this.history.push({
          type: "move",
          instanceId: piece.instanceId,
          prevState: { position: prevPos, rotation: piece.mesh.rotation.clone() },
          newState: {
            position: piece.mesh.position.clone(),
            rotation: piece.mesh.rotation.clone(),
          },
        });
        this._broadcastMovePlaced(piece);
      }
      this.sceneManager.refreshSelectionBox();
      this._emitChange();
    }
  }

  nudgeVertical(direction = 1, fine = false) {
    const step = fine ? LDU_HALF_PLATE : LDU_PLATE;
    if (this.carry) {
      this.carry.manualOffsetY += step * direction;
      this._updateCarryTransform();
      this._emitStatus();
      return;
    }
    this._nudgePlacedOrGroup(new THREE.Vector3(0, step * direction, 0));
  }

  /**
   * Desplaza la pieza o grupo seleccionado (o en mano) en el plano horizontal
   * de a medio stud (`10 LDU`) a lo largo del eje cardinal indicado.
   */
  nudgeHorizontal(dirX, dirZ, fine = false) {
    const step = fine ? LDU_HALF_PLATE : LDU_HALF_STUD;
    const dx = dirX * step;
    const dz = dirZ * step;
    if (this.carry) {
      this.carry.manualOffsetX += dx;
      this.carry.manualOffsetZ += dz;
      this._updateCarryTransform();
      this._emitStatus();
      return;
    }
    this._nudgePlacedOrGroup(new THREE.Vector3(dx, 0, dz));
  }

  /**
   * Devuelve una pieza colocada (o un grupo temporal) nuevamente a la pila física.
   */
  returnSelectedToPile() {
    if (this.selected?.kind === "group") {
      const items = [...this.selected.items];
      this.clearSelection();
      if (this._isGuestRoom()) {
        this.roomManager.sendGuestAction({
          type: "guest:op",
          op: "to-pile-group",
          instanceIds: items.map((p) => p.instanceId),
        });
        return;
      }
      const removedIds = new Set(items.map((p) => p.instanceId));
      this.placedPieces = this.placedPieces.filter((p) => !removedIds.has(p.instanceId));
      const undoItems = [];
      const netPileItems = [];

      for (const target of items) {
        const origPos = target.mesh.position.clone();
        const origRot = target.mesh.rotation.clone();
        const savedStickers = Array.isArray(target.stickers) ? structuredClone(target.stickers) : [];
        this._clearStickersFromMesh(target.mesh);
        target.stickers = [];
        this.sceneManager.removePlacedMesh(target.mesh);
        const pileId = `pile_${this.nextInstanceSeq++}`;
        target.mesh.userData.instanceId = pileId;
        const bagNum =
          target.mesh.userData.bagNumber || this._getDefaultBagForElement(target.elementId);
        this.pilePhysics.addPiece(pileId, target.elementId, target.mesh, target.localBox, null, true, bagNum);
        this.sceneManager.addPileMesh(target.mesh);
        undoItems.push({
          instanceId: target.instanceId,
          pileInstanceId: pileId,
          elementId: target.elementId,
          position: origPos,
          rotation: origRot,
          stickers: savedStickers,
        });
        netPileItems.push({
          instanceId: pileId,
          elementId: target.elementId,
          bagNumber: bagNum,
          position: { x: target.mesh.position.x, y: target.mesh.position.y, z: target.mesh.position.z },
          quaternion: { x: target.mesh.quaternion.x, y: target.mesh.quaternion.y, z: target.mesh.quaternion.z, w: target.mesh.quaternion.w },
        });
      }

      this.history.push({ type: "remove-group", items: undoItems });
      if (this._isHostRoom()) {
        this.roomManager.broadcastWorldEvent({
          type: "world:op",
          op: "placed-group-to-pile",
          nextInstanceSeq: this.nextInstanceSeq,
          removedInstanceIds: [...removedIds],
          pileItems: netPileItems,
        });
      }
      this._emitChange();
      return;
    }

    if (this.selected?.kind !== "placed") return;
    const target = this.selected.item;
    const savedStickers = Array.isArray(target.stickers) ? structuredClone(target.stickers) : [];
    this.clearSelection();
    if (this._isGuestRoom()) {
      this.roomManager.sendGuestAction({
        type: "guest:op",
        op: "to-pile",
        instanceId: target.instanceId,
      });
      return;
    }
    this._clearStickersFromMesh(target.mesh);
    target.stickers = [];
    this.sceneManager.removePlacedMesh(target.mesh);
    this.placedPieces = this.placedPieces.filter((p) => p.instanceId !== target.instanceId);

    const pileId = `pile_${this.nextInstanceSeq++}`;
    target.mesh.userData.instanceId = pileId;
    const bagNum =
      target.mesh.userData.bagNumber || this._getDefaultBagForElement(target.elementId);
    this.pilePhysics.addPiece(pileId, target.elementId, target.mesh, target.localBox, null, true, bagNum);
    this.sceneManager.addPileMesh(target.mesh);

    this.history.push({
      type: "remove",
      instanceId: target.instanceId,
      pileInstanceId: pileId,
      elementId: target.elementId,
      position: target.mesh.position.clone(),
      rotation: target.mesh.rotation.clone(),
      stickers: savedStickers,
    });
    if (this._isHostRoom()) {
      this.roomManager.broadcastWorldEvent({
        type: "world:op",
        op: "placed-to-pile",
        nextInstanceSeq: this.nextInstanceSeq,
        removedInstanceId: target.instanceId,
        pileItem: {
          instanceId: pileId,
          elementId: target.elementId,
          bagNumber: bagNum,
          position: { x: target.mesh.position.x, y: target.mesh.position.y, z: target.mesh.position.z },
          quaternion: { x: target.mesh.quaternion.x, y: target.mesh.quaternion.y, z: target.mesh.quaternion.z, w: target.mesh.quaternion.w },
        },
      });
    }
    this._emitChange();
  }

  async _restoreRemovedEntry(entry) {
    let removedFromPile = entry.pileInstanceId
      ? this.pilePhysics.removePiece(entry.pileInstanceId)
      : null;
    if (!removedFromPile) {
      const match = this.pilePhysics.items.find((it) => it.elementId === entry.elementId);
      if (match) removedFromPile = this.pilePhysics.removePiece(match.instanceId);
    }
    let mesh = removedFromPile?.mesh;
    let localBox = removedFromPile?.localBox;
    if (mesh) {
      this.sceneManager.removePileMesh(mesh);
    } else {
      const poolIdx = this.pendingPool.findIndex((it) => it.elementId === entry.elementId);
      if (poolIdx !== -1) this.pendingPool.splice(poolIdx, 1);
      const part = this.partsByElementId.get(entry.elementId);
      if (!part) return null;
      const created = await this.ldrawService.createPartInstance(part, {
        lightweight: this.isLightweightSet,
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
          this._attachStickerToPiece(restored, st);
        }
      }
    }
    this.sceneManager.addPlacedMesh(mesh);
    this._refreshPlacedWorldBox(restored);
    this.placedPieces.push(restored);
    return restored;
  }

  async undo() {
    if (this.carry) {
      this.cancelCarry();
      return;
    }
    if (this._isGuestRoom()) {
      this.callbacks.onToast?.("Solo el administrador del slot puede deshacer.");
      return;
    }
    const action = this.history.pop();
    if (!action) {
      this.callbacks.onToast?.("No hay cambios para deshacer.");
      return;
    }

    if (action.type === "add") {
      const piece = this.placedPieces.find((p) => p.instanceId === action.instanceId);
      if (piece) {
        if (
          this.selected?.item === piece ||
          (this.selected?.kind === "group" && this.selected.items.includes(piece))
        ) {
          this.clearSelection();
        }
        this._clearStickersFromMesh(piece.mesh);
        piece.stickers = [];
        this.sceneManager.removePlacedMesh(piece.mesh);
        this.placedPieces = this.placedPieces.filter((p) => p.instanceId !== action.instanceId);
        this.pilePhysics.addPiece(
          `pile_${this.nextInstanceSeq++}`,
          piece.elementId,
          piece.mesh,
          piece.localBox,
          null,
          true,
          piece.mesh.userData.bagNumber || this._getDefaultBagForElement(piece.elementId)
        );
        this.sceneManager.addPileMesh(piece.mesh);
      }
    } else if (action.type === "move") {
      const piece = this.placedPieces.find((p) => p.instanceId === action.instanceId);
      if (piece) {
        piece.mesh.position.copy(action.prevState.position);
        piece.mesh.rotation.copy(action.prevState.rotation);
        this._refreshPlacedWorldBox(piece);
        this.sceneManager.refreshSelectionBox();
      }
    } else if (action.type === "move-group") {
      const restoredPieces = [];
      for (const rec of action.items) {
        const piece = this.placedPieces.find((p) => p.instanceId === rec.instanceId);
        if (piece) {
          piece.mesh.position.copy(rec.prevState.position);
          piece.mesh.rotation.copy(rec.prevState.rotation);
          this._refreshPlacedWorldBox(piece);
          restoredPieces.push(piece);
        }
      }
      if (restoredPieces.length) {
        this._selectGroup(restoredPieces);
      }
    } else if (action.type === "remove") {
      await this._restoreRemovedEntry(action);
    } else if (action.type === "remove-group") {
      const restoredPieces = [];
      for (const entry of action.items) {
        const restored = await this._restoreRemovedEntry(entry);
        if (restored) restoredPieces.push(restored);
      }
      if (restoredPieces.length) {
        this._selectGroup(restoredPieces);
      }
    } else if (action.type === "sticker-add") {
      const piece = this.placedPieces.find((p) => p.instanceId === action.instanceId);
      if (piece) {
        this._detachStickerFromPiece(piece, action.faceKey);
        if (action.prevSticker?.dataUrl) {
          this._attachStickerToPiece(piece, action.prevSticker);
        }
      }
    } else if (action.type === "sticker-remove") {
      const piece = this.placedPieces.find((p) => p.instanceId === action.instanceId);
      if (piece && action.sticker?.dataUrl) {
        this._attachStickerToPiece(piece, action.sticker);
      }
    }
    if (this._isHostRoom()) {
      this.roomManager.broadcastWorldEvent({
        type: "world:snapshot",
        snapshot: this.exportWorldSnapshot(),
      });
    }
    this._emitChange();
  }

  _emitChange() {
    this.callbacks.onBuildChanged?.();
    this._emitStatus();
  }

  _emitStatus() {
    const selectedElementId = this.selected?.item?.elementId || null;
    this.callbacks.onStatusChanged?.({
      isCarrying: Boolean(this.carry),
      isColliding: Boolean(this.carry?.isColliding),
      carryPart: this.carry ? this.partsByElementId.get(this.carry.elementId) : null,
      carryGroupCount: this.carry?.source === "group" ? this.carry.origGroup?.length || 0 : 0,
      selectedKind: this.selected?.kind || null,
      selectedPart: selectedElementId ? this.partsByElementId.get(selectedElementId) : null,
      selectedGroupCount: this.selected?.kind === "group" ? this.selected.items.length : 0,
      fineGrid: this.fineGrid,
      fineRotation: this.fineRotation,
      autoOrient: this.autoOrient,
      collisionEnabled: this.collisionEnabled,
      placedTotal: this.placedPieces.length,
      pileTotal: this.pilePhysics.items.length,
      pendingTotal: this.pendingPool.length,
    });
  }
}
