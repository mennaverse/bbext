#!/usr/bin/env bun

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { convertBBModelsRecursively, type ConvertProgress } from "@bbext/lib";

type OutputExtension = "obj" | "gltf" | "gltf-three" | "fbx";

interface CliOptions {
  inputPath?: string;
  outputPath?: string;
  manifestPath?: string;
  generateManifest: boolean;
  manifestNameBy: "file-name" | "model-id";
  ext: OutputExtension;
  scale: number;
  splitByTexture: boolean;
  splitByAllDeclaredTextures: boolean;
  organizeByModel?: "file-name" | "model-id";
  modelScale?: number;
  embedTextures: boolean;
  exportGroupsAsArmature: boolean;
  exportAnimations: boolean;
  overwrite: boolean;
  cleanOutput: boolean;
  cleanOutputGodot: boolean;
  json: boolean;
}

interface ManifestModelSpec {
  bbmodel: string;
  output: string;
  textureIndex?: number;
  ext?: OutputExtension;
  modelScale?: number;
  embedTextures?: boolean;
  exportGroupsAsArmature?: boolean;
  exportAnimations?: boolean;
  metadata?: unknown;
}

interface ManifestSpec {
  version?: number;
  models: ManifestModelSpec[];
}

interface JsonResultItem {
  model: string;
  output: string;
  metadataJson?: string;
  exported: string[];
  error?: string;
}

interface JsonSummary {
  correct: JsonResultItem[];
  wrong: JsonResultItem[];
}

interface JsonProgressLine {
  type: "progress";
  phase: ConvertProgress["phase"];
  totalModels: number;
  processedModels: number;
  source?: string;
  prefix?: string;
}

