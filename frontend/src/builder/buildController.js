import * as THREE from "three";
import {
  LDU_HALF_PLATE,
  LDU_HALF_STUD,
  LDU_PLATE,
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
import { checkPieceCollision, computeTransformedWorldBox } from "./collision.js";
import {
  computeStudCoordParityOffset,
  computeWallParityOffset,
  snapAngle,
} from "./gridSnap.js";
import {
  assignBalancedBags,
  buildBalancedEffectiveManifest,
  getDefaultBagForElement,
  getDefaultBoxCount,
  getOrigBagForElement,
  normalizeCustomBoxCount,
} from "./bagDistributor.js";
import { deserializeSavedHistory, executeUndoAction } from "./historyManager.js";
import {
  buildWallPocketCandidates,
  computeSupportedSurfaceAt,
  countStudSupports,
  findBestConnectionStud,
  findBestTargetReceptor,
  hasStudSupportOnPlane,
  isInPileZone,
  resolveCarryConnectionGeometry,
  restoreCarryValidState,
  saveCarryValidState,
  updateCarryTransform,
} from "./placementSolver.js";
import {
  buildGroupCompositeData,
  clearSelectionState,
  collectCarryLockIds,
  collectSelectedLockIds,
  selectGroupInScreenRect,
  selectPileEntry,
  selectPlacedGroup,
  selectPlacedPiece,
  toggleGroupPieceAtPoint,
} from "./selectionManager.js";
import {
  attachStickerToPiece,
  clearStickersFromMesh,
  detachStickerFromPiece,
  movePlacedPieceToPile,
  refreshPlacedWorldBox,
  restoreRemovedPieceEntry,
} from "./worldTransitions.js";
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
    this.effectiveManifest = null;
    this.customBoxCount = null;
    this._partOrderMap = new Map();
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
    return collectSelectedLockIds(sel);
  }

  _collectCarryLockIds(c = this.carry) {
    return collectCarryLockIds(c);
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
    refreshPlacedWorldBox(this, piece);
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
    this.customBoxCount = this.normalizeCustomBoxCount(savedState?.custom_box_count);
    const resolvedParts = (manifest.parts || []).filter(
      (p) => p.status !== "unresolved" && p.ldraw_part_id
    );
    const totalCount = resolvedParts.reduce((acc, p) => acc + p.quantity, 0);
    if (totalCount > MAX_SUPPORTED_PIECES) {
      throw new Error(
        `No se pudo abrir el set (${totalCount} piezas): supera el límite seguro de ${MAX_SUPPORTED_PIECES} piezas simultáneas para evitar que se tilde el navegador.`
      );
    }

    this.partsByElementId.clear();
    this._partOrderMap.clear();
    this.failedElementIds.clear();
    this.pendingPool = [];
    this.isLightweightSet = totalCount >= LIGHTWEIGHT_RENDER_THRESHOLD;

    resolvedParts.forEach((part, idx) => {
      this.partsByElementId.set(part.element_id, part);
      this._partOrderMap.set(part.element_id, idx);
    });

    // 1. Restauramos piezas ya colocadas si existía progreso guardado
    let skippedRestored = 0;
    const restoredCounts = new Map();
    if (savedState?.pieces?.length) {
      let maxSeq = this.nextInstanceSeq;
      for (const item of savedState.pieces) {
        if (!item || typeof item !== "object") continue;
        const posX = Number(item.position?.x);
        const posY = Number(item.position?.y);
        const posZ = Number(item.position?.z);
        const rotX = Number(item.rotation?.x ?? item.rotation?._x ?? 0);
        const rotY = Number(item.rotation?.y ?? item.rotation?._y ?? 0);
        const rotZ = Number(item.rotation?.z ?? item.rotation?._z ?? 0);
        if (
          !Number.isFinite(posX) ||
          !Number.isFinite(posY) ||
          !Number.isFinite(posZ) ||
          !Number.isFinite(rotX) ||
          !Number.isFinite(rotY) ||
          !Number.isFinite(rotZ)
        ) {
          continue;
        }
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
        group.position.set(posX, posY, posZ);
        group.rotation.set(rotX, rotY, rotZ);
        group.userData.instanceId = instanceId;
        group.userData.elementId = item.element_id;
        const origBag = this._getOrigBagForElement(item.element_id);
        group.userData.origBagNumber = origBag;
        group.userData.bagNumber = origBag;

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
      this.history = deserializeSavedHistory(savedHistory);
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
          this.pendingPool.push({ elementId: part.element_id, bagNumber: 1, origBagNumber: 1 });
        }
      } else {
        for (const [bagNum, qty] of bagEntries) {
          const skipHere = Math.min(toSkip, qty);
          toSkip -= skipHere;
          const remHere = qty - skipHere;
          for (let i = 0; i < remHere; i += 1) {
            this.pendingPool.push({
              elementId: part.element_id,
              bagNumber: bagNum,
              origBagNumber: bagNum,
            });
          }
        }
      }
    }
    this.pendingPool.sort((a, b) => a.origBagNumber - b.origBagNumber);

    if (this.customBoxCount != null) {
      this._assignBalancedBags(this.pendingPool, this.customBoxCount);
      this.effectiveManifest = this._buildBalancedEffectiveManifest(
        this.manifest,
        this.customBoxCount,
        this.pendingPool
      );
      for (const p of this.placedPieces) {
        p.mesh.userData.bagNumber = this._getDefaultBagForElement(p.elementId);
      }
    } else {
      this.effectiveManifest = this.manifest;
    }

    this.tableLayout = computeTableLayout(this.effectiveManifest);
    this.sceneManager.applyTableLayout(this.tableLayout);
    this.pilePhysics.passiveMode = false;
    this.pilePhysics.setBagZones(this.tableLayout.bagZones);

    // 3. Soltamos todas las bolsas en sus respectivos cuadros de la mesa
    await this.dropNextBatch(this.pendingPool.length, skippedRestored);
    this._emitChange();
  }

  normalizeCustomBoxCount(value) {
    return normalizeCustomBoxCount(value);
  }

  getDefaultBoxCount() {
    return getDefaultBoxCount(this.manifest);
  }

  getEffectiveBoxCount() {
    return this.customBoxCount ?? this.getDefaultBoxCount();
  }

  getLoosePieceCount() {
    return this.pilePhysics.items.length + this.pendingPool.length;
  }

  getEffectiveManifest() {
    return this.effectiveManifest || this.manifest;
  }

  _getOrigBagForElement(elementId) {
    return getOrigBagForElement(this.partsByElementId, this.manifest, elementId);
  }

  _getDefaultBagForElement(elementId) {
    return getDefaultBagForElement(
      this.partsByElementId,
      this.manifest,
      this.customBoxCount,
      this.effectiveManifest,
      elementId
    );
  }

  _assignBalancedBags(entries, boxCount) {
    assignBalancedBags(entries, boxCount, this._partOrderMap);
  }

  _buildBalancedEffectiveManifest(baseManifest, boxCount, assignedItems) {
    return buildBalancedEffectiveManifest(baseManifest, boxCount, assignedItems);
  }

  setCustomBoxCount(nextCount) {
    if (!this.manifest) return false;
    if (this._isGuestRoom()) {
      this.callbacks.onToast?.("Solo el administrador de la sala puede cambiar las cajas.");
      return false;
    }
    const normalized = this.normalizeCustomBoxCount(nextCount);
    this.cancelCarry();
    this.clearSelection();
    this.customBoxCount = normalized;

    const allLoose = [...this.pilePhysics.items, ...this.pendingPool];
    for (const item of allLoose) {
      if (item.origBagNumber == null) {
        item.origBagNumber =
          item.mesh?.userData?.origBagNumber ??
          this._getOrigBagForElement(item.elementId);
      }
    }

    if (normalized == null) {
      for (const item of allLoose) {
        const orig = item.origBagNumber || 1;
        item.bagNumber = orig;
        if (item.mesh?.userData) item.mesh.userData.bagNumber = orig;
      }
      this.effectiveManifest = this.manifest;
    } else {
      this._assignBalancedBags(allLoose, normalized);
      for (const item of allLoose) {
        if (item.mesh?.userData) item.mesh.userData.bagNumber = item.bagNumber;
      }
      this.effectiveManifest = this._buildBalancedEffectiveManifest(
        this.manifest,
        normalized,
        allLoose
      );
    }

    for (const p of this.placedPieces) {
      p.mesh.userData.bagNumber = this._getDefaultBagForElement(p.elementId);
    }

    this.tableLayout = computeTableLayout(this.effectiveManifest);
    this.sceneManager.applyTableLayout(this.tableLayout);
    this.pilePhysics.setBagZones(this.tableLayout.bagZones);
    this.pilePhysics.shakeAll();
    for (const item of this.pilePhysics.items) {
      this.sceneManager.syncPileTransform(item.mesh);
    }

    if (this._isHostRoom()) {
      this.roomManager.broadcastWorldEvent({
        type: "world:snapshot",
        snapshot: this.exportWorldSnapshot(),
      });
    }
    this._emitChange();
    return true;
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
      const tasks = slice.map(async ({ elementId, bagNumber, origBagNumber }) => {
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
        group.userData.origBagNumber = origBagNumber ?? bagNumber;

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
          bagNumber,
          origBagNumber ?? bagNumber
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
    clearStickersFromMesh(mesh);
  }

  _attachStickerToPiece(piece, stickerData) {
    attachStickerToPiece(this, piece, stickerData);
  }

  _detachStickerFromPiece(piece, faceKey) {
    return detachStickerFromPiece(this, piece, faceKey);
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
    clearSelectionState(this);
  }

  _selectPlaced(piece) {
    selectPlacedPiece(this, piece);
  }

  _selectGroup(items) {
    selectPlacedGroup(this, items);
  }

  _selectPile(entry) {
    selectPileEntry(this, entry);
  }

  selectGroupInScreenRect(rect, additive = false) {
    selectGroupInScreenRect(this, rect, additive);
  }

  toggleGroupPieceAtPoint(clientX, clientY) {
    toggleGroupPieceAtPoint(this, clientX, clientY);
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

  _buildGroupCompositeData(items) {
    return buildGroupCompositeData(items);
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
    groupRoot.userData.antiStuds = meta.compositeAntiStuds;
    groupRoot.userData.connectors = meta.compositeConnectors;
    groupRoot.userData.collisionMeshData = meta.compositeMeshData;
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
    if (this.carry._boundsQuat && this.carry.ghostBox && this.carry._boundsQuat.angleTo(quaternion) < 1e-4) {
      return;
    }

    let box;
    const groupMembers =
      this.carry.source === "group" && Array.isArray(mesh.userData.collisionMeshData)
        ? mesh.userData.collisionMeshData
        : null;
    if (groupMembers?.length) {
      const boxes = groupMembers.map((m) => ({
        box: m.boundsBox || m.collisionBoxes?.[0] || this.carry.localBox,
        localPos: m.localPos,
        localQuat: m.localQuat,
      }));
      box = computeTransformedWorldBox(boxes, new THREE.Vector3(), quaternion);
    } else {
      const prevPos = ghost.position.clone();
      ghost.position.set(0, 0, 0);
      ghost.quaternion.copy(quaternion);
      ghost.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(ghost);
      ghost.position.copy(prevPos);
    }
    this.carry._boundsQuat = quaternion.clone();
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
      tmpUp.copy(s.up).applyQuaternion(quaternion);
      if (tmpUp.y > 0.85) {
        refStudPos = tmpPos.copy(s.pos).applyQuaternion(quaternion);
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
  }

  _findBestConnectionStud(hit, cardN, ignoreMesh = null) {
    return findBestConnectionStud(this, hit, cardN, ignoreMesh);
  }

  _resolveCarryConnectionGeometry(dirNormal) {
    return resolveCarryConnectionGeometry(this, dirNormal);
  }

  _buildWallPocketCandidates(hit, cardN) {
    return buildWallPocketCandidates(this, hit, cardN);
  }

  _findBestTargetReceptor(hit, cardN, ignoreMesh) {
    return findBestTargetReceptor(this, hit, cardN, ignoreMesh);
  }

  _countStudSupports(candidatePos, receptors, normalAxis, studUp, ignoreMesh) {
    return countStudSupports(this, candidatePos, receptors, normalAxis, studUp, ignoreMesh);
  }

  _hasStudSupportOnPlane(candidatePos, worldReceptors, normalAxis, studPlaneCoord, studUp, ignoreMesh) {
    return hasStudSupportOnPlane(this, candidatePos, worldReceptors, normalAxis, studPlaneCoord, studUp, ignoreMesh);
  }

  _computeSupportedSurfaceAt(candidateBoxes, x, z, maxSearchY, ignoreMesh, minOverlap = 4) {
    return computeSupportedSurfaceAt(this, candidateBoxes, x, z, maxSearchY, ignoreMesh, minOverlap);
  }

  _isInPileZone(x, z) {
    return isInPileZone(this, x, z);
  }

  _saveCarryValidState(pos) {
    saveCarryValidState(this, pos);
  }

  _restoreCarryValidState() {
    return restoreCarryValidState(this);
  }

  _updateCarryTransform() {
    updateCarryTransform(this);
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

  handlePointerMove(clientX, clientY, buttons = 0) {
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
      // Mientras el usuario mantiene presionado para orbitar/panear la cámara, congelamos el fantasma
      const isCameraDrag =
        Boolean(this.sceneManager.isCameraInteracting) ||
        ((buttons & 1) !== 0 && !this._draggedCarryFromPress) ||
        (buttons & 4) !== 0;
      if (isCameraDrag) return;
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
        const dropPos = { x: pos.x, y: Math.max(30, pos.y), z: pos.z };
        const undoItems = [];
        const netPileItems = [];
        for (const entry of c.origGroup) {
          const { undoEntry, netPileItem } = movePlacedPieceToPile(this, entry.piece, {
            dropPos,
            filterPlaced: false,
            origPos: entry.origPos,
            origRot: entry.origRot,
          });
          undoItems.push(undoEntry);
          netPileItems.push(netPileItem);
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
        const dropPos = { x: pos.x, y: Math.max(30, pos.y), z: pos.z };
        const { undoEntry, netPileItem } = movePlacedPieceToPile(this, orig, { dropPos });
        this.history.push({ type: "remove", ...undoEntry });
        if (this._isHostRoom()) {
          this.roomManager.broadcastWorldEvent({
            type: "world:op",
            op: "placed-to-pile",
            nextInstanceSeq: this.nextInstanceSeq,
            removedInstanceId: orig.instanceId,
            pileItem: netPileItem,
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

  _getCameraAxes() {
    if (typeof this.sceneManager?.getHorizontalCameraAxes === "function") {
      return this.sceneManager.getHorizontalCameraAxes();
    }
    return {
      right: WORLD_X.clone(),
      forward: new THREE.Vector3(0, 0, -1),
    };
  }

  _handleRightDragMove(clientX, clientY) {
    if (!this._rightDrag) return;
    this._rightDrag.accumX += clientX - this._rightDrag.lastX;
    this._rightDrag.accumY += clientY - this._rightDrag.lastY;
    this._rightDrag.lastX = clientX;
    this._rightDrag.lastY = clientY;

    if (Math.abs(this._rightDrag.accumX) >= ROTATE_DRAG_THRESHOLD_PX) {
      // Derecha -> como T (+1 en Y); Izquierda -> como R (-1 en Y)
      const dir = this._rightDrag.accumX > 0 ? 1 : -1;
      this.rotateActive("y", dir);
      // Limita a un paso por gesto brusco y evita mezcla accidental con el eje perpendicular
      this._rightDrag.accumX = 0;
      this._rightDrag.accumY = 0;
    } else if (Math.abs(this._rightDrag.accumY) >= ROTATE_DRAG_THRESHOLD_PX) {
      // Arriba -> como G (-1 sobre eje derecho de cámara); Abajo -> como F (+1)
      const dir = this._rightDrag.accumY > 0 ? 1 : -1;
      const { right } = this._getCameraAxes();
      this.rotateActive(right, dir);
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

  rotateActive(axisOrVec, direction = 1) {
    const step = this.fineRotation ? ROTATION_STEP_15 : ROTATION_STEP_90;
    const delta = step * direction;
    const worldAxis = axisOrVec?.isVector3
      ? axisOrVec.clone().normalize()
      : axisOrVec === "x"
        ? WORLD_X
        : axisOrVec === "y"
          ? WORLD_Y
          : WORLD_Z;
    const isVerticalY = Math.abs(worldAxis.y) > 0.9;

    if (this.carry) {
      if (this.autoOrient && !this.carry.manualTiltApplied && isVerticalY) {
        this.carry.spinAngle = snapAngle(this.carry.spinAngle + delta, step);
        if (!this.carry.activeMechKind) {
          this._applyAutoOrientation(this.carry.surfaceNormal);
        }
      } else {
        if (!isVerticalY || !this.autoOrient) {
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
      const gCenter = meta.groupWorldBox.getCenter(new THREE.Vector3());
      const useCenterPivot = !isVerticalY;
      const nextOrigin = useCenterPivot
        ? meta.pivotPos.clone().sub(gCenter).applyQuaternion(qDelta).add(gCenter)
        : meta.pivotPos.clone();

      const rotatedBox = computeTransformedWorldBox(meta.compositeBoxes, nextOrigin, qDelta);
      if (useCenterPivot) {
        // Mantiene la base del grupo a la misma altura (piso >= 0) al voltear para evitar deriva al repetir arriba/abajo
        const targetMinY = Math.max(0, meta.groupWorldBox.min.y);
        nextOrigin.y += targetMinY - rotatedBox.min.y;
      } else if (rotatedBox.min.y < -0.01) {
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
      const prevPos = piece.mesh.position.clone();
      const prevRot = piece.mesh.rotation.clone();
      const prevQuat = piece.mesh.quaternion.clone();
      const boxes = piece.mesh.userData.collisionBoxes || [piece.localBox];
      const prevBox =
        piece.worldBox?.clone() || computeTransformedWorldBox(boxes, prevPos, prevQuat);
      const qDelta = new THREE.Quaternion().setFromAxisAngle(worldAxis, delta);
      const nextQuat = prevQuat.clone().premultiply(qDelta).normalize();
      const nextPos = prevPos.clone();

      if (!isVerticalY) {
        const wCenter = prevBox.getCenter(new THREE.Vector3());
        nextPos.sub(wCenter).applyQuaternion(qDelta).add(wCenter);
        const rotBox = computeTransformedWorldBox(boxes, nextPos, nextQuat);
        const targetMinY = Math.max(0, prevBox.min.y);
        nextPos.y += targetMinY - rotBox.min.y;
      }

      piece.mesh.position.copy(nextPos);
      piece.mesh.quaternion.copy(nextQuat);

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
        piece.mesh.position.copy(prevPos);
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
          prevState: { position: prevPos, rotation: prevRot },
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
        const { undoEntry, netPileItem } = movePlacedPieceToPile(this, target, { filterPlaced: false });
        undoItems.push(undoEntry);
        netPileItems.push(netPileItem);
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
    this.clearSelection();
    if (this._isGuestRoom()) {
      this.roomManager.sendGuestAction({
        type: "guest:op",
        op: "to-pile",
        instanceId: target.instanceId,
      });
      return;
    }
    const { undoEntry, netPileItem } = movePlacedPieceToPile(this, target);

    this.history.push({ type: "remove", ...undoEntry });
    if (this._isHostRoom()) {
      this.roomManager.broadcastWorldEvent({
        type: "world:op",
        op: "placed-to-pile",
        nextInstanceSeq: this.nextInstanceSeq,
        removedInstanceId: target.instanceId,
        pileItem: netPileItem,
      });
    }
    this._emitChange();
  }

  async _restoreRemovedEntry(entry) {
    return restoreRemovedPieceEntry(this, entry);
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

    await executeUndoAction(this, action);
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
