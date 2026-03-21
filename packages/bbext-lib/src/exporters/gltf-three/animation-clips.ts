import {
  AnimationClip,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
  type Bone,
  type KeyframeTrack,
} from "three";
import type { BBAnimation, BBAnimationKeyframe, BBModel } from "../../types";
import { normalizeTracks, sampleRotationTrack, sampleTrackVec3 } from "../gltf/animations";

function groupKeyframesByChannel(keyframes: BBAnimationKeyframe[]): Map<string, BBAnimationKeyframe[]> {
  const byChannel = new Map<string, BBAnimationKeyframe[]>();
  for (const keyframe of keyframes) {
    const channel = keyframe.channel ?? "rotation";
    const list = byChannel.get(channel);
    if (list) {
      list.push(keyframe);
    } else {
      byChannel.set(channel, [keyframe]);
    }
  }

  for (const list of byChannel.values()) {
    list.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  }

  return byChannel;
}

export function buildAnimationClips(
  model: BBModel,
  boneByUuid: Map<string, Bone>,
  boneByName: Map<string, Bone>,
  modelScale: number,
): AnimationClip[] {
  const clips: AnimationClip[] = [];

  for (const animation of model.animations ?? []) {
    const tracks: KeyframeTrack[] = [];

    for (const entry of normalizeTracks(animation as BBAnimation)) {
      const track = entry.track;
      const targetBone = boneByUuid.get(entry.key)
        ?? (track?.name ? boneByName.get(track.name) : undefined)
        ?? boneByName.get(entry.key);

      if (!targetBone || !Array.isArray(track?.keyframes) || track.keyframes.length === 0) {
        continue;
      }

      const keyframesByChannel = groupKeyframesByChannel(track.keyframes);

      const positionKeyframes = keyframesByChannel.get("position");
      if (positionKeyframes && positionKeyframes.length > 0) {
        const samples = sampleTrackVec3(animation as BBAnimation, positionKeyframes, [0, 0, 0]);
        if (samples.length > 0) {
          const times = new Float32Array(samples.map((sample) => sample.time));
          const values = new Float32Array(samples.flatMap((sample) => [
            sample.value[0] * modelScale,
            sample.value[1] * modelScale,
            sample.value[2] * modelScale,
          ]));
          tracks.push(new VectorKeyframeTrack(`${targetBone.uuid}.position`, times, values));
        }
      }

      const scaleKeyframes = keyframesByChannel.get("scale");
      if (scaleKeyframes && scaleKeyframes.length > 0) {
        const samples = sampleTrackVec3(animation as BBAnimation, scaleKeyframes, [1, 1, 1]);
        if (samples.length > 0) {
          const times = new Float32Array(samples.map((sample) => sample.time));
          const values = new Float32Array(samples.flatMap((sample) => [
            sample.value[0],
            sample.value[1],
            sample.value[2],
          ]));
          tracks.push(new VectorKeyframeTrack(`${targetBone.uuid}.scale`, times, values));
        }
      }

      const rotationKeyframes = keyframesByChannel.get("rotation") ?? keyframesByChannel.get("quaternion");
      if (rotationKeyframes && rotationKeyframes.length > 0) {
        const samples = sampleRotationTrack(animation as BBAnimation, rotationKeyframes);
        if (samples.length > 0) {
          const times = new Float32Array(samples.map((sample) => sample.time));
          const values = new Float32Array(samples.flatMap((sample) => [
            sample.value[0],
            sample.value[1],
            sample.value[2],
            sample.value[3],
          ]));
          tracks.push(new QuaternionKeyframeTrack(`${targetBone.uuid}.quaternion`, times, values));
        }
      }
    }

    if (tracks.length > 0) {
      const duration = Number(animation.length ?? -1);
      clips.push(new AnimationClip(animation.name ?? "animation", duration > 0 ? duration : -1, tracks));
    }
  }

  return clips;
}
