import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { BuildController } from "../src/builder/buildController.js";
import { LDrawService } from "../src/core/ldrawService.js";
import { computePaginationWindow } from "../src/ui/lobbyView.js";
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

test("recessedReceptors y _findBestTargetReceptor conectan piezas con stud notch en ambos sentidos", () => {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(120, 180, 120);
  cam.updateMatrixWorld(true);
  const bc = new BuildController(
    { camera: cam, controls: { enablePan: true, enableRotate: true }, onFrame() {} },
    {}
  );

  // Plate 2x2 Corner simulada en [20, 8, 0] rotY=90 -> studs en (0,8,0), (20,8,0), (20,8,-20)
  const plateMesh = new THREE.Group();
  plateMesh.position.set(20, 8, 0);
  plateMesh.updateMatrixWorld(true);
  const plateBox = new THREE.Box3(new THREE.Vector3(-30, -8, -30), new THREE.Vector3(10, 4, 10));
  plateMesh.userData = {
    collisionBoxes: [
      new THREE.Box3(new THREE.Vector3(-30, -8, -10), new THREE.Vector3(10, 0, 10)),
      new THREE.Box3(new THREE.Vector3(-10, -8, -30), new THREE.Vector3(10, 0, -10)),
    ],
    topStuds: [
      { pos: new THREE.Vector3(-20, 0, 0), up: new THREE.Vector3(0, 1, 0), height: 4 },
      { pos: new THREE.Vector3(0, 0, 0), up: new THREE.Vector3(0, 1, 0), height: 4 },
      { pos: new THREE.Vector3(0, 0, -20), up: new THREE.Vector3(0, 1, 0), height: 4 },
    ],
    bottomReceptors: [new THREE.Vector3(0, -8, 0)],
    recessedReceptors: [],
    worldBox: plateBox.clone(),
  };

  // Bracket bloqueando studs (0,8,0) y (20,8,0) entre y=8..16 (solo queda libre stud (20,8,-20))
  const bracketMesh = new THREE.Group();
  bracketMesh.position.set(10, 16, 0);
  bracketMesh.updateMatrixWorld(true);
  const bracketBox = new THREE.Box3(new THREE.Vector3(-10, 8, -10), new THREE.Vector3(30, 16, 10));
  bracketMesh.userData = {
    collisionBoxes: [new THREE.Box3(new THREE.Vector3(-20, -8, -10), new THREE.Vector3(20, 0, 10))],
    topStuds: [],
    bottomReceptors: [],
    recessedReceptors: [],
    worldBox: bracketBox.clone(),
  };

  bc.placedPieces = [
    { instanceId: "p24", mesh: plateMesh, localBox: plateBox, worldBox: plateBox },
    { instanceId: "p99", mesh: bracketMesh, localBox: bracketBox, worldBox: bracketBox },
  ];

  // Caso 1: llevar 5095 (recessedReceptor en (-10, 8, -10)) con rotY=180 sobre stud (20, 8, -20)
  const wedgeMesh = new THREE.Group();
  wedgeMesh.userData = {
    collisionBoxes: [
      new THREE.Box3(new THREE.Vector3(-20, 0, 0), new THREE.Vector3(20, 16, 18)),
      new THREE.Box3(new THREE.Vector3(0, 0, -20), new THREE.Vector3(20, 16, 0)),
      new THREE.Box3(new THREE.Vector3(-20, 8, -20), new THREE.Vector3(0, 16, 0)),
    ],
    topStuds: [],
    bottomReceptors: [new THREE.Vector3(-10, 0, 10), new THREE.Vector3(10, 0, -10)],
    recessedReceptors: [new THREE.Vector3(-10, 8, -10)],
    defaultSupportUndersideY: 0,
    recessedSupportUndersideY: null,
  };
  const ghost = new THREE.Group();
  bc.carry = {
    source: "pile",
    elementId: "5095",
    mesh: wedgeMesh,
    ghost,
    localBox: new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 16, 18)),
    ghostBox: new THREE.Box3(new THREE.Vector3(-20, 0, -18), new THREE.Vector3(20, 16, 20)),
    spinAngle: Math.PI,
    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
    surfaceNormal: new THREE.Vector3(0, 1, 0),
    manualTiltApplied: false,
    activeMechKind: null,
    manualOffsetX: 0,
    manualOffsetY: 0,
    manualOffsetZ: 0,
    parityOffsetX: 0,
    parityOffsetZ: 0,
    isColliding: false,
  };
  bc._lastHit = {
    kind: "placed",
    point: new THREE.Vector3(20, 8, -20),
    normal: new THREE.Vector3(0, 1, 0),
    object: plateMesh,
  };
  bc._updateCarryTransform();
  assert.equal(bc.carry.isColliding, false);
  assert.deepEqual(
    ghost.position.toArray().map((n) => Math.round(n)),
    [10, 0, -30],
    "5095 debe encastrar al ras en y=0 usando su stud notch (-10,8,-10)"
  );

  // Caso 2: inverso - 5095 colocada y llevamos 2420 apuntando al hueco del stud notch
  wedgeMesh.position.set(0, 0, 0);
  wedgeMesh.quaternion.set(0, 0, 0, 1);
  wedgeMesh.updateMatrixWorld(true);
  const wedgeBox = new THREE.Box3(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 16, 18));
  wedgeMesh.userData.worldBox = wedgeBox;
  bc.placedPieces = [{ instanceId: "w5095", mesh: wedgeMesh, localBox: wedgeBox, worldBox: wedgeBox }];

  const carryPlate = plateMesh.clone(true);
  carryPlate.position.set(0, 0, 0);
  carryPlate.userData = { ...plateMesh.userData };
  const ghostPlate = new THREE.Group();
  bc.carry = {
    source: "pile",
    elementId: "2420",
    mesh: carryPlate,
    ghost: ghostPlate,
    localBox: new THREE.Box3(new THREE.Vector3(-30, -8, -30), new THREE.Vector3(10, 4, 10)),
    ghostBox: new THREE.Box3(new THREE.Vector3(-30, -8, -30), new THREE.Vector3(10, 4, 10)),
    spinAngle: 0,
    quaternion: new THREE.Quaternion(),
    surfaceNormal: new THREE.Vector3(0, 1, 0),
    manualTiltApplied: false,
    activeMechKind: null,
    manualOffsetX: 0,
    manualOffsetY: 0,
    manualOffsetZ: 0,
    parityOffsetX: 0,
    parityOffsetZ: 0,
    isColliding: false,
  };
  bc._lastHit = {
    kind: "placed",
    point: new THREE.Vector3(-10, 6, -10),
    normal: new THREE.Vector3(-1, 0, 0),
    object: wedgeMesh,
  };
  bc._updateCarryTransform();
  assert.equal(bc.carry.isColliding, false);
  assert.equal(Math.round(ghostPlate.position.y), 8, "2420 debe encastrar sus studs hacia +Y dentro del stud notch de 5095");
});

