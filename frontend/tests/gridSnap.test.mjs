import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BuildController } from "../src/builder/buildController.js";
import {
  computeSnappedPlacementY,
  computeStudCoordParityOffset,
  computeStudParityOffset,
  computeSupportDistanceAlongDir,
  computeSupportedSurfaceY,
  computeSurfaceY,
  computeWallParityOffset,
  snapAngle,
  snapNormalToCardinal,
  snapToReferenceCoord,
  snapXZ,
} from "../src/builder/gridSnap.js";

test("snapNormalToCardinal y snapToReferenceCoord alinean piezas en studs laterales", () => {
  assert.deepEqual(snapNormalToCardinal(-0.92, 0.1, 0.2), { x: -1, y: 0, z: 0 });
  assert.deepEqual(snapNormalToCardinal(0.1, 0.95, -0.1), { x: 0, y: 1, z: 0 });
  // Stud lateral en z=10, pieza 1x4 con refStud en +10 -> origen en múltiplos de 20
  assert.equal(snapToReferenceCoord(13, 10, 10, 20), 20);
  assert.equal(snapToReferenceCoord(-4, 10, 10, 20), 0);
});

test("computeStudCoordParityOffset alinea studs reales aunque haya salientes laterales", () => {
  // Bracket 44728: stud superior en x=+-10, z=0 -> offsetX=0, offsetZ=10
  assert.equal(computeStudCoordParityOffset(10), 0);
  assert.equal(computeStudCoordParityOffset(0), 10);
  assert.equal(computeStudCoordParityOffset(-20), 10);
});

test("computeWallParityOffset alinea tanto simétricas (1x6) como desplazadas (3660)", () => {
  assert.equal(computeWallParityOffset(-10), 10);  // 1x6 lado impar (-10..+10)
  assert.equal(computeWallParityOffset(-60), 0);   // 1x6 lado par (-60..+60)
  assert.equal(computeWallParityOffset(-30), 10);  // 3660 Slope Inverted 2x2 (-30..+10)
  assert.equal(computeWallParityOffset(-20), 0);   // 2x4 / 3660 ancho (-20..+20)
  assert.equal(computeWallParityOffset(-14), 10);  // Bracket 44728 (-14..+10)
});

test("computeStudParityOffset devuelve 10 LDU para anchos impares y 0 para pares", () => {
  assert.equal(computeStudParityOffset(20), 10); // 1 stud
  assert.equal(computeStudParityOffset(40), 0);  // 2 studs
  assert.equal(computeStudParityOffset(60), 10); // 3 studs
  assert.equal(computeStudParityOffset(120), 0); // 6 studs
  assert.equal(computeStudParityOffset(280), 0); // 14 studs
});

test("snapXZ alinea pieza 1x6 (impar x par) sobre studs de pieza 2x14 (par x par)", () => {
  // 2x14 centrada en (0, 0) tiene studs en x = ..., -30, -10, +10, +30, ...
  const pos2x14 = snapXZ(4, -3, { offsetX: 0, offsetZ: 0 });
  assert.deepEqual(pos2x14, { x: 0, z: 0 });

  // 1x6 orientada a lo largo de Z tiene 1 stud en X (offsetX=10) y 6 en Z (offsetZ=0):
  // su stud en X queda en x=10, -10, +30, coincidiendo exacto con los studs de la 2x14
  const pos1x6 = snapXZ(11, 2, { offsetX: 10, offsetZ: 0 });
  assert.deepEqual(pos1x6, { x: 10, z: 0 });

  // En modo fino (10 LDU) permite colocar tanto sobre studs como entre medio
  assert.deepEqual(snapXZ(19, -29, { fineGrid: true }), { x: 20, z: -30 });
});

test("computeSurfaceY ignora la altura del stud (4 LDU) al apilar", () => {
  assert.equal(computeSurfaceY(0, true), 0);
  assert.equal(computeSurfaceY(24, false), 24);
  assert.equal(computeSurfaceY(28, false), 24); // Punta de stud de brick 1x1
  assert.equal(computeSurfaceY(12, false), 8); // Punta de stud de plate 1x1
});

