import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GLTFExporter, TextureLoader } from "node-three-gltf";
import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  Scene,
  SRGBColorSpace,
  Texture,
} from "three";
import type { BBModel, SceneElement, Vec3 } from "../types";
import {
  buildFaceBatches,
  filterFaceBatches,
  modelFileNameFromPath,
  resolveTextureMap,
} from "./shared";

export interface GltfThreeExportOptions {
  modelScale?: number;
  embedTextures?: boolean;
}

interface GltfThreeData {
  gltf: string;
}

interface PrimitiveBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

function vecEquals(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
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
  const len = Math.hypot(nx, ny, nz);
  if (len === 0) {
    return [0, 1, 0];
  }
  return [nx / len, ny / len, nz / len];
}

function appendFace(buffers: PrimitiveBuffers, positions: [Vec3, Vec3, Vec3, Vec3], uvs: [[number, number], [number, number], [number, number], [number, number]]): void {
  const baseIndex = buffers.positions.length / 3;
  const normal = computeNormal(positions[0], positions[1], positions[2]);

  for (let i = 0; i < 4; i += 1) {
    const p = positions[i];
    const uv = uvs[i];
    buffers.positions.push(p[0], p[1], p[2]);
    buffers.normals.push(normal[0], normal[1], normal[2]);
    buffers.uvs.push(uv[0], uv[1]);
  }

  buffers.indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
  if (!vecEquals(positions[2], positions[3])) {
    buffers.indices.push(baseIndex, baseIndex + 2, baseIndex + 3);
  }
}

async function loadTexture(textureSourcePath: string | undefined, embeddedSource: string | undefined): Promise<Texture | null> {
  const loader = new TextureLoader();
  const input = embeddedSource?.startsWith("data:") ? embeddedSource : textureSourcePath;
  if (!input) {
    return null;
  }

  try {
    const texture = await new Promise<Texture>((resolveTexture, rejectTexture) => {
      loader.load(input, resolveTexture, undefined, rejectTexture);
    });
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    return texture;
  } catch {
    return null;
  }
}

export async function generateGltfThreeData(
  sourceFilePath: string,
  outputFilePath: string,
  model: BBModel,
  sceneElements: SceneElement[],
  scale: number,
  options: GltfThreeExportOptions = {},
  textureKeys?: Set<string>,
): Promise<GltfThreeData> {
  const modelName = modelFileNameFromPath(outputFilePath);
  const finalScale = options.modelScale ?? scale;
  const embedTextures = options.embedTextures ?? true;

  const textureMap = resolveTextureMap(model);
  const faceBatches = filterFaceBatches(buildFaceBatches(model, sceneElements, finalScale), { textureKeys });

  const byMaterial = new Map<string, PrimitiveBuffers>();
  const materialToTexture = new Map<string, string>();

  for (const face of faceBatches) {
    if (!byMaterial.has(face.materialName)) {
      byMaterial.set(face.materialName, {
        positions: [],
        normals: [],
        uvs: [],
        indices: [],
      });
      materialToTexture.set(face.materialName, face.textureKey);
    }

    const buffers = byMaterial.get(face.materialName);
    if (!buffers) {
      continue;
    }

    appendFace(buffers, face.positions, face.uvs);
  }

  const scene = new Scene();
  scene.name = modelName;

  for (const [materialName, buffers] of byMaterial) {
    if (buffers.positions.length === 0 || buffers.indices.length === 0) {
      continue;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(buffers.positions, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(buffers.normals, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(buffers.uvs, 2));
    geometry.setIndex(buffers.indices);

    const textureKey = materialToTexture.get(materialName) ?? "default";
    const textureInfo = textureMap.get(textureKey);
    const texturePath = textureInfo?.path ?? textureInfo?.relative_path;
    const absoluteTexturePath = texturePath ? resolve(dirname(sourceFilePath), texturePath) : undefined;
    const texture = await loadTexture(absoluteTexturePath, textureInfo?.source);

    const material = new MeshStandardMaterial({
      name: materialName,
      map: texture ?? null,
      color: 0xffffff,
      metalness: 0,
      roughness: 1,
      transparent: true,
      alphaTest: 0.05,
      side: 2,
    });

    const mesh = new Mesh(geometry, material);
    mesh.name = materialName;
    scene.add(mesh);
  }

  const exporter = new GLTFExporter();
  const gltfJson = await exporter.parseAsync(scene, {
    binary: false,
    embedImages: embedTextures,
    onlyVisible: false,
    trs: false,
  });

  return {
    gltf: JSON.stringify(gltfJson),
  };
}

export async function writeGltfThreeOutput(destinationGltfPath: string, data: GltfThreeData): Promise<void> {
  await writeFile(destinationGltfPath, data.gltf, "utf8");
}