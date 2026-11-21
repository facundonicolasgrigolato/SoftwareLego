# SoftwareLego

Simulador personal y gratuito para armar sets de LEGO en 3D a partir de manuales PDF oficiales, **100% local y sin consumo de tokens de IA**.

## Documentación clave
- [Arquitectura del proyecto](docs/ARCHITECTURE.md)
- [Registro de decisiones (ADR)](docs/ADR.md)
- [Esquema de salida JSON](docs/DATA_SCHEMA.md)

## Requisitos
- **Python 3.11+** (`py`) y dependencias en `backend/requirements.txt` (`pymupdf`)
- **Node.js 18+** (`npm.cmd`)
- Navegador con **WebGL2** (Chrome, Edge, Firefox actualizados)

## Para jugar (incluso sin conocimientos de programación)

1. Descargá el repositorio desde GitHub (**Code → Download ZIP**) y descomprimilo en una carpeta.
2. Hacé doble click en [`Iniciar_SoftwareLego.bat`](Iniciar_SoftwareLego.bat):
   - La primera vez verifica e instala automáticamente si faltan **Node.js**, **Python**, `pymupdf`, las dependencias web (`peerjs`, `three`, `cannon-es`) y descarga el catálogo oficial de piezas LEGO (`data/catalog.sqlite` y `data/ldraw/`, una sola vez).
   - En los siguientes inicios abre directamente el navegador en `http://127.0.0.1:5173/`.

## Instalación manual (opcional para desarrollo)

1. **Instalar dependencias Python:**
   ```powershell
   py -m pip install -r backend/requirements.txt
   ```

2. **Descargar catálogos offline (Rebrickable + LDraw) y construir `data/catalog.sqlite`:**
   ```powershell
   py backend/scripts/setup_catalog.py
   ```
   *(Solo se descarga la primera vez. Para reconstruir la base sin volver a descargar: `--rebuild-only`).*

3. **Instalar dependencias del frontend:**
   ```powershell
   cd frontend
   npm.cmd install
   ```

4. **Ejecutar por terminal:**
   ```powershell
   cd frontend
   npm.cmd run dev
   ```
   Abrí `http://127.0.0.1:5173/` (o `npm.cmd run build` + `npm.cmd run preview`).

## Modo multijugador cooperativo (hasta 4 jugadores)

- **Abrir sala (Admin del slot):** dentro de cualquier set y slot, presioná el botón de grupo entre **Pegatina** y **Deshacer**. Al **Abrir sala** se genera un código único de **7 dígitos** para compartir por Discord/chat. Desde esa ventana podés **renombrar** jugadores, **expulsar** (`✕`) o **cerrar la sala** (la próxima vez genera un código nuevo).
- **Unirse a sala (Amigos):** en la Sala de Juego, tocá **Unirse a sala** arriba a la derecha e ingresá el código de 7 dígitos. Si no tenés ese set en tu PC, se descarga automáticamente desde el anfitrión (catálogo, portada, `.dat` faltantes y manual PDF) y queda sumado a tu biblioteca con tus propios 3 slots vacíos.
- **Tiempo real y permisos:** cada jugador ve los **cursores 3D**, nombres y vistas previas de piezas de los demás en su color asignado; al agarrar o seleccionar una pieza queda reservada para evitar choques. Pegatina, Sala, Deshacer (`Ctrl + Z`), Reiniciar, Exportar, Importar y Guardar (`Ctrl + S`) son exclusivos del Admin; Manual PDF, `Q`, `E`, `U`, `K` y `H` son independientes por jugador.

## Funcionamiento offline vs online
- **Una vez procesado el set (`output/sets/<set>.json` y `.dat` en `data/ldraw/`):** podés **armar, guardar, abrir el manual PDF y colocar pegatinas 100% sin internet**.
- **Solo requiere conexión puntual** si procesás un PDF nuevo cuyo set requiera descargar una pieza reciente desde LDraw Unofficial Parts Tracker, el repositorio comunitario OMR o (opcionalmente) la API de Rebrickable.

## Sala de Juego y Guardados por Slots

