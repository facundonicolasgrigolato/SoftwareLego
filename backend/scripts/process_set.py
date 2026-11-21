"""CLI para procesar manuales PDF de `Sets/` y generar manifiestos JSON en `output/sets/`."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pymupdf

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import AppPaths  # noqa: E402
from app.exporters.json_exporter import build_manifest, export_manifest_json  # noqa: E402
from app.extractors.base import ExtractionPipeline  # noqa: E402
from app.extractors.pymupdf_bom import PyMuPDFBOMExtractor  # noqa: E402
from app.resolvers.base import ResolverChain  # noqa: E402
from app.resolvers.online_resolver import OnlineHybridResolver  # noqa: E402
from app.resolvers.override_resolver import OverrideResolver  # noqa: E402
from app.resolvers.sqlite_resolver import SQLiteCatalogResolver  # noqa: E402
from app.sequencers.hybrid_sequencer import sequence_manifest_parts  # noqa: E402


def _export_cover_image(pdf_path: Path, cover_path: Path) -> None:
    """Renderiza la portada (página 1) del manual PDF para mostrarla en la sala de juego."""
    try:
        cover_path.parent.mkdir(parents=True, exist_ok=True)
        with pymupdf.open(pdf_path) as doc:
            if len(doc) == 0:
                return
            page = doc[0]
            rect = page.rect
            scale = min(1.5, max(0.3, 460.0 / max(1.0, rect.width)))
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            pix.save(str(cover_path))
    except Exception:
        pass


def process_single_pdf(
    pdf_path: Path,
    paths: AppPaths,
    sample_limit: int | None = None,
) -> Path:
    if not pdf_path.is_file():
        raise FileNotFoundError(f"No existe el archivo PDF: '{pdf_path}'")

    pipeline = ExtractionPipeline([PyMuPDFBOMExtractor()])
    extraction = pipeline.run(pdf_path)

    with SQLiteCatalogResolver(paths.catalog_db_path) as sqlite_resolver:
        online_resolver = OnlineHybridResolver(
            paths=paths,
            sqlite_conn=sqlite_resolver._conn,
            allow_network=True,
        )
        chain = ResolverChain(
            [
                OverrideResolver(paths.overrides_path),
                sqlite_resolver,
                online_resolver,
            ]
        )
        resolved = chain.resolve_all(extraction.items)
        online_resolver.flush_cache()
        set_name = sqlite_resolver.lookup_set_name(extraction.set_number)

    sequence_source, bags_meta, table_layout = sequence_manifest_parts(
        pdf_path=pdf_path,
        set_number=extraction.set_number,
        inventory_pages=extraction.inventory_pages,
        resolved_parts=resolved,
        omr_dir=paths.omr_dir,
    )

    manifest = build_manifest(
        extraction,
        resolved,
        set_name=set_name,
        sequence_source=sequence_source,
        bags=bags_meta,
        table_layout=table_layout,
    )
    out_stem = extraction.set_number or pdf_path.stem
    out_path = paths.output_sets_dir / f"{out_stem}.json"
    export_manifest_json(manifest, out_path)
    _export_cover_image(pdf_path, paths.output_covers_dir / f"{out_stem}.png")

    stats = manifest.stats
    print(f"\n=== {pdf_path.name} (Set: {manifest.set_number or 'N/A'} - {set_name or 'Desconocido'}) ===")
    print(f"Páginas inventario : {stats['inventory_pages']}")
    print(f"Secuencia / Bolsas : {sequence_source} -> {len(bags_meta)} bolsas")
    print(f"Mesa recomendada   : {table_layout.get('build_zone')}")
    print(f"Elementos únicos   : {stats['unique_elements']} | Piezas totales: {stats['total_pieces']}")
    print(
        f"Resueltas          : {stats['resolved_pieces']}/{stats['total_pieces']} "
        f"({stats['coverage_percent']}%)"
    )
    print(f"Detalle estados    : {stats['by_status_unique']}")
    print(f"Archivo generado   : {out_path}")

    unresolved = [p for p in resolved if p.status == "unresolved"]
    if unresolved:
        print(f"Sin resolver ({len(unresolved)} únicos) - primeros 10:")
        for part in unresolved[:10]:
            print(f"  - element_id={part.element_id} qty={part.quantity} ({part.resolution_note})")

    if sample_limit and sample_limit > 0:
        usable = [p for p in resolved if p.status != "unresolved"][:sample_limit]
        sample_manifest = build_manifest(extraction, usable, set_name=f"{set_name or out_stem} (Sample {len(usable)})")
        sample_path = paths.output_sets_dir / f"{out_stem}_sample_{sample_limit}.json"
        export_manifest_json(sample_manifest, sample_path)
        print(f"Mini-set prueba    : {sample_path}")

    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Procesa un manual PDF o todos los PDFs de `Sets/`."
    )
    parser.add_argument(
        "pdf",
        nargs="?",
        help="Ruta a un PDF específico. Si se omite, procesa todos los .pdf de `Sets/`.",
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=0,
        help="Además del set completo, genera un mini-JSON con las primeras N piezas resueltas.",
    )
    args = parser.parse_args()

    paths = AppPaths()
    paths.ensure_directories()

    if args.pdf:
        targets = [Path(args.pdf).resolve()]
    else:
        targets = sorted(paths.sets_dir.glob("*.pdf"))

    if not targets:
        print(f"No se encontraron archivos PDF en {paths.sets_dir}")
        return

    succeeded = 0
    failed: list[dict[str, str]] = []
    for pdf_path in targets:
        try:
            process_single_pdf(pdf_path, paths, sample_limit=args.sample or None)
            succeeded += 1
        except Exception as exc:
            reason = str(exc) or exc.__class__.__name__
            print(f"[ERROR] No se pudo procesar '{pdf_path.name}': {reason}", file=sys.stderr)
            failed.append({"filename": pdf_path.name, "reason": reason})

    if failed:
        print(f"FAILED_JSON:{json.dumps(failed, ensure_ascii=False)}")
        if args.pdf or succeeded == 0:
            sys.exit(1)


if __name__ == "__main__":
    main()
