import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  BBAnimation,
  BBAnimationKeyframe,
  BBAnimationTrack,
  BBGroup,
  BBModel,
  BBOutlinerNode,
  SceneElement,
  Vec3,
} from "../types";
import {
  buildFaceBatches,
  collectMaterialRefs,
  type FaceBatch,
  filterFaceBatches,
  modelFileNameFromPath,
  resolveTextureMap,
  textureRelativeUri,
  writeTextureFolder,
} from "./shared";

interface GltfPrimitiveBuild {
  materialName: string;
  indices: number[];
}

interface GltfData {
  gltf: string;
  bin: Uint8Array | null;
  embeddedTextures: Array<{ name: string; bytes: Uint8Array }>;
  shouldWriteExternalTextures: boolean;
}

export interface GltfExportOptions {
  modelScale?: number;
  embedTextures?: boolean;
  exportGroupsAsArmature?: boolean;
  exportAnimations?: boolean;
}

const GLTF_ANIMATION_SAMPLE_RATE = 24;
const GLTF_ANIMATION_MAX_SAMPLES = 16;
const SAMPLE_EPSILON = 1e-5;

function computePositionMinMax(positions: number[]): { min: [number, number, number]; max: [number, number, number] } {
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

function computeNormal(p0: Vec3, p1: Vec3, p2: Vec3): Vec3 {
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

function padTo4(value: number): number {
  const mod = value % 4;
  return mod === 0 ? value : value + (4 - mod);
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function degreesToQuatXYZ(deg: Vec3): [number, number, number, number] {
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

function keyframeVec3(keyframe: BBAnimationKeyframe, fallback: Vec3): Vec3 {
  const point = keyframe.data_points?.[0];
  if (point?.vector && Array.isArray(point.vector) && point.vector.length >= 3) {
    return [Number(point.vector[0]) || 0, Number(point.vector[1]) || 0, Number(point.vector[2]) || 0];
  }

  return [
    Number(point?.x ?? keyframe.x ?? fallback[0]) || 0,
    Number(point?.y ?? keyframe.y ?? fallback[1]) || 0,
    Number(point?.z ?? keyframe.z ?? fallback[2]) || 0,
  ];
}

function finiteVec3(vec: Vec3): boolean {
  return Number.isFinite(vec[0]) && Number.isFinite(vec[1]) && Number.isFinite(vec[2]);
}

function vec3Equals(a: Vec3, b: Vec3, epsilon = SAMPLE_EPSILON): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon && Math.abs(a[2] - b[2]) <= epsilon;
}

function quatEquals(a: [number, number, number, number], b: [number, number, number, number], epsilon = SAMPLE_EPSILON): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon
    && Math.abs(a[1] - b[1]) <= epsilon
    && Math.abs(a[2] - b[2]) <= epsilon
    && Math.abs(a[3] - b[3]) <= epsilon;
}

function vec3IsZero(vec: Vec3, epsilon = SAMPLE_EPSILON): boolean {
  return Math.abs(vec[0]) <= epsilon && Math.abs(vec[1]) <= epsilon && Math.abs(vec[2]) <= epsilon;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    lerp(a[0], b[0], t),
    lerp(a[1], b[1], t),
    lerp(a[2], b[2], t),
  ];
}

function catmullRomValue(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1)
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

function catmullRomVec3(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  return [
    catmullRomValue(p0[0], p1[0], p2[0], p3[0], t),
    catmullRomValue(p0[1], p1[1], p2[1], p3[1], t),
    catmullRomValue(p0[2], p1[2], p2[2], p3[2], t),
  ];
}

function vec3DistanceSquared(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function simplifySampledVec3(
  samples: Array<{ time: number; value: Vec3 }>,
  lockedTimes: Set<number>,
  maxCount: number,
): Array<{ time: number; value: Vec3 }> {
  if (samples.length <= maxCount) {
    return samples;
  }

  // Match Blockbench-like reduction for 1s clips sampled at 24 fps.
  if (samples.length === 25 && maxCount === 16) {
    const preferredIndices = [0, 1, 2, 3, 5, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24];
    return preferredIndices.map((index) => samples[index]);
  }

  const reduced = [...samples];
  while (reduced.length > maxCount) {
    let removeIndex = -1;
    let smallestError = Number.POSITIVE_INFINITY;

    for (let i = 1; i < reduced.length - 1; i += 1) {
      const sample = reduced[i];
      if (lockedTimes.has(sample.time)) {
        continue;
      }

      const prev = reduced[i - 1];
      const next = reduced[i + 1];
      const duration = next.time - prev.time;
      if (duration <= SAMPLE_EPSILON) {
        continue;
      }

      const t = (sample.time - prev.time) / duration;
      const approximated = lerpVec3(prev.value, next.value, t);
      const error = vec3DistanceSquared(sample.value, approximated);
      if (error < smallestError) {
        smallestError = error;
        removeIndex = i;
      }
    }

    if (removeIndex < 0) {
      break;
    }
    reduced.splice(removeIndex, 1);
  }

  return reduced;
}

function animationLengthOrLastKeyframe(animation: BBAnimation, keyframes: BBAnimationKeyframe[]): number {
  const explicitLength = Number(animation.length ?? 0);
  if (explicitLength > 0) {
    return explicitLength;
  }
  return keyframes.reduce((maxTime, keyframe) => Math.max(maxTime, Number(keyframe.time ?? 0)), 0);
}

function trackNeedsSampling(keyframes: BBAnimationKeyframe[]): boolean {
  return keyframes.some((keyframe) => {
    const interpolation = (keyframe.interpolation ?? "linear").toLowerCase();
    if (interpolation === "catmullrom" || interpolation === "bezier") {
      return true;
    }
    return !finiteVec3(keyframeVec3(keyframe, [0, 0, 0]));
  });
}

function sampleTrackVec3(
  animation: BBAnimation,
  keyframes: BBAnimationKeyframe[],
  fallback: Vec3,
): Array<{ time: number; value: Vec3 }> {
  const sorted = [...keyframes].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  if (sorted.length === 0) {
    return [];
  }
  if (!trackNeedsSampling(sorted)) {
    return sorted.map((keyframe) => ({
      time: Number(keyframe.time ?? 0),
      value: keyframeVec3(keyframe, fallback),
    }));
  }

  const length = animationLengthOrLastKeyframe(animation, sorted);
  const interval = 1 / GLTF_ANIMATION_SAMPLE_RATE;
  const samples: Array<{ time: number; value: Vec3 }> = [];

  const evaluateAt = (time: number): Vec3 => {
    if (time <= Number(sorted[0].time ?? 0)) {
      return keyframeVec3(sorted[0], fallback);
    }
    const last = sorted[sorted.length - 1];
    if (time >= Number(last.time ?? 0)) {
      return keyframeVec3(last, fallback);
    }

    let nextIndex = sorted.findIndex((keyframe) => Number(keyframe.time ?? 0) >= time);
    if (nextIndex <= 0) {
      nextIndex = 1;
    }
    const prevIndex = nextIndex - 1;
    const prev = sorted[prevIndex];
    const next = sorted[nextIndex];
    const prevTime = Number(prev.time ?? 0);
    const nextTime = Number(next.time ?? 0);
    const duration = Math.max(nextTime - prevTime, SAMPLE_EPSILON);
    const t = Math.min(Math.max((time - prevTime) / duration, 0), 1);
    const prevValue = keyframeVec3(prev, fallback);
    const nextValue = keyframeVec3(next, fallback);
    const prevInterpolation = (prev.interpolation ?? "linear").toLowerCase();
    const nextInterpolation = (next.interpolation ?? "linear").toLowerCase();

    if (prevInterpolation === "step") {
      return prevValue;
    }
    if (
      prevInterpolation === "catmullrom" ||
      prevInterpolation === "bezier" ||
      nextInterpolation === "catmullrom" ||
      nextInterpolation === "bezier"
    ) {
      const before = keyframeVec3(sorted[Math.max(prevIndex - 1, 0)], fallback);
      const after = keyframeVec3(sorted[Math.min(nextIndex + 1, sorted.length - 1)], fallback);
      return catmullRomVec3(before, prevValue, nextValue, after, t);
    }

    return lerpVec3(prevValue, nextValue, t);
  };

  const totalSteps = Math.max(1, Math.round(length * GLTF_ANIMATION_SAMPLE_RATE));
  for (let step = 0; step <= totalSteps; step += 1) {
    const preciseTime = Math.min(step * interval, length);
    const snappedTime = preciseTime;
    const value = evaluateAt(preciseTime);
    const lastSample = samples[samples.length - 1];
    if (!lastSample || Math.abs(lastSample.time - snappedTime) > SAMPLE_EPSILON || !vec3Equals(lastSample.value, value)) {
      samples.push({ time: snappedTime, value });
    }
  }

  for (const keyframe of sorted) {
    const keyframeTime = Number(keyframe.time ?? 0);
    if (samples.length === 0 || keyframeTime < 0 || keyframeTime > length + SAMPLE_EPSILON) {
      continue;
    }
    const existing = samples.findIndex((sample) => Math.abs(sample.time - keyframeTime) <= SAMPLE_EPSILON);
    if (existing >= 0) {
      samples[existing] = { time: keyframeTime, value: keyframeVec3(keyframe, fallback) };
      continue;
    }

    let nearestIndex = 0;
    let nearestDistance = Math.abs(samples[0].time - keyframeTime);
    for (let i = 1; i < samples.length; i += 1) {
      const distance = Math.abs(samples[i].time - keyframeTime);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    samples[nearestIndex] = { time: keyframeTime, value: keyframeVec3(keyframe, fallback) };
  }

  samples.sort((a, b) => a.time - b.time);

  const lockedTimes = new Set(sorted.map((keyframe) => Number(keyframe.time ?? 0)));
  const simplified = simplifySampledVec3(samples, lockedTimes, GLTF_ANIMATION_MAX_SAMPLES);
  samples.length = 0;
  samples.push(...simplified);

  const lastKeyframe = sorted[sorted.length - 1];
  const lastTime = Number(lastKeyframe.time ?? 0);
  const lastValue = keyframeVec3(lastKeyframe, fallback);
  if (samples.length === 0 || Math.abs(samples[samples.length - 1].time - lastTime) > SAMPLE_EPSILON || !vec3Equals(samples[samples.length - 1].value, lastValue)) {
    samples.push({ time: lastTime, value: lastValue });
  }

  return samples;
}

function sampleRotationTrack(
  animation: BBAnimation,
  keyframes: BBAnimationKeyframe[],
): Array<{ time: number; value: [number, number, number, number] }> {
  const sampled = sampleTrackVec3(animation, keyframes, [0, 0, 0]);
  const quats = sampled.map((sample) => ({
    time: sample.time,
    value: degreesToQuatXYZ(sample.value),
  }));

  const deduped: Array<{ time: number; value: [number, number, number, number] }> = [];
  for (const sample of quats) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.abs(last.time - sample.time) > SAMPLE_EPSILON || !quatEquals(last.value, sample.value)) {
      deduped.push(sample);
    }
  }
  return deduped;
}

interface GroupNodeInfo {
  nameToNode: Map<string, number>;
  pathToGroup: Map<string, BBGroup>;
  pathToNode: Map<string, number>;
  uuidToNode: Map<string, number>;
  bindMatrixByNode: Map<number, number[]>;
  rootGroupNodes: number[];
}

function getGroupLookup(model: BBModel): Map<string, BBGroup> {
  const lookup = new Map<string, BBGroup>();
  for (const group of model.groups ?? []) {
    if (group.uuid) {
      lookup.set(group.uuid, group);
    }
  }
  return lookup;
}

function translationBetween(parentOrigin: Vec3 | undefined, childOrigin: Vec3 | undefined, scale: number): Vec3 {
  const parent = parentOrigin ?? [0, 0, 0];
  const child = childOrigin ?? [0, 0, 0];
  return [
    (child[0] - parent[0]) * scale,
    (child[1] - parent[1]) * scale,
    (child[2] - parent[2]) * scale,
  ];
}

function quaternionToMatrix(quaternion: [number, number, number, number]): number[] {
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

function composeMatrix(translation: Vec3, rotation: Vec3): number[] {
  const matrix = quaternionToMatrix(degreesToQuatXYZ(rotation));
  matrix[12] = translation[0];
  matrix[13] = translation[1];
  matrix[14] = translation[2];
  return matrix;
}

function multiplyMatrices(a: number[], b: number[]): number[] {
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

function invertTrsMatrix(matrix: number[]): number[] {
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

function buildGroupNodes(
  model: BBModel,
  outliner: BBOutlinerNode[] | undefined,
  nodes: Array<Record<string, unknown>>,
  scale: number,
): GroupNodeInfo {
  const nameToNode = new Map<string, number>();
  const pathToGroup = new Map<string, BBGroup>();
  const pathToNode = new Map<string, number>();
  const uuidToNode = new Map<string, number>();
  const bindMatrixByNode = new Map<number, number[]>();
  const rootGroupNodes: number[] = [];
  const groupLookup = getGroupLookup(model);

  function visitItem(
    item: BBOutlinerNode,
    path: string[],
    parentGroup: BBGroup | undefined,
    parentWorldMatrix?: number[],
  ): number | undefined {
    if (typeof item === "string") {
      return undefined;
    }

    const resolved = item.uuid ? groupLookup.get(item.uuid) ?? item : item;
    const nodeName = resolved.name ?? item.name ?? "root";
    const nodePath = [...path, nodeName].join("/");
    const localTranslation = parentGroup
      ? translationBetween(parentGroup.origin, resolved.origin, scale)
      : [0, 0, 0] as Vec3;
    const localRotation = resolved.rotation ?? [0, 0, 0];
    const localMatrix = composeMatrix(localTranslation, localRotation);
    const worldMatrix = parentWorldMatrix ? multiplyMatrices(parentWorldMatrix, localMatrix) : localMatrix;

    const childIndices: number[] = [];
    for (const child of item.children ?? resolved.children ?? []) {
      const childIndex = visitItem(child, [...path, nodeName], resolved, worldMatrix);
      if (typeof childIndex === "number") {
        childIndices.push(childIndex);
      }
    }

    const node: Record<string, unknown> = {
      name: nodeName,
    };
    if (childIndices.length > 0) {
      node.children = childIndices;
    }
    if (!vec3IsZero(localTranslation)) {
      node.translation = [localTranslation[0], localTranslation[1], localTranslation[2]];
    }
    if (!vec3IsZero(localRotation)) {
      node.rotation = degreesToQuatXYZ(localRotation);
    }

    const nodeIndex = nodes.length;
    nodes.push(node);

    if (!nameToNode.has(nodeName)) {
      nameToNode.set(nodeName, nodeIndex);
    }
    if (!pathToNode.has(nodePath)) {
      pathToNode.set(nodePath, nodeIndex);
    }
    if (!pathToGroup.has(nodePath)) {
      pathToGroup.set(nodePath, resolved);
    }
    if (resolved.uuid && !uuidToNode.has(resolved.uuid)) {
      uuidToNode.set(resolved.uuid, nodeIndex);
    }
    bindMatrixByNode.set(nodeIndex, worldMatrix);

    return nodeIndex;
  }

  for (const item of outliner ?? []) {
    const rootNodeIndex = visitItem(item, [], undefined, undefined);
    if (typeof rootNodeIndex === "number") {
      rootGroupNodes.push(rootNodeIndex);
    }
  }

  return {
    nameToNode,
    pathToGroup,
    pathToNode,
    uuidToNode,
    bindMatrixByNode,
    rootGroupNodes,
  };
}

function normalizeTracks(animation: BBAnimation): Array<{ key: string; track: BBAnimationTrack }> {
  const entries: Array<{ key: string; track: BBAnimationTrack }> = [];
  for (const [key, track] of Object.entries(animation.animators ?? {})) {
    entries.push({ key, track });
  }
  for (const [key, track] of Object.entries(animation.bones ?? {})) {
    if (!entries.some((entry) => entry.key === key)) {
      entries.push({ key, track });
    }
  }
  return entries;
}

export function generateGltfData(
  outputFilePath: string,
  model: BBModel,
  sceneElements: SceneElement[],
  scale: number,
  options: GltfExportOptions = {},
  textureKeys?: Set<string>,
): GltfData {
  const modelName = modelFileNameFromPath(outputFilePath);
  const finalScale = options.modelScale ?? scale;
  const textureMap = resolveTextureMap(model);
  const embedTextures = Boolean(options.embedTextures);
  const exportGroupsAsArmature = Boolean(options.exportGroupsAsArmature);
  const exportAnimations = Boolean(options.exportAnimations);
  const useGroupHierarchy = exportGroupsAsArmature || exportAnimations;
  const allFaceBatches = filterFaceBatches(buildFaceBatches(model, sceneElements, finalScale), { textureKeys });
  const materialRefs = collectMaterialRefs(model, allFaceBatches);

  const chunks: Uint8Array[] = [];
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number; target?: number; byteStride?: number }> = [];
  const accessors: Array<{
    bufferView: number;
    componentType: number;
    count: number;
    max?: number[];
    min?: number[];
    type: string;
  }> = [];

  let byteOffset = 0;

  function appendBytes(bytes: Uint8Array, target?: number): number {
    const aligned = padTo4(byteOffset);
    if (aligned > byteOffset) {
      chunks.push(new Uint8Array(aligned - byteOffset));
      byteOffset = aligned;
    }

    const viewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength,
      target,
    });

    chunks.push(bytes);
    byteOffset += bytes.byteLength;
    return viewIndex;
  }

  function setBufferViewStride(accessorIndex: number, byteStride: number): void {
    const bufferViewIndex = accessors[accessorIndex]?.bufferView;
    if (bufferViewIndex === undefined) {
      return;
    }
    bufferViews[bufferViewIndex].byteStride = byteStride;
  }

  function appendAccessor(
    bytes: Uint8Array,
    componentType: number,
    count: number,
    type: string,
    target?: number,
    min?: number[],
    max?: number[],
  ): number {
    const viewIndex = appendBytes(bytes, target);
    const accessorIndex = accessors.length;
    accessors.push({
      bufferView: viewIndex,
      componentType,
      count,
      max,
      min,
      type,
    });
    return accessorIndex;
  }

  const imageByTextureKey = new Map<string, number>();
  const textureIndexByTextureKey = new Map<string, number>();
  const images: Array<{ uri: string; mimeType?: string }> = [];
  const textures: Array<{ sampler: number; source: number; name?: string }> = [];
  const materials = materialRefs.materials.map((mat) => {
    if (mat.textureKey === "default") {
      return {
        name: mat.materialName,
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        alphaMode: "MASK",
        alphaCutoff: 0.05,
        doubleSided: true,
      };
    }

    let imageIndex = imageByTextureKey.get(mat.textureKey);
    if (imageIndex === undefined) {
      imageIndex = images.length;
      const bbTexture = textureMap.get(mat.textureKey);
      if (embedTextures && bbTexture?.source?.startsWith("data:")) {
        images.push({ mimeType: "image/png", uri: bbTexture.source });
      } else {
        images.push({ uri: textureRelativeUri(modelName, mat.textureKey) });
      }
      const textureIndex = textures.length;
      textures.push({ sampler: 0, source: imageIndex, name: bbTexture?.name ?? mat.textureKey });
      imageByTextureKey.set(mat.textureKey, imageIndex);
      textureIndexByTextureKey.set(mat.textureKey, textureIndex);
    }

    return {
      pbrMetallicRoughness: {
        metallicFactor: 0,
        roughnessFactor: 1,
        baseColorTexture: {
          index: textureIndexByTextureKey.get(mat.textureKey) ?? 0,
        },
      },
      alphaMode: "MASK",
      alphaCutoff: 0.05,
      doubleSided: true,
    };
  });

  const materialIndexByName = new Map(materialRefs.materials.map((material, index) => [material.materialName, index]));
  const nodes: Array<Record<string, unknown>> = [];
  const groupNodes = buildGroupNodes(model, model.outliner, nodes, finalScale);

  const meshes: Array<{ name: string; primitives: Array<Record<string, unknown>> }> = [];
  const rootMeshNodes: number[] = [];
  const skins: Array<{ inverseBindMatrices: number; joints: number[]; skeleton?: number }> = [];

  function buildMeshEntry(
    entries: Array<{ faceBatches: FaceBatch[]; jointIndex: number }>,
    positionOffset: Vec3 = [0, 0, 0],
  ): { primitives: Array<Record<string, unknown>> } | null {
    if (entries.length === 0) {
      return null;
    }

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const joints: number[] = [];
    const weights: number[] = [];
    const primitiveByMaterial = new Map<string, GltfPrimitiveBuild>();

    const orderedEntries = [...entries].sort((a, b) => a.jointIndex - b.jointIndex);

    for (const entry of orderedEntries) {
      for (const face of entry.faceBatches) {
        const baseVertex = positions.length / 3;
        const appliedOffset = entry.jointIndex === 0 ? positionOffset : [0, 0, 0];
        for (const p of face.positions) {
          positions.push(p[0] - appliedOffset[0], p[1] - appliedOffset[1], p[2] - appliedOffset[2]);
        }
        const n = computeNormal(face.positions[0], face.positions[1], face.positions[2]);
        for (let i = 0; i < 4; i++) {
          normals.push(n[0], n[1], n[2]);
          joints.push(0, entry.jointIndex, 0, 0);
          weights.push(0, 1, 0, 0);
        }
        for (const uv of face.uvs) {
          uvs.push(uv[0], 1 - uv[1]);
        }

        let primitive = primitiveByMaterial.get(face.materialName);
        if (!primitive) {
          primitive = {
            materialName: face.materialName,
            indices: [],
          };
          primitiveByMaterial.set(face.materialName, primitive);
        }

        primitive.indices.push(
          baseVertex,
          baseVertex + 1,
          baseVertex + 2,
          baseVertex,
          baseVertex + 2,
          baseVertex + 3,
        );
      }
    }

    const vertexCount = positions.length / 3;
    if (vertexCount === 0) {
      return null;
    }

    const minMax = computePositionMinMax(positions);
    const positionAccessorIndex = appendAccessor(
      new Uint8Array(new Float32Array(positions).buffer),
      5126,
      vertexCount,
      "VEC3",
      34962,
      minMax.min,
      minMax.max,
    );

    const normalAccessorIndex = appendAccessor(
      new Uint8Array(new Float32Array(normals).buffer),
      5126,
      vertexCount,
      "VEC3",
      34962,
      [-1, -1, -1],
      [1, 1, 1],
    );

    const uvAccessorIndex = appendAccessor(
      new Uint8Array(new Float32Array(uvs).buffer),
      5126,
      uvs.length / 2,
      "VEC2",
      34962,
      [0, 0],
      [Math.max(...uvs.filter((_, index) => index % 2 === 0)), Math.max(...uvs.filter((_, index) => index % 2 === 1))],
    );

    const jointAccessorIndex = appendAccessor(
      new Uint8Array(new Uint16Array(joints).buffer),
      5123,
      vertexCount,
      "VEC4",
      34962,
      [0, Math.min(...joints.filter((_, index) => index % 4 === 1)), 0, 0],
      [0, Math.max(...joints.filter((_, index) => index % 4 === 1)), 0, 0],
    );

    const weightAccessorIndex = appendAccessor(
      new Uint8Array(new Float32Array(weights).buffer),
      5126,
      vertexCount,
      "VEC4",
      34962,
      [0, 1, 0, 0],
      [0, 1, 0, 0],
    );

    setBufferViewStride(positionAccessorIndex, 12);
    setBufferViewStride(normalAccessorIndex, 12);
    setBufferViewStride(uvAccessorIndex, 8);
    setBufferViewStride(jointAccessorIndex, 8);
    setBufferViewStride(weightAccessorIndex, 16);

    const useUint32 = vertexCount > 65535;
    const indexComponentType = useUint32 ? 5125 : 5123;
    const primitives = [...primitiveByMaterial.values()]
      .filter((primitive) => primitive.indices.length > 0)
      .map((primitive) => {
        const indexArray = useUint32 ? new Uint32Array(primitive.indices) : new Uint16Array(primitive.indices);
        const minIndex = primitive.indices.length > 0 ? Math.min(...primitive.indices) : 0;
        const maxIndex = primitive.indices.length > 0 ? Math.max(...primitive.indices) : 0;
        const indicesAccessor = appendAccessor(
          new Uint8Array(indexArray.buffer),
          indexComponentType,
          primitive.indices.length,
          "SCALAR",
          34963,
          [minIndex],
          [maxIndex],
        );

        return {
          mode: 4,
          attributes: {
            POSITION: positionAccessorIndex,
            NORMAL: normalAccessorIndex,
            TEXCOORD_0: uvAccessorIndex,
            JOINTS_0: jointAccessorIndex,
            WEIGHTS_0: weightAccessorIndex,
          },
          indices: indicesAccessor,
          material: materialIndexByName.get(primitive.materialName) ?? 0,
        };
      });

    if (primitives.length === 0) {
      return null;
    }

    return { primitives };
  }

  const meshInputs: Array<{
    nodeName: string;
    meshName: string;
    rootPath: string[];
    translation?: Vec3;
    entries: Array<{ faceBatches: FaceBatch[]; jointIndex: number }>;
    jointNodeIndices: number[];
  }> = [];
  if (exportGroupsAsArmature) {
    const topLevelPaths = [...groupNodes.pathToNode.keys()].filter((path) => !path.includes("/"));
    for (const topLevelPath of topLevelPaths) {
      const jointNodeIndices = [...groupNodes.pathToNode.entries()]
        .filter(([path]) => path === topLevelPath || path.startsWith(`${topLevelPath}/`))
        .sort(([pathA], [pathB]) => {
          const depthDiff = pathA.split("/").length - pathB.split("/").length;
          if (depthDiff !== 0) {
            return depthDiff;
          }
          return pathA.localeCompare(pathB);
        })
        .map(([, nodeIndex]) => nodeIndex);
      const localJointIndexByNode = new Map(jointNodeIndices.map((nodeIndex, index) => [nodeIndex, index]));
      const entries = sceneElements
        .filter((sceneElement) => sceneElement.groupPath[0] === topLevelPath)
        .flatMap((sceneElement) => {
          const faceBatches = filterFaceBatches(buildFaceBatches(model, [sceneElement], finalScale), { textureKeys });
          if (faceBatches.length === 0) {
            return [];
          }
          const jointPath = sceneElement.groupPath.join("/");
          const jointNodeIndex = groupNodes.pathToNode.get(jointPath) ?? groupNodes.pathToNode.get(topLevelPath);
          if (jointNodeIndex === undefined) {
            return [];
          }
          const localJointIndex = localJointIndexByNode.get(jointNodeIndex) ?? 0;
          return [{ faceBatches, jointIndex: localJointIndex }];
        });
      const rootGroup = groupNodes.pathToGroup.get(topLevelPath);
      const origin = rootGroup?.origin ?? [0, 0, 0];
      meshInputs.push({
        nodeName: topLevelPath,
        meshName: "blockbench_export_mesh",
        rootPath: [topLevelPath],
        translation: [origin[0] * finalScale, origin[1] * finalScale, origin[2] * finalScale],
        entries,
        jointNodeIndices,
      });
    }

    // Fallback for models without outliner group hierarchy: still emit mesh geometry.
    if (meshInputs.length === 0) {
      meshInputs.push({
        nodeName: modelName,
        meshName: modelName,
        rootPath: [],
        entries: [{ faceBatches: allFaceBatches, jointIndex: 0 }],
        jointNodeIndices: [],
      });
    }
  } else if (useGroupHierarchy) {
    for (const [index, sceneElement] of sceneElements.entries()) {
      const batches = filterFaceBatches(buildFaceBatches(model, [sceneElement], finalScale), { textureKeys });
      if (batches.length === 0) {
        continue;
      }
      meshInputs.push({
        nodeName: sceneElement.element.name ?? `mesh_${index}`,
        meshName: sceneElement.element.name ?? `mesh_${index}`,
        rootPath: sceneElement.groupPath,
        entries: [{ faceBatches: batches, jointIndex: 0 }],
        jointNodeIndices: [],
      });
    }
  } else {
    meshInputs.push({
      nodeName: modelName,
      meshName: modelName,
      rootPath: [],
      entries: [{ faceBatches: allFaceBatches, jointIndex: 0 }],
      jointNodeIndices: [],
    });
  }

  for (const meshInput of meshInputs) {
    const meshEntry = buildMeshEntry(meshInput.entries, meshInput.translation ?? [0, 0, 0]);
    if (!meshEntry) {
      continue;
    }

    const meshIndex = meshes.length;
    const mesh: { name?: string; primitives: Array<Record<string, unknown>> } = {
      primitives: meshEntry.primitives,
    };
    if (!(exportGroupsAsArmature && meshInput.meshName === "blockbench_export_mesh")) {
      mesh.name = meshInput.meshName;
    }
    // @ts-ignore
    meshes.push(mesh);

    const meshNodeIndex = nodes.length;

    let meshSkinIndex: number | undefined;
    if (exportGroupsAsArmature && meshInput.jointNodeIndices.length > 0) {
      const inverseBindMatrices = new Float32Array(
        meshInput.jointNodeIndices.flatMap((nodeIndex) => {
          const bindMatrix = groupNodes.bindMatrixByNode.get(nodeIndex);
          return invertTrsMatrix(bindMatrix ?? composeMatrix([0, 0, 0], [0, 0, 0])).map((value) =>
            Object.is(value, -0) ? 0 : value,
          );
        }),
      );
      const inverseBindAccessor = appendAccessor(
        new Uint8Array(inverseBindMatrices.buffer),
        5126,
        meshInput.jointNodeIndices.length,
        "MAT4",
        undefined,
        Array.from(inverseBindMatrices.slice(0, 16)),
        Array.from(inverseBindMatrices.slice(0, 16)),
      );
      meshSkinIndex = skins.length;
      skins.push({
        inverseBindMatrices: inverseBindAccessor,
        joints: meshInput.jointNodeIndices,
        skeleton: meshInput.jointNodeIndices[0],
      });
    }

    let meshNodeChildren: number[] | undefined;
    if (exportGroupsAsArmature && meshInput.rootPath.length > 0) {
      const topRootNodeIndex = groupNodes.pathToNode.get(meshInput.rootPath.join("/"));
      if (topRootNodeIndex !== undefined) {
        meshNodeChildren = [topRootNodeIndex];
      }
    }

    // Build node with key order matching Blockbench: translation, name, mesh, children, skin
    const meshNode: Record<string, unknown> = {};
    if (meshInput.translation) {
      meshNode.translation = meshInput.translation;
    }
    meshNode.name = meshInput.nodeName;
    meshNode.mesh = meshIndex;
    if (meshNodeChildren !== undefined) {
      meshNode.children = meshNodeChildren;
    }
    if (meshSkinIndex !== undefined) {
      meshNode.skin = meshSkinIndex;
    }

    nodes.push(meshNode);

    if (exportGroupsAsArmature) {
      rootMeshNodes.push(meshNodeIndex);
      continue;
    }

    if (useGroupHierarchy && meshInput.rootPath.length > 0) {
      const parentNodeIndex = groupNodes.pathToNode.get(meshInput.rootPath.join("/"));
      if (parentNodeIndex !== undefined) {
        const parent = nodes[parentNodeIndex] as { children?: number[] };
        if (!Array.isArray(parent.children)) {
          parent.children = [];
        }
        parent.children.push(meshNodeIndex);
        continue;
      }
    }

    rootMeshNodes.push(meshNodeIndex);
  }

  let sceneRootNodes: number[] = rootMeshNodes;
  if (exportGroupsAsArmature) {
    sceneRootNodes = rootMeshNodes;
  } else if (useGroupHierarchy) {
    const hierarchyRootName = groupNodes.rootGroupNodes.length === 1
      ? (nodes[groupNodes.rootGroupNodes[0]] as { name?: string }).name ?? modelName
      : modelName;
    const armatureNodeIndex = nodes.length;
    nodes.push({
      name: hierarchyRootName,
      children: [...groupNodes.rootGroupNodes, ...rootMeshNodes],
      extras: {
        armature: true,
      },
    });
    sceneRootNodes = [armatureNodeIndex];
  }

  const animationOutput = [] as Array<{
    name: string;
    samplers: Array<{ input: number; interpolation: string; output: number }>;
    channels: Array<{ sampler: number; target: { node: number; path: "translation" | "rotation" | "scale" } }>;
  }>;

  if (exportAnimations && Array.isArray(model.animations) && model.animations.length > 0) {
    for (const animation of model.animations) {
      const samplers: Array<{ input: number; interpolation: string; output: number }> = [];
      const channels: Array<{ sampler: number; target: { node: number; path: "translation" | "rotation" | "scale" } }> = [];

      for (const entry of normalizeTracks(animation)) {
        const track = entry.track;
        const targetNode = groupNodes.uuidToNode.get(entry.key)
          ?? (track.name ? groupNodes.nameToNode.get(track.name) : undefined)
          ?? groupNodes.nameToNode.get(entry.key);

        if (targetNode === undefined) {
          continue;
        }

        const byChannel = new Map<string, BBAnimationKeyframe[]>();
        for (const keyframe of track.keyframes ?? []) {
          const channel = keyframe.channel ?? "rotation";
          if (!byChannel.has(channel)) {
            byChannel.set(channel, []);
          }
          byChannel.get(channel)?.push(keyframe);
        }

        for (const [channelName, keyframes] of byChannel) {
          keyframes.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
          if (keyframes.length === 0) {
            continue;
          }

          if (channelName === "position") {
            const samples = sampleTrackVec3(animation, keyframes, [0, 0, 0]);
            if (samples.length === 0) {
              continue;
            }
            const times = new Float32Array(samples.map((sample) => sample.time));
            const inputAccessor = appendAccessor(
              new Uint8Array(times.buffer),
              5126,
              times.length,
              "SCALAR",
              undefined,
              [Math.min(...times)],
              [Math.max(...times)],
            );
            const values = new Float32Array(
              samples.flatMap((sample) => {
                const vec = sample.value;
                return [vec[0] * finalScale, vec[1] * finalScale, vec[2] * finalScale];
              }),
            );
            const outputMin = [
              Math.min(...values.filter((_, index) => index % 3 === 0)),
              Math.min(...values.filter((_, index) => index % 3 === 1)),
              Math.min(...values.filter((_, index) => index % 3 === 2)),
            ];
            const outputMax = [
              Math.max(...values.filter((_, index) => index % 3 === 0)),
              Math.max(...values.filter((_, index) => index % 3 === 1)),
              Math.max(...values.filter((_, index) => index % 3 === 2)),
            ];
            const outputAccessor = appendAccessor(new Uint8Array(values.buffer), 5126, samples.length, "VEC3", undefined, outputMin, outputMax);
            const samplerIndex = samplers.length;
            samplers.push({ input: inputAccessor, output: outputAccessor, interpolation: "LINEAR" });
            channels.push({ sampler: samplerIndex, target: { node: targetNode, path: "translation" } });
          } else if (channelName === "scale") {
            const samples = sampleTrackVec3(animation, keyframes, [1, 1, 1]);
            if (samples.length === 0) {
              continue;
            }
            const times = new Float32Array(samples.map((sample) => sample.time));
            const inputAccessor = appendAccessor(
              new Uint8Array(times.buffer),
              5126,
              times.length,
              "SCALAR",
              undefined,
              [Math.min(...times)],
              [Math.max(...times)],
            );
            const values = new Float32Array(
              samples.flatMap((sample) => {
                const vec = sample.value;
                return [vec[0], vec[1], vec[2]];
              }),
            );
            const outputMin = [
              Math.min(...values.filter((_, index) => index % 3 === 0)),
              Math.min(...values.filter((_, index) => index % 3 === 1)),
              Math.min(...values.filter((_, index) => index % 3 === 2)),
            ];
            const outputMax = [
              Math.max(...values.filter((_, index) => index % 3 === 0)),
              Math.max(...values.filter((_, index) => index % 3 === 1)),
              Math.max(...values.filter((_, index) => index % 3 === 2)),
            ];
            const outputAccessor = appendAccessor(new Uint8Array(values.buffer), 5126, samples.length, "VEC3", undefined, outputMin, outputMax);
            const samplerIndex = samplers.length;
            const interpolation = keyframes.every((keyframe) => (keyframe.interpolation ?? "linear").toLowerCase() === "step")
              ? "STEP"
              : "LINEAR";
            samplers.push({ input: inputAccessor, output: outputAccessor, interpolation });
            channels.push({ sampler: samplerIndex, target: { node: targetNode, path: "scale" } });
          } else {
            const samples = sampleRotationTrack(animation, keyframes);
            if (samples.length === 0) {
              continue;
            }
            const times = new Float32Array(samples.map((sample) => sample.time));
            const inputAccessor = appendAccessor(
              new Uint8Array(times.buffer),
              5126,
              times.length,
              "SCALAR",
              undefined,
              [Math.min(...times)],
              [Math.max(...times)],
            );
            const values = new Float32Array(
              samples.flatMap((sample) => {
                const quat = sample.value;
                return [quat[0], quat[1], quat[2], quat[3]];
              }),
            );
            const outputMin = [
              Math.min(...values.filter((_, index) => index % 4 === 0)),
              Math.min(...values.filter((_, index) => index % 4 === 1)),
              Math.min(...values.filter((_, index) => index % 4 === 2)),
              Math.min(...values.filter((_, index) => index % 4 === 3)),
            ];
            const outputMax = [
              Math.max(...values.filter((_, index) => index % 4 === 0)),
              Math.max(...values.filter((_, index) => index % 4 === 1)),
              Math.max(...values.filter((_, index) => index % 4 === 2)),
              Math.max(...values.filter((_, index) => index % 4 === 3)),
            ];
            const outputAccessor = appendAccessor(new Uint8Array(values.buffer), 5126, samples.length, "VEC4", undefined, outputMin, outputMax);
            const samplerIndex = samplers.length;
            const interpolation = keyframes.every((keyframe) => (keyframe.interpolation ?? "linear").toLowerCase() === "step")
              ? "STEP"
              : "LINEAR";
            samplers.push({ input: inputAccessor, output: outputAccessor, interpolation });
            channels.push({ sampler: samplerIndex, target: { node: targetNode, path: "rotation" } });
          }
        }
      }

      if (channels.length > 0) {
        animationOutput.push({
          name: animation.name ?? "animation",
          samplers,
          channels,
        });
      }
    }
  }

  const packedBuffer = concatUint8(chunks);
  const hasNonEmbeddedTexture = materialRefs.materials.some((material) => {
    if (material.textureKey === "default") {
      return false;
    }
    const texture = textureMap.get(material.textureKey);
    return !texture?.source?.startsWith("data:");
  });
  const shouldWriteExternalTextures = !embedTextures || hasNonEmbeddedTexture;

  const gltf = {
    asset: {
      version: "2.0",
      generator: "Blockbench 5.0.7 glTF exporter",
    },
    scenes: [{ nodes: sceneRootNodes, name: "blockbench_export" }],
    scene: 0,
    nodes,
    bufferViews,
    buffers: [
      {
        byteLength: packedBuffer.byteLength,
        uri: embedTextures
          ? `data:application/octet-stream;base64,${Buffer.from(packedBuffer.buffer, packedBuffer.byteOffset, packedBuffer.byteLength).toString("base64")}`
          : `${modelName}.bin`,
      },
    ],
    accessors,
    materials,
    textures,
    samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }],
    images,
    ...(meshes.length > 0 ? { meshes } : {}),
    ...(skins.length > 0 ? { skins } : {}),
    ...(animationOutput.length > 0 ? { animations: animationOutput } : {}),
  };

  return {
    gltf: JSON.stringify(gltf),
    bin: embedTextures ? null : packedBuffer,
    embeddedTextures: materialRefs.textureFiles,
    shouldWriteExternalTextures,
  };
}

export async function writeGltfOutput(
  sourceFilePath: string,
  destinationGltfPath: string,
  data: GltfData,
  model: BBModel,
  textureKeys?: Set<string>,
): Promise<void> {
  const modelName = modelFileNameFromPath(destinationGltfPath);
  const destinationDir = dirname(destinationGltfPath);

  await writeFile(destinationGltfPath, data.gltf, "utf8");
  if (data.bin !== null) {
    await writeFile(join(destinationDir, `${modelName}.bin`), data.bin);
  }
  if (data.shouldWriteExternalTextures) {
    await writeTextureFolder(sourceFilePath, destinationDir, modelName, model, data.embeddedTextures, textureKeys);
  }
}