function printJsonProgress(progress: ConvertProgress, prefix?: string): void {
  const payload: JsonProgressLine = {
    type: "progress",
    phase: progress.phase,
    totalModels: progress.totalModels,
    processedModels: progress.processedModels,
    source: progress.source,
    prefix,
  };

  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

function printProgress(progress: ConvertProgress, prefix = ""): void {
  const tag = prefix.length > 0 ? `${prefix} ` : "";

  if (progress.phase === "model-processing") {
    const currentModel = progress.processedModels + 1;
    console.log(`${tag}Progress [model-processing] models ${currentModel}/${progress.totalModels} | source ${progress.source ?? "(unknown)"}`);
    return;
  }

  if (progress.phase === "model-completed") {
    console.log(`${tag}Progress [model-completed] models ${progress.processedModels}/${progress.totalModels} | source ${progress.source ?? "(unknown)"}`);
    return;
  }

  if (progress.phase === "done") {
    console.log(`${tag}Progress [done] models ${progress.totalModels}/${progress.totalModels}`);
  }
}

function printHelp(): void {
  console.log(`bbext - Recursive .bbmodel exporter\n
Usage:
  bbext --input <file-or-folder> --output <destination-folder> [options]
  bbext --manifest <bbext-manifest.json> [options]
  bbext --generate-manifest --input <folder-with-bbmodels> [--manifest <target-manifest.json>] [options]

Options:
  --input, -i       .bbmodel file or root folder for recursive scanning
  --output, -o      Output folder
  --manifest, -m    Manifest JSON with per-model bbmodel/output/textureIndex/ext,
                    modelScale/embedTextures/exportGroupsAsArmature/exportAnimations,
                    and metadata
                    In --generate-manifest mode, this is the output manifest file path
  --generate-manifest
                    Generate a basic manifest by scanning .bbmodel files recursively
  --manifest-name-by
                    Name output files by file-name or model-id (default: file-name)
  --ext, -e         3D object extension (obj, gltf, gltf-three, fbx)
  --scale, -s       Numeric scale applied to the model (default: 0.0625)
  --split-by-texture
                    Export each texture as a separate model file
  --split-by-all-declared-textures, -a
                    Export one file per declared texture, even if unused by faces
  --organize-by-model
                    Create a folder per bbmodel using file-name or model-id
  --model-scale     Model scale for glTF export
  --embed-textures  Embed textures in glTF (data URI when available)
  --export-groups-as-armature
                    Export outliner groups as an armature hierarchy in glTF
  --export-animations
                    Export animations present in the bbmodel to glTF
  --overwrite       Overwrite already converted files
  --clean-output    Clear the destination folder before converting
  --clean-output-godot
                    Keep Godot .import files; clean only generated glTF artifacts
  --json            Print final structured JSON report with correct/wrong arrays
  --help, -h        Show this help

Example:
  bbext -i ./models -o ./exports -e gltf --model-scale 0.0625 --embed-textures --export-groups-as-armature --export-animations --overwrite

Manifest example:
  bbext -m ./bbext.manifest.json --json

Manifest generation example:
  bbext --generate-manifest -i ./models -m ./bbext.manifest.json --manifest-name-by model-id
`);
}

function isOutputExtension(value: string): value is OutputExtension {
  return value === "obj" || value === "gltf" || value === "gltf-three" || value === "fbx";
}

function outputExtensionFromPath(filePath: string): OutputExtension | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".obj") {
    return "obj";
  }
  if (ext === ".gltf") {
    return "gltf";
  }
  if (ext === ".fbx") {
    return "fbx";
  }
  return null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    generateManifest: false,
    manifestNameBy: "file-name",
    ext: "obj",
    scale: 1 / 16,
    splitByTexture: false,
    splitByAllDeclaredTextures: false,
    organizeByModel: undefined,
    embedTextures: false,
    exportGroupsAsArmature: false,
    exportAnimations: false,
    overwrite: false,
    cleanOutput: false,
    cleanOutputGodot: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--input" || arg === "-i") {
      options.inputPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      options.outputPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--manifest" || arg === "-m") {
      options.manifestPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--generate-manifest") {
      options.generateManifest = true;
      continue;
    }
    if (arg === "--manifest-name-by") {
      const modeValue = (argv[i + 1] ?? "").toLowerCase();
      if (modeValue === "file-name" || modeValue === "model-id") {
        options.manifestNameBy = modeValue;
      } else {
        throw new Error("Invalid value for --manifest-name-by. Use file-name or model-id.");
      }
      i += 1;
      continue;
    }
    if (arg === "--ext" || arg === "-e") {
      const extValue = (argv[i + 1] ?? "").toLowerCase();
      if (isOutputExtension(extValue)) {
        options.ext = extValue;
      } else {
        options.ext = undefined;
      }
      i += 1;
      continue;
    }
    if (arg === "--scale" || arg === "-s") {
      const value = Number(argv[i + 1]);
      if (Number.isNaN(value) || value <= 0) {
        throw new Error("Invalid value for --scale. Use a positive number.");
      }
      options.scale = value;
      i += 1;
      continue;
    }
    if (arg === "--model-scale") {
      const value = Number(argv[i + 1]);
      if (Number.isNaN(value) || value <= 0) {
        throw new Error("Invalid value for --model-scale. Use a positive number.");
      }
      options.modelScale = value;
      i += 1;
      continue;
    }
    if (arg === "--split-by-texture") {
      options.splitByTexture = true;
      continue;
    }
    if (arg === "--split-by-all-declared-textures" || arg === "-a") {
      options.splitByAllDeclaredTextures = true;
      options.splitByTexture = true;
      continue;
    }
    if (arg === "--organize-by-model") {
      const modeValue = (argv[i + 1] ?? "").toLowerCase();
      if (modeValue === "file-name" || modeValue === "model-id") {
        options.organizeByModel = modeValue;
      } else {
        throw new Error("Invalid value for --organize-by-model. Use file-name or model-id.");
      }
      i += 1;
      continue;
    }
    if (arg === "--embed-textures") {
      options.embedTextures = true;
      continue;
    }
    if (arg === "--export-groups-as-armature") {
      options.exportGroupsAsArmature = true;
      continue;
    }
    if (arg === "--export-animations") {
      options.exportAnimations = true;
      continue;
    }
    if (arg === "--overwrite") {
      options.overwrite = true;
      continue;
    }
    if (arg === "--clean-output") {
      options.cleanOutput = true;
      continue;
    }
    if (arg === "--clean-output-godot") {
      options.cleanOutputGodot = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.ext !== "obj" && options.ext !== "gltf" && options.ext !== "gltf-three" && options.ext !== "fbx") {
    throw new Error(`Unsupported extension '${options.ext}'. Use --ext obj|gltf|gltf-three|fbx.`);
  }

  if (options.generateManifest) {
    if (!options.inputPath) {
      throw new Error("Provide --input with --generate-manifest.");
    }
    if (options.outputPath) {
      throw new Error("--output is not used with --generate-manifest.");
    }
    if (options.cleanOutput || options.cleanOutputGodot) {
      throw new Error("--clean-output and --clean-output-godot are not supported with --generate-manifest.");
    }
  } else if (options.manifestPath) {
    if (options.outputPath) {
      throw new Error("--output is not used with --manifest.");
    }
    if (options.cleanOutput || options.cleanOutputGodot) {
      throw new Error("--clean-output and --clean-output-godot are not supported with --manifest.");
    }
  } else {
    if (!options.inputPath) {
      throw new Error("Provide --input or use --manifest.");
    }
    if (!options.outputPath) {
      throw new Error("Provide --output or use --manifest.");
    }
  }

  if (options.cleanOutput && options.cleanOutputGodot) {
    throw new Error("Use either --clean-output or --clean-output-godot, not both.");
  }

  return {
    inputPath: options.inputPath ? resolve(options.inputPath) : undefined,
    outputPath: options.outputPath ? resolve(options.outputPath) : undefined,
    manifestPath: options.manifestPath ? resolve(options.manifestPath) : undefined,
    generateManifest: Boolean(options.generateManifest),
    manifestNameBy: options.manifestNameBy ?? "file-name",
    ext: options.ext,
    scale: options.scale ?? 1 / 16,
    splitByTexture: Boolean(options.splitByTexture),
    splitByAllDeclaredTextures: Boolean(options.splitByAllDeclaredTextures),
    organizeByModel: options.organizeByModel,
    modelScale: options.modelScale,
    embedTextures: Boolean(options.embedTextures),
    exportGroupsAsArmature: Boolean(options.exportGroupsAsArmature),
    exportAnimations: Boolean(options.exportAnimations),
    overwrite: Boolean(options.overwrite),
    cleanOutput: Boolean(options.cleanOutput),
    cleanOutputGodot: Boolean(options.cleanOutputGodot),
    json: Boolean(options.json),
  };
}

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function removeBOM(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

async function listBBModelsRecursive(inputPath: string): Promise<string[]> {
  const info = await stat(inputPath);
  if (info.isFile()) {
    return extname(inputPath).toLowerCase() === ".bbmodel" ? [resolve(inputPath)] : [];
  }

  const entries = await readdir(inputPath, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const entryPath = join(inputPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await listBBModelsRecursive(entryPath);
      found.push(...nested);
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".bbmodel") {
      found.push(resolve(entryPath));
    }
  }

  return found;
}

function sanitizeManifestName(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "model";
}

async function readModelId(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(removeBOM(raw)) as {
      model_identifier?: unknown;
      identifier?: unknown;
      id?: unknown;
    };

    const modelId = parsed.model_identifier ?? parsed.identifier ?? parsed.id;
    if (typeof modelId !== "string" || modelId.trim().length === 0) {
      return null;
    }

    return modelId.trim();
  } catch {
    return null;
  }
}