Al iniciar la aplicación se abre la **Sala de Juego 3D**:
- **Subir nuevos sets (PDF):** arrastrá o seleccioná manuales PDF oficiales en el panel izquierdo (`Sets/`), o presioná **↻ Re-escanear Sets/** para procesarlos automáticamente (genera manifiestos en `output/sets/` y portadas PNG en `output/covers/`).
- **Buscador y tarjetas:** filtrá los sets procesados por nombre o número de set, viendo cuántas piezas 3D resueltas tiene y cuántos slots están ocupados (`0/3` a `3/3`).
- **3 Slots independientes por set:** al hacer click en un set elegís entre **Slot 1**, **Slot 2** y **Slot 3**, guardados en disco dentro de `Saves/<set_number>/slot_<1|2|3>.json`.
  - Cada slot conserva su armado, nombre editable, fecha de última modificación, pegatinas colocadas e historial de **Deshacer (`Ctrl + Z`)**.
  - Desde el modal podés **Renombrar**, **Borrar**, **Exportar `.json`** o **Importar `.json`** en cualquier slot.
  - Si existía un armado antiguo en `localStorage`, se migra automáticamente al **Slot 1** la primera vez que abrís el set.

## Mesa Virtual 3D

- **Visor de manual PDF integrado:** panel lateral izquierdo con scroll continuo de todas las páginas, zoom continuo con `Ctrl + Rueda` (100%–300%), clic sobre el visor para colapsarlo a una pestaña lateral y botón **Abrir PDF** para llevarlo a otro monitor.
- **Bolsas organizadas y secuencia híbrida:** al procesar un PDF, el backend consulta secuencias LDraw OMR si existen o detecta localmente las páginas separadoras de **Bolsas** y miniaturas del PDF (0 tokens IA; si no hay bolsas numeradas, agrupa en tandas de ~150 piezas).
- **Mesa de madera dinámica y física contenida:** cada bolsa se carga en su propio compartimento físico a la izquierda (`Bolsa 1`, `Bolsa 2`, ...) con filtro por bolsa, botón **Ir a zona** y **Soltar +150** para tandas pendientes. Las piezas tienen paredes altas y contención por caja para no salirse al revolver, y hacer click en vacío sobre una caja bloquea la rotación accidental de la cámara.
- **Carrusel 3D inferior:** miniaturas 3D isométricas reales cacheadas offscreen, pestañas **Piezas**, **★ Favoritas** y **◷ Recientes**, buscador por nombre/color y filtro **Disponibles**.
- **Motor de colisiones exacto + conectores mecánicos unificados:**
  - Detección en dos fases: cajas finas por voxelización (`Box3[]` OBB SAT) seguidas de chequeo geométrico BVH triangular + interioridad por 6 rayos (`±X, ±Y, ±Z`), evitando falsos choques en piezas curvas, huecos y *studs* bajos (`85861`, `3960`), y tolerando la compresión de labios de retención en pines Technic.
  - Encastre automático para conectores mecánicos reales: **pines y ejes Technic**, **barras con clips o manos de minifigura**, **bisagras (`hinge`)** y **rótulas (`ball`)**.
- **Pegatinas en caras:** activá la herramienta de pegatina en la barra inferior, tocá cualquier cara plana de una pieza colocada y pegá con `Ctrl + V` o subiendo una imagen.
- **Rendimiento para sets grandes (1.600+ piezas):** renderizado WebGL2 en lotes (`THREE.BatchedMesh` + shader de aristas con `DataTexture`) y actualización de sombras bajo demanda para mantener alta fluidez incluso con todas las piezas del set cargadas simultáneamente (ej. `10352` Krusty Burger con 1.651 piezas).

### Controles principales
- **Cámara:** `W A S D` mover · Arrastrar izquierdo orbitar · Rueda zoom · `H` ocultar/mostrar HUD · botón **Centrar mesa**.
- **Pila y catálogo:** Click / arrastrar en caja para agarrar pieza física · Click en tarjeta del carrusel para sacar pieza · `Supr` / `Retroceso` devolver a bolsa · `Espacio` revolver piezas.
- **Armado y selección:** 1er click selecciona · 2do click mueve · `Ctrl + Arrastrar` / `Ctrl + Click` selecciona un área o suma/quita piezas (grupo temporal) · Click izquierdo coloca.
- **Rotación:** Click derecho + arrastrar (`Y` horizontal / `X` vertical) · `R / T` (eje Y) · `F / G` (eje X) · `V / B` (eje Z).
- **Ajuste fino con teclado (pieza o grupo en mano):** `← / →` mover ½ stud lateral · `Shift + ↑ / ↓` mover ½ stud adelante/atrás · `↑ / ↓` subir/bajar 1 plate (`Alt + ↑ / ↓` ½ plate).
- **Asistencias y persistencia:** `U` auto-orientar a cara · `K` colisiones · `Q` grilla ½ stud · `E` giro 15° · `Ctrl + Z` deshacer · `Ctrl + S` guardar progreso.

## Procesamiento manual por CLI y Tests

- **Procesar todos los PDFs de `Sets/` manualmente:**
  ```powershell
  py backend/scripts/process_set.py
  ```
  O un archivo puntual con mini-set de prueba:
  ```powershell
  py backend/scripts/process_set.py Sets/tu_manual.pdf --sample 20
  ```
- **Correr tests del backend:**
  ```powershell
  py -m unittest discover -s backend/tests -v
  ```
- **Correr tests y build de producción del frontend:**
  ```powershell
  node --test frontend/tests/*.test.mjs
  cd frontend
  npm.cmd run build
  ```

## Resolución híbrida (Camino B) y piezas sin resolver
El backend mantiene el catálogo offline (`data/catalog.sqlite`) como origen principal, y para piezas ausentes aplica una etapa híbrida (`OnlineHybridResolver`) con caché local:
1. Descarga automática desde **LDraw Unofficial Parts Tracker** (`library.ldraw.org/library/unofficial/`, sin API key) guardando el `.dat` y sus subpiezas en `data/ldraw/`.
2. *(Opcional, para `Element ID`s muy recientes ausentes en el CSV offline)* Configuración de `REBRICKABLE_API_KEY` (variable de entorno o `data/api_config.json` con `{"rebrickable_api_key": "..."}`) para consultar la API v3 de Rebrickable, cacheando respuestas en `data/api_cache.json`.
3. Soporte manual de reemplazos en `data/overrides.json` para correcciones puntuales.