test("computeSnappedPlacementY apoya la base local sobre surfaceY y permite brackets colgantes", () => {
  assert.equal(computeSnappedPlacementY(0, -24), 24);
  assert.equal(computeSnappedPlacementY(24, -24), 48);
  assert.equal(computeSnappedPlacementY(24, -8), 32);
  // Bracket 44728: localMinY = -40, supportUndersideY = -8 sobre Brick (surfaceY=32) -> Y=40
  assert.equal(computeSnappedPlacementY(32, -40, 0, -8), 40);
  assert.equal(computeSnappedPlacementY(0, -40, 0, -8), 40);
});

test("snapAngle normaliza rotaciones en [0, 2*PI)", () => {
  const halfPi = Math.PI / 2;
  assert.ok(Math.abs(snapAngle(halfPi * 4) - 0) < 1e-6);
  assert.ok(Math.abs(snapAngle(-halfPi) - halfPi * 3) < 1e-6);
});

test("computeSupportDistanceAlongDir y snapToReferenceCoord soportan grosores exactos y desfases 0.20 / 0.50", () => {
  const brick1x1 = [new THREE.Box3(new THREE.Vector3(-10, -24, -10), new THREE.Vector3(10, 0, 10))];
  const qUp = new THREE.Quaternion();
  const qSideX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);

  // Brick normal en +Y apoya a 24 LDU; girado 90° apoya sobre su costado de ancho 10 LDU en +Y y 24 LDU en +X
  assert.ok(Math.abs(computeSupportDistanceAlongDir(brick1x1, qUp, new THREE.Vector3(0, 1, 0)) - 24) < 1e-6);
  assert.ok(Math.abs(computeSupportDistanceAlongDir(brick1x1, qSideX, new THREE.Vector3(0, 1, 0)) - 10) < 1e-6);
  assert.ok(Math.abs(computeSupportDistanceAlongDir(brick1x1, qSideX, new THREE.Vector3(1, 0, 0)) - 24) < 1e-6);

  // Plate 1x4 sobre stud desplazado 4 LDU (0.20 studs en z=+14) con receptor en -30 -> alinea exacto en +14
  const snappedBracket = snapToReferenceCoord(6, -30, 14, 20);
  assert.equal(snappedBracket, 4); // receptores en 4 + [-30,-10,10,30] = [-26,-6,+14,+34]

  // Grupo compuesto: caja inferior en localPos(0,-8,0) + superior en localPos(0,+8,0)
  const plateBox = new THREE.Box3(new THREE.Vector3(-20, -8, -10), new THREE.Vector3(20, 0, 10));
  const comp = [
    { box: plateBox, localPos: new THREE.Vector3(0, 0, 0), localQuat: qUp },
    { box: plateBox, localPos: new THREE.Vector3(0, 8, 0), localQuat: qUp },
  ];
  assert.ok(Math.abs(computeSupportDistanceAlongDir(comp, qUp, new THREE.Vector3(0, 1, 0)) - 8) < 1e-6);
});

test("computeSupportedSurfaceY evita piezas flotando por tocar solo una esquina", () => {
  const placed = [
    // Cabeza alta en [0..40, 0..80, 0..40]
    { minX: 0, maxX: 40, minY: 0, maxY: 80, minZ: 0, maxZ: 40 },
    // Base más ancha en [-20..60, 0..8, -20..60]
    { minX: -20, maxX: 60, minY: 0, maxY: 8, minZ: -20, maxZ: 60 },
  ];

  // Pieza fuera de la esquina alta (solo roza en x=40 por 0 LDU) -> cae al soporte real debajo (y=8)
  assert.equal(computeSupportedSurfaceY(40, 60, 20, 40, placed, 82, 4), 8);
  // Pieza aún más afuera de toda base -> cae a la mesa (y=0)
  assert.equal(computeSupportedSurfaceY(60, 80, 20, 40, placed, 82, 4), 0);
  // Pieza apoyada claramente encima del bloque alto (solapa 20x20 LDU) -> queda en y=80
  assert.equal(computeSupportedSurfaceY(20, 40, 20, 40, placed, 82, 4), 80);
});

