"""Resolvedor por overrides manuales (`data/overrides.json`)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.models import ExtractedPartItem, ResolvedPart
from app.resolvers.base import BasePartResolver


class OverrideResolver(BasePartResolver):
    """Permite corregir o sustituir piezas puntuales sin tocar el código ni el catálogo."""

    name = "override_json"

    def __init__(self, overrides_path: Path) -> None:
        self.overrides_path = overrides_path
        self._overrides: dict[str, dict[str, Any]] = self._load(overrides_path)

    @staticmethod
    def _load(path: Path) -> dict[str, dict[str, Any]]:
        if not path.exists():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        entries = data.get("element_overrides", {})
        return entries if isinstance(entries, dict) else {}

    def resolve(self, item: ExtractedPartItem) -> ResolvedPart | None:
        entry = self._overrides.get(item.element_id)
        if not entry:
            return None

        ldraw_part_id = entry.get("ldraw_part_id")
        ldraw_file = entry.get("ldraw_file") or (
            f"parts/{ldraw_part_id}.dat" if ldraw_part_id else None
        )
        return ResolvedPart(
            element_id=item.element_id,
            quantity=item.quantity,
            status="override",
            resolution_note=entry.get("note", "Resuelto mediante data/overrides.json"),
            part_num=entry.get("part_num", ldraw_part_id),
            design_id=entry.get("design_id", ldraw_part_id),
            part_name=entry.get("part_name"),
            ldraw_part_id=ldraw_part_id,
            ldraw_file=ldraw_file,
            color_id=entry.get("color_id"),
            color_name=entry.get("color_name"),
            color_rgb=entry.get("color_rgb"),
            is_trans=bool(entry.get("is_trans", False)),
            ldraw_color_code=entry.get("ldraw_color_code"),
            source_pages=list(item.source_pages),
        )
