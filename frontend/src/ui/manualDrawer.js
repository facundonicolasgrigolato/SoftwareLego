/**
 * Visor lateral izquierdo continuo para el manual PDF:
 * - Rueda del mouse: scroll fluido entre todas las páginas
 * - Ctrl + rueda: zoom continuo
 * - Click en cualquier parte del manual: oculta hacia la barrita vertical izquierda
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
    this.onOpenChanged = onOpenChanged || (() => {});

    this.setNumber = null;
    this.sourcePdf = "";
    this.pageCount = 0;
    this.pageAspects = [];
    this.currentPage = 1;
    this.zoom = 1.0;
    this.isOpen = false;
    this.scrollMemory = new Map();
    this._loadSeq = 0;
    this._observer = null;
    this._pointerDown = null;
    this._pageSlots = [];

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
          ev.preventDefault();
          const delta = ev.deltaY < 0 ? 0.2 : -0.2;
          this.setZoom(this.zoom + delta, ev);
        }
        // Sin Ctrl, el scroll nativo de #manual-viewport recorre continuamente todas las páginas
      },
      { passive: false }
    );

    this.viewportEl?.addEventListener("scroll", () => {
      if (this.setNumber) {
        this.scrollMemory.set(this.setNumber, this.viewportEl.scrollTop);
      }
      this._updateVisiblePageIndicator();
    });

    // Click en cualquier parte del visor oculta el manual; arrastrar desplaza la hoja sin cerrarlo
    this.drawerEl?.addEventListener("dragstart", (ev) => ev.preventDefault());

    this.drawerEl?.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target?.closest?.("button, a, input, select, textarea")) return;
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

    const finishPointer = (ev) => {
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
      this._pointerDown = null;
      this.viewportEl?.classList.remove("is-panning");
    });
  }

  setHudVisible(visible) {
    this.drawerEl?.classList.toggle("is-hud-hidden", !visible);
    this.tabEl?.classList.toggle("is-hud-hidden", !visible);
  }

  setOpen(open) {
    this.isOpen = Boolean(open);
    this._syncOpenState();
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

  _updateVisiblePageIndicator() {
    if (!this._pageSlots.length || !this.viewportEl || !this.pageIndicatorEl) return;
    const vpCenter = this.viewportEl.scrollTop + this.viewportEl.clientHeight * 0.4;
    let bestPage = 1;
    let bestDist = Infinity;
    for (const slot of this._pageSlots) {
      const top = slot.el.offsetTop;
      const mid = top + slot.el.offsetHeight * 0.5;
      const dist = Math.abs(mid - vpCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = slot.page;
      }
    }
    this.currentPage = bestPage;
    this.pageIndicatorEl.textContent = `Pág. ${bestPage} / ${this.pageCount}`;
  }

  _loadSlot(slot, seq) {
    if (slot.loaded || slot.loading) return;
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

  async setSet(setNumber, sourcePdf = "") {
    this.setNumber = setNumber || null;
    this.sourcePdf = sourcePdf || "";
    this.pageCount = 0;
    this.pageAspects = [];
    this.currentPage = 1;
    this.zoom = 1.0;
    this._syncZoomUI();

    this._observer?.disconnect();
    this._observer = null;
    this._pageSlots = [];
    if (this.pagesContainerEl) this.pagesContainerEl.innerHTML = "";
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

      const savedScroll = this.scrollMemory.get(this.setNumber) || 0;
      if (this.viewportEl) {
        requestAnimationFrame(() => {
          if (seq !== this._loadSeq || !this.viewportEl) return;
          this.viewportEl.scrollTop = savedScroll;
          this._updateVisiblePageIndicator();
        });
      }
    } catch {
      if (seq !== this._loadSeq) return;
      this._setStatus("No se pudo cargar el manual PDF.", true);
    }
  }
}
