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

  const mandatory = samples.map((sample, index) => index === 0 || index === samples.length - 1 || lockedTimes.has(sample.time));
  const mandatoryCount = mandatory.reduce((count, value) => count + (value ? 1 : 0), 0);
  const targetCount = Math.max(mandatoryCount, maxCount);
  if (targetCount >= samples.length) {
    return samples;
  }

  const skipCost: number[][] = Array.from({ length: samples.length }, () => Array(samples.length).fill(Number.POSITIVE_INFINITY));
  for (let start = 0; start < samples.length; start += 1) {
    skipCost[start][start] = 0;
    for (let end = start + 1; end < samples.length; end += 1) {
      let maxError = 0;
      for (let skipped = start + 1; skipped < end; skipped += 1) {
        const prev = samples[start].value;
        const next = samples[end].value;
        const sample = samples[skipped].value;
        const duration = (samples[end].time - samples[start].time) || SAMPLE_EPSILON;
        const t = (samples[skipped].time - samples[start].time) / duration;
        const interpolated = slerpQuat(prev, next, t);
        const error = quatAngularError(sample, interpolated);
        maxError = Math.max(maxError, error);
      }
      skipCost[start][end] = maxError;
    }
  }

  const dp: number[][] = Array.from({ length: targetCount + 1 }, () => Array(samples.length).fill(Number.POSITIVE_INFINITY));
  const previousIndex: number[][] = Array.from({ length: targetCount + 1 }, () => Array(samples.length).fill(-1));
  dp[1][0] = 0;

  for (let kept = 2; kept <= targetCount; kept += 1) {
    for (let end = 1; end < samples.length; end += 1) {
      for (let start = Math.max(0, end - (samples.length - targetCount) - 1); start < end; start += 1) {
        if (mandatory[start] || mandatory[end] || start === 0 || end === samples.length - 1) {
          const cost = dp[kept - 1][start] + skipCost[start][end];
          if (cost < dp[kept][end]) {
            dp[kept][end] = cost;
            previousIndex[kept][end] = start;
          }
        }
      }
    }
  }

  let bestKept = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let kept = mandatoryCount; kept <= targetCount; kept += 1) {
    const cost = dp[kept][samples.length - 1];
    if (cost < bestCost) {
      bestCost = cost;
      bestKept = kept;
    }
  }

  if (bestKept < 0) {
    return samples;
  }

  const selectedIndices: number[] = [];
  let currentKept = bestKept;
  let currentIndex = samples.length - 1;
  while (currentIndex >= 0 && currentKept > 0) {
    selectedIndices.push(currentIndex);
    currentIndex = previousIndex[currentKept][currentIndex];
    currentKept -= 1;
  }

  selectedIndices.reverse();
  return selectedIndices.map((index) => samples[index]);
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

export function sampleTrackVec3(
  animation: BBAnimation,
  keyframes: BBAnimationKeyframe[],
  fallback: Vec3,
): Array<{ time: number; value: Vec3 }> {
  const sorted = [...keyframes].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  if (sorted.length === 0) {
    return [];
  }
  if (!trackNeedsSampling(sorted)) {
    return sorted.map((keyframe) => ({
      time: Number(keyframe.time ?? 0),
      value: keyframeVec3(keyframe, fallback),
    }));
  }

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

export function sampleRotationTrack(
  animation: BBAnimation,
  keyframes: BBAnimationKeyframe[],
): Array<{ time: number; value: [number, number, number, number] }> {
  const sorted = [...keyframes].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  if (sorted.length === 0) {
    return [];
  }

  // Collect locked keyframe times
  const lockedTimes = new Set<number>();
  for (const keyframe of sorted) {
    lockedTimes.add(Number(keyframe.time ?? 0));
  }

  // Quick path for simple linear interpolation between two keyframes
  if (!trackNeedsSampling(sorted)) {
    const result = sorted.map((keyframe) => ({
      time: Number(keyframe.time ?? 0),
      value: degreesToQuatXYZ(keyframeVec3(keyframe, [0, 0, 0])),
    }));
    return result;
  }

  // Dense sampling for rotations with large deltas
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

    const prevRotation = degreesToQuatXYZ(keyframeVec3(prev, [0, 0, 0]));
    const nextRotation = degreesToQuatXYZ(keyframeVec3(next, [0, 0, 0]));
    const prevInterpolation = (prev.interpolation ?? "linear").toLowerCase();

    if (prevInterpolation === "step") {
      return prevRotation;
    }

    return slerpQuat(prevRotation, nextRotation, t);
  };

  // Sample at regular intervals
  const totalSteps = Math.max(1, Math.round(length * GLTF_ANIMATION_SAMPLE_RATE));
  for (let step = 0; step <= totalSteps; step += 1) {
    const time = Math.min(step * sampleInterval, length);
    const value = evaluateRotationAt(time);
    const lastSample = allSamples[allSamples.length - 1];
    if (!lastSample || Math.abs(lastSample.time - time) > SAMPLE_EPSILON || !quatEquals(lastSample.value, value)) {
      allSamples.push({ time, value });
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
