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
  const textures = model.textures ?? [];
  for (const [index, texture] of textures.entries()) {
    const canonical = getTextureCanonicalKey(texture, index, textures);
    if (!map.has(canonical)) {
      map.set(canonical, texture);
    }

    if (texture.id !== undefined && texture.id !== null) {
      const idKey = String(texture.id);
      if (!map.has(idKey)) {
        map.set(idKey, texture);
      }
    }
    if (texture.uuid && !map.has(texture.uuid)) {
      map.set(texture.uuid, texture);
    }
    if (texture.name && !map.has(texture.name)) {
      map.set(texture.name, texture);
    }

    const indexKey = String(index);
    if (!map.has(indexKey)) {
      map.set(indexKey, texture);
    }
  }
  return map;
}

function getNameCounts(textures: BBTexture[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const texture of textures) {
    if (!texture.name) {
      continue;
    }
    counts.set(texture.name, (counts.get(texture.name) ?? 0) + 1);
  }
  return counts;
}

function getIdCounts(textures: BBTexture[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const texture of textures) {
    if (texture.id === undefined || texture.id === null) {
      continue;
    }
    const idKey = String(texture.id);
    counts.set(idKey, (counts.get(idKey) ?? 0) + 1);
  }
  return counts;
}

export function getTextureCanonicalKey(texture: BBTexture, index: number, textures: BBTexture[]): string {
  const nameCounts = getNameCounts(textures);
  const idCounts = getIdCounts(textures);

  if (texture.name && (nameCounts.get(texture.name) ?? 0) === 1) {
    return texture.name;
  }

  if (texture.id !== undefined && texture.id !== null) {
    const idKey = String(texture.id);
    if ((idCounts.get(idKey) ?? 0) === 1) {
      return idKey;
    }
  }

  if (texture.uuid) {
    return texture.uuid;
  }

  if (texture.name) {
    return `${texture.name}_${index}`;
  }

  return `texture_${index}`;
}

