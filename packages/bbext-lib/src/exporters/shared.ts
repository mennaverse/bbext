import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type {
  BBFace,
  BBModel,
  BBTexture,
  FaceName,
  SceneElement,
  Vec2,
  Vec3,
} from "../types";
import { applyTransforms, scalePoint } from "../math";

export interface TextureFile {
  name: string;
  bytes: Uint8Array;
}

export interface MaterialRef {
  materialName: string;
  textureKey: string;
}

export interface FaceBatch {
  materialName: string;
  textureKey: string;
  positions: [Vec3, Vec3, Vec3, Vec3];
  uvs: [Vec2, Vec2, Vec2, Vec2];
}

export interface FaceBatchFilterOptions {
  textureKeys?: Set<string>;
}

interface ObjFace {
  name: FaceName;
  corners: [Vec3, Vec3, Vec3, Vec3];
}

const FACE_ORDER: FaceName[] = ["north", "south", "east", "west", "up", "down"];

export function sanitizeMaterialName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function materialFromTextureKey(textureKey: string): string {
  return `mat_${sanitizeMaterialName(textureKey || "default")}`;
}

export function decodeDataUri(dataUri: string): Uint8Array | null {
  const marker = "base64,";
  const markerIndex = dataUri.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const base64 = dataUri.slice(markerIndex + marker.length);
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

export function resolveTextureMap(model: BBModel): Map<string, BBTexture> {
  const map = new Map<string, BBTexture>();
  for (const texture of model.textures ?? []) {
    if (texture.id) {
      map.set(texture.id, texture);
    }
    if (texture.uuid) {
      map.set(texture.uuid, texture);
    }
    if (texture.name) {
      map.set(texture.name, texture);
    }
  }
  return map;
}

function rotateUV(uvs: Vec2[], rotation: number): Vec2[] {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 0) {
    return uvs;
  }
  const steps = normalized / 90;
  if (!Number.isInteger(steps)) {
    return uvs;
  }
  const rotated = [...uvs];
  for (let i = 0; i < steps; i += 1) {
    rotated.unshift(rotated.pop() as Vec2);
  }
  return rotated;
}

function faceCorners(from: Vec3, to: Vec3): ObjFace[] {
  const [x1, y1, z1] = from;
  const [x2, y2, z2] = to;

  const a: Vec3 = [x1, y1, z1];
  const b: Vec3 = [x2, y1, z1];
  const c: Vec3 = [x2, y2, z1];
  const d: Vec3 = [x1, y2, z1];
  const e: Vec3 = [x1, y1, z2];
  const f: Vec3 = [x2, y1, z2];
  const g: Vec3 = [x2, y2, z2];
  const h: Vec3 = [x1, y2, z2];

  return [
    { name: "north", corners: [b, a, d, c] },
    { name: "south", corners: [e, f, g, h] },
    { name: "east", corners: [f, b, c, g] },
    { name: "west", corners: [a, e, h, d] },
    { name: "up", corners: [d, h, g, c] },
    { name: "down", corners: [a, b, f, e] },
  ];
}

function normalizeUV(
  face: BBFace | undefined,
  textureWidth: number,
  textureHeight: number,
): [Vec2, Vec2, Vec2, Vec2] {
  const raw = face?.uv ?? [0, 0, textureWidth, textureHeight];
  const [u1, v1, u2, v2] = raw;

  const mapped: Vec2[] = [
    [u1 / textureWidth, 1 - v1 / textureHeight],
    [u2 / textureWidth, 1 - v1 / textureHeight],
    [u2 / textureWidth, 1 - v2 / textureHeight],
    [u1 / textureWidth, 1 - v2 / textureHeight],
  ];

  const rotated = rotateUV(mapped, face?.rotation ?? 0);
  return [rotated[0], rotated[1], rotated[2], rotated[3]];
}

function resolveTextureKey(face: BBFace | undefined): string {
  if (!face?.texture && face?.texture !== 0) {
    return "default";
  }
  const value = String(face.texture);
  return value.startsWith("#") ? value.slice(1) : value;
}

export function buildFaceBatches(model: BBModel, sceneElements: SceneElement[], scale: number): FaceBatch[] {
  const textureWidth = model.resolution?.width ?? 16;
  const textureHeight = model.resolution?.height ?? 16;
  const batches: FaceBatch[] = [];

  for (const sceneElement of sceneElements) {
    const element = sceneElement.element;
    const from: Vec3 = [element.from[0], element.from[1], element.from[2]];
    const to: Vec3 = [element.to[0], element.to[1], element.to[2]];
    const faces = faceCorners(from, to);
    const elementFaces = element.faces ?? {};

    for (const faceName of FACE_ORDER) {
      const currentFace = faces.find((face) => face.name === faceName);
      if (!currentFace) {
        continue;
      }

      const bbFace = elementFaces[faceName];
      if (bbFace === null) {
        continue;
      }

      const uv = normalizeUV(bbFace, textureWidth, textureHeight);
      const transformed = currentFace.corners.map((point) => {
        const world = applyTransforms(point, sceneElement.transforms);
        return scalePoint(world, scale);
      }) as [Vec3, Vec3, Vec3, Vec3];

      const textureKey = resolveTextureKey(bbFace);
      const materialName = materialFromTextureKey(textureKey);

      batches.push({
        materialName,
        textureKey,
        positions: transformed,
        uvs: uv,
      });
    }
  }

  return batches;
}

