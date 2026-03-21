import { resolve } from "node:path";

export const DEFAULT_MODEL_FILE = "collectable_base.bbmodel";
export const DEFAULT_BLOCKBENCH_GLTF_FILE = "collectable_base_correct.gltf";

export const DEFAULT_SCALE = 0.0625;

export const DEFAULT_EXPORT_OPTIONS = {
  modelScale: DEFAULT_SCALE,
  embedTextures: true,
  exportGroupsAsArmature: true,
  exportAnimations: true,
} as const;

export function resolveWorkspaceRoot(cwd = process.cwd()): string {
  return resolve(cwd, "..", "..");
}

export function resolveDefaultModelPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, DEFAULT_MODEL_FILE);
}

export function resolveDefaultBlockbenchGltfPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, DEFAULT_BLOCKBENCH_GLTF_FILE);
}
