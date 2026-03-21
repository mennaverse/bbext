import type { BBModel } from "../../types";

export interface GltfThreeExportOptions {
  modelScale?: number;
  embedTextures?: boolean;
  exportGroupsAsArmature?: boolean;
  exportAnimations?: boolean;
  sourceFilePath?: string;
}

export interface GltfThreeData {
  gltf: string;
  bin: Uint8Array | null;
  embeddedTextures: Array<{ name: string; bytes: Uint8Array }>;
  shouldWriteExternalTextures: boolean;
}

export interface GltfThreeBuildContext {
  outputFilePath: string;
  model: BBModel;
  scale: number;
  sourceFilePath?: string;
  textureKeys?: Set<string>;
}