test("extractBottomReceptors centra piezas curvas 1x1 (tipo 24246) exactamente en (0, y, 0)", () => {
  const boxes = [
    new THREE.Box3(new THREE.Vector3(-10, -8, -10), new THREE.Vector3(10, 0, -6)),
    new THREE.Box3(new THREE.Vector3(-10, -8, -6), new THREE.Vector3(-6, 0, 6)),
    new THREE.Box3(new THREE.Vector3(6, -8, -6), new THREE.Vector3(10, 0, 6)),
    new THREE.Box3(new THREE.Vector3(-4, -8, 4), new THREE.Vector3(4, 0, 10)),
  ];
  const localBox = new THREE.Box3(new THREE.Vector3(-10, -8, -10), new THREE.Vector3(10, 0, 10));
  const { bottomReceptors } = LDrawService.extractBottomReceptors(boxes, localBox, -8, []);
  assert.equal(bottomReceptors.length, 1);
  assert.deepEqual(
    bottomReceptors[0].toArray().map((n) => Math.round(n * 10) / 10),
    [0, -8, 0]
  );
});

test("3386 y 11477 conectan completamente en ambos sentidos sin dejar holgura de 4 LDU", () => {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(-120, 80, -120);
  cam.updateMatrixWorld(true);
  const bc = new BuildController(
    { camera: cam, controls: { enablePan: true, enableRotate: true }, onFrame() {} },
    {}
  );

  // 11477 colocada de costado con su arco rebajado (0, 8, -10) mirando hacia +Z en (0, 38, -12)
  const bowMesh = new THREE.Group();
  bowMesh.position.set(0, 28, -4);
  const qBow = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 0, -1), Math.PI)
    .multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)))
    .normalize();
  bowMesh.quaternion.copy(qBow);
  bowMesh.updateMatrixWorld(true);
  const bowLocalBox = new THREE.Box3(new THREE.Vector3(-10, 0, -20), new THREE.Vector3(10, 16, 20));
  const bowWorldBox = bowLocalBox.clone().applyMatrix4(bowMesh.matrixWorld);
  bowMesh.userData = {
    collisionBoxes: [
      new THREE.Box3(new THREE.Vector3(-10, 0, 0), new THREE.Vector3(10, 16, 20)),
      new THREE.Box3(new THREE.Vector3(-10, 8, -20), new THREE.Vector3(10, 16, 0)),
    ],
    topStuds: [],
    bottomReceptors: [new THREE.Vector3(0, 0, 10)],
    recessedReceptors: [new THREE.Vector3(0, 8, -10)],
    worldBox: bowWorldBox,
  };
  bc.placedPieces = [{ instanceId: "b11477", mesh: bowMesh, localBox: bowLocalBox, worldBox: bowWorldBox }];

  // Llevando 3386 (con stud lateral en (0, -6, 10) hacia +Z): debe mantenerse vertical y encastrar en (0, 44, -2)
  const modMesh = new THREE.Group();
  modMesh.userData = {
    collisionBoxes: [new THREE.Box3(new THREE.Vector3(-10, -16, -10), new THREE.Vector3(10, 0, 10))],
    topStuds: [
      { pos: new THREE.Vector3(0, 0, 0), up: new THREE.Vector3(0, 1, 0), height: 4 },
      { pos: new THREE.Vector3(0, -6, 10), up: new THREE.Vector3(0, 0, 1), height: 4 },
    ],
    bottomReceptors: [new THREE.Vector3(0, -16, 0)],
    recessedReceptors: [],
    defaultSupportUndersideY: -16,
    recessedSupportUndersideY: null,
  };
  const ghostMod = new THREE.Group();
  bc.carry = {
    source: "pile",
    elementId: "3386",
    mesh: modMesh,
    ghost: ghostMod,
    localBox: new THREE.Box3(new THREE.Vector3(-10, -16, -10), new THREE.Vector3(10, 4, 14)),
    ghostBox: new THREE.Box3(new THREE.Vector3(-10, -16, -10), new THREE.Vector3(10, 4, 14)),
    spinAngle: 0,
    quaternion: new THREE.Quaternion(),
    surfaceNormal: new THREE.Vector3(0, 1, 0),
    manualTiltApplied: false,
    activeMechKind: null,
    manualOffsetX: 0,
    manualOffsetY: 0,
    manualOffsetZ: 0,
    parityOffsetX: 0,
    parityOffsetZ: 0,
    isColliding: false,
  };
  bc._lastHit = {
    kind: "placed",
    point: new THREE.Vector3(0, 38, -12),
    normal: new THREE.Vector3(0, 0, 1),
    object: bowMesh,
  };
  bc._updateCarryTransform();
  assert.equal(bc.carry.isColliding, false);
  assert.deepEqual(
    ghostMod.position.toArray().map((n) => Math.round(n) || 0),
    [0, 44, -2],
    "3386 debe conservar verticalidad y meter su stud lateral hasta z=-12 dentro de 11477"
  );
});

