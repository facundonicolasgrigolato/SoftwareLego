import {
  LEGO,
  bigArrow,
  gridStepDiagram,
  isoScene,
  mouseIcon,
  nudgeTopDiagram,
  rotationStepDiagram,
} from "./helpArt.js";

/* ------------------------------------------------------------------ */
/* Helpers de maquetado                                                */
/* ------------------------------------------------------------------ */

const kbd = (...keys) => keys.map((k) => `<kbd class="hg-kbd">${k}</kbd>`).join("");
const plus = '<span class="hg-plus">+</span>';
const brick = (o) => ({ type: "brick", ...o });
const replica = (label, on = false, extra = "") =>
  `<span class="btn hg-replica${on ? " is-on" : ""}${extra ? ` ${extra}` : ""}">${label}</span>`;

function vis(svg, caption = "", extraClass = "") {
  return `<figure class="hg-vis ${extraClass}"><div class="hg-vis-art">${svg}</div>${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
}

function card(title, body, art = "") {
  return `<section class="hg-card">${art ? `<div class="hg-card-art">${art}</div>` : ""}<h3>${title}</h3>${body}</section>`;
}

const tip = (html) => `<p class="hg-tip"><span class="hg-tip-icon">💡</span><span>${html}</span></p>`;

const STICKER_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <path d="M12.2 19.5H5.2A2.7 2.7 0 0 1 2.5 16.8V6.7A2.7 2.7 0 0 1 5.2 4h12.6a2.7 2.7 0 0 1 2.7 2.7v5.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <circle cx="8" cy="8.5" r="1.4" fill="currentColor"/>
  <path d="M4.2 16.6l3.4-3.7a1.1 1.1 0 0 1 1.6 0l2.4 2.5 1.8-1.8a1.1 1.1 0 0 1 1.5-.1l.9.7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="18.2" cy="17.8" r="4.3" fill="currentColor"/>
  <path d="M18.2 15.9v3.8M16.3 17.8h3.8" stroke="#0f1726" stroke-width="1.9" stroke-linecap="round"/>
</svg>`;

/* ------------------------------------------------------------------ */
/* Escenas reutilizables                                               */
/* ------------------------------------------------------------------ */

const BASE_BRICK = { w: 2, d: 4, color: LEGO.red };

function rotationScene(rot, axis) {
  const b = brick({ ...BASE_BRICK, rot });
  // Centro aproximado del ladrillo ya rotado para dibujar el eje
  const dims = { x: 40, y: 24, z: 80 };
  for (const [ax] of rot) {
    if (ax === "y") [dims.x, dims.z] = [dims.z, dims.x];
    if (ax === "x") [dims.y, dims.z] = [dims.z, dims.y];
    if (ax === "z") [dims.x, dims.y] = [dims.y, dims.x];
  }
  const center = [dims.x / 2, dims.y / 2, dims.z / 2];
  const len = Math.max(dims.x, dims.y, dims.z) + 50;
  const items = [b, { type: "axis", axis, center, length: len, label: axis.toUpperCase() }];
  return isoScene(items, { pad: 12 });
}

function rotationWithArc(rot, axis) {
  const dims = { x: 40, y: 24, z: 80 };
  for (const [ax] of rot) {
    if (ax === "y") [dims.x, dims.z] = [dims.z, dims.x];
    if (ax === "x") [dims.y, dims.z] = [dims.z, dims.y];
    if (ax === "z") [dims.x, dims.y] = [dims.y, dims.x];
  }
  const center = [dims.x / 2, dims.y / 2, dims.z / 2];
  const len = Math.max(dims.x, dims.y, dims.z) + 50;
  const arcCenter =
    axis === "y" ? [center[0], dims.y + 22, center[2]] : axis === "x" ? [dims.x + 26, center[1], center[2]] : [center[0], center[1], dims.z + 26];
  return isoScene(
    [
      brick({ ...BASE_BRICK, rot }),
      { type: "axis", axis, center, length: len, label: axis.toUpperCase() },
      { type: "arc", axis, center: arcCenter, radius: 26, from: 20, to: 300 },
    ],
    { pad: 12 }
  );
}

const plate = (w, d, color = LEGO.tan, at = [0, 0, 0]) => brick({ w, d, h: 8, color, at });

/* ------------------------------------------------------------------ */
/* Páginas                                                             */
/* ------------------------------------------------------------------ */

const OVERVIEW_MARKERS = [
  { n: 1, x: 12.5, y: 3.2, title: "Volver y progreso", text: "Flecha para volver a la Sala de Juego y barra con las piezas colocadas del total." },
  { n: 2, x: 9.5, y: 42, title: "Manual de instrucciones", text: "El PDF del set. Se abre y cierra con el botón <b>Manual</b> de la barra inferior." },
  { n: 3, x: 40, y: 22, title: "Cajas con piezas", text: "Las piezas sueltas de cada bolsa. Agarrás cualquiera directamente con un clic." },
  { n: 4, x: 72, y: 50, title: "Mesa de armado", text: "La base con studs donde construís el modelo." },
  { n: 5, x: 50, y: 79.5, title: "Carrusel de piezas", text: "Todas las piezas del set con su cantidad restante, favoritas y recientes." },
  { n: 6, x: 13, y: 94.5, title: "Buscador", text: "Encontrá una pieza por nombre o color." },
  { n: 7, x: 45.5, y: 92.4, title: "Herramientas", text: "Grilla, giro, auto-orientar, colisiones, centrar y revolver." },
  { n: 8, x: 84, y: 92.4, title: "Guardar y archivos", text: "Deshacer, reiniciar, exportar, importar y guardar progreso." },
  { n: 9, x: 92.8, y: 3.2, title: "Ayuda y HUD", text: "<b>?</b> abre esta guía y <b>Ocultar HUD</b> deja solo la mesa (tecla <b>H</b>)." },
];

function pageOverview() {
  const markers = OVERVIEW_MARKERS.map(
    (m) => `<span class="hg-marker" style="left:${m.x}%;top:${m.y}%">${m.n}</span>`
  ).join("");
  const legend = OVERVIEW_MARKERS.map(
    (m) => `<li><span class="hg-num">${m.n}</span><div><b>${m.title}</b><span>${m.text}</span></div></li>`
  ).join("");
  return `
    <p class="hg-lead">Esta guía te muestra, paso a paso, todo lo que podés hacer en la mesa. Usá las flechas de los costados (o <b>←</b> <b>→</b> del teclado) para avanzar.</p>
    <div class="hg-overview">
      <div class="hg-shot">
        <img src="/help/overview.jpg" alt="Pantalla de armado con sus partes numeradas" draggable="false" />
        ${markers}
      </div>
      <ol class="hg-legend">${legend}</ol>
    </div>`;
}

function pageCamera() {
  const wasd = `<div class="hg-keys-wasd">
      <div>${kbd("W")}</div>
      <div>${kbd("A", "S", "D")}</div>
    </div>`;
  return `
    <p class="hg-lead">Primero, aprendé a mirar la mesa desde donde quieras. Ninguno de estos movimientos cambia tus piezas.</p>
    <div class="hg-grid hg-grid-3">
      ${card("Girar alrededor", "<p>Mantené el <b>clic izquierdo</b> sobre un lugar vacío y arrastrá.</p>", mouseIcon({ button: "left", motion: "orbit" }))}
      ${card("Acercar y alejar", "<p>Girá la <b>rueda del mouse</b>: hacia adelante te acercás, hacia atrás te alejás.</p>", mouseIcon({ button: "wheel", motion: "scroll" }))}
      ${card("Desplazarte", "<p>Usá <b>W A S D</b> para moverte por la mesa como en un videojuego.</p>", wasd)}
    </div>
    <div class="hg-chips">
      <div class="hg-chip">${replica("Centrar mesa")}<span>Te devuelve a la vista inicial si te perdiste.</span></div>
      <div class="hg-chip">${kbd("H")}<span>Oculta toda la interfaz para ver solo la mesa. Volvé a tocar <b>H</b> (o <b>Mostrar HUD</b>).</span></div>
    </div>
    ${tip("Si hacés clic en un lugar vacío <b>dentro de una caja</b> de piezas, la cámara no gira: así no perdés la vista mientras buscás piezas.")}`;
}

function pageGrab() {
  const tray = isoScene(
    [
      brick({ size: [170, 6, 130], color: "#a8784a", at: [0, 0, 0] }),
      brick({ size: [170, 24, 7], color: LEGO.brown, at: [0, 0, 0] }),
      brick({ size: [7, 24, 130], color: LEGO.brown, at: [0, 0, 0] }),
      brick({ w: 2, d: 2, color: LEGO.blue, at: [26, 6, 24] }),
      plate(2, 3, LEGO.yellow, [86, 6, 16]),
      brick({ w: 2, d: 2, color: LEGO.green, at: [34, 6, 80] }),
      brick({ w: 1, d: 2, color: LEGO.red, at: [112, 6, 70] }),
      brick({ size: [7, 24, 130], color: LEGO.brown, at: [163, 0, 0] }),
      brick({ size: [170, 24, 7], color: LEGO.brown, at: [0, 0, 123] }),
      { type: "cursor", at: [122, 34, 84], size: 30 },
    ],
    { pad: 10 }
  );
  const hand = isoScene(
    [
      brick({ w: 2, d: 4, color: LEGO.blue, ghost: true, opacity: 0.6 }),
      { type: "cursor", at: [30, 34, 50], size: 30 },
    ],
    { pad: 14 }
  );
  const partCard = `<div class="hg-part-card">
      <span class="hg-part-star">☆</span>
      <div class="hg-part-thumb">${isoScene([brick({ w: 2, d: 4, color: LEGO.blue })], { pad: 6 })}</div>
      <span class="hg-part-name">Brick 2 x 4</span>
      <span class="hg-part-qty">4x</span>
    </div>`;
  return `
    <p class="hg-lead">Hay dos formas de tomar una pieza. En las dos, la pieza queda <b>en tu mano</b> y sigue al mouse hasta que la soltás.</p>
    <div class="hg-flow">
      ${vis(tray, "<b>Desde las cajas:</b> clic (o arrastrar) sobre la pieza suelta")}
      <div class="hg-or">o</div>
      ${vis(`<div class="hg-center">${partCard}</div>`, "<b>Desde el carrusel:</b> clic en la tarjeta de la pieza")}
      ${bigArrow()}
      ${vis(hand, "¡La tenés en la mano!")}
    </div>
    <div class="hg-chips">
      <div class="hg-chip">${kbd("Esc")}<span>Cancela y la pieza vuelve a donde estaba.</span></div>
      <div class="hg-chip">${kbd("Supr")}<span>Devuelve la pieza seleccionada a su caja.</span></div>
      <div class="hg-chip">${replica("Revolver")} ${kbd("Espacio")}<span>Sacude las cajas para destapar piezas escondidas.</span></div>
    </div>
    <div class="hg-chips">
      <div class="hg-chip"><span class="hg-mini-tag">★ Favoritas</span><span>Marcá la estrella ☆ de una tarjeta para tenerla a mano.</span></div>
      <div class="hg-chip"><span class="hg-mini-tag">◷ Recientes</span><span>Las últimas piezas que usaste.</span></div>
      <div class="hg-chip"><span class="hg-mini-tag">☑ Disponibles</span><span>Oculta las piezas que ya colocaste todas.</span></div>
    </div>
    ${tip("En sets grandes con varias bolsas aparece un selector de bolsa y el botón <b>Ir a zona</b> para llevar la cámara a esa caja. Si quedan piezas por volcar, el botón <b>Soltar +150</b> de arriba las agrega.")}`;
}

function pagePlace() {
  const before = isoScene(
    [
      plate(5, 5),
      brick({ w: 2, d: 4, color: LEGO.red, ghost: true, opacity: 0.55, at: [30, 46, 10] }),
      { type: "arrow", from: [86, 76, 50], to: [86, 18, 50] },
      { type: "cursor", at: [52, 70, 52], size: 28 },
    ],
    { pad: 10 }
  );
  const after = isoScene([plate(5, 5), brick({ w: 2, d: 4, color: LEGO.red, at: [30, 8, 10] })], { pad: 10 });
  const ok = isoScene(
    [plate(4, 4), brick({ w: 2, d: 2, color: LEGO.blue, at: [0, 8, 0] }), brick({ w: 2, d: 2, color: LEGO.yellow, ghost: true, opacity: 0.6, at: [40, 8, 40] })],
    { pad: 10 }
  );
  const bad = isoScene(
    [plate(4, 4), brick({ w: 2, d: 2, color: LEGO.blue, at: [20, 8, 20] }), brick({ w: 2, d: 2, color: LEGO.ghostRed, ghost: true, opacity: 0.7, at: [34, 8, 34] })],
    { pad: 10 }
  );
  const select = isoScene([plate(4, 4), brick({ w: 2, d: 2, color: LEGO.green, at: [20, 8, 20], outline: true })], { pad: 12 });
  const lift = isoScene(
    [plate(4, 4), brick({ w: 2, d: 2, color: LEGO.green, ghost: true, opacity: 0.55, at: [20, 40, 20] }), { type: "cursor", at: [40, 64, 40], size: 28 }],
    { pad: 12 }
  );
  const group = isoScene(
    [
      plate(6, 4),
      brick({ w: 1, d: 2, color: LEGO.blue, at: [0, 8, 0], outline: true }),
      brick({ w: 2, d: 2, color: LEGO.yellow, at: [44, 8, 10], outline: true }),
      brick({ w: 1, d: 2, color: LEGO.red, at: [100, 8, 36], outline: true }),
    ],
    { pad: 12 }
  );
  return `
    <p class="hg-lead">Con la pieza en la mano vas a ver una <b>pieza fantasma</b> (transparente) que muestra dónde va a quedar. Se acomoda sola sobre los studs.</p>
    <div class="hg-flow">
      ${vis(before, "Mové el mouse sobre la mesa o sobre otra pieza")}
      ${bigArrow("clic")}
      ${vis(after, "Queda encastrada")}
      <div class="hg-divider"></div>
      ${vis(ok, "Fantasma normal: entra bien")}
      ${vis(bad, "<b class='hg-red'>Fantasma rojo:</b> choca con otra pieza")}
    </div>
    <h4 class="hg-subtitle">Mover piezas que ya colocaste</h4>
    <div class="hg-flow">
      ${vis(select, "<b>1er clic:</b> la selecciona (marco celeste)")}
      ${bigArrow()}
      ${vis(lift, "<b>2do clic:</b> la levantás para moverla")}
      <div class="hg-divider"></div>
      ${vis(group, `${kbd("Ctrl")}${plus}<b>arrastrar</b> un rectángulo: elegís varias a la vez`)}
    </div>
    ${tip(`Con ${kbd("Ctrl")}${plus}<b>clic</b> sumás o quitás piezas del grupo. El grupo se mueve, gira y se devuelve a las cajas (${kbd("Supr")}) todo junto.`)}`;
}

function pageRotate() {
  const before = rotationScene([], "y");
  return `
    <p class="hg-lead">Podés girar la pieza que tenés <b>en la mano</b> o la que está <b>seleccionada</b>. Cada paso gira 90° (o 15° con el modo fino, ver más adelante).</p>
    <h4 class="hg-subtitle">Con el mouse: mantené el <span class="hg-accent">clic derecho</span> y arrastrá</h4>
    <div class="hg-rot-rows">
      <div class="hg-flow hg-flow-tight">
        ${vis(mouseIcon({ button: "right", motion: "horizontal" }), "Arrastrar a los <b>costados</b>", "hg-vis-sm")}
        ${bigArrow()}
        ${vis(before, "Antes")}
        ${bigArrow()}
        ${vis(rotationWithArc([["y", 90]], "y"), `Gira izquierda/derecha (${kbd("R")} / ${kbd("T")})`)}
      </div>
      <div class="hg-flow hg-flow-tight">
        ${vis(mouseIcon({ button: "right", motion: "vertical" }), "Arrastrar <b>arriba / abajo</b>", "hg-vis-sm")}
        ${bigArrow()}
        ${vis(rotationScene([], "x"), "Antes")}
        ${bigArrow()}
        ${vis(rotationWithArc([["x", -90]], "x"), `Inclina arriba/abajo según tu vista (${kbd("G")} / ${kbd("F")})`)}
      </div>
    </div>
    <h4 class="hg-subtitle">Con el teclado (siempre sigue tu vista horizontal)</h4>
    <div class="hg-grid hg-grid-3">
      ${card(`${kbd("R")} ${kbd("T")}`, "<p>Gira hacia la izquierda (<b class='hg-axis-y'>R</b>) o derecha (<b class='hg-axis-y'>T</b>).</p>", rotationWithArc([["y", 90]], "y"))}
      ${card(`${kbd("G")} ${kbd("F")}`, "<p>Inclina hacia arriba/atrás (<b>G</b>) o abajo/adelante (<b>F</b>) según dónde mirás.</p>", rotationWithArc([["x", -90]], "x"))}
      ${card(`${kbd("V")} ${kbd("B")}`, "<p>Inclina de costado respecto a tu cámara.</p>", rotationWithArc([["z", -90]], "z"))}
    </div>`;
}

function pageNudge() {
  const height = isoScene(
    [
      plate(4, 3),
      brick({ w: 2, d: 2, color: LEGO.yellow, ghost: true, opacity: 0.6, at: [20, 30, 10] }),
      { type: "arrow", from: [74, 52, 40], to: [74, 84, 40] },
      { type: "arrow", from: [74, 40, 40], to: [74, 12, 40] },
      { type: "label", at: [74, 84, 40], text: "↑ subir", dx: 30, dy: 0, anchor: "start" },
      { type: "label", at: [74, 12, 40], text: "↓ bajar", dx: 30, dy: 6, anchor: "start" },
    ],
    { pad: 12 }
  );
  return `
    <p class="hg-lead">Para ubicar la pieza con precisión, sin depender del mouse, usá las <b>flechas del teclado</b> mientras la tenés en la mano.</p>
    <div class="hg-grid hg-grid-2">
      ${card("Moverla por la mesa", `<p>${kbd("←")} ${kbd("→")} la corren medio stud hacia los costados.<br>${kbd("Shift")}${plus}${kbd("↑")} ${kbd("↓")} la llevan hacia adelante o atrás según dónde mirás.</p>`, nudgeTopDiagram())}
      ${card("Subirla o bajarla", `<p>${kbd("↑")} ${kbd("↓")} suben o bajan la altura de a <b>1 placa</b> (siempre en vertical).<br>${kbd("Alt")}${plus}${kbd("↑")} ${kbd("↓")} de a <b>media placa</b>.</p>`, height)}
    </div>
    ${tip("<b>←</b> <b>→</b> y <b>Shift</b>+<b>↑</b> <b>↓</b> siguen tu perspectiva en la mesa, mientras que <b>↑</b> <b>↓</b> siempre suben y bajan en vertical.")}`;
}

function pageTools() {
  return `
    <p class="hg-lead">En la barra inferior tenés dos interruptores que cambian <b>cuánto</b> se mueve y gira la pieza. El botón se pone celeste cuando el modo fino está activo.</p>
    <div class="hg-grid hg-grid-2">
      ${card(
        `Grilla ${kbd("Q")}`,
        `<div class="hg-compare">
          ${vis(gridStepDiagram(false), `<div class="hg-cap-stack">${replica("Grilla 1 stud")}<span>Normal: salta de stud en stud</span></div>`)}
          ${vis(gridStepDiagram(true), `<div class="hg-cap-stack">${replica("Grilla ½ stud", true)}<span>Fino: también entre studs</span></div>`)}
        </div>
        <p>Usá ½ stud para piezas que van <b>desfasadas</b>, por ejemplo sobre una placa jumper (con un solo stud al centro).</p>`
      )}
      ${card(
        `Giro ${kbd("E")}`,
        `<div class="hg-compare">
          ${vis(rotationStepDiagram(90), `<div class="hg-cap-stack">${replica("Giro 90°")}<span>Normal: cuartos de vuelta</span></div>`)}
          ${vis(rotationStepDiagram(15), `<div class="hg-cap-stack">${replica("Giro 15°", true)}<span>Fino: pasos de 15°</span></div>`)}
        </div>
        <p>Usá 15° para piezas en <b>ángulo</b>: bisagras, rampas o detalles diagonales.</p>`
      )}
    </div>`;
}

function pageAssist() {
  const snotBrick = (extra = {}) =>
    brick({ w: 1, d: 1, color: LEGO.gray, at: [0, 8, 0], extraStuds: [{ p: [10, 12, 20], n: [0, 0, 1] }], ...extra });
  const autoBefore = isoScene(
    [
      plate(3, 3),
      snotBrick({ highlightFace: "+z" }),
      brick({ w: 1, d: 2, h: 8, color: LEGO.blue, ghost: true, opacity: 0.6, at: [6, 54, 40] }),
      { type: "cursor", at: [10, 22, 22], size: 26 },
    ],
    { pad: 12 }
  );
  const autoAfter = isoScene(
    [plate(3, 3), snotBrick(), brick({ w: 1, d: 2, h: 8, color: LEGO.blue, rot: [["x", 90]], ghost: true, opacity: 0.7, at: [0, 0, 24] })],
    { pad: 12 }
  );
  const collideBad = isoScene(
    [plate(4, 4), brick({ w: 2, d: 2, color: LEGO.blue, at: [20, 8, 20] }), brick({ w: 2, d: 2, color: LEGO.ghostRed, ghost: true, opacity: 0.7, at: [34, 8, 34] })],
    { pad: 10 }
  );
  return `
    <p class="hg-lead">Dos ayudas que vienen <b>activadas</b> y hacen que armar sea más fácil. Casi nunca vas a necesitar apagarlas.</p>
    <div class="hg-grid hg-grid-2">
      ${card(
        `${replica("Auto-orientar", true)} ${kbd("U")}`,
        `<div class="hg-flow hg-flow-tight">
          ${vis(autoBefore, "Apuntás a una cara con studs al costado")}
          ${bigArrow()}
          ${vis(autoAfter, "La pieza gira sola para encastrar ahí")}
        </div>
        <p>Si lo apagás, el botón dice ${replica("Giro manual")} y la pieza mantiene siempre el giro que le diste vos.</p>`
      )}
      ${card(
        `${replica("Colisiones", true)} ${kbd("K")}`,
        `<div class="hg-flow hg-flow-tight">
          ${vis(collideBad, "Si el fantasma está rojo, no se puede soltar")}
          <div class="hg-toast-replica">No se puede colocar: choca con otra pieza (K para ignorar)</div>
        </div>
        <p>Impide meter una pieza dentro de otra. Pines, ejes, bisagras, clips y las manos de las minifiguras <b>encastran solos</b> aunque esté activado.</p>
        <p>Si lo apagás, el botón dice ${replica("Libre (sin choque)")}: dejalo solo para casos muy especiales.</p>`
      )}
    </div>`;
}

function pageManual() {
  const step = isoScene(
    [plate(4, 4, LEGO.white), brick({ w: 2, d: 2, color: LEGO.red, at: [20, 30, 20] }), { type: "arrow", from: [74, 54, 50], to: [74, 16, 50], color: "#f97316" }],
    { pad: 8 }
  );
  return `
    <p class="hg-lead">El manual oficial del set está siempre a mano, a la izquierda. Arranca <b>cerrado</b> para que tengas toda la mesa libre.</p>
    <div class="hg-manual-demo">
      <div class="hg-manual-mock">
        <div class="hg-manual-head">
          <span class="hg-manual-page">Pág. 12 / 44</span>
          <span class="hg-manual-actions"><span class="hg-manual-open">Abrir PDF</span><span class="hg-manual-zoom">100%</span></span>
          <span class="hg-marker hg-marker-inline" style="right:62px;top:-12px">5</span>
        </div>
        <div class="hg-manual-sheet">
          <span class="hg-manual-stepnum">12</span>
          ${step}
          <span class="hg-marker hg-marker-inline" style="left:50%;top:50%">4</span>
        </div>
        <div class="hg-manual-sheet hg-manual-sheet-next"><span class="hg-manual-stepnum">13</span></div>
        <span class="hg-marker hg-marker-inline" style="right:-12px;top:48%">2</span>
      </div>
      <ol class="hg-legend hg-legend-1col">
        <li><span class="hg-num">1</span><div><b>Abrir y cerrar</b><span>Botón ${replica("Manual", true)} de la barra inferior o la pestaña <b>Manual</b> pegada al borde izquierdo.</span></div></li>
        <li><span class="hg-num">2</span><div><b>Pasar páginas</b><span>Girá la rueda del mouse sobre el manual: las páginas pasan de forma continua.</span></div></li>
        <li><span class="hg-num">3</span><div><b>Zoom</b><span>${kbd("Ctrl")}${plus}rueda acerca hasta 300%. Con zoom, arrastrá la hoja para recorrerla.</span></div></li>
        <li><span class="hg-num">4</span><div><b>Esconderlo rápido</b><span>Un clic sobre el manual lo guarda en la pestaña lateral.</span></div></li>
        <li><span class="hg-num">5</span><div><b>Abrir PDF</b><span>Lo abre en otra pestaña del navegador: ideal para llevarlo a un <b>segundo monitor</b>.</span></div></li>
      </ol>
    </div>`;
}

function pageStickers() {
  const s1 = isoScene([brick({ w: 2, d: 1, color: LEGO.white, highlightFace: "+z" }), { type: "cursor", at: [16, 12, 20], size: 22 }], { pad: 12 });
  const s3 = isoScene([brick({ w: 2, d: 1, color: LEGO.white, sticker: { face: "+z", fill: "#fde047" } })], { pad: 12 });
  const popover = `<div class="hg-sticker-pop">
      <div class="hg-sticker-pop-head"><b>Pegatina en cara</b><span>✕</span></div>
      <p>Presioná <b>Ctrl + V</b> para pegar tu captura o elegí una imagen:</p>
      <div class="hg-sticker-pop-actions"><span class="btn btn-accent hg-replica">Pegar del portapapeles</span><span class="btn hg-replica">Subir imagen...</span></div>
    </div>`;
  return `
    <p class="hg-lead">Podés pegar cualquier imagen (una captura, un logo, un estampado) sobre una cara plana de una pieza ya colocada.</p>
    <div class="hg-flow">
      ${vis(`<div class="hg-center"><span class="btn-circle btn-sticker-tool hg-replica is-on">${STICKER_ICON}</span></div>`, "<b>1.</b> Activá la herramienta en la barra inferior", "hg-vis-sm")}
      ${bigArrow()}
      ${vis(s1, "<b>2.</b> Clic sobre la cara de una pieza armada")}
      ${bigArrow()}
      ${vis(`<div class="hg-center">${popover}</div>`, `<b>3.</b> ${kbd("Ctrl")}${plus}${kbd("V")} o subí una imagen`)}
      ${bigArrow()}
      ${vis(s3, "¡Listo!")}
    </div>
    ${tip(`Para sacar una pegatina, activá la herramienta y hacé clic sobre ella. ${kbd("Esc")} cancela y ${kbd("Ctrl")}${plus}${kbd("Z")} deshace.`)}`;
}

function pageSave() {
  const row = (btn, title, text) => `<li><div class="hg-save-btn">${btn}</div><div><b>${title}</b><span>${text}</span></div></li>`;
  const slot = (n, saved, name, stats) => `<div class="hg-slot${saved ? " is-saved" : ""}">
      <div class="hg-slot-top"><span class="hg-slot-badge${saved ? " saved" : ""}">Slot ${n}</span><b>${name}</b></div>
      <small>${stats}</small>
      <div class="hg-slot-actions">${replica(saved ? "Jugar / Continuar" : "Empezar aquí", false, "btn-accent")}${saved ? replica("Renombrar") : ""}</div>
    </div>`;
  return `
    <p class="hg-lead">Tu armado se <b>guarda solo</b> cada vez que hacés un cambio. Igual tenés estos botones abajo a la derecha:</p>
    <div class="hg-grid hg-grid-2 hg-grid-top">
      <ul class="hg-save-list">
        ${row(replica("💾 Guardar progreso", false, "btn-primary"), `Guardar ${kbd("Ctrl")}${plus}${kbd("S")}`, "Guarda al instante en el slot actual.")}
        ${row(replica("↶ Deshacer", false, "glass-btn"), `Deshacer ${kbd("Ctrl")}${plus}${kbd("Z")}`, "Vuelve atrás el último cambio. Se recuerda aunque cierres el juego.")}
        ${row(replica("↑ Exportar", false, "glass-btn"), "Exportar", "Descarga tu armado como archivo <b>.json</b> (copia de seguridad o para compartir).")}
        ${row(replica("↓ Importar", false, "glass-btn"), "Importar", "Carga un archivo <b>.json</b> en el slot actual.")}
        ${row(replica("↻ Reiniciar", false, "glass-btn btn-danger"), "Reiniciar", "Devuelve todas las piezas armadas a las cajas (te pide confirmación).")}
      </ul>
      <div class="hg-slots-demo">
        <h4 class="hg-subtitle">3 partidas por set</h4>
        <p class="hg-small">Al elegir un set en la Sala de Juego tenés 3 <b>slots</b> independientes, cada uno con su armado y su historial.</p>
        ${slot(1, true, "Mi primera vuelta", "342 / 1651 piezas · Modificado: 20/11/2026")}
        ${slot(2, false, "Vacío", "Sin partida guardada en este slot")}
        <p class="hg-small">En cada slot podés <b>Renombrar</b>, <b>Borrar</b>, <b>Exportar .json</b> e <b>Importar .json</b>.</p>
      </div>
    </div>`;
}

export const HELP_PAGES = [
  { title: "Tu mesa de armado", icon: "🧱", render: pageOverview },
  { title: "Mover la cámara", icon: "🎥", render: pageCamera },
  { title: "Agarrar piezas", icon: "✋", render: pageGrab },
  { title: "Colocar y mover piezas", icon: "📍", render: pagePlace },
  { title: "Rotar piezas", icon: "🔄", render: pageRotate },
  { title: "Ajuste fino con el teclado", icon: "⌨️", render: pageNudge },
  { title: "Grilla y giro fino", icon: "📐", render: pageTools },
  { title: "Auto-orientar y colisiones", icon: "🧲", render: pageAssist },
  { title: "El manual del set", icon: "📖", render: pageManual },
  { title: "Pegatinas", icon: "🏷️", render: pageStickers },
  { title: "Guardar tu progreso", icon: "💾", render: pageSave },
];

/* ------------------------------------------------------------------ */
/* Componente                                                          */
/* ------------------------------------------------------------------ */

/**
 * Guía de ayuda paginada: fondo oscuro, una página por tema, flechas laterales
 * (la izquierda se oculta en la primera página y la derecha en la última).
 */
export class HelpGuide {
  constructor(rootEl, { onOpenChanged } = {}) {
    this.rootEl = rootEl;
    this.onOpenChanged = onOpenChanged || (() => {});
    this.titleEl = rootEl.querySelector("#help-guide-title");
    this.kickerEl = rootEl.querySelector("#help-guide-kicker");
    this.bodyEl = rootEl.querySelector("#help-guide-body");
    this.dotsEl = rootEl.querySelector("#help-guide-dots");
    this.prevBtnEl = rootEl.querySelector("#btn-help-prev");
    this.nextBtnEl = rootEl.querySelector("#btn-help-next");
    this.closeBtnEl = rootEl.querySelector("#btn-close-help");
    this.finishBtnEl = rootEl.querySelector("#btn-help-finish");

    this.pages = HELP_PAGES;
    this.index = 0;
    this._cache = new Map();

    this._buildDots();
    this.prevBtnEl?.addEventListener("click", () => this.prev());
    this.nextBtnEl?.addEventListener("click", () => this.next());
    this.closeBtnEl?.addEventListener("click", () => this.close());
    this.finishBtnEl?.addEventListener("click", () => this.close());
    this.rootEl.addEventListener("click", (ev) => {
      if (ev.target === this.rootEl) this.close();
    });
  }

  _buildDots() {
    if (!this.dotsEl) return;
    this.dotsEl.innerHTML = "";
    this.pages.forEach((page, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "hg-dot";
      dot.title = `${i + 1}. ${page.title}`;
      dot.setAttribute("aria-label", dot.title);
      dot.addEventListener("click", () => this.goTo(i));
      this.dotsEl.appendChild(dot);
    });
  }

  _pageHtml(i) {
    if (!this._cache.has(i)) this._cache.set(i, this.pages[i].render());
    return this._cache.get(i);
  }

  isOpen() {
    return !this.rootEl.classList.contains("hidden");
  }

  open(index = this.index) {
    const wasOpen = this.isOpen();
    this.rootEl.classList.remove("hidden");
    this.goTo(index);
    if (!wasOpen) this.onOpenChanged(true);
  }

  close() {
    if (!this.isOpen()) return;
    this.rootEl.classList.add("hidden");
    this.onOpenChanged(false);
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  goTo(i) {
    const clamped = Math.max(0, Math.min(this.pages.length - 1, i));
    const dir = clamped >= this.index ? "next" : "prev";
    this.index = clamped;
    const page = this.pages[clamped];
    const isFirst = clamped === 0;
    const isLast = clamped === this.pages.length - 1;

    this.titleEl.textContent = `${page.icon} ${page.title}`;
    this.kickerEl.textContent = `Guía rápida · ${clamped + 1} de ${this.pages.length}`;
    this.bodyEl.innerHTML = `<div class="hg-page is-enter-${dir}">${this._pageHtml(clamped)}</div>`;
    this.bodyEl.scrollTop = 0;

    this.prevBtnEl.classList.toggle("is-hidden", isFirst);
    this.prevBtnEl.disabled = isFirst;
    this.nextBtnEl.classList.toggle("is-hidden", isLast);
    this.nextBtnEl.disabled = isLast;
    this.finishBtnEl?.classList.toggle("hidden", !isLast);

    Array.from(this.dotsEl?.children || []).forEach((dot, di) => {
      dot.classList.toggle("is-active", di === clamped);
      dot.setAttribute("aria-current", di === clamped ? "step" : "false");
    });
  }

  next() {
    if (this.index < this.pages.length - 1) this.goTo(this.index + 1);
  }

  prev() {
    if (this.index > 0) this.goTo(this.index - 1);
  }

  /** Atajos dentro de la guía. Devuelve true si consumió la tecla. */
  handleKey(ev) {
    if (!this.isOpen()) return false;
    switch (ev.key) {
      case "ArrowRight":
        ev.preventDefault();
        this.next();
        return true;
      case "ArrowLeft":
        ev.preventDefault();
        this.prev();
        return true;
      case "Escape":
        ev.preventDefault();
        this.close();
        return true;
      default:
        return true;
    }
  }
}
