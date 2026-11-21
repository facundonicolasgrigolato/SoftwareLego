import { BuildController } from "./builder/buildController.js";
import { computeFaceStickerPlacement, fileToStickerDataUrl } from "./builder/stickerDecal.js";
import { saveSlotToDisk, serializeBuildState } from "./builder/storage.js";
import { LDrawService } from "./core/ldrawService.js";
import { PartThumbnailRenderer } from "./core/partThumbnailRenderer.js";
import { SceneManager } from "./core/sceneManager.js";
import { RemotePresenceRenderer } from "./net/remotePresence.js";
import { RoomManager } from "./net/roomManager.js";
import { HelpGuide } from "./ui/helpGuide.js";
import { LobbyView } from "./ui/lobbyView.js";
import { ManualDrawer } from "./ui/manualDrawer.js";
import { RoomModal } from "./ui/roomModal.js";
import { TrayPanel } from "./ui/trayPanel.js";

const editorAppEl = document.getElementById("editor-app");
const topbarEl = document.getElementById("topbar");
const workspaceEl = document.getElementById("workspace");
const bottomDockEl = document.getElementById("bottom-dock");
const trayPanelEl = document.getElementById("tray-panel");
const viewportEl = document.getElementById("viewport");
const selectionMarqueeEl = document.getElementById("selection-marquee");
const statusPillEl = document.getElementById("status-pill");
const progressPillEl = document.getElementById("progress-pill");
const progressTextEl = document.getElementById("progress-text");
const progressBarEl = document.getElementById("progress-bar");
const minimalControlsEl = document.getElementById("minimal-controls");
const toastEl = document.getElementById("toast");

const btnBackLobbyEl = document.getElementById("btn-back-lobby");
const btnSaveSlotEl = document.getElementById("btn-save-slot");
const btnDropBatchEl = document.getElementById("btn-drop-batch");
const btnShakeEl = document.getElementById("btn-shake");
const btnGridEl = document.getElementById("btn-fine-grid");
const btnRotEl = document.getElementById("btn-fine-rot");
const btnAutoOrientEl = document.getElementById("btn-auto-orient");
const btnCollisionEl = document.getElementById("btn-collision");
const btnUndoEl = document.getElementById("btn-undo");
const btnToggleTrayEl = document.getElementById("btn-toggle-tray");
const btnToggleManualEl = document.getElementById("btn-toggle-manual");
const btnExportEl = document.getElementById("btn-export-build");
const inputImportEl = document.getElementById("input-import-build");
const btnClearEl = document.getElementById("btn-clear-build");
const btnHelpEl = document.getElementById("btn-help");
const btnHideHudEl = document.getElementById("btn-hide-hud");
const btnShowHudEl = document.getElementById("btn-show-hud");
const btnFocusMesaEl = document.getElementById("btn-focus-mesa");
const btnStickerModeEl = document.getElementById("btn-sticker-mode");
const btnMultiplayerEl = document.getElementById("btn-multiplayer");
const lblImportBuildEl = document.getElementById("lbl-import-build");
const roomStatusChipEl = document.getElementById("room-status-chip");
const remoteCursorsLayerEl = document.getElementById("remote-cursors-layer");
const stickerPopoverEl = document.getElementById("sticker-popover");
const btnCloseStickerEl = document.getElementById("btn-close-sticker");
const btnStickerPasteEl = document.getElementById("btn-sticker-paste");
const inputStickerFileEl = document.getElementById("input-sticker-file");

const manualDrawer = new ManualDrawer(
  {
    drawerEl: document.getElementById("manual-drawer"),
    tabEl: document.getElementById("manual-tab"),
    pageIndicatorEl: document.getElementById("manual-page-indicator"),
    openPdfBtnEl: document.getElementById("btn-manual-open-pdf"),
    zoomBadgeEl: document.getElementById("manual-zoom-badge"),
    viewportEl: document.getElementById("manual-viewport"),
    pagesContainerEl: document.getElementById("manual-pages"),
    statusEl: document.getElementById("manual-status"),
  },
  {
    onOpenChanged: (isOpen) => {
      btnToggleManualEl?.classList.toggle("is-on", isOpen);
    },
  }
);
btnToggleManualEl?.classList.toggle("is-on", manualDrawer.isOpen);

const helpGuide = new HelpGuide(document.getElementById("help-guide-backdrop"), {
  onOpenChanged: (isOpen) => {
    btnHelpEl?.classList.toggle("is-on", isOpen);
    if (isOpen) sceneManager.clearMoveKeys();
  },
});

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 2600);
}

const sceneManager = new SceneManager(viewportEl);
const ldrawService = new LDrawService();

let trayPanel = null;
let lobbyView = null;
let currentSetInfo = null;
let currentSetNumber = null;
let currentSlotNumber = null;
let currentSlotName = null;
let isLoadingSlot = false;
let autoSaveTimer = null;
let autoSaveInFlight = false;
let autoSaveQueued = false;
let hudVisible = true;
let trayVisible = true;
let stickerMode = false;
let pendingStickerTarget = null; // { piece, placement }

