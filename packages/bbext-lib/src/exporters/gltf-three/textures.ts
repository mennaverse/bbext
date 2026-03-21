import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import sharp from "sharp";
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearMipmapLinearFilter,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from "three";
import type { BBModel } from "../../types";
import {
  decodeDataUri,
  resolveTextureMap,
  sanitizeMaterialName,
  textureRelativeUri,
} from "../shared";

interface ResolvedTexture {
  textureKey: string;
  texture: Texture;
  bytes: Uint8Array;
}

async function loadTextureBytes(texture: { source?: string; path?: string; relative_path?: string }, sourceFilePath?: string): Promise<Uint8Array | null> {
  if (texture.source?.startsWith("data:")) {
    return decodeDataUri(texture.source);
  }

  const texturePath = texture.path ?? texture.relative_path;
  if (!texturePath) {
    return null;
  }

  const resolvedPath = sourceFilePath
    ? resolve(dirname(sourceFilePath), texturePath)
    : resolve(texturePath);

  try {
    return new Uint8Array(await readFile(resolvedPath));
  } catch {
    return null;
  }
}

async function createDataTexture(bytes: Uint8Array): Promise<Texture> {
  const image = sharp(bytes);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unsupported texture dimensions");
  }

  const raw = await image.ensureAlpha().raw().toBuffer();
  const dataTexture = new DataTexture(
    new Uint8Array(raw),
    metadata.width,
    metadata.height,
    RGBAFormat,
    UnsignedByteType,
  );

  dataTexture.colorSpace = SRGBColorSpace;
  dataTexture.flipY = false;
  dataTexture.wrapS = ClampToEdgeWrapping;
  dataTexture.wrapT = ClampToEdgeWrapping;
  dataTexture.magFilter = NearestFilter;
  dataTexture.minFilter = LinearMipmapLinearFilter;
  dataTexture.needsUpdate = true;

  return dataTexture;
}

export async function buildTextureAssets(
  model: BBModel,
  usedTextureKeys: string[],
  sourceFilePath?: string,
): Promise<{ byTextureKey: Map<string, ResolvedTexture>; embeddedTextures: Array<{ name: string; bytes: Uint8Array }> }> {
  const textureMap = resolveTextureMap(model);
  const byTextureKey = new Map<string, ResolvedTexture>();
  const embeddedTextures: Array<{ name: string; bytes: Uint8Array }> = [];

  for (const textureKey of usedTextureKeys) {
    if (!textureKey || textureKey === "default") {
      continue;
    }

    const textureRef = textureMap.get(textureKey);
    if (!textureRef) {
      continue;
    }

    const bytes = await loadTextureBytes(textureRef, sourceFilePath);
    if (!bytes) {
      continue;
    }

    try {
      const texture = await createDataTexture(bytes);
      texture.name = sanitizeMaterialName(textureKey);
      byTextureKey.set(textureKey, { textureKey, texture, bytes });

      const extension = extname(textureRef.path ?? textureRef.relative_path ?? "") || ".png";
      embeddedTextures.push({ name: `${sanitizeMaterialName(textureKey)}${extension}`, bytes });
    } catch {
      // Ignore invalid/unsupported textures and keep exporting geometry.
    }
  }

  return { byTextureKey, embeddedTextures };
}

export function rewriteImageUris(
  gltfJson: Record<string, unknown>,
  modelName: string,
  textureKeyByImageName: Map<string, string>,
): void {
  const images = gltfJson.images as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(images)) {
    return;
  }

  for (const image of images) {
    const imageName = typeof image.name === "string" ? image.name : undefined;
    if (!imageName) {
      continue;
    }
    const textureKey = textureKeyByImageName.get(imageName);
    if (!textureKey) {
      continue;
    }

    image.uri = textureRelativeUri(modelName, textureKey);
    delete image.bufferView;
    delete image.mimeType;
  }
}
