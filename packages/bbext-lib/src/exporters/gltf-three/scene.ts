import {
  AnimationClip,
  Mesh,
  MeshStandardMaterial,
  Scene,
  type Material,
} from "three";
import type { BBModel, SceneElement } from "../../types";
import {
  buildFaceBatches,
  collectMaterialRefs,
  filterFaceBatches,
  sanitizeMaterialName,
} from "../shared";
import { buildGeometryForFaceBatches } from "./geometry";
import { buildTextureAssets } from "./textures";
import { buildArmatureScene } from "./armature";
import { buildAnimationClips } from "./animation-clips";

export interface BuildThreeSceneOptions {
  exportGroupsAsArmature?: boolean;
  exportAnimations?: boolean;
}

export async function buildThreeScene(
  model: BBModel,
  sceneElements: SceneElement[],
  scale: number,
  sourceFilePath: string | undefined,
  options: BuildThreeSceneOptions = {},
  textureKeys?: Set<string>,
): Promise<{
  scene: Scene;
  materialTextureKey: Map<string, string>;
  textureKeyByImageName: Map<string, string>;
  embeddedTextures: Array<{ name: string; bytes: Uint8Array }>;
  animations: AnimationClip[];
}> {
  const useArmature = Boolean(options.exportGroupsAsArmature || options.exportAnimations);
  if (useArmature) {
    const built = await buildArmatureScene(model, sceneElements, scale, sourceFilePath, textureKeys);
    if (built.scene.children.length > 0) {
      const animations = options.exportAnimations
        ? buildAnimationClips(model, built.boneByUuid, built.boneByName, scale)
        : [];

      return {
        scene: built.scene,
        materialTextureKey: new Map<string, string>(),
        textureKeyByImageName: built.textureKeyByImageName,
        embeddedTextures: built.embeddedTextures,
        animations,
      };
    }
  }

  const faceBatches = filterFaceBatches(buildFaceBatches(model, sceneElements, scale), { textureKeys });
  const { materials } = collectMaterialRefs(model, faceBatches);

  const materialTextureKey = new Map<string, string>();
  for (const material of materials) {
    materialTextureKey.set(material.materialName, material.textureKey || "default");
  }

  const grouped = new Map<string, typeof faceBatches>();
  for (const face of faceBatches) {
    const list = grouped.get(face.materialName);
    if (list) {
      list.push(face);
    } else {
      grouped.set(face.materialName, [face]);
    }
  }

  const scene = new Scene();
  scene.name = "bbext_export";

  const usedTextureKeys = [...new Set(materials.map((material) => material.textureKey || "default"))];
  const textureAssets = await buildTextureAssets(model, usedTextureKeys, sourceFilePath);
  const textureKeyByImageName = new Map<string, string>();

  for (const [textureKey, resolved] of textureAssets.byTextureKey) {
    textureKeyByImageName.set(sanitizeMaterialName(textureKey), textureKey);
  }

  for (const [materialName, materialFaceBatches] of grouped.entries()) {
    const geometry = buildGeometryForFaceBatches(materialFaceBatches);
    if (!geometry.getAttribute("position") || geometry.getAttribute("position").count === 0) {
      continue;
    }

    const textureKey = materialTextureKey.get(materialName) ?? "default";
    const texture = textureAssets.byTextureKey.get(textureKey)?.texture;

    let material: Material;
    if (texture) {
      material = new MeshStandardMaterial({
        name: materialName,
        color: 0xffffff,
        map: texture,
        transparent: true,
        alphaTest: 0.05,
        metalness: 0,
        roughness: 1,
      });
    } else {
      material = new MeshStandardMaterial({
        name: materialName,
        color: 0xffffff,
        metalness: 0,
        roughness: 1,
      });
    }

    const mesh = new Mesh(geometry, material);
    mesh.name = materialName;
    scene.add(mesh);
  }

  return {
    scene,
    materialTextureKey,
    textureKeyByImageName,
    embeddedTextures: textureAssets.embeddedTextures,
    animations: [],
  };
}
