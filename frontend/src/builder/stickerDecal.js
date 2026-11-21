import * as THREE from "three";

const EPS = 1e-5;
const COPLANAR_TOLERANCE_LDU = 1.0;
const FACE_NORMAL_MIN_DOT = 0.88;
const STICKER_INSET_LDU = 0.4;
const STICKER_SURFACE_OFFSET_LDU = 0.28;

function roundKey(val, decimals = 2) {
  const factor = 10 ** decimals;
  const rounded = Math.round(val * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function snapCardinalNormal(normal) {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  const maxComp = Math.max(ax, ay, az);
  if (maxComp >= FACE_NORMAL_MIN_DOT) {
    if (ax === maxComp) return new THREE.Vector3(Math.sign(normal.x) || 1, 0, 0);
    if (ay === maxComp) return new THREE.Vector3(0, Math.sign(normal.y) || 1, 0);
    return new THREE.Vector3(0, 0, Math.sign(normal.z) || 1);
  }
  return normal.clone().normalize();
}

function buildFaceBasis(localNormal, invWorldMatrix, worldNormal, cameraMatrixWorld = null) {
  const worldUpInLocal = new THREE.Vector3(0, 1, 0)
    .transformDirection(invWorldMatrix)
    .normalize();

  let refUp = worldUpInLocal;
  // En caras horizontales (arriba/abajo) orientamos según la vista de la cámara si está disponible
  if (Math.abs(worldNormal.y) >= 0.85 && cameraMatrixWorld) {
    const camUpWorld = new THREE.Vector3(0, 1, 0)
      .applyMatrix4(new THREE.Matrix4().extractRotation(cameraMatrixWorld))
      .setY(0);
    if (camUpWorld.lengthSq() > 1e-4) {
      camUpWorld.normalize();
      refUp = camUpWorld.transformDirection(invWorldMatrix).normalize();
    } else {
      refUp = new THREE.Vector3(0, 0, -1).transformDirection(invWorldMatrix).normalize();
    }
  } else if (Math.abs(refUp.dot(localNormal)) > 0.94) {
    refUp = new THREE.Vector3(0, 0, -1);
    if (Math.abs(refUp.dot(localNormal)) > 0.94) {
      refUp = new THREE.Vector3(1, 0, 0);
    }
  }

  const vAxis = refUp
    .clone()
    .addScaledVector(localNormal, -refUp.dot(localNormal));
  if (vAxis.lengthSq() < EPS) {
    vAxis.set(0, 1, 0);
  } else {
    vAxis.normalize();
  }

  // En mano derecha (u × v = n), `v × n = u` deja el lado izquierdo/derecho y arriba/abajo correctos al mirar hacia -n
  const uAxis = new THREE.Vector3().crossVectors(vAxis, localNormal).normalize();
  // Si el plano es casi cardinal en ejes locales, ajustamos uAxis/vAxis para evitar derivas mínimas
  if (Math.abs(localNormal.x) + Math.abs(localNormal.y) + Math.abs(localNormal.z) <= 1.001) {
    const snapAxis = (vec) => {
      const mx = Math.max(Math.abs(vec.x), Math.abs(vec.y), Math.abs(vec.z));
      if (mx >= 0.92) {
        if (Math.abs(vec.x) === mx) vec.set(Math.sign(vec.x), 0, 0);
        else if (Math.abs(vec.y) === mx) vec.set(0, Math.sign(vec.y), 0);
        else vec.set(0, 0, Math.sign(vec.z));
      }
    };
    snapAxis(vAxis);
    uAxis.crossVectors(vAxis, localNormal).normalize();
  }

  return { uAxis, vAxis };
}

function scanCoplanarFaceBounds(pieceMesh, localPoint, localNormal, uAxis, vAxis) {
  pieceMesh.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(pieceMesh.matrixWorld).invert();
  const relMat = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const triN = new THREE.Vector3();
  const center = new THREE.Vector3();

  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  let planeDistMax = -Infinity;
  let count = 0;

  pieceMesh.traverse((child) => {
    if (!child.isMesh || child.userData?.isSticker) return;
    const posAttr = child.geometry?.getAttribute?.("position");
    if (!posAttr) return;

    relMat.multiplyMatrices(invRoot, child.matrixWorld);
    const indexAttr = child.geometry.getIndex();
    const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);

    for (let t = 0; t < triCount; t += 1) {
      const i0 = indexAttr ? indexAttr.getX(t * 3) : t * 3;
      const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

      a.fromBufferAttribute(posAttr, i0).applyMatrix4(relMat);
      b.fromBufferAttribute(posAttr, i1).applyMatrix4(relMat);
      c.fromBufferAttribute(posAttr, i2).applyMatrix4(relMat);

      ab.subVectors(b, a);
      ac.subVectors(c, a);
      triN.crossVectors(ab, ac);
      if (triN.lengthSq() < 1e-10) continue;
      triN.normalize();
      if (triN.dot(localNormal) < FACE_NORMAL_MIN_DOT) continue;

      center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      if (Math.abs(center.sub(localPoint).dot(localNormal)) > COPLANAR_TOLERANCE_LDU) {
        continue;
      }

      for (const vert of [a, b, c]) {
        const u = vert.dot(uAxis);
        const v = vert.dot(vAxis);
        const d = vert.dot(localNormal);
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
        if (d > planeDistMax) planeDistMax = d;
      }
      count += 1;
    }
  });

  if (!count) return null;
  return { uMin, uMax, vMin, vMax, planeDist: planeDistMax };
}

function fallbackBoxBounds(localBox, localPoint, localNormal, uAxis, vAxis) {
  const corners = [
    new THREE.Vector3(localBox.min.x, localBox.min.y, localBox.min.z),
    new THREE.Vector3(localBox.max.x, localBox.min.y, localBox.min.z),
    new THREE.Vector3(localBox.min.x, localBox.max.y, localBox.min.z),
    new THREE.Vector3(localBox.max.x, localBox.max.y, localBox.min.z),
    new THREE.Vector3(localBox.min.x, localBox.min.y, localBox.max.z),
    new THREE.Vector3(localBox.max.x, localBox.min.y, localBox.max.z),
    new THREE.Vector3(localBox.min.x, localBox.max.y, localBox.max.z),
    new THREE.Vector3(localBox.max.x, localBox.max.y, localBox.max.z),
  ];
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const pt of corners) {
    const u = pt.dot(uAxis);
    const v = pt.dot(vAxis);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  return {
    uMin,
    uMax,
    vMin,
    vMax,
    planeDist: localPoint.dot(localNormal),
  };
}

/**
 * Calcula posición, orientación y tamaño exactos de la cara clickeada en espacio local de la pieza.
 */
export function computeFaceStickerPlacement({
  pieceMesh,
  localBox,
  worldPoint,
  worldNormal,
  cameraMatrixWorld = null,
}) {
  pieceMesh.updateMatrixWorld(true);
  const invWorld = new THREE.Matrix4().copy(pieceMesh.matrixWorld).invert();
  const localPoint = worldPoint.clone().applyMatrix4(invWorld);
  const rawLocalNormal = worldNormal.clone().transformDirection(invWorld).normalize();
  const localNormal = snapCardinalNormal(rawLocalNormal);

  const { uAxis, vAxis } = buildFaceBasis(
    localNormal,
    invWorld,
    worldNormal,
    cameraMatrixWorld
  );

  const bounds =
    scanCoplanarFaceBounds(pieceMesh, localPoint, localNormal, uAxis, vAxis) ||
    fallbackBoxBounds(localBox, localPoint, localNormal, uAxis, vAxis);

  const uCenter = (bounds.uMin + bounds.uMax) * 0.5;
  const vCenter = (bounds.vMin + bounds.vMax) * 0.5;
  const width = Math.max(2, bounds.uMax - bounds.uMin - STICKER_INSET_LDU);
  const height = Math.max(2, bounds.vMax - bounds.vMin - STICKER_INSET_LDU);

  const center = new THREE.Vector3()
    .addScaledVector(uAxis, uCenter)
    .addScaledVector(vAxis, vCenter)
    .addScaledVector(localNormal, bounds.planeDist + STICKER_SURFACE_OFFSET_LDU);

  const faceKey = `${roundKey(localNormal.x)},${roundKey(localNormal.y)},${roundKey(localNormal.z)}@${roundKey(bounds.planeDist, 1)}`;

  return {
    faceKey,
    center: { x: center.x, y: center.y, z: center.z },
    normal: { x: localNormal.x, y: localNormal.y, z: localNormal.z },
    uAxis: { x: uAxis.x, y: uAxis.y, z: uAxis.z },
    vAxis: { x: vAxis.x, y: vAxis.y, z: vAxis.z },
    width,
    height,
  };
}

/**
 * Crea un mesh plano con la imagen recortada apoyado exclusivamente sobre la cara elegida.
 */
export function createStickerMesh(sticker) {
  const texture = new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const img = new Image();
  img.onload = () => {
    texture.image = img;
    texture.needsUpdate = true;
  };
  img.src = sticker.dataUrl;

  const geometry = new THREE.PlaneGeometry(sticker.width, sticker.height);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.02,
    roughness: 0.32,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const mesh = new THREE.Mesh(geometry, material);
  const u = new THREE.Vector3(sticker.uAxis.x, sticker.uAxis.y, sticker.uAxis.z).normalize();
  const v = new THREE.Vector3(sticker.vAxis.x, sticker.vAxis.y, sticker.vAxis.z).normalize();
  const n = new THREE.Vector3(sticker.normal.x, sticker.normal.y, sticker.normal.z).normalize();
  const basis = new THREE.Matrix4().makeBasis(u, v, n);

  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.set(sticker.center.x, sticker.center.y, sticker.center.z);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = 2;
  mesh.userData.isSticker = true;
  mesh.userData.stickerFaceKey = sticker.faceKey;
  return mesh;
}

export function disposeStickerMesh(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose?.();
  if (mesh.material?.map) mesh.material.map.dispose();
  mesh.material?.dispose?.();
}

export async function fileToStickerDataUrl(blobOrFile, maxDim = 512) {
  if (!blobOrFile) throw new Error("No se recibió ninguna imagen.");
  const rawDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.readAsDataURL(blobOrFile);
  });

  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("El archivo no es una imagen válida."));
    el.src = rawDataUrl;
  });

  const srcW = img.naturalWidth || img.width || 1;
  const srcH = img.naturalHeight || img.height || 1;
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const targetW = Math.max(1, Math.round(srcW * scale));
  const targetH = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, targetW, targetH);
  ctx.drawImage(img, 0, 0, targetW, targetH);
  return canvas.toDataURL("image/png");
}
