import { fileToStickerDataUrl } from "../builder/stickerDecal.js";

/**
 * Controla el modo pegatina: selección de cara, popover de pegado/subida y portapapeles.
 */
export class StickerToolController {
  constructor({
    editorAppEl,
    btnToggleEl,
    popoverEl,
    btnCloseEl,
    btnPasteEl,
    inputFileEl,
    statusPillEl,
    viewportEl,
    getBuildController,
    onBeforeEnterMode,
    showToast,
  }) {
    this.editorAppEl = editorAppEl;
    this.btnToggleEl = btnToggleEl;
    this.popoverEl = popoverEl;
    this.btnCloseEl = btnCloseEl;
    this.btnPasteEl = btnPasteEl;
    this.inputFileEl = inputFileEl;
    this.statusPillEl = statusPillEl;
    this.viewportEl = viewportEl;
    this.getBuildController = getBuildController;
    this.onBeforeEnterMode = onBeforeEnterMode;
    this.showToast = showToast;
    this.stickerMode = false;
    this.pendingTarget = null; // { piece, placement }

    this._bindEvents();
  }

  isActive() {
    return this.stickerMode;
  }

  hasPendingTarget() {
    return Boolean(this.pendingTarget);
  }

  refreshStatusPill() {
    if (!this.stickerMode || !this.statusPillEl) return false;
    this.statusPillEl.textContent = this.pendingTarget
      ? "Pegá una imagen (Ctrl+V), subila o cerrá con ✕ / Esc"
      : "Modo pegatina: clic en una cara para pegar · clic en una pegatina para quitarla · Esc/Ctrl+Z cancelar";
    this.statusPillEl.classList.remove("hidden");
    return true;
  }

  closePopover() {
    this.pendingTarget = null;
    this.popoverEl?.classList.add("hidden");
    if (this.inputFileEl) this.inputFileEl.value = "";
  }

  setMode(enabled) {
    const bc = this.getBuildController();
    this.stickerMode = Boolean(enabled);
    this.editorAppEl?.classList.toggle("is-sticker-mode", this.stickerMode);
    this.btnToggleEl?.classList.toggle("is-on", this.stickerMode);
    this.btnToggleEl?.setAttribute("aria-pressed", String(this.stickerMode));

    if (!this.stickerMode) {
      this.closePopover();
      bc?._emitStatus?.();
      return;
    }

    if (bc?.carry) bc.cancelCarry();
    this.onBeforeEnterMode?.();
    bc?.clearSelection();
    this.refreshStatusPill();
  }

  openPopover(piece, placement, clientX, clientY) {
    this.pendingTarget = { piece, placement };
    if (!this.popoverEl || !this.viewportEl) return;
    const wrapRect = this.viewportEl.getBoundingClientRect();
    const popW = 282;
    const popH = 158;
    const rawLeft = clientX - wrapRect.left + 14;
    const rawTop = clientY - wrapRect.top + 14;
    const clampedLeft = Math.max(12, Math.min(rawLeft, Math.max(12, wrapRect.width - popW - 12)));
    const clampedTop = Math.max(58, Math.min(rawTop, Math.max(58, wrapRect.height - popH - 12)));
    this.popoverEl.style.left = `${clampedLeft}px`;
    this.popoverEl.style.top = `${clampedTop}px`;
    this.popoverEl.classList.remove("hidden");
    this.refreshStatusPill();
  }

  async applyBlob(blobOrFile) {
    const target = this.pendingTarget;
    const bc = this.getBuildController();
    if (!target || !blobOrFile || !bc) return;
    try {
      const dataUrl = await fileToStickerDataUrl(blobOrFile, 512);
      bc.applyStickerToPlacedPiece(target.piece, target.placement, dataUrl);
      this.setMode(false);
      this.showToast?.("Pegatina aplicada en esa cara (Ctrl+Z para deshacer).");
    } catch (err) {
      this.showToast?.(err?.message || "No se pudo aplicar la imagen.");
    }
  }

  _bindEvents() {
    this.btnCloseEl?.addEventListener("click", () => this.setMode(false));

    this.btnPasteEl?.addEventListener("click", async () => {
      if (!this.pendingTarget) return;
      if (!navigator.clipboard?.read) {
        this.showToast?.("Presioná Ctrl + V para pegar tu captura desde el portapapeles.");
        return;
      }
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith("image/"));
          if (imgType) {
            const blob = await item.getType(imgType);
            await this.applyBlob(blob);
            return;
          }
        }
        this.showToast?.("No hay ninguna imagen copiada en el portapapeles.");
      } catch {
        this.showToast?.("Presioná Ctrl + V para pegar la imagen o subila desde tu dispositivo.");
      }
    });

    this.inputFileEl?.addEventListener("change", async (ev) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      await this.applyBlob(file);
      ev.target.value = "";
    });

    window.addEventListener("paste", async (ev) => {
      if (!this.pendingTarget) return;
      const items = Array.from(ev.clipboardData?.items || []);
      const imageItem = items.find((it) => it.type.startsWith("image/"));
      if (!imageItem) return;
      ev.preventDefault();
      const file = imageItem.getAsFile();
      if (file) await this.applyBlob(file);
    });
  }
}
