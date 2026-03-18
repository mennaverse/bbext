import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  BBAnimation,
  BBAnimationKeyframe,
  BBAnimationTrack,
  BBModel,
  BBOutlinerNode,
  SceneElement,
  Vec3,
} from "../types";
import {
  buildFaceBatches,
  collectMaterialRefs,
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
  bin: Uint8Array;
  embeddedTextures: Array<{ name: string; bytes: Uint8Array }>;
  shouldWriteExternalTextures: boolean;
}

export interface GltfExportOptions {
  modelScale?: number;
  embedTextures?: boolean;
  exportGroupsAsArmature?: boolean;
  exportAnimations?: boolean;
}

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

interface GroupNodeInfo {
  nameToNode: Map<string, number>;
  uuidToNode: Map<string, number>;
  rootGroupNodes: number[];
}

function buildGroupNodes(outliner: BBOutlinerNode[] | undefined, nodes: Array<Record<string, unknown>>): GroupNodeInfo {
  const nameToNode = new Map<string, number>();
  const uuidToNode = new Map<string, number>();
  const rootGroupNodes: number[] = [];
  let groupCounter = 0;

  function visit(items: BBOutlinerNode[] | undefined, parentNodeIndex?: number): void {
    for (const item of items ?? []) {
      if (typeof item === "string") {
        continue;
      }

      const nodeName = item.name ?? `group_${groupCounter}`;
      groupCounter += 1;

      const nodeIndex = nodes.length;
      nodes.push({
        name: nodeName,
        children: [],
        extras: {
          bbGroup: true,
        },
      });

      if (!nameToNode.has(nodeName)) {
        nameToNode.set(nodeName, nodeIndex);
      }
      if (item.uuid && !uuidToNode.has(item.uuid)) {
        uuidToNode.set(item.uuid, nodeIndex);
      }

      if (parentNodeIndex === undefined) {
        rootGroupNodes.push(nodeIndex);
      } else {
        const parent = nodes[parentNodeIndex] as { children?: number[] };
        if (!Array.isArray(parent.children)) {
          parent.children = [];
        }
        parent.children.push(nodeIndex);
      }

      visit(item.children, nodeIndex);
    }
  }

  visit(outliner);

  return {
    nameToNode,
    uuidToNode,
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
  const faceBatches = filterFaceBatches(buildFaceBatches(model, sceneElements, finalScale), { textureKeys });
  const materialRefs = collectMaterialRefs(model, faceBatches);
  const textureMap = resolveTextureMap(model);
  const embedTextures = Boolean(options.embedTextures);
  const exportGroupsAsArmature = Boolean(options.exportGroupsAsArmature);
  const exportAnimations = Boolean(options.exportAnimations);

  const positions: number[] = [];
  const uvs: number[] = [];
  const primitiveByMaterial = new Map<string, GltfPrimitiveBuild>();

  for (const face of faceBatches) {
    const baseVertex = positions.length / 3;
    for (const p of face.positions) {
      positions.push(p[0], p[1], p[2]);
    }
    for (const uv of face.uvs) {
      uvs.push(uv[0], uv[1]);
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

  const posArray = new Float32Array(positions);
  const uvArray = new Float32Array(uvs);
  const vertexCount = positions.length / 3;
  const minMax = computePositionMinMax(positions);

  const useUint32 = vertexCount > 65535;
  const indexComponentType = useUint32 ? 5125 : 5123;

  const chunks: Uint8Array[] = [];
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number; target?: number }> = [];
  const accessors: Array<{
    bufferView: number;
    byteOffset: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
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
      byteOffset: 0,
      componentType,
      count,
      type,
      min,
      max,
    });
    return accessorIndex;
  }

  const posBytes = new Uint8Array(posArray.buffer);
  const positionAccessorIndex = appendAccessor(
    posBytes,
    5126,
    vertexCount,
    "VEC3",
    34962,
    minMax.min,
    minMax.max,
  );

  const uvBytes = new Uint8Array(uvArray.buffer);
  const uvAccessorIndex = appendAccessor(uvBytes, 5126, uvs.length / 2, "VEC2", 34962);

  const primitiveEntries = [...primitiveByMaterial.values()];
  const primitiveAccessorIndexByMaterial = new Map<string, number>();

  for (const primitive of primitiveEntries) {
    const indexArray = useUint32 ? new Uint32Array(primitive.indices) : new Uint16Array(primitive.indices);
    const indexBytes = new Uint8Array(indexArray.buffer);
    const minIndex = primitive.indices.length > 0 ? Math.min(...primitive.indices) : 0;
    const maxIndex = primitive.indices.length > 0 ? Math.max(...primitive.indices) : 0;
    const accessorIndex = appendAccessor(
      indexBytes,
      indexComponentType,
      primitive.indices.length,
      "SCALAR",
      34963,
      [minIndex],
      [maxIndex],
    );
    primitiveAccessorIndexByMaterial.set(primitive.materialName, accessorIndex);
  }

  const imageByTextureKey = new Map<string, number>();
  const images: Array<{ uri: string }> = [];
  const textures: Array<{ sampler: number; source: number }> = [];
  const materials = materialRefs.materials.map((mat) => {
    if (mat.textureKey === "default") {
      return {
        name: mat.materialName,
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      };
    }

    let imageIndex = imageByTextureKey.get(mat.textureKey);
    if (imageIndex === undefined) {
      imageIndex = images.length;
      const bbTexture = textureMap.get(mat.textureKey);
      if (embedTextures && bbTexture?.source?.startsWith("data:")) {
        images.push({ uri: bbTexture.source });
      } else {
        images.push({ uri: textureRelativeUri(modelName, mat.textureKey) });
      }
      textures.push({ sampler: 0, source: imageIndex });
      imageByTextureKey.set(mat.textureKey, imageIndex);
    }

    return {
      name: mat.materialName,
      pbrMetallicRoughness: {
        baseColorTexture: {
          index: imageIndex,
        },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    };
  });

  const materialIndexByName = new Map(materials.map((material, index) => [material.name, index]));

  const nodes: Array<Record<string, unknown>> = [];
  const meshNodeIndex = nodes.length;
  nodes.push({ mesh: 0, name: modelName });

  let sceneRootNodes: number[] = [meshNodeIndex];
  const groupNodes = buildGroupNodes(model.outliner, nodes);
  const useGroupHierarchy = exportGroupsAsArmature || exportAnimations;

  if (useGroupHierarchy) {
    const armatureNodeIndex = nodes.length;
    nodes.push({
      name: `${modelName}_Armature`,
      children: [...groupNodes.rootGroupNodes, meshNodeIndex],
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

          const times = new Float32Array(keyframes.map((keyframe) => Number(keyframe.time ?? 0)));
          const inputAccessor = appendAccessor(
            new Uint8Array(times.buffer),
            5126,
            times.length,
            "SCALAR",
            undefined,
            [Math.min(...times)],
            [Math.max(...times)],
          );

          if (channelName === "position") {
            const values = new Float32Array(
              keyframes.flatMap((keyframe) => {
                const vec = keyframeVec3(keyframe, [0, 0, 0]);
                return [vec[0], vec[1], vec[2]];
              }),
            );
            const outputAccessor = appendAccessor(new Uint8Array(values.buffer), 5126, keyframes.length, "VEC3");
            const samplerIndex = samplers.length;
            samplers.push({ input: inputAccessor, interpolation: "LINEAR", output: outputAccessor });
            channels.push({ sampler: samplerIndex, target: { node: targetNode, path: "translation" } });
          } else if (channelName === "scale") {
            const values = new Float32Array(
              keyframes.flatMap((keyframe) => {
                const vec = keyframeVec3(keyframe, [1, 1, 1]);
                return [vec[0], vec[1], vec[2]];
              }),
            );
            const outputAccessor = appendAccessor(new Uint8Array(values.buffer), 5126, keyframes.length, "VEC3");
            const samplerIndex = samplers.length;
            samplers.push({ input: inputAccessor, interpolation: "LINEAR", output: outputAccessor });
            channels.push({ sampler: samplerIndex, target: { node: targetNode, path: "scale" } });
          } else {
            const values = new Float32Array(
              keyframes.flatMap((keyframe) => {
                const euler = keyframeVec3(keyframe, [0, 0, 0]);
                const quat = degreesToQuatXYZ(euler);
                return [quat[0], quat[1], quat[2], quat[3]];
              }),
            );
            const outputAccessor = appendAccessor(new Uint8Array(values.buffer), 5126, keyframes.length, "VEC4");
            const samplerIndex = samplers.length;
            samplers.push({ input: inputAccessor, interpolation: "LINEAR", output: outputAccessor });
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
      generator: "bbext",
    },
    scene: 0,
    scenes: [{ nodes: sceneRootNodes }],
    nodes,
    meshes: [
      {
        name: modelName,
        primitives: primitiveEntries.map((primitive) => ({
          attributes: {
            POSITION: positionAccessorIndex,
            TEXCOORD_0: uvAccessorIndex,
          },
          indices: primitiveAccessorIndexByMaterial.get(primitive.materialName),
          material: materialIndexByName.get(primitive.materialName) ?? 0,
        })),
      },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images,
    textures,
    materials,
    buffers: [{ uri: `${modelName}.bin`, byteLength: packedBuffer.byteLength }],
    bufferViews,
    accessors,
    ...(animationOutput.length > 0 ? { animations: animationOutput } : {}),
  };

  return {
    gltf: JSON.stringify(gltf, null, 2),
    bin: packedBuffer,
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

  await writeFile(destinationGltfPath, `${data.gltf}\n`, "utf8");
  await Bun.write(join(destinationDir, `${modelName}.bin`), data.bin);
  if (data.shouldWriteExternalTextures) {
    await writeTextureFolder(sourceFilePath, destinationDir, modelName, model, data.embeddedTextures, textureKeys);
  }
}
