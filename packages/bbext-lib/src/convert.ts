import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { buildSceneElements, loadBBModel } from "./bbmodel";
import { writeFbxOutput, generateFbxData } from "./exporters/fbx";
import { generateGltfThreeData, writeGltfThreeOutput } from "./exporters/gltf-three";
import { generateGltfData, writeGltfOutput } from "./exporters/gltf";
import { generateObjData, writeObjOutput } from "./exporters/obj";
import {
  buildFaceBatches,
  collectDeclaredTextureKeys,
  collectUsedTextureKeys,
  getTextureCanonicalKey,
  outputPathWithVariant,
  sanitizeMaterialName,
} from "./exporters/shared";
import { clearDirectory, ensureDirForFile, listBBModelsRecursive } from "./files";
import type { BBModel, ConvertResult, ExportOptions } from "./types";

export interface ConvertRequest {
  inputPath: string;
  outputPath: string;
  options: ExportOptions;
  onProgress?: (progress: ConvertProgress) => void;
}

export interface ConvertProgress {
  phase: "model-processing" | "model-completed" | "done";
  totalModels: number;
  processedModels: number;
  source?: string;
}

interface GodotCleanupManifest {
  version: 1;
  foldersBySource: Record<string, string>;
}

const GODOT_CLEANUP_MANIFEST_FILE = ".bbext-godot-cleanup.json";

function shouldUseGodotCleanup(options: ExportOptions): boolean {
  return Boolean(options.cleanOutputGodot) && (options.outputExtension === "gltf" || options.outputExtension === "gltf-three");
}

function resolveManifestPath(outputRoot: string): string {
  return join(outputRoot, GODOT_CLEANUP_MANIFEST_FILE);
}

async function readGodotCleanupManifest(outputRoot: string): Promise<GodotCleanupManifest> {
  const manifestPath = resolveManifestPath(outputRoot);
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<GodotCleanupManifest>;
    if (parsed.version !== 1 || typeof parsed.foldersBySource !== "object" || parsed.foldersBySource === null) {
      return { version: 1, foldersBySource: {} };
    }

    const sanitizedEntries = Object.entries(parsed.foldersBySource)
      .filter(([source, folder]) => typeof source === "string" && source.length > 0 && typeof folder === "string" && folder.length > 0);
    return {
      version: 1,
      foldersBySource: Object.fromEntries(sanitizedEntries),
    };
  } catch {
    return { version: 1, foldersBySource: {} };
  }
}

