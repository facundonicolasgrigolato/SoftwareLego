const STORAGE_PREFIX = "softwarelego_build_v1_";
const HISTORY_PREFIX = "softwarelego_history_v1_";
const MIGRATED_PREFIX = "softwarelego_migrated_v1_";

/**
 * Serializa las piezas colocadas sobre la mesa virtual.
 */
export function serializeBuildState(setNumber, placedPieces) {
  return {
    version: "1.0.0",
    set_number: setNumber,
    saved_at: new Date().toISOString(),
    pieces: placedPieces.map((p) => ({
      instance_id: p.instanceId,
      element_id: p.elementId,
      position: { x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z },
      rotation: { x: p.mesh.rotation.x, y: p.mesh.rotation.y, z: p.mesh.rotation.z },
      ...(Array.isArray(p.stickers) && p.stickers.length ? { stickers: p.stickers } : {}),
    })),
  };
}

function loadLegacyBuildFromLocalStorage(setNumber) {
  if (!setNumber) return null;
  const raw = localStorage.getItem(`${STORAGE_PREFIX}${setNumber}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadLegacyHistoryFromLocalStorage(setNumber) {
  if (!setNumber) return [];
  const raw = localStorage.getItem(`${HISTORY_PREFIX}${setNumber}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toPlainVec3(v) {
  if (!v || typeof v !== "object") return { x: 0, y: 0, z: 0 };
  const x = Number(v.x);
  const y = Number(v.y);
  const z = Number(v.z);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    z: Number.isFinite(z) ? z : 0,
  };
}

function toPlainEuler(r) {
  if (!r || typeof r !== "object") return { x: 0, y: 0, z: 0, order: "XYZ" };
  const x = Number(r.x ?? r._x);
  const y = Number(r.y ?? r._y);
  const z = Number(r.z ?? r._z);
  const order = typeof (r.order ?? r._order) === "string" ? (r.order ?? r._order) : "XYZ";
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    z: Number.isFinite(z) ? z : 0,
    order,
  };
}

function serializeHistoryAction(act) {
  if (!act || typeof act !== "object") return act;
  if (act.type === "add" || act.type === "remove") {
    return {
      ...act,
      position: toPlainVec3(act.position),
      rotation: toPlainEuler(act.rotation),
    };
  }
  if (act.type === "move") {
    return {
      ...act,
      prevState: {
        position: toPlainVec3(act.prevState?.position),
        rotation: toPlainEuler(act.prevState?.rotation),
      },
      newState: {
        position: toPlainVec3(act.newState?.position),
        rotation: toPlainEuler(act.newState?.rotation),
      },
    };
  }
  if (act.type === "move-group") {
    return {
      type: "move-group",
      items: (Array.isArray(act.items) ? act.items : []).map((rec) => ({
        instanceId: rec.instanceId,
        prevState: {
          position: toPlainVec3(rec.prevState?.position),
          rotation: toPlainEuler(rec.prevState?.rotation),
        },
        newState: {
          position: toPlainVec3(rec.newState?.position),
          rotation: toPlainEuler(rec.newState?.rotation),
        },
      })),
    };
  }
  if (act.type === "remove-group") {
    return {
      type: "remove-group",
      items: (Array.isArray(act.items) ? act.items : []).map((e) => ({
        ...e,
        position: toPlainVec3(e.position),
        rotation: toPlainEuler(e.rotation),
      })),
    };
  }
  return act;
}

export function serializeSlotHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-30).map(serializeHistoryAction);
}

