import { access } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { buildSceneElements, loadBBModel } from "./bbmodel";
import { writeFbxOutput, generateFbxData } from "./exporters/fbx";
import { generateGltfData, writeGltfOutput } from "./exporters/gltf";
import { generateObjData, writeObjOutput } from "./exporters/obj";
import { buildFaceBatches, collectUsedTextureKeys, outputPathWithVariant } from "./exporters/shared";
import { ensureDirForFile, listBBModelsRecursive } from "./files";
import type { ConvertResult, ExportOptions } from "./types";

export interface ConvertRequest {
  inputPath: string;
  outputPath: string;
  options: ExportOptions;
}

function outputPathFromSource(source: string, inputRoot: string, outputRoot: string): string {
  const relBase = relative(inputRoot, source);
  const rel = relBase === "" ? source.split(/[/\\]/).pop() ?? "model.bbmodel" : relBase;
  const dest = rel.replace(/\.bbmodel$/i, ".converted");
  return resolve(outputRoot, dest);
}

export async function convertBBModelsRecursively(request: ConvertRequest): Promise<ConvertResult[]> {
  const absoluteInput = resolve(request.inputPath);
  const inputRoot = absoluteInput.toLowerCase().endsWith(".bbmodel") ? dirname(absoluteInput) : absoluteInput;
  const outputRoot = resolve(request.outputPath);

  const bbmodels = await listBBModelsRecursive(absoluteInput);
  const converted: ConvertResult[] = [];

  for (const source of bbmodels) {
    const baseDestination = outputPathFromSource(source, inputRoot, outputRoot);
    const destination = baseDestination.replace(/\.converted$/i, `.${request.options.outputExtension}`);

    const model = await loadBBModel(source);
    const sceneElements = buildSceneElements(model);
    const faceBatches = buildFaceBatches(model, sceneElements, request.options.gltf?.modelScale ?? request.options.scale);
    const textureVariants = request.options.splitByTexture
      ? collectUsedTextureKeys(faceBatches)
      : ["__all__"];

    for (const textureVariant of textureVariants) {
      const selectedTextureKeys = textureVariant === "__all__" ? undefined : new Set<string>([textureVariant]);
      const currentDestination = textureVariant === "__all__"
        ? destination
        : outputPathWithVariant(destination, textureVariant);

      if (!request.options.overwrite) {
        try {
          await access(currentDestination);
          continue;
        } catch {
          // Destination does not exist; proceed.
        }
      }

      await ensureDirForFile(currentDestination);

      if (request.options.outputExtension === "obj") {
        const objData = generateObjData(currentDestination, model, sceneElements, request.options.scale, selectedTextureKeys);
        await writeObjOutput(source, currentDestination, objData, model, selectedTextureKeys);
      } else if (request.options.outputExtension === "gltf") {
        const gltfData = generateGltfData(
          currentDestination,
          model,
          sceneElements,
          request.options.scale,
          {
            modelScale: request.options.gltf?.modelScale,
            embedTextures: request.options.gltf?.embedTextures,
            exportGroupsAsArmature: request.options.gltf?.exportGroupsAsArmature,
            exportAnimations: request.options.gltf?.exportAnimations,
          },
          selectedTextureKeys,
        );
        await writeGltfOutput(source, currentDestination, gltfData, model, selectedTextureKeys);
      } else {
        const fbxData = generateFbxData(currentDestination, model, sceneElements, request.options.scale, selectedTextureKeys);
        await writeFbxOutput(currentDestination, fbxData);
      }

      converted.push({ source, output: currentDestination });
    }
  }

  return converted;
}
