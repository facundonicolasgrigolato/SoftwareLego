import * as THREE from "three";

const MAT_TEX_WIDTH = 256; // 64 matrices 4x4 (4 texels RGBA cada una) por fila

function createEdgeShaderMaterial(matricesTex) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMatricesTex: { value: matricesTex },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D uMatricesTex;
      attribute vec3 aColor;
      attribute float aSlot;
      varying vec3 vColor;

      void main() {
        int baseTexel = int(aSlot + 0.5) * 4;
        int y = baseTexel / ${MAT_TEX_WIDTH};
        int x = baseTexel - y * ${MAT_TEX_WIDTH};
        vec4 c0 = texelFetch(uMatricesTex, ivec2(x, y), 0);
        vec4 c1 = texelFetch(uMatricesTex, ivec2(x + 1, y), 0);
        vec4 c2 = texelFetch(uMatricesTex, ivec2(x + 2, y), 0);
        vec4 c3 = texelFetch(uMatricesTex, ivec2(x + 3, y), 0);
        if (c3.w < 0.5) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        mat4 instMat = mat4(c0, c1, c2, c3);
        gl_Position = projectionMatrix * modelViewMatrix * instMat * vec4(position, 1.0);
        vColor = aColor;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        gl_FragColor = vec4(vColor, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: false,
    depthTest: true,
    depthWrite: true,
  });
}

/**
 * Capa de renderizado unificada (`THREE.BatchedMesh` + `LineSegments` con textura de matrices)
 * para dibujar cientos o miles de piezas LEGO opacas con un mínimo de draw calls en WebGL.
 */
