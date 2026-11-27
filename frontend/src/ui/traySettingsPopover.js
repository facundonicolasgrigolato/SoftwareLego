const TRAY_WARNING_AVG_LIMIT = 150;

/**
 * Controla el popover de configuración personalizada de cajas (1..24) y advertencia de densidad.
 */
export class TraySettingsPopover {
  constructor({
    popoverEl,
    btnOpenEl,
    btnCloseEl,
    summaryEl,
    inputCountEl,
    btnIncEl,
    btnDecEl,
    estimateEl,
    warningEl,
    warningTextEl,
    btnWarningCancelEl,
    btnWarningConfirmEl,
    btnDefaultEl,
    btnApplyEl,
    workspaceEl,
    getBuildController,
    getRoomManager,
    onApplied,
    showToast,
  }) {
    this.popoverEl = popoverEl;
    this.btnOpenEl = btnOpenEl;
    this.btnCloseEl = btnCloseEl;
    this.summaryEl = summaryEl;
    this.inputCountEl = inputCountEl;
    this.btnIncEl = btnIncEl;
    this.btnDecEl = btnDecEl;
    this.estimateEl = estimateEl;
    this.warningEl = warningEl;
    this.warningTextEl = warningTextEl;
    this.btnWarningCancelEl = btnWarningCancelEl;
    this.btnWarningConfirmEl = btnWarningConfirmEl;
    this.btnDefaultEl = btnDefaultEl;
    this.btnApplyEl = btnApplyEl;
    this.workspaceEl = workspaceEl;
    this.getBuildController = getBuildController;
    this.getRoomManager = getRoomManager;
    this.onApplied = onApplied;
    this.showToast = showToast;
    this.pendingConfirmCount = null;

    this._bindEvents();
  }

  isOpen() {
    return Boolean(this.popoverEl && !this.popoverEl.classList.contains("hidden"));
  }

  refresh() {
    const bc = this.getBuildController();
    const isCustom = bc?.customBoxCount != null;
    const open = this.isOpen();
    this.btnOpenEl?.classList.toggle("is-on", open || isCustom);
    this.btnOpenEl?.setAttribute("aria-pressed", String(open));
    if (this.btnDefaultEl && bc) {
      const defCount = bc.getDefaultBoxCount();
      this.btnDefaultEl.textContent = `Por defecto (${defCount})`;
    }
  }

  hideWarning() {
    this.pendingConfirmCount = null;
    this.warningEl?.classList.add("hidden");
  }

  close() {
    this.hideWarning();
    this.popoverEl?.classList.add("hidden");
    this.refresh();
  }

  position() {
    if (!this.popoverEl || !this.btnOpenEl || !this.workspaceEl) return;
    const wsRect = this.workspaceEl.getBoundingClientRect();
    const btnRect = this.btnOpenEl.getBoundingClientRect();
    const popW = 304;
    const popH = this.popoverEl.offsetHeight || 220;
    const left = Math.max(
      12,
      Math.min(wsRect.width - popW - 12, btnRect.left - wsRect.left + btnRect.width / 2 - popW / 2)
    );
    const top = Math.max(12, btnRect.top - wsRect.top - popH - 12);
    this.popoverEl.style.left = `${Math.round(left)}px`;
    this.popoverEl.style.top = `${Math.round(top)}px`;
  }

  open() {
    const bc = this.getBuildController();
    const rm = this.getRoomManager();
    if (!this.popoverEl || rm?.isGuest() || !bc?.manifest) return;
    this.hideWarning();
    const looseCount = bc.getLoosePieceCount();
    const defCount = bc.getDefaultBoxCount();
    const curCount = bc.getEffectiveBoxCount();
    if (this.summaryEl) {
      this.summaryEl.textContent = `Piezas sueltas: ${looseCount} · Por defecto: ${defCount} caja(s)`;
    }
    if (this.inputCountEl) {
      this.inputCountEl.value = String(curCount);
    }
    this._updateEstimate();
    this.popoverEl.classList.remove("hidden");
    this.position();
    this.refresh();
    this.inputCountEl?.focus();
    this.inputCountEl?.select();
  }

  _updateEstimate() {
    const bc = this.getBuildController();
    if (!this.inputCountEl || !this.estimateEl || !bc) return;
    const raw = Math.round(Number(this.inputCountEl.value));
    const count = Number.isFinite(raw) ? Math.max(1, Math.min(24, raw)) : 1;
    const looseCount = bc.getLoosePieceCount();
    const approx = count > 0 ? Math.ceil(looseCount / count) : 0;
    this.estimateEl.textContent =
      looseCount > 0
        ? `Aprox. ${approx} pieza(s) por caja${approx > TRAY_WARNING_AVG_LIMIT ? " (muchas por caja)" : ""}`
        : "No hay piezas sueltas en este momento.";
  }

  _step(delta) {
    const bc = this.getBuildController();
    if (!this.inputCountEl || !bc) return;
    const raw = Math.round(Number(this.inputCountEl.value));
    const cur = Number.isFinite(raw) ? raw : bc.getEffectiveBoxCount();
    const next = Math.max(1, Math.min(24, cur + delta));
    this.inputCountEl.value = String(next);
    this.hideWarning();
    this._updateEstimate();
    this.position();
  }

  _commit(targetCount) {
    const bc = this.getBuildController();
    if (!bc?.setCustomBoxCount(targetCount)) return;
    this.close();
    this.onApplied?.(bc.getEffectiveManifest());
    if (targetCount == null) {
      this.showToast?.(`Cajas restauradas por defecto (${bc.getDefaultBoxCount()}).`);
    } else {
      this.showToast?.(`Piezas repartidas en ${targetCount} caja(s).`);
    }
  }

  _bindEvents() {
    this.btnOpenEl?.addEventListener("click", () => {
      if (this.getRoomManager()?.isGuest()) return;
      if (this.isOpen()) this.close();
      else this.open();
    });
    this.btnCloseEl?.addEventListener("click", () => this.close());
    this.inputCountEl?.addEventListener("input", () => {
      this.hideWarning();
      this._updateEstimate();
      this.position();
    });
    this.btnIncEl?.addEventListener("click", () => this._step(1));
    this.btnDecEl?.addEventListener("click", () => this._step(-1));
    this.inputCountEl?.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.btnApplyEl?.click();
      }
    });
    this.btnDefaultEl?.addEventListener("click", () => this._commit(null));
    this.btnApplyEl?.addEventListener("click", () => {
      const bc = this.getBuildController();
      const raw = Math.round(Number(this.inputCountEl?.value));
      if (!Number.isFinite(raw) || raw < 1 || raw > 24) {
        this.showToast?.("Ingresá un número de cajas entre 1 y 24.");
        return;
      }
      const looseCount = bc?.getLoosePieceCount() || 0;
      const approx = Math.ceil(looseCount / raw);
      if (looseCount > 0 && approx > TRAY_WARNING_AVG_LIMIT) {
        this.pendingConfirmCount = raw;
        if (this.warningTextEl) {
          this.warningTextEl.textContent = `¿Estás seguro? Tomar esta decisión haría que las cajas tengan aproximadamente ${approx} piezas cada una.`;
        }
        this.warningEl?.classList.remove("hidden");
        this.position();
        return;
      }
      this._commit(raw);
    });
    this.btnWarningCancelEl?.addEventListener("click", () => {
      this.hideWarning();
      this.position();
    });
    this.btnWarningConfirmEl?.addEventListener("click", () => {
      if (this.pendingConfirmCount != null) {
        this._commit(this.pendingConfirmCount);
      }
    });
  }
}
