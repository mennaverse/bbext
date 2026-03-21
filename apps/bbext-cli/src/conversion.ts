import { dirname, resolve } from "node:path";
import { convertBBModelsRecursively } from "@bbext/lib";
import { loadManifest } from "./manifest";
import { printJsonProgress, printProgress } from "./progress";
import type { CliOptions, JsonResultItem, JsonSummary } from "./types";
import { metadataToJsonText, outputExtensionFromPath } from "./utils";

export async function runManifestConversion(options: CliOptions): Promise<JsonSummary> {
  if (!options.manifestPath) {
    throw new Error("Internal error: manifest path not set.");
  }

  const manifest = await loadManifest(options.manifestPath);
  const manifestDir = dirname(options.manifestPath);
  const outputBaseDir = options.outputPath ? options.outputPath : manifestDir;

  const summary: JsonSummary = {
    correct: [],
    wrong: [],
  };

  for (const [modelIndex, modelSpec] of manifest.models.entries()) {
    const modelPath = resolve(manifestDir, modelSpec.bbmodel);
    const outputPath = resolve(outputBaseDir, modelSpec.output);
    const entryExtension = modelSpec.ext
      ?? outputExtensionFromPath(outputPath)
      ?? options.ext;
    const entryModelScale = modelSpec.modelScale ?? options.modelScale;
    const entryEmbedTextures = modelSpec.embedTextures ?? options.embedTextures;
    const entryExportGroupsAsArmature = modelSpec.exportGroupsAsArmature ?? options.exportGroupsAsArmature;
    const entryExportAnimations = modelSpec.exportAnimations ?? options.exportAnimations;

    const resultBase: JsonResultItem = {
      model: modelSpec.bbmodel,
      output: modelSpec.output,
      metadataJson: metadataToJsonText(modelSpec.metadata),
      exported: [],
    };

    try {
      const progressPrefix = `[manifest ${modelIndex + 1}/${manifest.models.length}]`;
      const converted = await convertBBModelsRecursively({
        inputPath: modelPath,
        outputPath: dirname(outputPath),
        onProgress: (progress) => {
          if (options.json) {
            printJsonProgress(progress, progressPrefix);
          } else {
            printProgress(progress, progressPrefix);
          }
        },
        options: {
          outputExtension: entryExtension,
          explicitOutputFilePath: outputPath,
          forcedTextureIndex: modelSpec.textureIndex,
          scale: options.scale,
          splitByTexture: false,
          splitByAllDeclaredTextures: false,
          organizeByModel: undefined,
          gltf: {
            modelScale: entryModelScale,
            embedTextures: entryEmbedTextures,
            exportGroupsAsArmature: entryExportGroupsAsArmature,
            exportAnimations: entryExportAnimations,
          },
          overwrite: options.overwrite,
          cleanOutput: false,
          cleanOutputGodot: false,
        },
      });

      summary.correct.push({
        ...resultBase,
        exported: converted.map((item) => item.output),
      });
    } catch (error) {
      summary.wrong.push({
        ...resultBase,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

export async function runDefaultConversion(options: CliOptions): Promise<JsonSummary> {
  if (!options.inputPath || !options.outputPath) {
    throw new Error("Internal error: input/output path not set.");
  }

  const converted = await convertBBModelsRecursively({
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    onProgress: (progress) => {
      if (options.json) {
        printJsonProgress(progress);
      } else {
        printProgress(progress);
      }
    },
    options: {
      outputExtension: options.ext,
      scale: options.scale,
      splitByTexture: options.splitByTexture,
      splitByAllDeclaredTextures: options.splitByAllDeclaredTextures,
      organizeByModel: options.organizeByModel,
      gltf: {
        modelScale: options.modelScale,
        embedTextures: options.embedTextures,
        exportGroupsAsArmature: options.exportGroupsAsArmature,
        exportAnimations: options.exportAnimations,
      },
      overwrite: options.overwrite,
      cleanOutput: options.cleanOutput,
      cleanOutputGodot: options.cleanOutputGodot,
    },
  });

  return {
    correct: converted.map((item) => ({
      model: item.source,
      output: item.output,
      exported: [item.output],
    })),
    wrong: [],
  };
}
