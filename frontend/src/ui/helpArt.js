/**
 * Ilustraciones vectoriales para la Guía de ayuda.
 * Todo se genera como SVG inline (sin imágenes externas): funciona offline y se ve nítido a cualquier tamaño.
 *
 * - `isoScene`: escena isométrica con ladrillos estilo LEGO (studs reales, rotaciones de 90°, fantasmas, flechas 3D).
 * - `mouseIcon`: mouse con el botón a usar resaltado y la dirección de arrastre.
 * - Diagramas 2D vistos desde arriba para grilla, giro y ajuste fino.
 */

export const LEGO = {
  red: "#c91a09",
  blue: "#0a5fd1",
  yellow: "#f2cd37",
  green: "#237841",
  tan: "#e4cd9e",
  gray: "#a0a5a9",
  white: "#f2f3f4",
  orange: "#fe8a18",
  brown: "#7a4a24",
  ghostRed: "#ef4444",
};

export const ACCENT = "#38bdf8";
const AXIS_COLORS = { x: "#f87171", y: "#4ade80", z: "#60a5fa" };
const EDGE = "rgba(8, 12, 22, 0.78)";
const COS30 = Math.cos(Math.PI / 6);

/* ------------------------------------------------------------------ */
/* Utilidades de color y vectores                                      */
/* ------------------------------------------------------------------ */

function hexToRgb(hex) {
  let h = String(hex).replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function shade(hex, f) {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c) => (f >= 0 ? Math.round(c + (255 - c) * f) : Math.round(c * (1 + f)));
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const round6 = (v) => Math.round(v * 1e6) / 1e6;

function rotMatrix(axis, deg) {
  const t = (deg * Math.PI) / 180;
  const c = round6(Math.cos(t));
  const s = round6(Math.sin(t));
  if (axis === "x") return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === "y") return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

function mulMat(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

function applyMat(m, v) {
  return [
    round6(m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2]),
    round6(m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2]),
    round6(m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]),
  ];
}

function project(p) {
  return [(p[0] - p[2]) * COS30, (p[0] + p[2]) * 0.5 - p[1]];
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();
const ptsAttr = (pts) => pts.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(" ");

/* ------------------------------------------------------------------ */
/* Escena isométrica                                                   */
/* ------------------------------------------------------------------ */

class Bounds {
  constructor() {
    this.minX = Infinity;
    this.minY = Infinity;
    this.maxX = -Infinity;
    this.maxY = -Infinity;
  }
  add([x, y]) {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }
}

/** Normal "visible" desde la cámara isométrica (+X derecha, +Z izquierda, +Y arriba). */
function faceShadeForNormal(n) {
  if (n[1] > 0.5) return 0.26;
  if (n[2] > 0.5) return 0.0;
  if (n[0] > 0.5) return -0.24;
  return null;
}

function perpAxes(n) {
  if (Math.abs(n[1]) > 0.5) return [[1, 0, 0], [0, 0, 1]];
  if (Math.abs(n[0]) > 0.5) return [[0, 1, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, 1, 0]];
}

/**
 * Construye un ladrillo/placa/caja alineado a ejes.
 * - `w`, `d`: studs en X y Z · `h`: alto en LDU (24 ladrillo, 8 placa)
 * - `size`: [sx, sy, sz] en LDU para cajas libres (sin studs por defecto)
 * - `rot`: lista de rotaciones [["x"|"y"|"z", grados], ...] alrededor del centro
 * - `at`: esquina mínima final en LDU
 */
function buildBrick(o) {
  const sx = o.size ? o.size[0] : (o.w ?? 2) * 20;
  const sy = o.size ? o.size[1] : o.h ?? 24;
  const sz = o.size ? o.size[2] : (o.d ?? 4) * 20;
  const center = [sx / 2, sy / 2, sz / 2];

  let m = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const [axis, deg] of o.rot || []) m = mulMat(rotMatrix(axis, deg), m);
  const tf = (p) => applyMat(m, sub(p, center));

  const rawCorners = [];
  for (const x of [0, sx]) for (const y of [0, sy]) for (const z of [0, sz]) rawCorners.push(tf([x, y, z]));
  const rMin = [0, 1, 2].map((i) => Math.min(...rawCorners.map((c) => c[i])));
  const rMax = [0, 1, 2].map((i) => Math.max(...rawCorners.map((c) => c[i])));
  const at = o.at || [0, 0, 0];
  const off = sub(at, rMin);
  const T = (p) => add(tf(p), off);

  const studs = [];
  const wantStuds = o.studs ?? !o.size;
  if (wantStuds) {
    const nTop = applyMat(m, [0, 1, 0]);
    const cols = Math.round(sx / 20);
    const rows = Math.round(sz / 20);
    for (let i = 0; i < cols; i += 1) {
      for (let j = 0; j < rows; j += 1) {
        studs.push({ c: T([20 * i + 10, sy, 20 * j + 10]), n: nTop });
      }
    }
  }
  for (const es of o.extraStuds || []) {
    studs.push({ c: T(es.p), n: applyMat(m, es.n) });
  }

  return {
    min: at,
    max: add(at, sub(rMax, rMin)),
    studs,
    color: o.color || LEGO.red,
    ghost: Boolean(o.ghost),
    outline: Boolean(o.outline),
    highlightFace: o.highlightFace || null,
    sticker: o.sticker || null,
    opacity: o.opacity ?? null,
  };
}