async function runGenerateManifest(options: CliOptions): Promise<void> {
  if (!options.inputPath) {
    throw new Error("Internal error: input path not set.");
  }

  const manifestPath = options.manifestPath
    ? options.manifestPath
    : resolve(process.cwd(), "bbext.manifest.json");
  const manifestDir = dirname(manifestPath);

  const bbmodels = await listBBModelsRecursive(options.inputPath);
  const usedNames = new Map<string, number>();

  const models: ManifestModelSpec[] = [];
  for (const modelPath of bbmodels) {
    const baseFileName = basename(modelPath, extname(modelPath));
    const modelId = options.manifestNameBy === "model-id"
      ? await readModelId(modelPath)
      : null;
    const chosenNameRaw = modelId ?? baseFileName;
    const chosenName = sanitizeManifestName(chosenNameRaw);

    const seen = usedNames.get(chosenName) ?? 0;
    const uniqueName = seen === 0 ? chosenName : `${chosenName}_${seen + 1}`;
    usedNames.set(chosenName, seen + 1);

    const bbmodelRelative = normalizeSlashes(relative(manifestDir, modelPath));
    models.push({
      bbmodel: bbmodelRelative,
      output: `exported/${uniqueName}.gltf`,
      modelScale: 1 / 16,
      embedTextures: true,
      exportGroupsAsArmature: false,
      exportAnimations: true,
      metadata: {},
    });
  }

  const manifest: ManifestSpec = {
    version: 1,
    models,
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Manifest generated: ${manifestPath}`);
  console.log(`Models listed: ${models.length}`);
}

function metadataToJsonText(metadata: unknown): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return JSON.stringify(metadata);
}

async function loadManifest(manifestPath: string): Promise<ManifestSpec> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as {
    version?: number;
    models?: unknown;
  };

  if (!Array.isArray(parsed.models)) {
    throw new Error("Invalid manifest: expected a 'models' array.");
  }

  const models: ManifestModelSpec[] = parsed.models.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Invalid manifest model at index ${index}.`);
    }

    const entry = item as {
      bbmodel?: unknown;
      output?: unknown;
      textureIndex?: unknown;
      ext?: unknown;
      modelScale?: unknown;
      embedTextures?: unknown;
      exportGroupsAsArmature?: unknown;
      exportAnimations?: unknown;
      metadata?: unknown;
    };

    if (typeof entry.bbmodel !== "string" || entry.bbmodel.length === 0) {
      throw new Error(`Invalid manifest model at index ${index}: 'bbmodel' must be a non-empty string.`);
    }
    if (typeof entry.output !== "string" || entry.output.length === 0) {
      throw new Error(`Invalid manifest model at index ${index}: 'output' must be a non-empty string.`);
    }
    if (entry.textureIndex !== undefined) {
      if (!Number.isInteger(entry.textureIndex) || Number(entry.textureIndex) < 0) {
        throw new Error(`Invalid manifest model at index ${index}: 'textureIndex' must be an integer >= 0.`);
      }
    }
    if (entry.ext !== undefined) {
      if (typeof entry.ext !== "string" || !isOutputExtension(entry.ext)) {
        throw new Error(`Invalid manifest model at index ${index}: 'ext' must be obj|gltf|gltf-three|fbx.`);
      }
    }
    if (entry.modelScale !== undefined) {
      if (typeof entry.modelScale !== "number" || !Number.isFinite(entry.modelScale) || entry.modelScale <= 0) {
        throw new Error(`Invalid manifest model at index ${index}: 'modelScale' must be a positive number.`);
      }
    }
    if (entry.embedTextures !== undefined && typeof entry.embedTextures !== "boolean") {
      throw new Error(`Invalid manifest model at index ${index}: 'embedTextures' must be boolean.`);
    }
    if (entry.exportGroupsAsArmature !== undefined && typeof entry.exportGroupsAsArmature !== "boolean") {
      throw new Error(`Invalid manifest model at index ${index}: 'exportGroupsAsArmature' must be boolean.`);
    }
    if (entry.exportAnimations !== undefined && typeof entry.exportAnimations !== "boolean") {
      throw new Error(`Invalid manifest model at index ${index}: 'exportAnimations' must be boolean.`);
    }

    return {
      bbmodel: entry.bbmodel,
      output: entry.output,
      textureIndex: entry.textureIndex === undefined ? undefined : Number(entry.textureIndex),
      ext: entry.ext as OutputExtension | undefined,
      modelScale: entry.modelScale,
      embedTextures: entry.embedTextures,
      exportGroupsAsArmature: entry.exportGroupsAsArmature,
      exportAnimations: entry.exportAnimations,
      metadata: entry.metadata,
    };
  });

  return {
    version: parsed.version,
    models,
  };
}

