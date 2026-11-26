import assert from "node:assert/strict";
import test from "node:test";
import { HELP_PAGES, HelpGuide } from "../src/ui/helpGuide.js";
import {
  MANUAL_MAX_WIDTH,
  MANUAL_MIN_WIDTH,
  ManualDrawer,
  buildManualHistoryKey,
} from "../src/ui/manualDrawer.js";

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

function createFakeEl(initialClasses = []) {
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    classList: createClassList(initialClasses),
    children: [],
    style: {},
    disabled: false,
    textContent: "",
    title: "",
    scrollTop: 0,
    set innerHTML(val) {
      this._innerHTML = String(val);
      if (val === "") this.children = [];
    },
    get innerHTML() {
      return this._innerHTML || "";
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(type, ev = {}) {
      const payload = { target: el, ...ev };
      for (const fn of listeners.get(type) || []) fn(payload);
    },
    click() {
      for (const fn of listeners.get("click") || []) fn({ target: el });
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) ?? null;
    },
  };
  return el;
}

test("HELP_PAGES renderiza todas las páginas sin NaN, Infinity ni undefined", () => {
  assert.ok(HELP_PAGES.length >= 8);
  for (const page of HELP_PAGES) {
    assert.ok(page.title && page.icon);
    const html = page.render();
    assert.equal(typeof html, "string");
    assert.ok(html.length > 80, `Página vacía: ${page.title}`);
    assert.equal(/\bNaN\b|\bInfinity\b|\bundefined\b/.test(html), false, `Token inválido en ${page.title}`);
    assert.match(html, /<svg\b|<img\b|hg-save-list/, `Se esperaba contenido visual en ${page.title}`);
  }
});

test("HelpGuide oculta la flecha izquierda en pág. 1, muestra ambas en el medio y oculta la derecha en la última", () => {
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: () => createFakeEl(),
  };
  try {
    const titleEl = createFakeEl();
    const kickerEl = createFakeEl();
    const bodyEl = createFakeEl();
    const dotsEl = createFakeEl();
    const prevBtnEl = createFakeEl(["is-hidden"]);
    const nextBtnEl = createFakeEl();
    const closeBtnEl = createFakeEl();
    const finishBtnEl = createFakeEl(["hidden"]);
    const map = new Map([
      ["#help-guide-title", titleEl],
      ["#help-guide-kicker", kickerEl],
      ["#help-guide-body", bodyEl],
      ["#help-guide-dots", dotsEl],
      ["#btn-help-prev", prevBtnEl],
      ["#btn-help-next", nextBtnEl],
      ["#btn-close-help", closeBtnEl],
      ["#btn-help-finish", finishBtnEl],
    ]);
    const rootEl = createFakeEl(["hidden"]);
    rootEl.querySelector = (sel) => map.get(sel) || null;

    let openChanges = [];
    const guide = new HelpGuide(rootEl, {
      onOpenChanged: (v) => openChanges.push(v),
    });

    assert.equal(guide.isOpen(), false);
    assert.equal(dotsEl.children.length, HELP_PAGES.length);

    // Página 1 (primera)
    guide.open(0);
    assert.equal(guide.isOpen(), true);
    assert.deepEqual(openChanges, [true]);
    assert.equal(prevBtnEl.classList.contains("is-hidden"), true);
    assert.equal(prevBtnEl.disabled, true);
    assert.equal(nextBtnEl.classList.contains("is-hidden"), false);
    assert.equal(nextBtnEl.disabled, false);
    assert.equal(finishBtnEl.classList.contains("hidden"), true);

    // Página intermedia
    nextBtnEl.click();
    assert.equal(guide.index, 1);
    assert.equal(prevBtnEl.classList.contains("is-hidden"), false);
    assert.equal(prevBtnEl.disabled, false);
    assert.equal(nextBtnEl.classList.contains("is-hidden"), false);
    assert.equal(nextBtnEl.disabled, false);
    assert.equal(finishBtnEl.classList.contains("hidden"), true);

    // Última página
    guide.goTo(HELP_PAGES.length - 1);
    assert.equal(prevBtnEl.classList.contains("is-hidden"), false);
    assert.equal(prevBtnEl.disabled, false);
    assert.equal(nextBtnEl.classList.contains("is-hidden"), true);
    assert.equal(nextBtnEl.disabled, true);
    assert.equal(finishBtnEl.classList.contains("hidden"), false);

    // Atajos de teclado
    let prevented = false;
    assert.equal(
      guide.handleKey({ key: "ArrowLeft", preventDefault: () => { prevented = true; } }),
      true
    );
    assert.equal(prevented, true);
    assert.equal(guide.index, HELP_PAGES.length - 2);

    assert.equal(
      guide.handleKey({ key: "Escape", preventDefault: () => {} }),
      true
    );
    assert.equal(guide.isOpen(), false);
    assert.deepEqual(openChanges, [true, false]);
  } finally {
    globalThis.document = prevDoc;
  }
});

