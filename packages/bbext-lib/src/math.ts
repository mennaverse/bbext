import type { Vec3 } from "./types";

const DEG_TO_RAD = Math.PI / 180;

export function rotateAround(point: Vec3, origin: Vec3, rotation: Vec3): Vec3 {
  const [ox, oy, oz] = origin;
  const translated: Vec3 = [point[0] - ox, point[1] - oy, point[2] - oz];

  const rx = rotation[0] * DEG_TO_RAD;
  const ry = rotation[1] * DEG_TO_RAD;
  const rz = rotation[2] * DEG_TO_RAD;

  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  // Blockbench rotations are Euler angles; X -> Y -> Z order is a practical default.
  const x1 = translated[0];
  const y1 = translated[1] * cx - translated[2] * sx;
  const z1 = translated[1] * sx + translated[2] * cx;

  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;

  const x3 = x2 * cz - y2 * sz;
  const y3 = x2 * sz + y2 * cz;
  const z3 = z2;

  return [x3 + ox, y3 + oy, z3 + oz];
}

export function applyTransforms(point: Vec3, transforms: { origin: Vec3; rotation: Vec3 }[]): Vec3 {
  let current: Vec3 = [point[0], point[1], point[2]];
  for (const transform of transforms) {
    current = rotateAround(current, transform.origin, transform.rotation);
  }
  return current;
}

export function scalePoint(point: Vec3, scalar: number): Vec3 {
  return [point[0] * scalar, point[1] * scalar, point[2] * scalar];
}
