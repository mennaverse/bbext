import type { BBGroup, Vec3 } from "../../types";
import type { FaceBatch } from "../shared";

export interface GltfPrimitiveBuild {
  materialName: string;
  indices: number[];
}

export interface GltfData {
  gltf: string;
  bin: Uint8Array | null;
  embeddedTextures: Array<{ name: string; bytes: Uint8Array }>;
  shouldWriteExternalTextures: boolean;
}

export interface GltfExportOptions {
  modelScale?: number;
  embedTextures?: boolean;
  exportGroupsAsArmature?: boolean;
  exportAnimations?: boolean;
}

export interface GroupNodeInfo {
  nameToNode: Map<string, number>;
  pathToGroup: Map<string, BBGroup>;
  pathToNode: Map<string, number>;
  pathVisitOrder: Map<string, number>;
  uuidToNode: Map<string, number>;
  bindMatrixByNode: Map<number, number[]>;
  rootGroupNodes: number[];
}

export interface MeshInput {
  nodeName: string;
  meshName: string;
  rootPath: string[];
  translation?: Vec3;
  entries: Array<{ faceBatches: FaceBatch[]; jointIndex: number }>;
  jointNodeIndices: number[];
}
