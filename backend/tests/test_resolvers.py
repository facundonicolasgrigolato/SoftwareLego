"""Tests unitarios para `SQLiteCatalogResolver`, `OverrideResolver` y `ResolverChain`."""

from __future__ import annotations

import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.db.catalog import build_catalog_database  # noqa: E402
from app.models import ExtractedPartItem  # noqa: E402
from app.resolvers.base import ResolverChain  # noqa: E402
from app.resolvers.override_resolver import OverrideResolver  # noqa: E402
from app.resolvers.sqlite_resolver import SQLiteCatalogResolver  # noqa: E402


def _write_gz(path: Path, content: str) -> None:
    with gzip.open(path, "wt", encoding="utf-8", newline="") as fh:
        fh.write(content)


class TestResolvers(unittest.TestCase):
    def _create_fixture_catalog(self, root: Path) -> tuple[Path, Path]:
        rb_dir = root / "rebrickable"
        ldraw_dir = root / "ldraw"
        (ldraw_dir / "parts").mkdir(parents=True)
        rb_dir.mkdir(parents=True)

        (ldraw_dir / "LDConfig.ldr").write_text(
            "0 !COLOUR White CODE 15 VALUE #FFFFFF EDGE #333333\n"
            "0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333\n",
            encoding="utf-8",
        )
        (ldraw_dir / "parts" / "3024.dat").write_text("0 Plate  1 x  1\n", encoding="utf-8")
        (ldraw_dir / "parts" / "87079.dat").write_text("0 Tile  2 x  4\n", encoding="utf-8")

        _write_gz(
            rb_dir / "colors.csv.gz",
            "id,name,rgb,is_trans,num_parts,num_sets,y1,y2\n"
            "15,White,FFFFFF,False,1,1,1950,2026\n"
            "4,Red,C91A09,False,1,1,1950,2026\n",
        )
        _write_gz(
            rb_dir / "parts.csv.gz",
            "part_num,name,part_cat_id,part_material\n"
            "3024,Plate 1 x 1,14,Plastic\n"
            "87079pr9974,Tile 2 x 4 Printed,19,Plastic\n"
            "87079,Tile 2 x 4,19,Plastic\n"
            "99999,Missing Mold,19,Plastic\n",
        )
        _write_gz(
            rb_dir / "elements.csv.gz",
            "element_id,part_num,color_id,design_id\n"
            "302401,3024,15,3024\n"
            "6500001,87079pr9974,4,\n"
            "6500002,99999,15,\n",
        )
        _write_gz(
            rb_dir / "part_relationships.csv.gz",
            "rel_type,child_part_num,parent_part_num\n"
            "P,87079pr9974,87079\n",
        )
        _write_gz(
            rb_dir / "sets.csv.gz",
            "set_num,name,year,theme_id,num_parts,img_url\n"
            "60312-1,Police Car,2022,1,94,https://example.com/1.jpg\n",
        )

        db_path = root / "catalog.sqlite"
        build_catalog_database(db_path, rb_dir, ldraw_dir)
        overrides_path = root / "overrides.json"
        overrides_path.write_text(
            json.dumps(
                {
                    "element_overrides": {
                        "7777777": {
                            "ldraw_part_id": "3024",
                            "color_rgb": "FF00FF",
                            "ldraw_color_code": 15,
                            "note": "Manual override",
                        }
                    }
                }
            ),
            encoding="utf-8",
        )
        return db_path, overrides_path

    def test_exact_fallback_override_and_unresolved(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path, overrides_path = self._create_fixture_catalog(Path(tmp))
            with SQLiteCatalogResolver(db_path) as sqlite_res:
                self.assertEqual(sqlite_res.lookup_set_name("60312"), "Police Car")
                chain = ResolverChain([OverrideResolver(overrides_path), sqlite_res])
                results = chain.resolve_all(
                    [
                        ExtractedPartItem("302401", 2, [10]),
                        ExtractedPartItem("6500001", 1, [10]),
                        ExtractedPartItem("6500002", 3, [10]),
                        ExtractedPartItem("7777777", 4, [11]),
                        ExtractedPartItem("8888888", 1, [11]),
                    ]
                )

            by_id = {r.element_id: r for r in results}
            self.assertEqual(by_id["302401"].status, "exact")
            self.assertEqual(by_id["302401"].ldraw_file, "parts/3024.dat")
            self.assertEqual(by_id["302401"].ldraw_color_code, 15)

            self.assertEqual(by_id["6500001"].status, "fallback_mold")
            self.assertEqual(by_id["6500001"].ldraw_file, "parts/87079.dat")
            self.assertEqual(by_id["6500001"].color_rgb, "#C91A09")

            self.assertEqual(by_id["6500002"].status, "unresolved")
            self.assertEqual(by_id["7777777"].status, "override")
            self.assertEqual(by_id["7777777"].ldraw_part_id, "3024")
            self.assertEqual(by_id["8888888"].status, "unresolved")

    def test_online_hybrid_resolver_unofficial_subparts_and_cache(self) -> None:
        from app.config import AppPaths
        from app.resolvers.online_resolver import OnlineHybridResolver

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path, overrides_path = self._create_fixture_catalog(root)
            ldraw_dir = root / "ldraw"
            (ldraw_dir / "parts" / "3626c.dat").write_text("0 Minifig Head\n", encoding="utf-8")

            paths = AppPaths(
                root_dir=root,
                sets_dir=root / "Sets",
                data_dir=root,
                rebrickable_dir=root / "rebrickable",
                ldraw_dir=ldraw_dir,
                omr_dir=root / "omr",
                catalog_db_path=db_path,
                overrides_path=overrides_path,
                api_cache_path=root / "api_cache.json",
                api_config_path=root / "api_config.json",
                output_sets_dir=root / "out_sets",
                output_covers_dir=root / "out_covers",
            )
            paths.ensure_directories()

            with SQLiteCatalogResolver(db_path) as sqlite_res:
                online_res = OnlineHybridResolver(paths=paths, sqlite_conn=sqlite_res._conn, allow_network=True)
                online_res.api_key = "fake_key"

                def fake_http_result(url: str, headers: dict | None = None) -> tuple[str | None, bool]:
                    if url.endswith("/parts/99999.dat"):
                        return "0 Unofficial Part 99999\r\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\99999s01.dat\r\n", False
                    if url.endswith("/parts/s/99999s01.dat"):
                        return "0 Subpart 99999s01\r\n3 16 0 0 0 1 0 0 0 1 0\r\n", False
                    return None, True

                def fake_rb(endpoint: str) -> dict | None:
                    if endpoint.startswith("elements/9990001/"):
                        return {
                            "design_id": "3626",
                            "part": {"part_num": "112099pr0001", "name": "Minifig Head Special, Demo"},
                            "color": {"id": 14, "name": "Yellow", "rgb": "F2CD37", "is_trans": False, "external_ids": {"LDraw": {"ext_ids": [14]}}},
                        }
                    return None

                online_res._http_get_result = fake_http_result  # type: ignore[method-assign]
                online_res._fetch_rebrickable_json = fake_rb  # type: ignore[method-assign]

                chain = ResolverChain([OverrideResolver(overrides_path), sqlite_res, online_res])
                results = chain.resolve_all(
                    [
                        ExtractedPartItem("6500002", 2, [5]),
                        ExtractedPartItem("9990001", 1, [6]),
                    ]
                )
                online_res.flush_cache()

            by_id = {r.element_id: r for r in results}
            self.assertEqual(by_id["6500002"].status, "api_online")
            self.assertEqual(by_id["6500002"].ldraw_file, "parts/99999.dat")
            self.assertTrue((ldraw_dir / "parts" / "99999.dat").is_file())
            self.assertTrue((ldraw_dir / "parts" / "s" / "99999s01.dat").is_file())
            self.assertNotIn(b"\r", (ldraw_dir / "parts" / "99999.dat").read_bytes())

            # Elemento desconocido en SQLite resuelto vía Rebrickable API mock + proxy Minifig Head
            self.assertEqual(by_id["9990001"].status, "fallback_mold")
            self.assertEqual(by_id["9990001"].ldraw_part_id, "3626c")
            self.assertEqual(by_id["9990001"].ldraw_color_code, 14)

            # Verificar que la caché persistió en api_cache.json
            cache_data = json.loads((root / "api_cache.json").read_text(encoding="utf-8"))
            self.assertIn("9990001", cache_data["elements"])

    def test_transient_network_error_not_cached_as_unofficial_miss(self) -> None:
        from app.config import AppPaths
        from app.resolvers.online_resolver import OnlineHybridResolver

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path, overrides_path = self._create_fixture_catalog(root)
            paths = AppPaths(
                root_dir=root,
                sets_dir=root / "Sets",
                data_dir=root,
                rebrickable_dir=root / "rebrickable",
                ldraw_dir=root / "ldraw",
                omr_dir=root / "omr",
                catalog_db_path=db_path,
                overrides_path=overrides_path,
                api_cache_path=root / "api_cache.json",
                api_config_path=root / "api_config.json",
                output_sets_dir=root / "out_sets",
                output_covers_dir=root / "out_covers",
            )
            paths.ensure_directories()

            with SQLiteCatalogResolver(db_path) as sqlite_res:
                online_res = OnlineHybridResolver(paths=paths, sqlite_conn=sqlite_res._conn, allow_network=True)
                # Simula timeout/429 transitorio (is_404 = False)
                online_res._http_get_result = lambda url, headers=None: (None, False)  # type: ignore[method-assign]
                self.assertIsNone(online_res._try_unofficial_ldraw("88888", ExtractedPartItem("8888801", 1, [1])))
                self.assertNotIn("88888", online_res._cache["unofficial_misses"])
                # Un 404 definitivo sí se registra en unofficial_misses
                online_res._http_get_result = lambda url, headers=None: (None, True)  # type: ignore[method-assign]
                self.assertIsNone(online_res._try_unofficial_ldraw("88888", ExtractedPartItem("8888801", 1, [1])))
                self.assertIn("88888", online_res._cache["unofficial_misses"])

    def test_invalid_html_or_corrupt_dat_is_rejected(self) -> None:
        from app.resolvers.online_resolver import _is_valid_ldraw_content

        self.assertFalse(_is_valid_ldraw_content("<html><body>0 Error 1</body></html>"))
        self.assertFalse(_is_valid_ldraw_content("0 Valid header\nbad line\n"))
        self.assertTrue(_is_valid_ldraw_content("\ufeff0 Part\r\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\a.dat\r\n"))


if __name__ == "__main__":
    unittest.main()
