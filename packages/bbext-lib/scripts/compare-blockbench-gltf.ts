import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import assert from "node:assert/strict";
import { buildSceneElements, loadBBModel } from "../src/bbmodel";
import { generateGltfData } from "../src/exporters/gltf";
import {
  DEFAULT_EXPORT_OPTIONS,
  DEFAULT_SCALE,
  resolveDefaultBlockbenchGltfPath,
  resolveDefaultModelPath,
  resolveWorkspaceRoot,
} from "./test-consts";

interface GltfLike {
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{ name?: string }>;
  meshes?: Array<{
    primitives?: Array<{
      attributes?: { POSITION?: number };
      indices?: number;
    }>;
  }>;
  skins?: Array<{ joints?: number[] }>;
  materials?: unknown[];
  textures?: unknown[];
  images?: Array<{ uri?: string }>;
  animations?: Array<{ name?: string; channels?: Array<{ target?: { path?: string } }> }>;
  bufferViews?: Array<{ byteLength?: number; byteStride?: number }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    count?: number;
    max?: number[];
    min?: number[];
    type?: string;
  }>;
}

interface GltfSummary {
  sceneRootCount: number;
  nodeCount: number;
  nodeNames: string[];
  meshCount: number;
  primitiveCount: number;
  skinCount: number;
  jointsPerSkin: number[];
  materialCount: number;
  textureCount: number;
  embeddedImageCount: number;
  externalImageCount: number;
  animationCount: number;
  animationNames: string[];
  channelsPerAnimation: number[];
  channelPathsPerAnimation: string[];
  accessorTypeCount: Record<string, number>;
}

function accessorTypeHistogram(gltf: GltfLike): Record<string, number> {
  const out: Record<string, number> = {};
  for (const accessor of gltf.accessors ?? []) {
    const type = accessor?.type ?? "UNKNOWN";
    out[type] = (out[type] ?? 0) + 1;
  }
  return out;
}

function summarizeGltf(gltf: GltfLike): GltfSummary {
  const sceneRootCount = gltf.scenes?.[0]?.nodes?.length ?? 0;
  const nodeNames = (gltf.nodes ?? [])
    .map((node) => node.name ?? "")
    .filter((name) => name.length > 0)
    .sort();

  const primitiveCount = (gltf.meshes ?? []).reduce((sum, mesh) => sum + (mesh.primitives?.length ?? 0), 0);

  const jointsPerSkin = (gltf.skins ?? [])
    .map((skin) => skin.joints?.length ?? 0)
    .sort((a, b) => a - b);

  const images = gltf.images ?? [];
  const embeddedImageCount = images.filter((image) => String(image.uri ?? "").startsWith("data:")).length;
  const externalImageCount = images.length - embeddedImageCount;

  const animations = gltf.animations ?? [];
  const animationNames = animations.map((animation) => animation.name ?? "").sort();
  const channelsPerAnimation = animations
    .map((animation) => animation.channels?.length ?? 0)
    .sort((a, b) => a - b);
  const channelPathsPerAnimation = animations
    .map((animation) => (animation.channels ?? [])
      .map((channel) => channel.target?.path ?? "")
      .sort()
      .join(","))
    .sort();

  return {
    sceneRootCount,
    nodeCount: gltf.nodes?.length ?? 0,
    nodeNames,
    meshCount: gltf.meshes?.length ?? 0,
    primitiveCount,
    skinCount: gltf.skins?.length ?? 0,
    jointsPerSkin,
    materialCount: gltf.materials?.length ?? 0,
    textureCount: gltf.textures?.length ?? 0,
    embeddedImageCount,
    externalImageCount,
    animationCount: animations.length,
    animationNames,
    channelsPerAnimation,
    channelPathsPerAnimation,
    accessorTypeCount: accessorTypeHistogram(gltf),
  };
}

function assertHistogramEqual(actual: Record<string, number>, expected: Record<string, number>, label: string): void {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  assert.deepEqual(actualKeys, expectedKeys, `${label}: different keys`);
  for (const key of actualKeys) {
    assert.equal(actual[key], expected[key], `${label}: mismatch for ${key}`);
  }
}

const COMPONENTS_PER_TYPE: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const BYTES_PER_COMPONENT: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

function validateAccessorLayouts(gltf: GltfLike, label: string): void {
  for (const [accessorIndex, accessor] of (gltf.accessors ?? []).entries()) {
    const bufferViewIndex = accessor.bufferView;
    if (bufferViewIndex === undefined) {
      continue;
    }

    const bufferView = gltf.bufferViews?.[bufferViewIndex];
    assert.ok(bufferView, `${label}: accessor ${accessorIndex} references missing bufferView ${bufferViewIndex}`);

    const componentCount = COMPONENTS_PER_TYPE[accessor.type ?? ""];
    const bytesPerComponent = BYTES_PER_COMPONENT[accessor.componentType ?? 0];
    assert.ok(componentCount, `${label}: accessor ${accessorIndex} has unsupported type ${accessor.type}`);
    assert.ok(bytesPerComponent, `${label}: accessor ${accessorIndex} has unsupported component type ${accessor.componentType}`);

    const elementSize = componentCount * bytesPerComponent;
    const byteStride = bufferView.byteStride ?? elementSize;
    const byteOffset = accessor.byteOffset ?? 0;
    const count = accessor.count ?? 0;
    const requiredBytes = count === 0 ? byteOffset : byteOffset + elementSize + (count - 1) * byteStride;

    assert.ok(byteStride >= elementSize, `${label}: accessor ${accessorIndex} byteStride is smaller than element size`);
    assert.ok(
      requiredBytes <= (bufferView.byteLength ?? 0),
      `${label}: accessor ${accessorIndex} exceeds its bufferView length`,
    );
  }
}

