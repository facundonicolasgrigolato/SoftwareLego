import * as THREE from "three";
import { LDrawLoader } from "three/examples/jsm/loaders/LDrawLoader.js";
import { LDrawConditionalLineMaterial } from "three/examples/jsm/materials/LDrawConditionalLineMaterial.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildCollisionMeshData } from "../builder/meshCollision.js";
import { extractPartFeatures } from "../builder/connectors.js";

const MAX_CONCURRENT_LOADS = 8;

/**
 * Servicio centralizado para cargar piezas `.dat` usando `LDrawLoader` oficial,
 * con cola de concurrencia limitada, caché de prototipos y extracción de studs/apoyos.
 */
export class LDrawService {
  constructor() {
    this.loader = new LDrawLoader();
    this.loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
    this.loader.setPartsLibraryPath("/ldraw/");
    this.loader.smoothNormals = true;

    this._materialsReady = null;
    this._prototypeCache = new Map();
    this._activeLoads = 0;
    this._queue = [];
  }

  async ensureMaterialsLoaded() {
    if (!this._materialsReady) {
      this._materialsReady = this.loader.preloadMaterials("/ldraw/LDConfig.ldr");
    }
    return this._materialsReady;
  }

  static cacheKey(part) {
    const colorKey = part.ldraw_color_code ?? part.color_rgb ?? "16";
    return `${part.ldraw_part_id}__${colorKey}__${part.is_trans ? "t" : "s"}`;
  }

