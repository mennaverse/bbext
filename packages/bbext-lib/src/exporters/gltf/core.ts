import type { BBModel, SceneElement, BBElement } from "../../types";
import type { FaceBatch } from "../shared";
import { buildFaceBatches, collectMaterialRefs, filterFaceBatches, modelFileNameFromPath, resolveTextureMap, textureRelativeUri } from "../shared";
import type { GltfData, GltfExportOptions, GltfPrimitiveBuild } from "./types";
import { buildGroupNodes, getBindMatrixInverse } from "./groups";
import { sampleRotationTrack, sampleTrackVec3, normalizeTracks } from "./animations";
import { concatUint8, padTo4 } from "./buffers";
import { computeNormal, computePositionMinMax } from "./math";
import type { Vec3 } from "../../types";
import { vec3IsZero } from "./math";

function collectReachableNodeIndices(
  nodes: Array<Record<string, unknown>>,
  roots: number[],
): Set<number> {
  const reachable = new Set<number>();
  const stack = [...roots];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || reachable.has(current) || current < 0 || current >= nodes.length) {
      continue;
    }

    reachable.add(current);
    const node = nodes[current] as { children?: unknown };
    if (!Array.isArray(node.children)) {
      continue;
    }

    for (const child of node.children) {
      if (typeof child === "number") {
        stack.push(child);
      }
    }
  }

  return reachable;
}

