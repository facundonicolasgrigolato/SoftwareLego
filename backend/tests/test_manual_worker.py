from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

import pymupdf

from scripts.manual_worker import ManualWorker


def _create_sample_pdf(path: Path, pages: int = 2) -> None:
    doc = pymupdf.open()
    for idx in range(pages):
        page = doc.new_page(width=200, height=100)
        page.insert_text((20, 40), f"Step {idx + 1}")
    doc.save(path)
    doc.close()


class ManualWorkerTests(unittest.TestCase):
    def test_info_page_and_clear_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sets_dir = Path(tmp)
            pdf_path = sets_dir / "75300-1.pdf"
            _create_sample_pdf(pdf_path, pages=2)

            worker = ManualWorker(sets_dir=sets_dir)
            try:
                info = worker.handle_request({
                    "id": 1,
                    "action": "info",
                    "set": "75300",
                    "source": pdf_path.name,
                })
                self.assertTrue(info["ok"])
                self.assertEqual(info["id"], 1)
                self.assertEqual(info["payload"]["pageCount"], 2)
                self.assertEqual(info["payload"]["filename"], pdf_path.name)
                self.assertEqual(info["payload"]["pageAspects"], [0.5, 0.5])

                page_resp = worker.handle_request({
                    "id": 2,
                    "action": "page",
                    "set": "75300",
                    "source": pdf_path.name,
                    "page": 2,
                    "scale": 1.5,
                })
                self.assertTrue(page_resp["ok"])
                png_bytes = base64.b64decode(page_resp["png_b64"])
                self.assertTrue(png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))

                cleared = worker.handle_request({"id": 3, "action": "clear_cache"})
                self.assertEqual(cleared, {"id": 3, "ok": True})
                self.assertEqual(len(worker._docs), 0)
                self.assertEqual(len(worker._path_cache), 0)
            finally:
                worker.clear_cache()

    def test_missing_pdf_and_unknown_action(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            sets_dir = Path(tmp)
            pdf_path = sets_dir / "10295.pdf"
            _create_sample_pdf(pdf_path, pages=1)

            worker = ManualWorker(sets_dir=sets_dir)
            try:
                missing = worker.handle_request({
                    "id": 10,
                    "action": "info",
                    "set": "99999",
                })
                self.assertFalse(missing["ok"])
                self.assertEqual(missing["id"], 10)

                unknown = worker.handle_request({
                    "id": 11,
                    "action": "unknown_op",
                    "set": "10295",
                    "source": pdf_path.name,
                })
                self.assertFalse(unknown["ok"])
                self.assertIn("unknown_op", unknown["error"])
            finally:
                worker.clear_cache()


if __name__ == "__main__":
    unittest.main()
