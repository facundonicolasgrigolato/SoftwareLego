/**
 * Normaliza una cantidad personalizada de cajas entre 1 y 24, o null si usa bolsas originales.
 */
export function normalizeCustomBoxCount(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.max(1, Math.min(24, Math.round(n)));
}

export function getDefaultBoxCount(manifest) {
  const bags = manifest?.bags;
  return Math.max(1, Array.isArray(bags) && bags.length ? bags.length : 1);
}

export function getOrigBagForElement(partsByElementId, manifest, elementId) {
  const part = partsByElementId.get(elementId);
  const keys = Object.keys(part?.bag_counts || {}).map(Number).filter((n) => n > 0);
  if (keys.length) return Math.min(...keys);
  return manifest?.bags?.[0]?.bag_number || 1;
}

export function getDefaultBagForElement(partsByElementId, manifest, customBoxCount, effectiveManifest, elementId) {
  if (customBoxCount != null && effectiveManifest) {
    const effPart = (effectiveManifest.parts || []).find((p) => p.element_id === elementId);
    const effKeys = Object.keys(effPart?.bag_counts || {}).map(Number).filter((n) => n > 0);
    if (effKeys.length) return Math.min(...effKeys);
    const orig = getOrigBagForElement(partsByElementId, manifest, elementId);
    return Math.max(1, Math.min(customBoxCount, orig));
  }
  return getOrigBagForElement(partsByElementId, manifest, elementId);
}

/**
 * Reparte piezas sueltas equitativamente en `boxCount` cajas conservando el orden del manifiesto.
 */
export function assignBalancedBags(entries, boxCount, partOrderMap) {
  const k = Math.max(1, Math.min(24, Math.round(boxCount)));
  const ordered = [...entries].sort((a, b) => {
    const ba = a.origBagNumber ?? a.bagNumber ?? 1;
    const bb = b.origBagNumber ?? b.bagNumber ?? 1;
    if (ba !== bb) return ba - bb;
    const oa = partOrderMap.get(a.elementId) ?? Number.MAX_SAFE_INTEGER;
    const ob = partOrderMap.get(b.elementId) ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return String(a.elementId || "").localeCompare(String(b.elementId || ""));
  });
  const total = ordered.length;
  const base = Math.floor(total / k);
  const rem = total % k;
  let cursor = 0;
  for (let boxIdx = 0; boxIdx < k; boxIdx += 1) {
    const quota = base + (boxIdx < rem ? 1 : 0);
    const bagNum = boxIdx + 1;
    for (let j = 0; j < quota && cursor < total; j += 1) {
      ordered[cursor].bagNumber = bagNum;
      cursor += 1;
    }
  }
}

/**
 * Construye un manifiesto derivado con conteos por caja recalculados tras repartir piezas.
 */
export function buildBalancedEffectiveManifest(baseManifest, boxCount, assignedItems) {
  if (!baseManifest) return null;
  if (boxCount == null) return baseManifest;
  const k = Math.max(1, Math.min(24, Math.round(boxCount)));
  const bagCounts = new Array(k).fill(0);
  const perPartBags = new Map();
  for (const item of assignedItems || []) {
    const b = Math.max(1, Math.min(k, Number(item.bagNumber) || 1));
    bagCounts[b - 1] += 1;
    let map = perPartBags.get(item.elementId);
    if (!map) {
      map = {};
      perPartBags.set(item.elementId, map);
    }
    map[String(b)] = (map[String(b)] || 0) + 1;
  }
  const bags = bagCounts.map((count, idx) => ({
    bag_number: idx + 1,
    label: `Caja ${idx + 1}`,
    piece_count: count,
  }));
  const parts = (baseManifest.parts || []).map((p) => {
    const mapped = perPartBags.get(p.element_id);
    return {
      ...p,
      bag_counts: mapped ? { ...mapped } : { "1": 0 },
    };
  });
  return {
    ...baseManifest,
    bags,
    parts,
  };
}
