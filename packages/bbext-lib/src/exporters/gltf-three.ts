import type { BBModel, SceneElement } from "../types";
import { generateGltfData, writeGltfOutput } from "./gltf";

export interface GltfThreeExportOptions {
  modelScale?: number;
  embedTextures?: boolean;
  exportGroupsAsArmature?: boolean;
  exportAnimations?: boolean;
}

interface GltfThreeData {
  gltf: string;
  bin: Uint8Array | null;
  embeddedTextures: Array<{ name: string; bytes: Uint8Array }>;
  shouldWriteExternalTextures: boolean;
}

export async function generateGltfThreeData(
  outputFilePath: string,
  model: BBModel,
  sceneElements: SceneElement[],
  scale: number,
  options: GltfThreeExportOptions = {},
  textureKeys?: Set<string>,
): Promise<GltfThreeData> {
  return generateGltfData(
    outputFilePath,
    model,
    sceneElements,
    scale,
    {
      modelScale: options.modelScale,
      embedTextures: options.embedTextures,
      exportGroupsAsArmature: options.exportGroupsAsArmature,
      exportAnimations: options.exportAnimations,
    },
    textureKeys,
  );
}

export async function writeGltfThreeOutput(
  sourceFilePath: string,
  destinationGltfPath: string,
  data: GltfThreeData,
  model: BBModel,
  textureKeys?: Set<string>,
): Promise<void> {
  await writeGltfOutput(sourceFilePath, destinationGltfPath, data, model, textureKeys);
}