import * as CANNON from "cannon-es";
import * as THREE from "three";
import { PILE_ZONE } from "../core/constants.js";

/**
 * Simulación física 3D (`cannon-es`) para las piezas sueltas en sus cajas por Bolsa.
 * Cada bolsa tiene sus propias paredes de contención y las piezas entran en `sleep`
 * automático cuando quedan quietas para mantener 60 FPS incluso con 1500+ piezas.
 */
export class PilePhysics {
  constructor() {
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -1100, 0),
    });
    this.world.allowSleep = true;
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.defaultContactMaterial.friction = 0.52;
    this.world.defaultContactMaterial.restitution = 0.06;

    this.items = []; // { instanceId, elementId, bagNumber, mesh, body, localBox }
    this.bagZones = [{ bagNumber: 1, ...PILE_ZONE }];
    this._wallBodies = [];
    this.passiveMode = false;
    this._setupFloor();
    this.setBagZones(this.bagZones);
  }

  _setupFloor() {
    const floorBody = new CANNON.Body({
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane(),
    });
    floorBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(floorBody);
  }

  setBagZones(bagZones) {
    for (const wall of this._wallBodies) {
      this.world.removeBody(wall);
    }
    this._wallBodies = [];
    this.bagZones =
      Array.isArray(bagZones) && bagZones.length > 0
        ? bagZones
        : [{ bagNumber: 1, ...PILE_ZONE }];

    const wallHeight = 280;
    const wallThick = 60;

    for (const bz of this.bagZones) {
      const width = bz.maxX - bz.minX;
      const depth = bz.maxZ - bz.minZ;
      const cx = (bz.minX + bz.maxX) / 2;
      const cz = (bz.minZ + bz.maxZ) / 2;

      const walls = [
        [bz.minX - wallThick / 2, wallHeight / 2, cz, wallThick / 2, wallHeight / 2, depth / 2 + wallThick],
        [bz.maxX + wallThick / 2, wallHeight / 2, cz, wallThick / 2, wallHeight / 2, depth / 2 + wallThick],
        [cx, wallHeight / 2, bz.minZ - wallThick / 2, width / 2 + wallThick, wallHeight / 2, wallThick / 2],
        [cx, wallHeight / 2, bz.maxZ + wallThick / 2, width / 2 + wallThick, wallHeight / 2, wallThick / 2],
      ];

      for (const [x, y, z, hx, hy, hz] of walls) {
        const wall = new CANNON.Body({
          type: CANNON.Body.STATIC,
          position: new CANNON.Vec3(x, y, z),
          shape: new CANNON.Box(new CANNON.Vec3(hx, hy, hz)),
        });
        this.world.addBody(wall);
        this._wallBodies.push(wall);
      }
    }
  }

  getBagZone(bagNumber = 1) {
    return (
      this.bagZones.find((b) => b.bagNumber === bagNumber) ||
      this.bagZones[0] ||
      PILE_ZONE
    );
  }

  isPointInAnyBag(x, z, margin = 20) {
    for (const bz of this.bagZones) {
      if (
        x >= bz.minX - margin &&
        x <= bz.maxX + margin &&
        z >= bz.minZ - margin &&
        z <= bz.maxZ + margin
      ) {
        return true;
      }
    }
    return false;
  }

  addPiece(
    instanceId,
    elementId,
    mesh,
    localBox,
    dropPosition = null,
    randomTilt = true,
    bagNumber = 1
  ) {
    const size = localBox.getSize(new THREE.Vector3());
    const center = localBox.getCenter(new THREE.Vector3());

    const hx = Math.max(3, size.x / 2);
    const hy = Math.max(2.5, size.y / 2);
    const hz = Math.max(3, size.z / 2);

    const bz = this.getBagZone(bagNumber);
    const padX = Math.min(48, (bz.maxX - bz.minX) * 0.16);
    const padZ = Math.min(48, (bz.maxZ - bz.minZ) * 0.16);
    const spawnX =
      dropPosition?.x ??
      bz.minX + padX + Math.random() * Math.max(10, bz.maxX - bz.minX - padX * 2);
    const spawnZ =
      dropPosition?.z ??
      bz.minZ + padZ + Math.random() * Math.max(10, bz.maxZ - bz.minZ - padZ * 2);
    const spawnY = dropPosition?.y ?? 26 + Math.random() * 48;

    const body = new CANNON.Body({
      mass: Math.max(0.4, Math.min(4, (hx * hy * hz) / 1000)),
      position: new CANNON.Vec3(spawnX, spawnY, spawnZ),
      linearDamping: 0.32,
      angularDamping: 0.42,
      sleepSpeedLimit: 12,
      sleepTimeLimit: 0.45,
    });
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(hx, hy, hz)),
      new CANNON.Vec3(center.x, center.y, center.z)
    );

    if (randomTilt) {
      body.quaternion.setFromEuler(
        (Math.random() - 0.5) * 0.45,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 0.45
      );
    } else {
      body.quaternion.set(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
    }

    this.world.addBody(body);
    mesh.position.set(body.position.x, body.position.y, body.position.z);
    mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);

    const entry = { instanceId, elementId, bagNumber, mesh, body, localBox };
    this.items.push(entry);
    return entry;
  }

  removePiece(instanceId) {
    const idx = this.items.findIndex((item) => item.instanceId === instanceId);
    if (idx === -1) return null;
    const [removed] = this.items.splice(idx, 1);
    this.world.removeBody(removed.body);
    return removed;
  }

  findByMesh(mesh) {
    return this.items.find((item) => item.mesh === mesh) || null;
  }

  wakeNearby(point, radius = 90) {
    for (const item of this.items) {
      const dx = item.body.position.x - point.x;
      const dz = item.body.position.z - point.z;
      if (dx * dx + dz * dz <= radius * radius) {
        item.body.wakeUp();
      }
    }
  }

  /**
   * Mueve temporalmente una pieza dentro de la pila aplicando velocidad hacia el cursor
   * para empujar de forma realista las piezas que están alrededor.
   */
  dragBodyToward(entry, targetX, targetY, targetZ) {
    entry.body.wakeUp();
    const bz = this.getBagZone(entry.bagNumber);
    const pad = 10;
    const clampedX = Math.max(bz.minX + pad, Math.min(bz.maxX - pad, targetX));
    const clampedZ = Math.max(bz.minZ + pad, Math.min(bz.maxZ - pad, targetZ));
    const clampedY = Math.max(8, Math.min(200, targetY));
    this.wakeNearby({ x: clampedX, z: clampedZ }, 100);
    entry.body.velocity.set(
      (clampedX - entry.body.position.x) * 10,
      (clampedY - entry.body.position.y) * 10,
      (clampedZ - entry.body.position.z) * 10
    );
    entry.body.angularVelocity.scale(0.8, entry.body.angularVelocity);
  }

  _containBodyInZone(entry) {
    const body = entry.body;
    const vel = body.velocity;
    const maxSpeed = 420;
    const speedSq = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z;
    if (speedSq > maxSpeed * maxSpeed) {
      const scale = maxSpeed / Math.sqrt(speedSq);
      vel.x *= scale;
      vel.y *= scale;
      vel.z *= scale;
    }

    const bz = this.getBagZone(entry.bagNumber);
    const pad = 6;
    const minX = bz.minX + pad;
    const maxX = bz.maxX - pad;
    const minZ = bz.minZ + pad;
    const maxZ = bz.maxZ - pad;

    if (body.position.x < minX) {
      body.position.x = minX;
      if (vel.x < 0) vel.x = -vel.x * 0.25;
    } else if (body.position.x > maxX) {
      body.position.x = maxX;
      if (vel.x > 0) vel.x = -vel.x * 0.25;
    }

    if (body.position.z < minZ) {
      body.position.z = minZ;
      if (vel.z < 0) vel.z = -vel.z * 0.25;
    } else if (body.position.z > maxZ) {
      body.position.z = maxZ;
      if (vel.z > 0) vel.z = -vel.z * 0.25;
    }

    if (body.position.y < 1) {
      body.position.y = 1;
      if (vel.y < 0) vel.y = 0;
    } else if (body.position.y > 220) {
      body.position.y = 220;
      if (vel.y > 0) vel.y = -vel.y * 0.2;
    }
  }

  /**
   * Da un pequeño impulso a toda la pila para revolver piezas escondidas abajo.
   */
  shakeAll() {
    for (const item of this.items) {
      item.body.wakeUp();
      item.body.velocity.set(
        (Math.random() - 0.5) * 110,
        70 + Math.random() * 90,
        (Math.random() - 0.5) * 110
      );
      item.body.angularVelocity.set(
        (Math.random() - 0.5) * 4,
        (Math.random() - 0.5) * 4,
        (Math.random() - 0.5) * 4
      );
    }
  }

  clear() {
    for (const item of this.items) {
      this.world.removeBody(item.body);
    }
    this.items = [];
  }

  exportPoses(onlyAwake = false) {
    const poses = [];
    for (const item of this.items) {
      if (onlyAwake && item.body.sleepState === CANNON.Body.SLEEPING) continue;
      poses.push({
        id: item.instanceId,
        p: [
          Math.round(item.body.position.x * 100) / 100,
          Math.round(item.body.position.y * 100) / 100,
          Math.round(item.body.position.z * 100) / 100,
        ],
        q: [
          Math.round(item.body.quaternion.x * 10000) / 10000,
          Math.round(item.body.quaternion.y * 10000) / 10000,
          Math.round(item.body.quaternion.z * 10000) / 10000,
          Math.round(item.body.quaternion.w * 10000) / 10000,
        ],
      });
    }
    return poses;
  }

  applyRemotePoses(poses, onBodyMoved = null) {
    if (!Array.isArray(poses) || !poses.length) return;
    const byId = new Map();
    for (const item of this.items) byId.set(item.instanceId, item);
    for (const pose of poses) {
      const item = byId.get(pose.id);
      if (!item || !pose.p || !pose.q) continue;
      item.body.position.set(pose.p[0], pose.p[1], pose.p[2]);
      item.body.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
      item.mesh.position.set(pose.p[0], pose.p[1], pose.p[2]);
      item.mesh.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
      item.mesh.updateMatrix();
      item.mesh.updateMatrixWorld(true);
      if (onBodyMoved) onBodyMoved(item);
    }
  }

  step(dtSeconds, onBodyMoved = null) {
    if (!this.items.length || this.passiveMode) return;
    const clamped = Math.min(dtSeconds, 1 / 30);
    const maxSubSteps = this.items.length > 450 ? 1 : 3;
    this.world.step(1 / 60, clamped, maxSubSteps);

    for (const item of this.items) {
      if (item.body.sleepState === CANNON.Body.SLEEPING) continue;
      this._containBodyInZone(item);
      item.mesh.position.set(item.body.position.x, item.body.position.y, item.body.position.z);
      item.mesh.quaternion.set(
        item.body.quaternion.x,
        item.body.quaternion.y,
        item.body.quaternion.z,
        item.body.quaternion.w
      );
      item.mesh.updateMatrix();
      item.mesh.updateMatrixWorld(true);
      if (onBodyMoved) onBodyMoved(item);
    }
  }
}
