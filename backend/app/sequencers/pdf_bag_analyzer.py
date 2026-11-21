"""Analizador local (0 tokens IA) de bolsas numeradas y miniaturas por paso en PDFs LEGO."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pymupdf

CALLOUT_QTY_RE = re.compile(r"^(\d{1,3})x$", re.IGNORECASE)
ELEMENT_ID_RE = re.compile(r"^\d{5,8}$")


@dataclass
class BagPageRange:
    bag_number: int
    start_page_1idx: int
    end_page_1idx: int


@dataclass
class ImageSignature:
    mean_rgb: tuple[float, float, float]
    aspect: float
    patch: list[int]  # 8x8 RGB (192 valores 0..255)


def detect_bag_page_ranges(doc: pymupdf.Document, stop_before_page_1idx: int) -> list[BagPageRange]:
    """Detecta las páginas separadoras de bolsas numeradas (1, 2, 3...) usando tamaño de fuente."""
    candidates_by_bag: dict[int, list[int]] = {}
    limit = max(0, min(len(doc), stop_before_page_1idx - 1))

    for idx in range(limit):
        d = doc[idx].get_text("dict")
        page_big_nums: set[int] = set()
        total_words = 0
        for block in d.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    txt = span.get("text", "").strip()
                    if not txt:
                        continue
                    total_words += len(txt.split())
                    if txt.isdigit() and span.get("size", 0) >= 34.0:
                        val = int(txt)
                        if 1 <= val <= 35:
                            page_big_nums.add(val)

        # Una página de cambio de bolsa suele mostrar el número de bolsa grande aislado o con poco texto
        if len(page_big_nums) == 1 and total_words <= 35:
            bag_num = next(iter(page_big_nums))
            candidates_by_bag.setdefault(bag_num, []).append(idx + 1)

    if 1 not in candidates_by_bag:
        return []

    selected: list[tuple[int, int]] = []
    min_page = 1
    bag_num = 1
    while bag_num in candidates_by_bag:
        valid_pages = [p for p in candidates_by_bag[bag_num] if p >= min_page]
        if not valid_pages:
            break
        chosen_page = valid_pages[0]
        selected.append((bag_num, chosen_page))
        min_page = chosen_page + 1
        bag_num += 1

    if len(selected) < 2:
        return []

    ranges: list[BagPageRange] = []
    for i, (b_num, start_p) in enumerate(selected):
        end_p = (selected[i + 1][1] - 1) if i + 1 < len(selected) else max(start_p, limit)
        ranges.append(BagPageRange(bag_number=b_num, start_page_1idx=start_p, end_page_1idx=end_p))
    return ranges


def _extract_signature(
    doc: pymupdf.Document,
    xref: int,
    smask: int,
    cache: dict[tuple[int, int], ImageSignature | None],
) -> ImageSignature | None:
    key = (xref, smask)
    if key in cache:
        return cache[key]

    try:
        pix = pymupdf.Pixmap(doc, xref)
        if pix.width < 4 or pix.height < 4:
            cache[key] = None
            return None
        if pix.n - pix.alpha != 3:
            rgb_pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            pix = rgb_pix
        if smask > 0 and not pix.alpha:
            try:
                mask_pix = pymupdf.Pixmap(doc, smask)
                if mask_pix.width == pix.width and mask_pix.height == pix.height:
                    pix = pymupdf.Pixmap(pix, mask_pix)
            except Exception:
                pass

        w, h, n = pix.width, pix.height, pix.n
        has_alpha = pix.alpha > 0
        samples = pix.samples

        patch: list[int] = []
        fg_r = fg_g = fg_b = fg_count = 0

        for gy in range(8):
            py_idx = min(h - 1, int((gy + 0.5) * h / 8))
            row_off = py_idx * w * n
            for gx in range(8):
                px_idx = min(w - 1, int((gx + 0.5) * w / 8))
                off = row_off + px_idx * n
                r, g, b = samples[off], samples[off + 1], samples[off + 2]
                a = samples[off + n - 1] if has_alpha else 255

                if a < 45:
                    r, g, b = 255, 255, 255
                elif r + g + b < 735:
                    fg_r += r
                    fg_g += g
                    fg_b += b
                    fg_count += 1

                patch.extend((r, g, b))

        if fg_count == 0:
            mean_rgb = (245.0, 245.0, 245.0)
        else:
            mean_rgb = (fg_r / fg_count, fg_g / fg_count, fg_b / fg_count)

        sig = ImageSignature(mean_rgb=mean_rgb, aspect=w / max(1, h), patch=patch)
        cache[key] = sig
        return sig
    except Exception:
        cache[key] = None
        return None


def _signature_distance(a: ImageSignature, b: ImageSignature) -> float:
    mr = abs(a.mean_rgb[0] - b.mean_rgb[0])
    mg = abs(a.mean_rgb[1] - b.mean_rgb[1])
    mb = abs(a.mean_rgb[2] - b.mean_rgb[2])
    mean_dist = (mr + mg + mb) / 3.0

    pa, pb = a.patch, b.patch
    patch_diff = 0
    for i in range(0, len(pa), 3):
        patch_diff += abs(pa[i] - pb[i]) + abs(pa[i + 1] - pb[i + 1]) + abs(pa[i + 2] - pb[i + 2])
    patch_dist = patch_diff / len(pa)

    aspect_diff = abs(a.aspect - b.aspect) * 40.0
    return mean_dist * 1.35 + patch_dist * 0.65 + aspect_diff


def _find_image_above_word(
    word_bbox: tuple[float, float, float, float],
    images: list[dict[str, Any]],
    max_width_pt: float = 135.0,
    max_height_pt: float = 115.0,
) -> dict[str, Any] | None:
    wx0, wy0, wx1, _ = word_bbox
    wcx = (wx0 + wx1) * 0.5
    best: dict[str, Any] | None = None
    best_score = float("inf")

    for info in images:
        ix0, iy0, ix1, iy1 = info["bbox"]
        iw = ix1 - ix0
        ih = iy1 - iy0
        if iw <= 4 or ih <= 4 or iw > max_width_pt or ih > max_height_pt:
            continue
        icx = (ix0 + ix1) * 0.5
        if abs(icx - wcx) > 36.0:
            continue
        dy = wy0 - iy1
        if dy < -8.0 or dy > 44.0:
            continue
        score = abs(dy) + abs(icx - wcx) * 1.2
        if score < best_score:
            best_score = score
            best = info
    return best


def analyze_pdf_bags(
    pdf_path: Path,
    inventory_pages: list[int],
    resolved_element_ids: set[str],
    part_quantities: dict[str, int],
) -> tuple[list[BagPageRange], dict[str, dict[str, int]]]:
    """
    Asigna cada `element_id` del inventario a las bolsas numeradas detectadas en el PDF
    comparando las miniaturas de cada paso con las miniaturas del BOM final.
    """
    with pymupdf.open(pdf_path) as doc:
        first_bom_page = min(inventory_pages) if inventory_pages else len(doc) + 1
        bag_ranges = detect_bag_page_ranges(doc, first_bom_page)
        if not bag_ranges:
            return [], {}

        sig_cache: dict[tuple[int, int], ImageSignature | None] = {}
        bom_sigs: dict[str, list[ImageSignature]] = {}

        # 1. Indexar firmas visuales de cada ElementID en las páginas del BOM
        for p_1idx in inventory_pages:
            idx = p_1idx - 1
            if idx < 0 or idx >= len(doc):
                continue
            page = doc[idx]
            words = page.get_text("words")
            imgs = page.get_image_info(xrefs=True)
            xref_smask = {img[0]: img[1] for img in page.get_images(full=True)}

            # Mapear palabras Nx cercanas arriba de ElementIDs
            qty_words = [w for w in words if CALLOUT_QTY_RE.match(w[4])]
            for w in words:
                eid = w[4].strip()
                if eid not in resolved_element_ids or not ELEMENT_ID_RE.match(eid):
                    continue
                ecx = (w[0] + w[2]) * 0.5
                anchor_bbox = w[:4]
                for qw in qty_words:
                    qcx = (qw[0] + qw[2]) * 0.5
                    dy = w[1] - qw[3]
                    if abs(qcx - ecx) <= 24.0 and -4.0 <= dy <= 16.0:
                        anchor_bbox = qw[:4]
                        break
                img_info = _find_image_above_word(anchor_bbox, imgs, max_width_pt=120.0, max_height_pt=110.0)
                if not img_info:
                    continue
                xref = int(img_info.get("xref") or 0)
                if xref <= 0:
                    continue
                sig = _extract_signature(doc, xref, xref_smask.get(xref, 0), sig_cache)
                if sig:
                    bom_sigs.setdefault(eid, []).append(sig)

        if not bom_sigs:
            return bag_ranges, {}

        remaining: dict[str, int] = dict(part_quantities)
        assignments: dict[str, dict[str, int]] = {}
        bom_set = set(inventory_pages)

        # 2. Recorrer bolsas en orden y asignar piezas según las miniaturas de cada paso
        for bag in bag_ranges:
            bag_key = str(bag.bag_number)
            for p_1idx in range(bag.start_page_1idx, bag.end_page_1idx + 1):
                if p_1idx in bom_set:
                    continue
                page = doc[p_1idx - 1]
                words = page.get_text("words")
                qty_words = [w for w in words if CALLOUT_QTY_RE.match(w[4])]
                if not qty_words:
                    continue
                imgs = page.get_image_info(xrefs=True)
                xref_smask = {img[0]: img[1] for img in page.get_images(full=True)}

                for qw in qty_words:
                    m = CALLOUT_QTY_RE.match(qw[4])
                    if not m:
                        continue
                    call_qty = int(m.group(1))
                    if call_qty <= 0:
                        continue
                    img_info = _find_image_above_word(qw[:4], imgs, max_width_pt=115.0, max_height_pt=105.0)
                    if not img_info:
                        continue
                    xref = int(img_info.get("xref") or 0)
                    if xref <= 0:
                        continue
                    step_sig = _extract_signature(doc, xref, xref_smask.get(xref, 0), sig_cache)
                    if not step_sig:
                        continue

                    best_eid: str | None = None
                    best_dist = float("inf")
                    for eid, sig_list in bom_sigs.items():
                        rem = remaining.get(eid, 0)
                        if rem <= 0:
                            continue
                        for bsig in sig_list:
                            dist = _signature_distance(step_sig, bsig)
                            # Pequeña penalización si el paso pide más cantidad que la restante en BOM
                            if call_qty > rem:
                                dist += 12.0
                            if dist < best_dist:
                                best_dist = dist
                                best_eid = eid

                    if best_eid and best_dist <= 65.0:
                        take = min(call_qty, remaining[best_eid])
                        if take > 0:
                            remaining[best_eid] -= take
                            per_bag = assignments.setdefault(best_eid, {})
                            per_bag[bag_key] = per_bag.get(bag_key, 0) + take

        # 3. Repartir remanentes no matcheados entre bolsas siguiendo sus pesos relativos
        bag_totals = {str(b.bag_number): 0 for b in bag_ranges}
        for per_bag in assignments.values():
            for bk, q in per_bag.items():
                bag_totals[bk] = bag_totals.get(bk, 0) + q

        total_assigned = sum(bag_totals.values())
        if total_assigned > 0:
            # Llenar las bolsas que quedaron más livianas respecto al promedio del set
            total_target = sum(part_quantities.values())
            avg_per_bag = max(1.0, total_target / len(bag_ranges))
            ordered_bags = [str(b.bag_number) for b in bag_ranges]
            cursor = 0
            for eid, rem in remaining.items():
                while rem > 0:
                    # Elegir la bolsa por debajo del promedio, o rotar ordenadamente
                    chosen = None
                    for offset in range(len(ordered_bags)):
                        bk = ordered_bags[(cursor + offset) % len(ordered_bags)]
                        if bag_totals[bk] < avg_per_bag:
                            chosen = bk
                            cursor = (cursor + offset + 1) % len(ordered_bags)
                            break
                    if chosen is None:
                        chosen = ordered_bags[cursor % len(ordered_bags)]
                        cursor += 1
                    per_bag = assignments.setdefault(eid, {})
                    per_bag[chosen] = per_bag.get(chosen, 0) + 1
                    bag_totals[chosen] += 1
                    rem -= 1

    return bag_ranges, assignments