function refreshStickerStatusPill() {
  if (!stickerMode) return false;
  statusPillEl.textContent = pendingStickerTarget
    ? "Pegá una imagen (Ctrl+V), subila o cerrá con ✕ / Esc"
    : "Modo pegatina: clic en una cara para pegar · clic en una pegatina para quitarla · Esc/Ctrl+Z cancelar";
  statusPillEl.classList.remove("hidden");
  return true;
}

function closeStickerPopover() {
  pendingStickerTarget = null;
  stickerPopoverEl?.classList.add("hidden");
  if (inputStickerFileEl) inputStickerFileEl.value = "";
}

function setStickerMode(enabled) {
  stickerMode = Boolean(enabled);
  editorAppEl?.classList.toggle("is-sticker-mode", stickerMode);
  btnStickerModeEl?.classList.toggle("is-on", stickerMode);
  btnStickerModeEl?.setAttribute("aria-pressed", String(stickerMode));

  if (!stickerMode) {
    closeStickerPopover();
    buildController?._emitStatus?.();
    return;
  }

  if (buildController.carry) buildController.cancelCarry();
  if (marqueeState) {
    clearMarquee();
    sceneManager.controls.enabled = true;
  }
  buildController.clearSelection();
  refreshStickerStatusPill();
}

function openStickerPopover(piece, placement, clientX, clientY) {
  pendingStickerTarget = { piece, placement };
  if (!stickerPopoverEl) return;
  const wrapRect = viewportEl.getBoundingClientRect();
  const popW = 282;
  const popH = 158;
  const rawLeft = clientX - wrapRect.left + 14;
  const rawTop = clientY - wrapRect.top + 14;
  const clampedLeft = Math.max(12, Math.min(rawLeft, Math.max(12, wrapRect.width - popW - 12)));
  const clampedTop = Math.max(58, Math.min(rawTop, Math.max(58, wrapRect.height - popH - 12)));
  stickerPopoverEl.style.left = `${clampedLeft}px`;
  stickerPopoverEl.style.top = `${clampedTop}px`;
  stickerPopoverEl.classList.remove("hidden");
  refreshStickerStatusPill();
}

async function applyPendingStickerBlob(blobOrFile) {
  const target = pendingStickerTarget;
  if (!target || !blobOrFile) return;
  try {
    const dataUrl = await fileToStickerDataUrl(blobOrFile, 512);
    buildController.applyStickerToPlacedPiece(target.piece, target.placement, dataUrl);
    setStickerMode(false);
    showToast("Pegatina aplicada en esa cara (Ctrl+Z para deshacer).");
  } catch (err) {
    showToast(err?.message || "No se pudo aplicar la imagen.");
  }
}

async function persistCurrentSlot({ showToastOnSuccess = false } = {}) {
  if (!currentSetNumber || !currentSlotNumber || isLoadingSlot || roomManager?.isGuest()) return;
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (autoSaveInFlight) {
    autoSaveQueued = true;
    return;
  }

  autoSaveInFlight = true;
  try {
    const serialized = serializeBuildState(currentSetNumber, buildController.placedPieces);
    await saveSlotToDisk(currentSetNumber, currentSlotNumber, {
      name: currentSlotName || `Slot ${currentSlotNumber}`,
      pieces: serialized.pieces,
      history: buildController.history,
    });
    if (showToastOnSuccess) {
      showToast(`Guardado en Slot ${currentSlotNumber} (${serialized.pieces.length} piezas).`);
    }
  } catch (err) {
    showToast(`No se pudo guardar en Slot ${currentSlotNumber}: ${err.message}`);
  } finally {
    autoSaveInFlight = false;
    if (autoSaveQueued) {
      autoSaveQueued = false;
      persistCurrentSlot({ showToastOnSuccess: false });
    }
  }
}

function scheduleAutoSave() {
  if (!currentSetNumber || !currentSlotNumber || isLoadingSlot || roomManager?.isGuest()) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    persistCurrentSlot({ showToastOnSuccess: false });
  }, 650);
}

function updateLayoutVisibility() {
  topbarEl.classList.toggle("hidden", !hudVisible);
  bottomDockEl?.classList.toggle("hidden", !hudVisible);
  workspaceEl.classList.toggle("hud-hidden", !hudVisible);
  minimalControlsEl.classList.toggle("hidden", hudVisible);

  const showTray = hudVisible && trayVisible;
  trayPanelEl.classList.toggle("hidden", !showTray);
  workspaceEl.classList.toggle("no-tray", !showTray);
  btnToggleTrayEl?.classList.toggle("is-on", trayVisible);
  manualDrawer?.setHudVisible(hudVisible);

  // Dejamos un frame para que CSS recalcule dimensiones del canvas
  requestAnimationFrame(() => sceneManager.resize());
}

