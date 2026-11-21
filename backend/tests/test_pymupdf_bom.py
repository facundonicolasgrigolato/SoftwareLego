"""Tests unitarios para el extractor Nivel 1 (`PyMuPDFBOMExtractor`)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import pymupdf

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.extractors.base import ExtractionError, ExtractionPipeline  # noqa: E402
from app.extractors.pymupdf_bom import PyMuPDFBOMExtractor  # noqa: E402


class TestPyMuPDFBOMExtractor(unittest.TestCase):
    def test_extracts_bom_and_ignores_duplicate_standalone_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "mini_car.pdf"
            doc = pymupdf.open()

            # Portada
            p0 = doc.new_page()
            p0.insert_text((72, 72), "60312\nLEGO City Police Car")

            # Página intermedia de instrucciones (sin inventario)
            p1 = doc.new_page()
            p1.insert_text((72, 72), "Step 1\n1x")

            # Página de inventario simulando duplicado sin 'Nx'
            p2 = doc.new_page()
            p2.insert_text(
                (72, 72),
                "2x 302401\n4x 6416525\n6416525\n1x 300121\n3x 302301",
            )

            # Segunda página de inventario con pieza repetida
            p3 = doc.new_page()
            p3.insert_text((72, 72), "1x 302401\n2x 300501\n5x 302001")
            doc.save(pdf_path)
            doc.close()

            pipeline = ExtractionPipeline([PyMuPDFBOMExtractor()])
            result = pipeline.run(pdf_path)

            self.assertEqual(result.set_number, "60312")
            self.assertEqual(result.total_pages, 4)
            self.assertEqual(result.inventory_pages, [3, 4])

            by_id = {item.element_id: item for item in result.items}
            self.assertEqual(by_id["302401"].quantity, 3)  # 2 + 1 sumados
            self.assertEqual(by_id["302401"].source_pages, [3, 4])
            self.assertEqual(by_id["6416525"].quantity, 4)  # No duplicado por el texto suelto
            self.assertEqual(by_id["300121"].quantity, 1)

    def test_raises_extraction_error_when_no_bom_text_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "scanned.pdf"
            doc = pymupdf.open()
            p0 = doc.new_page()
            p0.insert_text((72, 72), "Solo portada sin inventario")
            doc.save(pdf_path)
            doc.close()

            pipeline = ExtractionPipeline([PyMuPDFBOMExtractor()])
            with self.assertRaises(ExtractionError):
                pipeline.run(pdf_path)

    def test_extract_set_number_skips_calendar_year(self) -> None:
        from app.extractors.pymupdf_bom import extract_set_number_from_pages

        pages = [
            "© 2025 The LEGO Group\n2026 Catalog\nSet 40468\nYellow Taxi",
        ]
        self.assertEqual(extract_set_number_from_pages(pages), "40468")

    def test_reconstructs_overlapping_split_id_and_dedups_double_stamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "split_overlap.pdf"
            doc = pymupdf.open()
            p0 = doc.new_page()
            p0.insert_text((72, 72), "40797")

            p1 = doc.new_page()
            # Simula '1x\n4550359' partido en '45503' y '359' con el '3' superpuesto (mismo x, y)
            p1.insert_text((249.48, 118.41), "1x", fontsize=7.5)
            p1.insert_text((249.48, 125.61), "45503", fontsize=7.5)
            p1.insert_text((266.16, 125.61), "359", fontsize=7.5)

            # Simula bloque duplicado exactamente encima (doble impresión en el mismo x, y)
            p1.insert_text((100.0, 118.41), "6x", fontsize=7.5)
            p1.insert_text((100.0, 125.61), "6075179", fontsize=7.5)
            p1.insert_text((100.0, 118.41), "6x", fontsize=7.5)
            p1.insert_text((100.0, 125.61), "6075179", fontsize=7.5)

            p1.insert_text((180.0, 118.41), "2x", fontsize=7.5)
            p1.insert_text((180.0, 125.61), "302401", fontsize=7.5)
            doc.save(pdf_path)
            doc.close()

            result = ExtractionPipeline([PyMuPDFBOMExtractor()]).run(pdf_path)
            by_id = {item.element_id: item.quantity for item in result.items}
            self.assertEqual(by_id.get("4550359"), 1)
            self.assertNotIn("45503", by_id)
            self.assertEqual(by_id.get("6075179"), 6)
            self.assertEqual(by_id.get("302401"), 2)


if __name__ == "__main__":
    unittest.main()
