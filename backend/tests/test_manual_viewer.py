"""Tests unitarios para el visor de manuales PDF."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import pymupdf

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.manual_viewer import find_set_pdf, get_manual_info, render_manual_page_png  # noqa: E402


class TestManualViewer(unittest.TestCase):
    def test_find_set_pdf_fallback_on_renamed_file_and_render_png(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sets_dir = Path(tmp) / "Sets"
            sets_dir.mkdir(parents=True, exist_ok=True)
            pdf_path = sets_dir / "bob_esponja_renombrado.pdf"

            doc = pymupdf.open()
            p0 = doc.new_page()
            p0.insert_text((72, 72), "40858\nSpongeBob SquarePants")
            p1 = doc.new_page()
            p1.insert_text((72, 72), "Step 1")
            doc.save(pdf_path)
            doc.close()

            found = find_set_pdf(sets_dir, "40858", "6668527.pdf")
            self.assertEqual(found, pdf_path)

            info = get_manual_info(pdf_path)
            self.assertEqual(info["pageCount"], 2)
            self.assertEqual(info["filename"], "bob_esponja_renombrado.pdf")
            self.assertEqual(len(info["pageAspects"]), 2)
            self.assertGreater(info["pageAspects"][0], 1.0)

            png_bytes = render_manual_page_png(pdf_path, 99, scale=1.5)
            self.assertTrue(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))


if __name__ == "__main__":
    unittest.main()
