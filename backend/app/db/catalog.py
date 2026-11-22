"""Construcción y consulta del catálogo SQLite offline (Rebrickable + LDraw)."""

from __future__ import annotations

import csv
import gzip
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from app.db.schema import reset_database

COLOUR_RE = re.compile(
    r"^0\s+!COLOUR\s+(?P<name>\S+)\s+CODE\s+(?P<code>-?\d+)\s+VALUE\s+#?(?P<rgb>[0-9A-Fa-f]{6})(?P<rest>.*)$"
)
ALPHA_RE = re.compile(r"\bALPHA\s+(\d+)")
FINISH_KEYWORDS = ("CHROME", "PEARLESCENT", "RUBBER", "MATTE_METALLIC", "METAL")
REBRICKABLE_KEYWORD_RE = re.compile(r"\bRebrickable\s+([A-Za-z0-9._-]+)", re.IGNORECASE)
PATTERN_SUFFIX_RE = re.compile(r"(?:p[0-9a-z]|d[0-9a-z])", re.IGNORECASE)


def parse_ldconfig(ldconfig_path: Path) -> list[dict]:
    """Extrae definiciones de color desde `LDConfig.ldr`."""
    if not ldconfig_path.exists():
        return []

    colors: list[dict] = []
    with ldconfig_path.open("r", encoding="utf-8", errors="replace") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            match = COLOUR_RE.match(line)
            if not match:
                continue
            rest = match.group("rest")
            alpha_match = ALPHA_RE.search(rest)
            alpha = int(alpha_match.group(1)) if alpha_match else 255
            finish = next((kw for kw in FINISH_KEYWORDS if re.search(rf"\b{kw}\b", rest)), None)
            colors.append(
                {
                    "code": int(match.group("code")),
                    "name": match.group("name"),
                    "rgb": match.group("rgb").upper(),
                    "alpha": alpha,
                    "finish": finish,
                }
            )
    return colors


def _rgb_distance_sq(rgb_a: str, rgb_b: str) -> int:
    ra, ga, ba = int(rgb_a[0:2], 16), int(rgb_a[2:4], 16), int(rgb_a[4:6], 16)
    rb, gb, bb = int(rgb_b[0:2], 16), int(rgb_b[2:4], 16), int(rgb_b[4:6], 16)
    return (ra - rb) ** 2 + (ga - gb) ** 2 + (ba - bb) ** 2


def match_ldraw_color_code(
    rb_id: int,
    rb_rgb: str,
    is_trans: bool,
    ldraw_colors: list[dict],
) -> int | None:
    """Encuentra el código de color LDraw más fiel para un color Rebrickable."""
    if not ldraw_colors:
        return None

    by_code = {c["code"]: c for c in ldraw_colors}
    clean_rgb = rb_rgb.strip().lstrip("#").upper()
    if len(clean_rgb) != 6:
        return rb_id if rb_id in by_code else None

    direct = by_code.get(rb_id)
    if direct and bool(direct["alpha"] < 255) == is_trans and _rgb_distance_sq(direct["rgb"], clean_rgb) <= 900:
        return rb_id

    same_trans = [c for c in ldraw_colors if (c["alpha"] < 255) == is_trans]
    pool = same_trans if same_trans else ldraw_colors
    best = min(pool, key=lambda c: _rgb_distance_sq(c["rgb"], clean_rgb))
    return int(best["code"])


def _iter_csv_rows(csv_gz_path: Path) -> Iterable[dict[str, str]]:
    with gzip.open(csv_gz_path, "rt", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh)
        yield from reader


def _find_ldraw_root(ldraw_dir: Path) -> Path:
    """Soporta tanto `data/ldraw/parts` como `data/ldraw/ldraw/parts`."""
    if (ldraw_dir / "parts").is_dir():
        return ldraw_dir
    nested = ldraw_dir / "ldraw"
    if (nested / "parts").is_dir():
        return nested
    return ldraw_dir


def _alias_candidate_rank(ldraw_id: str, title: str | None, is_alias_org: bool) -> tuple[int, int, int, int, str]:
    """Prioriza moldes base limpios sobre auxiliares (`~`), alias oficiales o variantes impresas."""
    t = (title or "").strip()
    is_aux = 1 if (t.startswith("~") or t.startswith("_") or t.startswith("=")) else 0
    is_pattern = 1 if PATTERN_SUFFIX_RE.search(ldraw_id) else 0
    return (is_aux, 1 if is_alias_org else 0, is_pattern, len(ldraw_id), ldraw_id)