function validatePrimitiveIndices(gltf: GltfLike, label: string): void {
  for (const [meshIndex, mesh] of (gltf.meshes ?? []).entries()) {
    for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
      const positionAccessorIndex = primitive.attributes?.POSITION;
      const indicesAccessorIndex = primitive.indices;
      assert.notEqual(positionAccessorIndex, undefined, `${label}: mesh ${meshIndex} primitive ${primitiveIndex} is missing POSITION`);
      assert.notEqual(indicesAccessorIndex, undefined, `${label}: mesh ${meshIndex} primitive ${primitiveIndex} is missing indices`);

      const positionAccessor = gltf.accessors?.[positionAccessorIndex as number];
      const indicesAccessor = gltf.accessors?.[indicesAccessorIndex as number];
      assert.ok(positionAccessor, `${label}: mesh ${meshIndex} primitive ${primitiveIndex} references missing POSITION accessor`);
      assert.ok(indicesAccessor, `${label}: mesh ${meshIndex} primitive ${primitiveIndex} references missing index accessor`);

      const positionCount = positionAccessor?.count ?? 0;
      const maxIndex = indicesAccessor?.max?.[0];
      const minIndex = indicesAccessor?.min?.[0];
      if (minIndex !== undefined) {
        assert.ok(minIndex >= 0, `${label}: mesh ${meshIndex} primitive ${primitiveIndex} has negative index`);
      }
      if (maxIndex !== undefined) {
        assert.ok(
          maxIndex < positionCount,
          `${label}: mesh ${meshIndex} primitive ${primitiveIndex} has index ${maxIndex} outside vertex count ${positionCount}`,
        );
      }
    }
  }
}

async function loadJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

async function main(): Promise<void> {
  const workspaceRoot = resolveWorkspaceRoot();
  const bbmodelPath = process.argv[2]
    ? resolve(process.argv[2])
    : resolveDefaultModelPath(workspaceRoot);
  const blockbenchGltfPath = process.argv[3]
    ? resolve(process.argv[3])
    : resolveDefaultBlockbenchGltfPath(workspaceRoot);

  const model = await loadBBModel(bbmodelPath);
  const sceneElements = buildSceneElements(model);

  const generated = generateGltfData(
    resolve("compare-output.gltf"),
    model,
    sceneElements,
    DEFAULT_SCALE,
    DEFAULT_EXPORT_OPTIONS,
  );

  const blockbenchGltf = await loadJsonFile<GltfLike>(blockbenchGltfPath);
  const bbextGltf = JSON.parse(generated.gltf) as GltfLike;

  validateAccessorLayouts(blockbenchGltf, "blockbench gltf");
  validateAccessorLayouts(bbextGltf, "bbext gltf");
  validatePrimitiveIndices(blockbenchGltf, "blockbench gltf");
  validatePrimitiveIndices(bbextGltf, "bbext gltf");

  const expected = summarizeGltf(blockbenchGltf);
  const actual = summarizeGltf(bbextGltf);

  assert.equal(actual.sceneRootCount, expected.sceneRootCount, "scene root node count differs");
  assert.equal(actual.meshCount, expected.meshCount, "mesh count differs");
  assert.equal(actual.primitiveCount, expected.primitiveCount, "primitive count differs");
  assert.equal(actual.skinCount, expected.skinCount, "skin count differs");
  assert.deepEqual(actual.jointsPerSkin, expected.jointsPerSkin, "joints per skin differs");
  assert.equal(actual.materialCount, expected.materialCount, "material count differs");
  assert.equal(actual.textureCount, expected.textureCount, "texture count differs");
  assert.equal(actual.animationCount, expected.animationCount, "animation count differs");
  assert.deepEqual(actual.animationNames, expected.animationNames, "animation names differ");
  assert.deepEqual(actual.channelsPerAnimation, expected.channelsPerAnimation, "channels per animation differ");
  assert.deepEqual(actual.channelPathsPerAnimation, expected.channelPathsPerAnimation, "animation channel paths differ");
  assertHistogramEqual(actual.accessorTypeCount, expected.accessorTypeCount, "accessor type histogram differs");

  // Embedded texture parity for this fixture.
  assert.equal(actual.embeddedImageCount, expected.embeddedImageCount, "embedded image count differs");
  assert.equal(actual.externalImageCount, expected.externalImageCount, "external image count differs");

  // Helpful output for CI/terminal.
  const modelName = basename(bbmodelPath);
  const gltfName = basename(blockbenchGltfPath);
  console.log(`OK: ${modelName} matches structure of ${gltfName} (Blockbench vs bbext).`);
}

main().catch((error: unknown) => {
  console.error("GLTF comparison failed.");
  console.error(error);
  process.exitCode = 1;
});
