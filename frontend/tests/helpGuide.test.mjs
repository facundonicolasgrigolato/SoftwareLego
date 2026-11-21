import assert from "node:assert/strict";
import test from "node:test";
import { HELP_PAGES, HelpGuide } from "../src/ui/helpGuide.js";
import { ManualDrawer } from "../src/ui/manualDrawer.js";

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
