import {
  deleteSlotOnDisk,
  loadSlotSave,
  migrateLocalStorageToSlot1IfNeeded,
  renameSlotOnDisk,
  saveSlotToDisk,
} from "../builder/storage.js";
import { buildManualHistoryKey, clearSavedManualProgress } from "./manualDrawer.js";

export const LOBBY_SETS_PER_PAGE = 60;
export const LOBBY_MAX_PAGE_BUTTONS = 6;

/**
 * Calcula la ventana de paginación (máximo 6 botones numéricos tomando el extremo
 * superior como referencia: ej. pág 3 -> [1..6], pág 8 -> [3..8]).
 */
export function computePaginationWindow(
  currentPage,
  totalItems,
  perPage = LOBBY_SETS_PER_PAGE,
  maxButtons = LOBBY_MAX_PAGE_BUTTONS
) {
  const safeTotal = Math.max(0, Number(totalItems) || 0);
  const totalPages = Math.max(1, Math.ceil(safeTotal / perPage));
  const safePage = Math.max(1, Math.min(totalPages, Math.floor(Number(currentPage) || 1)));
  if (totalPages <= 1) {
    return {
      totalPages: 1,
      currentPage: 1,
      startIndex: 0,
      endIndex: Math.min(safeTotal, perPage),
      pages: [1],
      showArrows: false,
    };
  }
  const visibleCount = Math.min(totalPages, maxButtons);
  const endPage = Math.min(totalPages, Math.max(visibleCount, safePage));
  const startPage = Math.max(1, endPage - visibleCount + 1);
  const pages = [];
  for (let p = startPage; p <= endPage; p += 1) {
    pages.push(p);
  }
  const startIndex = (safePage - 1) * perPage;
  const endIndex = Math.min(safeTotal, startIndex + perPage);
  return {
    totalPages,
    currentPage: safePage,
    startIndex,
    endIndex,
    pages,
    showArrows: true,
  };
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function formatDate(isoString) {
  if (!isoString) return "—";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  return d.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export class LobbyView {
  constructor({ onOpenSlot, onJoinRoom, onCancelJoin, onToast }) {
    this.onOpenSlot = onOpenSlot;
    this.onJoinRoom = onJoinRoom;
    this.onCancelJoin = onCancelJoin;
    this.onToast = onToast || (() => {});

    this.screenEl = document.getElementById("lobby-screen");
    this.gridEl = document.getElementById("lobby-sets-grid");
    this.scrollWrapEl = this.gridEl?.parentElement || null;
    this.emptyEl = document.getElementById("lobby-empty");
    this.paginationEl = document.getElementById("lobby-pagination");
    this.searchEl = document.getElementById("lobby-search");
    this.countEl = document.getElementById("lobby-count");
    this.dropzoneEl = document.getElementById("pdf-dropzone");
    this.uploadInputEl = document.getElementById("input-upload-pdf");
    this.scanBtnEl = document.getElementById("btn-lobby-scan");
    this.uploadStatusEl = document.getElementById("upload-status");

    this.joinBtnEl = document.getElementById("btn-join-room");
    this.joinModalEl = document.getElementById("join-room-modal");
    this.joinCloseBtnEl = document.getElementById("btn-close-join-room");
    this.joinCancelBtnEl = document.getElementById("btn-cancel-join");
    this.joinFormEl = document.getElementById("join-room-form");
    this.joinCodeEl = document.getElementById("input-join-code");
    this.joinNameEl = document.getElementById("input-join-name");
    this.joinSubmitBtnEl = document.getElementById("btn-submit-join");
    this.joinProgressEl = document.getElementById("join-room-progress");
    this.joinProgressTextEl = document.getElementById("join-room-progress-text");
    this.joinProgressBarEl = document.getElementById("join-room-progress-bar");
    this.joinErrorEl = document.getElementById("join-room-error");

    this.modalEl = document.getElementById("slots-modal");
    this.modalCoverEl = document.getElementById("slots-modal-cover");
    this.modalTitleEl = document.getElementById("slots-modal-title");
    this.modalMetaEl = document.getElementById("slots-modal-meta");
    this.modalNoticeEl = document.getElementById("slots-modal-notice");
    this.rescanSetBtnEl = document.getElementById("btn-rescan-set");
    this.closeModalBtnEl = document.getElementById("btn-close-slots");
    this.slotsListEl = document.getElementById("slots-list");

    this.sets = [];
    this.currentPage = 1;
    this.activeModalSet = null;
    this.activeSlots = [];
    this.editingSlotNumber = null;
    this.busyUpload = false;
    this.busyRescan = false;
    this.busyJoin = false;

    this._bindEvents();
  }

  _bindEvents() {
    this.searchEl.addEventListener("input", () => {
      this.currentPage = 1;
      this.renderSets();
    });

    this.uploadInputEl.addEventListener("change", async (ev) => {
      const files = Array.from(ev.target.files || []);
      ev.target.value = "";
      if (files.length) await this.handlePdfFiles(files);
    });

    this.dropzoneEl.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      this.dropzoneEl.classList.add("is-dragover");
    });

    this.dropzoneEl.addEventListener("dragleave", () => {
      this.dropzoneEl.classList.remove("is-dragover");
    });

    this.dropzoneEl.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      this.dropzoneEl.classList.remove("is-dragover");
      const files = Array.from(ev.dataTransfer?.files || []);
      if (files.length) await this.handlePdfFiles(files);
    });

    this.scanBtnEl.addEventListener("click", () => this.scanSets());
    this.rescanSetBtnEl?.addEventListener("click", () => this.rescanActiveSet());
    this.closeModalBtnEl.addEventListener("click", () => this.closeModal());
    this.modalEl.addEventListener("click", (ev) => {
      if (ev.target === this.modalEl) this.closeModal();
    });

    this.joinBtnEl?.addEventListener("click", () => this.openJoinModal());
    this.joinCloseBtnEl?.addEventListener("click", () => this.closeJoinModal());
    this.joinCancelBtnEl?.addEventListener("click", () => this.closeJoinModal());
    this.joinModalEl?.addEventListener("click", (ev) => {
      if (ev.target === this.joinModalEl && !this.busyJoin) this.closeJoinModal();
    });
    this.joinCodeEl?.addEventListener("input", () => {
      this.joinCodeEl.value = this.joinCodeEl.value.replace(/\D/g, "").slice(0, 7);
    });
    this.joinFormEl?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (this.busyJoin || !this.onJoinRoom) return;
      const code = String(this.joinCodeEl?.value || "").trim();
      const playerName = String(this.joinNameEl?.value || "").trim();
      if (!/^\d{7}$/.test(code)) {
        this._setJoinError("Ingresá un código válido de 7 dígitos.");
        return;
      }
      this.busyJoin = true;
      if (this.joinSubmitBtnEl) this.joinSubmitBtnEl.disabled = true;
      if (this.joinCodeEl) this.joinCodeEl.disabled = true;
      if (this.joinNameEl) this.joinNameEl.disabled = true;
      this._setJoinError("");
      this._setJoinProgress(0, 100, "Buscando sala...");
      try {
        await this.onJoinRoom({
          code,
          playerName,
          onProgress: (done, total, label) => this._setJoinProgress(done, total, label),
        });
        this.busyJoin = false;
        this.closeJoinModal(true);
      } catch (err) {
        this._setJoinProgress(0, 0, "");
        this._setJoinError(err?.message || "No se pudo conectar a la sala.");
      } finally {
        this.busyJoin = false;
        if (this.joinSubmitBtnEl) this.joinSubmitBtnEl.disabled = false;
        if (this.joinCodeEl) this.joinCodeEl.disabled = false;
        if (this.joinNameEl) this.joinNameEl.disabled = false;
      }
    });
  }

  _setJoinError(msg) {
    if (!this.joinErrorEl) return;
    if (!msg) {
      this.joinErrorEl.classList.add("hidden");
      this.joinErrorEl.textContent = "";
    } else {
      this.joinErrorEl.textContent = msg;
      this.joinErrorEl.classList.remove("hidden");
    }
  }

  _setJoinProgress(done, total, label) {
    if (!this.joinProgressEl) return;
    if (!total) {
      this.joinProgressEl.classList.add("hidden");
      return;
    }
    this.joinProgressEl.classList.remove("hidden");
    if (this.joinProgressTextEl) this.joinProgressTextEl.textContent = label || "Cargando...";
    if (this.joinProgressBarEl) {
      const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
      this.joinProgressBarEl.style.width = `${pct}%`;
    }
  }

  openJoinModal() {
    this._setJoinError("");
    this._setJoinProgress(0, 0, "");
    this.joinModalEl?.classList.remove("hidden");
    setTimeout(() => this.joinCodeEl?.focus(), 0);
  }

  closeJoinModal(force = false) {
    if (this.busyJoin && !force) {
      this.onCancelJoin?.();
    }
    this.joinModalEl?.classList.add("hidden");
    this._setJoinProgress(0, 0, "");
    this._setJoinError("");
  }

  isOpen() {
    return !this.screenEl.classList.contains("hidden");
  }

  isModalOpen() {
    return (
      !this.modalEl.classList.contains("hidden") ||
      Boolean(this.joinModalEl && !this.joinModalEl.classList.contains("hidden"))
    );
  }

  show() {
    this.screenEl.classList.remove("hidden");
  }

  hide() {
    this.closeModal();
    this.closeJoinModal(true);
    this.screenEl.classList.add("hidden");
  }

  _setUploadStatus(message, tone = "") {
    if (!message) {
      this.uploadStatusEl.classList.add("hidden");
      this.uploadStatusEl.textContent = "";
      this.uploadStatusEl.className = "upload-status hidden";
      return;
    }
    this.uploadStatusEl.textContent = message;
    this.uploadStatusEl.className = `upload-status${tone ? ` is-${tone}` : ""}`;
  }

  showError(message) {
    this._setUploadStatus(message, "error");
  }

  async loadSets() {
    const resp = await fetch("/api/sets");
    const sets = await resp.json();
    this.sets = Array.isArray(sets) ? sets : [];
    this.renderSets();
    return this.sets;
  }

  async scanSets() {
    if (this.busyUpload) return;
    this.busyUpload = true;
    this.scanBtnEl.disabled = true;
    this._setUploadStatus("Escaneando carpeta Sets/...");
    try {
      const resp = await fetch("/api/scan-sets", { method: "POST" });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        this._setUploadStatus(data.error || "No se pudo escanear Sets/.", "error");
        return;
      }
      this.sets = Array.isArray(data.sets) ? data.sets : [];
      this.renderSets();
      if (Array.isArray(data.failed) && data.failed.length) {
        const failedList = data.failed.map((f) => f.filename).join(", ");
        this._setUploadStatus(
          `Catálogo actualizado (${this.sets.length} sets). Omitidos: ${failedList}`,
          "error",
        );
      } else {
        this._setUploadStatus(`Catálogo actualizado (${this.sets.length} sets).`, "success");
      }
    } catch (err) {
      this._setUploadStatus(`Error escaneando: ${err.message}`, "error");
    } finally {
      this.busyUpload = false;
      this.scanBtnEl.disabled = false;
    }
  }

  async handlePdfFiles(files) {
    if (this.busyUpload) return;
    const pdfs = files.filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) {
      this._setUploadStatus("Seleccioná uno o más archivos .pdf válidos.", "error");
      return;
    }

    this.busyUpload = true;
    this.scanBtnEl.disabled = true;
    let uploadedCount = 0;
    try {
      for (const file of pdfs) {
        this._setUploadStatus(`Subiendo y procesando ${file.name}...`);
        const resp = await fetch(
          `/api/upload-pdf?filename=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/pdf" },
            body: file,
          }
        );
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `Error procesando ${file.name}`);
        }
        if (Array.isArray(data.sets)) {
          this.sets = data.sets;
        }
        uploadedCount += 1;
      }
      this.renderSets();
      const msg =
        uploadedCount === 1
          ? `PDF procesado correctamente (${pdfs[0].name}).`
          : `${uploadedCount} PDFs procesados correctamente.`;
      this._setUploadStatus(msg, "success");
      this.onToast(msg);
    } catch (err) {
      this._setUploadStatus(err.message, "error");
      this.onToast(`Error: ${err.message}`);
    } finally {
      this.busyUpload = false;
      this.scanBtnEl.disabled = false;
    }
  }

  renderSets() {
    const query = normalizeSearch(this.searchEl.value);
    const filtered = this.sets.filter((s) => {
      if (!query) return true;
      const haystack = normalizeSearch(`${s.set_number} ${s.set_name}`);
      return haystack.includes(query);
    });

    this.countEl.textContent = `${filtered.length} ${filtered.length === 1 ? "set" : "sets"}`;
    this.gridEl.innerHTML = "";
    this.emptyEl.classList.toggle("hidden", filtered.length > 0);

    const pageState = computePaginationWindow(this.currentPage, filtered.length);
    this.currentPage = pageState.currentPage;
    const pageSets = filtered.slice(pageState.startIndex, pageState.endIndex);

    for (const setInfo of pageSets) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "set-card";
      card.dataset.setNumber = setInfo.set_number;

      const thumb = document.createElement("div");
      thumb.className = "set-card-thumb";
      if (setInfo.cover_url) {
        const img = document.createElement("img");
        img.src = setInfo.cover_url;
        img.alt = `${setInfo.set_number} ${setInfo.set_name}`;
        img.loading = "lazy";
        thumb.appendChild(img);
      } else {
        const fallback = document.createElement("span");
        fallback.className = "set-card-fallback";
        fallback.textContent = setInfo.set_number;
        thumb.appendChild(fallback);
      }

      const savesPill = document.createElement("span");
      const savesCount = Number(setInfo.saves_count || 0);
      savesPill.className = `set-card-saves-pill${savesCount > 0 ? " has-saves" : ""}`;
      savesPill.textContent = `${savesCount}/3 guardados`;
      thumb.appendChild(savesPill);

      const body = document.createElement("div");
      body.className = "set-card-body";

      const num = document.createElement("span");
      num.className = "set-card-num";
      num.textContent = `Set #${setInfo.set_number}`;

      const name = document.createElement("div");
      name.className = "set-card-name";
      name.textContent = setInfo.set_name;

      const meta = document.createElement("div");
      meta.className = "set-card-meta";
      meta.textContent = `${setInfo.resolved_pieces} piezas 3D (${setInfo.total_pieces} totales)`;

      body.append(num, name, meta);
      card.append(thumb, body);
      card.addEventListener("click", () => this.openSetModal(setInfo));
      this.gridEl.appendChild(card);
    }

    this._renderPagination(filtered.length, pageState);
  }

  _goToPage(pageNum) {
    this.currentPage = pageNum;
    this.renderSets();
    if (this.scrollWrapEl) {
      this.scrollWrapEl.scrollTop = 0;
    }
  }

  _renderPagination(totalItems, pageState) {
    if (!this.paginationEl) return;
    this.paginationEl.innerHTML = "";
    if (!totalItems) {
      this.paginationEl.classList.add("hidden");
      return;
    }
    this.paginationEl.classList.remove("hidden");

    const { totalPages, currentPage, pages, showArrows } = pageState;

    if (showArrows) {
      const prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.className = "lobby-page-btn lobby-page-arrow";
      prevBtn.textContent = "<";
      prevBtn.title = "Página anterior";
      prevBtn.setAttribute("aria-label", "Página anterior");
      prevBtn.disabled = currentPage <= 1;
      prevBtn.addEventListener("click", () => this._goToPage(currentPage - 1));
      this.paginationEl.appendChild(prevBtn);
    }

    for (const p of pages) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `lobby-page-btn${p === currentPage ? " is-active" : ""}`;
      btn.textContent = String(p);
      btn.setAttribute("aria-label", `Página ${p}`);
      if (p === currentPage) {
        btn.setAttribute("aria-current", "page");
      }
      if (totalPages === 1) {
        btn.disabled = true;
      } else if (p !== currentPage) {
        btn.addEventListener("click", () => this._goToPage(p));
      }
      this.paginationEl.appendChild(btn);
    }

    if (showArrows) {
      const nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.className = "lobby-page-btn lobby-page-arrow";
      nextBtn.textContent = ">";
      nextBtn.title = "Página siguiente";
      nextBtn.setAttribute("aria-label", "Página siguiente");
      nextBtn.disabled = currentPage >= totalPages;
      nextBtn.addEventListener("click", () => this._goToPage(currentPage + 1));
      this.paginationEl.appendChild(nextBtn);
    }
  }

  _renderModalNotice(setInfo, customMessage = null, customTone = "") {
    if (!this.modalNoticeEl) return;
    if (customMessage) {
      this.modalNoticeEl.textContent = customMessage;
      this.modalNoticeEl.className = `modal-notice${customTone ? ` is-${customTone}` : ""}`;
      return;
    }
    const summary = setInfo?.unresolved_summary;
    if (summary && summary.definitive_pieces > 0 && summary.transient_pieces === 0 && summary.reason) {
      const n = summary.definitive_pieces;
      const msg =
        n === 1
          ? `1 pieza no pudo aparecer porque ${summary.reason}. Volver a escanear no podrá recuperarla hasta que ese molde exista en LDraw.`
          : `${n} piezas no pudieron aparecer porque ${summary.reason}. Volver a escanear no podrá recuperarlas hasta que esos moldes existan en LDraw.`;
      this.modalNoticeEl.textContent = msg;
      this.modalNoticeEl.className = "modal-notice is-warning";
      return;
    }
    this.modalNoticeEl.textContent = "";
    this.modalNoticeEl.className = "modal-notice hidden";
  }

  async rescanActiveSet() {
    if (this.busyRescan || !this.activeModalSet) return;
    const targetSet = this.activeModalSet;
    this.busyRescan = true;
    if (this.rescanSetBtnEl) {
      this.rescanSetBtnEl.disabled = true;
      this.rescanSetBtnEl.textContent = "Re-escaneando...";
    }
    this._renderModalNotice(targetSet, "Re-escaneando el PDF de este set...", "info");

    try {
      const resp = await fetch("/api/rescan-set", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          set_number: targetSet.set_number,
          source_pdf: targetSet.source_pdf || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        this._renderModalNotice(targetSet, data.error || "No se pudo re-escanear este set.", "error");
        return;
      }

      if (Array.isArray(data.sets)) {
        this.sets = data.sets;
      }
      const updated =
        data.set ||
        this.sets.find((s) => s.set_number === targetSet.set_number) ||
        targetSet;
      this.activeModalSet = updated;
      this.modalTitleEl.textContent = `${updated.set_number} — ${updated.set_name}`;
      this.modalMetaEl.textContent = `${updated.resolved_pieces} piezas 3D disponibles`;
      this.renderSets();
      this.renderSlots();

      const summary = updated.unresolved_summary;
      if (summary && summary.definitive_pieces > 0 && summary.transient_pieces === 0 && summary.reason) {
        this._renderModalNotice(updated);
      } else {
        this._renderModalNotice(
          updated,
          `Re-escaneo listo: ${updated.resolved_pieces} / ${updated.total_pieces} piezas 3D disponibles.`,
          "success"
        );
      }
    } catch (err) {
      this._renderModalNotice(targetSet, `Error al re-escanear: ${err.message}`, "error");
    } finally {
      this.busyRescan = false;
      if (this.rescanSetBtnEl) {
        this.rescanSetBtnEl.disabled = false;
        this.rescanSetBtnEl.textContent = "↻ Re-escanear";
      }
    }
  }

  async openSetModal(setInfo) {
    this.activeModalSet = setInfo;
    this.editingSlotNumber = null;

    this.modalTitleEl.textContent = `${setInfo.set_number} — ${setInfo.set_name}`;
    this.modalMetaEl.textContent = `${setInfo.resolved_pieces} piezas 3D disponibles`;
    this._renderModalNotice(null);
    if (this.rescanSetBtnEl) {
      this.rescanSetBtnEl.disabled = false;
      this.rescanSetBtnEl.textContent = "↻ Re-escanear";
    }
    if (setInfo.cover_url) {
      this.modalCoverEl.src = setInfo.cover_url;
      this.modalCoverEl.classList.remove("hidden");
    } else {
      this.modalCoverEl.classList.add("hidden");
    }

    this.slotsListEl.textContent = "Cargando slots...";
    this.modalEl.classList.remove("hidden");

    try {
      this.activeSlots = await migrateLocalStorageToSlot1IfNeeded(setInfo.set_number);
      this._syncCardSavesCount(setInfo.set_number, this.activeSlots);
      this.renderSlots();
    } catch (err) {
      this.slotsListEl.textContent = `Error cargando guardados: ${err.message}`;
    }
  }

  closeModal() {
    this.modalEl.classList.add("hidden");
    this._renderModalNotice(null);
    this.activeModalSet = null;
    this.editingSlotNumber = null;
    if (this.joinModalEl && !this.joinModalEl.classList.contains("hidden")) {
      this.closeJoinModal(true);
    }
  }

  _syncCardSavesCount(setNumber, slots) {
    const count = slots.filter((s) => s.exists).length;
    const item = this.sets.find((s) => s.set_number === setNumber);
    if (item) {
      item.saves_count = count;
      this.renderSets();
    }
  }

  renderSlots() {
    if (!this.activeModalSet) return;
    const setInfo = this.activeModalSet;
    this.slotsListEl.innerHTML = "";

    for (const slot of this.activeSlots) {
      const isEditing = this.editingSlotNumber === slot.slot;
      const card = document.createElement("div");
      card.className = `slot-card${slot.exists ? " is-saved" : ""}${isEditing ? " is-editing" : ""}`;
      card.dataset.slot = String(slot.slot);

      const top = document.createElement("div");
      top.className = "slot-top";

      const titleRow = document.createElement("div");
      titleRow.className = "slot-title-row";

      const badge = document.createElement("span");
      badge.className = `slot-badge${slot.exists ? " saved" : ""}`;
      badge.textContent = `Slot ${slot.slot}`;
      titleRow.appendChild(badge);

      if (isEditing) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "slot-rename-input";
        input.value = slot.name || `Slot ${slot.slot}`;
        input.maxLength = 60;
        input.addEventListener("keydown", async (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            await this._commitRename(slot.slot, input.value);
          } else if (ev.key === "Escape") {
            ev.preventDefault();
            this.editingSlotNumber = null;
            this.renderSlots();
          }
        });
        titleRow.appendChild(input);
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);

        const saveRenameBtn = document.createElement("button");
        saveRenameBtn.type = "button";
        saveRenameBtn.className = "btn btn-accent slot-rename-btn";
        saveRenameBtn.textContent = "Ok";
        saveRenameBtn.addEventListener("click", () => this._commitRename(slot.slot, input.value));

        const cancelRenameBtn = document.createElement("button");
        cancelRenameBtn.type = "button";
        cancelRenameBtn.className = "btn slot-rename-btn";
        cancelRenameBtn.textContent = "Cancelar";
        cancelRenameBtn.addEventListener("click", () => {
          this.editingSlotNumber = null;
          this.renderSlots();
        });
        titleRow.append(saveRenameBtn, cancelRenameBtn);
      } else {
        const nameEl = document.createElement("span");
        nameEl.className = "slot-name";
        nameEl.textContent = slot.exists ? slot.name || `Slot ${slot.slot}` : "Vacío";
        titleRow.appendChild(nameEl);
      }

      const stats = document.createElement("div");
      stats.className = "slot-stats";
      stats.textContent = slot.exists
        ? `${slot.placed_count} / ${setInfo.resolved_pieces} piezas · Modificado: ${formatDate(slot.updated_at)}`
        : "Sin partida guardada en este slot";

      top.append(titleRow, stats);

      const actions = document.createElement("div");
      actions.className = "slot-actions";

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "btn btn-accent";
      playBtn.textContent = slot.exists ? "Jugar / Continuar" : "Empezar aquí";
      playBtn.addEventListener("click", () => this._launchSlot(setInfo, slot));
      actions.appendChild(playBtn);

      if (slot.exists) {
        const renameBtn = document.createElement("button");
        renameBtn.type = "button";
        renameBtn.className = "btn";
        renameBtn.textContent = "Renombrar";
        renameBtn.addEventListener("click", () => {
          this.editingSlotNumber = slot.slot;
          this.renderSlots();
        });

        const exportBtn = document.createElement("button");
        exportBtn.type = "button";
        exportBtn.className = "btn";
        exportBtn.textContent = "Exportar .json";
        exportBtn.addEventListener("click", () => this._exportSlot(setInfo, slot.slot));

        actions.append(renameBtn, exportBtn);
      }

      const importLabel = document.createElement("label");
      importLabel.className = "btn btn-file";
      importLabel.textContent = "Importar .json";
      const importInput = document.createElement("input");
      importInput.type = "file";
      importInput.accept = ".json";
      importInput.hidden = true;
      importInput.addEventListener("change", async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = "";
        if (file) await this._importIntoSlot(setInfo, slot, file);
      });
      importLabel.appendChild(importInput);
      actions.appendChild(importLabel);

      if (slot.exists) {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "btn btn-danger";
        deleteBtn.textContent = "Borrar";
        deleteBtn.addEventListener("click", () => this._deleteSlot(setInfo, slot));
        actions.appendChild(deleteBtn);
      }

      card.append(top, actions);
      this.slotsListEl.appendChild(card);
    }
  }

  async _commitRename(slotNumber, newName) {
    if (!this.activeModalSet) return;
    const trimmed = String(newName || "").trim();
    if (!trimmed) {
      this.onToast("El nombre del slot no puede estar vacío.");
      return;
    }
    try {
      const res = await renameSlotOnDisk(this.activeModalSet.set_number, slotNumber, trimmed);
      this.editingSlotNumber = null;
      if (res?.slots) this.activeSlots = res.slots;
      this.renderSlots();
      this.onToast(`Slot ${slotNumber} renombrado a "${trimmed}".`);
    } catch (err) {
      this.onToast(`No se pudo renombrar: ${err.message}`);
    }
  }

  async _exportSlot(setInfo, slotNumber) {
    try {
      const save = await loadSlotSave(setInfo.set_number, slotNumber);
      if (!save) {
        this.onToast("Ese slot está vacío.");
        return;
      }
      downloadJsonFile(`build_${setInfo.set_number}_slot_${slotNumber}.json`, save);
    } catch (err) {
      this.onToast(`Error exportando: ${err.message}`);
    }
  }

  async _importIntoSlot(setInfo, slot, file) {
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.pieces)) {
        throw new Error("El archivo .json no contiene una lista válida de piezas ('pieces').");
      }
      const pieces = parsed.pieces;
      const history = Array.isArray(parsed.history) ? parsed.history : [];
      const name = slot.exists ? slot.name : parsed.name || `Slot ${slot.slot}`;
      const res = await saveSlotToDisk(setInfo.set_number, slot.slot, {
        name,
        pieces,
        history,
      });
      if (res?.slots) {
        this.activeSlots = res.slots;
        this._syncCardSavesCount(setInfo.set_number, this.activeSlots);
      }
      this.renderSlots();
      this.onToast(`Archivo importado en Slot ${slot.slot}.`);
    } catch (err) {
      this.onToast(`No se pudo importar: ${err.message}`);
    }
  }

  async _deleteSlot(setInfo, slot) {
    const label = slot.name || `Slot ${slot.slot}`;
    if (!confirm(`¿Borrar definitivamente el guardado "${label}" (Slot ${slot.slot}) del set ${setInfo.set_number}?`)) {
      return;
    }
    try {
      const res = await deleteSlotOnDisk(setInfo.set_number, slot.slot);
      clearSavedManualProgress(buildManualHistoryKey(setInfo.set_number, slot.slot));
      if (res?.slots) {
        this.activeSlots = res.slots;
        this._syncCardSavesCount(setInfo.set_number, this.activeSlots);
      }
      this.renderSlots();
      this.onToast(`Slot ${slot.slot} borrado.`);
    } catch (err) {
      this.onToast(`No se pudo borrar: ${err.message}`);
    }
  }

  async _launchSlot(setInfo, slot) {
    try {
      const saveData = slot.exists ? await loadSlotSave(setInfo.set_number, slot.slot) : null;
      const slotName = saveData?.name || slot.name || `Slot ${slot.slot}`;
      this.closeModal();
      await this.onOpenSlot({
        setInfo,
        slotNumber: slot.slot,
        slotName,
        saveData,
      });
    } catch (err) {
      this.onToast(`Error abriendo Slot ${slot.slot}: ${err.message}`);
    }
  }
}
