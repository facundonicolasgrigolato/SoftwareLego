const FAV_STORAGE_KEY = "softwarelego_favorites_v1";

function loadFavoritesSet() {
  try {
    const raw = localStorage.getItem(FAV_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveFavoritesSet(favs) {
  try {
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...favs]));
  } catch {
    // ignore quota issues
  }
}

/**
 * Dock inferior horizontal de piezas con miniaturas 3D reales, pestañas
 * (Piezas / Favoritas / Recientes), buscador, filtro por color y por bolsa.
 */
export class TrayPanel {
  constructor(elements, buildController, onSelectPart) {
    this.listEl = elements.listEl;
    this.searchEl = elements.searchEl;
    this.colorFilterEl = elements.colorFilterEl;
    this.onlyAvailableEl = elements.onlyAvailableEl;
    this.bagRowEl = elements.bagRowEl;
    this.bagFilterEl = elements.bagFilterEl;
    this.focusBagBtnEl = elements.focusBagBtnEl;
    this.summaryEl = elements.summaryEl;
    this.topProgressFillEl = elements.topProgressFillEl;
    this.tabCountEl = elements.tabCountEl;
    this.favCountEl = elements.favCountEl;
    this.tabButtons = Array.from(elements.tabButtons || []);
    this.prevBtnEl = elements.prevBtnEl;
    this.nextBtnEl = elements.nextBtnEl;

    this.thumbnailRenderer = elements.thumbnailRenderer || null;
    this.buildController = buildController;
    this.onSelectPart = onSelectPart;
    this.onFocusBag = elements.onFocusBag || null;

    this.parts = [];
    this.bags = [];
    this.activeTab = "all"; // "all" | "favorites" | "recent"
    this.favorites = loadFavoritesSet();
    this.recentIds = [];

    this.searchEl.addEventListener("input", () => this.render());
    this.colorFilterEl?.addEventListener("change", () => this.render());
    this.onlyAvailableEl.addEventListener("change", () => this.render());
    this.bagFilterEl?.addEventListener("change", () => this.render());
    this.focusBagBtnEl?.addEventListener("click", () => {
      const val = this.bagFilterEl?.value;
      this.onFocusBag?.(val ? Number(val) : null);
    });

    for (const btn of this.tabButtons) {
      btn.addEventListener("click", () => {
        this.activeTab = btn.dataset.tab || "all";
        for (const other of this.tabButtons) {
          other.classList.toggle("is-active", other === btn);
        }
        this.render();
      });
    }

    this.prevBtnEl?.addEventListener("click", () => {
      this.listEl.scrollBy({ left: -340, behavior: "smooth" });
    });
    this.nextBtnEl?.addEventListener("click", () => {
      this.listEl.scrollBy({ left: 340, behavior: "smooth" });
    });

    this.listEl.addEventListener(
      "wheel",
      (ev) => {
        if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
          ev.preventDefault();
          this.listEl.scrollLeft += ev.deltaY;
        }
      },
      { passive: false }
    );
  }

  recordRecent(elementId) {
    if (!elementId) return;
    this.recentIds = [elementId, ...this.recentIds.filter((id) => id !== elementId)].slice(0, 24);
  }

  toggleFavorite(elementId) {
    if (this.favorites.has(elementId)) {
      this.favorites.delete(elementId);
    } else {
      this.favorites.add(elementId);
    }
    saveFavoritesSet(this.favorites);
    this.render();
  }

  setManifest(manifest) {
    this.parts = (manifest.parts || []).filter(
      (p) => p.status !== "unresolved" && p.ldraw_part_id
    );
    this.bags = Array.isArray(manifest.bags) ? manifest.bags : [];
    this.recentIds = [];

    if (this.colorFilterEl) {
      const colors = new Map();
      for (const part of this.parts) {
        if (part.color_name) {
          colors.set(part.color_name, part.color_rgb || "#94a3b8");
        }
      }

      this.colorFilterEl.innerHTML = `<option value="">Todos los colores</option>`;
      for (const colorName of [...colors.keys()].sort()) {
        const opt = document.createElement("option");
        opt.value = colorName;
        opt.textContent = colorName;
        this.colorFilterEl.appendChild(opt);
      }
    }

    if (this.bagFilterEl && this.bagRowEl) {
      this.bagFilterEl.innerHTML = `<option value="">Todas las bolsas (${this.bags.length || 1})</option>`;
      for (const bag of this.bags) {
        const opt = document.createElement("option");
        opt.value = String(bag.bag_number);
        opt.textContent = `${bag.label || `Bolsa ${bag.bag_number}`} (${bag.piece_count || 0})`;
        this.bagFilterEl.appendChild(opt);
      }
      this.bagRowEl.classList.toggle("hidden", this.bags.length <= 1);
    }

    this.render();
  }

  render() {
    const query = this.searchEl.value.trim().toLowerCase();
    const colorFilter = this.colorFilterEl?.value || "";
    const bagFilter = this.bagFilterEl?.value || "";
    const onlyAvailable = this.onlyAvailableEl.checked;
    const activeId = this.buildController.carry?.elementId || null;

    const totalRequired = this.parts.reduce((acc, p) => acc + p.quantity, 0);
    const totalPlaced = this.buildController.placedPieces.length;
    this.summaryEl.textContent = `${totalPlaced} / ${totalRequired} piezas`;
    if (this.topProgressFillEl) {
      const pct = totalRequired > 0 ? Math.min(100, Math.round((totalPlaced / totalRequired) * 100)) : 0;
      this.topProgressFillEl.style.width = `${pct}%`;
    }

    if (this.tabCountEl) {
      this.tabCountEl.textContent = String(totalRequired);
    }
    if (this.favCountEl) {
      const setFavCount = this.parts.filter((p) => this.favorites.has(p.element_id)).length;
      this.favCountEl.textContent = String(setFavCount);
    }

    const filtered = this.parts.filter((part) => {
      if (this.activeTab === "favorites" && !this.favorites.has(part.element_id)) {
        return false;
      }
      if (this.activeTab === "recent" && !this.recentIds.includes(part.element_id)) {
        return false;
      }
      const remaining = this.buildController.getRemainingCount(part.element_id);
      if (onlyAvailable && remaining <= 0) return false;
      if (colorFilter && part.color_name !== colorFilter) return false;
      if (bagFilter && !(part.bag_counts?.[bagFilter] > 0)) return false;
      if (query) {
        const hay = `${part.part_name || ""} ${part.part_num || ""} ${part.element_id} ${part.color_name || ""}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    if (this.activeTab === "recent") {
      filtered.sort(
        (a, b) => this.recentIds.indexOf(a.element_id) - this.recentIds.indexOf(b.element_id)
      );
    } else {
      filtered.sort((a, b) => {
        const remA = this.buildController.getRemainingCount(a.element_id) > 0 ? 0 : 1;
        const remB = this.buildController.getRemainingCount(b.element_id) > 0 ? 0 : 1;
        if (remA !== remB) return remA - remB;
        return (a.part_name || "").localeCompare(b.part_name || "");
      });
    }

    this.listEl.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "tray-empty";
      empty.textContent =
        this.activeTab === "favorites"
          ? "Todavía no marcaste piezas favoritas (usá ★ en cualquier tarjeta)."
          : this.activeTab === "recent"
            ? "Todavía no agarraste piezas en esta sesión."
            : "Sin piezas coincidentes.";
      this.listEl.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const part of filtered) {
      const remaining = this.buildController.getRemainingCount(part.element_id);
      const isFailed = Boolean(this.buildController.isPartFailed?.(part.element_id));
      const isFav = this.favorites.has(part.element_id);

      const card = document.createElement("div");
      card.role = "button";
      card.tabIndex = 0;
      card.className = "part-card";
      if (part.element_id === activeId) card.classList.add("is-active");
      if (remaining === 0) card.classList.add("is-depleted");
      if (isFailed) card.classList.add("is-failed");

      const bagKeys = Object.keys(part.bag_counts || {})
        .filter((k) => (part.bag_counts?.[k] || 0) > 0)
        .sort((a, b) => Number(a) - Number(b));
      const bagText =
        this.bags.length > 1 && bagKeys.length
          ? ` · Bolsa ${bagKeys.join(", ")}`
          : "";
      card.title = `${part.part_name || part.ldraw_part_id} (${part.color_name || ""}) · #${part.ldraw_part_id}${bagText}${isFailed ? " · Modelo 3D no disponible" : ""}`;

      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = `part-fav-btn${isFav ? " is-fav" : ""}`;
      favBtn.textContent = isFav ? "★" : "☆";
      favBtn.title = isFav ? "Quitar de favoritas" : "Guardar en favoritas";
      favBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.toggleFavorite(part.element_id);
      });

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "part-thumb-wrap";

      const cachedUrl = this.thumbnailRenderer?.getCached(part);
      if (cachedUrl) {
        const img = document.createElement("img");
        img.className = "part-thumb-img";
        img.src = cachedUrl;
        img.alt = part.part_name || part.ldraw_part_id;
        thumbWrap.appendChild(img);
      } else {
        const fallback = document.createElement("span");
        fallback.className = "color-swatch";
        fallback.style.backgroundColor = part.color_rgb || "#64748b";
        if (part.is_trans) fallback.classList.add("is-trans");
        thumbWrap.appendChild(fallback);

        if (this.thumbnailRenderer) {
          this.thumbnailRenderer.requestThumbnail(part).then((url) => {
            if (!url || !card.isConnected) return;
            thumbWrap.innerHTML = "";
            const img = document.createElement("img");
            img.className = "part-thumb-img";
            img.src = url;
            img.alt = part.part_name || part.ldraw_part_id;
            thumbWrap.appendChild(img);
          });
        }
      }

      const caption = document.createElement("div");
      caption.className = "part-caption";
      caption.textContent = part.part_name || `#${part.ldraw_part_id}`;

      const badge = document.createElement("span");
      badge.className = "part-qty";
      badge.textContent = isFailed ? "Error 3D" : `${remaining}x`;

      if (this.bags.length > 1 && bagKeys.length) {
        const bagBadge = document.createElement("span");
        bagBadge.className = "part-bag-badge";
        bagBadge.textContent = `B${bagKeys[0]}`;
        card.appendChild(bagBadge);
      }

      card.append(favBtn, thumbWrap, caption, badge);

      const activate = () => {
        if (remaining > 0) {
          this.recordRecent(part.element_id);
          this.onSelectPart(part.element_id);
        }
      };
      card.addEventListener("click", activate);
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          activate();
        }
      });

      fragment.appendChild(card);
    }

    this.listEl.appendChild(fragment);
  }
}