test("BuildController.nudgeVertical mueve únicamente en eje Y mundial aunque haya stud o pared lateral", () => {
  const fakeSceneManager = {
    camera: { position: new THREE.Vector3(100, 120, 220) },
    onFrame() {},
    addPlacedMesh() {},
    removePlacedMesh() {},
    setSelectionBoxes() {},
    refreshSelectionBox() {},
  };
  const bc = new BuildController(fakeSceneManager, {});

  // Pieza colocada con stud lateral apuntando hacia +X
  const baseMesh = new THREE.Group();
  baseMesh.position.set(100, 24, 100);
  baseMesh.userData = {
    topStuds: [{ pos: new THREE.Vector3(10, -12, 0), up: new THREE.Vector3(1, 0, 0) }],
  };
  const baseBox = new THREE.Box3(new THREE.Vector3(90, 0, 90), new THREE.Vector3(110, 24, 110));
  bc.placedPieces.push({
    instanceId: "placed_1",
    elementId: "base",
    mesh: baseMesh,
    localBox: new THREE.Box3(new THREE.Vector3(-10, -24, -10), new THREE.Vector3(10, 0, 10)),
    worldBox: baseBox,
  });

  // Pieza en mano 1x1x1 plate con receptores estándar
  const localBox = new THREE.Box3(new THREE.Vector3(-10, -8, -10), new THREE.Vector3(10, 0, 10));
  const carryMesh = new THREE.Group();
  carryMesh.userData = {
    part: { dimensions: "1 x 1" },
    collisionBoxes: [localBox],
    bottomReceptors: [new THREE.Vector3(0, 0, 0)],
  };
  const ghost = new THREE.Group();

  bc.carry = {
    source: "pile",
    elementId: "plate1x1",
    mesh: carryMesh,
    ghost,
    localBox,
    quaternion: new THREE.Quaternion(),
    ghostBox: localBox.clone(),
    surfaceNormal: new THREE.Vector3(1, 0, 0),
    activeMechKind: null,
    spinAngle: 0,
    manualTiltApplied: false,
    manualOffsetX: 0,
    manualOffsetY: 0,
    manualOffsetZ: 0,
    parityOffsetX: 0,
    parityOffsetZ: 0,
    isColliding: false,
    lastValid: null,
  };
  bc._lastHit = {
    kind: "placed",
    object: baseMesh,
    point: new THREE.Vector3(110, 12, 100),
    normal: new THREE.Vector3(1, 0, 0),
  };

  bc._updateCarryTransform();
  const initialPos = ghost.position.clone();

  bc.nudgeVertical(1, false); // 1 placa = +8 LDU en Y
  assert.ok(Math.abs(ghost.position.x - initialPos.x) < 1e-6, "ArrowUp no debe mover X");
  assert.ok(Math.abs(ghost.position.z - initialPos.z) < 1e-6, "ArrowUp no debe mover Z");
  assert.ok(Math.abs(ghost.position.y - (initialPos.y + 8)) < 1e-6, "ArrowUp debe subir +8 en Y");

  bc.nudgeVertical(-1, true); // media placa = -4 LDU en Y
  assert.ok(Math.abs(ghost.position.x - initialPos.x) < 1e-6, "ArrowDown fino no debe mover X");
  assert.ok(Math.abs(ghost.position.z - initialPos.z) < 1e-6, "ArrowDown fino no debe mover Z");
  assert.ok(Math.abs(ghost.position.y - (initialPos.y + 4)) < 1e-6, "ArrowDown fino debe bajar -4 en Y");
});

test("Arrastrar click derecho rota según perspectiva (der=T, izq=R, arriba=G, abajo=F)", () => {
  let activeRight = new THREE.Vector3(1, 0, 0);
  let activeForward = new THREE.Vector3(0, 0, -1);
  const fakeSceneManager = {
    camera: { position: new THREE.Vector3(0, 120, 220) },
    controls: { enablePan: true, enableRotate: true },
    getHorizontalCameraAxes() {
      return { right: activeRight.clone(), forward: activeForward.clone() };
    },
    onFrame() {},
    addPlacedMesh() {},
    removePlacedMesh() {},
    setSelectionBoxes() {},
    refreshSelectionBox() {},
  };
  const bc = new BuildController(fakeSceneManager, {});
  const calls = [];
  bc.carry = { ghost: new THREE.Group() };
  bc.rotateActive = (axis, dir) =>
    calls.push([axis?.isVector3 ? axis.toArray() : axis, dir]);

  // Vista frontal: right = +X
  assert.equal(bc.handleRightPointerDown(100, 100), true);
  bc._handleRightDragMove(200, 100); // derecha -> T (+1 en Y)
  bc._handleRightDragMove(100, 100); // izquierda -> R (-1 en Y)
  bc._handleRightDragMove(100, 0);   // arriba -> G (-1 sobre right)
  bc._handleRightDragMove(100, 100); // abajo -> F (+1 sobre right)
  bc.handleRightPointerUp();

  // Cámara rotada 90° a la derecha: right = (0, 0, -1)
  activeRight = new THREE.Vector3(0, 0, -1);
  activeForward = new THREE.Vector3(-1, 0, 0);
  assert.equal(bc.handleRightPointerDown(100, 100), true);
  bc._handleRightDragMove(100, 0);   // arriba -> G (-1 sobre nuevo right)
  bc.handleRightPointerUp();

  assert.deepEqual(calls, [
    ["y", 1],
    ["y", -1],
    [[1, 0, 0], -1],
    [[1, 0, 0], 1],
    [[0, 0, -1], -1],
  ]);
});

