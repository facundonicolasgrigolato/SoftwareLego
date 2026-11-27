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
     ▼  (frontend/server/localApiServer.mjs + manual_worker.py persistente)
[Sala de Juego (3 slots en Saves/) + Visor PDF (/api/manual/*)]
     │
     ▼  (Frontend Three.js WebGL2 + cannon-es + PeerJS P2P)
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
| `backend/scripts/` | CLIs y workers: `setup_catalog.py`, `process_set.py`, `render_manual_page.py` y worker JSONL `manual_worker.py`. |
| `backend/tests/` | Suite unitaria (`unittest`) para extractores, resolvedores, catálogo SQLite, secuenciador, exportador, visor PDF y worker persistente. |
| `frontend/server/` | Servidor HTTP local desacoplado (`localApiServer.mjs`) y validadores de seguridad (`localSecurity.mjs`) para `/sets/`, `/covers/`, `/ldraw/` y `/api/*`. |
| `frontend/vite.config.js` | Configuración Vite (dev, preview y separación de chunks vendor `three`/`cannon-es`/`peerjs`) que monta `createLocalApiHandler`. |
| `frontend/src/main.js` | Orquestador de Sala de Juego, editor 3D, autoguardado por slot, atajos y coordinación de HUD. |
| `frontend/src/core/` | Motor 3D: `sceneManager.js`, `ldrawService.js`, `batchedPieceLayer.js`, `tableLayout.js`, `partThumbnailRenderer.js`, `threeHelpers.js`, `constants.js`. |
| `frontend/src/builder/` | Reglas de armado modularizadas: `buildController.js`, `placementSolver.js`, `selectionManager.js`, `worldTransitions.js`, `bagDistributor.js`, `historyManager.js`, `gridSnap.js`, `connectors.js`, `connectorExtractor.js`, `collision.js`, `meshCollision.js`, `stickerDecal.js`, `storage.js`. |
| `frontend/src/net/` | Multijugador cooperativo P2P: `roomManager.js`, `worldSync.js`, `remotePresence.js`. |
| `frontend/src/physics/` | Simulación de piezas sueltas en cajas con contención estricta (`pilePhysics.js`). |
| `frontend/src/ui/` | Interfaz DOM: `lobbyView.js`, `manualDrawer.js`, `trayPanel.js`, `traySettingsPopover.js`, `stickerToolController.js`, `roomModal.js`, `helpGuide.js`, `helpArt.js`. |
| `frontend/tests/` | Tests unitarios y de integración (`node --test`) para API local, seguridad, LDraw, colisiones, conectores, batching, layout/contención, pegatinas, UI y multijugador. |
| `.github/workflows/ci.yml` | Pipeline CI automatizado en GitHub Actions (`unittest`, `npm test` y `vite build`). |
| `docs/` | Documentación técnica (`ARCHITECTURE.md`, `ADR.md`, `DATA_SCHEMA.md`). |

---

## Estado de implementación (Hitos completados)

1. **Hito 1 (Completado):** Catálogo offline SQLite + extractor `PyMuPDF` + cadena de resolución con fallbacks por molde, `overrides.json` y etapa híbrida online con caché + exportación JSON + suite de tests.
2. **Hito 2 (Completado):** Simulador 3D interactivo (`Three.js` + `LDrawLoader`), snap a grilla matemática LDU (`20/10` XZ, `8/4` Y), rotación discreta y libre, selección de grupos temporales y persistencia JSON.
3. **Hito 3 (Completado):** Sala de Juego con subida/escaneo de PDFs, 3 slots independientes en disco (`Saves/`), carga por tandas (`150`), compartimentos físicos por bolsa (`cannon-es`), carrusel 3D con miniaturas isométricas, visor integrado de manual PDF y renderizado WebGL2 en lotes (`BatchedPieceLayer`) apto para sets de 1.600+ piezas.
4. **Hito 4 (Completado):** Colisiones en dos fases (OBB SAT sobre voxelización + BVH triangular exacto con chequeo interior de 6 rayos), conectores mecánicos unificados (`connectors.js`: pines, ejes, barras/manos/clips, bisagras y rótulas), pegatinas coplanares sobre caras y contención física por caja.
