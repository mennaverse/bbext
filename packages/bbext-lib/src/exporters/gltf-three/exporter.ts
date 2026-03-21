import { GLTFExporter } from "node-three-gltf";
import type { BBModel, SceneElement } from "../../types";
import { modelFileNameFromPath } from "../shared";
import { writeGltfOutput } from "../gltf";
import { buildThreeScene } from "./scene";
import { rewriteImageUris } from "./textures";
import type { GltfThreeData, GltfThreeExportOptions } from "./types";

function decodeBase64DataUri(dataUri: string): Uint8Array | null {
  const marker = "base64,";
  const markerIndex = dataUri.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const base64 = dataUri.slice(markerIndex + marker.length);
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function extractBinFromJson(gltfJson: Record<string, unknown>, modelName: string): Uint8Array | null {
  const buffers = gltfJson.buffers as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(buffers) || buffers.length === 0) {
    return null;
  }

  const first = buffers[0];
  const uri = typeof first.uri === "string" ? first.uri : undefined;
  if (!uri?.startsWith("data:")) {
    return null;
  }

  const bytes = decodeBase64DataUri(uri);
  if (!bytes) {
    return null;
  }

  first.uri = `${modelName}.bin`;
  return bytes;
}

export async function generateGltfThreeData(
  outputFilePath: string,
  model: BBModel,
  sceneElements: SceneElement[],
  scale: number,
  options: GltfThreeExportOptions = {},
  textureKeys?: Set<string>,
): Promise<GltfThreeData> {
  const modelScale = options.modelScale ?? scale;
  const modelName = modelFileNameFromPath(outputFilePath);

  const built = await buildThreeScene(
    model,
    sceneElements,
    modelScale,
    options.sourceFilePath,
    {
      exportGroupsAsArmature: options.exportGroupsAsArmature,
      exportAnimations: options.exportAnimations,
    },
    textureKeys,
  );

  const exporter = new GLTFExporter();
  const gltfJson = await exporter.parseAsync(built.scene, {
    binary: false,
    trs: true,
    onlyVisible: false,
    embedImages: Boolean(options.embedTextures),
    animations: built.animations,
  }) as Record<string, unknown>;

  const bin = extractBinFromJson(gltfJson, modelName);

  if (!options.embedTextures) {
    rewriteImageUris(gltfJson, modelName, built.textureKeyByImageName);
  }

  gltfJson.asset = {
    ...(typeof gltfJson.asset === "object" && gltfJson.asset !== null ? gltfJson.asset as Record<string, unknown> : {}),
    generator: "bbext node-three-gltf",
  };

  return {
    gltf: `${JSON.stringify(gltfJson, null, 2)}\n`,
    bin,
    embeddedTextures: built.embeddedTextures,
    shouldWriteExternalTextures: !Boolean(options.embedTextures),
  };
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