const buildController = new BuildController(sceneManager, ldrawService, {
  onToast: showToast,
  onProgress: (done, total, label) => {
    if (!total) {
      progressPillEl.classList.add("hidden");
      return;
    }
    progressPillEl.classList.remove("hidden");
    progressTextEl.textContent = label;
    progressBarEl.style.width = `${Math.round((done / total) * 100)}%`;
  },
  onBuildChanged: () => {
    trayPanel?.render();
    scheduleAutoSave();
  },
  onStatusChanged: (state) => {
    btnGridEl.textContent = state.fineGrid ? "Grilla ½ stud" : "Grilla 1 stud";
    btnGridEl.classList.toggle("is-on", state.fineGrid);

    btnRotEl.textContent = state.fineRotation ? "Giro 15°" : "Giro 90°";
    btnRotEl.classList.toggle("is-on", state.fineRotation);

    btnAutoOrientEl.textContent = state.autoOrient ? "Auto-orientar" : "Giro manual";
    btnAutoOrientEl.classList.toggle("is-on", state.autoOrient);

    btnCollisionEl.textContent = state.collisionEnabled ? "Colisiones" : "Libre (sin choque)";
    btnCollisionEl.classList.toggle("is-on", state.collisionEnabled);

    if (state.pendingTotal > 0) {
      btnDropBatchEl.classList.remove("hidden");
      btnDropBatchEl.textContent = `Soltar +${Math.min(150, state.pendingTotal)} (${state.pendingTotal})`;
    } else {
      btnDropBatchEl.classList.add("hidden");
    }

    if (refreshStickerStatusPill()) {
      // Mantiene el aviso de modo pegatina activo sobre el estado normal
    } else if (state.isCarrying && state.carryGroupCount > 1) {
      statusPillEl.textContent = `Grupo temporal (${state.carryGroupCount} piezas) · Click para soltar · Esc cancelar`;
      statusPillEl.classList.remove("hidden");
    } else if (state.isCarrying && state.carryPart) {
      const name = state.carryPart.part_name || state.carryPart.ldraw_part_id;
      statusPillEl.textContent = `En mano: ${name} (${state.carryPart.color_name || ""})`;
      statusPillEl.classList.remove("hidden");
    } else if (state.selectedKind === "group" && state.selectedGroupCount > 1) {
      statusPillEl.textContent = `Grupo temporal (${state.selectedGroupCount} piezas) · Click mover · R/T/F/G rotar · Supr devolver`;
      statusPillEl.classList.remove("hidden");
    } else if (state.selectedPart) {
      const hint = state.selectedKind === "pile" ? "Click de nuevo o arrastrá para tomar" : "Click de nuevo para mover · Click der. rotar";
      statusPillEl.textContent = `${state.selectedPart.part_name || state.selectedPart.ldraw_part_id} · ${hint}`;
      statusPillEl.classList.remove("hidden");
    } else {
      statusPillEl.classList.add("hidden");
    }

    trayPanel?.render();
    if (roomManager?.isOpen()) {
      const payload = buildController.getCarryPreviewPayload();
      roomManager.sendPresence({ type: "carry:preview", ...payload });
    }
  },
});

const remotePresence = new RemotePresenceRenderer(
  sceneManager,
  ldrawService,
  remoteCursorsLayerEl
);
sceneManager.getManifestPartByElementId = (elId) => buildController.partsByElementId.get(elId);

let roomModal = null;
const roomManager = new RoomManager({
  onStateChanged: (state) => {
    roomModal?.setState(state);
    btnMultiplayerEl?.classList.toggle("is-on", state.mode === "open");
    applyRolePermissions();
    remotePresence.syncPlayersRoster(state.players, state.localPeerId);
    renderRoomStatusChip(state);
  },
  onLocksChanged: (locks) => {
    remotePresence.updateLockBoxes(
      locks,
      buildController.placedPieces,
      buildController.pilePhysics.items,
      roomManager.localPeerId
    );
  },
  onRemotePresence: (msg) => remotePresence.handleMessage(msg),
  onRemotePresenceRemoved: (peerId) => remotePresence.removePeer(peerId),
  onClearRemotePresence: () => remotePresence.clearAll(),
  getWorldSnapshot: () => buildController.exportWorldSnapshot(),
  onHostActionFromGuest: (peerId, msg) => {
    if (msg?.type === "guest:op") {
      buildController.handleGuestNetworkOp(msg);
    }
  },
  onGuestWorldSnapshot: (snapshot) => {
    if (buildController.manifest) {
      buildController.loadFromNetworkSnapshot(buildController.manifest, snapshot, {
        passivePhysics: true,
      });
    }
  },
  onGuestWorldEvent: (msg) => {
    if (msg.type === "pile:poses") {
      buildController.pilePhysics.applyRemotePoses(msg.poses, (item) => {
        sceneManager.syncPileTransform(item.mesh);
      });
      if (buildController.selected?.kind === "pile") {
        sceneManager.refreshSelectionBox();
      }
    } else if (msg.type === "world:snapshot") {
      if (buildController.manifest) {
        buildController.loadFromNetworkSnapshot(buildController.manifest, msg.snapshot, {
          passivePhysics: true,
        });
      }
    } else if (msg.type === "world:op") {
      buildController.handleHostNetworkOp(msg);
    }
  },
  onPlayerJoined: (player) => showToast(`${player.name} se unió a la sala.`),
  onPlayerLeft: (player) => showToast(`${player.name} salió de la sala.`),
  onError: (msg) => showToast(msg),
  onKickedOrClosed: (reason) => {
    showToast(reason || "La sala se cerró.");
    returnToLobby({ skipFlush: true });
  },
});

