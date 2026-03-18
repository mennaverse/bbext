export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface BBTexture {
  id?: string;
  uuid?: string;
  name?: string;
  source?: string;
  path?: string;
}

export interface BBFace {
  uv?: [number, number, number, number];
  texture?: string | number;
  rotation?: number;
}

export interface BBElement {
  uuid?: string;
  name?: string;
  from: Vec3;
  to: Vec3;
  origin?: Vec3;
  rotation?: Vec3;
  faces?: Partial<Record<FaceName, BBFace>>;
}

export type BBOutlinerNode = string | BBGroup;

export interface BBGroup {
  uuid?: string;
  name?: string;
  origin?: Vec3;
  rotation?: Vec3;
  children?: BBOutlinerNode[];
}

export interface BBAnimationKeyframePoint {
  x?: number;
  y?: number;
  z?: number;
  vector?: Vec3;
}

export interface BBAnimationKeyframe {
  channel?: "rotation" | "position" | "scale" | string;
  time?: number;
  x?: number;
  y?: number;
  z?: number;
  data_points?: BBAnimationKeyframePoint[];
}

export interface BBAnimationTrack {
  name?: string;
  type?: string;
  keyframes?: BBAnimationKeyframe[];
}

export interface BBAnimation {
  name?: string;
  length?: number;
  animators?: Record<string, BBAnimationTrack>;
  bones?: Record<string, BBAnimationTrack>;
}

export interface BBModel {
  name?: string;
  resolution?: {
    width?: number;
    height?: number;
  };
  textures?: BBTexture[];
  elements?: BBElement[];
  outliner?: BBOutlinerNode[];
  animations?: BBAnimation[];
}

export type FaceName = "north" | "south" | "east" | "west" | "up" | "down";

export interface SceneElement {
  element: BBElement;
  transforms: Transform[];
  groupPath: string[];
}

export interface Transform {
  origin: Vec3;
  rotation: Vec3;
}

export interface ExportOptions {
  outputExtension: "obj" | "gltf" | "fbx";
  scale: number;
  overwrite: boolean;
  splitByTexture?: boolean;
  gltf?: {
    modelScale?: number;
    embedTextures?: boolean;
    exportGroupsAsArmature?: boolean;
    exportAnimations?: boolean;
  };
}

export interface ConvertResult {
  source: string;
  output: string;
}
