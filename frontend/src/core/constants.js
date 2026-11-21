/**
 * Constantes oficiales del sistema de unidades LDraw (LDU) y configuración de la mesa.
 * 1 stud = 20 LDU | 1 plate = 8 LDU | 1 brick = 24 LDU (3 plates).
 */
export const LDU_STUD = 20;
export const LDU_HALF_STUD = 10;
export const LDU_PLATE = 8;
export const LDU_HALF_PLATE = 4;

export const PILE_ZONE = {
  minX: -660,
  maxX: -180,
  minZ: -360,
  maxZ: 360,
  centerX: -420,
};

export const ROTATION_STEP_90 = Math.PI / 2;
export const ROTATION_STEP_15 = Math.PI / 12;

export const ROTATE_DRAG_THRESHOLD_PX = 88;
export const CAMERA_WASD_SPEED = 460; // LDU por segundo

export const PILE_BATCH_SIZE = 150;
export const LIGHTWEIGHT_RENDER_THRESHOLD = 400;
export const MAX_SUPPORTED_PIECES = 3500;
