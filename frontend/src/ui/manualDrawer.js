const MANUAL_HISTORY_STORAGE_KEY = "softwarelego_manual_progress_v1";
const MANUAL_HISTORY_MAX_ENTRIES = 60;
export const MANUAL_MIN_WIDTH = 260;
export const MANUAL_MAX_WIDTH = 760;

export function buildManualHistoryKey(setNumber, slotNumber = null) {
  const safeSet = String(setNumber || "").trim();
  if (!safeSet) return null;
  const slot = Number(slotNumber);
  if (Number.isInteger(slot) && slot > 0) {
    return `${safeSet}::slot::${slot}`;
  }
  return safeSet;
}

function getStorageSafe() {
  try {
    return globalThis?.localStorage || null;
  } catch {
    return null;
  }
}

function readManualHistoryStore() {
  const storage = getStorageSafe();
  if (!storage) return {};
  try {
    const raw = storage.getItem(MANUAL_HISTORY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeManualHistoryStore(store) {
  const storage = getStorageSafe();
  if (!storage) return;
  try {
    const entries = Object.entries(store || {})
      .filter(([k, v]) => k && v && Number.isFinite(Number(v.page)))
      .sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
      .slice(0, MANUAL_HISTORY_MAX_ENTRIES);
    storage.setItem(MANUAL_HISTORY_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignora cuotas llenas o almacenamiento bloqueado
  }
}

export function clearSavedManualProgress(historyKey) {
  if (!historyKey) return;
  const store = readManualHistoryStore();
  if (Object.prototype.hasOwnProperty.call(store, historyKey)) {
    delete store[historyKey];
    writeManualHistoryStore(store);
  }
}

function normalizeProgressEntry(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { page: Math.max(1, Math.round(raw)), offsetRatio: 0, updatedAt: Date.now() };
  }
  if (!raw || typeof raw !== "object") return null;
  const page = Number(raw.page);
  if (!Number.isFinite(page) || page < 1) return null;
  const offsetRatio = Number(raw.offsetRatio);
  return {
    page: Math.max(1, Math.round(page)),
    offsetRatio: Number.isFinite(offsetRatio) ? Math.max(-0.5, Math.min(1.5, offsetRatio)) : 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
}

/**
 * Visor lateral izquierdo continuo para el manual PDF:
 * - Rueda del mouse: scroll fluido entre todas las páginas
 * - Ctrl + rueda: zoom continuo
 * - Click en cualquier parte del manual: oculta hacia la barrita vertical izquierda
 * - Borde derecho arrastrable para redimensionar temporalmente en horizontal
 */
export class ManualDrawer {
  constructor(elements, { onOpenChanged } = {}) {
    this.drawerEl = elements.drawerEl;
    this.tabEl = elements.tabEl;
    this.pageIndicatorEl = elements.pageIndicatorEl;
    this.openPdfBtnEl = elements.openPdfBtnEl;
    this.zoomBadgeEl = elements.zoomBadgeEl;
    this.viewportEl = elements.viewportEl;
    this.pagesContainerEl = elements.pagesContainerEl;
    this.statusEl = elements.statusEl;
    this.resizeHandleEl =
      elements.resizeHandleEl ||
      elements.drawerEl?.querySelector?.("#manual-resize-handle, .manual-resize-handle") ||
      null;
    this.onOpenChanged = onOpenChanged || (() => {});

    this.setNumber = null;
    this.memoryKey = null;
    this.sourcePdf = "";
    this.pageCount = 0;
    this.pageAspects = [];
    this.currentPage = 1;
    this.zoom = 1.0;
    this.isOpen = false;
    this.scrollMemory = new Map();
    const persisted = readManualHistoryStore();
    for (const [key, entry] of Object.entries(persisted)) {
      const normalized = normalizeProgressEntry(entry);
      if (normalized) this.scrollMemory.set(key, normalized);
    }

    this._loadSeq = 0;
    this._observer = null;
    this._pointerDown = null;
    this._resizeState = null;
    this._pageSlots = [];
    this._pendingRestorePos = null;
    this._suppressScrollSave = false;
    this._scrollSaveTimer = null;
    this._lastPersistedPage = 0;

    this._bindEvents();
    this._syncOpenState();
    this._syncZoomUI();
  }

  _bindEvents() {
    this.tabEl?.addEventListener("click", () => this.setOpen(true));

    this.openPdfBtnEl?.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    this.openPdfBtnEl?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.openExternalPdf();
    });

    this.viewportEl?.addEventListener(
      "wheel",
      (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault?.();
          const delta = ev.deltaY < 0 ? 0.2 : -0.2;
          this.setZoom(this.zoom + delta, ev);
        }
        // Sin Ctrl, el scroll nativo de #manual-viewport recorre continuamente todas las páginas
      },
      { passive: false }
    );

    this.viewportEl?.addEventListener("scroll", () => {
      if (!this._pageSlots.length) return;
      this._updateVisiblePageIndicator();
      if (!this._suppressScrollSave && !this._resizeState) {
        this._recordCurrentScroll({ immediate: false });
      }
    });

    this.resizeHandleEl?.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      if (!this.isOpen || !this.drawerEl) return;
      ev.stopPropagation?.();
      ev.preventDefault?.();
      const startWidth = this.getCurrentWidth();
      const anchor = this._captureScrollPosition();
      this._resizeState = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startWidth,
        anchor,
        captured: false,
      };
      if (ev.pointerId !== undefined) {
        try {
          this.resizeHandleEl?.setPointerCapture?.(ev.pointerId);
          this._resizeState.captured = true;
        } catch {
          // Ignora punteros sintéticos sin captura disponible
        }
      }
      this.drawerEl.classList.add("is-resizing");
      if (typeof document !== "undefined" && document.body?.style) {
        document.body.style.cursor = "ew-resize";
      }
    });

    // Click en cualquier parte del visor oculta el manual; arrastrar desplaza la hoja sin cerrarlo
    this.drawerEl?.addEventListener("dragstart", (ev) => ev.preventDefault());
    this.drawerEl?.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target?.closest?.("button, a, input, select, textarea, .manual-resize-handle")) return;
      // Ignoramos clicks en la barra de scroll vertical/horizontal nativa
      if (this.viewportEl && ev.target === this.viewportEl) {
        const rect = this.viewportEl.getBoundingClientRect();
        if (
          ev.clientX >= rect.left + this.viewportEl.clientWidth - 2 ||
          ev.clientY >= rect.top + this.viewportEl.clientHeight - 2
        ) {
          return;
        }
      }
      ev.preventDefault?.();
      if (typeof window !== "undefined") {
        window.getSelection?.()?.removeAllRanges?.();
      }
      this._pointerDown = {
        pointerId: ev.pointerId,
        x: ev.clientX,
        y: ev.clientY,
        scrollLeft: this.viewportEl?.scrollLeft || 0,
        scrollTop: this.viewportEl?.scrollTop || 0,
        moved: false,
        captured: false,
      };
    });

    window.addEventListener("pointermove", (ev) => {
      const resize = this._resizeState;
      if (resize) {
        if (
          resize.pointerId !== undefined &&
          ev.pointerId !== undefined &&
          ev.pointerId !== resize.pointerId
        ) {
          return;
        }
        const dx = ev.clientX - resize.startX;
        this.setWidth(resize.startWidth + dx);
        if (resize.anchor) {
          this._applyScrollPosition(resize.anchor);
        }
        return;
      }

      const down = this._pointerDown;
      if (!down) return;
      if (
        down.pointerId !== undefined &&
        ev.pointerId !== undefined &&
        ev.pointerId !== down.pointerId
      ) {
        return;
      }
      const dx = ev.clientX - down.x;
      const dy = ev.clientY - down.y;
      if (down.moved || Math.hypot(dx, dy) >= 4) {
        down.moved = true;
        if (!down.captured && down.pointerId !== undefined) {
          down.captured = true;
          try {
            this.drawerEl?.setPointerCapture?.(down.pointerId);
          } catch {
            // Ignora punteros sintéticos sin captura disponible
          }
        }
        const vp = this.viewportEl;
        const canPan =
          vp &&
          (this.zoom > 1.01 ||
            vp.scrollHeight > vp.clientHeight + 1 ||
            vp.scrollWidth > vp.clientWidth + 1);
        if (canPan) {
          vp.classList.add("is-panning");
          vp.scrollLeft = down.scrollLeft - dx;
          vp.scrollTop = down.scrollTop - dy;
        }
      }
    });

    const finishResize = (ev) => {
      const resize = this._resizeState;
      if (!resize) return false;
      if (
        resize.pointerId !== undefined &&
        ev?.pointerId !== undefined &&
        ev.pointerId !== resize.pointerId
      ) {
        return false;
      }
      this._resizeState = null;
      this.drawerEl?.classList.remove("is-resizing");
      if (typeof document !== "undefined" && document.body?.style) {
        document.body.style.cursor = "";
      }
      if (resize.captured && resize.pointerId !== undefined) {
        try {
          if (this.resizeHandleEl?.hasPointerCapture?.(resize.pointerId)) {
            this.resizeHandleEl.releasePointerCapture(resize.pointerId);
          }
        } catch {
          // Ignora si el navegador ya liberó la captura
        }
      }
      if (resize.anchor) {
        this._applyScrollPosition(resize.anchor);
      }
      this._recordCurrentScroll({ immediate: true });
      return true;
    };

    const finishPointer = (ev) => {
      if (finishResize(ev)) return;

      const down = this._pointerDown;
      if (!down) return;
      if (
        down.pointerId !== undefined &&
        ev.pointerId !== undefined &&
        ev.pointerId !== down.pointerId
      ) {
        return;
      }
      this._pointerDown = null;
      this.viewportEl?.classList.remove("is-panning");
      if (down.captured && down.pointerId !== undefined) {
        try {
          if (this.drawerEl?.hasPointerCapture?.(down.pointerId)) {
            this.drawerEl.releasePointerCapture(down.pointerId);
          }
        } catch {
          // Ignora si el navegador ya liberó la captura
        }
      }

      const dx = typeof ev.clientX === "number" ? ev.clientX - down.x : 0;
      const dy = typeof ev.clientY === "number" ? ev.clientY - down.y : 0;
      const movedOnRelease = Math.hypot(dx, dy) >= 4;
      const scrolled =
        Math.abs((this.viewportEl?.scrollLeft || 0) - down.scrollLeft) >= 1 ||
        Math.abs((this.viewportEl?.scrollTop || 0) - down.scrollTop) >= 1;
      const wasClick =
        ev.type === "pointerup" &&
        (ev.button === undefined || ev.button === 0) &&
        !down.moved &&
        !movedOnRelease &&
        !scrolled;
      if (wasClick && this.isOpen) {
        this.setOpen(false);
      }
    };
    window.addEventListener("pointerup", finishPointer);
    window.addEventListener("pointercancel", finishPointer);
    window.addEventListener("blur", () => {
      finishResize();
      this._pointerDown = null;
      this.viewportEl?.classList.remove("is-panning");
    });
    window.addEventListener("resize", () => {
      const rawWidth = this.drawerEl?.style?.width;
      if (!rawWidth) return;
      const numeric = Number.parseFloat(rawWidth);
      if (Number.isFinite(numeric)) {
        this.setWidth(numeric);
      }
    });
    const handleBeforeExit = () => this.flushProgress();
    window.addEventListener("pagehide", handleBeforeExit);
    window.addEventListener("beforeunload", handleBeforeExit);
  }

  getWidthLimits() {
    const viewportWidth =
      typeof window !== "undefined" && Number.isFinite(window.innerWidth) && window.innerWidth > 0
        ? window.innerWidth
        : 1280;
    const minWidth = MANUAL_MIN_WIDTH;
    const maxWidth = Math.max(minWidth, Math.min(MANUAL_MAX_WIDTH, Math.floor(viewportWidth * 0.62)));
    return { minWidth, maxWidth };
  }

  getCurrentWidth() {
    if (!this.drawerEl) return 368;
    const rectWidth = this.drawerEl.getBoundingClientRect?.().width;
    if (Number.isFinite(rectWidth) && rectWidth > 0) return rectWidth;
    const styleWidth = Number.parseFloat(this.drawerEl.style?.width || "");
    if (Number.isFinite(styleWidth) && styleWidth > 0) return styleWidth;
    return 368;
  }

  setWidth(nextWidth) {
    if (!this.drawerEl || !Number.isFinite(nextWidth)) return null;
    const { minWidth, maxWidth } = this.getWidthLimits();
    const clamped = Math.round(Math.max(minWidth, Math.min(maxWidth, nextWidth)));
    this.drawerEl.style.width = `${clamped}px`;
    return clamped;
  }

  resetWidth() {
    if (this.drawerEl?.style) {
      this.drawerEl.style.width = "";
    }
    this.drawerEl?.classList?.remove("is-resizing");
  }

  setHudVisible(visible) {
    this.drawerEl?.classList.toggle("is-hud-hidden", !visible);
    this.tabEl?.classList.toggle("is-hud-hidden", !visible);
  }

  setOpen(open) {
    const nextOpen = Boolean(open);
    if (!nextOpen && this.isOpen) {
      this.flushProgress();
    }
    this.isOpen = nextOpen;
    this._syncOpenState();
    if (this.isOpen && this._pendingRestorePos) {
      const applyLater = () => this._applyPendingRestore();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(applyLater);
      } else {
        applyLater();
      }
    }
    this.onOpenChanged(this.isOpen);
  }

  _syncOpenState() {
    this.drawerEl?.classList.toggle("is-collapsed", !this.isOpen);
    this.tabEl?.classList.toggle("hidden", this.isOpen);
  }

  setZoom(nextZoom, wheelEv = null) {
    const prevZoom = this.zoom;
    const clamped = Math.max(1.0, Math.min(3.0, Math.round(nextZoom * 10) / 10));
    if (Math.abs(clamped - prevZoom) < 1e-4) return;

    const vp = this.viewportEl;
    let relX = 0.5;
    let relY = 0.5;
    if (vp && wheelEv) {
      const rect = vp.getBoundingClientRect();
      relX = Math.max(0, Math.min(1, (wheelEv.clientX - rect.left) / Math.max(1, rect.width)));
      relY = Math.max(0, Math.min(1, (wheelEv.clientY - rect.top) / Math.max(1, rect.height)));
    }
    const anchorX = vp ? (vp.scrollLeft + (vp.clientWidth * relX)) / prevZoom : 0;
    const anchorY = vp ? (vp.scrollTop + (vp.clientHeight * relY)) / prevZoom : 0;

    this.zoom = clamped;
    this._syncZoomUI();

    if (vp) {
      vp.scrollLeft = Math.max(0, anchorX * clamped - vp.clientWidth * relX);
      vp.scrollTop = Math.max(0, anchorY * clamped - vp.clientHeight * relY);
    }
  }

  _syncZoomUI() {
    if (this.zoomBadgeEl) {
      this.zoomBadgeEl.textContent = `${Math.round(this.zoom * 100)}%`;
    }
    if (this.pagesContainerEl) {
      this.pagesContainerEl.style.width = `${Math.round(this.zoom * 100)}%`;
    }
    this.viewportEl?.classList.toggle("is-zoomed", this.zoom > 1.01);
  }

  openExternalPdf() {
    if (!this.setNumber) return;
    const params = new URLSearchParams({
      set: this.setNumber,
      source: this.sourcePdf || "",
    });
    const url = `/api/manual/pdf?${params.toString()}#page=${this.currentPage || 1}`;
    window.open(url, "_blank", "noopener");
  }

  _buildPageUrl(page) {
    const params = new URLSearchParams({
      set: this.setNumber || "",
      source: this.sourcePdf || "",
      page: String(page),
      scale: "2.0",
    });
    return `/api/manual/page?${params.toString()}`;
  }

  _setStatus(text, isError = false) {
    if (!this.statusEl) return;
    if (!text) {
      this.statusEl.classList.add("hidden");
      this.statusEl.textContent = "";
      this.statusEl.classList.remove("is-error");
      return;
    }
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("is-error", isError);
    this.statusEl.classList.remove("hidden");
  }

  _getVisiblePageSlot() {
    if (!this._pageSlots.length || !this.viewportEl) return null;
    const vpCenter = (this.viewportEl.scrollTop || 0) + (this.viewportEl.clientHeight || 0) * 0.4;
    let bestSlot = this._pageSlots[0];
    let bestDist = Infinity;
    for (const slot of this._pageSlots) {
      const top = Number(slot.el.offsetTop) || 0;
      const height = Number(slot.el.offsetHeight) || 0;
      const mid = top + height * 0.5;
      const dist = Math.abs(mid - vpCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestSlot = slot;
      }
    }
    return bestSlot;
  }

  _updateVisiblePageIndicator() {
    const bestSlot = this._getVisiblePageSlot();
    if (!bestSlot) return;
    this.currentPage = bestSlot.page;
    if (this.pageIndicatorEl) {
      this.pageIndicatorEl.textContent = `Pág. ${bestSlot.page} / ${this.pageCount}`;
    }
  }

  _captureScrollPosition() {
    if (!this._pageSlots.length || !this.viewportEl) return null;
    const slot = this._getVisiblePageSlot();
    if (!slot) return null;
    if ((this.viewportEl.scrollTop || 0) <= 1 && slot.page === 1) {
      return { page: 1, offsetRatio: 0, updatedAt: Date.now() };
    }
    const height = Number(slot.el.offsetHeight) || 0;
    const top = Number(slot.el.offsetTop) || 0;
    const offsetRatio =
      height > 0 ? Math.max(-0.5, Math.min(1.5, ((this.viewportEl.scrollTop || 0) - top) / height)) : 0;
    return {
      page: slot.page,
      offsetRatio: Math.round(offsetRatio * 10000) / 10000,
      updatedAt: Date.now(),
    };
  }

  _applyScrollPosition(pos) {
    if (!pos || !this.viewportEl || !this._pageSlots.length) return false;
    const pageIndex = Math.max(0, Math.min(this._pageSlots.length - 1, (Number(pos.page) || 1) - 1));
    const slot = this._pageSlots[pageIndex];
    if (!slot) return false;
    const height = Number(slot.el.offsetHeight) || 0;
    const top = Number(slot.el.offsetTop) || 0;
    if (this._pageSlots.length > 1 && height <= 0) {
      return false;
    }
    const targetTop = Math.max(0, Math.round(top + (Number(pos.offsetRatio) || 0) * height));
    this._suppressScrollSave = true;
    this.viewportEl.scrollTop = targetTop;
    this._updateVisiblePageIndicator();
    const release = () => {
      this._suppressScrollSave = false;
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(release);
    } else {
      release();
    }
    return true;
  }

  _persistProgressMap() {
    const store = readManualHistoryStore();
    for (const [key, entry] of this.scrollMemory.entries()) {
      const normalized = normalizeProgressEntry(entry);
      if (normalized) store[key] = normalized;
    }
    writeManualHistoryStore(store);
  }

  _recordCurrentScroll({ immediate = false } = {}) {
    if (!this.memoryKey || !this._pageSlots.length || !this.viewportEl) return;
    const pos = this._captureScrollPosition();
    if (!pos) return;
    this.scrollMemory.set(this.memoryKey, pos);

    const pageChanged = pos.page !== this._lastPersistedPage;
    if (immediate || pageChanged) {
      if (this._scrollSaveTimer) {
        clearTimeout(this._scrollSaveTimer);
        this._scrollSaveTimer = null;
      }
      this._lastPersistedPage = pos.page;
      this._persistProgressMap();
      return;
    }

    if (this._scrollSaveTimer) clearTimeout(this._scrollSaveTimer);
    this._scrollSaveTimer = setTimeout(() => {
      this._scrollSaveTimer = null;
      this._lastPersistedPage = pos.page;
      this._persistProgressMap();
    }, 180);
  }

  flushProgress() {
    if (this._scrollSaveTimer) {
      clearTimeout(this._scrollSaveTimer);
      this._scrollSaveTimer = null;
    }
    if (this.memoryKey && this._pageSlots.length && !this._suppressScrollSave && !this._pendingRestorePos) {
      this._recordCurrentScroll({ immediate: true });
    }
  }

  clearProgress(historyKey = this.memoryKey) {
    if (!historyKey) return;
    if (this._scrollSaveTimer) {
      clearTimeout(this._scrollSaveTimer);
      this._scrollSaveTimer = null;
    }
    this.scrollMemory.delete(historyKey);
    clearSavedManualProgress(historyKey);
    if (historyKey === this.memoryKey) {
      this._pendingRestorePos = null;
      this._lastPersistedPage = 1;
      this.currentPage = 1;
    }
  }

  getSavedPage() {
    if (this._pendingRestorePos?.page) {
      return Math.max(1, Number(this._pendingRestorePos.page) || 1);
    }
    return Math.max(1, Number(this.currentPage) || 1);
  }

  _resolveInitialProgress(memoryKey, fallbackPage = 1) {
    const inMemory = memoryKey ? normalizeProgressEntry(this.scrollMemory.get(memoryKey)) : null;
    if (inMemory) return inMemory;
    const store = readManualHistoryStore();
    const stored = memoryKey ? normalizeProgressEntry(store[memoryKey]) : null;
    if (stored) {
      this.scrollMemory.set(memoryKey, stored);
      return stored;
    }
    const fallback = Number(fallbackPage);
    if (Number.isFinite(fallback) && fallback > 1) {
      return { page: Math.round(fallback), offsetRatio: 0, updatedAt: 0 };
    }
    return null;
  }

  _applyPendingRestore() {
    const pending = this._pendingRestorePos;
    if (!pending || !this.viewportEl || !this._pageSlots.length) return false;
    if ((this.viewportEl.clientHeight || 0) <= 0) return false;
    const applied = this._applyScrollPosition(pending);
    if (!applied) return false;
    this._pendingRestorePos = null;
    this._lastPersistedPage = this.currentPage;
    return true;
  }

  _loadSlot(slot, seq) {
    if (slot.loaded || slot.loading || typeof Image === "undefined") return;
    slot.loading = true;
    const img = new Image();
    img.className = "manual-page-img";
    img.alt = `Página ${slot.page}`;
    img.draggable = false;
    img.onload = () => {
      if (seq !== this._loadSeq) return;
      slot.loaded = true;
      slot.loading = false;
      slot.el.innerHTML = "";
      slot.el.classList.add("is-loaded");
      slot.el.appendChild(img);
    };
    img.onerror = () => {
      if (seq !== this._loadSeq) return;
      slot.loading = false;
    };
    img.src = this._buildPageUrl(slot.page);
  }

  _buildPageFeed(seq) {
    this._observer?.disconnect();
    this._observer = null;
    this._pageSlots = [];
    if (!this.pagesContainerEl) return;
    this.pagesContainerEl.innerHTML = "";

    const fragment = document.createDocumentFragment();
    for (let page = 1; page <= this.pageCount; page += 1) {
      const aspect = this.pageAspects[page - 1] || 0.85;
      const el = document.createElement("div");
      el.className = "manual-page-slot";
      el.style.aspectRatio = `1 / ${aspect}`;
      el.dataset.page = String(page);
      el.textContent = `Página ${page}`;
      fragment.appendChild(el);
      this._pageSlots.push({ page, el, loaded: false, loading: false });
    }
    this.pagesContainerEl.appendChild(fragment);

    if (typeof IntersectionObserver !== "undefined" && this.viewportEl) {
      this._observer = new IntersectionObserver(
        (entries) => {
          if (seq !== this._loadSeq) return;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const p = Number(entry.target.dataset.page || 0);
            const slot = this._pageSlots[p - 1];
            if (slot) this._loadSlot(slot, seq);
            // Pre-cargamos 1 página arriba/abajo para scroll sin parpadeos
            if (this._pageSlots[p]) this._loadSlot(this._pageSlots[p], seq);
            if (this._pageSlots[p - 2]) this._loadSlot(this._pageSlots[p - 2], seq);
          }
        },
        { root: this.viewportEl, rootMargin: "550px 0px" }
      );
      for (const slot of this._pageSlots) {
        this._observer.observe(slot.el);
      }
    } else {
      for (let i = 0; i < Math.min(3, this._pageSlots.length); i += 1) {
        this._loadSlot(this._pageSlots[i], seq);
      }
    }
  }

  async setSet(setNumber, sourcePdf = "", { historyKey = null, fallbackPage = 1 } = {}) {
    this.flushProgress();
    this.resetWidth();

    this.setNumber = setNumber || null;
    this.memoryKey = historyKey || this.setNumber || null;
    this.sourcePdf = sourcePdf || "";
    this.pageCount = 0;
    this.pageAspects = [];
    this.currentPage = 1;
    this.zoom = 1.0;
    this._lastPersistedPage = 0;
    this._pendingRestorePos = null;
    this._syncZoomUI();

    this._observer?.disconnect();
    this._observer = null;
    this._pageSlots = [];
    if (this.pagesContainerEl) this.pagesContainerEl.innerHTML = "";
    if (this.viewportEl) this.viewportEl.scrollTop = 0;
    if (this.pageIndicatorEl) this.pageIndicatorEl.textContent = "Pág. - / -";
    if (this.openPdfBtnEl) this.openPdfBtnEl.disabled = true;

    if (!this.setNumber) {
      this._setStatus("Sin manual activo.");
      return;
    }

    const seq = ++this._loadSeq;
    this._setStatus("Abriendo manual PDF...");
    try {
      const params = new URLSearchParams({
        set: this.setNumber,
        source: this.sourcePdf,
      });
      const resp = await fetch(`/api/manual/info?${params.toString()}`);
      const data = await resp.json();
      if (seq !== this._loadSeq) return;
      if (!resp.ok || !data.ok) {
        this._setStatus(data.error || "Manual PDF no encontrado en Sets/.", true);
        return;
      }
      if (this.openPdfBtnEl) this.openPdfBtnEl.disabled = false;
      this.pageCount = Math.max(1, Number(data.pageCount) || 1);
      this.pageAspects = Array.isArray(data.pageAspects) ? data.pageAspects : [];
      this._setStatus("");
      this._buildPageFeed(seq);

      const savedPos = this._resolveInitialProgress(this.memoryKey, fallbackPage);
      if (savedPos) {
        this._pendingRestorePos = savedPos;
      }
      const restore = () => {
        if (seq !== this._loadSeq || !this.viewportEl) return;
        if (!this._applyPendingRestore()) {
          this._updateVisiblePageIndicator();
        }
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(restore);
      } else {
        restore();
      }
    } catch {
      if (seq !== this._loadSeq) return;
      this._setStatus("No se pudo cargar el manual PDF.", true);
    }
  }
}
