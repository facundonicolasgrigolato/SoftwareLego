import assert from "node:assert/strict";
import test from "node:test";
import { RoomModal } from "../src/ui/roomModal.js";
import { StickerToolController } from "../src/ui/stickerToolController.js";
import { TrayPanel } from "../src/ui/trayPanel.js";
import { TraySettingsPopover } from "../src/ui/traySettingsPopover.js";

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...cls) => cls.forEach((c) => set.add(c)),
    remove: (...cls) => cls.forEach((c) => set.delete(c)),
    toggle: (c, force) => {
      const next = force === undefined ? !set.has(c) : Boolean(force);
      if (next) set.add(c);
      else set.delete(c);
      return next;
    },
    contains: (c) => set.has(c),
  };
}

function createFakeEl(initialClasses = [], tagName = "div") {
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    tagName: tagName.toUpperCase(),
    classList: createClassList(initialClasses),
    className: initialClasses.join(" "),
    children: [],
    style: {},
    dataset: {},
    disabled: false,
    checked: false,
    value: "",
    textContent: "",
    title: "",
    scrollLeft: 0,
    offsetHeight: 200,
    set innerHTML(val) {
      this._innerHTML = String(val);
      if (val === "") this.children = [];
    },
    get innerHTML() {
      return this._innerHTML || "";
    },
    appendChild(child) {
      if (child?.isFragment) {
        this.children.push(...child.children);
      } else {
        this.children.push(child);
      }
      return child;
    },
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) ?? null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(type, ev = {}) {
      const handlers = listeners.get(type) || [];
      const payload = {
        target: el,
        preventDefault() {},
        stopPropagation() {},
        ...ev,
      };
      for (const fn of handlers) fn(payload);
    },
    click() {
      this.dispatchEvent("click");
    },
    focus() {},
    select() {},
    blur() {},
    scrollBy() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 900, height: 600 };
    },
    getContext() {
      return {
        clearRect() {},
        drawImage() {},
      };
    },
    toDataURL() {
      return "data:image/png;base64,ZmFrZQ==";
    },
  };
  return el;
}

function installFakeDom(t) {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevStorage = globalThis.localStorage;
  const store = new Map();
  const winListeners = new Map();

  globalThis.document = {
    createElement: (tag) => createFakeEl([], tag),
    createDocumentFragment: () => ({
      isFragment: true,
      children: [],
      appendChild(c) {
        this.children.push(c);
        return c;
      },
    }),
  };
  globalThis.window = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  t.after(() => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.localStorage = prevStorage;
  });
}

test("TraySettingsPopover valida rango, advierte alta densidad y aplica cajas", (t) => {
  installFakeDom(t);
  const toasts = [];
  let customCount = null;
  let looseCount = 400;
  let lastAppliedManifest = null;
  const effectiveManifest = { bags: [{ bag_number: 1 }, { bag_number: 2 }], parts: [] };

  const bc = {
    manifest: { bags: [{ bag_number: 1 }] },
    get customBoxCount() {
      return customCount;
    },
    getDefaultBoxCount: () => 1,
    getEffectiveBoxCount: () => customCount ?? 1,
    getLoosePieceCount: () => looseCount,
    getEffectiveManifest: () => effectiveManifest,
    setCustomBoxCount(next) {
      customCount = next;
      return true;
    },
  };

  const popoverEl = createFakeEl(["hidden"]);
  const btnOpenEl = createFakeEl();
  const inputCountEl = createFakeEl([], "input");
  const warningEl = createFakeEl(["hidden"]);
  const warningTextEl = createFakeEl();
  const btnApplyEl = createFakeEl([], "button");
  const btnWarningConfirmEl = createFakeEl([], "button");
  const btnDefaultEl = createFakeEl([], "button");

  const pop = new TraySettingsPopover({
    popoverEl,
    btnOpenEl,
    btnCloseEl: createFakeEl([], "button"),
    summaryEl: createFakeEl(),
    inputCountEl,
    btnIncEl: createFakeEl([], "button"),
    btnDecEl: createFakeEl([], "button"),
    estimateEl: createFakeEl(),
    warningEl,
    warningTextEl,
    btnWarningCancelEl: createFakeEl([], "button"),
    btnWarningConfirmEl,
    btnDefaultEl,
    btnApplyEl,
    workspaceEl: createFakeEl(),
    getBuildController: () => bc,
    getRoomManager: () => ({ isGuest: () => false }),
    onApplied: (m) => {
      lastAppliedManifest = m;
    },
    showToast: (msg) => toasts.push(msg),
  });

  btnOpenEl.click();
  assert.equal(pop.isOpen(), true);
  assert.equal(inputCountEl.value, "1");

  // 400 / 2 = 200 piezas por caja (> 150) => muestra advertencia antes de aplicar
  inputCountEl.value = "2";
  btnApplyEl.click();
  assert.equal(warningEl.classList.contains("hidden"), false);
  assert.equal(customCount, null);

  btnWarningConfirmEl.click();
  assert.equal(customCount, 2);
  assert.equal(pop.isOpen(), false);
  assert.equal(lastAppliedManifest, effectiveManifest);
  assert.match(toasts.at(-1), /2 caja/);

  // Restaurar por defecto
  btnOpenEl.click();
  btnDefaultEl.click();
  assert.equal(customCount, null);
  assert.match(toasts.at(-1), /Por defecto|defecto/i);

  // Inválido fuera de 1..24
  looseCount = 10;
  btnOpenEl.click();
  inputCountEl.value = "99";
  btnApplyEl.click();
  assert.match(toasts.at(-1), /1 y 24/);
});