test("Raycast por dentro de stud hueco (11211) o borde cilíndrico no empuja 24246 hacia atrás", () => {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(-50, 150, 200);
  const bc = new BuildController(
    { camera: cam, onFrame() {} },
    { isPointInAnyBag: () => false }
  );
  bc.collisionEnabled = true;

  // Simulamos 11211 (1x2 con 2 studs huecos al frente en z=10) en (0, 24, 0)
  const brickMesh = new THREE.Group();
  brickMesh.position.set(0, 24, 0);
  brickMesh.userData = {
    collisionBoxes: [new THREE.Box3(new THREE.Vector3(-20, -24, -10), new THREE.Vector3(20, 0, 10))],
    topStuds: [
      { pos: new THREE.Vector3(-10, -10, 10), up: new THREE.Vector3(0, 0, 1), height: 4 },
      { pos: new THREE.Vector3(10, -10, 10), up: new THREE.Vector3(0, 0, 1), height: 4 },
      { pos: new THREE.Vector3(-10, 0, 0), up: new THREE.Vector3(0, 1, 0), height: 4 },
      { pos: new THREE.Vector3(10, 0, 0), up: new THREE.Vector3(0, 1, 0), height: 4 },
    ],
    bottomReceptors: [new THREE.Vector3(-10, -24, 0), new THREE.Vector3(10, -24, 0)],
    recessedReceptors: [],
    defaultSupportUndersideY: -24,
    recessedSupportUndersideY: null,
  };
  brickMesh.updateMatrixWorld(true);
  bc.placedPieces = [
    {
      instanceId: "b11211",
      mesh: brickMesh,
      localBox: new THREE.Box3(new THREE.Vector3(-20, -24, -10), new THREE.Vector3(20, 4, 14)),
      worldBox: new THREE.Box3(new THREE.Vector3(-20, 0, -10), new THREE.Vector3(20, 24, 10)),
    },
  ];

  // Simulamos Tile 1x1 Half Circle (24246) con caja real [-10..10, -8..0, -10..10]
  const tileBox = new THREE.Box3(new THREE.Vector3(-10, -8, -10), new THREE.Vector3(10, 0, 10));
  const tileMesh = new THREE.Mesh(
    new THREE.BoxGeometry(20, 8, 20),
    new THREE.MeshBasicMaterial()
  );
  tileMesh.geometry.translate(0, -4, 0);
  tileMesh.userData = {
    collisionBoxes: [tileBox.clone()],
    topStuds: [],
    bottomReceptors: [new THREE.Vector3(0, -8, 0)],
    recessedReceptors: [],
    defaultSupportUndersideY: -8,
    recessedSupportUndersideY: null,
  };
  const ghostTile = tileMesh.clone();
  bc.carry = {
    source: "pile",
    elementId: "24246",
    mesh: tileMesh,
    ghost: ghostTile,
    localBox: tileBox.clone(),
    ghostBox: tileBox.clone(),
    spinAngle: 0,
    quaternion: new THREE.Quaternion(),
    surfaceNormal: new THREE.Vector3(0, 1, 0),
    manualTiltApplied: false,
    activeMechKind: null,
    manualOffsetX: 0,
    manualOffsetY: 0,
    manualOffsetZ: 0,
    parityOffsetX: 0,
    parityOffsetZ: 0,
    isColliding: false,
  };

  // 1. Rayo entra por el centro del stud hueco (-10, 14, 12) e impacta pared interna trasera en z=-6
  bc._lastHit = {
    kind: "placed",
    object: brickMesh,
    point: new THREE.Vector3(-7.7, 2.5, -6),
    normal: new THREE.Vector3(0, 0, 1),
  };
  bc._updateCarryTransform();
  assert.equal(bc.carry.isColliding, false);
  assert.deepEqual(
    ghostTile.position.toArray().map((n) => Math.round(n) || 0),
    [-10, 14, 18],
    "Rayo a través del stud hueco debe encastrar al frente en (-10, 14, 18) y no irse atrás"
  );

  // 2. Rayo roza el borde cilíndrico superior del stud horizontal (-11.5, 19.7, 12.4)
  bc.carry.lastValid = null;
  bc._lastHit = {
    kind: "placed",
    object: brickMesh,
    point: new THREE.Vector3(-11.5, 19.7, 12.4),
    normal: new THREE.Vector3(-0.2, 0.98, 0),
  };
  bc._updateCarryTransform();
  assert.equal(bc.carry.isColliding, false);
  assert.deepEqual(
    ghostTile.position.toArray().map((n) => Math.round(n) || 0),
    [-10, 14, 18],
    "Roce sobre cilindro del stud lateral debe mantenerse en (-10, 14, 18)"
  );
});