function printJsonSummary(summary: JsonSummary): void {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function runManifestConversion(options: CliOptions): Promise<JsonSummary> {
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

async function runDefaultConversion(options: CliOptions): Promise<JsonSummary> {
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

function fatalError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);

  if (process.argv.includes("--json")) {
    printJsonSummary({
      correct: [],
      wrong: [{
        model: "__cli__",
        output: "",
        exported: [],
        error: message,
      }],
    });
    process.exit(1);
  }

  process.stderr.write(`Error: ${message}\n`);
  process.stderr.write("Use --help to see the available parameters.\n");
  process.exit(1);
}

process.on("uncaughtException", fatalError);
process.on("unhandledRejection", fatalError);

// Safety-net: force-quit after 5 minutes in case async handles keep the loop alive.
const _forceExitTimer = setTimeout(() => {
  process.stderr.write("Error: Process timed out.\n");
  process.exit(1);
}, 5 * 60 * 1000);
_forceExitTimer.unref();

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.generateManifest) {
      await runGenerateManifest(options);
      return;
    }

    const summary = options.manifestPath
      ? await runManifestConversion(options)
      : await runDefaultConversion(options);

    if (options.json) {
      printJsonSummary(summary);
      if (summary.wrong.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    if (summary.correct.length === 0 && summary.wrong.length === 0) {
      console.log("No files were exported.");
      console.log("Check your input path, filters/options, and use --overwrite if needed.");
      return;
    }

    console.log(`Conversion completed: ${summary.correct.length} success(es), ${summary.wrong.length} failure(s).`);
    for (const item of summary.correct) {
      const target = item.exported[0] ?? item.output;
      console.log(`- OK: ${item.model} -> ${target}`);
    }
    for (const item of summary.wrong) {
      console.log(`- FAIL: ${item.model} (${item.error ?? "unknown error"})`);
    }

    if (summary.wrong.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    fatalError(error);
  }
}

main().catch(fatalError);
