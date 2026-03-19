#!/usr/bin/env bun

import { resolve } from "node:path";
import { convertBBModelsRecursively } from "@bbext/lib";

interface CliOptions {
  inputPath: string;
  outputPath: string;
  ext: "obj" | "gltf" | "gltf-three" | "fbx";
  scale: number;
  splitByTexture: boolean;
  splitByAllDeclaredTextures: boolean;
  organizeByModel?: "file-name" | "model-id";
  modelScale?: number;
  embedTextures: boolean;
  exportGroupsAsArmature: boolean;
  exportAnimations: boolean;
  overwrite: boolean;
}

function printHelp(): void {
  console.log(`bbext - Recursive .bbmodel exporter\n
Usage:
  bbext --input <file-or-folder> --output <destination-folder> [options]

Options:
  --input, -i       .bbmodel file or root folder for recursive scanning
  --output, -o      Output folder
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
  --help, -h        Show this help

Example:
  bbext -i ./models -o ./exports -e gltf --model-scale 0.0625 --embed-textures --export-groups-as-armature --export-animations --overwrite
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    ext: "obj",
    scale: 1 / 16,
    splitByTexture: false,
    splitByAllDeclaredTextures: false,
    organizeByModel: undefined,
    embedTextures: false,
    exportGroupsAsArmature: false,
    exportAnimations: false,
    overwrite: false,
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
    if (arg === "--ext" || arg === "-e") {
      const extValue = (argv[i + 1] ?? "").toLowerCase();
      if (extValue === "obj" || extValue === "gltf" || extValue === "gltf-three" || extValue === "fbx") {
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.inputPath) {
    throw new Error("Provide --input.");
  }
  if (!options.outputPath) {
    throw new Error("Provide --output.");
  }
  if (options.ext !== "obj" && options.ext !== "gltf" && options.ext !== "gltf-three" && options.ext !== "fbx") {
    throw new Error(`Unsupported extension '${options.ext}'. Use --ext obj|gltf|gltf-three|fbx.`);
  }

  return {
    inputPath: resolve(options.inputPath),
    outputPath: resolve(options.outputPath),
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
  };
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const converted = await convertBBModelsRecursively({
      inputPath: options.inputPath,
      outputPath: options.outputPath,
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
      },
    });

    if (converted.length === 0) {
      console.log("No files were exported.");
      console.log("Check your input path, filters/options, and use --overwrite if needed.");
      return;
    }

    console.log(`Conversion completed: ${converted.length} file(s).`);
    for (const item of converted) {
      console.log(`- ${item.source} -> ${item.output}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    console.error("Use --help to see the available parameters.");
    process.exit(1);
  }
}

await main();