test("Cursor en pared vertical alta o mesa junto a pared no dispara saltos bruscos hacia el techo", () => {
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(-50, 140, 220);
  const bc = new BuildController(
    { camera: cam, onFrame() {} },
    { isPointInAnyBag: () => false }
  );
  bc.collisionEnabled = true;

  // Bloque frontal alto (0..48 LDU)
  const wallBox = new THREE.Box3(new THREE.Vector3(-20, -48, -10), new THREE.Vector3(20, 0, 10));
  const wallMesh = new THREE.Group();
  wallMesh.position.set(0, 48, 0);
  wallMesh.userData = {
    collisionBoxes: [wallBox],
    topStuds: [],
    bottomReceptors: [new THREE.Vector3(0, -48, 0)],
    recessedReceptors: [],
    defaultSupportUndersideY: -48,
    recessedSupportUndersideY: null,
  };
  wallMesh.updateMatrixWorld(true);
  bc.placedPieces = [
    {
      instanceId: "wall",
      mesh: wallMesh,
      localBox: wallBox,
      worldBox: new THREE.Box3(new THREE.Vector3(-20, 0, -10), new THREE.Vector3(20, 48, 10)),
    },
  ];

  const carriedBox = new THREE.Box3(new THREE.Vector3(-10, -8, -30), new THREE.Vector3(10, 0, 10));
  const carriedMesh = new THREE.Mesh(new THREE.BoxGeometry(20, 8, 40), new THREE.MeshBasicMaterial());
  carriedMesh.geometry.translate(0, -4, -10);
  carriedMesh.userData = {
    collisionBoxes: [carriedBox.clone()],
    topStuds: [],
    bottomReceptors: [new THREE.Vector3(0, -8, -10)],
    recessedReceptors: [],
    defaultSupportUndersideY: -8,
    recessedSupportUndersideY: null,
  };
  const ghost = carriedMesh.clone();
  bc.carry = {
    source: "pile",
    elementId: "long_plate",
    mesh: carriedMesh,
    ghost,
    localBox: carriedBox.clone(),
    ghostBox: carriedBox.clone(),
    spinAngle: 0,
    quaternion: new THREE.Quaternion(),
    surfaceNormal: new THREE.Vector3(0, 1, 0),
    manualTiltApplied: false,
    activeMechKind: null,
    manualOffsetX: 0,
    manualOffsetY: 0,
    manualOffsetZ: 0,
    parityOffsetX: 0,
    parityOffsetZ: 0,
    isColliding: false,
  };

  // 1. Apuntar parte alta de la pared frontal (y=36) apoya contra la pared cerca del cursor, sin caer al piso (y=8)
  bc._lastHit = {
    kind: "placed",
    object: wallMesh,
    point: new THREE.Vector3(0, 36, 10),
    normal: new THREE.Vector3(0, 0, 1),
  };
  bc._updateCarryTransform();
  assert.ok(ghost.position.y >= 24 && ghost.position.y <= 48, `Esperado cerca de y=36, obtuvo ${ghost.position.y}`);

  // 2. Apuntar en la mesa colisionando contra una pared de 24 LDU no permite encajarla encima del techo (y=32)
  wallMesh.position.set(0, 24, 0);
  bc.placedPieces[0].worldBox = new THREE.Box3(new THREE.Vector3(-20, 0, -10), new THREE.Vector3(20, 24, 10));
  bc.carry.lastValid = null;
  bc._lastHit = {
    kind: "table",
    object: null,
    point: new THREE.Vector3(0, 0, 20),
    normal: new THREE.Vector3(0, 1, 0),
  };
  bc._updateCarryTransform();
  assert.equal(bc.carry.isColliding, true, "Desde la mesa no debe auto-encastrar arriba de una pared de 24 LDU");
});