function faceQuad(b, face) {
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  if (face === "+y") return [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  if (face === "+x") return [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]];
  return [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
}

/** Mapea coordenadas (u, v) en [0..1] de una cara visible a 3D. */
function facePoint(b, face, u, v) {
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  if (face === "+y") return [x0 + (x1 - x0) * u, y1, z0 + (z1 - z0) * v];
  if (face === "+x") return [x1, y1 - (y1 - y0) * v, z1 - (z1 - z0) * u];
  return [x0 + (x1 - x0) * u, y1 - (y1 - y0) * v, z1];
}

function renderStud(s, color, bounds) {
  const faceShade = faceShadeForNormal(s.n);
  if (faceShade === null) return "";
  const [u, v] = perpAxes(s.n);
  const r = 6;
  const h = 4.5;
  const base = [];
  const top = [];
  for (let k = 0; k < 28; k += 1) {
    const a = (2 * Math.PI * k) / 28;
    const p = add(s.c, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
    base.push(project(p));
    top.push(project(add(p, scale(s.n, h))));
  }
  const hull = convexHull(base.concat(top));
  hull.forEach((p) => bounds.add(p));
  const sideShade = s.n[1] > 0.5 ? -0.08 : faceShade - 0.16;
  return (
    `<polygon points="${ptsAttr(hull)}" fill="${shade(color, sideShade)}" stroke="${EDGE}" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
    `<polygon points="${ptsAttr(top)}" fill="${shade(color, faceShade + 0.06)}" stroke="${EDGE}" stroke-width="1" vector-effect="non-scaling-stroke"/>`
  );
}

function renderSticker(b, bounds) {
  const st = b.sticker;
  const face = st.face || "+z";
  const inset = 0.14;
  const quad = [
    facePoint(b, face, inset, inset),
    facePoint(b, face, 1 - inset, inset),
    facePoint(b, face, 1 - inset, 1 - inset),
    facePoint(b, face, inset, 1 - inset),
  ].map(project);
  quad.forEach((p) => bounds.add(p));
  const circle = (cu, cv, r, fill) => {
    const pts = [];
    for (let k = 0; k < 20; k += 1) {
      const a = (2 * Math.PI * k) / 20;
      pts.push(project(facePoint(b, face, cu + r * Math.cos(a) * 0.55, cv + r * Math.sin(a))));
    }
    return `<polygon points="${ptsAttr(pts)}" fill="${fill}"/>`;
  };
  const mouth = [];
  for (let k = 0; k <= 12; k += 1) {
    const a = Math.PI * 0.15 + (Math.PI * 0.7 * k) / 12;
    mouth.push(project(facePoint(b, face, 0.5 + 0.2 * Math.cos(a), 0.52 + 0.17 * Math.sin(a))));
  }
  return (
    `<polygon points="${ptsAttr(quad)}" fill="${st.fill || "#fde047"}" stroke="#ffffff" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` +
    circle(0.38, 0.38, 0.06, "#1f2937") +
    circle(0.62, 0.38, 0.06, "#1f2937") +
    `<polyline points="${ptsAttr(mouth)}" fill="none" stroke="#1f2937" stroke-width="2.2" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
  );
}

function renderBrick(o, bounds) {
  const b = buildBrick(o);
  const color = b.color;
  const faces = ["+z", "+x", "+y"].map((face) => {
    const quad = faceQuad(b, face).map(project);
    quad.forEach((p) => bounds.add(p));
    const f = face === "+y" ? 0.26 : face === "+z" ? 0 : -0.24;
    return `<polygon points="${ptsAttr(quad)}" fill="${shade(color, f)}" stroke="${EDGE}" stroke-width="1.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  });

  let hl = "";
  if (b.highlightFace) {
    const quad = faceQuad(b, b.highlightFace).map(project);
    hl = `<polygon points="${ptsAttr(quad)}" fill="rgba(56,189,248,0.38)" stroke="${ACCENT}" stroke-width="2.4" vector-effect="non-scaling-stroke"/>`;
  }

  const studs = b.studs
    .filter((s) => faceShadeForNormal(s.n) !== null)
    .sort((a, c) => a.c[0] + a.c[1] + a.c[2] - (c.c[0] + c.c[1] + c.c[2]))
    .map((s) => renderStud(s, color, bounds))
    .join("");

  const sticker = b.sticker ? renderSticker(b, bounds) : "";

  let outline = "";
  if (b.outline) {
    const e = 3;
    const [x0, y0, z0] = sub(b.min, [e, e, e]);
    const [x1, y1, z1] = add(b.max, [e, e + 5, e]);
    const c = (x, y, z) => project([x, y, z]);
    const edges = [
      [c(x0, y0, z0), c(x1, y0, z0)], [c(x1, y0, z0), c(x1, y0, z1)], [c(x1, y0, z1), c(x0, y0, z1)], [c(x0, y0, z1), c(x0, y0, z0)],
      [c(x0, y1, z0), c(x1, y1, z0)], [c(x1, y1, z0), c(x1, y1, z1)], [c(x1, y1, z1), c(x0, y1, z1)], [c(x0, y1, z1), c(x0, y1, z0)],
      [c(x0, y0, z0), c(x0, y1, z0)], [c(x1, y0, z0), c(x1, y1, z0)], [c(x1, y0, z1), c(x1, y1, z1)], [c(x0, y0, z1), c(x0, y1, z1)],
    ];
    edges.forEach(([a, z]) => {
      bounds.add(a);
      bounds.add(z);
    });
    outline = edges
      .map(([a, z]) => `<line x1="${fmt(a[0])}" y1="${fmt(a[1])}" x2="${fmt(z[0])}" y2="${fmt(z[1])}" stroke="${ACCENT}" stroke-width="2" vector-effect="non-scaling-stroke"/>`)
      .join("");
  }

  const body = faces.join("") + hl + studs + sticker;
  if (b.ghost) {
    return `<g opacity="${b.opacity ?? 0.5}" stroke-dasharray="5 3">${body}</g>${outline}`;
  }
  if (b.opacity !== null) {
    return `<g opacity="${b.opacity}">${body}</g>${outline}`;
  }
  return body + outline;
}

function arrowHead2d(tip, from, color, size) {
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip[0] - ux * size;
  const by = tip[1] - uy * size;
  const px = -uy * size * 0.55;
  const py = ux * size * 0.55;
  return `<polygon points="${fmt(tip[0])},${fmt(tip[1])} ${fmt(bx + px)},${fmt(by + py)} ${fmt(bx - px)},${fmt(by - py)}" fill="${color}"/>`;
}

function renderArrow3d(o, bounds) {
  const a = project(o.from);
  const b = project(o.to);
  bounds.add(a);
  bounds.add(b);
  const color = o.color || ACCENT;
  const size = o.head ?? 11;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const end = [b[0] - (dx / len) * size * 0.6, b[1] - (dy / len) * size * 0.6];
  let svg = `<line x1="${fmt(a[0])}" y1="${fmt(a[1])}" x2="${fmt(end[0])}" y2="${fmt(end[1])}" stroke="${color}" stroke-width="${o.width ?? 3}" stroke-linecap="round" ${o.dashed ? 'stroke-dasharray="6 5"' : ""} vector-effect="non-scaling-stroke"/>`;
  svg += arrowHead2d(b, a, color, size);
  if (o.both) svg += arrowHead2d(a, b, color, size);
  return svg;
}

function renderAxis(o, bounds) {
  const color = AXIS_COLORS[o.axis];
  const dir = o.axis === "x" ? [1, 0, 0] : o.axis === "y" ? [0, 1, 0] : [0, 0, 1];
  const half = o.length / 2;
  const a = project(add(o.center, scale(dir, -half)));
  const b = project(add(o.center, scale(dir, half)));
  bounds.add(a);
  bounds.add(b);
  let svg = `<line x1="${fmt(a[0])}" y1="${fmt(a[1])}" x2="${fmt(b[0])}" y2="${fmt(b[1])}" stroke="${color}" stroke-width="2.4" stroke-dasharray="7 5" vector-effect="non-scaling-stroke"/>`;
  if (o.label) {
    const lp = [b[0] + (o.labelDx ?? 6), b[1] + (o.labelDy ?? -4)];
    bounds.add([lp[0] + 18, lp[1] - 12]);
    svg += `<text x="${fmt(lp[0])}" y="${fmt(lp[1])}" fill="${color}" font-size="15" font-weight="800" font-family="inherit">${o.label}</text>`;
  }
  return svg;
}

function renderArc3d(o, bounds) {
  const color = o.color || AXIS_COLORS[o.axis] || ACCENT;
  const [u, v] = perpAxes(o.axis === "x" ? [1, 0, 0] : o.axis === "y" ? [0, 1, 0] : [0, 0, 1]);
  const pts = [];
  const steps = 36;
  for (let k = 0; k <= steps; k += 1) {
    const a = ((o.from + ((o.to - o.from) * k) / steps) * Math.PI) / 180;
    const p = add(o.center, add(scale(u, o.radius * Math.cos(a)), scale(v, o.radius * Math.sin(a))));
    pts.push(project(p));
  }
  pts.forEach((p) => bounds.add(p));
  const tip = pts[pts.length - 1];
  const prev = pts[pts.length - 4];
  return (
    `<polyline points="${ptsAttr(pts.slice(0, -1))}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    arrowHead2d(tip, prev, color, o.head ?? 12)
  );
}

function renderCursor(o, bounds) {
  const [x, y] = project(o.at);
  const s = (o.size ?? 26) / 26;
  const pts = [
    [0, 0], [0, 22], [5.5, 17], [9.5, 26], [13, 24.5], [9, 16], [16, 16],
  ].map(([px, py]) => [x + px * s, y + py * s]);
  pts.forEach((p) => bounds.add(p));
  return `<polygon points="${ptsAttr(pts)}" fill="#ffffff" stroke="#0f172a" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
}

function renderLabel(o, bounds) {
  const [x, y] = project(o.at);
  const fx = x + (o.dx ?? 0);
  const fy = y + (o.dy ?? 0);
  const size = o.size ?? 14;
  const w = String(o.text).length * size * 0.6;
  const anchor = o.anchor || "middle";
  const left = anchor === "middle" ? fx - w / 2 : anchor === "end" ? fx - w : fx;
  bounds.add([left - 4, fy - size]);
  bounds.add([left + w + 4, fy + 4]);
  return `<text x="${fmt(fx)}" y="${fmt(fy)}" text-anchor="${anchor}" fill="${o.color || "#e2e8f0"}" font-size="${size}" font-weight="${o.weight ?? 700}" font-family="inherit">${o.text}</text>`;
}

/**
 * Renderiza una escena isométrica en orden (el autor de la escena ordena de atrás hacia adelante).
 * items: { type: "brick" | "arrow" | "axis" | "arc" | "cursor" | "label", ... }
 */
export function isoScene(items, { pad = 14, className = "" } = {}) {
  const bounds = new Bounds();
  const parts = items.map((it) => {
    switch (it.type) {
      case "arrow":
        return renderArrow3d(it, bounds);
      case "axis":
        return renderAxis(it, bounds);
      case "arc":
        return renderArc3d(it, bounds);
      case "cursor":
        return renderCursor(it, bounds);
      case "label":
        return renderLabel(it, bounds);
      default:
        return renderBrick(it, bounds);
    }
  });
  const x = bounds.minX - pad;
  const y = bounds.minY - pad;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxY - bounds.minY + pad * 2;
  return `<svg class="hg-iso ${className}" viewBox="${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${parts.join("")}</svg>`;
}

/* ------------------------------------------------------------------ */
/* Íconos y diagramas 2D                                               */
/* ------------------------------------------------------------------ */

function arrow2d(x1, y1, x2, y2, color = ACCENT, width = 4, head = 11) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ex = x2 - (dx / len) * head * 0.6;
  const ey = y2 - (dy / len) * head * 0.6;
  return (
    `<line x1="${x1}" y1="${y1}" x2="${fmt(ex)}" y2="${fmt(ey)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>` +
    arrowHead2d([x2, y2], [x1, y1], color, head)
  );
}

/**
 * Mouse con el botón resaltado y la dirección del gesto.
 * button: "left" | "right" | "wheel" · motion: "horizontal" | "vertical" | "orbit" | "scroll" | "click" | "none"
 */
export function mouseIcon({ button = "right", motion = "none" } = {}) {
  const on = (b) => (button === b ? ACCENT : "transparent");
  let motionSvg = "";
  if (motion === "horizontal") {
    motionSvg = arrow2d(30, 60, 6, 60) + arrow2d(90, 60, 114, 60);
  } else if (motion === "vertical") {
    motionSvg = arrow2d(104, 50, 104, 18) + arrow2d(104, 70, 104, 102);
  } else if (motion === "orbit") {
    motionSvg =
      `<path d="M20 78 A44 44 0 0 1 46 16" fill="none" stroke="${ACCENT}" stroke-width="4" stroke-linecap="round"/>` +
      arrowHead2d([50, 14], [40, 19], ACCENT, 12) +
      `<path d="M100 42 A44 44 0 0 1 74 104" fill="none" stroke="${ACCENT}" stroke-width="4" stroke-linecap="round"/>` +
      arrowHead2d([70, 106], [80, 101], ACCENT, 12);
  } else if (motion === "scroll") {
    motionSvg = arrow2d(100, 46, 100, 16) + arrow2d(100, 58, 100, 88);
  } else if (motion === "click") {
    motionSvg =
      `<path d="M${button === "left" ? 30 : 90} 18 l-6 -8 M${button === "left" ? 24 : 96} 26 l-10 -3 M${button === "left" ? 38 : 82} 14 l-1 -10" stroke="${ACCENT}" stroke-width="3.5" stroke-linecap="round"/>`;
  }
  return `<svg class="hg-mouse" viewBox="0 0 120 120" aria-hidden="true">
    ${motionSvg}
    <rect x="38" y="24" width="44" height="72" rx="22" fill="#1e293b" stroke="#cbd5e1" stroke-width="2.5"/>
    <path d="M60 25 A21 21 0 0 0 39 46 L39 52 L60 52 Z" fill="${on("left")}"/>
    <path d="M60 25 A21 21 0 0 1 81 46 L81 52 L60 52 Z" fill="${on("right")}"/>
    <path d="M60 24 V52 M38 52 H82" stroke="#cbd5e1" stroke-width="2.2"/>
    <rect x="56.5" y="31" width="7" height="14" rx="3.5" fill="${button === "wheel" ? ACCENT : "#64748b"}" stroke="#cbd5e1" stroke-width="1.4"/>
  </svg>`;
}

/** Flecha grande "antes → después". */
export function bigArrow(label = "") {
  return `<div class="hg-flow-arrow" aria-hidden="true">
    <svg viewBox="0 0 64 32"><path d="M4 16 H48" stroke="${ACCENT}" stroke-width="5" stroke-linecap="round"/><polygon points="60,16 44,6 44,26" fill="${ACCENT}"/></svg>
    ${label ? `<span>${label}</span>` : ""}
  </div>`;
}

function studGrid(cols, rows, ox, oy, pitch, r = 8) {
  let out = "";
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      const cx = ox + pitch * i + pitch / 2;
      const cy = oy + pitch * j + pitch / 2;
      out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${shade(LEGO.tan, 0.12)}" stroke="${shade(LEGO.tan, -0.35)}" stroke-width="1.5"/>`;
    }
  }
  return `<rect x="${ox}" y="${oy}" width="${cols * pitch}" height="${rows * pitch}" rx="4" fill="${LEGO.tan}" stroke="${shade(LEGO.tan, -0.4)}" stroke-width="1.5"/>${out}`;
}

function topPiece(x, y, cols, rows, pitch, color, { ghost = false } = {}) {
  const w = cols * pitch;
  const h = rows * pitch;
  let studs = "";
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      studs += `<circle cx="${x + pitch * i + pitch / 2}" cy="${y + pitch * j + pitch / 2}" r="${pitch * 0.3}" fill="${ghost ? "none" : shade(color, 0.2)}" stroke="${ghost ? "#ffffff" : shade(color, -0.4)}" stroke-width="1.5" ${ghost ? 'stroke-dasharray="3 2"' : ""}/>`;
    }
  }
  if (ghost) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="rgba(255,255,255,0.12)" stroke="#ffffff" stroke-width="2.2" stroke-dasharray="6 4"/>${studs}`;
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${color}" stroke="${shade(color, -0.45)}" stroke-width="2"/>${studs}`;
}