export function filterFaceBatches(faceBatches: FaceBatch[], options: FaceBatchFilterOptions = {}): FaceBatch[] {
  if (!options.textureKeys || options.textureKeys.size === 0) {
    return faceBatches;
  }

  return faceBatches.filter((batch) => options.textureKeys?.has(batch.textureKey));
}

export function collectUsedTextureKeys(faceBatches: FaceBatch[]): string[] {
  const textureKeys = new Set<string>();
  for (const batch of faceBatches) {
    textureKeys.add(batch.textureKey || "default");
  }
  return [...textureKeys];
}

export function collectMaterialRefs(model: BBModel, faceBatches: FaceBatch[]): {
  materials: MaterialRef[];
  textureFiles: TextureFile[];
} {
  const textureMap = resolveTextureMap(model);
  const materialToTextureKey = new Map<string, string>();
  const textureOutputs = new Map<string, Uint8Array>();

  for (const batch of faceBatches) {
    if (!materialToTextureKey.has(batch.materialName)) {
      materialToTextureKey.set(batch.materialName, batch.textureKey);
    }
  }

  const materials: MaterialRef[] = [];
  for (const [materialName, rawTextureKey] of materialToTextureKey) {
    const textureKey = rawTextureKey || "default";
    materials.push({ materialName, textureKey });

    const texture = textureMap.get(textureKey);
    if (!texture?.source?.startsWith("data:")) {
      continue;
    }
    const bytes = decodeDataUri(texture.source);
    if (!bytes) {
      continue;
    }
    textureOutputs.set(`${sanitizeMaterialName(textureKey)}.png`, bytes);
  }

  return {
    materials,
    textureFiles: [...textureOutputs.entries()].map(([name, bytes]) => ({ name, bytes })),
  };
}

export async function writeTextureFolder(
  sourceFilePath: string,
  destinationDir: string,
  modelName: string,
  model: BBModel,
  embeddedTextureFiles: TextureFile[],
  allowedTextureKeys?: Set<string>,
): Promise<void> {
  const textureFolder = join(destinationDir, `${modelName}_textures`);
  const textureMap = resolveTextureMap(model);
  const allowedSanitizedTextureKeys = allowedTextureKeys
    ? new Set([...allowedTextureKeys].map((textureKey) => sanitizeMaterialName(textureKey)))
    : undefined;

  let hasAnyTexture = embeddedTextureFiles.length > 0;
  if (!hasAnyTexture) {
    hasAnyTexture = (model.textures ?? []).some((texture) => Boolean(texture.path));
  }
  if (!hasAnyTexture) {
    return;
  }

  await mkdir(textureFolder, { recursive: true });

  for (const texture of embeddedTextureFiles) {
    const textureKey = texture.name.replace(/\.[^.]+$/, "");
    if (
      allowedTextureKeys
      && !allowedTextureKeys.has(textureKey)
      && !allowedTextureKeys.has("default")
      && !allowedSanitizedTextureKeys?.has(textureKey)
    ) {
      continue;
    }
    await Bun.write(join(textureFolder, texture.name), texture.bytes);
  }

  for (const texture of model.textures ?? []) {
    if (!texture.path || texture.source?.startsWith("data:")) {
      continue;
    }

    const textureKey = texture.id ?? texture.uuid ?? texture.name;
    if (!textureKey || !textureMap.has(textureKey)) {
      continue;
    }
    if (allowedTextureKeys && !allowedTextureKeys.has(textureKey)) {
      continue;
    }

    const sourceTexturePath = resolve(sourceFilePath, "..", texture.path);
    const targetName = `${sanitizeMaterialName(textureKey)}${extname(texture.path) || ".png"}`;
    const targetPath = join(textureFolder, targetName);

    try {
      await copyFile(sourceTexturePath, targetPath);
    } catch {
      // Ignore missing external texture paths and keep export pipeline running.
    }
  }
}

export function textureRelativeUri(modelName: string, textureKey: string): string {
  return `${modelName}_textures/${sanitizeMaterialName(textureKey)}.png`;
}

export function modelFileNameFromPath(outputPath: string): string {
  return basename(outputPath, extname(outputPath));
}

export function outputPathWithVariant(outputPath: string, textureKey: string): string {
  const ext = extname(outputPath);
  const base = outputPath.slice(0, outputPath.length - ext.length);
  return `${base}__${sanitizeMaterialName(textureKey || "default")}${ext}`;
}
