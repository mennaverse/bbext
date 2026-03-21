import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  type Material,
} from "three";
import type { BBGroup, BBModel, SceneElement, Vec2, Vec3 } from "../../types";
import {
  buildFaceBatches,
  collectMaterialRefs,
  filterFaceBatches,
} from "../shared";
import { buildGroupNodes } from "../gltf/groups";
import { computeNormal, degreesToQuatXYZ, translationBetween } from "../gltf/math";
import { buildTextureAssets } from "./textures";

function createMaterial(
  materialName: string,
  textureKey: string,
  textureAssets: Awaited<ReturnType<typeof buildTextureAssets>>,
): Material {
  const texture = textureAssets.byTextureKey.get(textureKey)?.texture;
  return new MeshStandardMaterial({
    name: materialName,
    color: 0xffffff,
    map: texture,
    transparent: Boolean(texture),
    alphaTest: texture ? 0.05 : 0,
    metalness: 0,
    roughness: 1,
  });
}

function buildSkinnedGeometry(
  entries: Array<{ faceBatches: ReturnType<typeof buildFaceBatches>; jointIndex: number }>,
  materialIndexByName: Map<string, number>,
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const groups: Array<{ start: number; count: number; materialIndex: number }> = [];

  const materialGrouped = new Map<string, Array<{ positions: Vec3[]; uvs: Vec2[]; jointIndex: number }>>();
  for (const entry of entries) {
    for (const face of entry.faceBatches) {
      const list = materialGrouped.get(face.materialName);
      const payload = { positions: face.positions, uvs: face.uvs, jointIndex: entry.jointIndex };
      if (list) {
        list.push(payload);
      } else {
        materialGrouped.set(face.materialName, [payload]);
      }
    }
  }

  const pushTriangle = (
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    uv0: Vec2,
    uv1: Vec2,
    uv2: Vec2,
    jointIndex: number,
  ): void => {
    const normal = computeNormal(p0, p1, p2);
    positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    normals.push(normal[0], normal[1], normal[2], normal[0], normal[1], normal[2], normal[0], normal[1], normal[2]);
    uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);

    for (let i = 0; i < 3; i += 1) {
      skinIndices.push(jointIndex, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
  };

  let vertexCursor = 0;
  for (const [materialName, faces] of materialGrouped.entries()) {
    const groupStart = vertexCursor;

    for (const face of faces) {
      if (face.positions.length < 3 || face.uvs.length < 3) {
        continue;
      }

      if (face.positions.length === 3) {
        pushTriangle(
          face.positions[0],
          face.positions[1],
          face.positions[2],
          face.uvs[0],
          face.uvs[1],
          face.uvs[2],
          face.jointIndex,
        );
        vertexCursor += 3;
        continue;
      }

      pushTriangle(
        face.positions[0],
        face.positions[1],
        face.positions[2],
        face.uvs[0],
        face.uvs[1],
        face.uvs[2],
        face.jointIndex,
      );
      pushTriangle(
        face.positions[0],
        face.positions[2],
        face.positions[3],
        face.uvs[0],
        face.uvs[2],
        face.uvs[3],
        face.jointIndex,
      );
      vertexCursor += 6;
    }

    const groupCount = vertexCursor - groupStart;
    if (groupCount > 0) {
      groups.push({
        start: groupStart,
        count: groupCount,
        materialIndex: materialIndexByName.get(materialName) ?? 0,
      });
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute(skinWeights, 4));

  for (const group of groups) {
    geometry.addGroup(group.start, group.count, group.materialIndex);
  }

  return geometry;
}

function createBoneTreeForTopLevel(
  topLevelPath: string,
  groupNodes: ReturnType<typeof buildGroupNodes>,
  scale: number,
): {
  rootBone: Bone;
  bones: Bone[];
  jointPathOrder: string[];
  boneByPath: Map<string, Bone>;
  rootTranslation: Vec3;
} | null {
  const jointPathOrder = [...groupNodes.pathToNode.keys()]
    .filter((path) => path === topLevelPath || path.startsWith(`${topLevelPath}/`))
    .sort((a, b) => (groupNodes.pathVisitOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (groupNodes.pathVisitOrder.get(b) ?? Number.MAX_SAFE_INTEGER));

  if (jointPathOrder.length === 0) {
    return null;
  }

  const boneByPath = new Map<string, Bone>();
  const bones: Bone[] = [];

  const topGroup = groupNodes.pathToGroup.get(topLevelPath);
  const topOrigin = topGroup?.origin ?? [0, 0, 0];
  const rootTranslation: Vec3 = [topOrigin[0] * scale, topOrigin[1] * scale, topOrigin[2] * scale];

  for (const path of jointPathOrder) {
    const group = groupNodes.pathToGroup.get(path);
    if (!group) {
      continue;
    }

    const bone = new Bone();
    bone.name = group.name ?? path.split("/").pop() ?? "bone";

    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
    if (parentPath) {
      const parentGroup = groupNodes.pathToGroup.get(parentPath);
      const local = translationBetween(parentGroup?.origin, group.origin, scale);
      bone.position.set(local[0], local[1], local[2]);
    } else {
      bone.position.set(0, 0, 0);
    }

    const quat = degreesToQuatXYZ(group.rotation ?? [0, 0, 0]);
    bone.quaternion.set(quat[0], quat[1], quat[2], quat[3]);

    boneByPath.set(path, bone);
    bones.push(bone);
  }

  for (const path of jointPathOrder) {
    const bone = boneByPath.get(path);
    if (!bone) {
      continue;
    }

    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
    if (!parentPath) {
      continue;
    }

    const parent = boneByPath.get(parentPath);
    if (parent) {
      parent.add(bone);
    }
  }

  const rootBone = boneByPath.get(topLevelPath);
  if (!rootBone) {
    return null;
  }

  return {
    rootBone,
    bones: jointPathOrder.map((path) => boneByPath.get(path)).filter((bone): bone is Bone => Boolean(bone)),
    jointPathOrder,
    boneByPath,
    rootTranslation,
  };
}

export async function buildArmatureScene(
  model: BBModel,
  sceneElements: SceneElement[],
  scale: number,
  sourceFilePath: string | undefined,
  textureKeys?: Set<string>,
): Promise<{
  scene: Scene;
  textureKeyByImageName: Map<string, string>;
  embeddedTextures: Array<{ name: string; bytes: Uint8Array }>;
  boneByUuid: Map<string, Bone>;
  boneByName: Map<string, Bone>;
}> {
  const scene = new Scene();
  scene.name = "bbext_export";

  const allFaceBatches = filterFaceBatches(buildFaceBatches(model, sceneElements, scale), { textureKeys });
  const { materials } = collectMaterialRefs(model, allFaceBatches);
  const usedTextureKeys = [...new Set(materials.map((material) => material.textureKey || "default"))];
  const textureAssets = await buildTextureAssets(model, usedTextureKeys, sourceFilePath);

  const materialTextureKey = new Map<string, string>();
  for (const material of materials) {
    materialTextureKey.set(material.materialName, material.textureKey || "default");
  }

  const materialList: Material[] = materials.map((material) =>
    createMaterial(material.materialName, material.textureKey || "default", textureAssets));
  const materialIndexByName = new Map(materials.map((material, index) => [material.materialName, index]));

  const groupNodes = buildGroupNodes(model, model.outliner, [], scale);
  const topLevelPaths = [...groupNodes.pathToNode.keys()].filter((path) => !path.includes("/"));

  const boneByUuid = new Map<string, Bone>();
  const boneByName = new Map<string, Bone>();

  for (const topLevelPath of topLevelPaths) {
    const boneTree = createBoneTreeForTopLevel(topLevelPath, groupNodes, scale);
    if (!boneTree) {
      continue;
    }

    const jointIndexByPath = new Map<string, number>(boneTree.jointPathOrder.map((path, index) => [path, index]));
    const entries: Array<{ faceBatches: ReturnType<typeof buildFaceBatches>; jointIndex: number }> = [];

    for (const sceneElement of sceneElements) {
      if (sceneElement.groupPath[0] !== topLevelPath) {
        continue;
      }

      const faceBatches = filterFaceBatches(buildFaceBatches(model, [sceneElement], scale), { textureKeys });
      if (faceBatches.length === 0) {
        continue;
      }

      const jointPath = sceneElement.groupPath.join("/");
      const jointIndex = jointIndexByPath.get(jointPath) ?? 0;
      entries.push({ faceBatches, jointIndex });
    }

    if (entries.length === 0) {
      continue;
    }

    const geometry = buildSkinnedGeometry(entries, materialIndexByName);
    if (!geometry.getAttribute("position") || geometry.getAttribute("position").count === 0) {
      continue;
    }

    const skinnedMesh = new SkinnedMesh(geometry, materialList.length === 1 ? materialList[0] : materialList);
    skinnedMesh.name = topLevelPath;
    skinnedMesh.position.set(boneTree.rootTranslation[0], boneTree.rootTranslation[1], boneTree.rootTranslation[2]);

    skinnedMesh.add(boneTree.rootBone);
    skinnedMesh.bind(new Skeleton(boneTree.bones));
    scene.add(skinnedMesh);

    for (const [path, bone] of boneTree.boneByPath.entries()) {
      const group = groupNodes.pathToGroup.get(path);
      if (!group) {
        continue;
      }
      if (group.uuid) {
        boneByUuid.set(group.uuid, bone);
      }
      if (group.name && !boneByName.has(group.name)) {
        boneByName.set(group.name, bone);
      }
    }
  }

  const textureKeyByImageName = new Map<string, string>();
  for (const [textureKey, resolved] of textureAssets.byTextureKey.entries()) {
    textureKeyByImageName.set(resolved.texture.name, textureKey);
  }

  return {
    scene,
    textureKeyByImageName,
    embeddedTextures: textureAssets.embeddedTextures,
    boneByUuid,
    boneByName,
  };
}
