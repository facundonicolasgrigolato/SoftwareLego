"""Tests unitarios del secuenciador híbrido (OMR comunitario + fallback por bolsas)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.models import ResolvedPart  # noqa: E402
from app.sequencers.omr_sequencer import parse_omr_sequence  # noqa: E402


SAMPLE_MPD = """0 FILE main.ldr
1 14 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
0 STEP
1 16 40 -24 0 1 0 0 0 1 0 0 0 1 sub.ldr
0 NOFILE
0 FILE sub.ldr
1 4 0 0 20 1 0 0 0 1 0 0 0 1 3023.dat
1 1 80 0 20 1 0 0 0 1 0 0 0 1 3024.dat
0 NOFILE
"""


class TestSequencers(unittest.TestCase):
    def test_parse_omr_sequence_expands_submodels_and_bounds(self) -> None:
        res = parse_omr_sequence(SAMPLE_MPD, source_label="test")
        self.assertEqual(res.ordered_parts, [("3001", 14), ("3023", 4), ("3024", 1)])
        self.assertIsNotNone(res.bounds_ldu)
        assert res.bounds_ldu is not None
        w, h, d = res.bounds_ldu
        self.assertAlmostEqual(w, 240.0)  # (120 - 0) + 120
        self.assertGreater(h, 80.0)
        self.assertAlmostEqual(d, 140.0)  # (20 - 0) + 120

    def test_hybrid_sequencer_uses_local_omr_and_chunks_large_sets(self) -> None:
        from app.sequencers.hybrid_sequencer import sequence_manifest_parts
        import pymupdf

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            omr_dir = tmp_path / "omr"
            omr_dir.mkdir(parents=True)
            (omr_dir / "99999.mpd").write_text(SAMPLE_MPD, encoding="utf-8")

            pdf_path = tmp_path / "dummy.pdf"
            doc = pymupdf.open()
            doc.new_page()
            doc.save(str(pdf_path))
            doc.close()

            parts = [
                ResolvedPart(element_id="1", quantity=120, status="exact", ldraw_part_id="3001", ldraw_color_code=14),
                ResolvedPart(element_id="2", quantity=120, status="exact", ldraw_part_id="3023", ldraw_color_code=4),
                ResolvedPart(element_id="3", quantity=80, status="exact", ldraw_part_id="3024", ldraw_color_code=1),
            ]
            seq_src, bags, layout = sequence_manifest_parts(
                pdf_path=pdf_path,
                set_number="99999",
                inventory_pages=[1],
                resolved_parts=parts,
                omr_dir=omr_dir,
                allow_network=False,
            )
            self.assertEqual(seq_src, "omr_community")
            self.assertEqual(sum(b["piece_count"] for b in bags), 320)
            self.assertGreaterEqual(len(bags), 2)
            for p in parts:
                self.assertEqual(sum(p.bag_counts.values()), p.quantity)
            self.assertGreaterEqual(layout["build_zone"]["width_ldu"], 800)


if __name__ == "__main__":
    unittest.main()
