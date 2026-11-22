"""Resolvedor offline contra `data/catalog.sqlite` (Rebrickable + LDraw)."""

from __future__ import annotations

import re
import sqlite3
from collections import deque
from pathlib import Path

from app.models import ExtractedPartItem, ResolvedPart
from app.resolvers.base import BasePartResolver

PRINT_SUFFIX_RE = re.compile(r"^(.+?)(?:pr\d+|pat\d+|c\d+)$", re.IGNORECASE)
MOLD_REVISION_RE = re.compile(r"^(\d{3,6})[a-z]$", re.IGNORECASE)
RELATION_PRIORITY = ("P", "M", "A")


class SQLiteCatalogResolver(BasePartResolver):
    """Traduce `element_id` usando Rebrickable + relaciones de molde + índice LDraw."""

    name = "sqlite_catalog"

    def __init__(self, db_path: Path) -> None:
        if not db_path.exists():
            raise FileNotFoundError(
                f"No existe la base de catálogo '{db_path}'. Ejecutá primero scripts/setup_catalog.py."
            )
        self.db_path = db_path
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        self._has_keyword_aliases = bool(
            self._conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ldraw_keyword_aliases'"
            ).fetchone()
        )

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "SQLiteCatalogResolver":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def lookup_set_name(self, set_number: str | None) -> str | None:
        """Busca el nombre oficial del set en Rebrickable (`10352` -> `10352-1`)."""
        if not set_number:
            return None
        for candidate in (f"{set_number}-1", set_number):
            row = self._conn.execute(
                "SELECT name FROM sets WHERE set_num = ?", (candidate,)
            ).fetchone()
            if row:
                return str(row["name"])
        return None

    def _find_ldraw_part(self, candidate_id: str | None) -> sqlite3.Row | None:
        if not candidate_id:
            return None
        return self._conn.execute(
            "SELECT ldraw_id, rel_path, title FROM ldraw_parts WHERE ldraw_id = ?",
            (candidate_id.strip().lower(),),
        ).fetchone()

    def _find_ldraw_by_keyword_alias(self, candidate_id: str | None) -> sqlite3.Row | None:
        if not candidate_id or not self._has_keyword_aliases:
            return None
        row = self._conn.execute(
            "SELECT ldraw_id FROM ldraw_keyword_aliases WHERE rb_part_num = ?",
            (candidate_id.strip().lower(),),
        ).fetchone()
        if row is None:
            return None
        return self._find_ldraw_part(str(row["ldraw_id"]))

    def _resolve_via_relationships(self, part_num: str, max_depth: int = 3) -> tuple[sqlite3.Row, str] | None:
        """Recorre `part_relationships` (Print/Mold/Alternate) hasta encontrar un `.dat` válido."""
        visited: set[str] = {part_num}
        queue: deque[tuple[str, int, str]] = deque([(part_num, 0, "")])

        while queue:
            current, depth, trail = queue.popleft()
            if depth >= max_depth:
                continue

            placeholders = ",".join("?" for _ in RELATION_PRIORITY)
            rows = self._conn.execute(
                f"SELECT rel_type, parent_part_num FROM part_relationships WHERE child_part_num = ? AND rel_type IN ({placeholders})",
                (current, *RELATION_PRIORITY),
            ).fetchall()
            rows_sorted = sorted(
                rows,
                key=lambda r: RELATION_PRIORITY.index(r["rel_type"])
                if r["rel_type"] in RELATION_PRIORITY
                else len(RELATION_PRIORITY),
            )
            for row in rows_sorted:
                parent = str(row["parent_part_num"])
                rel_type = str(row["rel_type"])
                step_trail = f"{trail} -> {rel_type}:{parent}" if trail else f"{rel_type}:{parent}"
                ldraw_row = self._find_ldraw_part(parent)
                if ldraw_row is not None:
                    return ldraw_row, step_trail
                if parent not in visited:
                    visited.add(parent)
                    queue.append((parent, depth + 1, step_trail))
        return None

    def _resolve_geometry(
        self, part_num: str, design_id: str | None
    ) -> tuple[str, sqlite3.Row | None, str | None]:
        """Intenta localizar el `.dat` exacto o un molde equivalente."""
        exact = self._find_ldraw_part(part_num)
        if exact is not None:
            return "exact", exact, None

        if design_id:
            by_design = self._find_ldraw_part(design_id)
            if by_design is not None:
                return (
                    "fallback_mold",
                    by_design,
                    f"Resuelto por design_id '{design_id}' (molde base de '{part_num}').",
                )

        rel_match = self._resolve_via_relationships(part_num)
        if rel_match is not None:
            ldraw_row, trail = rel_match
            return (
                "fallback_mold",
                ldraw_row,
                f"Resuelto por relación Rebrickable ({trail}).",
            )

        suffix_match = PRINT_SUFFIX_RE.match(part_num)
        if suffix_match:
            base_candidate = suffix_match.group(1)
            for candidate in (base_candidate, MOLD_REVISION_RE.sub(r"\1", base_candidate)):
                by_prefix = self._find_ldraw_part(candidate)
                if by_prefix is not None:
                    return (
                        "fallback_mold",
                        by_prefix,
                        f"Resuelto quitando sufijo de impresión/ensamble ('{part_num}' -> '{candidate}').",
                    )

        rev_match = MOLD_REVISION_RE.match(part_num)
        if rev_match:
            base_num = rev_match.group(1)
            by_rev = self._find_ldraw_part(base_num)
            if by_rev is not None:
                return (
                    "fallback_mold",
                    by_rev,
                    f"Resuelto por revisión de molde base ('{part_num}' -> '{base_num}').",
                )

        if part_num.lower().startswith("973") or design_id == "78568":
            for torso_id in ("76382", "973"):
                torso_row = self._find_ldraw_part(torso_id)
                if torso_row is not None:
                    return (
                        "fallback_mold",
                        torso_row,
                        f"Resuelto como torso minifigura estándar '{torso_id}' (variante '{part_num}').",
                    )

        for candidate in (part_num, design_id):
            by_kw = self._find_ldraw_by_keyword_alias(candidate)
            if by_kw is not None:
                return (
                    "fallback_mold",
                    by_kw,
                    f"Resuelto por alias LDraw !KEYWORDS Rebrickable ('{part_num}' -> '{by_kw['ldraw_id']}').",
                )

        return (
            "unresolved",
            None,
            f"Pieza conocida en Rebrickable ('{part_num}'), pero sin archivo .dat equivalente en LDraw local.",
        )

    def resolve(self, item: ExtractedPartItem) -> ResolvedPart | None:
        elem = self._conn.execute(
            "SELECT element_id, part_num, color_id, design_id FROM elements WHERE element_id = ?",
            (item.element_id,),
        ).fetchone()
        if elem is None:
            return None

        part_num = str(elem["part_num"])
        design_id = str(elem["design_id"]) if elem["design_id"] else None
        color_id = int(elem["color_id"])

        part_row = self._conn.execute(
            "SELECT name FROM parts WHERE part_num = ?", (part_num,)
        ).fetchone()
        color_row = self._conn.execute(
            "SELECT name, rgb, is_trans, ldraw_code FROM colors WHERE id = ?", (color_id,)
        ).fetchone()

        status, ldraw_row, note = self._resolve_geometry(part_num, design_id)

        return ResolvedPart(
            element_id=item.element_id,
            quantity=item.quantity,
            status=status,
            resolution_note=note,
            part_num=part_num,
            design_id=design_id,
            part_name=str(part_row["name"]) if part_row else None,
            ldraw_part_id=str(ldraw_row["ldraw_id"]) if ldraw_row else None,
            ldraw_file=str(ldraw_row["rel_path"]) if ldraw_row else None,
            color_id=color_id,
            color_name=str(color_row["name"]) if color_row else None,
            color_rgb=f"#{color_row['rgb']}" if color_row else None,
            is_trans=bool(color_row["is_trans"]) if color_row else False,
            ldraw_color_code=int(color_row["ldraw_code"])
            if color_row and color_row["ldraw_code"] is not None
            else None,
            source_pages=list(item.source_pages),
        )
