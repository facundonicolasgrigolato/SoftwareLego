"""Resolvedor híbrido (Camino B): LDraw Unofficial Tracker + Rebrickable API opcional + caché local."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import replace
from pathlib import Path
from typing import Any

from app.config import AppPaths
from app.models import ExtractedPartItem, ResolvedPart
from app.resolvers.base import BasePartResolver

LDRAW_UNOFFICIAL_BASE = "https://library.ldraw.org/library/unofficial"
REBRICKABLE_API_BASE = "https://rebrickable.com/api/v3/lego"
PRINT_SUFFIX_RE = re.compile(r"^(.+?)(?:pr\d+|pat\d+|c\d+)$", re.IGNORECASE)
MOLD_REVISION_RE = re.compile(r"^(\d{3,6})[a-z]$", re.IGNORECASE)


def _is_valid_ldraw_content(content: str) -> bool:
    """Valida que un `.dat` descargado tenga líneas LDraw (`0`..`5`) y no HTML o basura."""
    cleaned = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lower_head = cleaned[:256].lower()
    if "<html" in lower_head or "<!doctype" in lower_head:
        return False

    has_line = False
    for raw_line in cleaned.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        first = line[0]
        if first not in ("0", "1", "2", "3", "4", "5"):
            return False
        if len(line) > 1 and not line[1].isspace():
            return False
        has_line = True
    return has_line


def _normalize_rel_dat_path(raw_ref: str) -> str:
    clean = raw_ref.strip().replace("\\", "/").lstrip("/")
    return clean


class OnlineHybridResolver(BasePartResolver):
    """
    Complementa al catálogo offline cuando una pieza nueva o poco común queda `unresolved`:
    1) Rebrickable API v3 (si hay `REBRICKABLE_API_KEY` o `data/api_config.json`) para `element_id` nuevo
       y mapeos `external_ids.LDraw`.
    2) LDraw Unofficial Parts Tracker (`library.ldraw.org/library/unofficial/`, sin API key) para bajar
       archivos `.dat` aún no incluidos en `complete.zip` junto con sus subpiezas en `data/ldraw/`.
    3) Geometría aproximada documentada (ej. cabeza/cadera minifigura) si todavía no existe `.dat` en LDraw.
    Todo resultado se cachea en `data/api_cache.json` para no repetir llamadas HTTP.
    """

    name = "online_hybrid"

    def __init__(
        self,
        paths: AppPaths,
        sqlite_conn: sqlite3.Connection | None = None,
        allow_network: bool = True,
        timeout_sec: float = 5.0,
    ) -> None:
        self.paths = paths
        self.ldraw_root = paths.resolve_ldraw_parts_root()
        self.sqlite_conn = sqlite_conn
        self.allow_network = allow_network
        self.timeout_sec = timeout_sec
        self.api_key = self._load_api_key()
        self._cache = self._load_cache()
        self._dirty = False

    def _load_api_key(self) -> str | None:
        env_key = os.environ.get("REBRICKABLE_API_KEY", "").strip()
        if env_key:
            return env_key
        cfg_path = self.paths.api_config_path
        if cfg_path.is_file():
            try:
                data = json.loads(cfg_path.read_text(encoding="utf-8"))
                key = str(data.get("rebrickable_api_key") or "").strip()
                return key or None
            except Exception:
                return None
        return None

    def _load_cache(self) -> dict[str, Any]:
        cache_path = self.paths.api_cache_path
        if cache_path.is_file():
            try:
                data = json.loads(cache_path.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    data.setdefault("elements", {})
                    data.setdefault("parts", {})
                    data.setdefault("unofficial_misses", [])
                    return data
            except Exception:
                pass
        return {"elements": {}, "parts": {}, "unofficial_misses": []}

    def flush_cache(self) -> None:
        if not self._dirty:
            return
        self.paths.api_cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.paths.api_cache_path.write_text(
            json.dumps(self._cache, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        if self.sqlite_conn is not None:
            try:
                self.sqlite_conn.commit()
            except Exception:
                pass
        self._dirty = False

    def _http_get_result(
        self, url: str, headers: dict[str, str] | None = None
    ) -> tuple[str | None, bool]:
        """Devuelve `(contenido, es_404_definitivo)` para no cachear fallos transitorios de red/429."""
        if not self.allow_network:
            return None, False
        req_headers = {"User-Agent": "SoftwareLego/1.0"}
        if headers:
            req_headers.update(headers)
        try:
            req = urllib.request.Request(url, headers=req_headers)
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                return resp.read().decode("utf-8", errors="replace"), False
        except urllib.error.HTTPError as exc:
            return None, exc.code == 404
        except Exception:
            return None, False

    def _http_get_text(self, url: str, headers: dict[str, str] | None = None) -> str | None:
        text, _ = self._http_get_result(url, headers=headers)
        return text

    def _fetch_rebrickable_json(self, path_suffix: str) -> dict[str, Any] | None:
        if not self.api_key or not self.allow_network:
            return None
        url = f"{REBRICKABLE_API_BASE}/{path_suffix.lstrip('/')}"
        raw = self._http_get_text(url, headers={"Authorization": f"key {self.api_key}"})
        if not raw:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    def _resolve_element_via_api(self, item: ExtractedPartItem) -> ResolvedPart | None:
        cached = self._cache["elements"].get(item.element_id)
        if isinstance(cached, dict) and cached.get("part_num"):
            return self._resolved_from_cached_element(item, cached)

        if not self.api_key or not self.allow_network:
            return None

        data = self._fetch_rebrickable_json(f"elements/{urllib.parse.quote(item.element_id)}/")
        if not data or not isinstance(data.get("part"), dict):
            return None

        part = data["part"]
        color = data.get("color") or {}
        ext_part = part.get("external_ids") or {}
        ext_col = color.get("external_ids") or {}
        ldraw_ids = [str(x).strip() for x in (ext_part.get("LDraw") or []) if str(x).strip()]
        ldraw_col_list = ext_col.get("LDraw", {}).get("ext_ids") if isinstance(ext_col.get("LDraw"), dict) else []
        ldraw_col = int(ldraw_col_list[0]) if ldraw_col_list else None
        rgb_raw = str(color.get("rgb") or "").lstrip("#").upper()

        entry = {
            "part_num": str(part.get("part_num") or ""),
            "design_id": str(data.get("design_id") or "") or None,
            "part_name": str(part.get("name") or "") or None,
            "color_id": int(color["id"]) if color.get("id") is not None else None,
            "color_name": str(color.get("name") or "") or None,
            "color_rgb": f"#{rgb_raw}" if len(rgb_raw) == 6 else None,
            "is_trans": bool(color.get("is_trans", False)),
            "ldraw_color_code": ldraw_col,
            "ldraw_ids": ldraw_ids,
        }
        self._cache["elements"][item.element_id] = entry
        if entry["part_num"] and ldraw_ids:
            self._cache["parts"][entry["part_num"]] = ldraw_ids
        self._dirty = True
        return self._resolved_from_cached_element(item, entry)

    def _resolved_from_cached_element(
        self, item: ExtractedPartItem, entry: dict[str, Any]
    ) -> ResolvedPart:
        return ResolvedPart(
            element_id=item.element_id,
            quantity=item.quantity,
            status="unresolved",
            resolution_note="Metadatos obtenidos vía Rebrickable API.",
            part_num=entry.get("part_num"),
            design_id=entry.get("design_id"),
            part_name=entry.get("part_name"),
            color_id=entry.get("color_id"),
            color_name=entry.get("color_name"),
            color_rgb=entry.get("color_rgb"),
            is_trans=bool(entry.get("is_trans", False)),
            ldraw_color_code=entry.get("ldraw_color_code"),
            source_pages=list(item.source_pages),
        )

    def _lookup_external_ldraw_ids(self, part_num: str) -> list[str]:
        if part_num in self._cache["parts"]:
            cached = self._cache["parts"][part_num]
            return list(cached) if isinstance(cached, list) else []
        if not self.api_key or not self.allow_network:
            return []
        data = self._fetch_rebrickable_json(f"parts/{urllib.parse.quote(part_num)}/")
        if not data:
            return []
        ext = (data.get("external_ids") or {}).get("LDraw") or []
        ids = [str(x).strip() for x in ext if str(x).strip()]
        self._cache["parts"][part_num] = ids
        self._dirty = True
        return ids

    def _local_rel_exists(self, rel_path: str) -> bool:
        clean = _normalize_rel_dat_path(rel_path)
        base = self.ldraw_root.resolve()
        target = (base / clean).resolve()
        if not target.is_relative_to(base):
            return False
        return target.is_file()

    def _save_ldraw_file(self, rel_path: str, content: str) -> Path | None:
        clean = _normalize_rel_dat_path(rel_path)
        base = self.ldraw_root.resolve()
        target = (base / clean).resolve()
        if not target.is_relative_to(base):
            return None
        target.parent.mkdir(parents=True, exist_ok=True)
        normalized = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
        target.write_bytes(normalized.encode("utf-8"))
        return target

    def _download_unofficial_recursive(
        self,
        rel_path: str,
        visited: set[str],
        depth: int = 0,
    ) -> tuple[bool, bool]:
        """Descarga recursiva devolviendo `(ok, fue_404_definitivo)`."""
        if depth > 5:
            return False, False
        clean = _normalize_rel_dat_path(rel_path)
        key = clean.lower()
        if key in visited:
            return True, False
        visited.add(key)

        if self._local_rel_exists(clean):
            return True, False

        text, is_404 = self._http_get_result(f"{LDRAW_UNOFFICIAL_BASE}/{clean}")
        if text is None or not _is_valid_ldraw_content(text):
            return False, is_404

        normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
        self._save_ldraw_file(clean, normalized)

        # Descargar recursivamente subarchivos/primitivas que falten localmente
        for raw_line in normalized.splitlines():
            line = raw_line.strip()
            if not line.startswith("1 "):
                continue
            tokens = line.split(maxsplit=14)
            if len(tokens) < 15:
                continue
            sub_ref = _normalize_rel_dat_path(tokens[14])
            if not sub_ref:
                continue

            # En LDraw un tipo 1 dentro de parts/ puede referenciar `s\...`, otro part o `p\...`
            candidates = [f"parts/{sub_ref}", f"p/{sub_ref}"]
            if any(self._local_rel_exists(c) for c in candidates):
                continue
            for cand in candidates:
                ok_sub, _ = self._download_unofficial_recursive(cand, visited, depth + 1)
                if ok_sub:
                    break

        return True, False

    def _register_sqlite_ldraw(self, ldraw_id: str, rel_path: str, title: str) -> None:
        if self.sqlite_conn is None:
            return
        try:
            self.sqlite_conn.execute(
                "INSERT OR IGNORE INTO ldraw_parts (ldraw_id, rel_path, title) VALUES (?, ?, ?)",
                (ldraw_id.lower(), rel_path, title),
            )
            self._dirty = True
        except Exception:
            pass

    def _try_unofficial_ldraw(self, part_num: str | None, design_id: str | None) -> tuple[str, str] | None:
        hit, _ = self._try_unofficial_ldraw_with_status(part_num, design_id)
        return hit

    def _try_unofficial_ldraw_with_status(
        self, part_num: str | None, design_id: str | None
    ) -> tuple[tuple[str, str] | None, bool]:
        candidates: list[str] = []
        if part_num:
            candidates.extend(self._lookup_external_ldraw_ids(part_num))
            candidates.append(part_num)
            m = PRINT_SUFFIX_RE.match(part_num)
            if m:
                base = m.group(1)
                candidates.append(base)
                candidates.append(MOLD_REVISION_RE.sub(r"\1", base))
            rm = MOLD_REVISION_RE.match(part_num)
            if rm:
                candidates.append(rm.group(1))
        if design_id:
            candidates.append(design_id)

        seen: set[str] = set()
        ordered_cids: list[str] = []
        for raw_cid in candidates:
            cid = str(raw_cid or "").strip().lower()
            if cid and cid not in seen:
                seen.add(cid)
                ordered_cids.append(cid)

        misses = set(self._cache.get("unofficial_misses") or [])
        visited: set[str] = set()
        had_transient_failure = False

        for cid in ordered_cids:
            rel = f"parts/{cid}.dat"
            if self._local_rel_exists(rel):
                return (cid, rel), False
            if cid in misses:
                continue
            if not self.allow_network:
                had_transient_failure = True
                continue
            ok_dl, is_404 = self._download_unofficial_recursive(rel, visited)
            if ok_dl:
                first_line = (self.ldraw_root / rel).read_text(encoding="utf-8", errors="ignore").splitlines()[0]
                title = first_line[2:].strip() if first_line.startswith("0 ") else cid
                self._register_sqlite_ldraw(cid, rel, title)
                return (cid, rel), False
            if is_404:
                misses.add(cid)
                self._cache["unofficial_misses"] = sorted(misses)
                self._dirty = True
            else:
                had_transient_failure = True

        all_confirmed_404 = bool(ordered_cids) and not had_transient_failure and all(
            cid in misses for cid in ordered_cids
        )
        return None, all_confirmed_404

    def _try_minifig_proxy(self, part_name: str | None) -> tuple[str, str, str] | None:
        if not part_name:
            return None
        lower = part_name.lower()
        proxy_id: str | None = None
        if "minifig head" in lower:
            proxy_id = "3626c"
        elif "hipwear" in lower or "minifig hips" in lower:
            proxy_id = "3815b"
        elif "minifig torso" in lower or lower.startswith("torso,"):
            proxy_id = "76382"

        if not proxy_id:
            return None
        rel = f"parts/{proxy_id}.dat"
        if not self._local_rel_exists(rel):
            return None
        note = (
            f"Geometría base aproximada ('{proxy_id}'): molde especial todavía sin archivo .dat "
            "en LDraw oficial ni no oficial."
        )
        return proxy_id, rel, note

    def resolve(self, item: ExtractedPartItem) -> ResolvedPart | None:
        return self.resolve_with_partial(item, None)

    def resolve_with_partial(
        self,
        item: ExtractedPartItem,
        partial: ResolvedPart | None = None,
    ) -> ResolvedPart | None:
        base = partial
        if base is None:
            base = self._resolve_element_via_api(item)
        if base is None:
            return None

        hit, all_confirmed_404 = self._try_unofficial_ldraw_with_status(base.part_num, base.design_id)
        if hit is not None:
            cid, rel = hit
            return replace(
                base,
                status="api_online",
                ldraw_part_id=cid,
                ldraw_file=rel,
                resolution_note=f"Resuelto vía LDraw Unofficial / API híbrida ('{cid}.dat') y cacheado localmente.",
                unresolved_definitive=False,
            )

        proxy = self._try_minifig_proxy(base.part_name)
        if proxy is not None:
            pid, rel, note = proxy
            return replace(
                base,
                status="fallback_mold",
                ldraw_part_id=pid,
                ldraw_file=rel,
                resolution_note=note,
                unresolved_definitive=False,
            )

        if all_confirmed_404:
            return replace(base, unresolved_definitive=True)
        return base
