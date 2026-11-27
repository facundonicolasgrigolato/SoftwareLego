from __future__ import annotations

import csv
import gzip
import io
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pymupdf  # noqa: E402

from app.db.catalog import (  # noqa: E402
    build_catalog_database,
    match_ldraw_color_code,
    parse_ldconfig,
)
from app.models import ExtractedPartItem  # noqa: E402
from app.resolvers.sqlite_resolver import SQLiteCatalogResolver  # noqa: E402
from app.sequencers.pdf_bag_analyzer import detect_bag_page_ranges  # noqa: E402


def _write_csv_gz(path: Path, fieldnames: list[str], rows: list[list[str]]) -> None:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(fieldnames)
    writer.writerows(rows)
    with gzip.open(path, "wt", encoding="utf-8", newline="") as fh:
        fh.write(buf.getvalue())


class TestCatalogAndBagAnalyzer(unittest.TestCase):
    def test_ldconfig_and_color_matching(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            ldconfig = Path(tmp) / "LDConfig.ldr"
            ldconfig.write_text(
                "\n".join([
                    "0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE 33",
                    "0 !COLOUR Trans_Clear CODE 47 VALUE #FCFCFC EDGE 33 ALPHA 128",
                    "0 !COLOUR Chrome_Silver CODE 383 VALUE #E0E0E0 EDGE 33 CHROME",
                ]),
                encoding="utf-8",
            )
            colors = parse_ldconfig(ldconfig)
            self.assertEqual(len(colors), 3)
            self.assertEqual(colors[1]["alpha"], 128)
            self.assertEqual(colors[2]["finish"], "CHROME")

            self.assertEqual(match_ldraw_color_code(4, "C91A09", False, colors), 4)
            # Transparent color skips opaque #C91A09 and chooses ALPHA < 255 entry
            self.assertEqual(match_ldraw_color_code(99, "FCFCFC", True, colors), 47)

    def test_build_catalog_database_and_sqlite_resolver(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rb_dir = root / "rebrickable"
            ldraw_dir = root / "ldraw"
            parts_dir = ldraw_dir / "parts"
            rb_dir.mkdir(parents=True, exist_ok=True)
            parts_dir.mkdir(parents=True, exist_ok=True)

            (ldraw_dir / "LDConfig.ldr").write_text(
                "0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE 33\n",
                encoding="utf-8",
            )
            (parts_dir / "3001.dat").write_text("0 Brick 2 x 4\n", encoding="utf-8")
            (parts_dir / "98765.dat").write_text(
                "0 Part With Alias\n0 !KEYWORDS Rebrickable 54321\n",
                encoding="utf-8",
            )

            _write_csv_gz(rb_dir / "colors.csv.gz", ["id", "name", "rgb", "is_trans"], [["4", "Red", "C91A09", "False"]])
            _write_csv_gz(
                rb_dir / "parts.csv.gz",
                ["part_num", "name", "part_cat_id", "part_material"],
                [
                    ["3001", "Brick 2 x 4", "11", "Plastic"],
                    ["3001pr0001", "Brick 2 x 4 Printed", "11", "Plastic"],
                    ["54321", "Alias Brick", "11", "Plastic"],
                ],
            )
            _write_csv_gz(
                rb_dir / "elements.csv.gz",
                ["element_id", "part_num", "color_id", "design_id"],
                [
                    ["300121", "3001", "4", "3001"],
                    ["999001", "3001pr0001", "4", "3001pr0001"],
                    ["999002", "54321", "4", "54321"],
                ],
            )
            _write_csv_gz(
                rb_dir / "part_relationships.csv.gz",
                ["rel_type", "child_part_num", "parent_part_num"],
                [["P", "3001pr0001", "3001"]],
            )
            _write_csv_gz(
                rb_dir / "sets.csv.gz",
                ["set_num", "name", "year", "theme_id", "num_parts"],
                [["75300-1", "Test Fighter", "2021", "158", "10"]],
            )

            db_path = root / "catalog.sqlite"
            counts = build_catalog_database(db_path, rb_dir, ldraw_dir)
            self.assertEqual(counts["ldraw_parts"], 2)
            self.assertEqual(counts["ldraw_keyword_aliases"], 1)

            with SQLiteCatalogResolver(db_path) as resolver:
                self.assertEqual(resolver.lookup_set_name("75300"), "Test Fighter")

                direct = resolver.resolve(ExtractedPartItem("300121", 2, [1]))
                self.assertIsNotNone(direct)
                self.assertEqual(direct.status, "exact")
                self.assertEqual(direct.ldraw_part_id, "3001")

                printed = resolver.resolve(ExtractedPartItem("999001", 1, [2]))
                self.assertIsNotNone(printed)
                self.assertEqual(printed.status, "fallback_mold")
                self.assertEqual(printed.ldraw_part_id, "3001")

                aliased = resolver.resolve(ExtractedPartItem("999002", 1, [3]))
                self.assertIsNotNone(aliased)
                self.assertEqual(aliased.status, "fallback_mold")
                self.assertEqual(aliased.ldraw_part_id, "98765")

    def test_detect_bag_page_ranges_from_synthetic_pdf(self) -> None:
        doc = pymupdf.open()
        try:
            # Page 1: Cover
            p1 = doc.new_page(width=400, height=300)
            p1.insert_text((40, 60), "LEGO 75300", fontsize=18)
            # Page 2: Bag 1 separator + Page 3 step
            p2 = doc.new_page(width=400, height=300)
            p2.insert_text((180, 150), "1", fontsize=48)
            doc.new_page(width=400, height=300).insert_text((40, 60), "Step 1", fontsize=14)
            # Page 4: Bag 2 separator + Page 5 step
            p4 = doc.new_page(width=400, height=300)
            p4.insert_text((180, 150), "2", fontsize=48)
            doc.new_page(width=400, height=300).insert_text((40, 60), "Step 2", fontsize=14)
            # Page 6: BOM
            doc.new_page(width=400, height=300).insert_text((40, 60), "BOM 300121 2x", fontsize=12)

            ranges = detect_bag_page_ranges(doc, stop_before_page_1idx=6)
            self.assertEqual(len(ranges), 2)
            self.assertEqual((ranges[0].bag_number, ranges[0].start_page_1idx, ranges[0].end_page_1idx), (1, 2, 3))
            self.assertEqual((ranges[1].bag_number, ranges[1].start_page_1idx, ranges[1].end_page_1idx), (2, 4, 5))
        finally:
            doc.close()


if __name__ == "__main__":
    unittest.main()
