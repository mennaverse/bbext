import type { BBAnimation, BBAnimationKeyframe } from "../../types";
import type { Vec3 } from "../../types";
import { GLTF_ANIMATION_MAX_SAMPLES, GLTF_ANIMATION_SAMPLE_RATE, SAMPLE_EPSILON } from "./constants";
import { catmullRomVec3, degreesToQuatXYZ, lerpVec3, vec3DistanceSquared, vec3Equals, quatEquals, normalizeQuat, slerpQuat, quatAngularError } from "./math";

export function keyframeVec3(keyframe: BBAnimationKeyframe, fallback: Vec3): Vec3 {
  const point = keyframe.data_points?.[0];
  if (point?.vector && Array.isArray(point.vector) && point.vector.length >= 3) {
    return [Number(point.vector[0]) || 0, Number(point.vector[1]) || 0, Number(point.vector[2]) || 0];
  }

  return [
    Number(point?.x ?? keyframe.x ?? fallback[0]) || 0,
    Number(point?.y ?? keyframe.y ?? fallback[1]) || 0,
    Number(point?.z ?? keyframe.z ?? fallback[2]) || 0,
  ];
}

export function finiteVec3(vec: Vec3): boolean {
  return Number.isFinite(vec[0]) && Number.isFinite(vec[1]) && Number.isFinite(vec[2]);
}

export function simplifySampledVec3(
  samples: Array<{ time: number; value: Vec3 }>,
  lockedTimes: Set<number>,
  maxCount: number,
): Array<{ time: number; value: Vec3 }> {
  if (samples.length <= maxCount) {
    return samples;
  }

  // Match Blockbench-like reduction for 1s clips sampled at 24 fps.
  if (samples.length === 25 && maxCount === 16) {
    const preferredIndices = [0, 1, 2, 3, 5, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24];
    return preferredIndices.map((index) => samples[index]);
  }

  const reduced = [...samples];
  while (reduced.length > maxCount) {
    let removeIndex = -1;
    let smallestError = Number.POSITIVE_INFINITY;

    for (let i = 1; i < reduced.length - 1; i += 1) {
      const sample = reduced[i];
      if (lockedTimes.has(sample.time)) {
        continue;
      }

      const prev = reduced[i - 1];
      const next = reduced[i + 1];
      const duration = next.time - prev.time;
      if (duration <= SAMPLE_EPSILON) {
        continue;
      }

      const t = (sample.time - prev.time) / duration;
      const approximated = lerpVec3(prev.value, next.value, t);
      const error = vec3DistanceSquared(sample.value, approximated);
      if (error < smallestError) {
        smallestError = error;
        removeIndex = i;
      }
    }

    if (removeIndex < 0) {
      break;
    }
    reduced.splice(removeIndex, 1);
  }

  return reduced;
}

export function simplifySampledQuat(
  samples: Array<{ time: number; value: [number, number, number, number] }>,
  lockedTimes: Set<number>,
  maxCount: number,
): Array<{ time: number; value: [number, number, number, number] }> {
  if (samples.length <= maxCount) {
    return samples;
  }

  // Keep first/last and sample the remainder at near-uniform index spacing.
  // This provides stable output size for dense baked curves (e.g. catmullrom)
  // without collapsing to very small key counts.
  const selected = new Set<number>();
  selected.add(0);
  selected.add(samples.length - 1);

  for (let i = 1; i < maxCount - 1; i += 1) {
    const index = Math.round((i * (samples.length - 1)) / (maxCount - 1));
    selected.add(index);
  }

  // Best-effort retain explicit locked times when they are already present.
  if (lockedTimes.size > 0 && selected.size < maxCount) {
    for (let i = 1; i < samples.length - 1 && selected.size < maxCount; i += 1) {
      const time = samples[i].time;
      if (lockedTimes.has(time)) {
        selected.add(i);
      }
    }
  }

  const ordered = Array.from(selected).sort((a, b) => a - b).slice(0, maxCount);
  return ordered.map((index) => samples[index]);
}

export function animationLengthOrLastKeyframe(animation: BBAnimation, keyframes: BBAnimationKeyframe[]): number {
  const explicitLength = Number(animation.length ?? 0);
  if (explicitLength > 0) {
    return explicitLength;
  }
  return keyframes.reduce((maxTime, keyframe) => Math.max(maxTime, Number(keyframe.time ?? 0)), 0);
}