function isFiniteCoordObj(v) {
  if (!v || typeof v !== "object") return false;
  const x = v.x ?? v._x;
  const y = v.y ?? v._y;
  const z = v.z ?? v._z;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

/**
 * Valida la estructura básica de un archivo `.json` de guardado importado.
 */
export function validateImportedSave(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.pieces)) {
    throw new Error("El archivo .json no contiene una lista válida de piezas ('pieces').");
  }
  for (let i = 0; i < parsed.pieces.length; i += 1) {
    const p = parsed.pieces[i];
    if (!p || typeof p !== "object" || typeof p.element_id !== "string" || !p.element_id.trim()) {
      throw new Error(`Pieza inválida en índice ${i}: falta 'element_id'.`);
    }
    if (!isFiniteCoordObj(p.position) || !isFiniteCoordObj(p.rotation)) {
      throw new Error(`Pieza inválida (${p.element_id}): posición o rotación no numérica.`);
    }
    if (p.stickers !== undefined) {
      if (!Array.isArray(p.stickers)) {
        throw new Error(`Pieza inválida (${p.element_id}): 'stickers' debe ser una lista.`);
      }
      for (const st of p.stickers) {
        if (
          !st ||
          typeof st.faceKey !== "string" ||
          typeof st.dataUrl !== "string" ||
          !/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(st.dataUrl)
        ) {
          throw new Error(`Pegatina inválida en pieza ${p.element_id}.`);
        }
      }
    }
  }
  return parsed;
}

async function requestJson(url, options = {}) {
  const resp = await fetch(url, options);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  if (!resp.ok || (data && data.ok === false)) {
    const errMsg = data?.error || `HTTP ${resp.status}`;
    const err = new Error(errMsg);
    err.status = resp.status;
    throw err;
  }
  return data;
}

export async function fetchSetSlots(setNumber) {
  const data = await requestJson(`/api/saves?set=${encodeURIComponent(setNumber)}`);
  return data.slots || [];
}

export async function loadSlotSave(setNumber, slot) {
  try {
    const data = await requestJson(
      `/api/saves/${encodeURIComponent(setNumber)}/${encodeURIComponent(slot)}`
    );
    return data.save || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export async function saveSlotToDisk(
  setNumber,
  slot,
  { name, pieces, history, manualPage, customBoxCount } = {}
) {
  const payload = {
    name,
    pieces: Array.isArray(pieces) ? pieces : [],
    history: serializeSlotHistory(history),
  };
  const pageNum = Number(manualPage);
  if (Number.isFinite(pageNum) && pageNum >= 1) {
    payload.manual_page = Math.round(pageNum);
  }
  if (customBoxCount === null) {
    payload.custom_box_count = null;
  } else {
    const boxNum = Number(customBoxCount);
    if (Number.isFinite(boxNum) && boxNum >= 1) {
      payload.custom_box_count = Math.max(1, Math.min(24, Math.round(boxNum)));
    }
  }
  return requestJson(`/api/saves/${encodeURIComponent(setNumber)}/${encodeURIComponent(slot)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function renameSlotOnDisk(setNumber, slot, name) {
  return requestJson(`/api/saves/${encodeURIComponent(setNumber)}/${encodeURIComponent(slot)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ renameOnly: true, name }),
  });
}

export async function deleteSlotOnDisk(setNumber, slot) {
  return requestJson(`/api/saves/${encodeURIComponent(setNumber)}/${encodeURIComponent(slot)}`, {
    method: "DELETE",
  });
}

export async function migrateLocalStorageToSlot1IfNeeded(setNumber) {
  let slots = await fetchSetSlots(setNumber);
  if (slots.some((s) => s.exists)) return slots;

  const flagKey = `${MIGRATED_PREFIX}${setNumber}`;
  try {
    if (localStorage.getItem(flagKey) === "1") return slots;
  } catch {
    // ignore storage access issues
  }

  const legacyBuild = loadLegacyBuildFromLocalStorage(setNumber);
  if (legacyBuild?.pieces?.length) {
    const legacyHistory = loadLegacyHistoryFromLocalStorage(setNumber);
    const res = await saveSlotToDisk(setNumber, 1, {
      name: "Slot 1",
      pieces: legacyBuild.pieces,
      history: legacyHistory,
    });
    try {
      localStorage.setItem(flagKey, "1");
    } catch {
      // ignore
    }
    if (res?.slots) slots = res.slots;
  }
  return slots;
}
