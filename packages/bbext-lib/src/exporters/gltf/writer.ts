import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BBModel } from "../../types";
import { modelFileNameFromPath, writeTextureFolder } from "../shared";
import type { GltfData } from "./types";

export async function writeGltfOutput(
  sourceFilePath: string,
  destinationGltfPath: string,
  data: GltfData,
  model: BBModel,
  textureKeys?: Set<string>,
): Promise<void> {
  const modelName = modelFileNameFromPath(destinationGltfPath);
  const destinationDir = dirname(destinationGltfPath);

  await writeFile(destinationGltfPath, data.gltf, "utf8");
  if (data.bin !== null) {
    await writeFile(join(destinationDir, `${modelName}.bin`), data.bin);
  }
  if (data.shouldWriteExternalTextures) {
    await writeTextureFolder(sourceFilePath, destinationDir, modelName, model, data.embeddedTextures, textureKeys);
  }
}