test("Peluca ancha con un único antiStud encastra en stud de cabeza minifig incluso al apuntar bordes o cara", () => {
  const bc = new BuildController(
    {
      camera: { position: new THREE.Vector3(60, 120, 160) },
      controls: { enablePan: true, enableRotate: true },
      onFrame() {},
    },
    {}
  );
  bc.pilePhysics = { isPointInAnyBag: () => false };

  const headBox = new THREE.Box3(new THREE.Vector3(-13, -24, -13), new THREE.Vector3(13, 4, 13));
  const headMesh = new THREE.Mesh(new THREE.BoxGeometry(26, 28, 26), new THREE.MeshBasicMaterial());
  headMesh.position.set(0, 24, 0);
  headMesh.userData = {
    collisionBoxes: [new THREE.Box3(new THREE.Vector3(-13, -24, -13), new THREE.Vector3(13, 0, 13))],
    topStuds: [{ pos: new THREE.Vector3(0, 0, 0), up: new THREE.Vector3(0, 1, 0), height: 4 }],
    connectors: [{ kind: "minifig_neck", role: "socket", pos: new THREE.Vector3(0, -24, 0) }],
    bottomReceptors: [new THREE.Vector3(0, -24, 0)],
    recessedReceptors: [],
    defaultSupportUndersideY: -24,
    recessedSupportUndersideY: null,
  };
  headMesh.updateMatrixWorld(true);
  bc.placedPieces = [
    {
      instanceId: "head",
      mesh: headMesh,
      localBox: headBox,
      worldBox: new THREE.Box3(new THREE.Vector3(-13, 0, -13), new THREE.Vector3(13, 28, 13)),
    },
  ];

  // Peluca ancha (> 22 LDU) cuyo único receptor inferior está en (0, 0, 0)
  const wigBox = new THREE.Box3(new THREE.Vector3(-21, -23, -25), new THREE.Vector3(21, 9, 9));
  const wigMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
  wigMesh.userData = {
    collisionBoxes: [new THREE.Box3(new THREE.Vector3(-4, 2, -4), new THREE.Vector3(4, 9, 4))],
    topStuds: [],
    antiStuds: [{ pos: new THREE.Vector3(0, 0, 0), dir: new THREE.Vector3(0, -1, 0) }],
    bottomReceptors: [new THREE.Vector3(0, 0, 0)],
    recessedReceptors: [],
    defaultSupportUndersideY: 0,
    recessedSupportUndersideY: null,
  };
  const ghost = wigMesh.clone();
  bc.carry = {
    source: "pile",
    elementId: "wig_21269",
    mesh: wigMesh,
    ghost,
    localBox: wigBox.clone(),
    ghostBox: wigBox.clone(),
    spinAngle: 0,
    quaternion: new THREE.Quaternion(),
    surfaceNormal: new THREE.Vector3(0, 1, 0),
    manualTiltApplied: false,
    activeMechKind: null,
    manualOffsetX: 0,
    manualOffsetY: 0,
    manualOffsetZ: 0,
    parityOffsetX: 0,
    parityOffsetZ: 0,
    isColliding: false,
  };

  // Borde superior curvo (x=-10.6) y costado inclinado (z=10.8): ambos deben centrar en (0, 24, 0)
  for (const [point, normal] of [
    [new THREE.Vector3(-10.6, 23.2, -1.4), new THREE.Vector3(-0.47, 0.88, -0.09)],
    [new THREE.Vector3(-5.3, 22.1, 10.8), new THREE.Vector3(-0.43, 0.63, 0.64)],
  ]) {
    bc.carry.lastValid = null;
    bc._lastHit = { kind: "placed", object: headMesh, point, normal };
    bc._updateCarryTransform();
    assert.equal(bc.carry.isColliding, false);
    assert.ok(ghost.position.distanceTo(new THREE.Vector3(0, 24, 0)) < 0.05, `Esperado (0,24,0), obtuvo ${ghost.position.toArray()}`);
  }
});