  async createPartInstance(part, { lightweight = false, proxyOnly = false } = {}) {
    await this.ensureMaterialsLoaded();

    const key = LDrawService.cacheKey(part);
    if (!this._prototypeCache.has(key)) {
      const promise = this._enqueueLoad(() => this._loadPrototype(part));
      this._prototypeCache.set(key, promise);
    }

    const proto = await this._prototypeCache.get(key);
    const useProxy = Boolean(proxyOnly && proto.batchedMeshGeo);
    const clone = useProxy ? new THREE.Group() : proto.group.clone(true);

    clone.userData.topStuds = proto.topStuds.map((s) => ({
      pos: s.pos.clone(),
      up: s.up.clone(),
      height: s.height,
    }));
    clone.userData.antiStuds = proto.antiStuds || [];
    clone.userData.connectors = proto.connectors;
    clone.userData.pinHoles = proto.pinHoles;
    clone.userData.pinConnectors = proto.pinConnectors;
    clone.userData.defaultSupportUndersideY = proto.defaultSupportUndersideY;
    clone.userData.recessedSupportUndersideY = proto.recessedSupportUndersideY;
    clone.userData.collisionBoxes = proto.collisionBoxes.map((b) => b.clone());
    clone.userData.collisionMeshData = proto.collisionMeshData;
    clone.userData.bottomReceptors = proto.bottomReceptors.map((r) => r.clone());
    clone.userData.recessedReceptors = proto.recessedReceptors.map((r) => r.clone());
    clone.userData.protoKey = key;
    clone.userData.batchedMeshGeo = proto.batchedMeshGeo;
    clone.userData.batchedEdgeGeo = proto.batchedEdgeGeo;
    clone.userData.visualTemplateGroup = proto.group;
    clone.userData.ensureVisualChildren = () => {
      if (clone.children.length > 0 || !proto.group) return;
      for (const child of proto.group.children) {
        clone.add(child.clone(true));
      }
    };

    if (!useProxy && lightweight) {
      clone.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = false;
        } else if (child.isConditionalLine || child.type === "ConditionalLineSegments") {
          child.visible = false;
        }
      });
    }
    return {
      group: clone,
      localBox: proto.localBox.clone(),
      topStuds: clone.userData.topStuds,
    };
  }

  _enqueueLoad(taskFn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        this._activeLoads += 1;
        taskFn()
          .then(resolve, reject)
          .finally(() => {
            this._activeLoads -= 1;
            const next = this._queue.shift();
            if (next) next();
          });
      };

      if (this._activeLoads < MAX_CONCURRENT_LOADS) {
        run();
      } else {
        this._queue.push(run);
      }
    });
  }

  /**
   * Extrae las posiciones de studs (`stud*.dat`) en coordenadas del `wrapper` (+Y arriba).
   * Permite alinear piezas con salientes laterales (como brackets) exacto stud-con-stud.
   */
  /**
   * Extrae studs (`stud*.dat`), agujeros Technic (`peghole.dat`) y vástagos de pin
   * (`connect*` / `confric*`) en coordenadas del `wrapper` (+Y arriba) con un único recorrido.
   */
  _extractPartFeatures(datFileName, localBox = null) {
    return extractPartFeatures(datFileName, this.loader.partsCache?.parseCache, localBox);
  }

  _extractStudPositions(datFileName) {
    return this._extractPartFeatures(datFileName).topStuds;
  }

  async _loadPrototype(part) {
    const colorCode = part.ldraw_color_code ?? 16;
    const datFile = `${part.ldraw_part_id}.dat`;
    const ldrText = [
      `0 ${part.part_name || part.ldraw_part_id}`,
      `1 ${colorCode} 0 0 0 1 0 0 0 1 0 0 0 1 ${datFile}`,
      "",
    ].join("\n");

    const rawGroup = await new Promise((resolve, reject) => {
      this.loader.parse(ldrText, resolve, reject);
    });

    // En LDraw +Y apunta hacia abajo; rotar PI en X alinea al eje +Y arriba de Three.js
    const wrapper = new THREE.Group();
    rawGroup.rotation.x = Math.PI;
    wrapper.add(rawGroup);

    if (part.ldraw_color_code == null && part.color_rgb) {
      const fallbackColor = new THREE.Color(part.color_rgb);
      wrapper.traverse((child) => {
        if (child.isMesh && child.material) {
          const mat = child.material.clone();
          mat.color.copy(fallbackColor);
          if (part.is_trans) {
            mat.transparent = true;
            mat.opacity = 0.65;
          }
          child.material = mat;
        }
      });
    }

    wrapper.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    wrapper.updateMatrixWorld(true);
    const localBox = new THREE.Box3().setFromObject(wrapper);
    const { topStuds, antiStuds, pinBarrels, connectors } = this._extractPartFeatures(
      datFile,
      localBox
    );
    const pinHoles = connectors.filter((c) => c.kind === "pin" && c.role === "hole");
    const pinConnectors = connectors.filter((c) => c.kind === "pin" && c.role === "plug");
    const { supportY: defaultSupportUndersideY, recessedY: recessedSupportUndersideY } =
      LDrawService.computeSupportUndersideProfile(wrapper, localBox, antiStuds);
    const collisionBoxes = LDrawService.buildCollisionBoxes(wrapper, localBox, topStuds);
    const isMinifigHead =
      connectors.some((c) => c.kind === "minifig_neck" && c.role === "socket") &&
      topStuds.length === 1 &&
      topStuds[0].up.y > 0.85;
    const collisionMeshData = buildCollisionMeshData(
      wrapper,
      topStuds,
      collisionBoxes,
      pinBarrels,
      {
        antiStuds,
        isMinifigHead,
        headTopStud: isMinifigHead ? topStuds[0] : null,
      }
    );
    const { bottomReceptors, recessedReceptors } = LDrawService.extractBottomReceptors(
      collisionBoxes,
      localBox,
      defaultSupportUndersideY,
      topStuds,
      wrapper,
      antiStuds
    );
    const { batchedMeshGeo, batchedEdgeGeo } = LDrawService.buildBatchedGeometries(
      wrapper,
      Boolean(part.is_trans)
    );
    return {
      group: wrapper,
      localBox,
      topStuds,
      antiStuds,
      connectors,
      pinHoles,
      pinConnectors,
      defaultSupportUndersideY,
      recessedSupportUndersideY,
      collisionBoxes,
      collisionMeshData,
      bottomReceptors,
      recessedReceptors,
      batchedMeshGeo,
      batchedEdgeGeo,
    };
  }

  /**
   * Invierte el orden de los vértices de cada triángulo `[i, i+1, i+2] -> [i, i+2, i+1]`
   * en una geometría no indexada, necesario tras aplicar una transformación espejo (`det < 0`).
   */
  static _reverseTriangleWinding(geo) {
    const pos = geo.attributes.position;
    if (!pos) return;
    const count = pos.count;
    for (const attr of Object.values(geo.attributes)) {
      const itemSize = attr.itemSize;
      const arr = attr.array;
      for (let i = 0; i + 2 < count; i += 3) {
        for (let k = 0; k < itemSize; k += 1) {
          const i1 = (i + 1) * itemSize + k;
          const i2 = (i + 2) * itemSize + k;
          const tmp = arr[i1];
          arr[i1] = arr[i2];
          arr[i2] = tmp;
        }
      }
      attr.needsUpdate = true;
    }
  }

  /**
   * Fusiona todas las mallas opacas y líneas de borde de un prototipo en un par de
   * geometrías planas (`batchedMeshGeo`, `batchedEdgeGeo`) listas para `BatchedPieceLayer`.
   */
  static buildBatchedGeometries(wrapper, isTransPart = false) {
    if (isTransPart) return { batchedMeshGeo: null, batchedEdgeGeo: null };
    wrapper.updateMatrixWorld(true);
    const invRoot = new THREE.Matrix4().copy(wrapper.matrixWorld).invert();
    const relMat = new THREE.Matrix4();

    let hasTransparent = false;
    const meshParts = [];
    const edgeParts = [];

    wrapper.traverse((child) => {
      if (hasTransparent) return;
      if (child.isMesh && child.geometry && child.visible) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (m?.transparent && m.opacity < 0.99) {
            hasTransparent = true;
            return;
          }
        }
        relMat.multiplyMatrices(invRoot, child.matrixWorld);
        const geo = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
        geo.applyMatrix4(relMat);
        if (relMat.determinant() < 0) {
          LDrawService._reverseTriangleWinding(geo);
        }
        if (!geo.attributes.normal) geo.computeVertexNormals();

        const posCount = geo.attributes.position.count;
        const srcCol = geo.attributes.color;
        const colArr = new Float32Array(posCount * 3);

        if (Array.isArray(child.material) && geo.groups?.length) {
          for (const g of geo.groups) {
            const c = child.material[g.materialIndex]?.color || mats[0]?.color;
            const r = c ? c.r : 0.8;
            const gr = c ? c.g : 0.8;
            const b = c ? c.b : 0.8;
            const end = Math.min(posCount, g.start + g.count);
            for (let i = g.start; i < end; i += 1) {
              const sr = srcCol ? srcCol.getX(i) : 1;
              const sg = srcCol ? srcCol.getY(i) : 1;
              const sb = srcCol ? srcCol.getZ(i) : 1;
              colArr[i * 3] = r * sr;
              colArr[i * 3 + 1] = gr * sg;
              colArr[i * 3 + 2] = b * sb;
            }
          }
        } else {
          const c = mats[0]?.color;
          const r = c ? c.r : 0.8;
          const gr = c ? c.g : 0.8;
          const b = c ? c.b : 0.8;
          for (let i = 0; i < posCount; i += 1) {
            const sr = srcCol ? srcCol.getX(i) : 1;
            const sg = srcCol ? srcCol.getY(i) : 1;
            const sb = srcCol ? srcCol.getZ(i) : 1;
            colArr[i * 3] = r * sr;
            colArr[i * 3 + 1] = gr * sg;
            colArr[i * 3 + 2] = b * sb;
          }
        }

        for (const attrName of Object.keys(geo.attributes)) {
          if (attrName !== "position" && attrName !== "normal") {
            geo.deleteAttribute(attrName);
          }
        }
        geo.clearGroups();
        geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
        meshParts.push(geo);
      } else if (
        child.isLineSegments &&
        child.geometry &&
        child.visible &&
        !child.isConditionalLine &&
        child.type !== "ConditionalLineSegments"
      ) {
        relMat.multiplyMatrices(invRoot, child.matrixWorld);
        const geo = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
        geo.applyMatrix4(relMat);
        const posCount = geo.attributes.position.count;
        const c = child.material?.color;
        const r = c ? c.r : 0.02;
        const g = c ? c.g : 0.03;
        const b = c ? c.b : 0.05;
        const colArr = new Float32Array(posCount * 3);
        for (let i = 0; i < posCount; i += 1) {
          colArr[i * 3] = r;
          colArr[i * 3 + 1] = g;
          colArr[i * 3 + 2] = b;
        }
        for (const attrName of Object.keys(geo.attributes)) {
          if (attrName !== "position") {
            geo.deleteAttribute(attrName);
          }
        }
        geo.clearGroups();
        geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
        edgeParts.push(geo);
      }
    });

    if (hasTransparent || !meshParts.length) {
      for (const g of meshParts) g.dispose();
      for (const g of edgeParts) g.dispose();
      return { batchedMeshGeo: null, batchedEdgeGeo: null };
    }

    const batchedMeshGeo = meshParts.length === 1 ? meshParts[0] : mergeGeometries(meshParts, false);
    if (meshParts.length > 1) {
      for (const g of meshParts) g.dispose();
    }
    batchedMeshGeo?.computeBoundingBox();
    batchedMeshGeo?.computeBoundingSphere();

    let batchedEdgeGeo = null;
    if (edgeParts.length > 0) {
      batchedEdgeGeo = edgeParts.length === 1 ? edgeParts[0] : mergeGeometries(edgeParts, false);
      if (edgeParts.length > 1) {
        for (const g of edgeParts) g.dispose();
      }
    }

    return { batchedMeshGeo, batchedEdgeGeo };
  }

  /**
   * Descompone la malla LDraw en sub-cajas AABB ajustadas (voxeles de ~4 LDU agrupados)
   * excluyendo las protuberancias de los studs para permitir encastres reales en piezas
   * cóncavas como brackets (`44728`) o pendientes (`3660`) sin falsos choques.
   */
  static buildCollisionBoxes(wrapper, localBox, topStuds = []) {
    // Limpiamos ruido de punto flotante (~1e-15 por Math.PI) para evitar cajas fantasma
    const minX = Math.round(localBox.min.x * 1000) / 1000;
    const minY = Math.round(localBox.min.y * 1000) / 1000;
    const minZ = Math.round(localBox.min.z * 1000) / 1000;
    const maxX = Math.round(localBox.max.x * 1000) / 1000;
    const maxY = Math.round(localBox.max.y * 1000) / 1000;
    const maxZ = Math.round(localBox.max.z * 1000) / 1000;

    const sizeX = Math.max(0.1, maxX - minX);
    const sizeY = Math.max(0.1, maxY - minY);
    const sizeZ = Math.max(0.1, maxZ - minZ);

    // Si una pieza compacta tiene bordes a múltiplos de 2 LDU (ej. 10, -10, 14 en 4081b/44728),
    // usamos paso 2 LDU y alineamos la grilla a LDU exactos para que una placa (-8) nunca sangre a -10.
    const hasSub4Edge = (vMin, vMax) => {
      const m1 = Math.abs(vMin % 4);
      const m2 = Math.abs(vMax % 4);
      return (m1 > 0.4 && m1 < 3.6) || (m2 > 0.4 && m2 < 3.6);
    };
    const vx = sizeX <= 48 && hasSub4Edge(minX, maxX) ? 2 : Math.max(4, Math.ceil(sizeX / 80));
    const vy = sizeY <= 48 && hasSub4Edge(minY, maxY) ? 2 : Math.max(4, Math.ceil(sizeY / 60));
    const vz = sizeZ <= 48 && hasSub4Edge(minZ, maxZ) ? 2 : Math.max(4, Math.ceil(sizeZ / 80));

    const gridMinX = Math.floor(minX / vx) * vx;
    const gridMinY = Math.floor(minY / vy) * vy;
    const gridMinZ = Math.floor(minZ / vz) * vz;

    const nx = Math.max(1, Math.ceil((maxX - gridMinX - 0.05) / vx));
    const ny = Math.max(1, Math.ceil((maxY - gridMinY - 0.05) / vy));
    const nz = Math.max(1, Math.ceil((maxZ - gridMinZ - 0.05) / vz));
    const minStep = Math.min(vx, vy, vz);
    const grid = new Uint8Array(nx * ny * nz);

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const triCenter = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const norm = new THREE.Vector3();
    const pt = new THREE.Vector3();
    const diff = new THREE.Vector3();

    const isInsideStud = (p) => {
      for (let i = 0; i < topStuds.length; i += 1) {
        const s = topStuds[i];
        diff.subVectors(p, s.pos);
        const proj = diff.dot(s.up);
        const maxProj = (s.height || 4) + 0.7;
        // Excluimos todo el cilindro del stud desde su base (-0.08) hacia afuera
        // para que nunca genere voxeles sólidos que bloqueen el encastre.
        if (proj >= -0.08 && proj <= maxProj) {
          const radialSq = diff.lengthSq() - proj * proj;
          if (radialSq <= 6.35 * 6.35) return true;
        }
      }
      return false;
    };

    wrapper.updateMatrixWorld(true);
    wrapper.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const pos = child.geometry.attributes.position;
      if (!pos) return;
      const index = child.geometry.index;
      const mat = child.matrixWorld;
      const triCount = index ? index.count / 3 : pos.count / 3;

      for (let i = 0; i < triCount; i += 1) {
        const i0 = index ? index.getX(i * 3) : i * 3;
        const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
        const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;

        a.fromBufferAttribute(pos, i0).applyMatrix4(mat);
        b.fromBufferAttribute(pos, i1).applyMatrix4(mat);
        c.fromBufferAttribute(pos, i2).applyMatrix4(mat);

        ab.subVectors(b, a);
        ac.subVectors(c, a);
        norm.crossVectors(ab, ac);
        const nLen = norm.length();
        if (nLen < 1e-5) continue;
        norm.divideScalar(nLen);

        triCenter.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        const maxEdge = Math.max(
          a.distanceTo(b),
          b.distanceTo(c),
          c.distanceTo(a)
        );
        const steps = Math.min(36, Math.max(1, Math.ceil(maxEdge / (minStep * 0.8))));

        for (let u = 0; u <= steps; u += 1) {
          for (let v = 0; v <= steps - u; v += 1) {
            const w = steps - u - v;
            pt.set(
              (a.x * u + b.x * v + c.x * w) / steps,
              (a.y * u + b.y * v + c.y * w) / steps,
              (a.z * u + b.z * v + c.z * w) / steps
            );
            // Acercamos levemente al centroide del triángulo y hacia adentro de la normal
            // para evitar que aristas exactas (ej. z=+14 o y=0) sangren al voxel siguiente.
            pt.lerp(triCenter, 0.04);
            pt.addScaledVector(norm, -0.3);
            if (isInsideStud(pt)) continue;

            const ix = Math.max(0, Math.min(nx - 1, Math.floor((pt.x - gridMinX) / vx)));
            const iy = Math.max(0, Math.min(ny - 1, Math.floor((pt.y - gridMinY) / vy)));
            const iz = Math.max(0, Math.min(nz - 1, Math.floor((pt.z - gridMinZ) / vz)));
            grid[(iy * nz + iz) * nx + ix] = 1;
          }
        }
      }
    });

    // Fusión codiciosa de voxeles ocupados en cajas mínimas
    const visited = new Uint8Array(nx * ny * nz);
    const boxes = [];
    const idxAt = (x, y, z) => (y * nz + z) * nx + x;

    for (let y = 0; y < ny; y += 1) {
      for (let z = 0; z < nz; z += 1) {
        for (let x = 0; x < nx; x += 1) {
          const startIdx = idxAt(x, y, z);
          if (!grid[startIdx] || visited[startIdx]) continue;

          let ex = x + 1;
          while (ex < nx && grid[idxAt(ex, y, z)] && !visited[idxAt(ex, y, z)]) ex += 1;

          let ez = z + 1;
          outerZ: while (ez < nz) {
            for (let xx = x; xx < ex; xx += 1) {
              const id = idxAt(xx, y, ez);
              if (!grid[id] || visited[id]) break outerZ;
            }
            ez += 1;
          }

          let ey = y + 1;
          outerY: while (ey < ny) {
            for (let zz = z; zz < ez; zz += 1) {
              for (let xx = x; xx < ex; xx += 1) {
                const id = idxAt(xx, ey, zz);
                if (!grid[id] || visited[id]) break outerY;
              }
            }
            ey += 1;
          }

          for (let yy = y; yy < ey; yy += 1) {
            for (let zz = z; zz < ez; zz += 1) {
              for (let xx = x; xx < ex; xx += 1) {
                visited[idxAt(xx, yy, zz)] = 1;
              }
            }
          }

          boxes.push(
            new THREE.Box3(
              new THREE.Vector3(
                Math.max(minX, gridMinX + x * vx),
                Math.max(minY, gridMinY + y * vy),
                Math.max(minZ, gridMinZ + z * vz)
              ),
              new THREE.Vector3(
                Math.min(maxX, gridMinX + ex * vx),
                Math.min(maxY, gridMinY + ey * vy),
                Math.min(maxZ, gridMinZ + ez * vz)
              )
            )
          );
        }
      }
    }

    return boxes.length ? boxes : [localBox.clone()];
  }

  /**
   * Analiza la geometría ya rotada para detectar tanto el plano de apoyo principal
   * (`supportY`) como un eventual techo/hueco rebajado (`recessedY`, p. ej. 66792) que
   * permite encastrar sobre un plate/brick angosto sin chocar las faldillas laterales.
   */
  static computeSupportUndersideY(object3D, box) {
    return LDrawService.computeSupportUndersideProfile(object3D, box).supportY;
  }

  static computeSupportUndersideProfile(object3D, box, antiStuds = []) {
    const totalW = Math.max(1, box.max.x - box.min.x);
    const totalD = Math.max(1, box.max.z - box.min.z);
    const totalArea = totalW * totalD;

    let sliceMinX = Infinity;
    let sliceMaxX = -Infinity;
    let sliceMinZ = Infinity;
    let sliceMaxZ = -Infinity;
    let hasSlice = false;

    let bottomMinX = Infinity;
    let bottomMaxX = -Infinity;
    let bottomMinZ = Infinity;
    let bottomMaxZ = -Infinity;
    let hasBottomSlice = false;

    const buckets = new Map();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const cross = new THREE.Vector3();
    const sliceLimitY = box.min.y + 4.5;
    const bottomLimitY = box.min.y + 1.2;

    object3D.updateMatrixWorld(true);
    object3D.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      const pos = child.geometry.attributes.position;
      if (!pos) return;
      const index = child.geometry.index;
      const mat = child.matrixWorld;
      const count = pos.count;

      for (let k = 0; k < count; k += 1) {
        a.fromBufferAttribute(pos, k).applyMatrix4(mat);
        if (a.y <= sliceLimitY) {
          hasSlice = true;
          if (a.x < sliceMinX) sliceMinX = a.x;
          if (a.x > sliceMaxX) sliceMaxX = a.x;
          if (a.z < sliceMinZ) sliceMinZ = a.z;
          if (a.z > sliceMaxZ) sliceMaxZ = a.z;
        }
        if (a.y <= bottomLimitY) {
          hasBottomSlice = true;
          if (a.x < bottomMinX) bottomMinX = a.x;
          if (a.x > bottomMaxX) bottomMaxX = a.x;
          if (a.z < bottomMinZ) bottomMinZ = a.z;
          if (a.z > bottomMaxZ) bottomMaxZ = a.z;
        }
      }

      const triCount = index ? index.count / 3 : pos.count / 3;
      for (let i = 0; i < triCount; i += 1) {
        const i0 = index ? index.getX(i * 3) : i * 3;
        const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
        const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;

        a.fromBufferAttribute(pos, i0).applyMatrix4(mat);
        b.fromBufferAttribute(pos, i1).applyMatrix4(mat);
        c.fromBufferAttribute(pos, i2).applyMatrix4(mat);

        ab.subVectors(b, a);
        ac.subVectors(c, a);
        cross.crossVectors(ab, ac);
        const area2 = cross.length();
        if (area2 < 1e-4) continue;

        if (cross.y / area2 < -0.985) {
          const yBucket = Math.round(a.y / 4) * 4;
          buckets.set(yBucket, (buckets.get(yBucket) || 0) + area2);
        }
      }
    });

    if (!hasSlice) return { supportY: box.min.y, recessedY: null };
    const sliceArea = Math.max(0, sliceMaxX - sliceMinX) * Math.max(0, sliceMaxZ - sliceMinZ);
    const bottomArea = hasBottomSlice
      ? Math.max(0, bottomMaxX - bottomMinX) * Math.max(0, bottomMaxZ - bottomMinZ)
      : 0;
    const minYBucket = Math.round(box.min.y / 4) * 4;
    let totalDownArea = 0;
    let maxBucketArea = 0;
    for (const area of buckets.values()) {
      totalDownArea += area;
      if (area > maxBucketArea) maxBucketArea = area;
    }

    let supportY = box.min.y;
    if (sliceArea / totalArea >= 0.35) {
      // Si el borde inferior (`box.min.y + 1.2`) cubre la huella de la pieza (ej. plato 4740)
      // o tiene cara plana real, apoya en `box.min.y`. Solo elevamos en salientes chicas (ej. anillo de 4081b).
      const minArea = buckets.get(minYBucket) || 0;
      if (bottomArea / totalArea >= 0.35 || minArea >= maxBucketArea * 0.08 || totalDownArea <= 0) {
        supportY = box.min.y;
      } else {
        for (const [yVal, area] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
          if (yVal >= minYBucket && yVal <= minYBucket + 4.5 && area >= maxBucketArea * 0.15) {
            supportY = yVal;
            break;
          }
        }
      }
    } else {
      // Es una pieza colgante (ej. bracket 44728): buscamos el plano horizontal más bajo
      // de su pestaña superior (borde real de apoyo, por ej. -8 y no el hueco interno -4).
      const candidates = [];
      let bestHangArea = -1;
      for (const [yVal, area] of buckets.entries()) {
        if (yVal < 0 && yVal > box.min.y + 8) {
          candidates.push([yVal, area]);
          if (area > bestHangArea) bestHangArea = area;
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => a[0] - b[0]);
        supportY = candidates[0][0];
        for (const [yVal, area] of candidates) {
          if (area >= bestHangArea * 0.08) {
            supportY = yVal;
            break;
          }
        }
      }
      if (antiStuds.length > 0) {
        const antiY = Math.round(antiStuds[0].pos.y * 1000) / 1000;
        if (antiY > box.min.y + 1.5 && antiY <= box.max.y - 1) {
          supportY = antiY;
        }
      }
    }

    // Techo interior real (ej. -8 en 66792 con faldillas en -16) que domina sobre el borde
    let recessedY = null;
    if (supportY <= -12) {
      const defBucket = Math.round(supportY / 4) * 4;
      const defArea = buckets.get(defBucket) || 0;
      for (const [yVal, area] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        if (yVal >= defBucket + 6 && yVal <= -8 && area > defArea * 1.1 && area >= maxBucketArea * 0.12) {
          recessedY = yVal;
          break;
        }
      }
    }

    return { supportY, recessedY };
  }

  /**
   * Calcula los puntos hembra (receptores de encastre en el plano inferior `supportY`)
   * y muescas elevadas (`recessedReceptors`, ej. +8 LDU en 5095/5093 con stud notch)
   * usando studs reales hacia +Y cuando coinciden con toda la base, o grilla 20x20 de la huella.
   */
  static extractBottomReceptors(
    collisionBoxes,
    localBox,
    supportY,
    topStuds = [],
    object3D = null,
    antiStuds = []
  ) {
    const upStuds = topStuds.filter((s) => s.up && s.up.y > 0.85);
    const matchingAntiStuds = (antiStuds || []).filter(
      (a) => Math.abs(a.pos.y - supportY) <= 1.0
    );
    if (upStuds.length === 0 && matchingAntiStuds.length > 0 && supportY > localBox.min.y + 1.5) {
      return {
        bottomReceptors: matchingAntiStuds.map(
          (a) =>
            new THREE.Vector3(
              Math.round(a.pos.x * 10) / 10,
              supportY,
              Math.round(a.pos.z * 10) / 10
            )
        ),
        recessedReceptors: [],
      };
    }
    const bandMinY = supportY - 0.5;
    const bandMaxY = supportY + 5.5;
    const sliceBoxes = collisionBoxes.filter(
      (b) => b.max.y >= bandMinY && b.min.y <= bandMaxY
    );

    const NOTCH_OFFSETS = [8, 16, 24];
    const lowTriCentroids = [];
    const cellTriBounds = [];
    const notchTrisByDy = new Map(NOTCH_OFFSETS.map((d) => [d, []]));
    if (object3D) {
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const ab = new THREE.Vector3();
      const ac = new THREE.Vector3();
      const cross = new THREE.Vector3();
      object3D.updateMatrixWorld(true);
      object3D.traverse((child) => {
        if (!child.isMesh || !child.geometry) return;
        const pos = child.geometry.attributes.position;
        if (!pos) return;
        const index = child.geometry.index;
        const mat = child.matrixWorld;
        const triCount = index ? index.count / 3 : pos.count / 3;
        for (let i = 0; i < triCount; i += 1) {
          const i0 = index ? index.getX(i * 3) : i * 3;
          const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
          const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;
          a.fromBufferAttribute(pos, i0).applyMatrix4(mat);
          b.fromBufferAttribute(pos, i1).applyMatrix4(mat);
          c.fromBufferAttribute(pos, i2).applyMatrix4(mat);
          const cx = (a.x + b.x + c.x) / 3;
          const cy = (a.y + b.y + c.y) / 3;
          const cz = (a.z + b.z + c.z) / 3;
          cellTriBounds.push({ x: cx, y: cy, z: cz });
          if (cy <= supportY + 2.5) {
            lowTriCentroids.push({ x: cx, z: cz });
          }
          for (const dy of NOTCH_OFFSETS) {
            if (localBox.max.y >= supportY + dy + 3.5 && Math.abs(cy - (supportY + dy)) <= 1.2) {
              ab.subVectors(b, a);
              ac.subVectors(c, a);
              cross.crossVectors(ab, ac);
              const area2 = cross.length();
              if (area2 > 1e-4 && Math.abs(cross.y) / area2 > 0.85) {
                notchTrisByDy.get(dy).push({ x: cx, z: cz, area2 });
              }
            }
          }
        }
      });
    }

    const hasLowMeshInCell = (cx, cz) => {
      if (!object3D || lowTriCentroids.length === 0) return true;
      for (const t of lowTriCentroids) {
        if (t.x > cx - 9 && t.x < cx + 9 && t.z > cz - 9 && t.z < cz + 9) {
          return true;
        }
      }
      return false;
    };

    const findNotchRoofYInCell = (cx, cz) => {
      if (!object3D || localBox.max.y < supportY + 11.5) return null;
      let cellMaxY = -Infinity;
      for (const t of cellTriBounds) {
        if (t.x >= cx - 9 && t.x <= cx + 9 && t.z >= cz - 9 && t.z <= cz + 9 && t.y > cellMaxY) {
          cellMaxY = t.y;
        }
      }
      for (const dy of NOTCH_OFFSETS) {
        const targetY = supportY + dy;
        if (localBox.max.y < targetY + 3.5 || cellMaxY < targetY + 3.5) continue;
        // Verificamos que el centro de la celda debajo de targetY esté despejado (sin cuña diagonal)
        let blockedBelow = false;
        for (const t of cellTriBounds) {
          if (
            t.y > supportY + 2.5 &&
            t.y < targetY - 1.5 &&
            t.x >= cx - 5 &&
            t.x <= cx + 5 &&
            t.z >= cz - 5 &&
            t.z <= cz + 5
          ) {
            blockedBelow = true;
            break;
          }
        }
        if (blockedBelow) continue;
        let area2 = 0;
        for (const t of notchTrisByDy.get(dy)) {
          if (t.x >= cx - 9 && t.x <= cx + 9 && t.z >= cz - 9 && t.z <= cz + 9) {
            area2 += t.area2;
          }
        }
        if (area2 >= 80) return targetY;
      }
      return null;
    };

    if (!sliceBoxes.length) {
      const fallback = upStuds.length
        ? upStuds.map((s) => new THREE.Vector3(s.pos.x, supportY, s.pos.z))
        : [
            new THREE.Vector3(
              (localBox.min.x + localBox.max.x) * 0.5,
              supportY,
              (localBox.min.z + localBox.max.z) * 0.5
            ),
          ];
      return { bottomReceptors: fallback, recessedReceptors: [] };
    }

    // Solo consideramos cajas que formen parte del cuerpo base (>= 12 LDU en al menos un eje,
    // así no descartamos paredes finas de 4 LDU en plates huecos como 3710 o bricks como 3004).
    const bodyBoxes = sliceBoxes.filter(
      (b) => Math.max(b.max.x - b.min.x, b.max.z - b.min.z) >= 12
    );
    const baseBoxes = bodyBoxes.length ? bodyBoxes : sliceBoxes;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const b of baseBoxes) {
      if (b.min.x < minX) minX = b.min.x;
      if (b.max.x > maxX) maxX = b.max.x;
      if (b.min.z < minZ) minZ = b.min.z;
      if (b.max.z > maxZ) maxZ = b.max.z;
    }

    // Si una celda única quedó truncada (< 19.5 LDU) por extremos curvos < 12 LDU (ej. 24246),
    // recuperamos su ancho real con cajas >= 8 LDU dentro de 1 stud (<= 20.5 LDU).
    const slice8 = sliceBoxes.filter(
      (b) => Math.max(b.max.x - b.min.x, b.max.z - b.min.z) >= 8
    );
    if (slice8.length) {
      let s8MinX = Infinity;
      let s8MaxX = -Infinity;
      let s8MinZ = Infinity;
      let s8MaxZ = -Infinity;
      for (const b of slice8) {
        if (b.min.x < s8MinX) s8MinX = b.min.x;
        if (b.max.x > s8MaxX) s8MaxX = b.max.x;
        if (b.min.z < s8MinZ) s8MinZ = b.min.z;
        if (b.max.z > s8MaxZ) s8MaxZ = b.max.z;
      }
      if (maxX - minX < 19.5 && s8MaxX - s8MinX > maxX - minX && s8MaxX - s8MinX <= 20.5) {
        minX = s8MinX;
        maxX = s8MaxX;
      }
      if (maxZ - minZ < 19.5 && s8MaxZ - s8MinZ > maxZ - minZ && s8MaxZ - s8MinZ <= 20.5) {
        minZ = s8MinZ;
        maxZ = s8MaxZ;
      }
    }

    const alignStart = (rawStart, ax) => {
      const distinctAxisStuds = new Set(upStuds.map((s) => Math.round(s.pos[ax])));
      if (distinctAxisStuds.size >= 2) {
        const ref = upStuds[0].pos[ax];
        const aligned = Math.round((rawStart - ref) / 20) * 20 + ref;
        if (Math.abs(aligned - rawStart) <= 10.5) return Math.round(aligned * 10) / 10;
      }
      const lbMin = localBox.min[ax];
      if (Math.abs(lbMin - Math.round(lbMin / 10) * 10) < 0.5) {
        const ref = Math.round(lbMin / 10) * 10 + 10;
        const aligned = Math.round((rawStart - ref) / 20) * 20 + ref;
        if (Math.abs(aligned - rawStart) <= 3.5) return Math.round(aligned * 10) / 10;
      }
      return rawStart;
    };

    const countX = Math.max(1, Math.round((maxX - minX) / 20));
    const countZ = Math.max(1, Math.round((maxZ - minZ) / 20));
    const gridCells = [];
    const recessedReceptors = [];
    const startX = alignStart(Math.round((minX + 10) * 10) / 10, "x");
    const startZ = alignStart(Math.round((minZ + 10) * 10) / 10, "z");
    const checkY = supportY + 2.5;

    const hasBaseCellAt = (cx, cz) => {
      let cellMinX = Infinity;
      let cellMaxX = -Infinity;
      let cellMinZ = Infinity;
      let cellMaxZ = -Infinity;
      for (const b of baseBoxes) {
        if (
          cx >= b.min.x - 9.5 &&
          cx <= b.max.x + 9.5 &&
          cz >= b.min.z - 9.5 &&
          cz <= b.max.z + 9.5 &&
          checkY >= b.min.y - 3 &&
          checkY <= b.max.y + 3
        ) {
          cellMinX = Math.min(cellMinX, Math.max(cx - 10, b.min.x));
          cellMaxX = Math.max(cellMaxX, Math.min(cx + 10, b.max.x));
          cellMinZ = Math.min(cellMinZ, Math.max(cz - 10, b.min.z));
          cellMaxZ = Math.max(cellMaxZ, Math.min(cz + 10, b.max.z));
        }
      }
      return cellMaxX - cellMinX >= 14 && cellMaxZ - cellMinZ >= 14;
    };

    for (let ix = 0; ix < countX; ix += 1) {
      const cx =
        countX === 1
          ? alignStart(Math.round(((minX + maxX) * 0.5) * 10) / 10, "x")
          : startX + ix * 20;
      for (let iz = 0; iz < countZ; iz += 1) {
        const cz =
          countZ === 1
            ? alignStart(Math.round(((minZ + maxZ) * 0.5) * 10) / 10, "z")
            : startZ + iz * 20;
        const hasLow = hasLowMeshInCell(cx, cz);
        if (hasLow && hasBaseCellAt(cx, cz)) {
          gridCells.push(new THREE.Vector3(cx, supportY, cz));
        } else if (!hasLow) {
          const notchY = findNotchRoofYInCell(cx, cz);
          if (notchY != null) {
            recessedReceptors.push(new THREE.Vector3(cx, notchY, cz));
          }
        }
      }
    }

    // Escanea también celdas rebajadas fuera de baseBoxes (ej. mitad delantera y=8..16 en 11477, arcos y brackets)
    const hasAnyNotchTris = [...notchTrisByDy.values()].some((arr) => arr.length > 0);
    if (object3D && hasAnyNotchTris && localBox.max.y >= supportY + 11.5) {
      const anchorX =
        gridCells[0]?.x ??
        (countX === 1 ? alignStart(Math.round(((minX + maxX) * 0.5) * 10) / 10, "x") : startX);
      const anchorZ =
        gridCells[0]?.z ??
        (countZ === 1 ? alignStart(Math.round(((minZ + maxZ) * 0.5) * 10) / 10, "z") : startZ);
      const kxMin = Math.floor((localBox.min.x + 14 - anchorX) / 20);
      const kxMax = Math.ceil((localBox.max.x - 14 - anchorX) / 20);
      const kzMin = Math.floor((localBox.min.z + 14 - anchorZ) / 20);
      const kzMax = Math.ceil((localBox.max.z - 14 - anchorZ) / 20);
      for (let kx = kxMin; kx <= kxMax; kx += 1) {
        const cx = Math.round((anchorX + kx * 20) * 10) / 10;
        for (let kz = kzMin; kz <= kzMax; kz += 1) {
          const cz = Math.round((anchorZ + kz * 20) * 10) / 10;
          if (
            cx < localBox.min.x + 2 ||
            cx > localBox.max.x - 2 ||
            cz < localBox.min.z + 2 ||
            cz > localBox.max.z - 2
          ) {
            continue;
          }
          const already =
            gridCells.some((g) => Math.abs(g.x - cx) < 2 && Math.abs(g.z - cz) < 2) ||
            recessedReceptors.some((r) => Math.abs(r.x - cx) < 2 && Math.abs(r.z - cz) < 2);
          if (already) continue;
          if (!hasLowMeshInCell(cx, cz)) {
            const notchY = findNotchRoofYInCell(cx, cz);
            if (notchY != null) {
              recessedReceptors.push(new THREE.Vector3(cx, notchY, cz));
            }
          }
        }
      }
    }

    const dedupStuds = [];
    const seenKeys = new Set();
    for (const s of upStuds) {
      const sx = Math.round(s.pos.x * 10) / 10;
      const sz = Math.round(s.pos.z * 10) / 10;
      if (!hasBaseCellAt(sx, sz) || !hasLowMeshInCell(sx, sz)) continue;
      const key = `${sx}_${sz}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      dedupStuds.push(new THREE.Vector3(sx, supportY, sz));
    }

    if (dedupStuds.length > 0 && dedupStuds.length >= gridCells.length) {
      return { bottomReceptors: dedupStuds, recessedReceptors };
    }

    if (gridCells.length) {
      // Incluye también receptores centrales de studs únicos (ej. Dish 4740 o Jumper 18674 en (0,0))
      const merged = [...gridCells];
      for (const s of dedupStuds) {
        const exists = merged.some(
          (g) => Math.abs(g.x - s.x) < 2 && Math.abs(g.z - s.z) < 2
        );
        if (!exists) merged.push(s);
      }
      return { bottomReceptors: merged, recessedReceptors };
    }

    if (dedupStuds.length) {
      return { bottomReceptors: dedupStuds, recessedReceptors };
    }

    return {
      bottomReceptors: [
        new THREE.Vector3(
          (minX + maxX) * 0.5,
          supportY,
          (minZ + maxZ) * 0.5
        ),
      ],
      recessedReceptors,
    };
  }

  static makeGhostClone(group) {
    const source =
      group.children.length === 0 && group.userData?.visualTemplateGroup
        ? group.userData.visualTemplateGroup
        : group;
    const ghost = source.clone(true);
    ghost.visible = true;
    const matInfos = [];
    const lineInfos = [];
    ghost.traverse((child) => {
      if (child.isMesh) {
        child.visible = true;
        child.castShadow = false;
        child.receiveShadow = false;
        const mat = child.material.clone();
        mat.transparent = true;
        mat.opacity = 0.78;
        // depthWrite evita transparencia tipo rayos-X para distinguir caras y rotación con claridad
        mat.depthWrite = true;
        matInfos.push({
          mat,
          origColor: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
          origEmissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0x000000),
          origOpacity: 0.78,
        });
        child.material = mat;
      } else if (
        child.isLineSegments &&
        !child.isConditionalLine &&
        child.type !== "ConditionalLineSegments"
      ) {
        child.visible = true;
        if (child.material) {
          const lineMat = child.material.clone();
          lineMat.transparent = true;
          lineMat.opacity = 0.78;
          lineInfos.push({
            mat: lineMat,
            origColor: lineMat.color ? lineMat.color.clone() : new THREE.Color(0x111827),
            origOpacity: 0.78,
          });
          child.material = lineMat;
        }
      } else if (child.isLineSegments || child.isConditionalLine) {
        child.visible = false;
      }
    });
    ghost.userData.ghostMatInfos = matInfos;
    ghost.userData.ghostLineInfos = lineInfos;
    ghost.userData.isColliding = false;
    return ghost;
  }

  static setGhostColliding(ghost, isColliding) {
    if (!ghost || ghost.userData.isColliding === isColliding) return;
    ghost.userData.isColliding = isColliding;
    const infos = ghost.userData.ghostMatInfos || [];
    for (const info of infos) {
      if (isColliding) {
        info.mat.color?.setHex(0xef4444);
        info.mat.emissive?.setHex(0x7f1d1d);
        info.mat.opacity = 0.82;
      } else {
        info.mat.color?.copy(info.origColor);
        info.mat.emissive?.copy(info.origEmissive);
        info.mat.opacity = info.origOpacity;
      }
    }
    const lineInfos = ghost.userData.ghostLineInfos || [];
    for (const linfo of lineInfos) {
      if (isColliding) {
        linfo.mat.color?.setHex(0xfecaca);
        linfo.mat.opacity = 0.9;
      } else {
        linfo.mat.color?.copy(linfo.origColor);
        linfo.mat.opacity = linfo.origOpacity;
      }
    }
  }
}