export function collectDeclaredTextureKeys(model: BBModel): string[] {
  const textures = model.textures ?? [];
  const keys = new Set<string>();
  for (const [index, texture] of textures.entries()) {
    keys.add(getTextureCanonicalKey(texture, index, textures));
  }
  return [...keys];
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

function textureIdentity(texture: BBTexture | undefined, fallback: string): string {
  if (!texture) {
    return fallback;
  }
  return texture.name ?? String(texture.id ?? texture.uuid ?? fallback);
}

function resolveTextureKey(face: BBFace | undefined, model: BBModel): string {
  if (!face?.texture && face?.texture !== 0) {
    return "default";
  }

  const textures = model.textures ?? [];
  const textureMap = resolveTextureMap(model);

  if (typeof face.texture === "number" && Number.isInteger(face.texture)) {
    const texture = textures[face.texture];
    return texture ? getTextureCanonicalKey(texture, face.texture, textures) : String(face.texture);
  }

  const rawValue = String(face.texture);
  const normalizedValue = rawValue.startsWith("#") ? rawValue.slice(1) : rawValue;

  if (/^\d+$/.test(normalizedValue)) {
    const index = Number(normalizedValue);
    const texture = textures[index];
    if (texture) {
      return getTextureCanonicalKey(texture, index, textures);
    }
  }

  const resolved = textureMap.get(normalizedValue);
  if (!resolved) {
    return normalizedValue;
  }
  const index = textures.indexOf(resolved);
  if (index >= 0) {
    return getTextureCanonicalKey(resolved, index, textures);
  }
  return textureIdentity(resolved, normalizedValue);
}

export function buildFaceBatches(model: BBModel, sceneElements: SceneElement[], scale: number): FaceBatch[] {
  const textureWidth = model.resolution?.width ?? 16;
  const textureHeight = model.resolution?.height ?? 16;
  const batches: FaceBatch[] = [];

  for (const sceneElement of sceneElements) {
    const element = sceneElement.element;

    const maybeMesh = element as unknown as {
      type?: string;
      vertices?: Record<string, [number, number, number]>;
      faces?: Record<string, { vertices?: string[]; uv?: Record<string, [number, number]>; texture?: string | number }>;
    };

    if (maybeMesh.type === "mesh" && maybeMesh.vertices && maybeMesh.faces) {
      for (const face of Object.values(maybeMesh.faces)) {
        const vertexIds = Array.isArray(face.vertices) ? face.vertices : [];
        if (vertexIds.length < 3) {
          continue;
        }

        const textureKey = resolveTextureKey({ texture: face.texture }, model);
        const materialName = materialFromTextureKey(textureKey);

        const worldPositions = vertexIds.map((vertexId) => {
          const vertex = maybeMesh.vertices?.[vertexId];
          if (!vertex || vertex.length < 3) {
            return null;
          }
          const world = applyTransforms([vertex[0], vertex[1], vertex[2]], sceneElement.transforms);
          return scalePoint(world, scale);
        });

        if (worldPositions.some((position) => position === null)) {
          continue;
        }

        const worldUvs = vertexIds.map((vertexId) => {
          const uv = face.uv?.[vertexId];
          if (!uv || uv.length < 2) {
            return [0, 0] as Vec2;
          }
          return [uv[0] / textureWidth, 1 - uv[1] / textureHeight] as Vec2;
        });

        if (vertexIds.length === 4) {
          batches.push({
            materialName,
            textureKey,
            positions: [
              worldPositions[0] as Vec3,
              worldPositions[1] as Vec3,
              worldPositions[2] as Vec3,
              worldPositions[3] as Vec3,
            ],
            uvs: [worldUvs[0], worldUvs[1], worldUvs[2], worldUvs[3]],
          });
          continue;
        }

        if (vertexIds.length === 3) {
          const p0 = worldPositions[0] as Vec3;
          const p1 = worldPositions[1] as Vec3;
          const p2 = worldPositions[2] as Vec3;
          const uv0 = worldUvs[0];
          const uv1 = worldUvs[1];
          const uv2 = worldUvs[2];
          batches.push({
            materialName,
            textureKey,
            positions: [p0, p1, p2, p2],
            uvs: [uv0, uv1, uv2, uv2],
          });
          continue;
        }

        // Triangulate n-gons using fan triangulation.
        for (let i = 1; i < vertexIds.length - 1; i += 1) {
          const p0 = worldPositions[0] as Vec3;
          const p1 = worldPositions[i] as Vec3;
          const p2 = worldPositions[i + 1] as Vec3;

          const uv0 = worldUvs[0];
          const uv1 = worldUvs[i];
          const uv2 = worldUvs[i + 1];

          batches.push({
            materialName,
            textureKey,
            positions: [p0, p1, p2, p2],
            uvs: [uv0, uv1, uv2, uv2],
          });
        }
      }
      continue;
    }

    // Some bbmodel elements are not cuboids and do not provide from/to.
    if (!Array.isArray(element.from) || element.from.length < 3 || !Array.isArray(element.to) || element.to.length < 3) {
      continue;
    }

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

      const textureKey = resolveTextureKey(bbFace, model);
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
    const texturePath = texture.path ?? texture.relative_path;
    if (!texturePath || texture.source?.startsWith("data:")) {
      continue;
    }

    const textureIndex = (model.textures ?? []).indexOf(texture);
    const textureKey = getTextureCanonicalKey(texture, textureIndex, model.textures ?? []);
    if (!textureMap.has(textureKey)) {
      continue;
    }
    if (allowedTextureKeys && !allowedTextureKeys.has(textureKey)) {
      continue;
    }

    const sourceTexturePath = resolve(sourceFilePath, "..", texturePath);
    const targetName = `${sanitizeMaterialName(textureKey)}${extname(texturePath) || ".png"}`;
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
