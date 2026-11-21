# Registro de Decisiones de Arquitectura (ADR)

Este documento registra **qué decidimos, por qué lo decidimos, qué alternativas descartamos y cómo evolucionar cada parte** sin romper el proyecto. Sirve como memoria técnica del proyecto para retomar decisiones en futuras etapas.

---

## ADR-001: Estrategia de lectura de manuales sin visión IA ni gasto de tokens

- **Estado:** Aceptada (Hito 1)
- **Contexto:** Los manuales PDF tienen entre 100 y 300+ páginas. Usar modelos multimodales/IA página por página quema tokens, es lento y propenso a alucinaciones. Además, el usuario visualizará el manual oficial en un segundo monitor durante el armado.
- **Decisión:** No reconstruir pasos de construcción desde el PDF. Extraer únicamente el **inventario total de piezas** del manual, usando una cascada (`ExtractionPipeline`) donde el **Nivel 1** lee texto vectorial embebido en las páginas finales con `PyMuPDF` (`PyMuPDFBOMExtractor`).
- **Alternativas consideradas:**
  - *OpenCV + diff entre páginas paso a paso:* descartada por frágil ante cambios de ángulo, rotaciones y oclusiones, y porque el manual ya estará visible en el monitor secundario.
  - *OCR desde el día 1 (`RapidOCR` / `Tesseract`):* postergada a **Nivel 2** para no agregar ~200–300 MB de modelos ni complejidad innecesaria antes de validar el flujo base.
- **Cómo extender en el futuro:** Implementar una nueva subclase de `BasePDFExtractor` (ej. `OCRInventoryExtractor` para Nivel 2, o `CoverSetLookupExtractor` para Nivel 3 consultando `sets` en SQLite/Rebrickable) y agregarla al array de `ExtractionPipeline`.

---

## ADR-002: Catálogo offline SQLite (Rebrickable CSV + LDraw) como fuente principal (Camino A → futuro Camino B)

- **Estado:** Aceptada (Hito 1)
- **Contexto:** Los manuales listan **Element IDs** (ej. `6168642`, `302401`) que combinan molde + color + posible decoración. LDraw en cambio organiza archivos `.dat` por geometría base y colores en `LDConfig.ldr`.
- **Decisión:** Elegir el **Camino A**: descargar una sola vez los dumps públicos `.csv.gz` de Rebrickable (`elements`, `parts`, `colors`, `part_relationships`, `sets`) y la biblioteca oficial de LDraw (`complete.zip`), e indexar todo en `data/catalog.sqlite`.
- **Ventajas:** 0 tokens, 0 API keys, consultas en milisegundos, 100% offline tras el setup inicial.
- **Desventajas asumidas:** Sets recién lanzados pueden traer algún `Element ID` nuevo aún ausente en el CSV hasta actualizar los dumps o registrarlo manualmente.
- **Cómo escalar a Camino B (híbrido) en el futuro:** La resolución usa `ResolverChain([OverrideResolver, SQLiteCatalogResolver])`. Para pasar a Camino B basta crear un `RebrickableAPIResolver(BasePartResolver)` que consulte la API solo cuando `SQLiteCatalogResolver` devuelva `unresolved`, cachee la respuesta en SQLite/overrides y se inserte al final de `ResolverChain`.

---

## ADR-003: Cadena de resolución y fallback de moldes impresos (`part_relationships`)

- **Estado:** Aceptada (Hito 1)
- **Contexto:** Muchas piezas decoradas/impresas (ej. `87079pr9974`) o variantes de molde tienen `Element ID` propio en Rebrickable, pero en LDraw solo existe el molde base sin imprimir (`87079.dat`).
- **Decisión:** Resolver la geometría en orden de fidelidad:
  1. Override manual en `data/overrides.json` (`status = "override"`).
  2. Coincidencia exacta `<part_num>.dat` en `ldraw_parts` (`status = "exact"`).
  3. Coincidencia por `design_id` (`status = "fallback_mold"`).
  4. Recorrido BFS (profundidad máx. 3) sobre `part_relationships` priorizando `P` (Print), `M` (Mold), `A` (Alternate) (`status = "fallback_mold"`).
  5. Limpieza heurística de sufijos `prXXXX` / `patXXXX` / `cXX` (`status = "fallback_mold"`).
  6. Si nada coincide, marcar `status = "unresolved"` con motivo explícito para corrección puntual en `data/overrides.json`.
