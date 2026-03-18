import { access } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { buildSceneElements, loadBBModel } from "./bbmodel";
import { writeFbxOutput, generateFbxData } from "./exporters/fbx";
import { generateGltfData, writeGltfOutput } from "./exporters/gltf";
import { generateObjData, writeObjOutput } from "./exporters/obj";
import {
  buildFaceBatches,
  collectDeclaredTextureKeys,
  collectUsedTextureKeys,
  outputPathWithVariant,
  sanitizeMaterialName,
} from "./exporters/shared";
import { ensureDirForFile, listBBModelsRecursive } from "./files";
import type { BBModel, ConvertResult, ExportOptions } from "./types";

export interface ConvertRequest {
  inputPath: string;
  outputPath: string;
  options: ExportOptions;
}

function resolveModelFolderName(source: string, model: BBModel, mode: ExportOptions["organizeByModel"]): string | null {
  if (!mode) {
    return null;
  }

  const sourceBaseName = basename(source, extname(source));
  if (mode === "file-name") {
    return sanitizeMaterialName(sourceBaseName);
  }

  const modelId = model.model_identifier ?? model.identifier ?? model.id;
  return sanitizeMaterialName(modelId || sourceBaseName);
}

function outputPathFromSource(source: string, inputRoot: string, outputRoot: string, model: BBModel, options: ExportOptions): string {
  const relBase = relative(inputRoot, source);
  const rel = relBase === "" ? source.split(/[/\\]/).pop() ?? "model.bbmodel" : relBase;
  const relDir = dirname(rel);
  const relFileName = basename(rel).replace(/\.bbmodel$/i, ".converted");
  const modelFolderName = resolveModelFolderName(source, model, options.organizeByModel);

  const segments = [outputRoot];
  if (relDir !== ".") {
    segments.push(relDir);
  }
  if (modelFolderName) {
    segments.push(modelFolderName);
  }
  segments.push(relFileName);

  const dest = resolve(...segments);
  return resolve(outputRoot, dest);
}

export async function convertBBModelsRecursively(request: ConvertRequest): Promise<ConvertResult[]> {
  const absoluteInput = resolve(request.inputPath);
  const inputRoot = absoluteInput.toLowerCase().endsWith(".bbmodel") ? dirname(absoluteInput) : absoluteInput;
  const outputRoot = resolve(request.outputPath);

  const bbmodels = await listBBModelsRecursive(absoluteInput);
  const converted: ConvertResult[] = [];

  for (const source of bbmodels) {
    const model = await loadBBModel(source);
    const baseDestination = outputPathFromSource(source, inputRoot, outputRoot, model, request.options);
    const destination = baseDestination.replace(/\.converted$/i, `.${request.options.outputExtension}`);
    const sceneElements = buildSceneElements(model);
    const faceBatches = buildFaceBatches(model, sceneElements, request.options.gltf?.modelScale ?? request.options.scale);
        const textureVariants = request.options.splitByTexture
          ? (() => {
        const keys = request.options.splitByAllDeclaredTextures
          ? collectDeclaredTextureKeys(model)
          : collectUsedTextureKeys(faceBatches);
            return keys.length > 0 ? keys : ["default"];
          })()
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