test("setCustomBoxCount reparte piezas equitativamente entre K cajas y restaura las bolsas por defecto", () => {
  const layouts = [];
  const bc = new BuildController(
    {
      camera: { position: new THREE.Vector3(0, 120, 220) },
      controls: { enablePan: true, enableRotate: true },
      onFrame() {},
      applyTableLayout(layout) { layouts.push(layout); },
      syncPileTransform() {},
      setSelectionBox() {},
    },
    {}
  );

  bc.manifest = {
    set_number: "test",
    bags: [
      { bag_number: 1, label: "Bolsa 1", piece_count: 2 },
      { bag_number: 2, label: "Bolsa 2", piece_count: 8 },
    ],
    parts: [
      { element_id: "a", quantity: 2, bag_counts: { "1": 2 } },
      { element_id: "b", quantity: 8, bag_counts: { "2": 8 } },
    ],
  };
  bc.effectiveManifest = bc.manifest;
  bc.partsByElementId.set("a", bc.manifest.parts[0]);
  bc.partsByElementId.set("b", bc.manifest.parts[1]);
  bc._partOrderMap.set("a", 0);
  bc._partOrderMap.set("b", 1);

  const box = new THREE.Box3(new THREE.Vector3(-10, -8, -10), new THREE.Vector3(10, 0, 10));
  for (let i = 0; i < 10; i += 1) {
    const eid = i < 2 ? "a" : "b";
    const origBag = i < 2 ? 1 : 2;
    const m = new THREE.Mesh(new THREE.BoxGeometry(20, 8, 20), new THREE.MeshBasicMaterial());
    m.userData = { bagNumber: origBag, origBagNumber: origBag };
    bc.pilePhysics.addPiece(`pile_${i}`, eid, m, box, { x: -200, y: 20, z: 0 }, false, origBag, origBag);
  }

  // Dividir en 4 cajas balanceadas: 10 / 4 -> [3, 3, 2, 2]
  assert.equal(bc.setCustomBoxCount(4), true);
  assert.equal(bc.getEffectiveBoxCount(), 4);
  assert.equal(bc.tableLayout.bagZones.length, 4);
  const counts4 = bc.getEffectiveManifest().bags.map((b) => b.piece_count);
  assert.deepEqual(counts4, [3, 3, 2, 2]);
  assert.equal(bc.exportWorldSnapshot().customBoxCount, 4);

  // Restaurar por defecto: vuelve a las 2 bolsas originales (2 y 8)
  assert.equal(bc.setCustomBoxCount(null), true);
  assert.equal(bc.customBoxCount, null);
  assert.equal(bc.getEffectiveBoxCount(), 2);
  assert.equal(bc.tableLayout.bagZones.length, 2);
  const origCounts = bc.pilePhysics.items.reduce(
    (acc, it) => {
      acc[it.bagNumber] = (acc[it.bagNumber] || 0) + 1;
      return acc;
    },
    {}
  );
  assert.deepEqual(origCounts, { 1: 2, 2: 8 });
  assert.equal(bc.exportWorldSnapshot().customBoxCount, null);
});

