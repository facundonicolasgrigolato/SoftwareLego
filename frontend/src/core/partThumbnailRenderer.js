import * as THREE from "three";
import { LDrawService } from "./ldrawService.js";

/**
 * Renderiza miniaturas 3D isométricas reales de cada pieza LDraw en un único
 * WebGLRenderer offscreen compartido, con caché por combinación pieza+color.
 */
export class PartThumbnailRenderer {
  constructor(ldrawService, width = 128, height = 96) {
    this.ldrawService = ldrawService;
    this.width = width;
    this.height = height;
    this._cache = new Map();
    this._pending = new Map();
    this._queue = [];
    this._draining = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, width / height, 0.5, 5000);

    const hemi = new THREE.HemisphereLight(0xf8fafc, 0x64748b, 1.55);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.85);
    key.position.set(180, 260, 200);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xe2e8f0, 0.75);
    fill.position.set(-160, 90, -140);
    this.scene.add(fill);

    this._renderer = null;
  }

  _ensureRenderer() {
    if (!this._renderer) {
      this._renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
      });
      this._renderer.setPixelRatio(1);
      this._renderer.setSize(this.width, this.height, false);
      this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    return this._renderer;
  }

  getCached(part) {
    return this._cache.get(LDrawService.cacheKey(part)) || null;
  }

  requestThumbnail(part) {
    const key = LDrawService.cacheKey(part);
    if (this._cache.has(key)) {
      return Promise.resolve(this._cache.get(key));
    }
    if (this._pending.has(key)) {
      return this._pending.get(key);
    }

    const promise = new Promise((resolve) => {
      this._queue.push({ key, part, resolve });
      this._scheduleDrain();
    });
    this._pending.set(key, promise);
    return promise;
  }

  _scheduleDrain() {
    if (this._draining) return;
    this._draining = true;
    requestAnimationFrame(() => this._drainNext());
  }

  async _drainNext() {
    const job = this._queue.shift();
    if (!job) {
      this._draining = false;
      return;
    }

    const { key, part, resolve } = job;
    try {
      const { group } = await this.ldrawService.createPartInstance(part, {
        lightweight: true,
      });
      const box = new THREE.Box3().setFromObject(group);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      group.position.sub(center);
      this.scene.add(group);

      const maxDim = Math.max(size.x, size.y, size.z, 18);
      const fovRad = (this.camera.fov * Math.PI) / 180;
      const dist = (maxDim / (2 * Math.tan(fovRad / 2))) * 1.65;
      const dir = new THREE.Vector3(1.0, 0.82, 1.08).normalize();

      this.camera.position.copy(dir.multiplyScalar(dist));
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();

      const renderer = this._ensureRenderer();
      renderer.render(this.scene, this.camera);
      const dataUrl = renderer.domElement.toDataURL("image/png");

      this.scene.remove(group);
      this._cache.set(key, dataUrl);
      this._pending.delete(key);
      resolve(dataUrl);
    } catch {
      this._pending.delete(key);
      resolve(null);
    }

    if (this._queue.length > 0) {
      requestAnimationFrame(() => this._drainNext());
    } else {
      this._draining = false;
    }
  }

  dispose() {
    this._queue = [];
    this._pending.clear();
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
  }
}
