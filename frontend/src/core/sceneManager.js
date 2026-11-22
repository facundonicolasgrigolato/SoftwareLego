import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  CAMERA_WASD_SPEED,
  LDU_STUD,
} from "./constants.js";
import { computeTableLayout } from "./tableLayout.js";
import { BatchedPieceLayer } from "./batchedPieceLayer.js";

/**
 * Administra el renderer WebGL, cámara orbital + WASD, mesa de madera dinámica
 * (cajas por Bolsa a la izquierda y Mesa de Juego escalable a la derecha) y ambiente cálido.
 */
export class SceneManager {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 12, 16000);
    this.camera.position.set(110, 420, 560);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(-20, 10, 0);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.minDistance = 80;
    this.controls.maxDistance = 3600;
    this.isCameraInteracting = false;
    this.controls.addEventListener("start", () => {
      this.isCameraInteracting = true;
    });
    this.controls.addEventListener("end", () => {
      this.isCameraInteracting = false;
    });

    this.placedGroup = new THREE.Group();
    this.placedGroup.name = "PlacedPieces";
    this.scene.add(this.placedGroup);

    this.pileGroup = new THREE.Group();
    this.pileGroup.name = "PilePieces";
    this.scene.add(this.pileGroup);

    this.placedBatch = new BatchedPieceLayer({
      castShadow: true,
      receiveShadow: true,
      maxInstances: 2048,
      maxMeshVerts: 1200000,
      maxEdgeVerts: 800000,
    });
    this.scene.add(this.placedBatch.group);

    this.pileBatch = new BatchedPieceLayer({
      castShadow: false,
      receiveShadow: true,
      maxInstances: 2560,
      maxMeshVerts: 1200000,
      maxEdgeVerts: 800000,
    });
    this.scene.add(this.pileBatch.group);

    this.tableGroup = new THREE.Group();
    this.tableGroup.name = "TableEnvironment";
    this.scene.add(this.tableGroup);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._moveKeys = new Set();
    this._onFrameCallbacks = [];
    this._lastTime = performance.now();
    this._disposableTextures = [];

    this._setupEnvironment();
    this._setupLights();
    this.layout = computeTableLayout(null);
    this.applyTableLayout(this.layout);
    this._selectionHelper = null;

    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);

    this._animFrame = null;
    this._animate();
  }

  onFrame(fn) {
    this._onFrameCallbacks.push(fn);
  }

  setMoveKey(key, active) {
    const k = key.toLowerCase();
    if (!["w", "a", "s", "d"].includes(k)) return;
    if (active) this._moveKeys.add(k);
    else this._moveKeys.delete(k);
  }

  clearMoveKeys() {
    this._moveKeys.clear();
  }

  _updateWASD(dt) {
    if (!this._moveKeys.size) return;

    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const move = new THREE.Vector3();

    if (this._moveKeys.has("w")) move.add(forward);
    if (this._moveKeys.has("s")) move.sub(forward);
    if (this._moveKeys.has("d")) move.add(right);
    if (this._moveKeys.has("a")) move.sub(right);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(CAMERA_WASD_SPEED * dt);
      this.camera.position.add(move);
      this.controls.target.add(move);
    }
  }

  _setupEnvironment() {
    // Fallback inmediato (cielo celeste -> pradera verde) mientras carga el panorama 360°
    const fallbackCanvas = document.createElement("canvas");
    fallbackCanvas.width = 512;
    fallbackCanvas.height = 256;
    const fctx = fallbackCanvas.getContext("2d");
    const grad = fctx.createLinearGradient(0, 0, 0, fallbackCanvas.height);
    grad.addColorStop(0.0, "#3898ec");
    grad.addColorStop(0.46, "#b7e1fa");
    grad.addColorStop(0.51, "#7cb342");
    grad.addColorStop(1.0, "#4f7a28");
    fctx.fillStyle = grad;
    fctx.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);

    const fallbackTex = new THREE.CanvasTexture(fallbackCanvas);
    fallbackTex.mapping = THREE.EquirectangularReflectionMapping;
    fallbackTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = fallbackTex;
    this.scene.fog = null;
    this._envTexture = fallbackTex;

    const img = new Image();
    img.onload = () => {
      const w = 2048;
      const h = 1024;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");

      // Lienzo auxiliar espejado 360° con cielo extendido arriba para mostrar árboles y nubes al construir
      const tile = document.createElement("canvas");
      tile.width = w;
      tile.height = h;
      const tctx = tile.getContext("2d");
      const offsetY = 145;
      tctx.drawImage(img, 0, offsetY, w / 2, h - offsetY);
      // Rellenamos banda superior reflejando suavemente la parte alta del cielo
      tctx.save();
      tctx.translate(0, offsetY);
      tctx.scale(1, -1);
      tctx.drawImage(img, 0, 0, img.width, img.height * 0.28, 0, 0, w / 2, offsetY);
      tctx.restore();

      tctx.save();
      tctx.translate(w, 0);
      tctx.scale(-1, 1);
      tctx.drawImage(tile, 0, 0, w / 2, h, 0, 0, w / 2, h);
      tctx.restore();

      ctx.save();
      ctx.filter = "blur(7.5px)";
      // Dibujamos con sangrado lateral para que el blur mantenga continuidad exacta en 360°
      ctx.drawImage(tile, -w, 0, w, h);
      ctx.drawImage(tile, 0, 0, w, h);
      ctx.drawImage(tile, w, 0, w, h);
      ctx.restore();

      const panoTex = new THREE.CanvasTexture(canvas);
      panoTex.mapping = THREE.EquirectangularReflectionMapping;
      panoTex.colorSpace = THREE.SRGBColorSpace;
      panoTex.needsUpdate = true;
      this.scene.background = panoTex;
      if (this._envTexture && this._envTexture !== panoTex) {
        this._envTexture.dispose();
      }
      this._envTexture = panoTex;
    };
    img.src = "/meadow_360.jpg";
  }

  _createLightWoodTexture(repeatX = 4, repeatZ = 3) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    // Roble claro cálido dividido en tablones horizontales naturales
    const plankCount = 4;
    const plankH = 512 / plankCount;
    const plankTones = ["#ddb481", "#d4a66f", "#e3bd8d", "#d8ac76"];

    for (let p = 0; p < plankCount; p += 1) {
      const y0 = p * plankH;
      ctx.fillStyle = plankTones[p % plankTones.length];
      ctx.fillRect(0, y0, 512, plankH);

      // Vetas orgánicas de roble por tablón
      for (let ly = 0; ly < plankH; ly += 2) {
        const y = y0 + ly;
        const wave = Math.sin((y + p * 37) * 0.085) * 0.5 + Math.cos((y - p * 19) * 0.028) * 0.5;
        const alpha = 0.045 + Math.abs(wave) * 0.085;
        ctx.fillStyle =
          wave > 0 ? `rgba(146, 94, 44, ${alpha})` : `rgba(246, 222, 184, ${alpha * 0.9})`;
        ctx.fillRect(0, y, 512, 2);
      }

      // Poro fino y nudos sutiles del roble
      for (let i = 0; i < 24; i += 1) {
        const x = ((i * 89 + p * 131) % 512);
        const y = y0 + 6 + ((i * 37) % Math.max(8, plankH - 12));
        const w = 70 + ((i * 53) % 190);
        ctx.fillStyle = i % 2 === 0 ? "rgba(132, 82, 36, 0.09)" : "rgba(248, 226, 190, 0.07)";
        ctx.fillRect(x - w / 2, y, w, 1.5);
      }

      // Junta sutil entre tablones de roble
      ctx.fillStyle = "rgba(116, 70, 32, 0.28)";
      ctx.fillRect(0, y0, 512, 2);
      ctx.fillStyle = "rgba(252, 232, 198, 0.22)";
      ctx.fillRect(0, y0 + 2, 512, 1);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(Math.max(1, repeatX), Math.max(1, repeatZ));
    tex.colorSpace = THREE.SRGBColorSpace;
    this._disposableTextures.push(tex);
    return tex;
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xfff7e6, 0x7d5d38, 1.04);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff1d6, 2.25);
    dir.position.set(560, 620, 440);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 100;
    dir.shadow.camera.far = 3600;
    dir.shadow.camera.left = -1200;
    dir.shadow.camera.right = 1200;
    dir.shadow.camera.top = 900;
    dir.shadow.camera.bottom = -900;
    dir.shadow.bias = -0.0005;
    dir.shadow.normalBias = 0.4;
    this.scene.add(dir);
    this._mainLight = dir;

    const rim = new THREE.DirectionalLight(0xe0f2fe, 0.58);
    rim.position.set(-550, 340, -380);
    this.scene.add(rim);
  }

  _disposeTableResources() {
    for (const tex of this._disposableTextures) {
      tex.dispose();
    }
    this._disposableTextures = [];

    this.tableGroup.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
    this.tableGroup.clear();
  }

  applyTableLayout(layout) {
    this.layout = layout;
    this._disposeTableResources();

    const { tableBounds, buildZone, bagZones } = layout;

    // 1. Tablero real de madera café claro (superficie raycastable en y = 0 + espesor 3D)
    const woodTex = this._createLightWoodTexture(
      Math.round(tableBounds.width / 420),
      Math.round(tableBounds.depth / 420)
    );
    const topGeo = new THREE.PlaneGeometry(tableBounds.width, tableBounds.depth);
    topGeo.rotateX(-Math.PI / 2);
    const topMat = new THREE.MeshStandardMaterial({
      map: woodTex,
      roughness: 0.66,
      metalness: 0.04,
    });
    this.tableMesh = new THREE.Mesh(topGeo, topMat);
    this.tableMesh.position.set(tableBounds.centerX, 0, tableBounds.centerZ);
    this.tableMesh.receiveShadow = true;
    this.tableMesh.name = "VirtualTable";
    this.tableGroup.add(this.tableMesh);

    const slabGeo = new THREE.BoxGeometry(tableBounds.width, 30, tableBounds.depth);
    const slabMat = new THREE.MeshStandardMaterial({
      color: 0x9c6a3b,
      roughness: 0.78,
      metalness: 0.04,
    });
    const slabMesh = new THREE.Mesh(slabGeo, slabMat);
    slabMesh.position.set(tableBounds.centerX, -16.6, tableBounds.centerZ);
    slabMesh.receiveShadow = true;
    this.tableGroup.add(slabMesh);

    // 2. Zona de Armado rectangular estilo baseplate viva con studs LEGO 3D (20 LDU)
    const buildMatGeo = new THREE.PlaneGeometry(buildZone.width, buildZone.depth);
    buildMatGeo.rotateX(-Math.PI / 2);
    const buildMatMesh = new THREE.Mesh(
      buildMatGeo,
      new THREE.MeshStandardMaterial({
        color: 0xe0c191,
        roughness: 0.46,
        metalness: 0.03,
      })
    );
    buildMatMesh.position.set(buildZone.centerX, 0.25, buildZone.centerZ);
    buildMatMesh.receiveShadow = true;
    this.tableGroup.add(buildMatMesh);

    // Puntos de encastre circulares con relieve y sombra real
    const studCols = Math.round(buildZone.width / LDU_STUD);
    const studRows = Math.round(buildZone.depth / LDU_STUD);
    const studCount = studCols * studRows;
    const studGeo = new THREE.CylinderGeometry(5.8, 6.2, 2.3, 10);
    const studMat = new THREE.MeshStandardMaterial({
      color: 0xedd5ac,
      roughness: 0.36,
      metalness: 0.04,
    });
    const studMesh = new THREE.InstancedMesh(studGeo, studMat, studCount);
    studMesh.receiveShadow = true;
    studMesh.castShadow = false;
    studMesh.matrixAutoUpdate = false;
    const dummy = new THREE.Object3D();
    let studIdx = 0;
    for (let cx = 0; cx < studCols; cx += 1) {
      const sx = buildZone.minX + cx * LDU_STUD + LDU_STUD * 0.5;
      for (let cz = 0; cz < studRows; cz += 1) {
        const sz = buildZone.minZ + cz * LDU_STUD + LDU_STUD * 0.5;
        dummy.position.set(sx, 1.4, sz);
        dummy.updateMatrix();
        studMesh.setMatrixAt(studIdx, dummy.matrix);
        studIdx += 1;
      }
    }
    studMesh.instanceMatrix.needsUpdate = true;
    studMesh.updateMatrix();
    this.tableGroup.add(studMesh);

    // Grilla sutil complementaria (20 LDU)
    const gridPts = [];
    for (let x = buildZone.minX; x <= buildZone.maxX + 0.01; x += LDU_STUD) {
      gridPts.push(x, 0.34, buildZone.minZ, x, 0.34, buildZone.maxZ);
    }
    for (let z = buildZone.minZ; z <= buildZone.maxZ + 0.01; z += LDU_STUD) {
      gridPts.push(buildZone.minX, 0.34, z, buildZone.maxX, 0.34, z);
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(gridPts, 3));
    const gridLines = new THREE.LineSegments(
      gridGeo,
      new THREE.LineBasicMaterial({ color: 0xa47c50, transparent: true, opacity: 0.2 })
    );
    this.tableGroup.add(gridLines);

    // Borde sutil de la Mesa de Juego + cartel
    const borderMat = new THREE.MeshStandardMaterial({ color: 0x8a5e36, roughness: 0.72 });
    const bt = 6;
    const bh = 3;
    const bEdges = [
      [buildZone.minX - bt / 2, bh / 2, buildZone.centerZ, bt, bh, buildZone.depth + bt * 2],
      [buildZone.maxX + bt / 2, bh / 2, buildZone.centerZ, bt, bh, buildZone.depth + bt * 2],
      [buildZone.centerX, bh / 2, buildZone.minZ - bt / 2, buildZone.width, bh, bt],
      [buildZone.centerX, bh / 2, buildZone.maxZ + bt / 2, buildZone.width, bh, bt],
    ];
    for (const [x, y, z, w, h, d] of bEdges) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), borderMat);
      m.position.set(x, y, z);
      m.receiveShadow = true;
      this.tableGroup.add(m);
    }

    // 3. Cajas / Bandejas físicas por cada Bolsa
    const padMat = new THREE.MeshStandardMaterial({ color: 0xc29b6c, roughness: 0.92 });
    const railMat = new THREE.MeshStandardMaterial({ color: 0x7c532e, roughness: 0.72 });
    const railH = 12;
    const railT = 7;

    for (const bz of bagZones) {
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(bz.width, bz.depth), padMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(bz.centerX, 0.26, bz.centerZ);
      pad.receiveShadow = true;
      this.tableGroup.add(pad);

      const rails = [
        [bz.minX - railT / 2, railH / 2, bz.centerZ, railT, railH, bz.depth + railT * 2],
        [bz.maxX + railT / 2, railH / 2, bz.centerZ, railT, railH, bz.depth + railT * 2],
        [bz.centerX, railH / 2, bz.minZ - railT / 2, bz.width, railH, railT],
        [bz.centerX, railH / 2, bz.maxZ + railT / 2, bz.width, railH, railT],
      ];
      for (const [x, y, z, w, h, d] of rails) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), railMat);
        rail.position.set(x, y, z);
        rail.receiveShadow = true;
        rail.castShadow = true;
        this.tableGroup.add(rail);
      }
    }

    // 4. Ajustar rango de sombras y zoom máximo al tamaño real de la mesa
    if (this._mainLight) {
      const halfSpan = Math.max(tableBounds.width, tableBounds.depth) * 0.62;
      this._mainLight.position.set(tableBounds.centerX + 560, Math.max(620, halfSpan * 0.65), tableBounds.centerZ + 440);
      this._mainLight.target.position.set(tableBounds.centerX, 0, tableBounds.centerZ);
      this._mainLight.target.updateMatrixWorld();
      this._mainLight.shadow.camera.left = -halfSpan;
      this._mainLight.shadow.camera.right = halfSpan;
      this._mainLight.shadow.camera.top = halfSpan;
      this._mainLight.shadow.camera.bottom = -halfSpan;
      this._mainLight.shadow.camera.updateProjectionMatrix();
    }
    this.controls.maxDistance = Math.max(2600, Math.max(tableBounds.width, tableBounds.depth) * 1.45);
    this.tableGroup.traverse((obj) => {
      if (obj !== this.tableGroup) {
        obj.updateMatrix();
        obj.matrixAutoUpdate = false;
      }
    });
    this.tableGroup.updateMatrixWorld(true);
    this.invalidateShadows();
  }

  invalidateShadows() {
    this.renderer.shadowMap.needsUpdate = true;
  }

  addPlacedMesh(mesh) {
    if (!mesh) return;
    const hasStickers = mesh.children.some((c) => c.userData?.isSticker);
    if (mesh.userData?.batchedMeshGeo && !hasStickers) {
      this.placedGroup.remove(mesh);
      this.placedBatch.addPiece(mesh);
    } else {
      mesh.userData?.ensureVisualChildren?.();
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
      this.placedGroup.add(mesh);
    }
    this.invalidateShadows();
  }

  removePlacedMesh(mesh) {
    if (!mesh) return;
    this.placedBatch.removePiece(mesh);
    this.placedGroup.remove(mesh);
    this.invalidateShadows();
  }

  syncPlacedTransform(mesh) {
    if (!mesh) return;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    this.placedBatch.setTransform(mesh, mesh.matrixWorld);
    this.invalidateShadows();
  }

  setPlacedVisible(mesh, visible) {
    if (!mesh) return;
    mesh.visible = Boolean(visible);
    this.placedBatch.setVisible(mesh, Boolean(visible));
    this.invalidateShadows();
  }

  promotePlacedMeshToIndividual(mesh) {
    if (!mesh) return;
    this.placedBatch.removePiece(mesh);
    mesh.userData?.ensureVisualChildren?.();
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    if (!this.placedGroup.children.includes(mesh)) {
      this.placedGroup.add(mesh);
    }
    this.invalidateShadows();
  }

  addPileMesh(mesh) {
    if (!mesh) return;
    if (mesh.userData?.batchedMeshGeo) {
      this.pileGroup.remove(mesh);
      this.pileBatch.addPiece(mesh);
    } else {
      mesh.updateMatrix();
      mesh.updateMatrixWorld(true);
      this.pileGroup.add(mesh);
    }
  }

  removePileMesh(mesh) {
    if (!mesh) return;
    this.pileBatch.removePiece(mesh);
    this.pileGroup.remove(mesh);
  }

  syncPileTransform(mesh) {
    if (!mesh) return;
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
    this.pileBatch.setTransform(mesh, mesh.matrixWorld);
  }

  clearPieces() {
    this.placedGroup.clear();
    this.pileGroup.clear();
    this.placedBatch.clear();
    this.pileBatch.clear();
    this.invalidateShadows();
  }

  setSelectionBox(target) {
    if (this._selectionHelpers) {
      for (const h of this._selectionHelpers) {
        this.scene.remove(h);
        h.dispose();
      }
    }
    this._selectionHelpers = [];
    const list = Array.isArray(target) ? target : target ? [target] : [];
    for (const obj of list) {
      const hasChildMesh = obj.children && obj.children.length > 0;
      const helper =
        !hasChildMesh && obj.userData?.worldBox
          ? new THREE.Box3Helper(obj.userData.worldBox, 0x38bdf8)
          : new THREE.BoxHelper(obj, 0x38bdf8);
      helper.userData.targetObj = obj;
      this.scene.add(helper);
      this._selectionHelpers.push(helper);
    }
  }

  refreshSelectionBox() {
    if (!this._selectionHelpers) return;
    for (const h of this._selectionHelpers) {
      const obj = h.userData?.targetObj;
      if (h.isBox3Helper && obj?.userData?.worldBox) {
        h.box.copy(obj.userData.worldBox);
      }
      if (typeof h.update === "function") h.update();
    }
  }

  /**
   * Devuelve los dos ejes cardinales horizontales (`right` y `forward`) más alineados
   * con la dirección actual de la cámara, para mover piezas según lo que ve el usuario.
   */
  getHorizontalCameraAxes() {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) {
      const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      camRight.y = 0;
      if (camRight.lengthSq() >= 1e-4) {
        camRight.normalize();
        fwd.crossVectors(new THREE.Vector3(0, 1, 0), camRight);
      } else {
        fwd.set(0, 0, -1);
      }
    }
    fwd.normalize();

    const forward =
      Math.abs(fwd.x) >= Math.abs(fwd.z)
        ? new THREE.Vector3(Math.sign(fwd.x) || 1, 0, 0)
        : new THREE.Vector3(0, 0, Math.sign(fwd.z) || -1);
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    return { right, forward };
  }

  focusBuildZone() {
    const bz = this.layout.buildZone;
    const dist = Math.max(420, Math.max(bz.width, bz.depth) * 0.55);
    this.camera.position.set(bz.centerX + 80, dist * 0.75, dist);
    this.controls.target.set(bz.centerX, 15, bz.centerZ);
    this.controls.update();
  }

  focusBagZone(bagNumber = 1) {
    const bz =
      this.layout.bagZones.find((b) => b.bagNumber === bagNumber) ||
      this.layout.bagZones[0];
    if (!bz) return;
    this.camera.position.set(bz.centerX, 340, bz.centerZ + 340);
    this.controls.target.set(bz.centerX, 15, bz.centerZ);
    this.controls.update();
  }

  focusPileZone() {
    this.focusBagZone(1);
  }

  resetCamera() {
    const bz = this.layout.buildZone;
    const firstBag = this.layout.bagZones[0];
    const targetX = firstBag ? (firstBag.centerX * 0.35 + bz.centerX * 0.65) : bz.centerX - 60;
    const span = Math.max(bz.width, bz.depth);
    const camY = Math.max(335, span * 0.38);
    const camZ = Math.max(660, span * 0.74);
    this.camera.position.set(targetX + 40, camY, camZ);
    this.controls.target.set(targetX, -42, 0);
    this.controls.update();
  }

  raycastWorkspace(clientX, clientY, { ignoreObject = null, includePile = true } = {}) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const isIgnored = (obj) =>
      ignoreObject instanceof Set ? ignoreObject.has(obj) : obj === ignoreObject;

    const ray = this.raycaster.ray;
    const targets = [];
    if (this.placedBatch.meshBatch.instanceCount > 0) {
      targets.push(this.placedBatch.meshBatch);
    }
    for (const child of this.placedGroup.children) {
      if (isIgnored(child)) continue;
      if (child.userData?.worldBox && !ray.intersectsBox(child.userData.worldBox)) continue;
      targets.push(child);
    }
    if (includePile) {
      if (this.pileBatch.meshBatch.instanceCount > 0) {
        targets.push(this.pileBatch.meshBatch);
      }
      for (const child of this.pileGroup.children) {
        if (isIgnored(child)) continue;
        targets.push(child);
      }
    }
    if (this.tableMesh) targets.push(this.tableMesh);

    const hits = this.raycaster.intersectObjects(targets, true);
    for (const hit of hits) {
      if (hit.object.isLineSegments) continue;

      if (hit.object === this.placedBatch.meshBatch) {
        const root = this.placedBatch.resolveProxyByBatchId(hit.batchId);
        if (!root || isIgnored(root)) continue;
        const normal = hit.face
          ? hit.face.normal.clone().transformDirection(root.matrixWorld).normalize()
          : new THREE.Vector3(0, 1, 0);
        return { kind: "placed", point: hit.point, normal, object: root, stickerFaceKey: null };
      }

      if (hit.object === this.pileBatch.meshBatch) {
        const root = this.pileBatch.resolveProxyByBatchId(hit.batchId);
        if (!root || isIgnored(root)) continue;
        const normal = hit.face
          ? hit.face.normal.clone().transformDirection(root.matrixWorld).normalize()
          : new THREE.Vector3(0, 1, 0);
        return { kind: "pile", point: hit.point, normal, object: root };
      }

      let root = hit.object;
      while (
        root &&
        root.parent !== this.placedGroup &&
        root.parent !== this.pileGroup &&
        root !== this.tableMesh
      ) {
        root = root.parent;
      }

      const normal = hit.face
        ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);

      if (root === this.tableMesh) {
        return { kind: "table", point: hit.point, normal: new THREE.Vector3(0, 1, 0), object: null };
      }
      if (root?.parent === this.pileGroup) {
        return { kind: "pile", point: hit.point, normal, object: root };
      }
      if (root?.parent === this.placedGroup) {
        return {
          kind: "placed",
          point: hit.point,
          normal,
          object: root,
          stickerFaceKey: hit.object.userData?.isSticker
            ? hit.object.userData.stickerFaceKey || null
            : null,
        };
      }
    }
    return null;
  }

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  _animate() {
    this._animFrame = requestAnimationFrame(() => this._animate());
    const now = performance.now();
    const dt = (now - this._lastTime) / 1000;
    this._lastTime = now;

    this._updateWASD(dt);
    for (const fn of this._onFrameCallbacks) {
      fn(dt);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    window.removeEventListener("resize", this._onResize);
    this._disposeTableResources();
    this.placedBatch.dispose();
    this.pileBatch.dispose();
    if (this._envTexture) this._envTexture.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