buildController.setRoomManager(roomManager);

roomModal = new RoomModal(
  {
    backdropEl: document.getElementById("room-modal-backdrop"),
    closeBtnEl: document.getElementById("btn-close-room-modal"),
    statusBadgeEl: document.getElementById("room-status-badge"),
    toggleBtnEl: document.getElementById("btn-toggle-room"),
    codeSectionEl: document.getElementById("room-code-box"),
    codeTextEl: document.getElementById("room-code-text"),
    copyBtnEl: document.getElementById("btn-copy-room-code"),
    playersCountEl: document.getElementById("room-players-count"),
    playersListEl: document.getElementById("room-players-list"),
    hintEl: document.getElementById("room-modal-hint"),
  },
  {
    onOpenRoom: async () => {
      if (!currentSetNumber) return;
      try {
        const code = await roomManager.openRoom({
          setNumber: currentSetNumber,
          hostName: "Admin",
        });
        if (code) showToast(`Sala abierta. Código: ${code}`);
      } catch (err) {
        showToast(err?.message || "No se pudo abrir la sala.");
      }
    },
    onCloseRoom: () => {
      roomManager.closeRoom();
      showToast("Sala cerrada.");
    },
    onRenamePlayer: (peerId, name) => roomManager.renamePlayer(peerId, name),
    onKickPlayer: (peerId) => roomManager.kickPlayer(peerId),
    onToast: showToast,
  }
);

function applyRolePermissions() {
  const isGuest = roomManager.isGuest();
  btnStickerModeEl?.classList.toggle("hidden", isGuest);
  btnMultiplayerEl?.classList.toggle("hidden", isGuest);
  btnUndoEl?.classList.toggle("hidden", isGuest);
  btnClearEl?.classList.toggle("hidden", isGuest);
  btnExportEl?.classList.toggle("hidden", isGuest);
  lblImportBuildEl?.classList.toggle("hidden", isGuest);
  btnSaveSlotEl?.classList.toggle("hidden", isGuest);
  if (isGuest) {
    if (stickerMode) setStickerMode(false);
    roomModal.hide();
  }
}

function renderRoomStatusChip(state) {
  if (!roomStatusChipEl) return;
  const active = state.mode === "open" || state.mode === "joined";
  roomStatusChipEl.classList.toggle("hidden", !active);
  if (!active) {
    roomStatusChipEl.innerHTML = "";
    return;
  }
  const players = Array.isArray(state.players) ? state.players : [];
  const dots = players
    .map(
      (p) =>
        `<span class="room-chip-dot" style="background:${p.color}" title="${p.name}"></span>`
    )
    .join("");
  const label =
    state.role === "host" && state.roomCode
      ? `Sala ${state.roomCode} · ${players.length}/4`
      : `En sala · ${players.length}/4`;
  roomStatusChipEl.innerHTML = `${dots}<span>${label}</span>`;
  roomStatusChipEl.classList.toggle("is-clickable", state.role === "host");
  roomStatusChipEl.title =
    state.role === "host" ? "Administrar sala" : "Conectado como amigo";
}

let lastPilePoseBroadcast = 0;
let sentSettledPilePoses = true;
sceneManager.onFrame((dt) => {
  remotePresence.updateFrame(dt);

  if (roomManager.isHost()) {
    const now = performance.now();
    const awakePoses = buildController.pilePhysics.exportPoses(true);
    if (awakePoses.length > 0) {
      sentSettledPilePoses = false;
      if (now - lastPilePoseBroadcast >= 55) {
        lastPilePoseBroadcast = now;
        roomManager.broadcastWorldEvent({ type: "pile:poses", poses: awakePoses });
      }
    } else if (!sentSettledPilePoses) {
      sentSettledPilePoses = true;
      lastPilePoseBroadcast = now;
      roomManager.broadcastWorldEvent({
        type: "pile:poses",
        poses: buildController.pilePhysics.exportPoses(false),
      });
    }
  }
});

const thumbnailRenderer = new PartThumbnailRenderer(ldrawService);

trayPanel = new TrayPanel(
  {
    listEl: document.getElementById("tray-list"),
    searchEl: document.getElementById("tray-search"),
    onlyAvailableEl: document.getElementById("tray-only-available"),
    bagRowEl: document.getElementById("tray-bag-row"),
    bagFilterEl: document.getElementById("tray-bag-filter"),
    focusBagBtnEl: document.getElementById("btn-focus-bag"),
    summaryEl: document.getElementById("tray-summary"),
    topProgressFillEl: document.getElementById("top-progress-fill"),
    tabCountEl: document.getElementById("tray-tab-count"),
    favCountEl: document.getElementById("tray-fav-count"),
    tabButtons: document.querySelectorAll(".tray-tab"),
    prevBtnEl: document.getElementById("btn-tray-prev"),
    nextBtnEl: document.getElementById("btn-tray-next"),
    thumbnailRenderer,
    onFocusBag: (bagNumber) => {
      if (bagNumber) sceneManager.focusBagZone(bagNumber);
      else sceneManager.focusBuildZone();
    },
  },
  buildController,
  (elementId) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    buildController.startCarryFromTray(elementId);
  }
);