def index_ldraw_parts_and_aliases(
    ldraw_dir: Path,
) -> tuple[list[tuple[str, str, str | None]], list[tuple[str, str]]]:
    """
    Indexa `.dat` principales de `parts/` y extrae mapeos `Rebrickable <id>` desde `0 !KEYWORDS`.
    Ante colisiones, conserva determinísticamente el molde base más limpio.
    """
    root = _find_ldraw_root(ldraw_dir)
    parts_dir = root / "parts"
    if not parts_dir.is_dir():
        return [], []

    rows: list[tuple[str, str, str | None]] = []
    best_aliases: dict[str, tuple[tuple[int, int, int, int, str], str]] = {}

    for dat_path in parts_dir.glob("*.dat"):
        ldraw_id = dat_path.stem.lower()
        rel_path = f"parts/{dat_path.name}"
        title: str | None = None
        is_alias_org = False
        rb_keywords: list[str] = []

        try:
            with dat_path.open("r", encoding="utf-8", errors="replace") as fh:
                for line_idx in range(30):
                    raw = fh.readline()
                    if not raw:
                        break
                    line = raw.strip()
                    if not line:
                        continue
                    if not line.startswith("0"):
                        break
                    if line_idx == 0 and line.startswith("0 "):
                        title = line[2:].strip()
                    elif line.startswith("0 !LDRAW_ORG") and "Alias" in line:
                        is_alias_org = True
                    elif line.startswith("0 !KEYWORDS"):
                        rb_keywords.extend(REBRICKABLE_KEYWORD_RE.findall(line))
        except OSError:
            title = None

        rows.append((ldraw_id, rel_path, title))
        if rb_keywords:
            rank = _alias_candidate_rank(ldraw_id, title, is_alias_org)
            for raw_rb in rb_keywords:
                rb_key = raw_rb.strip().lower()
                if not rb_key:
                    continue
                prev = best_aliases.get(rb_key)
                if prev is None or rank < prev[0]:
                    best_aliases[rb_key] = (rank, ldraw_id)

    alias_rows = [(rb_key, pair[1]) for rb_key, pair in best_aliases.items()]
    return rows, alias_rows


def index_ldraw_parts(ldraw_dir: Path) -> list[tuple[str, str, str | None]]:
    """Indexa archivos `.dat` principales de `parts/` (excluyendo sub-partes `s/`)."""
    rows, _ = index_ldraw_parts_and_aliases(ldraw_dir)
    return rows


