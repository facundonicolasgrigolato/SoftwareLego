"""Extractor Nivel 1: lectura directa de inventario vectorial/texto con PyMuPDF."""

from __future__ import annotations

import re
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from app.extractors.base import BasePDFExtractor
from app.models import ExtractedPartItem, PDFExtractionResult

# Formato típico de inventario LEGO al final del manual: "2x 302401" o "2x\n302401"
BOM_ENTRY_RE = re.compile(r"(?:^|\s)(\d{1,4})\s*x\s+(\d{5,8})\b")
SET_NUMBER_RE = re.compile(r"\b(\d{4,6})\b")
_QTY_TOKEN_RE = re.compile(r"^(\d{1,4})x$", re.IGNORECASE)
_INLINE_BOM_TOKEN_RE = re.compile(r"^(\d{1,4})x(\d{5,8})$", re.IGNORECASE)
_ELEMENT_ID_TOKEN_RE = re.compile(r"^(\d{5,8})$")


@dataclass(frozen=True)
class _TextToken:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    row_idx: int


def _is_likely_year(num_str: str) -> bool:
    return len(num_str) == 4 and 1990 <= int(num_str) <= 2035


def extract_set_number_from_pages(texts: list[str]) -> str | None:
    """Intenta detectar el número de set oficial en las primeras páginas del manual."""
    fallback_year: str | None = None
    for text in texts:
        for line in text.splitlines():
            clean = line.strip()
            if re.fullmatch(r"\d{4,6}", clean):
                if _is_likely_year(clean):
                    fallback_year = fallback_year or clean
                    continue
                return clean
        for match in SET_NUMBER_RE.finditer(text):
            candidate = match.group(1)
            if _is_likely_year(candidate):
                fallback_year = fallback_year or candidate
                continue
            return candidate
    return fallback_year


def _extract_page_tokens(page: pymupdf.Page) -> list[_TextToken]:
    """Reconstruye tokens por coordenadas `(y, x)` uniendo fragmentos solapados."""
    raw_chars: list[tuple[str, float, float, float, float, float]] = []
    raw_dict = page.get_text("rawdict")
    for block in raw_dict.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                for ch_info in span.get("chars", []):
                    ch = ch_info.get("c", "")
                    if not ch:
                        continue
                    x0, y0, x1, y1 = ch_info["bbox"]
                    _, oy = ch_info["origin"]
                    raw_chars.append((ch, x0, y0, x1, y1, oy))

    if not raw_chars:
        return []

    raw_chars.sort(key=lambda c: (c[5], c[1]))
    rows: list[list[tuple[str, float, float, float, float, float]]] = []
    current_row = [raw_chars[0]]
    row_y = raw_chars[0][5]
    for char_entry in raw_chars[1:]:
        if abs(char_entry[5] - row_y) <= 2.2:
            current_row.append(char_entry)
        else:
            rows.append(current_row)
            current_row = [char_entry]
            row_y = char_entry[5]
    rows.append(current_row)

    tokens: list[_TextToken] = []
    for row_idx, row in enumerate(rows):
        row.sort(key=lambda c: c[1])
        deduped: list[tuple[str, float, float, float, float, float]] = []
        for ch, x0, y0, x1, y1, oy in row:
            if not ch.isspace() and deduped and not deduped[-1][0].isspace():
                pch, px0, py0, px1, py1, poy = deduped[-1]
                # Elimina glifos duplicados/solapados en el mismo origen (ej. "45503" + "359")
                if pch == ch and abs(x0 - px0) <= 1.2:
                    deduped[-1] = (pch, px0, min(py0, y0), max(px1, x1), max(py1, y1), poy)
                    continue
            deduped.append((ch, x0, y0, x1, y1, oy))

        buf = ""
        tx0 = ty0 = tx1 = ty1 = 0.0
        saw_space = False
        for ch, x0, y0, x1, y1, _ in deduped:
            if ch.isspace():
                saw_space = True
                continue
            if not buf:
                buf, tx0, ty0, tx1, ty1 = ch, x0, y0, x1, y1
            elif not saw_space and (x0 - tx1) <= 1.8:
                buf += ch
                tx1 = max(tx1, x1)
                ty0 = min(ty0, y0)
                ty1 = max(ty1, y1)
            else:
                tokens.append(_TextToken(buf, tx0, ty0, tx1, ty1, row_idx))
                buf, tx0, ty0, tx1, ty1 = ch, x0, y0, x1, y1
            saw_space = False

        if buf:
            tokens.append(_TextToken(buf, tx0, ty0, tx1, ty1, row_idx))

    return _merge_split_qty_tokens(tokens)


def _merge_split_qty_tokens(tokens: list[_TextToken]) -> list[_TextToken]:
    """Une pares `'2'` + `'x'` cercanos en la misma fila en un solo token `'2x'`."""
    merged: list[_TextToken] = []
    i = 0
    while i < len(tokens):
        cur = tokens[i]
        if (
            i + 1 < len(tokens)
            and cur.text.isdigit()
            and len(cur.text) <= 4
            and tokens[i + 1].row_idx == cur.row_idx
            and tokens[i + 1].text.lower() == "x"
            and 0.0 <= (tokens[i + 1].x0 - cur.x1) <= 8.0
        ):
            nxt = tokens[i + 1]
            merged.append(
                _TextToken(
                    f"{cur.text}x",
                    cur.x0,
                    min(cur.y0, nxt.y0),
                    nxt.x1,
                    max(cur.y1, nxt.y1),
                    cur.row_idx,
                )
            )
            i += 2
            continue
        merged.append(cur)
        i += 1
    return merged