export class BatchedPieceLayer {
  constructor({
    castShadow = false,
    receiveShadow = true,
    maxInstances = 2048,
    maxMeshVerts = 1200000,
    maxEdgeVerts = 800000,
  } = {}) {
    this.castShadow = castShadow;
    this.receiveShadow = receiveShadow;
    this.maxInstances = maxInstances;
    this.maxMeshVerts = maxMeshVerts;
    this.maxEdgeVerts = maxEdgeVerts;

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;

    this.meshMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.34,
      metalness: 0.06,
    });

    this._initBatches();
  }

  _initBatches() {
    this._geometryIds = new Map(); // protoKey -> geometryId
    this._records = new Map(); // proxyMesh -> { batchId, edgeSlot, visible }
    this._batchIdToProxy = new Map(); // batchId -> proxyMesh
    this._nextEdgeSlot = 0;
    this._edgeVertexCount = 0;

    this.meshBatch = new THREE.BatchedMesh(
      this.maxInstances,
      this.maxMeshVerts,
      0,
      this.meshMaterial
    );
    this.meshBatch.castShadow = this.castShadow;
    this.meshBatch.receiveShadow = this.receiveShadow;
    this.meshBatch.frustumCulled = false;
    this.meshBatch.perObjectFrustumCulled = true;
    this.meshBatch.matrixAutoUpdate = false;
    this.meshBatch.name = this.castShadow ? "PlacedBatchedMesh" : "PileBatchedMesh";

    const rows = Math.max(16, Math.ceil((this.maxInstances * 4) / MAT_TEX_WIDTH));
    this._edgeMatrices = new Float32Array(rows * MAT_TEX_WIDTH * 4);
    this._edgeTex = new THREE.DataTexture(
      this._edgeMatrices,
      MAT_TEX_WIDTH,
      rows,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this._edgeTex.minFilter = THREE.NearestFilter;
    this._edgeTex.magFilter = THREE.NearestFilter;
    this._edgeTex.needsUpdate = true;

    this._edgePos = new Float32Array(this.maxEdgeVerts * 3);
    this._edgeCol = new Float32Array(this.maxEdgeVerts * 3);
    this._edgeSlotAttr = new Float32Array(this.maxEdgeVerts);
    this._edgeGeo = new THREE.BufferGeometry();
    this._edgeGeo.setAttribute("position", new THREE.BufferAttribute(this._edgePos, 3));
    this._edgeGeo.setAttribute("aColor", new THREE.BufferAttribute(this._edgeCol, 3));
    this._edgeGeo.setAttribute("aSlot", new THREE.BufferAttribute(this._edgeSlotAttr, 1));
    this._edgeGeo.setDrawRange(0, 0);

    this._edgeMat = createEdgeShaderMaterial(this._edgeTex);
    this.edgeMesh = new THREE.LineSegments(this._edgeGeo, this._edgeMat);
    this.edgeMesh.frustumCulled = false;
    this.edgeMesh.matrixAutoUpdate = false;
    this.edgeMesh.renderOrder = 1;

    this.group.clear();
    this.group.add(this.meshBatch, this.edgeMesh);
  }

  _ensureMeshCapacity(neededVerts) {
    if (this.meshBatch.instanceCount >= this.maxInstances) {
      const nextMaxInst = this.maxInstances * 2;
      this.meshBatch.setInstanceCount(nextMaxInst);
      this.maxInstances = nextMaxInst;
      this._growEdgeMatrixTexture(nextMaxInst);
    }
    const usedVerts = this.meshBatch._nextVertexStart || 0;
    if (usedVerts + neededVerts > this.maxMeshVerts) {
      let nextVerts = this.maxMeshVerts * 2;
      while (usedVerts + neededVerts > nextVerts) nextVerts *= 2;
      this.meshBatch.setGeometrySize(nextVerts, 0);
      this.maxMeshVerts = nextVerts;
    }
  }

  _growEdgeMatrixTexture(nextMaxInst) {
    const neededRows = Math.max(16, Math.ceil((nextMaxInst * 4) / MAT_TEX_WIDTH));
    const currentRows = this._edgeTex.image.height;
    if (neededRows <= currentRows) return;

    const nextData = new Float32Array(neededRows * MAT_TEX_WIDTH * 4);
    nextData.set(this._edgeMatrices);
    this._edgeMatrices = nextData;
    this._edgeTex.dispose();
    this._edgeTex = new THREE.DataTexture(
      this._edgeMatrices,
      MAT_TEX_WIDTH,
      neededRows,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this._edgeTex.minFilter = THREE.NearestFilter;
    this._edgeTex.magFilter = THREE.NearestFilter;
    this._edgeTex.needsUpdate = true;
    this._edgeMat.uniforms.uMatricesTex.value = this._edgeTex;
  }

  _ensureEdgeVertexCapacity(neededVerts) {
    if (this._edgeVertexCount + neededVerts <= this.maxEdgeVerts) return;
    let nextCap = this.maxEdgeVerts * 2;
    while (this._edgeVertexCount + neededVerts > nextCap) nextCap *= 2;

    const nextPos = new Float32Array(nextCap * 3);
    const nextCol = new Float32Array(nextCap * 3);
    const nextSlot = new Float32Array(nextCap);
    nextPos.set(this._edgePos.subarray(0, this._edgeVertexCount * 3));
    nextCol.set(this._edgeCol.subarray(0, this._edgeVertexCount * 3));
    nextSlot.set(this._edgeSlotAttr.subarray(0, this._edgeVertexCount));

    this._edgePos = nextPos;
    this._edgeCol = nextCol;
    this._edgeSlotAttr = nextSlot;
    this.maxEdgeVerts = nextCap;

    this._edgeGeo.setAttribute("position", new THREE.BufferAttribute(this._edgePos, 3));
    this._edgeGeo.setAttribute("aColor", new THREE.BufferAttribute(this._edgeCol, 3));
    this._edgeGeo.setAttribute("aSlot", new THREE.BufferAttribute(this._edgeSlotAttr, 1));
  }

  hasPiece(proxyMesh) {
    return this._records.has(proxyMesh);
  }

  resolveProxyByBatchId(batchId) {
    return this._batchIdToProxy.get(batchId) || null;
  }

  addPiece(proxyMesh) {
    const ud = proxyMesh?.userData;
    if (!ud?.batchedMeshGeo || !ud?.protoKey) return false;

    proxyMesh.updateMatrix();
    proxyMesh.updateMatrixWorld(true);

    const existing = this._records.get(proxyMesh);
    if (existing) {
      this.setVisible(proxyMesh, true);
      this.setTransform(proxyMesh, proxyMesh.matrixWorld);
      return true;
    }

    let geoId = this._geometryIds.get(ud.protoKey);
    const vertCount = ud.batchedMeshGeo.attributes.position.count;
    this._ensureMeshCapacity(geoId === undefined ? vertCount : 0);

    if (geoId === undefined) {
      geoId = this.meshBatch.addGeometry(ud.batchedMeshGeo);
      this._geometryIds.set(ud.protoKey, geoId);
    }

    const batchId = this.meshBatch.addInstance(geoId);
    this.meshBatch.setMatrixAt(batchId, proxyMesh.matrixWorld);
    this.meshBatch.setVisibleAt(batchId, true);

    let edgeSlot = -1;
    if (ud.batchedEdgeGeo) {
      const ePos = ud.batchedEdgeGeo.attributes.position;
      const eCol = ud.batchedEdgeGeo.attributes.color;
      const eCount = ePos.count;
      if (eCount > 0) {
        if (this._nextEdgeSlot >= this.maxInstances) {
          const nextInst = this.maxInstances * 2;
          this.meshBatch.setInstanceCount(nextInst);
          this.maxInstances = nextInst;
          this._growEdgeMatrixTexture(nextInst);
        }
        this._ensureEdgeVertexCapacity(eCount);
        edgeSlot = this._nextEdgeSlot;
        this._nextEdgeSlot += 1;

        const vStart = this._edgeVertexCount;
        this._edgePos.set(ePos.array, vStart * 3);
        if (eCol) {
          this._edgeCol.set(eCol.array, vStart * 3);
        } else {
          for (let i = 0; i < eCount * 3; i += 3) {
            this._edgeCol[vStart * 3 + i] = 0.02;
            this._edgeCol[vStart * 3 + i + 1] = 0.03;
            this._edgeCol[vStart * 3 + i + 2] = 0.05;
          }
        }
        this._edgeSlotAttr.fill(edgeSlot, vStart, vStart + eCount);
        this._edgeVertexCount += eCount;

        this._edgeGeo.attributes.position.needsUpdate = true;
        this._edgeGeo.attributes.aColor.needsUpdate = true;
        this._edgeGeo.attributes.aSlot.needsUpdate = true;
        this._edgeGeo.setDrawRange(0, this._edgeVertexCount);

        this._writeEdgeMatrix(edgeSlot, proxyMesh.matrixWorld, true);
      }
    }

    this._records.set(proxyMesh, { batchId, edgeSlot, visible: true });
    this._batchIdToProxy.set(batchId, proxyMesh);
    return true;
  }

  _writeEdgeMatrix(edgeSlot, matrixWorld, visible) {
    if (edgeSlot < 0) return;
    const base = edgeSlot * 16;
    if (!visible) {
      this._edgeMatrices[base + 15] = 0;
    } else {
      const e = matrixWorld.elements;
      for (let i = 0; i < 16; i += 1) {
        this._edgeMatrices[base + i] = e[i];
      }
      this._edgeMatrices[base + 15] = 1;
    }
    this._edgeTex.needsUpdate = true;
  }

  setTransform(proxyMesh, matrixWorld) {
    const rec = this._records.get(proxyMesh);
    if (!rec) return;
    this.meshBatch.setMatrixAt(rec.batchId, matrixWorld);
    if (rec.edgeSlot >= 0) {
      this._writeEdgeMatrix(rec.edgeSlot, matrixWorld, rec.visible);
    }
  }

  setVisible(proxyMesh, visible) {
    const rec = this._records.get(proxyMesh);
    if (!rec) return;
    rec.visible = Boolean(visible);
    this.meshBatch.setVisibleAt(rec.batchId, rec.visible);
    if (rec.edgeSlot >= 0) {
      this._writeEdgeMatrix(rec.edgeSlot, proxyMesh.matrixWorld, rec.visible);
    }
  }

  removePiece(proxyMesh) {
    // Ocultamos el slot manteniendo su geometría registrada para que undo/recolocar sea O(1)
    this.setVisible(proxyMesh, false);
  }

  clear() {
    this.meshBatch.dispose();
    this._edgeGeo.dispose();
    this._edgeTex.dispose();
    this._edgeMat.dispose();
    this._initBatches();
  }

  dispose() {
    this.meshBatch.dispose();
    this.meshMaterial.dispose();
    this._edgeGeo.dispose();
    this._edgeTex.dispose();
    this._edgeMat.dispose();
  }
}
