"""Cliente y parser de secuencias abiertas LDraw OMR (`.mpd` / `.ldr`)."""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

OMR_HF_FILTER_URL = (
    "https://datasets-server.huggingface.co/filter"
    "?dataset=DylanRiden/sets_lego_omr_full&config=default&split=train"
)


@dataclass
class OMRSequenceResult:
    """Secuencia de pasos y dimensiones estimadas extraídas de un `.mpd`/`.ldr`."""

    source_label: str
    ordered_parts: list[tuple[str, int]]  # (ldraw_part_id, ldraw_color_code)
    bounds_ldu: tuple[float, float, float] | None  # (width_x, height_y, depth_z)


def find_or_fetch_omr_mpd(
    set_number: str | None,
    omr_dir: Path,
    allow_network: bool = True,
    timeout_sec: float = 4.0,
) -> tuple[str, str] | None:
    """Busca un archivo `.mpd`/`.ldr` local en `data/omr/` o intenta consultarlo online."""
    if not set_number:
        return None

    omr_dir.mkdir(parents=True, exist_ok=True)
    candidates = [
        omr_dir / f"{set_number}.mpd",
        omr_dir / f"{set_number}-1.mpd",
        omr_dir / f"{set_number}.ldr",
        omr_dir / f"{set_number}-1.ldr",
    ]
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="utf-8", errors="ignore"), f"local:{path.name}"

    if not allow_network:
        return None

    where = urllib.parse.quote(f'"set_num"=\'{set_number}-1\'')
    url = f"{OMR_HF_FILTER_URL}&where={where}&length=1"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "SoftwareLego/1.0"})
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="ignore"))
        rows = payload.get("rows") or []
        if not rows:
            return None
        row = rows[0].get("row") or {}
        mpd_content = row.get("mpd_content")
        if not isinstance(mpd_content, str) or "1 " not in mpd_content:
            return None
        cache_path = omr_dir / f"{set_number}.mpd"
        cache_path.write_text(mpd_content, encoding="utf-8")
        return mpd_content, "huggingface:sets_lego_omr_full"
    except Exception:
        return None


def _normalize_part_id(raw_file: str) -> str:
    clean = raw_file.strip().replace("\\", "/")
    if clean.lower().endswith(".dat"):
        clean = clean[:-4]
    return clean.lower()


def parse_omr_sequence(mpd_text: str, source_label: str = "omr") -> OMRSequenceResult:
    """Extrae el orden de aparición de piezas y el bounding box global del modelo LDraw."""
    submodels: dict[str, list[str]] = {}
    current_file: str | None = None
    first_file: str | None = None

    for raw_line in mpd_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        upper = line.upper()
        if upper.startswith("0 FILE "):
            current_file = line[7:].strip().lower()
            if first_file is None:
                first_file = current_file
            submodels.setdefault(current_file, [])
            continue
        if upper == "0 NOFILE":
            current_file = None
            continue
        if current_file is None:
            current_file = "__root__"
            if first_file is None:
                first_file = current_file
            submodels.setdefault(current_file, [])
        submodels[current_file].append(line)

    if not submodels or first_file is None:
        return OMRSequenceResult(source_label=source_label, ordered_parts=[], bounds_ldu=None)

    ordered: list[tuple[str, int]] = []
    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")

    def transform_point(m: tuple[float, ...], lx: float, ly: float, lz: float) -> tuple[float, float, float]:
        tx, ty, tz, a, b, c, d, e, f, g, h, i = m
        return (
            a * lx + b * ly + c * lz + tx,
            d * lx + e * ly + f * lz + ty,
            g * lx + h * ly + i * lz + tz,
        )

    def compose(parent: tuple[float, ...], child: tuple[float, ...]) -> tuple[float, ...]:
        ptx, pty, ptz, pa, pb, pc, pd, pe, pf, pg, ph, pi = parent
        ctx, cty, ctz, ca, cb, cc, cd, ce, cf, cg, ch, ci = child
        ntx, nty, ntz = transform_point(parent, ctx, cty, ctz)
        return (
            ntx, nty, ntz,
            pa * ca + pb * cd + pc * cg, pa * cb + pb * ce + pc * ch, pa * cc + pb * cf + pc * ci,
            pd * ca + pe * cd + pf * cg, pd * cb + pe * ce + pf * ch, pd * cc + pe * cf + pf * ci,
            pg * ca + ph * cd + pi * cg, pg * cb + ph * ce + pi * ch, pg * cc + ph * cf + pi * ci,
        )

    identity = (0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)

    def walk(model_key: str, parent_mat: tuple[float, ...], inherited_color: int, depth: int) -> None:
        nonlocal min_x, min_y, min_z, max_x, max_y, max_z
        if depth > 10:
            return
        for line in submodels.get(model_key, []):
            if not line.startswith("1 "):
                continue
            tokens = re.split(r"\s+", line, maxsplit=14)
            if len(tokens) < 15:
                continue
            try:
                col = int(tokens[1])
                nums = [float(x) for x in tokens[2:14]]
            except ValueError:
                continue
            eff_col = inherited_color if col == 16 else col
            child_mat = tuple(nums)
            world_mat = compose(parent_mat, child_mat)
            ref_name = tokens[14].strip().lower()

            if ref_name in submodels:
                walk(ref_name, world_mat, eff_col, depth + 1)
            else:
                part_id = _normalize_part_id(ref_name)
                if not part_id or "/" in part_id:
                    continue
                ordered.append((part_id, eff_col))
                px, py, pz = world_mat[0], world_mat[1], world_mat[2]
                if px < min_x:
                    min_x = px
                if px > max_x:
                    max_x = px
                if py < min_y:
                    min_y = py
                if py > max_y:
                    max_y = py
                if pz < min_z:
                    min_z = pz
                if pz > max_z:
                    max_z = pz

    walk(first_file, identity, 16, 0)

    bounds = None
    if ordered and min_x < float("inf"):
        bounds = (
            max(80.0, (max_x - min_x) + 120.0),
            max(80.0, (max_y - min_y) + 80.0),
            max(80.0, (max_z - min_z) + 120.0),
        )

    return OMRSequenceResult(
        source_label=source_label,
        ordered_parts=ordered,
        bounds_ldu=bounds,
    )