test("StickerToolController gestiona modo pegatina, popover y aplicación de imagen", async (t) => {
  installFakeDom(t);
  const prevFileReader = globalThis.FileReader;
  const prevImage = globalThis.Image;
  t.after(() => {
    globalThis.FileReader = prevFileReader;
    globalThis.Image = prevImage;
  });

  globalThis.FileReader = class FakeFileReader {
    readAsDataURL() {
      this.result = "data:image/png;base64,QUJD";
      this.onload?.();
    }
  };
  globalThis.Image = class FakeImage {
    set src(_v) {
      this.naturalWidth = 64;
      this.naturalHeight = 64;
      this.onload?.();
    }
  };

  let carryCancelled = false;
  let selectionCleared = false;
  let appliedArgs = null;
  const toasts = [];
  const bc = {
    carry: { elementId: "3001" },
    cancelCarry: () => {
      carryCancelled = true;
      bc.carry = null;
    },
    clearSelection: () => {
      selectionCleared = true;
    },
    applyStickerToPlacedPiece: (piece, placement, dataUrl) => {
      appliedArgs = { piece, placement, dataUrl };
    },
    _emitStatus() {},
  };

  const editorAppEl = createFakeEl();
  const btnToggleEl = createFakeEl([], "button");
  const popoverEl = createFakeEl(["hidden"]);
  const statusPillEl = createFakeEl(["hidden"]);
  const inputFileEl = createFakeEl([], "input");

  const controller = new StickerToolController({
    editorAppEl,
    btnToggleEl,
    popoverEl,
    btnCloseEl: createFakeEl([], "button"),
    btnPasteEl: createFakeEl([], "button"),
    inputFileEl,
    statusPillEl,
    viewportEl: createFakeEl(),
    getBuildController: () => bc,
    onBeforeEnterMode() {},
    showToast: (msg) => toasts.push(msg),
  });

  controller.setMode(true);
  assert.equal(controller.isActive(), true);
  assert.equal(carryCancelled, true);
  assert.equal(selectionCleared, true);
  assert.equal(editorAppEl.classList.contains("is-sticker-mode"), true);

  const piece = { instanceId: "p1" };
  const placement = { faceKey: "top" };
  controller.openPopover(piece, placement, 200, 150);
  assert.equal(controller.hasPendingTarget(), true);
  assert.equal(popoverEl.classList.contains("hidden"), false);

  await controller.applyBlob(new Blob(["fake"], { type: "image/png" }));
  assert.deepEqual(appliedArgs, {
    piece,
    placement,
    dataUrl: "data:image/png;base64,ZmFrZQ==",
  });
  assert.equal(controller.isActive(), false);
  assert.equal(controller.hasPendingTarget(), false);
  assert.match(toasts.at(-1), /Pegatina aplicada/);
});

