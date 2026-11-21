# Esquema de Datos (`output/sets/<set>.json` y `Saves/`)

Versión actual del esquema de manifiesto: **`1.0.0`**

El archivo `output/sets/<set>.json` es el **contrato oficial entre el Backend Python y el Frontend 3D**.

---

## Ejemplo de manifiesto (`output/sets/<set>.json`)

```json
{
  "schema_version": "1.0.0",
  "set_number": "10352",
  "set_name": "The Simpsons: Krusty Burger",
  "source_pdf": "taberna-simpsons.pdf",
  "extractor_used": "pymupdf_bom_v1",
  "generated_at": "2026-11-20T02:29:03.887499+00:00",
  "stats": {
    "total_pages": 268,
    "inventory_pages": [263, 264, 265, 266],
    "unique_elements": 533,
    "total_pieces": 1651,
    "resolved_unique": 533,
    "resolved_pieces": 1651,
    "coverage_percent": 100.0,
    "by_status_unique": {
      "exact": 501,
      "fallback_mold": 32,
      "override": 0,
      "api_online": 0,
      "unresolved": 0
    },
    "by_status_pieces": {
      "exact": 1608,
      "fallback_mold": 43,
      "override": 0,
      "api_online": 0,
      "unresolved": 0
    }
  },
  "sequence_source": "pdf_bags_visual",
  "bags": [
    {
      "bag_number": 1,
      "label": "Bolsa 1",
      "piece_count": 180,
      "page_start": 11,
      "page_end": 31
    }
  ],
  "table_layout": {
    "build_zone": {
      "width_ldu": 1400,
      "depth_ldu": 1200,
      "source": "piece_count_scale"
    },
    "omr_source": null
  },
  "warnings": [],
  "parts": [
    {
      "element_id": "6168642",
      "quantity": 1,
      "status": "exact",
      "resolution_note": null,
      "part_num": "85861",
      "design_id": "28626",
      "part_name": "Plate Round 1 x 1 with Open Stud",
      "ldraw_part_id": "85861",
      "ldraw_file": "parts/85861.dat",
      "color_id": 15,
      "color_name": "White",
      "color_rgb": "#FFFFFF",
      "is_trans": false,
      "ldraw_color_code": 15,
      "source_pages": [263],
      "bag_counts": {
        "8": 1
      }
    }
  ]
}
```

---

## Campos de nivel superior y estructuras auxiliares

| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `schema_version` | `string` | Versión del contrato JSON (`"1.0.0"`). |
| `set_number` | `string \| null` | Número oficial del set extraído de la portada. |
| `set_name` | `string \| null` | Nombre del set resuelto desde `sets.csv.gz` en SQLite. |
| `source_pdf` | `string` | Nombre del PDF origen dentro de `Sets/`. |
| `sequence_source` | `string` | Estrategia de bolsas usada (`"omr"`, `"pdf_bags_visual"`, `"auto_chunks"`, etc.). |
| `bags` | `object[]` | Lista de bolsas con `bag_number`, `label`, `piece_count`, `page_start` y `page_end`. |
| `table_layout` | `object` | Dimensiones recomendadas para el tablero (`build_zone: { width_ldu, depth_ldu, source }`, `omr_source`). |

---

## Campos de cada objeto en `parts[]`

| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `element_id` | `string` | Código único extraído del manual PDF (molde + color). |
| `quantity` | `int` | Cantidad total requerida en el set. |
| `status` | `string` | `"exact"` (molde `.dat` exacto), `"fallback_mold"` (molde equivalente), `"override"` (`data/overrides.json`), `"api_online"` (resolución híbrida cacheada) o `"unresolved"`. |
| `resolution_note` | `string \| null` | Explicación de cómo se resolvió o por qué falló. |
| `part_num` | `string \| null` | Identificador de pieza en Rebrickable. |
| `design_id` | `string \| null` | Design ID asociado al elemento, si existe. |
| `part_name` | `string \| null` | Nombre descriptivo de la pieza. |
| `ldraw_part_id` | `string \| null` | ID base del archivo LDraw (sin `.dat`). |
| `ldraw_file` | `string \| null` | Ruta relativa dentro de `data/ldraw/` (ej. `"parts/85861.dat"`). |
| `color_id` | `int \| null` | ID de color en Rebrickable. |
| `color_name` | `string \| null` | Nombre del color. |
| `color_rgb` | `string \| null` | Color hexadecimal `#RRGGBB` para fallback visual directo en Three.js. |
| `is_trans` | `bool` | Indica si el material es translúcido. |
| `ldraw_color_code` | `int \| null` | Código oficial en `LDConfig.ldr` para `LDrawLoader`. |
| `source_pages` | `int[]` | Páginas de inventario del PDF donde apareció el ítem. |
| `bag_counts` | `object` | Mapa `{ "<bag_number>": cantidad }` asignado por el secuenciador híbrido. |

---

## Guardado de progreso (`Saves/<set_number>/slot_<1|2|3>.json`)

Cada slot persistido por el middleware `/api/saves/:set/:slot` almacena:
- Metadatos del slot: `version`, `slot` (`1..3`), `set_number`, `name`, `updated_at`, `placed_count`.
- `pieces[]`: lista de piezas colocadas (`instance_id`, `element_id`, `position {x,y,z}`, `rotation {x,y,z}` y opcionalmente `stickers[]` con la normal/posición/tamaño y `dataUrl`).
- `history[]`: últimas acciones (hasta 30) para mantener operativo **Deshacer (`Ctrl + Z`)** entre sesiones.