- **Por qué:** Maximiza el porcentaje de piezas armables en 3D con medidas y color exactos sin perder trazabilidad de qué piezas usaron molde base en lugar de textura impresa.

---

## ADR-004: Contrato desacoplado por JSON entre Backend (Hito 1) y Simulador 3D (Hito 2+)

- **Estado:** Aceptada (Hito 1)
- **Contexto:** Queremos poder validar y corregir la extracción de sets sin tener que levantar el motor 3D cada vez, y mantener frontend/backend desacoplados.
- **Decisión:** El backend exporta `output/sets/<set_id>.json` siguiendo `SCHEMA_VERSION = "1.0.0"` (documentado en `docs/DATA_SCHEMA.md`). En el Hito 2, el frontend Three.js consumirá directamente ese JSON y los archivos `.dat` de `data/ldraw/`.

---

## ADR-005: Empezar con sets chicos y validar incrementalmente

- **Estado:** Aceptada (Hito 1)
- **Contexto:** Probar interacción 3D, cámara y encastres directamente sobre un set de 1.600+ piezas dificulta detectar errores de escala, snap o rendimiento.
- **Decisión:** Soportar procesamiento completo de cualquier PDF en `Sets/` **y** ofrecer el flag `--sample N` en `process_set.py` para generar mini-sets de prueba rápidos, además de validar inicialmente el Hito 2 con un set pequeño (ej. un auto) antes de pasar a sets modulares/grandes.

---

## ADR-006: Frontend con Vite + Vanilla JS + Three.js `LDrawLoader` y middleware local

- **Estado:** Aceptada (Hito 2)
- **Contexto:** Se necesita una mesa 3D interactiva que cargue `output/sets/*.json` y los ~25.000 `.dat` de `data/ldraw/` sin duplicar gigas/archivos dentro de `frontend/public/`.
- **Decisión:** Usar **Vite + ES Modules sin framework pesado** (React/R3F) + `LDrawLoader` oficial con `preloadMaterials('/ldraw/LDConfig.ldr')` + `loader.parse()` por pieza cacheada, sirviendo `/sets/` y `/ldraw/` vía middleware en `vite.config.js`.
- **Ventajas:** Cero overhead entre el loop WebGL y el DOM, sin duplicar `data/ldraw/`, arranque instantáneo y migración directa a FastAPI en Hito 3.
- **Desventajas:** Si en un futuro la UI de paneles creciera mucho en complejidad de estado, convendría extraer componentes o migrar la capa UI (la lógica de `core/` y `builder/` ya está desacoplada del DOM).

---

## ADR-007: Snap a grilla matemática LDU en Hito 2 vs encastre estricto por studs (Hito 4)

- **Estado:** Aceptada (Hito 2)
- **Contexto:** Un set como `40468` (Yellow Taxi) mezcla ladrillos estándar, placas, ruedas/ejes, pendientes, parabrisas y ladrillos SNOT (`52107` con studs laterales).
- **Decisión:** Implementar en el Hito 2 **snap a grilla oficial LDU** (`20` / `10` LDU en XZ, `8` / `4` LDU en Y, rotación `90°` o `15°` en X/Y/Z) usando raycasting contra la mesa y piezas colocadas + ajuste manual vertical (`W/S`).
- **Ventajas:** Funciona con el 100% de las piezas LDraw desde el primer día y no bloquea piezas laterales, ruedas ni bisagras.
- **Desventajas:** Todavía no impide colisiones o piezas "flotando" (esas validaciones físicas se construirán en el Hito 4 extrayendo conectores `stud*.dat` y bounding boxes).

---

## ADR-008: Pila física realista (`cannon-es`) con lotes progresivos y modo liviano (Hito 3)