test("TrayPanel filtra por texto, color, bolsa, favoritos y recientes", (t) => {
  installFakeDom(t);
  const selected = [];
  const remainingByElement = new Map([
    ["e1", 2],
    ["e2", 0],
    ["e3", 1],
  ]);

  const bc = {
    carry: null,
    placedPieces: [{ instanceId: "p1" }],
    getRemainingCount: (id) => remainingByElement.get(id) ?? 0,
    isPartFailed: () => false,
  };

  const listEl = createFakeEl();
  const searchEl = createFakeEl([], "input");
  const colorFilterEl = createFakeEl([], "select");
  const onlyAvailableEl = createFakeEl([], "input");
  const bagRowEl = createFakeEl(["hidden"]);
  const bagFilterEl = createFakeEl([], "select");
  const tabAll = createFakeEl(["is-active"], "button");
  tabAll.dataset.tab = "all";
  const tabFav = createFakeEl([], "button");
  tabFav.dataset.tab = "favorites";
  const tabRecent = createFakeEl([], "button");
  tabRecent.dataset.tab = "recent";

  const tray = new TrayPanel(
    {
      listEl,
      searchEl,
      colorFilterEl,
      onlyAvailableEl,
      bagRowEl,
      bagFilterEl,
      focusBagBtnEl: createFakeEl([], "button"),
      summaryEl: createFakeEl(),
      topProgressFillEl: createFakeEl(),
      tabCountEl: createFakeEl(),
      favCountEl: createFakeEl(),
      tabButtons: [tabAll, tabFav, tabRecent],
      prevBtnEl: createFakeEl([], "button"),
      nextBtnEl: createFakeEl([], "button"),
    },
    bc,
    (id) => selected.push(id)
  );

  tray.setManifest({
    bags: [
      { bag_number: 1, label: "Bolsa 1", piece_count: 2 },
      { bag_number: 2, label: "Bolsa 2", piece_count: 1 },
    ],
    parts: [
      {
        element_id: "e1",
        ldraw_part_id: "3001",
        part_name: "Brick 2x4",
        color_name: "Red",
        color_rgb: "#C91A09",
        quantity: 2,
        bag_counts: { 1: 2 },
      },
      {
        element_id: "e2",
        ldraw_part_id: "3003",
        part_name: "Brick 2x2",
        color_name: "Blue",
        color_rgb: "#0055BF",
        quantity: 1,
        bag_counts: { 1: 1 },
      },
      {
        element_id: "e3",
        ldraw_part_id: "3020",
        part_name: "Plate 2x4",
        color_name: "Red",
        color_rgb: "#C91A09",
        quantity: 1,
        bag_counts: { 2: 1 },
      },
    ],
  });

  assert.equal(bagRowEl.classList.contains("hidden"), false);
  assert.equal(listEl.children.length, 3);

  onlyAvailableEl.checked = true;
  onlyAvailableEl.dispatchEvent("change");
  assert.equal(listEl.children.length, 2);

  bagFilterEl.value = "2";
  bagFilterEl.dispatchEvent("change");
  assert.equal(listEl.children.length, 1);

  bagFilterEl.value = "";
  onlyAvailableEl.checked = false;
  tray.toggleFavorite("e2");
  tabFav.click();
  assert.equal(listEl.children.length, 1);

  tray.recordRecent("e3");
  tabRecent.click();
  assert.equal(listEl.children.length, 1);

  listEl.children[0].click();
  assert.deepEqual(selected, ["e3"]);
});

test("RoomModal muestra estado de sala, jugadores y dispara rename/kick/toggle", async (t) => {
  installFakeDom(t);
  const actions = [];
  const backdropEl = createFakeEl(["hidden"]);
  const toggleBtnEl = createFakeEl([], "button");
  const codeSectionEl = createFakeEl(["hidden"]);
  const codeTextEl = createFakeEl();
  const playersListEl = createFakeEl();

  const modal = new RoomModal(
    {
      backdropEl,
      closeBtnEl: createFakeEl([], "button"),
      statusBadgeEl: createFakeEl(),
      toggleBtnEl,
      codeSectionEl,
      codeTextEl,
      copyBtnEl: createFakeEl([], "button"),
      playersCountEl: createFakeEl(),
      playersListEl,
      hintEl: createFakeEl(),
    },
    {
      onOpenRoom: async () => actions.push("open"),
      onCloseRoom: async () => actions.push("close"),
      onRenamePlayer: (peerId, name) => actions.push(["rename", peerId, name]),
      onKickPlayer: (peerId) => actions.push(["kick", peerId]),
    }
  );

  modal.show();
  assert.equal(modal.isOpen(), true);
  assert.equal(codeSectionEl.classList.contains("hidden"), true);

  await toggleBtnEl.click();
  assert.deepEqual(actions[0], "open");

  modal.setState({
    mode: "open",
    roomCode: "4829104",
    players: [
      { peerId: "host-1", name: "Admin", color: "#38bdf8", isHost: true },
      { peerId: "guest-2", name: "Facu", color: "#22c55e", isHost: false },
    ],
  });
  assert.equal(codeSectionEl.classList.contains("hidden"), false);
  assert.equal(codeTextEl.textContent, "4829104");
  assert.equal(playersListEl.children.length, 2);

  const guestRow = playersListEl.children[1];
  const guestInput = guestRow.children[1];
  const kickBtn = guestRow.children[3];
  guestInput.value = "Facundo";
  guestInput.dispatchEvent("change");
  kickBtn.click();

  assert.deepEqual(actions.slice(1), [
    ["rename", "guest-2", "Facundo"],
    ["kick", "guest-2"],
  ]);
});