def build_catalog_database(
    db_path: Path,
    rebrickable_dir: Path,
    ldraw_dir: Path,
) -> dict[str, int]:
    """Construye `catalog.sqlite` desde los CSVs de Rebrickable y la biblioteca LDraw."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    ldraw_root = _find_ldraw_root(ldraw_dir)
    ldconfig_path = ldraw_root / "LDConfig.ldr"

    conn = sqlite3.connect(db_path)
    try:
        reset_database(conn)

        # 1. Colores LDraw
        ldraw_colors = parse_ldconfig(ldconfig_path)
        conn.executemany(
            "INSERT INTO ldraw_colors (code, name, rgb, alpha, finish) VALUES (?, ?, ?, ?, ?)",
            [(c["code"], c["name"], c["rgb"], c["alpha"], c["finish"]) for c in ldraw_colors],
        )

        # 2. Colores Rebrickable
        colors_rows = []
        colors_path = rebrickable_dir / "colors.csv.gz"
        if colors_path.exists():
            for row in _iter_csv_rows(colors_path):
                cid = int(row["id"])
                is_trans = 1 if row.get("is_trans", "").strip().lower() == "true" else 0
                rgb = row.get("rgb", "000000").strip().upper()
                ldraw_code = match_ldraw_color_code(cid, rgb, bool(is_trans), ldraw_colors)
                colors_rows.append((cid, row["name"].strip(), rgb, is_trans, ldraw_code))
            conn.executemany(
                "INSERT INTO colors (id, name, rgb, is_trans, ldraw_code) VALUES (?, ?, ?, ?, ?)",
                colors_rows,
            )

        # 3. Piezas Rebrickable
        parts_rows = []
        parts_path = rebrickable_dir / "parts.csv.gz"
        if parts_path.exists():
            for row in _iter_csv_rows(parts_path):
                cat_raw = row.get("part_cat_id", "").strip()
                parts_rows.append(
                    (
                        row["part_num"].strip(),
                        row["name"].strip(),
                        int(cat_raw) if cat_raw else None,
                        row.get("part_material", "").strip() or None,
                    )
                )
            conn.executemany(
                "INSERT INTO parts (part_num, name, part_cat_id, part_material) VALUES (?, ?, ?, ?)",
                parts_rows,
            )

        # 4. Elements (Element ID -> Part + Color + Design ID)
        elements_rows = []
        elements_path = rebrickable_dir / "elements.csv.gz"
        if elements_path.exists():
            for row in _iter_csv_rows(elements_path):
                elements_rows.append(
                    (
                        row["element_id"].strip(),
                        row["part_num"].strip(),
                        int(row["color_id"]),
                        row.get("design_id", "").strip() or None,
                    )
                )
            conn.executemany(
                "INSERT OR REPLACE INTO elements (element_id, part_num, color_id, design_id) VALUES (?, ?, ?, ?)",
                elements_rows,
            )

        # 5. Relaciones entre piezas (Print -> Base Mold, Mold -> Alt, etc.)
        rel_rows = []
        rel_path = rebrickable_dir / "part_relationships.csv.gz"
        if rel_path.exists():
            for row in _iter_csv_rows(rel_path):
                rel_rows.append(
                    (
                        row["rel_type"].strip(),
                        row["child_part_num"].strip(),
                        row["parent_part_num"].strip(),
                    )
                )
            conn.executemany(
                "INSERT INTO part_relationships (rel_type, child_part_num, parent_part_num) VALUES (?, ?, ?)",
                rel_rows,
            )

        # 6. Sets Rebrickable (para enriquecer metadatos desde el número de set de la portada)
        sets_rows = []
        sets_path = rebrickable_dir / "sets.csv.gz"
        if sets_path.exists():
            for row in _iter_csv_rows(sets_path):
                year_raw = row.get("year", "").strip()
                theme_raw = row.get("theme_id", "").strip()
                num_parts_raw = row.get("num_parts", "").strip()
                sets_rows.append(
                    (
                        row["set_num"].strip(),
                        row["name"].strip(),
                        int(year_raw) if year_raw else None,
                        int(theme_raw) if theme_raw else None,
                        int(num_parts_raw) if num_parts_raw else None,
                    )
                )
            conn.executemany(
                "INSERT INTO sets (set_num, name, year, theme_id, num_parts) VALUES (?, ?, ?, ?, ?)",
                sets_rows,
            )

        # 7. Piezas LDraw locales y alias `!KEYWORDS Rebrickable`
        ldraw_parts_rows, alias_rows = index_ldraw_parts_and_aliases(ldraw_dir)
        conn.executemany(
            "INSERT OR REPLACE INTO ldraw_parts (ldraw_id, rel_path, title) VALUES (?, ?, ?)",
            ldraw_parts_rows,
        )
        conn.executemany(
            "INSERT OR REPLACE INTO ldraw_keyword_aliases (rb_part_num, ldraw_id) VALUES (?, ?)",
            alias_rows,
        )

        counts = {
            "ldraw_colors": len(ldraw_colors),
            "colors": len(colors_rows),
            "parts": len(parts_rows),
            "elements": len(elements_rows),
            "part_relationships": len(rel_rows),
            "sets": len(sets_rows),
            "ldraw_parts": len(ldraw_parts_rows),
            "ldraw_keyword_aliases": len(alias_rows),
        }

        meta = [
            ("built_at", datetime.now(timezone.utc).isoformat()),
            ("ldraw_root", str(ldraw_root)),
            *[(f"count_{k}", str(v)) for k, v in counts.items()],
        ]
        conn.executemany("INSERT INTO metadata (key, value) VALUES (?, ?)", meta)
        conn.commit()
        return counts
    finally:
        conn.close()