test("ManualDrawer arranca cerrado por defecto al iniciar", () => {
  const prevWin = globalThis.window;
  globalThis.window = { addEventListener: () => {} };
  try {
    const drawerEl = createFakeEl();
    const tabEl = createFakeEl(["hidden"]);
    const drawer = new ManualDrawer({ drawerEl, tabEl });
    assert.equal(drawer.isOpen, false);
    assert.equal(drawerEl.classList.contains("is-collapsed"), true);
    assert.equal(tabEl.classList.contains("hidden"), false);
  } finally {
    globalThis.window = prevWin;
  }
});

test("ManualDrawer oculta con click pero NO al arrastrar, soltar rápido o usar scrollbars", () => {
  const prevWin = globalThis.window;
  const winListeners = new Map();
  globalThis.window = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };
  const emitWin = (type, ev) => {
    const payload = { type, ...ev };
    for (const fn of winListeners.get(type) || []) fn(payload);
  };
  try {
    const drawerEl = createFakeEl();
    const tabEl = createFakeEl(["hidden"]);
    const viewportEl = createFakeEl();
    viewportEl.scrollLeft = 0;
    viewportEl.scrollTop = 50;
    viewportEl.clientWidth = 320;
    viewportEl.clientHeight = 400;
    viewportEl.scrollWidth = 640;
    viewportEl.scrollHeight = 1200;
    viewportEl.getBoundingClientRect = () => ({ left: 14, top: 64, width: 336, height: 416 });

    const drawer = new ManualDrawer({ drawerEl, tabEl, viewportEl });
    drawer.zoom = 1.6;
    drawer.setOpen(true);

    // 1. Arrastrar sobre el PDF y soltar (incluso volviendo cerca del inicio) NO cierra
    drawerEl.dispatchEvent("pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 150 });
    emitWin("pointermove", { pointerId: 1, clientX: 70, clientY: 120 });
    emitWin("pointermove", { pointerId: 1, clientX: 99, clientY: 149 });
    emitWin("pointerup", { button: 0, pointerId: 1, clientX: 99, clientY: 149 });
    assert.equal(drawer.isOpen, true);

    // 2. Arrastre rápido sin pointermove intermedio (pointerup desplazado >= 4px) NO cierra
    drawerEl.dispatchEvent("pointerdown", { button: 0, pointerId: 2, clientX: 100, clientY: 150 });
    emitWin("pointerup", { button: 0, pointerId: 2, clientX: 112, clientY: 150 });
    assert.equal(drawer.isOpen, true);

    // 3. Arrastrar barra de scroll horizontal (parte inferior) NO cierra
    drawerEl.dispatchEvent("pointerdown", {
      target: viewportEl,
      button: 0,
      pointerId: 3,
      clientX: 150,
      clientY: 64 + 408,
    });
    emitWin("pointerup", { button: 0, pointerId: 3, clientX: 150, clientY: 64 + 408 });
    assert.equal(drawer.isOpen, true);

    // 4. Si el viewport scrolleó mientras el botón estaba presionado, NO cierra
    drawerEl.dispatchEvent("pointerdown", { button: 0, pointerId: 4, clientX: 100, clientY: 150 });
    viewportEl.scrollTop = 90;
    emitWin("pointerup", { button: 0, pointerId: 4, clientX: 100, clientY: 150 });
    assert.equal(drawer.isOpen, true);

    // 5. Click limpio sin movimiento SÍ oculta el manual
    drawerEl.dispatchEvent("pointerdown", { button: 0, pointerId: 5, clientX: 100, clientY: 150 });
    emitWin("pointerup", { button: 0, pointerId: 5, clientX: 100, clientY: 150 });
    assert.equal(drawer.isOpen, false);
  } finally {
    globalThis.window = prevWin;
  }
});