test("Rotar grupo arriba/abajo repetidamente en eje Z no genera deriva ni desfasaje de worldBox", () => {
  const fakeSceneManager = {
    camera: { position: new THREE.Vector3(0, 120, 220) },
    controls: { enablePan: true, enableRotate: true },
    onFrame() {},
    addPlacedMesh() {},
    removePlacedMesh() {},
    syncPlacedTransform() {},
    setSelectionBoxes() {},
    refreshSelectionBox() {},
  };
  const bc = new BuildController(fakeSceneManager, {});

  const makePiece = (id, x, y, z, w, h, d) => {
    const mesh = new THREE.Group();
    mesh.position.set(x, y, z);
    const localBox = new THREE.Box3(
      new THREE.Vector3(-w / 2, -h, -d / 2),
      new THREE.Vector3(w / 2, 0, d / 2)
    );
    mesh.userData = { collisionBoxes: [localBox] };
    const piece = {
      instanceId: id,
      elementId: id,
      mesh,
      localBox,
      worldBox: null,
    };
    bc._refreshPlacedWorldBox(piece);
    bc.placedPieces.push(piece);
    return piece;
  };

  // Grupo asimétrico tipo frente de auto: base 6x2x1 brick + pieza superior desplazada a un lado
  const p1 = makePiece("base", 0, 24, 0, 120, 24, 40);
  const p2 = makePiece("top", -40, 32, 0, 40, 8, 20);
  const init1 = p1.mesh.position.clone();
  const init2 = p2.mesh.position.clone();
  const box1Ref = p1.worldBox;

  bc.selected = { kind: "group", items: [p1, p2] };

  for (let i = 0; i < 6; i += 1) {
    bc.rotateActive("z", -1);
    assert.equal(p1.worldBox, box1Ref, "worldBox debe actualizarse in-place para Box3Helper");
    bc.rotateActive("z", 1);
  }

  assert.ok(p1.mesh.position.distanceTo(init1) < 1e-4, "Base del grupo no debe derivar tras abajo/arriba");
  assert.ok(p2.mesh.position.distanceTo(init2) < 1e-4, "Pieza superior del grupo no debe derivar tras abajo/arriba");
});

test("Modo fantasmal congela la pieza mientras se orbita/mueve la cámara manteniendo click", () => {
  let raycastCalls = 0;
  const fakeSceneManager = {
    camera: { position: new THREE.Vector3(0, 120, 220) },
    controls: { enablePan: true, enableRotate: true },
    isCameraInteracting: false,
    onFrame() {},
    raycastWorkspace() {
      raycastCalls += 1;
      return null;
    },
  };
  const bc = new BuildController(fakeSceneManager, {});
  bc.carry = { ghost: new THREE.Group(), mesh: new THREE.Group() };

  // Hover normal (sin botón apretado): sigue al mouse
  bc.handlePointerMove(100, 100, 0);
  assert.equal(raycastCalls, 1);

  // Orbitando con click izquierdo sostenido o OrbitControls activo: congela el fantasma
  bc.handlePointerMove(140, 120, 1);
  fakeSceneManager.isCameraInteracting = true;
  bc.handlePointerMove(180, 140, 0);
  bc.handlePointerMove(200, 150, 4);
  assert.equal(raycastCalls, 1, "No debe mover el fantasma mientras se arrastra la cámara");

  // Arrastrando directamente una pieza ya levantada (_draggedCarryFromPress = true): sí acompaña
  fakeSceneManager.isCameraInteracting = false;
  bc._draggedCarryFromPress = true;
  bc.handlePointerMove(220, 160, 1);
  assert.equal(raycastCalls, 2);
});
