import { readFile } from "node:fs/promises";
import type { BBElement, BBModel, BBOutlinerNode, SceneElement, Transform, Vec3 } from "./types";

function toVec3(input: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(input) || input.length < 3) {
    return fallback;
  }
  const x = Number(input[0]);
  const y = Number(input[1]);
  const z = Number(input[2]);
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
    return fallback;
  }
  return [x, y, z];
}

export async function loadBBModel(filePath: string): Promise<BBModel> {
  const raw = await readFile(filePath, "utf8");
  const normalized = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const parsed = JSON.parse(normalized) as BBModel;

  // Compatibility pass inspired by Blockbench's project codec.
  if ((!parsed.elements || parsed.elements.length === 0) && Array.isArray(parsed.cubes)) {
    parsed.elements = parsed.cubes;
  }
  if (!parsed.model_identifier && parsed.geometry_name) {
    parsed.model_identifier = parsed.geometry_name;
  }
  if (Array.isArray(parsed.textures)) {
    for (const texture of parsed.textures) {
      if (!texture.path && texture.relative_path) {
        texture.path = texture.relative_path;
      }
    }
  }

  return parsed;
}

function collectElementsFromOutliner(
  nodes: BBOutlinerNode[],
  byUuid: Map<string, BBElement>,
  groupsByUuid: Map<string, BBOutlinerNode>,
  inheritedTransforms: Transform[],
  groupPath: string[],
  out: SceneElement[],
): void {
  function collectGroup(
    groupNode: Exclude<BBOutlinerNode, string>,
    inheritedGroupTransforms: Transform[],
    inheritedGroupPath: string[],
  ): void {
    const resolvedByUuid = groupNode.uuid ? groupsByUuid.get(groupNode.uuid) : undefined;
    const resolvedGroup = (resolvedByUuid && typeof resolvedByUuid !== "string") ? resolvedByUuid : groupNode;
    const children = Array.isArray(groupNode.children)
      ? groupNode.children
      : Array.isArray(resolvedGroup.children)
        ? resolvedGroup.children
        : [];
    const groupName = resolvedGroup.name ?? groupNode.name ?? "group";
    const nextGroupPath = [...inheritedGroupPath, groupName];
    const groupRotation = toVec3(resolvedGroup.rotation, [0, 0, 0]);
    const groupOrigin = toVec3(resolvedGroup.origin, [0, 0, 0]);

    let nextTransforms = inheritedGroupTransforms;
    if (groupRotation.some((value) => value !== 0)) {
      nextTransforms = [...inheritedGroupTransforms, { origin: groupOrigin, rotation: groupRotation }];
    }

    collectElementsFromOutliner(children, byUuid, groupsByUuid, nextTransforms, nextGroupPath, out);
  }

  for (const node of nodes) {
    if (typeof node === "string") {
      const element = byUuid.get(node);
      if (element) {
        const elementRotation = toVec3(element.rotation, [0, 0, 0]);
        const elementOrigin = toVec3(element.origin, [0, 0, 0]);
        const elementTransforms = [...inheritedTransforms];
        if (elementRotation.some((value) => value !== 0)) {
          elementTransforms.push({
            origin: elementOrigin,
            rotation: elementRotation,
          });
        }
        out.push({
          element,
          transforms: elementTransforms,
          groupPath,
        });
        continue;
      }

      const referencedGroup = groupsByUuid.get(node);
      if (referencedGroup && typeof referencedGroup !== "string") {
        collectGroup(referencedGroup, inheritedTransforms, groupPath);
      }
      continue;
    }

    collectGroup(node, inheritedTransforms, groupPath);
  }
}

export function buildSceneElements(model: BBModel): SceneElement[] {
  const elements = Array.isArray(model.elements) ? model.elements : [];
  const byUuid = new Map<string, BBElement>();
  const groupsByUuid = new Map<string, BBOutlinerNode>();

  for (const element of elements) {
    if (element.uuid) {
      byUuid.set(element.uuid, element);
    }
  }
  for (const group of model.groups ?? []) {
    if (group.uuid) {
      groupsByUuid.set(group.uuid, group);
    }
  }

  const sceneElements: SceneElement[] = [];
  const outliner = Array.isArray(model.outliner) ? model.outliner : [];

  if (outliner.length > 0 && byUuid.size > 0) {
    collectElementsFromOutliner(outliner, byUuid, groupsByUuid, [], [], sceneElements);
    if (sceneElements.length > 0) {
      return sceneElements;
    }
  }

  // Fallback for models without outliner linkage.
  for (const element of elements) {
    const rotation = toVec3(element.rotation, [0, 0, 0]);
    const origin = toVec3(element.origin, [0, 0, 0]);
    const transforms: Transform[] = [];
    if (rotation.some((value) => value !== 0)) {
      transforms.push({ origin, rotation });
    }
    sceneElements.push({ element, transforms, groupPath: [] });
  }

  return sceneElements;
}