test("_buildGroupCompositeData propaga antiStuds y todos los conectores transformados", () => {
  const bc = new BuildController({ camera: new THREE.PerspectiveCamera(), onFrame() {} }, {});
  const box = new THREE.Box3(new THREE.Vector3(-10, -8, -10), new THREE.Vector3(10, 0, 10));

  const meshA = new THREE.Group();
  meshA.position.set(10, 8, 0);
  meshA.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  meshA.userData = {
    collisionBoxes: [box.clone()],
    topStuds: [],
    antiStuds: [{ pos: new THREE.Vector3(0, -4, 0), dir: new THREE.Vector3(0, -1, 0) }],
    bottomReceptors: [new THREE.Vector3(0, -8, 0)],
    recessedReceptors: [],
    pinHoles: [],
    pinConnectors: [],
    pinBarrels: [],
    connectors: [
      {
        kind: "bar",
        role: "plug",
        pos: new THREE.Vector3(6, 0, 0),
        barMidPos: new THREE.Vector3(10, 0, 0),
        dir: new THREE.Vector3(1, 0, 0),
      },
    ],
  };

  const meshB = new THREE.Group();
  meshB.position.set(30, 8, 0);
  meshB.userData = {
    collisionBoxes: [box.clone()],
    topStuds: [],
    antiStuds: [{ pos: new THREE.Vector3(0, -4, 0), dir: new THREE.Vector3(0, -1, 0) }],
    bottomReceptors: [new THREE.Vector3(0, -8, 0)],
    recessedReceptors: [],
    pinHoles: [],
    pinConnectors: [],
    pinBarrels: [],
    connectors: [],
  };

  const wbA = new THREE.Box3(new THREE.Vector3(0, 0, -10), new THREE.Vector3(20, 8, 10));
  const wbB = new THREE.Box3(new THREE.Vector3(20, 0, -10), new THREE.Vector3(40, 8, 10));
  const comp = bc._buildGroupCompositeData([
    { mesh: meshA, localBox: box.clone(), worldBox: wbA },
    { mesh: meshB, localBox: box.clone(), worldBox: wbB },
  ]);
  assert.equal(comp.compositeAntiStuds.length, 2, "Debe heredar antiStuds de todas las piezas del grupo");
  assert.ok(comp.compositeAntiStuds[1].pos.distanceTo(new THREE.Vector3(20, -4, 0)) < 1e-4);
  assert.equal(comp.compositeConnectors.length, 1);
  assert.ok(comp.compositeConnectors[0].barMidPos.distanceTo(new THREE.Vector3(0, 0, -10)) < 1e-4);
});

