# Arquitectura del Proyecto — SoftwareLego

## Objetivo
Construir un simulador local gratuito para armar sets de LEGO en 3D a partir de manuales PDF oficiales colocados en `Sets/`, usando la biblioteca **LDraw** y datos abiertos de **Rebrickable**, **sin consumir tokens ni APIs de IA generativa**. El usuario puede consultar el manual integrado en el panel lateral izquierdo (o abrirlo en otra pestaña/monitor) mientras arma el set en una mesa virtual 3D con físicas, conectores mecánicos y medidas reales en LDU.

---

## Flujo de datos general

```text
[Sets/*.pdf]  (subidos desde la Sala de Juego o colocados manualmente)
     │
     ▼  (ExtractionPipeline — PyMuPDFBOMExtractor)
[Element ID + cantidad + páginas de origen]
     │
     ▼  (ResolverChain)
[OverrideResolver] ──► [SQLiteCatalogResolver] ──► [OnlineHybridResolver (caché en data/)]
     │
     ▼  (hybrid_sequencer: OMR comunitario + pdf_bag_analyzer sin IA)
[Bolsas numeradas + layout dinámico de mesa]
     │
     ▼  (json_exporter + portada PNG)
[output/sets/<set>.json] + [output/covers/<set>.png]
     │
     ▼  (Vite local middleware: /api/*, /sets/, /covers/, /ldraw/)
[Sala de Juego (3 slots en Saves/) + Visor PDF (/api/manual/*)]
     │
     ▼  (Frontend Three.js WebGL2 + cannon-es + LDrawLoader)
[Mesas con cajas físicas + BatchedPieceLayer + Snap LDU + Conectores + BVH + Pegatinas]
```

---

## Estructura de carpetas y módulos

| Ruta | Responsabilidad |
| :--- | :--- |
| `Sets/` | PDFs oficiales colocados por el usuario o subidos vía `/api/upload-pdf`. |
| `Saves/` | Partidas guardadas por set en hasta 3 slots JSON (`Saves/<set>/slot_<1|2|3>.json`). |
| `data/` | Catálogo `catalog.sqlite`, dumps `rebrickable/`, biblioteca `ldraw/` (`.dat` y `LDConfig.ldr`), caché `omr/`, `overrides.json` y `api_cache.json`. |
| `output/sets/` | Manifiestos JSON listos para el simulador (`<set>.json`). |
| `output/covers/` | Portadas PNG renderizadas de la página 1 de cada manual. |
| `backend/app/config.py` | Rutas y constantes centralizadas (`AppPaths`, `SCHEMA_VERSION`). |
| `backend/app/models.py` | Dataclasses tipadas (`ExtractedPartItem`, `ResolvedPart`, `SetManifest`). |
| `backend/app/db/` | Esquema SQLite, parseo de `LDConfig.ldr` e indexado de piezas `.dat` y relaciones de molde. |
| `backend/app/extractors/` | Extractores de PDF (`BasePDFExtractor`, `ExtractionPipeline`, `PyMuPDFBOMExtractor`). |
| `backend/app/resolvers/` | Cadena de resolución (`OverrideResolver`, `SQLiteCatalogResolver`, `OnlineHybridResolver`). |
| `backend/app/sequencers/` | Secuenciación híbrida (`hybrid_sequencer.py`, `omr_sequencer.py`, `pdf_bag_analyzer.py`). |
| `backend/app/exporters/` | Generación de `SetManifest` y estadísticas (`json_exporter.py`). |
| `backend/app/manual_viewer.py` | Búsqueda de PDFs en `Sets/`, metadatos de página y renderizado PNG vía `pymupdf`. |
| `backend/scripts/` | CLIs ejecutables: `setup_catalog.py`, `process_set.py` y `render_manual_page.py`. |
| `backend/tests/` | Suite unitaria (`unittest`) para extractores, resolvedores, secuenciador, exportador y visor PDF. |
| `frontend/vite.config.js` | Plugin Vite (dev y preview) que sirve `/sets/`, `/covers/`, `/ldraw/` y endpoints `/api/*`. |
| `frontend/src/main.js` | Orquestador de Sala de Juego, editor 3D, autoguardado por slot, atajos, pegatinas y HUD flotante. |
| `frontend/src/core/` | Motor 3D: `sceneManager.js`, `ldrawService.js`, `batchedPieceLayer.js`, `tableLayout.js`, `partThumbnailRenderer.js`, `constants.js`. |
| `frontend/src/builder/` | Reglas de armado: `buildController.js`, `gridSnap.js`, `connectors.js`, `collision.js`, `meshCollision.js`, `stickerDecal.js`, `storage.js`. |
| `frontend/src/physics/` | Simulación de piezas sueltas en cajas con contención estricta (`pilePhysics.js`). |
| `frontend/src/ui/` | Interfaz DOM: `lobbyView.js`, `manualDrawer.js`, `trayPanel.js`. |
| `frontend/tests/` | Tests unitarios (`node --test`) para LDraw, colisiones, conectores, batching, layout/contención, pegatinas y almacenamiento. |
| `docs/` | Documentación técnica (`ARCHITECTURE.md`, `ADR.md`, `DATA_SCHEMA.md`). |

---

## Estado de implementación (Hitos completados)

1. **Hito 1 (Completado):** Catálogo offline SQLite + extractor `PyMuPDF` + cadena de resolución con fallbacks por molde, `overrides.json` y etapa híbrida online con caché + exportación JSON + suite de tests.
2. **Hito 2 (Completado):** Simulador 3D interactivo (`Three.js` + `LDrawLoader`), snap a grilla matemática LDU (`20/10` XZ, `8/4` Y), rotación discreta y libre, selección de grupos temporales y persistencia JSON.
3. **Hito 3 (Completado):** Sala de Juego con subida/escaneo de PDFs, 3 slots independientes en disco (`Saves/`), carga por tandas (`150`), compartimentos físicos por bolsa (`cannon-es`), carrusel 3D con miniaturas isométricas, visor integrado de manual PDF y renderizado WebGL2 en lotes (`BatchedPieceLayer`) apto para sets de 1.600+ piezas.
4. **Hito 4 (Completado):** Colisiones en dos fases (OBB SAT sobre voxelización + BVH triangular exacto con chequeo interior de 6 rayos), conectores mecánicos unificados (`connectors.js`: pines, ejes, barras/manos/clips, bisagras y rótulas), pegatinas coplanares sobre caras y contención física por caja.
