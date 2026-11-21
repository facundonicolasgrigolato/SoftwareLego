"""Exportador del manifiesto JSON estándar para el simulador 3D."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import SCHEMA_VERSION
from app.models import PDFExtractionResult, ResolvedPart, SetManifest


def build_manifest(
    extraction: PDFExtractionResult,
    resolved_parts: list[ResolvedPart],
    set_name: str | None = None,
    sequence_source: str = "auto_chunks",
    bags: list[dict[str, Any]] | None = None,
    table_layout: dict[str, Any] | None = None,
) -> SetManifest:
    """Construye el manifiesto completo con estadísticas de cobertura."""
    total_unique = len(resolved_parts)
    total_quantity = sum(p.quantity for p in resolved_parts)

    status_counts: dict[str, int] = {
        "exact": 0,
        "fallback_mold": 0,
        "override": 0,
        "api_online": 0,
        "unresolved": 0,
    }
    quantity_by_status: dict[str, int] = dict(status_counts)

    for part in resolved_parts:
        key = part.status if part.status in status_counts else "unresolved"
        status_counts[key] += 1
        quantity_by_status[key] += part.quantity

    resolved_unique = total_unique - status_counts["unresolved"]
    resolved_qty = total_quantity - quantity_by_status["unresolved"]
    coverage_pct = round((resolved_qty / total_quantity) * 100, 2) if total_quantity else 0.0

    stats = {
        "total_pages": extraction.total_pages,
        "inventory_pages": extraction.inventory_pages,
        "unique_elements": total_unique,
        "total_pieces": total_quantity,
        "resolved_unique": resolved_unique,
        "resolved_pieces": resolved_qty,
        "coverage_percent": coverage_pct,
        "by_status_unique": status_counts,
        "by_status_pieces": quantity_by_status,
    }

    return SetManifest(
        schema_version=SCHEMA_VERSION,
        set_number=extraction.set_number,
        set_name=set_name,
        source_pdf=extraction.pdf_filename,
        extractor_used=extraction.extractor_used,
        generated_at=datetime.now(timezone.utc).isoformat(),
        stats=stats,
        parts=resolved_parts,
        warnings=list(extraction.warnings),
        sequence_source=sequence_source,
        bags=bags or [],
        table_layout=table_layout or {},
    )


def export_manifest_json(manifest: SetManifest, output_path: Path) -> Path:
    """Guarda el manifiesto en disco con formato legible UTF-8."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(manifest.to_dict(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return output_path