/** Vista superior: cuánto salta la pieza con grilla de 1 stud o ½ stud. */
export function gridStepDiagram(half = false) {
  const pitch = 28;
  const ox = 14;
  const oy = 34;
  const step = half ? pitch / 2 : pitch;
  const px = ox + pitch;
  const py = oy + pitch;
  const label = half ? "½ stud" : "1 stud";
  return `<svg class="hg-diagram" viewBox="0 0 224 160" aria-hidden="true">
    ${studGrid(7, 4, ox, oy, pitch)}
    ${topPiece(px, py, 2, 2, pitch, LEGO.blue)}
    ${topPiece(px + step, py, 2, 2, pitch, LEGO.blue, { ghost: true })}
    ${arrow2d(px + pitch, oy - 12, px + pitch + step, oy - 12, ACCENT, 3.5, 9)}
    <line x1="${px + pitch}" y1="${oy - 20}" x2="${px + pitch}" y2="${oy - 4}" stroke="${ACCENT}" stroke-width="2"/>
    <text x="${px + pitch + step + 10}" y="${oy - 7}" fill="#e2e8f0" font-size="13" font-weight="700">${label}</text>
  </svg>`;
}

/** Vista superior: ángulo de cada paso de giro (90° o 15°). */
export function rotationStepDiagram(deg = 90) {
  const cx = 86;
  const cy = 84;
  const brick = (angle, ghost) => {
    let studs = "";
    for (let i = 0; i < 2; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        studs += `<circle cx="${-14 + 28 * i}" cy="${-42 + 28 * j}" r="7.5" fill="${ghost ? "none" : shade(LEGO.red, 0.2)}" stroke="${ghost ? "#ffffff" : shade(LEGO.red, -0.4)}" stroke-width="1.4" ${ghost ? 'stroke-dasharray="3 2"' : ""}/>`;
      }
    }
    const rect = ghost
      ? `<rect x="-28" y="-56" width="56" height="112" rx="3" fill="rgba(255,255,255,0.1)" stroke="#ffffff" stroke-width="2" stroke-dasharray="6 4"/>`
      : `<rect x="-28" y="-56" width="56" height="112" rx="3" fill="${LEGO.red}" stroke="${shade(LEGO.red, -0.45)}" stroke-width="2"/>`;
    return `<g transform="translate(${cx} ${cy}) rotate(${angle})">${rect}${studs}</g>`;
  };
  let fan = "";
  if (deg < 90) {
    for (let a = deg * 2; a < 90; a += deg) {
      const r = (a - 90) * (Math.PI / 180);
      fan += `<line x1="${cx}" y1="${cy}" x2="${fmt(cx + Math.cos(r) * 74)}" y2="${fmt(cy + Math.sin(r) * 74)}" stroke="rgba(255,255,255,0.22)" stroke-width="1.5" stroke-dasharray="3 4"/>`;
    }
  }
  const r0 = -Math.PI / 2;
  const r1 = ((deg - 90) * Math.PI) / 180;
  const R = 70;
  const ax = cx + Math.cos(r0) * R;
  const ay = cy + Math.sin(r0) * R;
  const bx = cx + Math.cos(r1) * R;
  const by = cy + Math.sin(r1) * R;
  const prevA = r1 - 0.12;
  const arc = `<path d="M${fmt(ax)} ${fmt(ay)} A${R} ${R} 0 0 1 ${fmt(bx)} ${fmt(by)}" fill="none" stroke="${ACCENT}" stroke-width="3.5" stroke-linecap="round"/>${arrowHead2d([bx, by], [cx + Math.cos(prevA) * R, cy + Math.sin(prevA) * R], ACCENT, 11)}`;
  const mid = (r0 + r1) / 2;
  return `<svg class="hg-diagram" viewBox="0 -14 190 184" aria-hidden="true">
    ${brick(0, false)}
    ${fan}
    ${brick(deg, true)}
    ${arc}
    <text x="${fmt(cx + Math.cos(mid) * (R + 16))}" y="${fmt(cy + Math.sin(mid) * (R + 16) + 5)}" text-anchor="middle" fill="#e2e8f0" font-size="15" font-weight="800">${deg}°</text>
  </svg>`;
}