- **Estado:** Aceptada (Ajustes Hito 2 + Hito 3)
- **Contexto:** El usuario prefiere que las piezas caigan amontonadas y sueltas en la mesa con física real (empujándose al revolver/arrastrar) en lugar de aparecer solo desde una lista lateral, y al mismo tiempo escalar a sets de 1.600+ piezas (`10352`) sin colapsar CPU/GPU.
- **Decisión:**
  1. Dividir la mesa en **Zona de Pila** (`cannon-es` con `allowSleep = true` y colisionador `Box` ajustado al `Box3` de cada pieza LDraw) y **Zona de Armado** (grilla LDU fija).
  2. Sets de hasta 250 piezas (`40468`) sueltan toda la pila de entrada; sets más grandes (`10352`, 1.637 piezas) sueltan lotes iniciales de 150 piezas con botón **"Soltar +150"** (estilo bolsas numeradas), cola de carga LDraw limitada a 8 peticiones concurrentes y render liviano automático (`>= 400` piezas desactiva sombras individuales y líneas condicionales pesadas).
  3. Permitir ocultar el HUD completo con `H` para una experiencia minimalista inmersiva.
- **Ventajas:** Combina realismo táctil en sets chicos/medianos con fluidez real en sets grandes de 1.600+ piezas.
- **Desventajas:** Los colisionadores de la pila usan `Box` envolventes (no mallas cóncavas exactas por stud) para mantener 60 FPS en navegador; piezas con formas en L pueden apilarse con un margen rectangular mínimo.

---

## ADR-009: Hitboxes multi-caja por voxelización (Hito 4) y auto-orientado solo en caras con studs

- **Estado:** Aceptada (Hito 4)
- **Contexto:** Una caja envolvente única (`Box3`) bloqueaba encastres en piezas cóncavas como el bracket `44728`, mientras que sin chequeo de colisiones se podían meter piezas dentro de otras. Además, auto-orientar sobre cantos finos sin studs inclinaba piezas accidentalmente en el aire.
- **Decisión:**
  1. En `LDrawService.buildCollisionBoxes`, voxelizar las mallas `.dat` a ~4 LDU excluyendo los cilindros de `stud*.dat` y fusionar en sub-cajas mínimas (`Box3[]`), evaluadas con OBB SAT (`collision.js`) y tolerancia de 1.25 LDU (desactivable con `K`).
  2. Restringir el auto-orientado vertical únicamente a caras que tengan studs laterales reales (`stud*.dat` apuntando a la normal).
- **Ventajas:** Permite encastres exactos dentro del hueco en L de brackets y pendientes sin falsos choques, bloquea piezas superpuestas marcando el fantasma en rojo y evita rotaciones accidentales en bordes finos.

---

## ADR-010: Sala de Juego, 3 slots en disco y visor PDF integrado vía Vite middleware

- **Estado:** Aceptada
- **Contexto:** Mantener un `<select>` de sets, guardar únicamente en `localStorage` y depender siempre de un segundo monitor para leer el manual limitaba la usabilidad y ponía en riesgo armados largos frente a limpieza de caché del navegador.
- **Decisión:**
  1. Extender [`frontend/vite.config.js`](../frontend/vite.config.js) (en `configureServer` y `configurePreviewServer`) con endpoints locales `/api/sets`, `/api/scan-sets`, `/api/upload-pdf`, `/api/manual/*` y `/api/saves/*`, sin requerir un segundo servidor aparte para uso diario.
  2. Persistir hasta **3 slots independientes por set** en `Saves/<set_number>/slot_<1|2|3>.json` con autoguardado, historial de deshacer e importación/exportación `.json`, migrando automáticamente armados previos de `localStorage` al Slot 1.
  3. Integrar [`ManualDrawer`](../frontend/src/ui/manualDrawer.js) a la izquierda con renderizado bajo demanda (`pymupdf`), zoom continuo (`Ctrl + Rueda`), clic para colapsar y acceso rápido en otra pestaña (**Abrir PDF**).
- **Ventajas:** Experiencia autocontenida en un solo puerto (`5173`), sin pérdida de progreso en sets grandes y usable tanto en un único monitor como en doble pantalla.

