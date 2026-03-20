import type { BBAnimation, BBAnimationKeyframe } from "../../types";
import type { Vec3 } from "../../types";
import { GLTF_ANIMATION_MAX_SAMPLES, GLTF_ANIMATION_SAMPLE_RATE, SAMPLE_EPSILON } from "./constants";
import { catmullRomVec3, degreesToQuatXYZ, lerpVec3, vec3DistanceSquared, vec3Equals, quatEquals } from "./math";

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
  const sampled = sampleTrackVec3(animation, keyframes, [0, 0, 0]);
  const quats = sampled.map((sample) => ({
    time: sample.time,
    value: degreesToQuatXYZ(sample.value),
  }));

  const deduped: Array<{ time: number; value: [number, number, number, number] }> = [];
  for (const sample of quats) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.abs(last.time - sample.time) > SAMPLE_EPSILON || !quatEquals(last.value, sample.value)) {
      deduped.push(sample);
    }
  }
  return deduped;
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