test("ManualDrawer redimensiona en horizontal con límites min/max, sin cerrar y de forma temporal", async () => {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevFetch = globalThis.fetch;
  const winListeners = new Map();
  globalThis.window = {
    innerWidth: 1920,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
  };
  const emitWin = (type, ev) => {
    const payload = { type, ...ev };
    for (const fn of winListeners.get(type) || []) fn(payload);
  };
  globalThis.document = {
    body: { style: {} },
    createDocumentFragment: () => createFakeEl(),
    createElement: () => createFakeEl(),
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: true, pageCount: 4, pageAspects: [0.85, 0.85, 0.85, 0.85] }),
  });

  try {
    const drawerEl = createFakeEl();
    let currentWidth = 368;
    drawerEl.getBoundingClientRect = () => ({ left: 14, top: 64, width: currentWidth, height: 500 });
    Object.defineProperty(drawerEl.style, "width", {
      get: () => (currentWidth === 368 && drawerEl._customWidth === "" ? "" : drawerEl._customWidth ?? ""),
      set: (val) => {
        drawerEl._customWidth = val;
        if (val) currentWidth = parseFloat(val);
        else currentWidth = 368;
      },
    });
    const tabEl = createFakeEl(["hidden"]);
    const viewportEl = createFakeEl();
    viewportEl.clientHeight = 500;
    const pagesContainerEl = createFakeEl();
    const pageIndicatorEl = createFakeEl();
    const resizeHandleEl = createFakeEl();

    const drawer = new ManualDrawer({
      drawerEl,
      tabEl,
      viewportEl,
      pagesContainerEl,
      pageIndicatorEl,
      resizeHandleEl,
    });
    drawer.setOpen(true);

    // Arrastrar borde derecho hacia la derecha (+600px) -> limitado a MANUAL_MAX_WIDTH (760px)
    resizeHandleEl.dispatchEvent("pointerdown", { button: 0, pointerId: 9, clientX: 382 });
    emitWin("pointermove", { pointerId: 9, clientX: 982 });
    assert.equal(drawerEl.style.width, `${MANUAL_MAX_WIDTH}px`);
    assert.equal(drawerEl.classList.contains("is-resizing"), true);

    // Arrastrar hacia la izquierda (-900px) -> limitado a MANUAL_MIN_WIDTH (260px)
    emitWin("pointermove", { pointerId: 9, clientX: -100 });
    assert.equal(drawerEl.style.width, `${MANUAL_MIN_WIDTH}px`);

    // Arrastrar a un ancho válido intermedio (520px) y soltar: NO debe cerrar el manual
    emitWin("pointermove", { pointerId: 9, clientX: 382 + (520 - 368) });
    emitWin("pointerup", { button: 0, pointerId: 9, clientX: 382 + (520 - 368) });
    assert.equal(drawerEl.style.width, "520px");
    assert.equal(drawerEl.classList.contains("is-resizing"), false);
    assert.equal(drawer.isOpen, true);

    // Al volver a entrar a un set, el ancho temporal se resetea al valor por defecto
    await drawer.setSet("77237", "", { historyKey: buildManualHistoryKey("77237", 1) });
    assert.equal(drawerEl.style.width, "");
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.fetch = prevFetch;
  }
});

test("ManualDrawer guarda y restaura la página del historial por set/slot entre sesiones", async () => {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const prevFetch = globalThis.fetch;
  const prevStorage = globalThis.localStorage;

  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const makeMockEnv = () => {
    const winListeners = new Map();
    globalThis.window = {
      innerWidth: 1440,
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(fn);
      },
    };
    globalThis.document = {
      body: { style: {} },
      createDocumentFragment() {
        const frag = {
          children: [],
          appendChild(child) {
            this.children.push(child);
            return child;
          },
        };
        return frag;
      },
      createElement: () => {
        const el = createFakeEl();
        el.dataset = {};
        el.offsetHeight = 300;
        return el;
      },
    };
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        pageCount: 128,
        pageAspects: Array.from({ length: 128 }, () => 0.85),
      }),
    });

    const drawerEl = createFakeEl();
    const tabEl = createFakeEl(["hidden"]);
    const viewportEl = createFakeEl();
    viewportEl.clientHeight = 500;
    const pagesContainerEl = createFakeEl();
    pagesContainerEl.appendChild = (frag) => {
      const list = frag.children || [frag];
      list.forEach((child, idx) => {
        child.offsetTop = idx * 310;
        child.offsetHeight = 300;
        pagesContainerEl.children.push(child);
      });
      return frag;
    };
    const pageIndicatorEl = createFakeEl();
    const drawer = new ManualDrawer({ drawerEl, tabEl, viewportEl, pagesContainerEl, pageIndicatorEl });
    return { drawer, viewportEl, pageIndicatorEl };
  };

  try {
    // Sesión 1: entrar al Set 77237 Slot 1 y navegar hasta la página 93
    const s1 = makeMockEnv();
    const slot1Key = buildManualHistoryKey("77237", 1);
    await s1.drawer.setSet("77237", "", { historyKey: slot1Key });
    s1.viewportEl.scrollTop = 92 * 310 + 40;
    s1.viewportEl.dispatchEvent("scroll");
    s1.drawer.flushProgress();
    assert.equal(s1.drawer.currentPage, 93);
    assert.equal(s1.pageIndicatorEl.textContent, "Pág. 93 / 128");

    // Sesión 2 (nueva instancia tras salir y volver a entrar): restaura página 93
    const s2 = makeMockEnv();
    await s2.drawer.setSet("77237", "", { historyKey: slot1Key });
    assert.equal(s2.drawer.currentPage, 93);
    assert.equal(s2.pageIndicatorEl.textContent, "Pág. 93 / 128");
    assert.ok(s2.viewportEl.scrollTop >= 92 * 310);

    // Slot 2 del mismo set arranca independiente (pág. 1 si no tiene historial, o fallbackPage del save)
    const slot2Key = buildManualHistoryKey("77237", 2);
    await s2.drawer.setSet("77237", "", { historyKey: slot2Key });
    assert.equal(s2.drawer.currentPage, 1);

    // Al borrar progreso de Slot 1 vuelve a página 1
    s2.drawer.clearProgress(slot1Key);
    await s2.drawer.setSet("77237", "", { historyKey: slot1Key });
    assert.equal(s2.drawer.currentPage, 1);
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
    globalThis.fetch = prevFetch;
    globalThis.localStorage = prevStorage;
  }
});