---

## ADR-011: Secuenciación híbrida por bolsas, mesa escalable y contención física estricta

- **Estado:** Aceptada
- **Contexto:** Volcar 1.600 piezas en una única pila desbordaba el área visual, hacía lento encontrar piezas de los primeros pasos y permitía que al revolver piezas con física alguna saltara fuera de su bandeja.
- **Decisión:**
  1. Implementar `backend/app/sequencers/` (`hybrid_sequencer.py`, `omr_sequencer.py`, `pdf_bag_analyzer.py`) para reconstruir bolsas desde OMR comunitario o directamente desde separadores/miniaturas del PDF sin IA, repartiendo piezas en `bags[]` y dimensionando `table_layout.build_zone`.
  2. En `frontend/src/physics/pilePhysics.js`, generar compartimentos separados a la izquierda de la mesa con paredes altas (`wallHeight = 280`), limitador de velocidad y clamp estricto dentro del volumen de cada bolsa (`_containBodyInZone`), además de bloquear la rotación de cámara al hacer clic en vacío dentro de una caja.
- **Ventajas:** Organiza sets grandes por bolsas reales, impide que las piezas salgan despedidas y evita giros involuntarios de cámara al buscar piezas.

---

## ADR-012: Colisiones exactas en 2 fases (OBB + BVH triangular) y conectores mecánicos unificados

- **Estado:** Aceptada
- **Contexto:** Los bloques ortogonales funcionaban con voxelización multi-caja, pero piezas curvas, *studs* abiertos/bajos (`85861` bajo `3960`), pines Technic con labio de retención (`3673` en `6541`), manos de minifigura, bisagras (`hinge`) y rótulas (`ball`) fallaban si se trataban solo como cajas o studs verticales.
- **Decisión:**
  1. Mantener las sub-cajas OBB como filtro grueso rápido y agregar en [`meshCollision.js`](../frontend/src/builder/meshCollision.js) una **Fase 2 geométrica exacta con BVH de triángulos**, test robusto de interioridad en 3 ejes (los 6 rayos `±X, ±Y, ±Z` deben dar paridad impar) y flexión elástica controlada de labios `connect*`/`confric*`.
  2. Crear [`connectors.js`](../frontend/src/builder/connectors.js) para extraer automáticamente conectores tipados desde primitivas LDraw (`pin`, `axle`, `bar` —incluyendo manos `3820.dat` y clips—, `hinge` y `ball`) y calcular el encastre/rotación compatible sin casos rígidos por ID de pieza.
- **Ventajas:** Permite encajar piezas curvas, Technic, bisagras, rótulas y accesorios de minifigura sin desactivar colisiones (`K`), generalizando a moldes nuevos no vistos previamente.

---

## ADR-013: Renderizado WebGL2 en lotes (`BatchedMesh` + shader de aristas) para sets de 1.600+ piezas

- **Estado:** Aceptada
- **Contexto:** Con 1.651 piezas cargadas simultáneamente en escena (ej. set `10352`), mantener miles de `THREE.Mesh` y `THREE.LineSegments` individuales generaba miles de *draw calls* por frame y caídas fuertes de FPS.
- **Decisión:**
  1. Crear [`BatchedPieceLayer`](../frontend/src/core/batchedPieceLayer.js) combinando `THREE.BatchedMesh` (vértices coloreados por cara con `BufferAttribute` `color` compartido en 1 material opaco estándar) y `BatchedEdgeLayer` (un único `LineSegments` cuyo vertex shader consulta las matrices `4x4` de cada instancia desde una `DataTexture` `RGBA32F`).
  2. Promover a malla individual en `placedGroup` únicamente cuando una pieza recibe pegatinas (`stickerDecal.js`) o queda en mano (`carry`), mantener las piezas translúcidas en grupo separado y actualizar el mapa de sombras bajo demanda (`renderer.shadowMap.autoUpdate = false`).
- **Ventajas:** Colapsa más de 1.500 piezas en un par de *draw calls*, mantiene aristas LDraw nítidas y conserva fluida la interacción completa con todas las piezas del set visibles.


