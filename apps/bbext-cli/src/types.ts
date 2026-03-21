import type { ConvertProgress } from "@bbext/lib";

export type OutputExtension = "obj" | "gltf" | "gltf-three" | "fbx";

export interface CliOptions {
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
  exportGroupsAsArmature?: boolean;
  exportAnimations?: boolean;
  overwrite: boolean;
  cleanOutput: boolean;
  cleanOutputGodot: boolean;
  json: boolean;
}

export interface ManifestModelSpec {
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

export interface ManifestSpec {
  version?: number;
  models: ManifestModelSpec[];
}

export interface JsonResultItem {
  model: string;
  output: string;
  metadata?: unknown;
  exported: string[];
  error?: string;
}

export interface JsonSummary {
  correct: JsonResultItem[];
  wrong: JsonResultItem[];
}

export interface JsonProgressLine {
  type: "progress";
  phase: ConvertProgress["phase"];
  totalModels: number;
  processedModels: number;
  source?: string;
  prefix?: string;
}
