import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { CliOptions, ManifestModelSpec, ManifestSpec } from "./types";
import { isOutputExtension, normalizeSlashes, removeBOM, sanitizeManifestName } from "./utils";

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

export async function runGenerateManifest(options: CliOptions): Promise<void> {
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

export async function loadManifest(manifestPath: string): Promise<ManifestSpec> {
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
      ext: entry.ext,
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
