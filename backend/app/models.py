"""Modelos de datos compartidos entre extractores, resolvedores y exportadores."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class ExtractedPartItem:
    """Ítem crudo extraído de un manual PDF antes de resolverse contra el catálogo."""

    element_id: str
    quantity: int
    source_pages: list[int] = field(default_factory=list)


@dataclass
class PDFExtractionResult:
    """Resultado normalizado de la lectura de un manual PDF."""

    pdf_filename: str
    set_number: str | None
    total_pages: int
    inventory_pages: list[int]
    extractor_used: str
    items: list[ExtractedPartItem]
    warnings: list[str] = field(default_factory=list)


@dataclass
class ResolvedPart:
    """Pieza resuelta y lista para ser consumida por el simulador 3D (Hito 2)."""

    element_id: str
    quantity: int
    status: str  # "exact" | "fallback_mold" | "override" | "unresolved"
    resolution_note: str | None = None
    part_num: str | None = None
    design_id: str | None = None
    part_name: str | None = None
    ldraw_part_id: str | None = None
    ldraw_file: str | None = None
    color_id: int | None = None
    color_name: str | None = None
    color_rgb: str | None = None
    is_trans: bool = False
    ldraw_color_code: int | None = None
    source_pages: list[int] = field(default_factory=list)
    bag_counts: dict[str, int] = field(default_factory=dict)
    unresolved_definitive: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class SetManifest:
    """Contrato JSON final de un set procesado (`output/sets/<set>.json`)."""

    schema_version: str
    set_number: str | None
    set_name: str | None
    source_pdf: str
    extractor_used: str
    generated_at: str
    stats: dict[str, Any]
    parts: list[ResolvedPart]
    warnings: list[str] = field(default_factory=list)
    sequence_source: str = "auto_chunks"
    bags: list[dict[str, Any]] = field(default_factory=list)
    table_layout: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "set_number": self.set_number,
            "set_name": self.set_name,
            "source_pdf": self.source_pdf,
            "extractor_used": self.extractor_used,
            "generated_at": self.generated_at,
            "stats": self.stats,
            "sequence_source": self.sequence_source,
            "bags": self.bags,
            "table_layout": self.table_layout,
            "warnings": self.warnings,
            "parts": [part.to_dict() for part in self.parts],
        }
