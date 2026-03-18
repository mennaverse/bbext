import { writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { BBModel, SceneElement } from "../types";
import {
  buildFaceBatches,
  collectMaterialRefs,
  filterFaceBatches,
  modelFileNameFromPath,
  textureRelativeUri,
  writeTextureFolder,
} from "./shared";

interface ObjExportData {
  obj: string;
  mtl: string;
  textures: Array<{ name: string; bytes: Uint8Array }>;
}

export function generateObjData(
  outputFilePath: string,
  model: BBModel,
  sceneElements: SceneElement[],
  scale: number,
  textureKeys?: Set<string>,
): ObjExportData {
  const modelName = modelFileNameFromPath(outputFilePath);
  const faceBatches = filterFaceBatches(buildFaceBatches(model, sceneElements, scale), { textureKeys });
  const materialRefs = collectMaterialRefs(model, faceBatches);

  const linesObj: string[] = [];
  const linesMtl: string[] = [];

  linesObj.push(`# Exported by bbext`);
  linesObj.push(`mtllib ${modelName}.mtl`);

  let vertexIndex = 1;

  for (const batch of faceBatches) {
    linesObj.push(`usemtl ${batch.materialName}`);

    for (const corner of batch.positions) {
      linesObj.push(`v ${corner[0]} ${corner[1]} ${corner[2]}`);
    }

    for (const uvCoord of batch.uvs) {
      linesObj.push(`vt ${uvCoord[0]} ${uvCoord[1]}`);
    }

    linesObj.push(`f ${vertexIndex}/${vertexIndex} ${vertexIndex + 1}/${vertexIndex + 1} ${vertexIndex + 2}/${vertexIndex + 2}`);
    linesObj.push(`f ${vertexIndex}/${vertexIndex} ${vertexIndex + 2}/${vertexIndex + 2} ${vertexIndex + 3}/${vertexIndex + 3}`);
    vertexIndex += 4;
  }

  for (const material of materialRefs.materials) {
    const materialName = material.materialName;
    const textureKey = material.textureKey;
    linesMtl.push(`newmtl ${materialName}`);
    linesMtl.push("Ka 1.000 1.000 1.000");
    linesMtl.push("Kd 1.000 1.000 1.000");
    linesMtl.push("Ks 0.000 0.000 0.000");

    if (textureKey !== "default") {
      linesMtl.push(`map_Kd ${textureRelativeUri(modelName, textureKey)}`);
    }

    linesMtl.push("");
  }

  return {
    obj: `${linesObj.join("\n")}\n`,
    mtl: `${linesMtl.join("\n")}\n`,
    textures: materialRefs.textureFiles,
  };
}

export async function writeObjOutput(
  sourceFilePath: string,
  destinationObjPath: string,
  data: ObjExportData,
  model: BBModel,
  textureKeys?: Set<string>,
): Promise<void> {
  const modelName = modelFileNameFromPath(destinationObjPath);
  const destinationDir = dirname(destinationObjPath);

  await writeFile(destinationObjPath, data.obj, "utf8");
  await writeFile(join(destinationDir, `${modelName}.mtl`), data.mtl, "utf8");
  await writeTextureFolder(sourceFilePath, destinationDir, modelName, model, data.textures, textureKeys);
}
