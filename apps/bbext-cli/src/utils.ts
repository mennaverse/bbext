import { extname } from "node:path";
import type { OutputExtension } from "./types";

export function isOutputExtension(value: string): value is OutputExtension {
  return value === "obj" || value === "gltf" || value === "gltf-three" || value === "fbx";
}

export function outputExtensionFromPath(filePath: string): OutputExtension | null {
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

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function removeBOM(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

export function sanitizeManifestName(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "model";
}

export function metadataToJsonText(metadata: unknown): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  return JSON.stringify(metadata);
}