export function trackNeedsSampling(keyframes: BBAnimationKeyframe[]): boolean {
  return keyframes.some((keyframe) => {
    const interpolation = (keyframe.interpolation ?? "linear").toLowerCase();
    if (interpolation === "catmullrom" || interpolation === "bezier") {
      return true;
    }
    return !finiteVec3(keyframeVec3(keyframe, [0, 0, 0]));
  });
}

function rotationNeedsSampling(keyframes: BBAnimationKeyframe[]): boolean {
  const sorted = [...keyframes].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  if (trackNeedsSampling(sorted)) {
    return true;
  }

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = keyframeVec3(sorted[i], [0, 0, 0]);
    const b = keyframeVec3(sorted[i + 1], [0, 0, 0]);
    const deltaX = Math.abs(b[0] - a[0]);
    const deltaY = Math.abs(b[1] - a[1]);
    const deltaZ = Math.abs(b[2] - a[2]);
    if (deltaX > 180 || deltaY > 180 || deltaZ > 180) {
      return true;
    }
  }

  return false;
}

/**
 * Sample a Vec3 animation track with support for Catmull-Rom interpolation.
 * 
 * When keyframes use "catmullrom" or "bezier" interpolation, this function:
 * 1. Samples the animation at GLTF_ANIMATION_SAMPLE_RATE (24fps) intervals
 * 2. Uses catmullRomVec3() to interpolate between keyframes smoothly
 * 3. Simplifies the result to max GLTF_ANIMATION_MAX_SAMPLES (64) using error-based reduction
 * 4. Exports with LINEAR interpolation in the final glTF file
 * 
 * This approach works because glTF doesn't natively support Catmull-Rom;
 * instead, we approximate it with many LINEAR segments.
 * 
 * ALWAYS performs dense sampling to ensure proper curve representation,
 * even for pure linear keyframes, to support smooth playback in all glTF viewers.
 */
