import { resolve } from "node:path";
import { printHelp } from "./help";
import type { CliOptions } from "./types";
import { isOutputExtension } from "./utils";

export function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    generateManifest: false,
    manifestNameBy: "file-name",
    ext: "obj",
    scale: 1 / 16,
    splitByTexture: false,
    splitByAllDeclaredTextures: false,
    organizeByModel: undefined,
    embedTextures: false,
    exportGroupsAsArmature: undefined,
    exportAnimations: undefined,
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
    exportGroupsAsArmature: options.exportGroupsAsArmature,
    exportAnimations: options.exportAnimations,
    overwrite: Boolean(options.overwrite),
    cleanOutput: Boolean(options.cleanOutput),
    cleanOutputGodot: Boolean(options.cleanOutputGodot),
    json: Boolean(options.json),
  };
}