btnFocusMesaEl?.addEventListener("click", () => sceneManager.focusBuildZone());

// Gestión unificada de puntero sobre el canvas 3D
const canvas = sceneManager.renderer.domElement;
let leftDownPos = null;
let rightDownActive = false;
let marqueeState = null;

function updateMarqueeVisual() {
  if (!marqueeState || !selectionMarqueeEl) return;
  const wrapRect = viewportEl.getBoundingClientRect();
  const left = Math.max(0, Math.min(marqueeState.startX, marqueeState.curX) - wrapRect.left);
  const top = Math.max(0, Math.min(marqueeState.startY, marqueeState.curY) - wrapRect.top);
  const right = Math.min(wrapRect.width, Math.max(marqueeState.startX, marqueeState.curX) - wrapRect.left);
  const bottom = Math.min(wrapRect.height, Math.max(marqueeState.startY, marqueeState.curY) - wrapRect.top);
  selectionMarqueeEl.style.left = `${left}px`;
  selectionMarqueeEl.style.top = `${top}px`;
  selectionMarqueeEl.style.width = `${Math.max(1, right - left)}px`;
  selectionMarqueeEl.style.height = `${Math.max(1, bottom - top)}px`;
  selectionMarqueeEl.classList.remove("hidden");
}

function clearMarquee() {
  marqueeState = null;
  selectionMarqueeEl?.classList.add("hidden");
}

canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

canvas.addEventListener(
  "pointerdown",
  (ev) => {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== canvas) {
      document.activeElement.blur();
    }
    if (ev.button === 0) {
      if (stickerMode) {
        leftDownPos = { x: ev.clientX, y: ev.clientY };
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && !buildController.carry) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        marqueeState = {
          startX: ev.clientX,
          startY: ev.clientY,
          curX: ev.clientX,
          curY: ev.clientY,
          additive: ev.shiftKey,
        };
        sceneManager.controls.enabled = false;
        updateMarqueeVisual();
        return;
      }
      leftDownPos = { x: ev.clientX, y: ev.clientY };
      if (buildController.handleLeftPointerDown(ev.clientX, ev.clientY)) {
        ev.stopImmediatePropagation();
      }
    } else if (ev.button === 2) {
      rightDownActive = buildController.handleRightPointerDown(ev.clientX, ev.clientY);
      if (rightDownActive) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    }
  },
  { capture: true }
);

let lastPresenceSentAt = 0;
window.addEventListener("pointermove", (ev) => {
  if (marqueeState) {
    marqueeState.curX = ev.clientX;
    marqueeState.curY = ev.clientY;
    updateMarqueeVisual();
    return;
  }
  buildController.handlePointerMove(ev.clientX, ev.clientY);

  if (roomManager.isOpen() && !editorAppEl.classList.contains("hidden")) {
    const now = performance.now();
    if (now - lastPresenceSentAt >= 42) {
      lastPresenceSentAt = now;
      const targetEl = document.elementFromPoint(ev.clientX, ev.clientY);
      const overCanvas = targetEl === canvas;
      if (!overCanvas) {
        roomManager.sendPresence({ type: "cursor:update", visible: false });
      } else {
        const hit = sceneManager.raycastWorkspace(ev.clientX, ev.clientY, {
          ignoreObject: buildController.carry?.ghost || null,
        });
        roomManager.sendPresence({
          type: "cursor:update",
          visible: Boolean(hit),
          position: hit
            ? {
                x: Math.round(hit.point.x * 10) / 10,
                y: Math.round(hit.point.y * 10) / 10,
                z: Math.round(hit.point.z * 10) / 10,
              }
            : null,
        });
      }
      if (buildController.carry) {
        roomManager.sendPresence({
          type: "carry:preview",
          ...buildController.getCarryPreviewPayload(),
        });
      }
    }
  }
});

window.addEventListener("pointerup", (ev) => {
  if (ev.button === 0 && marqueeState) {
    const m = marqueeState;
    clearMarquee();
    sceneManager.controls.enabled = true;
    const dist = Math.hypot(ev.clientX - m.startX, ev.clientY - m.startY);
    if (dist < 5) {
      buildController.toggleGroupPieceAtPoint(ev.clientX, ev.clientY);
    } else {
      buildController.selectGroupInScreenRect(
        { left: m.startX, top: m.startY, right: ev.clientX, bottom: ev.clientY },
        m.additive
      );
    }
    return;
  }
  if (ev.button === 0 && leftDownPos) {
    const dist = Math.hypot(ev.clientX - leftDownPos.x, ev.clientY - leftDownPos.y);
    leftDownPos = null;
    if (stickerMode) {
      if (dist < 5) {
        const hit = sceneManager.raycastWorkspace(ev.clientX, ev.clientY, { includePile: false });
        if (!hit || hit.kind !== "placed") {
          showToast("Hacé clic sobre una pieza armada para poner o quitar una pegatina.");
          return;
        }
        const piece = buildController.getPlacedPieceByObject(hit.object);
        if (!piece) return;

        const placement = computeFaceStickerPlacement({
          pieceMesh: piece.mesh,
          localBox: piece.localBox,
          worldPoint: hit.point,
          worldNormal: hit.normal,
          cameraMatrixWorld: sceneManager.camera.matrixWorld,
        });
        const existingKey = hit.stickerFaceKey || (buildController.hasStickerOnFace(piece, placement.faceKey) ? placement.faceKey : null);
        if (existingKey && buildController.removeStickerFromPlacedPiece(piece, existingKey)) {
          setStickerMode(false);
          showToast("Pegatina quitada de esa cara (Ctrl+Z para deshacer).");
          return;
        }
        openStickerPopover(piece, placement, ev.clientX, ev.clientY);
      }
      return;
    }
    buildController.handleLeftPointerUp(ev.clientX, ev.clientY, dist < 5);
  } else if (ev.button === 2 && rightDownActive) {
    rightDownActive = false;
    buildController.handleRightPointerUp();
  }
});