/** Vista superior: flechas del teclado para mover ½ stud la pieza en mano. */
export function nudgeTopDiagram() {
  const pitch = 26;
  const ox = 36;
  const oy = 30;
  const px = ox + pitch * 2;
  const py = oy + pitch;
  const cxp = px + pitch;
  const cyp = py + pitch;
  return `<svg class="hg-diagram" viewBox="0 0 230 172" aria-hidden="true">
    ${studGrid(6, 4, ox, oy, pitch, 7.5)}
    ${topPiece(px, py, 2, 2, pitch, LEGO.yellow)}
    ${arrow2d(px - 4, cyp, px - 30, cyp)}
    ${arrow2d(px + pitch * 2 + 4, cyp, px + pitch * 2 + 30, cyp)}
    ${arrow2d(cxp, py - 4, cxp, py - 24)}
    ${arrow2d(cxp, py + pitch * 2 + 4, cxp, py + pitch * 2 + 24)}
    <text x="${px - 34}" y="${cyp - 10}" text-anchor="end" fill="#e2e8f0" font-size="15" font-weight="800">←</text>
    <text x="${px + pitch * 2 + 34}" y="${cyp - 10}" fill="#e2e8f0" font-size="15" font-weight="800">→</text>
    <text x="${cxp + 10}" y="${py - 16}" fill="#e2e8f0" font-size="12" font-weight="700">Shift + ↑</text>
    <text x="${cxp + 10}" y="${py + pitch * 2 + 24}" fill="#e2e8f0" font-size="12" font-weight="700">Shift + ↓</text>
  </svg>`;
}