function meshElementNodeTranslation(sceneElement: SceneElement, scale: number): Vec3 | undefined {
  const meshCandidate = sceneElement.element as BBElement & {
    type?: string;
    vertices?: unknown;
    faces?: unknown;
  };
  const isMeshElement = meshCandidate.type === "mesh"
    || (typeof meshCandidate.vertices === "object" && meshCandidate.vertices !== null
      && typeof meshCandidate.faces === "object" && meshCandidate.faces !== null);
  if (!isMeshElement) {
    return undefined;
  }

  const origin = sceneElement.element.origin;
  if (!Array.isArray(origin) || origin.length < 3) {
    return undefined;
  }

  const translation: Vec3 = [origin[0] * scale, origin[1] * scale, origin[2] * scale];
  if (vec3IsZero(translation)) {
    return undefined;
  }

  return translation;
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

  const meshInputs = buildMeshInputs(
    sceneElements,
    textureKeys,
    allFaceBatches,
    exportGroupsAsArmature,
    useGroupHierarchy,
    groupNodes,
    modelName,
    model,
    finalScale,
  );

  for (const meshInput of meshInputs) {
    const meshEntry = buildMeshEntry(
      meshInput.entries,
      meshInput.translation ?? [0, 0, 0],
      appendAccessor,
      setBufferViewStride,
      materialIndexByName,
    );
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
        meshInput.jointNodeIndices.flatMap((nodeIndex: number) => {
          const bindMatrix = groupNodes.bindMatrixByNode.get(nodeIndex);
          const fallbackMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
          return getBindMatrixInverse(bindMatrix || fallbackMatrix, fallbackMatrix);
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

  const animationOutput = buildAnimations(
    model,
    exportAnimations,
    normalizeTracks,
    groupNodes,
    sampleTrackVec3,
    sampleRotationTrack,
    finalScale,
    appendAccessor,
  );

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

function buildMeshInputs(
  sceneElements: SceneElement[],
  textureKeys: Set<string> | undefined,
  allFaceBatches: FaceBatch[],
  exportGroupsAsArmature: boolean,
  useGroupHierarchy: boolean,
  groupNodes: any,
  modelName: string,
  model: BBModel,
  finalScale: number,
) {
  const meshInputs: any = [];
  if (exportGroupsAsArmature) {
    const topLevelPaths = [...groupNodes.pathToNode.keys()].filter((path: string) => !path.includes("/"));
    for (const topLevelPath of topLevelPaths) {
      const jointNodeIndices = [...groupNodes.pathToNode.entries()]
        .filter(([path]: [string, any]) => path === topLevelPath || path.startsWith(`${topLevelPath}/`))
        .sort(([pathA]: [string, any], [pathB]: [string, any]) => {
          const depthDiff = pathA.split("/").length - pathB.split("/").length;
          if (depthDiff !== 0) {
            return depthDiff;
          }
          return pathA.localeCompare(pathB);
        })
        .map(([, nodeIndex]: [string, number]) => nodeIndex);
      const localJointIndexByNode = new Map(jointNodeIndices.map((nodeIndex: number, index: number) => [nodeIndex, index]));
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

    // Fallback for models without outliner group hierarchy: emit one mesh per element,
    // matching Blockbench behaviour.
    if (meshInputs.length === 0) {
      for (const [index, sceneElement] of sceneElements.entries()) {
        const batches = filterFaceBatches(buildFaceBatches(model, [sceneElement], finalScale), { textureKeys });
        if (batches.length === 0) {
          continue;
        }
        meshInputs.push({
          nodeName: sceneElement.element.name ?? `mesh_${index}`,
          meshName: sceneElement.element.name ?? `mesh_${index}`,
          rootPath: [],
          entries: [{ faceBatches: batches, jointIndex: 0 }],
          jointNodeIndices: [],
        });
      }
      // Final fallback if every element is empty.
      if (meshInputs.length === 0) {
        meshInputs.push({
          nodeName: modelName,
          meshName: modelName,
          rootPath: [],
          entries: [{ faceBatches: allFaceBatches, jointIndex: 0 }],
          jointNodeIndices: [],
        });
      }
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

  return meshInputs;
}

function buildAnimations(
  model: BBModel,
  exportAnimations: boolean,
  normalizeTracks: any,
  groupNodes: any,
  sampleTrackVec3: any,
  sampleRotationTrack: any,
  finalScale: number,
  appendAccessor: any,
) {
  const animationOutput: any = [];

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

        const byChannel = new Map<string, any[]>();
        for (const keyframe of track.keyframes ?? []) {
          const channel = keyframe.channel ?? "rotation";
          if (!byChannel.has(channel)) {
            byChannel.set(channel, []);
          }
          byChannel.get(channel)?.push(keyframe);
        }

        for (const [channelName, keyframes] of byChannel) {
          keyframes.sort((a: any, b: any) => (a.time ?? 0) - (b.time ?? 0));
          if (keyframes.length === 0) {
            continue;
          }

          if (channelName === "position") {
            const samples = sampleTrackVec3(animation, keyframes, [0, 0, 0]);
            if (samples.length === 0) {
              continue;
            }
            const times = new Float32Array(samples.map((sample: any) => sample.time));
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
              samples.flatMap((sample: any) => {
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
            const times = new Float32Array(samples.map((sample: any) => sample.time));
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
              samples.flatMap((sample: any) => {
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
            const interpolation = keyframes.every((keyframe: any) => (keyframe.interpolation ?? "linear").toLowerCase() === "step")
              ? "STEP"
              : "LINEAR";
            samplers.push({ input: inputAccessor, output: outputAccessor, interpolation });
            channels.push({ sampler: samplerIndex, target: { node: targetNode, path: "scale" } });
          } else {
            const samples = sampleRotationTrack(animation, keyframes);
            if (samples.length === 0) {
              continue;
            }
            const times = new Float32Array(samples.map((sample: any) => sample.time));
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
              samples.flatMap((sample: any) => {
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
            const interpolation = keyframes.every((keyframe: any) => (keyframe.interpolation ?? "linear").toLowerCase() === "step")
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

  return animationOutput;
}

function buildMeshEntry(
  entries: Array<{ faceBatches: FaceBatch[]; jointIndex: number }>,
  positionOffset: Vec3,
  appendAccessor: (bytes: Uint8Array, componentType: number, count: number, type: string, target?: number, min?: number[], max?: number[]) => number,
  setBufferViewStride: (accessorIndex: number, byteStride: number) => void,
  materialIndexByName: Map<string, number>,
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
        if (face.positions.length < 3 || face.uvs.length !== face.positions.length) {
          continue;
        }

      const baseVertex = positions.length / 3;
      const appliedOffset = entry.jointIndex === 0 ? positionOffset : [0, 0, 0];
      for (const p of face.positions) {
        positions.push(p[0] - appliedOffset[0], p[1] - appliedOffset[1], p[2] - appliedOffset[2]);
      }
      const n = computeNormal(face.positions[0], face.positions[1], face.positions[2]);
        for (let i = 0; i < face.positions.length; i++) {
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
      );

      if (face.positions.length === 4) {
        primitive.indices.push(
          baseVertex,
          baseVertex + 2,
          baseVertex + 3,
        );
      }
    }
  }

  const vertexCount = positions.length / 3;
  if (vertexCount === 0) {
    return null;
  }

  const hasJoints = orderedEntries.some((entry) => entry.jointIndex > 0);

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

  let jointAccessorIndex: number | undefined;
  let weightAccessorIndex: number | undefined;

  if (hasJoints) {
    jointAccessorIndex = appendAccessor(
      new Uint8Array(new Uint16Array(joints).buffer),
      5123,
      vertexCount,
      "VEC4",
      34962,
      [0, Math.min(...joints.filter((_, index) => index % 4 === 1)), 0, 0],
      [0, Math.max(...joints.filter((_, index) => index % 4 === 1)), 0, 0],
    );

    weightAccessorIndex = appendAccessor(
      new Uint8Array(new Float32Array(weights).buffer),
      5126,
      vertexCount,
      "VEC4",
      34962,
      [0, 1, 0, 0],
      [0, 1, 0, 0],
    );
  }

  setBufferViewStride(positionAccessorIndex, 12);
  setBufferViewStride(normalAccessorIndex, 12);
  setBufferViewStride(uvAccessorIndex, 8);
  if (jointAccessorIndex !== undefined) {
    setBufferViewStride(jointAccessorIndex, 8);
  }
  if (weightAccessorIndex !== undefined) {
    setBufferViewStride(weightAccessorIndex, 16);
  }

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

      const attributes: Record<string, number> = {
        POSITION: positionAccessorIndex,
        NORMAL: normalAccessorIndex,
        TEXCOORD_0: uvAccessorIndex,
      };
      if (jointAccessorIndex !== undefined) {
        attributes.JOINTS_0 = jointAccessorIndex;
      }
      if (weightAccessorIndex !== undefined) {
        attributes.WEIGHTS_0 = weightAccessorIndex;
      }

      return {
        mode: 4,
        attributes,
        indices: indicesAccessor,
        material: materialIndexByName.get(primitive.materialName) ?? 0,
      };
    });

  if (primitives.length === 0) {
    return null;
  }

  return { primitives };
}