// Botones de barra superior
btnDropBatchEl.addEventListener("click", () => buildController.dropNextBatch());
btnShakeEl.addEventListener("click", () => buildController.shakePile());
btnGridEl.addEventListener("click", () => buildController.toggleFineGrid());
btnRotEl.addEventListener("click", () => buildController.toggleFineRotation());
btnAutoOrientEl.addEventListener("click", () => buildController.toggleAutoOrient());
btnCollisionEl.addEventListener("click", () => buildController.toggleCollision());
btnUndoEl.addEventListener("click", () => buildController.undo());
btnStickerModeEl?.addEventListener("click", () => setStickerMode(!stickerMode));
btnMultiplayerEl?.addEventListener("click", () => {
  if (roomManager.isGuest()) return;
  if (roomModal.isOpen()) roomModal.hide();
  else roomModal.show();
});
roomStatusChipEl?.addEventListener("click", () => {
  if (roomManager.isHost()) roomModal.show();
});
btnCloseStickerEl?.addEventListener("click", () => setStickerMode(false));

btnStickerPasteEl?.addEventListener("click", async () => {
  if (!pendingStickerTarget) return;
  if (!navigator.clipboard?.read) {
    showToast("Presioná Ctrl + V para pegar tu captura desde el portapapeles.");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imgType = item.types.find((t) => t.startsWith("image/"));
      if (imgType) {
        const blob = await item.getType(imgType);
        await applyPendingStickerBlob(blob);
        return;
      }
    }
    showToast("No hay ninguna imagen copiada en el portapapeles.");
  } catch {
    showToast("Presioná Ctrl + V para pegar la imagen o subila desde tu dispositivo.");
  }
});

inputStickerFileEl?.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  await applyPendingStickerBlob(file);
  ev.target.value = "";
});

window.addEventListener("paste", async (ev) => {
  if (!pendingStickerTarget) return;
  const items = Array.from(ev.clipboardData?.items || []);
  const imageItem = items.find((it) => it.type.startsWith("image/"));
  if (!imageItem) return;
  ev.preventDefault();
  const file = imageItem.getAsFile();
  if (file) await applyPendingStickerBlob(file);
});

btnToggleTrayEl?.addEventListener("click", () => {
  trayVisible = !trayVisible;
  updateLayoutVisibility();
});

btnToggleManualEl?.addEventListener("click", () => {
  manualDrawer.setOpen(!manualDrawer.isOpen);
});

btnHideHudEl.addEventListener("click", () => {
  hudVisible = false;
  helpGuide.close();
  updateLayoutVisibility();
});

btnShowHudEl.addEventListener("click", () => {
  hudVisible = true;
  updateLayoutVisibility();
});

btnHelpEl.addEventListener("click", () => {
  helpGuide.toggle();
});

btnBackLobbyEl.addEventListener("click", () => returnToLobby());
btnSaveSlotEl.addEventListener("click", () => persistCurrentSlot({ showToastOnSuccess: true }));

btnClearEl.addEventListener("click", async () => {
  if (!currentSetInfo) return;
  if (!buildController.placedPieces.length) return;
  if (confirm("¿Devolver todas las piezas armadas a la pila en este slot?")) {
    await loadManifestIntoSlot(currentSetInfo, currentSlotNumber, currentSlotName, {
      pieces: [],
      history: [],
    });
    await persistCurrentSlot({ showToastOnSuccess: true });
    if (roomManager.isHost()) {
      roomManager.broadcastWorldEvent({
        type: "world:snapshot",
        snapshot: buildController.exportWorldSnapshot(),
      });
    }
  }
});

