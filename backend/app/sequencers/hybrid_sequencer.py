"""Orquestador híbrido de secuencia de bolsas (OMR comunitario + análisis local PDF)."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from app.models import ResolvedPart
from app.sequencers.omr_sequencer import find_or_fetch_omr_mpd, parse_omr_sequence
from app.sequencers.pdf_bag_analyzer import analyze_pdf_bags

BAG_CHUNK_TARGET = 150
MIN_BUILD_ZONE_LDU = 800


def _snap_up_40(val: float) -> int:
    return int(math.ceil(max(MIN_BUILD_ZONE_LDU, val) / 40.0) * 40)


def _compute_recommended_build_zone(
    total_resolved: int,
    omr_bounds_ldu: tuple[float, float, float] | None,
) -> dict[str, Any]:
    if omr_bounds_ldu is not None:
        w, _, d = omr_bounds_ldu
        return {
            "width_ldu": _snap_up_40(w * 1.45),
            "depth_ldu": _snap_up_40(d * 1.45),
            "source": "omr_bounds",
        }

    if total_resolved <= 250:
        w, d = 800, 800
    elif total_resolved <= 600:
        w, d = 1000, 920
    elif total_resolved <= 1200:
        w, d = 1200, 1080
    else:
        w, d = 1400, 1200

    return {
        "width_ldu": w,
        "depth_ldu": d,
        "source": "piece_count_scale",
    }


def _assign_omr_order_to_parts(
    resolved_parts: list[ResolvedPart],
    omr_ordered: list[tuple[str, int]],
    bag_capacities: list[tuple[int, int, str, int | None, int | None]],
) -> None:
    """Ordena unidades de piezas según secuencia OMR y las reparte en las bolsas indicadas."""
    by_ldraw: dict[tuple[str, int], list[ResolvedPart]] = {}
    by_part_only: dict[str, list[ResolvedPart]] = {}
    remaining_qty: dict[str, int] = {}

    for p in resolved_parts:
        if p.status == "unresolved":
            continue
        remaining_qty[p.element_id] = p.quantity
        pid = (p.ldraw_part_id or "").lower()
        col = p.ldraw_color_code if p.ldraw_color_code is not None else -1
        if pid:
            by_ldraw.setdefault((pid, col), []).append(p)
            by_part_only.setdefault(pid, []).append(p)

    unit_stream: list[ResolvedPart] = []
    for pid, col in omr_ordered:
        picked: ResolvedPart | None = None
        for cand in by_ldraw.get((pid, col), []):
            if remaining_qty.get(cand.element_id, 0) > 0:
                picked = cand
                break
        if picked is None:
            for cand in by_part_only.get(pid, []):
                if remaining_qty.get(cand.element_id, 0) > 0:
                    picked = cand
                    break
        if picked is not None:
            remaining_qty[picked.element_id] -= 1
            unit_stream.append(picked)

    # Anexar cualquier remanente no encontrado en OMR
    for p in resolved_parts:
        if p.status == "unresolved":
            continue
        rem = remaining_qty.get(p.element_id, 0)
        for _ in range(rem):
            unit_stream.append(p)
        p.bag_counts = {}

    idx = 0
    for bag_num, cap, _, _, _ in bag_capacities:
        bag_key = str(bag_num)
        taken = 0
        while idx < len(unit_stream) and taken < cap:
            part = unit_stream[idx]
            part.bag_counts[bag_key] = part.bag_counts.get(bag_key, 0) + 1
            idx += 1
            taken += 1

    # Si sobró alguna unidad por redondeo, va a la última bolsa
    if bag_capacities:
        last_key = str(bag_capacities[-1][0])
        while idx < len(unit_stream):
            part = unit_stream[idx]
            part.bag_counts[last_key] = part.bag_counts.get(last_key, 0) + 1
            idx += 1


def sequence_manifest_parts(
    pdf_path: Path,
    set_number: str | None,
    inventory_pages: list[int],
    resolved_parts: list[ResolvedPart],
    omr_dir: Path,
    allow_network: bool = True,
) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    """
    Calcula bolsas y dimensiones recomendadas combinando:
    1) Secuencia abierta LDraw OMR (si existe local o en API pública)
    2) Detección local de bolsas + emparejamiento de miniaturas paso-vs-BOM en el PDF
    3) Fallback por tandas ordenadas de ~150 piezas
    """
    usable = [p for p in resolved_parts if p.status != "unresolved"]
    total_resolved = sum(p.quantity for p in usable)
    resolved_eids = {p.element_id for p in usable}
    qty_map = {p.element_id: p.quantity for p in usable}

    # 1. Consultar OMR comunitario (local primero, luego API sin bloquear si falla)
    omr_res = None
    fetched = find_or_fetch_omr_mpd(set_number, omr_dir, allow_network=allow_network)
    if fetched is not None:
        mpd_text, label = fetched
        parsed = parse_omr_sequence(mpd_text, source_label=label)
        if parsed.ordered_parts:
            omr_res = parsed

    # 2. Analizar bolsas numeradas reales en el PDF
    bag_ranges, pdf_assignments = analyze_pdf_bags(
        pdf_path=pdf_path,
        inventory_pages=inventory_pages,
        resolved_element_ids=resolved_eids,
        part_quantities=qty_map,
    )

    bags_meta: list[dict[str, Any]] = []
    sequence_source = "auto_chunks"

    if omr_res is not None:
        sequence_source = "omr_and_pdf_bags" if bag_ranges else "omr_community"
        if bag_ranges:
            # Calcular cuántas piezas cayeron en cada bolsa detectada del PDF o repartir parejo
            pdf_bag_counts = {str(b.bag_number): 0 for b in bag_ranges}
            for per_bag in pdf_assignments.values():
                for bk, q in per_bag.items():
                    pdf_bag_counts[bk] = pdf_bag_counts.get(bk, 0) + q
            total_pdf_matched = sum(pdf_bag_counts.values())

            capacities: list[tuple[int, int, str, int | None, int | None]] = []
            assigned_so_far = 0
            for i, br in enumerate(bag_ranges):
                if i == len(bag_ranges) - 1:
                    cap = max(0, total_resolved - assigned_so_far)
                elif total_pdf_matched > 0:
                    cap = max(1, round(total_resolved * (pdf_bag_counts.get(str(br.bag_number), 0) / total_pdf_matched)))
                else:
                    cap = max(1, round(total_resolved / len(bag_ranges)))
                assigned_so_far += cap
                capacities.append((br.bag_number, cap, f"Bolsa {br.bag_number}", br.start_page_1idx, br.end_page_1idx))
        else:
            bag_count = 1 if total_resolved <= 220 else max(2, math.ceil(total_resolved / BAG_CHUNK_TARGET))
            per_bag = math.ceil(total_resolved / bag_count) if bag_count > 0 else total_resolved
            capacities = []
            rem = total_resolved
            for b_num in range(1, bag_count + 1):
                cap = min(per_bag, rem) if b_num < bag_count else rem
                rem -= cap
                capacities.append((b_num, cap, f"Bolsa {b_num}", None, None))

        _assign_omr_order_to_parts(resolved_parts, omr_res.ordered_parts, capacities)
        for b_num, _, label, p_start, p_end in capacities:
            bk = str(b_num)
            actual_cnt = sum(p.bag_counts.get(bk, 0) for p in usable)
            if actual_cnt > 0:
                bags_meta.append(
                    {
                        "bag_number": b_num,
                        "label": label,
                        "piece_count": actual_cnt,
                        "page_start": p_start,
                        "page_end": p_end,
                    }
                )

    elif bag_ranges and pdf_assignments:
        sequence_source = "pdf_bags_visual"
        for p in usable:
            p.bag_counts = dict(pdf_assignments.get(p.element_id, {"1": p.quantity}))
        for br in bag_ranges:
            bk = str(br.bag_number)
            actual_cnt = sum(p.bag_counts.get(bk, 0) for p in usable)
            if actual_cnt > 0:
                bags_meta.append(
                    {
                        "bag_number": br.bag_number,
                        "label": f"Bolsa {br.bag_number}",
                        "piece_count": actual_cnt,
                        "page_start": br.start_page_1idx,
                        "page_end": br.end_page_1idx,
                    }
                )

    else:
        # Sin OMR ni bolsas numeradas: 1 bolsa si es chico, o bloques ~150 ordenados estructuralmente
        bag_count = 1 if total_resolved <= 220 else max(2, math.ceil(total_resolved / BAG_CHUNK_TARGET))
        # Orden heurístico suave: plates/bricks/bases primero, tiles/detalles al final
        def _structural_priority(part: ResolvedPart) -> tuple[int, str]:
            name = (part.part_name or "").lower()
            if "baseplate" in name:
                return (0, name)
            if "plate" in name:
                return (1, name)
            if "brick" in name:
                return (2, name)
            if "slope" in name or "bracket" in name:
                return (3, name)
            return (4, name)

        sorted_parts = sorted(usable, key=_structural_priority)
        capacities = []
        rem = total_resolved
        per_bag = math.ceil(total_resolved / bag_count) if bag_count > 0 else total_resolved
        for b_num in range(1, bag_count + 1):
            cap = min(per_bag, rem) if b_num < bag_count else rem
            rem -= cap
            capacities.append((b_num, cap, f"Bolsa {b_num}", None, None))

        _assign_omr_order_to_parts(sorted_parts, [], capacities)
        for b_num, _, label, p_start, p_end in capacities:
            bk = str(b_num)
            actual_cnt = sum(p.bag_counts.get(bk, 0) for p in usable)
            if actual_cnt > 0:
                bags_meta.append(
                    {
                        "bag_number": b_num,
                        "label": label,
                        "piece_count": actual_cnt,
                        "page_start": p_start,
                        "page_end": p_end,
                    }
                )

    table_layout = {
        "build_zone": _compute_recommended_build_zone(
            total_resolved=total_resolved,
            omr_bounds_ldu=omr_res.bounds_ldu if omr_res else None,
        ),
        "omr_source": omr_res.source_label if omr_res else None,
    }
    return sequence_source, bags_meta, table_layout
