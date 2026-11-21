import { LDU_STUD } from "./constants.js";

const MIN_BUILD_W = 800;
const MIN_BUILD_D = 800;
const BUILD_ORIGIN_MIN_X = -120; // Conserva compatibilidad con guardados previos de 40468
const BAG_GAP_TO_BUILD = 70;
const BAG_CELL_GAP = 42;
const TABLE_PADDING = 90;

function snapUpTo2Studs(value, minValue) {
  const step = LDU_STUD * 2;
  return Math.ceil(Math.max(minValue, value) / step) * step;
}

/**
 * Calcula las zonas dinámicas de la mesa (Mesa de Juego a la derecha + cajas por Bolsa a la izquierda)
 * a partir del manifiesto del set, manteniendo compatibilidad con coordenadas previas.
 */
export function computeTableLayout(manifest = null) {
  const rec = manifest?.table_layout?.build_zone;
  const resolvedCount =
    manifest?.stats?.resolved_pieces ??
    (manifest?.parts || [])
      .filter((p) => p.status !== "unresolved")
      .reduce((acc, p) => acc + (p.quantity || 0), 0);

  let buildW = MIN_BUILD_W;
  let buildD = MIN_BUILD_D;
  if (rec?.width_ldu && rec?.depth_ldu) {
    buildW = snapUpTo2Studs(rec.width_ldu, MIN_BUILD_W);
    buildD = snapUpTo2Studs(rec.depth_ldu, MIN_BUILD_D);
  } else if (resolvedCount > 1200) {
    buildW = 1400;
    buildD = 1200;
  } else if (resolvedCount > 600) {
    buildW = 1200;
    buildD = 1080;
  } else if (resolvedCount > 250) {
    buildW = 1000;
    buildD = 920;
  }

  const buildZone = {
    minX: BUILD_ORIGIN_MIN_X,
    maxX: BUILD_ORIGIN_MIN_X + buildW,
    minZ: -buildD / 2,
    maxZ: buildD / 2,
    width: buildW,
    depth: buildD,
    centerX: BUILD_ORIGIN_MIN_X + buildW / 2,
    centerZ: 0,
  };

  const rawBags =
    Array.isArray(manifest?.bags) && manifest.bags.length > 0
      ? manifest.bags
      : [{ bag_number: 1, label: "Bolsa 1", piece_count: resolvedCount || 0 }];

  const bagCount = rawBags.length;
  const bagZones = [];

  if (bagCount === 1) {
    const w = 480;
    const d = Math.min(buildD, 720);
    const maxX = buildZone.minX - BAG_GAP_TO_BUILD;
    const minX = maxX - w;
    bagZones.push({
      bagNumber: rawBags[0].bag_number ?? 1,
      label: rawBags[0].label || "Bolsa 1",
      pieceCount: rawBags[0].piece_count ?? resolvedCount,
      minX,
      maxX,
      minZ: -d / 2,
      maxZ: d / 2,
      width: w,
      depth: d,
      centerX: (minX + maxX) / 2,
      centerZ: 0,
    });
  } else {
    const rowsPerCol = bagCount <= 4 ? 2 : 3;
    const cols = Math.ceil(bagCount / rowsPerCol);
    const cellW = bagCount <= 4 ? 420 : 380;
    const cellD = Math.max(300, Math.floor((buildD - (rowsPerCol - 1) * BAG_CELL_GAP) / rowsPerCol));
    const totalBagsD = rowsPerCol * cellD + (rowsPerCol - 1) * BAG_CELL_GAP;
    const startTopZ = -totalBagsD / 2;

    for (let i = 0; i < bagCount; i += 1) {
      const col = Math.floor(i / rowsPerCol);
      const row = i % rowsPerCol;
      const rightEdgeX = buildZone.minX - BAG_GAP_TO_BUILD - col * (cellW + BAG_CELL_GAP);
      const minX = rightEdgeX - cellW;
      const minZ = startTopZ + row * (cellD + BAG_CELL_GAP);
      const maxZ = minZ + cellD;
      const bagMeta = rawBags[i];
      bagZones.push({
        bagNumber: bagMeta.bag_number ?? i + 1,
        label: bagMeta.label || `Bolsa ${bagMeta.bag_number ?? i + 1}`,
        pieceCount: bagMeta.piece_count ?? 0,
        col,
        row,
        minX,
        maxX: rightEdgeX,
        minZ,
        maxZ,
        width: cellW,
        depth: cellD,
        centerX: (minX + rightEdgeX) / 2,
        centerZ: (minZ + maxZ) / 2,
      });
    }
    void cols;
  }

  let overallMinX = buildZone.minX;
  let overallMaxX = buildZone.maxX;
  let overallMinZ = buildZone.minZ;
  let overallMaxZ = buildZone.maxZ;
  for (const bz of bagZones) {
    overallMinX = Math.min(overallMinX, bz.minX);
    overallMaxX = Math.max(overallMaxX, bz.maxX);
    overallMinZ = Math.min(overallMinZ, bz.minZ);
    overallMaxZ = Math.max(overallMaxZ, bz.maxZ);
  }

  const tableBounds = {
    minX: overallMinX - TABLE_PADDING,
    maxX: overallMaxX + TABLE_PADDING,
    minZ: overallMinZ - TABLE_PADDING,
    maxZ: overallMaxZ + TABLE_PADDING,
  };
  tableBounds.width = tableBounds.maxX - tableBounds.minX;
  tableBounds.depth = tableBounds.maxZ - tableBounds.minZ;
  tableBounds.centerX = (tableBounds.minX + tableBounds.maxX) / 2;
  tableBounds.centerZ = (tableBounds.minZ + tableBounds.maxZ) / 2;

  return { tableBounds, buildZone, bagZones };
}