def extract_bom_matches_from_page(page: pymupdf.Page) -> list[tuple[str, str]]:
    """Extrae pares `(cantidad, element_id)` reconstruyendo líneas y columnas por posición."""
    tokens = _extract_page_tokens(page)
    matches: list[tuple[str, str]] = []
    used_elem_indices: set[int] = set()

    for i, qty_tok in enumerate(tokens):
        inline_match = _INLINE_BOM_TOKEN_RE.match(qty_tok.text)
        if inline_match:
            matches.append((inline_match.group(1), inline_match.group(2)))
            continue

        qty_match = _QTY_TOKEN_RE.match(qty_tok.text)
        if not qty_match:
            continue

        # 1) Prioriza IDs en la misma fila inmediatamente a la derecha (ej. "2x 302401")
        best_idx: int | None = None
        best_score = float("inf")
        for j, elem_tok in enumerate(tokens):
            if j == i or j in used_elem_indices:
                continue
            if not _ELEMENT_ID_TOKEN_RE.match(elem_tok.text):
                continue
            if elem_tok.row_idx == qty_tok.row_idx and 0.0 <= (elem_tok.x0 - qty_tok.x1) <= 25.0:
                score = elem_tok.x0 - qty_tok.x1
                if score < best_score:
                    best_score = score
                    best_idx = j

        # 2) Fallback: ID debajo del multiplicador en la misma columna (formato estándar LEGO)
        if best_idx is None:
            for j, elem_tok in enumerate(tokens):
                if j == i or j in used_elem_indices:
                    continue
                if not _ELEMENT_ID_TOKEN_RE.match(elem_tok.text):
                    continue
                dy = elem_tok.y0 - qty_tok.y0
                dx = abs(elem_tok.x0 - qty_tok.x0)
                if dx <= 8.0 and 0.0 < dy <= 22.0:
                    score = dy + dx * 2.0
                    if score < best_score:
                        best_score = score
                        best_idx = j

        if best_idx is not None:
            used_elem_indices.add(best_idx)
            matches.append((qty_match.group(1), tokens[best_idx].text))

    return matches


class PyMuPDFBOMExtractor(BasePDFExtractor):
    """Extrae `<cantidad>x <ElementID>` de las páginas finales cuando el PDF tiene texto embebido."""

    name = "pymupdf_bom_v1"

    def __init__(self, tail_pages_to_scan: int = 20, min_matches_per_page: int = 3) -> None:
        self.tail_pages_to_scan = tail_pages_to_scan
        self.min_matches_per_page = min_matches_per_page

    def can_extract(self, pdf_path: Path) -> bool:
        return pdf_path.is_file() and pdf_path.suffix.lower() == ".pdf"

    def extract(self, pdf_path: Path) -> PDFExtractionResult:
        with pymupdf.open(pdf_path) as doc:
            total_pages = len(doc)
            cover_texts = [doc[i].get_text("text") for i in range(min(3, total_pages))]
            set_number = extract_set_number_from_pages(cover_texts)

            start_idx = max(0, total_pages - self.tail_pages_to_scan)
            page_matches: list[tuple[int, list[tuple[str, str]]]] = []
            for idx in range(start_idx, total_pages):
                matches = extract_bom_matches_from_page(doc[idx])
                if matches:
                    page_matches.append((idx + 1, matches))

            candidate_pages = [
                (pnum, matches)
                for pnum, matches in page_matches
                if len(matches) >= self.min_matches_per_page
            ]
            # Fallback para sets diminutos con 1 o 2 piezas únicas en la tabla final
            if not candidate_pages:
                candidate_pages = page_matches

            aggregated: OrderedDict[str, ExtractedPartItem] = OrderedDict()
            inventory_pages: list[int] = []
            warnings: list[str] = []

            for page_num, matches in candidate_pages:
                inventory_pages.append(page_num)
                for qty_str, element_id in matches:
                    qty = int(qty_str)
                    if qty <= 0:
                        continue
                    if element_id in aggregated:
                        aggregated[element_id].quantity += qty
                        if page_num not in aggregated[element_id].source_pages:
                            aggregated[element_id].source_pages.append(page_num)
                    else:
                        aggregated[element_id] = ExtractedPartItem(
                            element_id=element_id,
                            quantity=qty,
                            source_pages=[page_num],
                        )

            if not aggregated:
                warnings.append(
                    "No se detectó texto seleccionable de inventario en las últimas páginas; "
                    "puede requerir Nivel 2 (OCR) o Nivel 3 (catálogo por número de set)."
                )

            return PDFExtractionResult(
                pdf_filename=pdf_path.name,
                set_number=set_number,
                total_pages=total_pages,
                inventory_pages=inventory_pages,
                extractor_used=self.name,
                items=list(aggregated.values()),
                warnings=warnings,
            )
