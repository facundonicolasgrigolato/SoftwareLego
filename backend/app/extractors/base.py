"""Interfaces base y pipeline en cascada para extractores de manuales PDF."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from app.models import PDFExtractionResult


class ExtractionError(RuntimeError):
    """Error lanzado cuando ningún extractor logra leer el inventario del PDF."""


class BasePDFExtractor(ABC):
    """Contrato común para extractores de inventario (Nivel 1 texto, Nivel 2 OCR, etc.)."""

    name: str = "base"

    @abstractmethod
    def can_extract(self, pdf_path: Path) -> bool:
        """Indica rápidamente si este extractor aplica al PDF recibido."""

    @abstractmethod
    def extract(self, pdf_path: Path) -> PDFExtractionResult:
        """Extrae el inventario de piezas y metadatos básicos del PDF."""


class ExtractionPipeline:
    """Ejecuta extractores en orden de prioridad (más barato/exacto primero)."""

    def __init__(self, extractors: list[BasePDFExtractor]) -> None:
        if not extractors:
            raise ValueError("ExtractionPipeline requiere al menos un extractor.")
        self.extractors = extractors

    def run(self, pdf_path: Path) -> PDFExtractionResult:
        errors: list[str] = []
        for extractor in self.extractors:
            if not extractor.can_extract(pdf_path):
                errors.append(f"{extractor.name}: no aplicable")
                continue
            try:
                result = extractor.extract(pdf_path)
                if result.items:
                    return result
                errors.append(f"{extractor.name}: no encontró ítems de inventario")
            except Exception as exc:  # pragma: no cover - defensa de cascada
                errors.append(f"{extractor.name}: error ({exc})")

        raise ExtractionError(
            f"No se pudo extraer inventario de '{pdf_path.name}'. Detalles: {'; '.join(errors)}"
        )