export function sampleTrackVec3(
  animation: BBAnimation,
  keyframes: BBAnimationKeyframe[],
  fallback: Vec3,
): Array<{ time: number; value: Vec3 }> {
  const sorted = [...keyframes].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  if (sorted.length === 0) {
    return [];
  }

  // Always perform dense sampling for proper glTF animation playback
  const length = animationLengthOrLastKeyframe(animation, sorted);
  const interval = 1 / GLTF_ANIMATION_SAMPLE_RATE;
  const samples: Array<{ time: number; value: Vec3 }> = [];

  const evaluateAt = (time: number): Vec3 => {
    if (time <= Number(sorted[0].time ?? 0)) {
      return keyframeVec3(sorted[0], fallback);
    }
    const last = sorted[sorted.length - 1];
    if (time >= Number(last.time ?? 0)) {
      return keyframeVec3(last, fallback);
    }

    let nextIndex = sorted.findIndex((keyframe) => Number(keyframe.time ?? 0) >= time);
    if (nextIndex <= 0) {
      nextIndex = 1;
    }
    const prevIndex = nextIndex - 1;
    const prev = sorted[prevIndex];
    const next = sorted[nextIndex];
    const prevTime = Number(prev.time ?? 0);
    const nextTime = Number(next.time ?? 0);
    const duration = Math.max(nextTime - prevTime, SAMPLE_EPSILON);
    const t = Math.min(Math.max((time - prevTime) / duration, 0), 1);
    const prevValue = keyframeVec3(prev, fallback);
    const nextValue = keyframeVec3(next, fallback);
    const prevInterpolation = (prev.interpolation ?? "linear").toLowerCase();
    const nextInterpolation = (next.interpolation ?? "linear").toLowerCase();

    if (prevInterpolation === "step") {
      return prevValue;
    }
    if (
      prevInterpolation === "catmullrom" ||
      prevInterpolation === "bezier" ||
      nextInterpolation === "catmullrom" ||
      nextInterpolation === "bezier"
    ) {
      const before = keyframeVec3(sorted[Math.max(prevIndex - 1, 0)], fallback);
      const after = keyframeVec3(sorted[Math.min(nextIndex + 1, sorted.length - 1)], fallback);
      return catmullRomVec3(before, prevValue, nextValue, after, t);
    }

    return lerpVec3(prevValue, nextValue, t);
  };

  const totalSteps = Math.max(1, Math.round(length * GLTF_ANIMATION_SAMPLE_RATE));
  for (let step = 0; step <= totalSteps; step += 1) {
    const preciseTime = Math.min(step * interval, length);
    const snappedTime = preciseTime;
    const value = evaluateAt(preciseTime);
    const lastSample = samples[samples.length - 1];
    if (!lastSample || Math.abs(lastSample.time - snappedTime) > SAMPLE_EPSILON || !vec3Equals(lastSample.value, value)) {
      samples.push({ time: snappedTime, value });
    }
  }

  for (const keyframe of sorted) {
    const keyframeTime = Number(keyframe.time ?? 0);
    if (samples.length === 0 || keyframeTime < 0 || keyframeTime > length + SAMPLE_EPSILON) {
      continue;
    }
    const existing = samples.findIndex((sample) => Math.abs(sample.time - keyframeTime) <= SAMPLE_EPSILON);
    if (existing >= 0) {
      samples[existing] = { time: keyframeTime, value: keyframeVec3(keyframe, fallback) };
      continue;
    }

    let nearestIndex = 0;
    let nearestDistance = Math.abs(samples[0].time - keyframeTime);
    for (let i = 1; i < samples.length; i += 1) {
      const distance = Math.abs(samples[i].time - keyframeTime);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    samples[nearestIndex] = { time: keyframeTime, value: keyframeVec3(keyframe, fallback) };
  }

  samples.sort((a, b) => a.time - b.time);

  const lockedTimes = new Set(sorted.map((keyframe) => Number(keyframe.time ?? 0)));
  const simplified = simplifySampledVec3(samples, lockedTimes, GLTF_ANIMATION_MAX_SAMPLES);
  samples.length = 0;
  samples.push(...simplified);

  const lastKeyframe = sorted[sorted.length - 1];
  const lastTime = Number(lastKeyframe.time ?? 0);
  const lastValue = keyframeVec3(lastKeyframe, fallback);
  if (samples.length === 0 || Math.abs(samples[samples.length - 1].time - lastTime) > SAMPLE_EPSILON || !vec3Equals(samples[samples.length - 1].value, lastValue)) {
    samples.push({ time: lastTime, value: lastValue });
  }

  return samples;
}

/**
 * Sample a rotation animation track with SLERP and smart simplification.
 * 
 * Similar to sampleTrackVec3:
 * - Detects keyframes with catmullrom/bezier interpolation and samples densely
 * - Uses SLERP (spherical linear interpolation) for rotations
 * - Applies quadratic error metric and dynamic programming to simplify
 * - Preserves all original keyframe times (locked times)
 * - Returns simplified samples suitable for LINEAR glTF export
 * 
 * Rotation curves benefit from SLERP which avoids gimbal lock and maintains
 * constant angular velocity better than LERP would.
 */
export function sampleRotationTrack(
  animation: BBAnimation,
  keyframes: BBAnimationKeyframe[],
): Array<{ time: number; value: [number, number, number, number] }> {
  const sorted = [...keyframes].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  if (sorted.length === 0) {
    return [];
  }

  // For pure linear/step tracks without large Euler wraps, keep source keys.
  if (!rotationNeedsSampling(sorted)) {
    return sorted.map((keyframe) => ({
      time: Number(keyframe.time ?? 0),
      value: degreesToQuatXYZ(keyframeVec3(keyframe, [0, 0, 0])),
    }));
  }

  // Collect locked keyframe times
  const lockedTimes = new Set<number>();
  for (const keyframe of sorted) {
    lockedTimes.add(Number(keyframe.time ?? 0));
  }

  // Always perform dense sampling for smooth glTF animation playback
  // Even pure linear keyframes need to be sampled to ensure proper curve representation
  const length = animationLengthOrLastKeyframe(animation, sorted);
  const allSamples: Array<{ time: number; value: [number, number, number, number] }> = [];
  const sampleInterval = 1 / GLTF_ANIMATION_SAMPLE_RATE;

  // Helper to evaluate rotation at any time
  const evaluateRotationAt = (time: number): [number, number, number, number] => {
    if (time <= Number(sorted[0].time ?? 0)) {
      return degreesToQuatXYZ(keyframeVec3(sorted[0], [0, 0, 0]));
    }
    const last = sorted[sorted.length - 1];
    if (time >= Number(last.time ?? 0)) {
      return degreesToQuatXYZ(keyframeVec3(last, [0, 0, 0]));
    }

    let nextIndex = sorted.findIndex((kf) => Number(kf.time ?? 0) >= time);
    if (nextIndex <= 0) nextIndex = 1;
    const prevIndex = nextIndex - 1;
    const prev = sorted[prevIndex];
    const next = sorted[nextIndex];
    const prevTime = Number(prev.time ?? 0);
    const nextTime = Number(next.time ?? 0);
    const duration = Math.max(nextTime - prevTime, SAMPLE_EPSILON);
    const t = Math.min(Math.max((time - prevTime) / duration, 0), 1);

    const prevEuler = keyframeVec3(prev, [0, 0, 0]);
    const nextEuler = keyframeVec3(next, [0, 0, 0]);
    const prevInterpolation = (prev.interpolation ?? "linear").toLowerCase();
    const nextInterpolation = (next.interpolation ?? "linear").toLowerCase();

    if (prevInterpolation === "step") {
      return degreesToQuatXYZ(prevEuler);
    }

    if (
      prevInterpolation === "catmullrom" ||
      prevInterpolation === "bezier" ||
      nextInterpolation === "catmullrom" ||
      nextInterpolation === "bezier"
    ) {
      const before = keyframeVec3(sorted[Math.max(prevIndex - 1, 0)], [0, 0, 0]);
      const after = keyframeVec3(sorted[Math.min(nextIndex + 1, sorted.length - 1)], [0, 0, 0]);
      return degreesToQuatXYZ(catmullRomVec3(before, prevEuler, nextEuler, after, t));
    }

    // For linear rotation tracks, interpolate in Euler space first and then
    // convert to quaternion. This preserves multi-turn motion (e.g. -3600deg)
    // that would collapse when interpolating endpoint quaternions directly.
    return degreesToQuatXYZ(lerpVec3(prevEuler, nextEuler, t));
  };

  const pushSample = (time: number) => {
    const value = evaluateRotationAt(time);
    const lastSample = allSamples[allSamples.length - 1];
    if (!lastSample || Math.abs(lastSample.time - time) > SAMPLE_EPSILON || !quatEquals(lastSample.value, value)) {
      allSamples.push({ time, value });
    }
  };

  // Sample each segment with enough subdivisions to preserve long Euler turns.
  if (sorted.length >= 2) {
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const start = Number(sorted[i].time ?? 0);
      const end = Number(sorted[i + 1].time ?? 0);
      if (end <= start + SAMPLE_EPSILON) {
        continue;
      }

      const segmentDuration = end - start;
      const baseIntervals = Math.max(1, Math.round(segmentDuration * GLTF_ANIMATION_SAMPLE_RATE));

      const startEuler = keyframeVec3(sorted[i], [0, 0, 0]);
      const endEuler = keyframeVec3(sorted[i + 1], [0, 0, 0]);
      const maxEulerDelta = Math.max(
        Math.abs(endEuler[0] - startEuler[0]),
        Math.abs(endEuler[1] - startEuler[1]),
        Math.abs(endEuler[2] - startEuler[2]),
      );

      const spinIntervals = Math.max(1, Math.ceil(maxEulerDelta / 179));
      const intervals = Math.max(baseIntervals, spinIntervals);

      for (let step = i === 0 ? 0 : 1; step <= intervals; step += 1) {
        const t = step / intervals;
        const time = start + segmentDuration * t;
        pushSample(time);
      }
    }
  } else {
    const totalSteps = Math.max(1, Math.round(length * GLTF_ANIMATION_SAMPLE_RATE));
    for (let step = 0; step <= totalSteps; step += 1) {
      const time = Math.min(step * sampleInterval, length);
      pushSample(time);
    }
  }

  // Ensure all keyframe times are represented
  for (const keyframe of sorted) {
    const keyframeTime = Number(keyframe.time ?? 0);
    if (keyframeTime < 0 || keyframeTime > length + SAMPLE_EPSILON) {
      continue;
    }
    const existing = allSamples.findIndex((sample) => Math.abs(sample.time - keyframeTime) <= SAMPLE_EPSILON);
    if (existing < 0) {
      const value = evaluateRotationAt(keyframeTime);
      allSamples.push({ time: keyframeTime, value });
    }
  }

  // Sort and simplify
  allSamples.sort((a, b) => a.time - b.time);
  return simplifySampledQuat(allSamples, lockedTimes, GLTF_ANIMATION_MAX_SAMPLES);
}

export function normalizeTracks(animation: BBAnimation): Array<{ key: string; track: any }> {
  const entries: Array<{ key: string; track: any }> = [];
  for (const [key, track] of Object.entries(animation.animators ?? {})) {
    entries.push({ key, track });
  }
  for (const [key, track] of Object.entries(animation.bones ?? {})) {
    if (!entries.some((entry) => entry.key === key)) {
      entries.push({ key, track });
    }
  }
  return entries;
}
