// Types
export type { GltfData, GltfExportOptions, GltfPrimitiveBuild, GroupNodeInfo, MeshInput } from "./types";

// Core functions
export { generateGltfData } from "./core";
export { writeGltfOutput } from "./writer";

// Math utilities
export {
  computePositionMinMax,
  computeNormal,
  degreesToQuatXYZ,
  vec3Equals,
  quatEquals,
  vec3IsZero,
  lerp,
  lerpVec3,
  catmullRomValue,
  catmullRomVec3,
  vec3DistanceSquared,
  quaternionToMatrix,
  composeMatrix,
  multiplyMatrices,
  invertTrsMatrix,
  translationBetween,
} from "./math";

// Animation utilities
export {
  keyframeVec3,
  finiteVec3,
  simplifySampledVec3,
  animationLengthOrLastKeyframe,
  trackNeedsSampling,
  sampleTrackVec3,
  sampleRotationTrack,
  normalizeTracks,
} from "./animations";

// Group utilities
export { getGroupLookup, buildGroupNodes, getBindMatrixInverse } from "./groups";

// Buffer utilities
export { padTo4, concatUint8 } from "./buffers";

// Constants
export { GLTF_ANIMATION_SAMPLE_RATE, GLTF_ANIMATION_MAX_SAMPLES, SAMPLE_EPSILON } from "./constants";
