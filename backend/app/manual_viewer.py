"""Utilidades para localizar y renderizar páginas del manual PDF en PNG."""

from __future__ import annotations

from pathlib import Path

import pymupdf

from app.extractors.pymupdf_bom import extract_set_number_from_pages


def find_set_pdf(
    sets_dir: Path,
    set_number: str,
    source_pdf: str | None = None,
) -> Path | None:
    """Busca el PDF del set en `Sets/` por nombre o inspeccionando el número en portada."""
    if not sets_dir.is_dir():
        return None

    if source_pdf:
        direct = sets_dir / Path(source_pdf).name
        if direct.is_file():
            return direct

    clean_set = (set_number or "").strip()
    pdfs = sorted(sets_dir.glob("*.pdf"))
    if not clean_set:
        return None

    for pdf_path in pdfs:
        if clean_set in pdf_path.stem:
            return pdf_path

    for pdf_path in pdfs:
        try:
            with pymupdf.open(pdf_path) as doc:
                cover_texts = [doc[i].get_text("text") for i in range(min(3, len(doc)))]
            if extract_set_number_from_pages(cover_texts) == clean_set:
                return pdf_path
        except Exception:
            continue

    return None


def get_manual_info(pdf_path: Path) -> dict[str, object]:
    """Devuelve cantidad de páginas, relaciones de aspecto y nombre de archivo del PDF."""
    with pymupdf.open(pdf_path) as doc:
        aspects = [
            round(float(page.rect.height) / max(1.0, float(page.rect.width)), 4)
            for page in doc
        ]
        return {
            "ok": True,
            "filename": pdf_path.name,
            "pageCount": len(doc),
            "pageAspects": aspects,
        }


def render_manual_page_png(
    pdf_path: Path,
    page_1based: int,
    scale: float = 2.0,
) -> bytes:
    """Renderiza una página (1-based) del manual como bytes PNG sin canal alfa."""
    clamped_scale = max(1.0, min(3.0, float(scale)))
    with pymupdf.open(pdf_path) as doc:
        if len(doc) == 0:
            raise ValueError("El PDF no contiene páginas.")
        idx = max(0, min(len(doc) - 1, int(page_1based) - 1))
        pix = doc[idx].get_pixmap(
            matrix=pymupdf.Matrix(clamped_scale, clamped_scale),
            alpha=False,
        )
        return pix.tobytes("png")