async function writeGodotCleanupManifest(outputRoot: string, foldersBySource: Record<string, string>): Promise<void> {
  const manifestPath = resolveManifestPath(outputRoot);
  const manifest: GodotCleanupManifest = {
    version: 1,
    foldersBySource,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

async function removeNonImportFilesRecursive(directoryPath: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryName = String(entry.name);
    const entryPath = join(directoryPath, entryName);
    if (entry.isDirectory()) {
      await removeNonImportFilesRecursive(entryPath);
      try {
        const nestedEntries = await readdir(entryPath, { encoding: "utf8" });
        if (nestedEntries.length === 0) {
          await rm(entryPath, { recursive: false, force: true });
        }
      } catch {
        // Ignore race conditions while pruning.
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }
    if (entryName.toLowerCase().endsWith(".import")) {
      continue;
    }
    await rm(entryPath, { force: true });
  }
}

async function cleanGodotArtifactsForDestination(destinationPath: string): Promise<void> {
  const destinationDir = dirname(destinationPath);
  const destinationName = basename(destinationPath, extname(destinationPath));
  const textureDir = join(destinationDir, `${destinationName}_textures`);

  await rm(destinationPath, { force: true });
  await rm(join(destinationDir, `${destinationName}.bin`), { force: true });
  await removeNonImportFilesRecursive(textureDir);
}

function cloneModelWithForcedTexture(model: BBModel, textureKey: string): BBModel {
  const clone = JSON.parse(JSON.stringify(model)) as BBModel;

  for (const element of clone.elements ?? []) {
    if (element.faces) {
      for (const face of Object.values(element.faces)) {
        if (face) {
          face.texture = textureKey;
        }
      }
    }

    const maybeMesh = element as unknown as {
      type?: string;
      faces?: Record<string, { texture?: string | number }>;
    };
    if (maybeMesh.type === "mesh" && maybeMesh.faces) {
      for (const face of Object.values(maybeMesh.faces)) {
        face.texture = textureKey;
      }
    }
  }

  return clone;
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

function resolveForcedTextureKey(model: BBModel, textureIndex: number): string {
  if (!Number.isInteger(textureIndex) || textureIndex < 0) {
    throw new Error(`Invalid forced texture index '${textureIndex}'. Use an integer >= 0.`);
  }

  const textures = model.textures ?? [];
  const texture = textures[textureIndex];
  if (!texture) {
    throw new Error(`Texture index ${textureIndex} not found for model.`);
  }

  return getTextureCanonicalKey(texture, textureIndex, textures);
}

export async function convertBBModelsRecursively(request: ConvertRequest): Promise<ConvertResult[]> {
  const absoluteInput = resolve(request.inputPath);
  const inputRoot = absoluteInput.toLowerCase().endsWith(".bbmodel") ? dirname(absoluteInput) : absoluteInput;
  const outputRoot = resolve(request.outputPath);
  const useGodotCleanup = shouldUseGodotCleanup(request.options);

  if (request.options.cleanOutput) {
    await clearDirectory(outputRoot);
  }

  // Pre-discovery: collect all bbmodel files first
  const bbmodels = await listBBModelsRecursive(absoluteInput);
  const sourceSet = new Set(bbmodels.map((source) => resolve(source)));
  const foldersBySourceForManifest: Record<string, string> = {};

  if (useGodotCleanup && request.options.organizeByModel) {
    const previousManifest = await readGodotCleanupManifest(outputRoot);
    for (const [source, folderPath] of Object.entries(previousManifest.foldersBySource)) {
      const normalizedSource = resolve(source);
      if (sourceSet.has(normalizedSource)) {
        continue;
      }

      const resolvedFolderPath = resolve(folderPath);
      if (resolvedFolderPath.startsWith(outputRoot)) {
        await rm(resolvedFolderPath, { recursive: true, force: true });
      }
    }
  }

  const converted: ConvertResult[] = [];
  let processedModels = 0;

  const emitProgress = (progress: Omit<ConvertProgress, "totalModels" | "processedModels">): void => {
    request.onProgress?.({
      totalModels: bbmodels.length,
      processedModels,
      ...progress,
    });
  };

  for (const source of bbmodels) {
    emitProgress({ phase: "model-processing", source });
    const model = await loadBBModel(source);
    const explicitOutputPath = request.options.explicitOutputFilePath
      ? resolve(request.options.explicitOutputFilePath)
      : undefined;
    const baseDestination = explicitOutputPath
      ? explicitOutputPath
      : outputPathFromSource(source, inputRoot, outputRoot, model, request.options);
    const outputFileExtension = request.options.outputExtension === "gltf-three"
      ? "gltf"
      : request.options.outputExtension;
    const destination = extname(baseDestination).length > 0
      ? baseDestination
      : `${baseDestination}.${outputFileExtension}`;
    if (useGodotCleanup) {
      const modelFolderPath = dirname(baseDestination);
      foldersBySourceForManifest[resolve(source)] = modelFolderPath;
    }
    const sceneElements = buildSceneElements(model);
    const faceBatches = buildFaceBatches(model, sceneElements, request.options.gltf?.modelScale ?? request.options.scale);
    const forcedTextureKey = request.options.forcedTextureIndex !== undefined
      ? resolveForcedTextureKey(model, request.options.forcedTextureIndex)
      : undefined;
        const textureVariants = request.options.splitByTexture
          ? (() => {
        const keys = request.options.splitByAllDeclaredTextures
          ? collectDeclaredTextureKeys(model)
          : collectUsedTextureKeys(faceBatches);
            return keys.length > 0 ? keys : ["default"];
          })()
          : ["__all__"];
    const finalTextureVariants = forcedTextureKey ? [forcedTextureKey] : textureVariants;

    for (const textureVariant of finalTextureVariants) {
      const selectedTextureKeys = textureVariant === "__all__" ? undefined : new Set<string>([textureVariant]);
      const useExactDestinationForForcedTexture = Boolean(forcedTextureKey && textureVariant === forcedTextureKey);
      const currentDestination = textureVariant === "__all__"
        ? destination
        : useExactDestinationForForcedTexture
          ? destination
        : outputPathWithVariant(destination, textureVariant);
      if (useGodotCleanup) {
        await cleanGodotArtifactsForDestination(currentDestination);
      }
      const shouldRemapToDeclaredTexture = Boolean(
        (request.options.splitByAllDeclaredTextures || forcedTextureKey)
        && textureVariant !== "__all__"
        && selectedTextureKeys
        && faceBatches.length > 0
        && !faceBatches.some((batch) => selectedTextureKeys.has(batch.textureKey)),
      );
      const variantModel = shouldRemapToDeclaredTexture
        ? cloneModelWithForcedTexture(model, textureVariant)
        : model;
      const variantSceneElements = shouldRemapToDeclaredTexture
        ? buildSceneElements(variantModel)
        : sceneElements;

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
        const objData = generateObjData(currentDestination, variantModel, variantSceneElements, request.options.scale, selectedTextureKeys);
        await writeObjOutput(source, currentDestination, objData, variantModel, selectedTextureKeys);
      } else if (request.options.outputExtension === "gltf") {
        const gltfData = generateGltfData(
          currentDestination,
          variantModel,
          variantSceneElements,
          request.options.scale,
          {
            modelScale: request.options.gltf?.modelScale,
            embedTextures: request.options.gltf?.embedTextures,
            exportGroupsAsArmature: request.options.gltf?.exportGroupsAsArmature,
            exportAnimations: request.options.gltf?.exportAnimations,
          },
          selectedTextureKeys,
        );
        await writeGltfOutput(source, currentDestination, gltfData, variantModel, selectedTextureKeys);
      } else if (request.options.outputExtension === "gltf-three") {
        const gltfData = await generateGltfThreeData(
          currentDestination,
          variantModel,
          variantSceneElements,
          request.options.scale,
          {
            modelScale: request.options.gltf?.modelScale,
            embedTextures: request.options.gltf?.embedTextures,
            exportGroupsAsArmature: request.options.gltf?.exportGroupsAsArmature,
            exportAnimations: request.options.gltf?.exportAnimations,
            sourceFilePath: source,
          },
          selectedTextureKeys,
        );
        await writeGltfThreeOutput(source, currentDestination, gltfData, variantModel, selectedTextureKeys);
      } else {
        const fbxData = generateFbxData(currentDestination, variantModel, variantSceneElements, request.options.scale, selectedTextureKeys);
        await writeFbxOutput(currentDestination, fbxData);
      }

      converted.push({ source, output: currentDestination });
    }

    processedModels += 1;
    emitProgress({ phase: "model-completed", source });
  }

  if (useGodotCleanup && request.options.organizeByModel) {
    await writeGodotCleanupManifest(outputRoot, foldersBySourceForManifest);
  }

  emitProgress({ phase: "done", source: undefined });

  return converted;
}
