import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import assert from "node:assert/strict";
import { buildSceneElements, loadBBModel } from "../src/bbmodel";
import { generateGltfThreeData } from "../src/exporters/gltf-three";
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
  meshes?: Array<{ primitives?: unknown[] }>;
  skins?: Array<{ joints?: number[] }>;
  materials?: unknown[];
  textures?: unknown[];
  animations?: Array<{ name?: string; channels?: Array<{ target?: { path?: string } }> }>;
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
  animationCount: number;
  animationNames: string[];
  channelsPerAnimation: number[];
  channelPathsPerAnimation: string[];
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
    animationCount: animations.length,
    animationNames,
    channelsPerAnimation,
    channelPathsPerAnimation,
  };
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
  const modelWithoutTextures = JSON.parse(JSON.stringify(model)) as typeof model;
  modelWithoutTextures.textures = [];

  for (const element of modelWithoutTextures.elements ?? []) {
    if (element.faces) {
      for (const face of Object.values(element.faces)) {
        if (face) {
          delete face.texture;
        }
      }
    }

    const maybeMesh = element as unknown as {
      faces?: Record<string, { texture?: string | number }>;
    };
    for (const meshFace of Object.values(maybeMesh.faces ?? {})) {
      delete meshFace.texture;
    }
  }

  const sceneElements = buildSceneElements(modelWithoutTextures);

  const generated = await generateGltfThreeData(
    resolve("compare-output-three.gltf"),
    modelWithoutTextures,
    sceneElements,
    DEFAULT_SCALE,
    {
      ...DEFAULT_EXPORT_OPTIONS,
      // Keep this false in automated comparison to avoid platform-specific image embedding issues.
      embedTextures: false,
      sourceFilePath: bbmodelPath,
    },
  );

  const blockbenchGltf = await loadJsonFile<GltfLike>(blockbenchGltfPath);
  const bbextGltf = JSON.parse(generated.gltf) as GltfLike;

  const expected = summarizeGltf(blockbenchGltf);
  const actual = summarizeGltf(bbextGltf);

  // Structural parity checks (less strict than canonical exporter due different internals in three exporter).
  assert.equal(actual.sceneRootCount, expected.sceneRootCount, "scene root node count differs");
  assert.equal(actual.meshCount, expected.meshCount, "mesh count differs");
  assert.equal(actual.primitiveCount, expected.primitiveCount, "primitive count differs");
  assert.equal(actual.skinCount, expected.skinCount, "skin count differs");
  assert.deepEqual(actual.jointsPerSkin, expected.jointsPerSkin, "joints per skin differs");
  assert.equal(actual.animationCount, expected.animationCount, "animation count differs");
  assert.deepEqual(actual.animationNames, expected.animationNames, "animation names differ");
  assert.deepEqual(actual.channelsPerAnimation, expected.channelsPerAnimation, "channels per animation differ");
  assert.deepEqual(actual.channelPathsPerAnimation, expected.channelPathsPerAnimation, "animation channel paths differ");

  // Material count should remain present even without texture maps.
  assert.ok(actual.materialCount >= 1, "material count should be at least 1");

  const modelName = basename(bbmodelPath);
  const gltfName = basename(blockbenchGltfPath);
  console.log(`OK: ${modelName} matches structural expectations of ${gltfName} (Blockbench vs bbext gltf-three).`);
}

main().catch((error: unknown) => {
  console.error("GLTF-three comparison failed.");
  console.error(error);
  process.exitCode = 1;
});