test("computePaginationWindow pagina en bloques de 60 y desliza ventana de 6 usando el extremo superior", () => {
  // Menos de 60 sets -> página 1 única centrada sin flechas
  const single = computePaginationWindow(1, 37);
  assert.equal(single.totalPages, 1);
  assert.deepEqual(single.pages, [1]);
  assert.equal(single.showArrows, false);
  assert.equal(single.startIndex, 0);
  assert.equal(single.endIndex, 37);

  // 167 sets -> 3 páginas (60, 60, 47) con flechas
  const p3 = computePaginationWindow(3, 167);
  assert.equal(p3.totalPages, 3);
  assert.deepEqual(p3.pages, [1, 2, 3]);
  assert.equal(p3.showArrows, true);
  assert.equal(p3.endIndex - p3.startIndex, 47);

  // Catálogo grande (>= 10 páginas): página 3 -> [1..6], página 8 -> [3..8]
  const win3 = computePaginationWindow(3, 600);
  assert.deepEqual(win3.pages, [1, 2, 3, 4, 5, 6]);
  assert.equal(win3.currentPage, 3);

  const win8 = computePaginationWindow(8, 600);
  assert.deepEqual(win8.pages, [3, 4, 5, 6, 7, 8]);
  assert.equal(win8.currentPage, 8);
});
