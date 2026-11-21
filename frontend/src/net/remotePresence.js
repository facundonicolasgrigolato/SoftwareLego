import * as THREE from "three";
import { LDrawService } from "../core/ldrawService.js";

/**
 * Renderiza en el espacio 3D los punteros de cada jugador conectado,
 * sus etiquetas flotantes con nombre/color y la vista previa de la pieza que llevan.
 */
export class RemotePresenceRenderer {
  constructor(sceneManager, ldrawService, labelsOverlayEl) {
    this.sceneManager = sceneManager;
    this.ldrawService = ldrawService;
    this.labelsOverlayEl = labelsOverlayEl;

    this.group = new THREE.Group();
    this.group.name = "RemotePresenceGroup";
    this.sceneManager.scene.add(this.group);

    this.lockBoxesGroup = new THREE.Group();
    this.lockBoxesGroup.name = "RemoteLocksGroup";
    this.sceneManager.scene.add(this.lockBoxesGroup);

    this._peers = new Map(); // peerId -> entry
    this._ghostSeq = 0;
  }

  _ensurePeer(peerId, name, colorHex) {
    let entry = this._peers.get(peerId);
    if (entry) {
      if (name && entry.name !== name) {
        entry.name = name;
        if (entry.labelNameEl) entry.labelNameEl.textContent = name;
      }
      if (colorHex && entry.colorHex !== colorHex) {
        entry.colorHex = colorHex;
        entry.coneMat.color.set(colorHex);
        entry.ringMat.color.set(colorHex);
        if (entry.labelEl) entry.labelEl.style.setProperty("--peer-color", colorHex);
        if (entry.ghostMatInfos) {
          for (const info of entry.ghostMatInfos) {
            info.mat.emissive?.set(colorHex);
          }
        }
      }
      return entry;
    }

    const color = new THREE.Color(colorHex || "#22c55e");
    const root = new THREE.Group();
    root.visible = false;

    const coneGeo = new THREE.ConeGeometry(7, 22, 16);
    coneGeo.rotateX(Math.PI);
    coneGeo.translate(0, 14, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
      depthTest: true,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.renderOrder = 15;

    const ringGeo = new THREE.RingGeometry(8, 12, 24);
    ringGeo.rotateX(-Math.PI / 2);
    ringGeo.translate(0, 0.8, 0);
    const ringMat = new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.renderOrder = 14;

    root.add(cone, ring);
    this.group.add(root);

    let labelEl = null;
    let labelNameEl = null;
    if (this.labelsOverlayEl && typeof document !== "undefined") {
      labelEl = document.createElement("div");
      labelEl.className = "remote-cursor-tag hidden";
      labelEl.style.setProperty("--peer-color", colorHex || "#22c55e");

      const dot = document.createElement("span");
      dot.className = "remote-cursor-dot";
      labelNameEl = document.createElement("span");
      labelNameEl.textContent = name || "Amigo";

      labelEl.append(dot, labelNameEl);
      this.labelsOverlayEl.appendChild(labelEl);
    }

    entry = {
      peerId,
      name: name || "Amigo",
      colorHex: colorHex || "#22c55e",
      root,
      coneGeo,
      coneMat,
      ringGeo,
      ringMat,
      labelEl,
      labelNameEl,
      targetPos: new THREE.Vector3(),
      currentPos: new THREE.Vector3(),
      hasCursor: false,
      lastSeenAt: performance.now(),
      ghost: null,
      ghostElementId: null,
      ghostTargetPos: new THREE.Vector3(),
      ghostTargetQuat: new THREE.Quaternion(),
      ghostActive: false,
      ghostMatInfos: [],
      ghostLoadToken: 0,
    };
    this._peers.set(peerId, entry);
    return entry;
  }

  syncPlayersRoster(players, localPeerId) {
    const validIds = new Set();
    for (const p of players || []) {
      if (!p?.peerId || p.peerId === localPeerId) continue;
      validIds.add(p.peerId);
      this._ensurePeer(p.peerId, p.name, p.color);
    }
    for (const existingId of [...this._peers.keys()]) {
      if (!validIds.has(existingId)) {
        this.removePeer(existingId);
      }
    }
  }

  handleMessage(msg) {
    if (!msg?.peerId) return;
    const entry = this._ensurePeer(msg.peerId, msg.name, msg.color);
    entry.lastSeenAt = performance.now();

    if (msg.type === "cursor:update") {
      if (!msg.visible || !msg.position) {
        entry.hasCursor = false;
        entry.root.visible = false;
        entry.labelEl?.classList.add("hidden");
        return;
      }
      entry.targetPos.set(msg.position.x || 0, msg.position.y || 0, msg.position.z || 0);
      if (!entry.hasCursor) {
        entry.currentPos.copy(entry.targetPos);
      }
      entry.hasCursor = true;
      entry.root.visible = true;
      return;
    }

    if (msg.type === "carry:preview") {
      if (!msg.active || !msg.elementId || !msg.position) {
        entry.ghostActive = false;
        if (entry.ghost) entry.ghost.visible = false;
        return;
      }
      entry.ghostTargetPos.set(msg.position.x || 0, msg.position.y || 0, msg.position.z || 0);
      if (msg.rotation) {
        const euler = new THREE.Euler(msg.rotation.x || 0, msg.rotation.y || 0, msg.rotation.z || 0, "XYZ");
        entry.ghostTargetQuat.setFromEuler(euler);
      }
      const wasActive = entry.ghostActive;
      entry.ghostActive = true;

      if (entry.ghost && entry.ghostElementId === msg.elementId) {
        if (!wasActive) {
          entry.ghost.position.copy(entry.ghostTargetPos);
          entry.ghost.quaternion.copy(entry.ghostTargetQuat);
        }
        entry.ghost.visible = true;
        this._tintGhost(entry, Boolean(msg.isColliding));
        return;
      }

      this._loadRemoteGhost(entry, msg.elementId, Boolean(msg.isColliding));
    }
  }

  _tintGhost(entry, isColliding) {
    const hex = isColliding ? "#ef4444" : entry.colorHex;
    for (const info of entry.ghostMatInfos || []) {
      if (isColliding) {
        info.mat.color?.setHex(0xef4444);
        info.mat.emissive?.setHex(0x7f1d1d);
      } else {
        info.mat.color?.copy(info.origColor);
        info.mat.emissive?.set(hex);
        if (info.mat.emissiveIntensity !== undefined) {
          info.mat.emissiveIntensity = 0.28;
        }
      }
      info.mat.opacity = 0.62;
    }
  }

  async _loadRemoteGhost(entry, elementId, isColliding) {
    const part = this.sceneManager.getManifestPartByElementId?.(elementId);
    if (!part) return;
    const token = ++this._ghostSeq;
    entry.ghostLoadToken = token;
    entry.ghostElementId = elementId;

    try {
      const { group } = await this.ldrawService.createPartInstance(part);
      if (entry.ghostLoadToken !== token || !this._peers.has(entry.peerId)) return;

      if (entry.ghost) {
        this.group.remove(entry.ghost);
      }
      const ghost = LDrawService.makeGhostClone(group);
      ghost.position.copy(entry.ghostTargetPos);
      ghost.quaternion.copy(entry.ghostTargetQuat);
      ghost.visible = entry.ghostActive;
      entry.ghost = ghost;
      entry.ghostMatInfos = ghost.userData.ghostMatInfos || [];
      this.group.add(ghost);
      this._tintGhost(entry, isColliding);
    } catch {
      // ignorar si no cargó aún
    }
  }

  /**
   * Actualiza cajas de contorno sobre piezas reservadas por otros jugadores.
   */
  updateLockBoxes(locksMap, placedPieces, pileItems, localPeerId) {
    this.lockBoxesGroup.clear();
    if (!locksMap || !locksMap.size) return;

    const byId = new Map();
    for (const p of placedPieces || []) byId.set(p.instanceId, p);
    for (const p of pileItems || []) byId.set(p.instanceId, p);

    for (const [instanceId, owner] of locksMap.entries()) {
      if (!owner || owner.peerId === localPeerId) continue;
      const piece = byId.get(instanceId);
      if (!piece) continue;
      const box = piece.worldBox || new THREE.Box3().setFromObject(piece.mesh);
      if (box.isEmpty()) continue;
      const helper = new THREE.Box3Helper(box, new THREE.Color(owner.color || "#f59e0b"));
      this.lockBoxesGroup.add(helper);
    }
  }

  updateFrame(dt) {
    const camera = this.sceneManager.camera;
    const renderer = this.sceneManager.renderer;
    if (!camera || !renderer) return;
    const width = renderer.domElement.clientWidth || 1;
    const height = renderer.domElement.clientHeight || 1;
    const alpha = Math.min(1, Math.max(0.18, dt * 16));
    const proj = new THREE.Vector3();

    for (const entry of this._peers.values()) {
      if (entry.hasCursor && entry.root.visible) {
        entry.currentPos.lerp(entry.targetPos, alpha);
        entry.root.position.copy(entry.currentPos);

        if (entry.labelEl) {
          proj.copy(entry.currentPos).add(new THREE.Vector3(0, 28, 0)).project(camera);
          const visibleOnScreen = proj.z >= -1 && proj.z <= 1;
          entry.labelEl.classList.toggle("hidden", !visibleOnScreen);
          if (visibleOnScreen) {
            const x = (proj.x * 0.5 + 0.5) * width;
            const y = (-proj.y * 0.5 + 0.5) * height;
            entry.labelEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
          }
        }
      } else {
        entry.labelEl?.classList.add("hidden");
      }

      if (entry.ghost && entry.ghostActive && entry.ghost.visible) {
        entry.ghost.position.lerp(entry.ghostTargetPos, alpha);
        entry.ghost.quaternion.slerp(entry.ghostTargetQuat, alpha);
      }
    }
  }

  removePeer(peerId) {
    const entry = this._peers.get(peerId);
    if (!entry) return;
    this.group.remove(entry.root);
    entry.coneGeo.dispose();
    entry.coneMat.dispose();
    entry.ringGeo.dispose();
    entry.ringMat.dispose();
    if (entry.ghost) this.group.remove(entry.ghost);
    entry.labelEl?.remove();
    this._peers.delete(peerId);
  }

  clearAll() {
    for (const id of [...this._peers.keys()]) {
      this.removePeer(id);
    }
    this.lockBoxesGroup.clear();
  }
}
