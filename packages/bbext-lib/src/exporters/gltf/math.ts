import type { Vec3 } from "../../types";
import { SAMPLE_EPSILON } from "./constants";

export function computePositionMinMax(positions: number[]): { min: [number, number, number]; max: [number, number, number] } {
  if (positions.length === 0) {
    return {
      min: [0, 0, 0],
      max: [0, 0, 0],
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

export function computeNormal(p0: Vec3, p1: Vec3, p2: Vec3): Vec3 {
  const ax = p1[0] - p0[0];
  const ay = p1[1] - p0[1];
  const az = p1[2] - p0[2];
  const bx = p2[0] - p0[0];
  const by = p2[1] - p0[1];
  const bz = p2[2] - p0[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return [0, 1, 0];
  const clean = (value: number): number => (Object.is(value, -0) ? 0 : value);
  return [clean(nx / len), clean(ny / len), clean(nz / len)];
}

export function degreesToQuatXYZ(deg: Vec3): [number, number, number, number] {
  const x = (deg[0] * Math.PI) / 180;
  const y = (deg[1] * Math.PI) / 180;
  const z = (deg[2] * Math.PI) / 180;

  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);

  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

export function vec3Equals(a: Vec3, b: Vec3, epsilon = SAMPLE_EPSILON): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon && Math.abs(a[2] - b[2]) <= epsilon;
}

export function quatEquals(a: [number, number, number, number], b: [number, number, number, number], epsilon = SAMPLE_EPSILON): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon
    && Math.abs(a[1] - b[1]) <= epsilon
    && Math.abs(a[2] - b[2]) <= epsilon
    && Math.abs(a[3] - b[3]) <= epsilon;
}

export function vec3IsZero(vec: Vec3, epsilon = SAMPLE_EPSILON): boolean {
  return Math.abs(vec[0]) <= epsilon && Math.abs(vec[1]) <= epsilon && Math.abs(vec[2]) <= epsilon;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
  ];
}

export function catmullRomValue(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1)
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

export function catmullRomVec3(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  return [
    catmullRomValue(p0[0], p1[0], p2[0], p3[0], t),
    catmullRomValue(p0[1], p1[1], p2[1], p3[1], t),
    catmullRomValue(p0[2], p1[2], p2[2], p3[2], t),
  ];
}

export function vec3DistanceSquared(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

export function quaternionToMatrix(quaternion: [number, number, number, number]): number[] {
  const [x, y, z, w] = quaternion;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

export function composeMatrix(translation: Vec3, rotation: Vec3): number[] {
  const matrix = quaternionToMatrix(degreesToQuatXYZ(rotation));
  matrix[12] = translation[0];
  matrix[13] = translation[1];
  matrix[14] = translation[2];
  return matrix;
}

export function multiplyMatrices(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[col + row * 4] =
        a[row * 4] * b[col]
        + a[row * 4 + 1] * b[col + 4]
        + a[row * 4 + 2] * b[col + 8]
        + a[row * 4 + 3] * b[col + 12];
    }
  }
  return out;
}

export function invertTrsMatrix(matrix: number[]): number[] {
  const r00 = matrix[0];
  const r01 = matrix[1];
  const r02 = matrix[2];
  const r10 = matrix[4];
  const r11 = matrix[5];
  const r12 = matrix[6];
  const r20 = matrix[8];
  const r21 = matrix[9];
  const r22 = matrix[10];
  const tx = matrix[12];
  const ty = matrix[13];
  const tz = matrix[14];

  return [
    r00, r10, r20, 0,
    r01, r11, r21, 0,
    r02, r12, r22, 0,
    -(r00 * tx + r10 * ty + r20 * tz),
    -(r01 * tx + r11 * ty + r21 * tz),
    -(r02 * tx + r12 * ty + r22 * tz),
    1,
  ];
}

export function translationBetween(parentOrigin: Vec3 | undefined, childOrigin: Vec3 | undefined, scale: number): Vec3 {
  const parent = parentOrigin ?? [0, 0, 0];
  const child = childOrigin ?? [0, 0, 0];
  return [
    (child[0] - parent[0]) * scale,
    (child[1] - parent[1]) * scale,
    (child[2] - parent[2]) * scale,
  ];
}
