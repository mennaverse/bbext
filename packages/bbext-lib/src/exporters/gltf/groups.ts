import type { BBModel, BBOutlinerNode, BBGroup } from "../../types";
import type { GroupNodeInfo } from "./types";
import { composeMatrix, degreesToQuatXYZ, invertTrsMatrix, multiplyMatrices, translationBetween, vec3IsZero } from "./math";

export function getGroupLookup(model: BBModel): Map<string, BBGroup> {
  const lookup = new Map<string, BBGroup>();
  for (const group of model.groups ?? []) {
    if (group.uuid) {
      lookup.set(group.uuid, group);
    }
  }
  return lookup;
}

export function buildGroupNodes(
  model: BBModel,
  outliner: BBOutlinerNode[] | undefined,
  nodes: Array<Record<string, unknown>>,
  scale: number,
): GroupNodeInfo {
  const nameToNode = new Map<string, number>();
  const pathToGroup = new Map<string, BBGroup>();
  const pathToNode = new Map<string, number>();
  const pathVisitOrder = new Map<string, number>();
  const uuidToNode = new Map<string, number>();
  const bindMatrixByNode = new Map<number, number[]>();
  const rootGroupNodes: number[] = [];
  const groupLookup = getGroupLookup(model);
  let visitCounter = 0;

  function visitItem(
    item: BBOutlinerNode,
    path: string[],
    parentGroup: BBGroup | undefined,
    parentWorldMatrix?: number[],
  ): number | undefined {
    if (typeof item === "string") {
      return undefined;
    }

    const resolved = item.uuid ? groupLookup.get(item.uuid) ?? item : item;
    const nodeName = resolved.name ?? item.name ?? "root";
    const nodePath = [...path, nodeName].join("/");
    if (!pathVisitOrder.has(nodePath)) {
      pathVisitOrder.set(nodePath, visitCounter);
      visitCounter += 1;
    }
    const localTranslation = parentGroup
      ? translationBetween(parentGroup.origin, resolved.origin, scale)
      : [0, 0, 0] as any;
    const localRotation = resolved.rotation ?? [0, 0, 0];
    const localMatrix = composeMatrix(localTranslation, localRotation);
    const worldMatrix = parentWorldMatrix ? multiplyMatrices(parentWorldMatrix, localMatrix) : localMatrix;

    const childIndices: number[] = [];
    for (const child of item.children ?? resolved.children ?? []) {
      const childIndex = visitItem(child, [...path, nodeName], resolved, worldMatrix);
      if (typeof childIndex === "number") {
        childIndices.push(childIndex);
      }
    }

    const node: Record<string, unknown> = {
      name: nodeName,
    };
    if (childIndices.length > 0) {
      node.children = childIndices;
    }
    if (!vec3IsZero(localTranslation)) {
      node.translation = [localTranslation[0], localTranslation[1], localTranslation[2]];
    }
    if (!vec3IsZero(localRotation)) {
      node.rotation = degreesToQuatXYZ(localRotation);
    }

    const nodeIndex = nodes.length;
    nodes.push(node);

    if (!nameToNode.has(nodeName)) {
      nameToNode.set(nodeName, nodeIndex);
    }
    if (!pathToNode.has(nodePath)) {
      pathToNode.set(nodePath, nodeIndex);
    }
    if (!pathToGroup.has(nodePath)) {
      pathToGroup.set(nodePath, resolved);
    }
    if (resolved.uuid && !uuidToNode.has(resolved.uuid)) {
      uuidToNode.set(resolved.uuid, nodeIndex);
    }
    bindMatrixByNode.set(nodeIndex, worldMatrix);

    return nodeIndex;
  }

  for (const item of outliner ?? []) {
    const rootNodeIndex = visitItem(item, [], undefined, undefined);
    if (typeof rootNodeIndex === "number") {
      rootGroupNodes.push(rootNodeIndex);
    }
  }

  return {
    nameToNode,
    pathToGroup,
    pathToNode,
    pathVisitOrder,
    uuidToNode,
    bindMatrixByNode,
    rootGroupNodes,
  };
}

export function getBindMatrixInverse(bindMatrix: number[], fallback: number[]): number[] {
  return invertTrsMatrix(bindMatrix ?? fallback).map((value) =>
    Object.is(value, -0) ? 0 : value,
  );
}