btnExportEl.addEventListener("click", () => {
  if (!currentSetNumber) return;
  const data = serializeBuildState(currentSetNumber, buildController.placedPieces);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `build_${currentSetNumber}_slot_${currentSlotNumber || 1}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

inputImportEl.addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file || !currentSetInfo) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.pieces)) {
      throw new Error("El archivo .json no contiene una lista válida de piezas ('pieces').");
    }
    await loadManifestIntoSlot(currentSetInfo, currentSlotNumber, currentSlotName, parsed);
    await persistCurrentSlot({ showToastOnSuccess: false });
    if (roomManager.isHost()) {
      roomManager.broadcastWorldEvent({
        type: "world:snapshot",
        snapshot: buildController.exportWorldSnapshot(),
      });
    }
    showToast(`Progreso importado en Slot ${currentSlotNumber}.`);
  } catch (err) {
    showToast(`No se pudo importar: ${err.message}`);
  } finally {
    ev.target.value = "";
  }
});

// Controles de teclado: WASD cámara, R/T Y, F/G X, C/V Z, Flechas altura, H HUD, Espacio revolver
window.addEventListener("keydown", (ev) => {
  if (ev.target.tagName === "INPUT" || ev.target.tagName === "SELECT" || ev.target.tagName === "TEXTAREA") {
    return;
  }

  if (lobbyView?.isOpen()) {
    if (ev.key === "Escape" && lobbyView.isModalOpen()) {
      lobbyView.closeModal();
    }
    return;
  }

  if (helpGuide.handleKey(ev)) {
    return;
  }

  if (roomModal?.isOpen()) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      roomModal.hide();
    }
    return;
  }

  if (
    (ev.ctrlKey || ev.metaKey) &&
    !ev.altKey &&
    (ev.key.toLowerCase() === "s" || ev.code === "KeyS")
  ) {
    ev.preventDefault();
    if (roomManager.isGuest()) {
      showToast("Solo el administrador del slot puede guardar.");
      return;
    }
    persistCurrentSlot({ showToastOnSuccess: true });
    return;
  }

  if (
    (ev.ctrlKey || ev.metaKey) &&
    !ev.altKey &&
    (ev.key.toLowerCase() === "z" || ev.code === "KeyZ")
  ) {
    ev.preventDefault();
    if (stickerMode || pendingStickerTarget) {
      setStickerMode(false);
      showToast("Modo pegatina cancelado.");
      return;
    }
    if (roomManager.isGuest()) {
      showToast("Solo el administrador del slot puede deshacer.");
      return;
    }
    buildController.undo();
    return;
  }

  if (ev.ctrlKey || ev.metaKey) {
    return;
  }

  const key = ev.key.toLowerCase();
  if (["w", "a", "s", "d"].includes(key)) {
    sceneManager.setMoveKey(key, true);
    return;
  }

  switch (key) {
    case "r":
      buildController.rotateActive("y", -1);
      break;
    case "t":
      buildController.rotateActive("y", 1);
      break;
    case "f":
      buildController.rotateActive("x", 1);
      break;
    case "g":
      buildController.rotateActive("x", -1);
      break;
    case "v":
      buildController.rotateActive("z", 1);
      break;
    case "b":
      buildController.rotateActive("z", -1);
      break;
    case "arrowleft": {
      ev.preventDefault();
      const { right } = sceneManager.getHorizontalCameraAxes();
      buildController.nudgeHorizontal(-right.x, -right.z);
      break;
    }
    case "arrowright": {
      ev.preventDefault();
      const { right } = sceneManager.getHorizontalCameraAxes();
      buildController.nudgeHorizontal(right.x, right.z);
      break;
    }
    case "arrowup": {
      ev.preventDefault();
      if (ev.shiftKey) {
        const { forward } = sceneManager.getHorizontalCameraAxes();
        buildController.nudgeHorizontal(forward.x, forward.z);
      } else {
        buildController.nudgeVertical(1, ev.altKey);
      }
      break;
    }
    case "arrowdown": {
      ev.preventDefault();
      if (ev.shiftKey) {
        const { forward } = sceneManager.getHorizontalCameraAxes();
        buildController.nudgeHorizontal(-forward.x, -forward.z);
      } else {
        buildController.nudgeVertical(-1, ev.altKey);
      }
      break;
    }
    case "pageup":
      ev.preventDefault();
      buildController.nudgeVertical(1, ev.shiftKey || ev.altKey);
      break;
    case "pagedown":
      ev.preventDefault();
      buildController.nudgeVertical(-1, ev.shiftKey || ev.altKey);
      break;
    case "q":
      buildController.toggleFineGrid();
      break;
    case "e":
      buildController.toggleFineRotation();
      break;
    case "u":
      buildController.toggleAutoOrient();
      break;
    case "k":
      buildController.toggleCollision();
      break;
    case "h":
      hudVisible = !hudVisible;
      helpGuide.close();
      updateLayoutVisibility();
      break;
    case " ":
      ev.preventDefault();
      buildController.shakePile();
      break;
    case "delete":
    case "backspace":
      buildController.returnSelectedToPile();
      break;
    case "escape":
      if (stickerMode || pendingStickerTarget) {
        setStickerMode(false);
      } else if (marqueeState) {
        clearMarquee();
        sceneManager.controls.enabled = true;
      } else if (buildController.carry) {
        buildController.cancelCarry();
      } else {
        buildController.clearSelection();
      }
      break;
  }
});

window.addEventListener("keyup", (ev) => {
  sceneManager.setMoveKey(ev.key.toLowerCase(), false);
});
window.addEventListener("blur", () => {
  sceneManager.clearMoveKeys();
  if (marqueeState) {
    clearMarquee();
    sceneManager.controls.enabled = true;
  }
});

async function loadManifestIntoSlot(setInfo, slotNumber, slotName, saveData = null) {
  isLoadingSlot = true;
  try {
    const resp = await fetch(`/sets/${encodeURIComponent(setInfo.filename)}`);
    if (!resp.ok) {
      throw new Error(`No se pudo cargar ${setInfo.filename} (HTTP ${resp.status}).`);
    }
    const manifest = await resp.json();
    if (!manifest || !Array.isArray(manifest.parts)) {
      throw new Error(`El manifiesto de ${setInfo.filename} está corrupto o incompleto.`);
    }
    currentSetInfo = setInfo;
    currentSetNumber = manifest.set_number || setInfo.set_number;
    currentSlotNumber = slotNumber;
    currentSlotName = slotName || `Slot ${slotNumber}`;

    const saved = saveData ? { pieces: saveData.pieces || [] } : null;
    const savedHistory = Array.isArray(saveData?.history) ? saveData.history : [];

    await buildController.loadManifest(manifest, saved, savedHistory);
    trayPanel.setManifest(manifest);
    manualDrawer.setOpen(false);
    manualDrawer.setSet(currentSetNumber, manifest.source_pdf || "");
    sceneManager.resetCamera();
    return true;
  } finally {
    isLoadingSlot = false;
  }
}

async function enterEditorWithSlot({ setInfo, slotNumber, slotName, saveData }) {
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  applyRolePermissions();
  lobbyView.hide();
  editorAppEl.classList.remove("hidden");
  hudVisible = true;
  updateLayoutVisibility();

  try {
    const ok = await loadManifestIntoSlot(setInfo, slotNumber, slotName, saveData);
    if (!ok) {
      await returnToLobby({ skipFlush: true });
      return;
    }
    requestAnimationFrame(() => sceneManager.resize());
  } catch (err) {
    const msg = err?.message || "No se pudo abrir el set.";
    await returnToLobby({ skipFlush: true });
    lobbyView.showError(msg);
    showToast(msg);
  }
}

async function joinRoomFromLobby({ code, playerName, onProgress }) {
  const joined = await roomManager.joinRoom({ code, playerName, onProgress });
  const { setMeta, snapshot, roomCode } = joined;

  const resp = await fetch(`/sets/${encodeURIComponent(setMeta.manifest_file)}`);
  if (!resp.ok) {
    roomManager.closeRoom();
    throw new Error("No se pudo abrir el catálogo descargado del set.");
  }
  const manifest = await resp.json();

  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  currentSetInfo = {
    filename: setMeta.manifest_file,
    set_number: setMeta.set_number,
    set_name: setMeta.set_name,
  };
  currentSetNumber = manifest.set_number || setMeta.set_number;
  currentSlotNumber = null;
  currentSlotName = null;

  applyRolePermissions();
  lobbyView.hide();
  editorAppEl.classList.remove("hidden");
  hudVisible = true;
  updateLayoutVisibility();

  await buildController.loadFromNetworkSnapshot(manifest, snapshot, { passivePhysics: true });
  trayPanel.setManifest(manifest);
  manualDrawer.setOpen(false);
  manualDrawer.setSet(currentSetNumber, manifest.source_pdf || "");
  sceneManager.resetCamera();
  remotePresence.syncPlayersRoster(roomManager.getPlayers(), roomManager.localPeerId);
  remotePresence.updateLockBoxes(
    roomManager.remoteLocks,
    buildController.placedPieces,
    buildController.pilePhysics.items,
    roomManager.localPeerId
  );
  requestAnimationFrame(() => sceneManager.resize());
  showToast(`Conectado a la sala ${roomCode}.`);
}

async function returnToLobby({ skipFlush = false } = {}) {
  if (!skipFlush && autoSaveTimer && !roomManager.isGuest()) {
    await persistCurrentSlot({ showToastOnSuccess: false });
  }
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  if (marqueeState) {
    clearMarquee();
    sceneManager.controls.enabled = true;
  }
  setStickerMode(false);
  roomModal.hide();
  buildController.cancelCarry();
  buildController.clearSelection();
  if (roomManager.isOpen()) {
    roomManager.closeRoom();
  }
  remotePresence.clearAll();
  sceneManager.clearMoveKeys();
  helpGuide.close();
  applyRolePermissions();

  currentSetInfo = null;
  currentSetNumber = null;
  currentSlotNumber = null;
  currentSlotName = null;

  editorAppEl.classList.add("hidden");
  lobbyView.show();
  try {
    await lobbyView.loadSets();
  } catch (err) {
    showToast(`Error actualizando sets: ${err.message}`);
  }
}

async function init() {
  lobbyView = new LobbyView({
    onOpenSlot: enterEditorWithSlot,
    onJoinRoom: joinRoomFromLobby,
    onCancelJoin: () => roomManager.closeRoom(),
    onToast: showToast,
  });
  try {
    lobbyView.show();
    const sets = await lobbyView.loadSets();
    if (!sets.length) {
      showToast("Subí un PDF desde el panel izquierdo para comenzar.");
    }
  } catch (err) {
    showToast(`Error iniciando: ${err.message}`);
  }
}

init();
