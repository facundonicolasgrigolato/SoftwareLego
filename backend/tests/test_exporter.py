"""Tests unitarios para el exportador JSON (`json_exporter.py`)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.exporters.json_exporter import build_manifest, export_manifest_json  # noqa: E402
from app.models import ExtractedPartItem, PDFExtractionResult, ResolvedPart  # noqa: E402


class TestExporter(unittest.TestCase):
    def test_build_and_export_manifest_stats(self) -> None:
        extraction = PDFExtractionResult(
            pdf_filename="demo.pdf",
            set_number="12345",
            total_pages=20,
            inventory_pages=[19],
            extractor_used="pymupdf_bom_v1",
            items=[ExtractedPartItem("302401", 3, [19]), ExtractedPartItem("999", 1, [19])],
        )
        parts = [
            ResolvedPart(element_id="302401", quantity=3, status="exact", ldraw_file="parts/3024.dat"),
            ResolvedPart(element_id="999", quantity=1, status="unresolved"),
        ]
        manifest = build_manifest(extraction, parts, set_name="Demo Car")
        self.assertEqual(manifest.stats["total_pieces"], 4)
        self.assertEqual(manifest.stats["resolved_pieces"], 3)
        self.assertEqual(manifest.stats["coverage_percent"], 75.0)

        with tempfile.TemporaryDirectory() as tmp:
            out_path = export_manifest_json(manifest, Path(tmp) / "12345.json")
            loaded = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(loaded["set_name"], "Demo Car")
            self.assertEqual(len(loaded["parts"]), 2)


if __name__ == "__main__":
    unittest.main()
