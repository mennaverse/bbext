import { writeFile } from "node:fs/promises";
import type { BBModel, SceneElement } from "../types";
import { buildFaceBatches, filterFaceBatches, modelFileNameFromPath } from "./shared";

interface FbxData {
  fbx: string;
}

function joinNumbers(values: number[]): string {
  return values.map((value) => (Number.isInteger(value) ? String(value) : value.toFixed(6))).join(",");
}

export function generateFbxData(
  outputFilePath: string,
  model: BBModel,
  sceneElements: SceneElement[],
  scale: number,
  textureKeys?: Set<string>,
): FbxData {
  const modelName = modelFileNameFromPath(outputFilePath);
  const faces = filterFaceBatches(buildFaceBatches(model, sceneElements, scale), { textureKeys });

  const vertices: number[] = [];
  const polygonIndices: number[] = [];
  const uvs: number[] = [];
  const uvIndices: number[] = [];

  let cursor = 0;
  for (const face of faces) {
    for (const p of face.positions) {
      vertices.push(p[0], p[1], p[2]);
    }
    for (const uv of face.uvs) {
      uvs.push(uv[0], uv[1]);
    }

    polygonIndices.push(cursor, cursor + 1, -(cursor + 2) - 1);
    polygonIndices.push(cursor, cursor + 2, -(cursor + 3) - 1);

    uvIndices.push(cursor, cursor + 1, cursor + 2, cursor, cursor + 2, cursor + 3);
    cursor += 4;
  }

  const geometryId = 100000;
  const modelId = 100001;
  const materialId = 100002;

  const fbx = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
  FBXHeaderVersion: 1003
  FBXVersion: 7400
}
GlobalSettings:  {
  Version: 1000
  Properties70:  {
    P: "UpAxis", "int", "Integer", "",1
    P: "UpAxisSign", "int", "Integer", "",1
    P: "FrontAxis", "int", "Integer", "",2
    P: "FrontAxisSign", "int", "Integer", "",1
    P: "CoordAxis", "int", "Integer", "",0
    P: "CoordAxisSign", "int", "Integer", "",1
    P: "UnitScaleFactor", "double", "Number", "",1
  }
}
Definitions:  {
  Version: 100
  Count: 3
  ObjectType: "Geometry" {
    Count: 1
  }
  ObjectType: "Model" {
    Count: 1
  }
  ObjectType: "Material" {
    Count: 1
  }
}
Objects:  {
  Geometry: ${geometryId}, "Geometry::${modelName}", "Mesh" {
    Vertices: *${vertices.length} {
      a: ${joinNumbers(vertices)}
    }
    PolygonVertexIndex: *${polygonIndices.length} {
      a: ${joinNumbers(polygonIndices)}
    }
    GeometryVersion: 124
    LayerElementUV: 0 {
      Version: 101
      Name: "UVChannel_1"
      MappingInformationType: "ByPolygonVertex"
      ReferenceInformationType: "IndexToDirect"
      UV: *${uvs.length} {
        a: ${joinNumbers(uvs)}
      }
      UVIndex: *${uvIndices.length} {
        a: ${joinNumbers(uvIndices)}
      }
    }
    Layer: 0 {
      Version: 100
      LayerElement: {
        Type: "LayerElementUV"
        TypedIndex: 0
      }
    }
  }
  Material: ${materialId}, "Material::bbext_default", "" {
    Version: 102
    ShadingModel: "phong"
    MultiLayer: 0
  }
  Model: ${modelId}, "Model::${modelName}", "Mesh" {
    Version: 232
    Properties70:  {
      P: "InheritType", "enum", "", "",1
      P: "DefaultAttributeIndex", "int", "Integer", "",0
    }
    Shading: T
    Culling: "CullingOff"
  }
}
Connections:  {
  C: "OO",${geometryId},${modelId}
  C: "OO",${modelId},0
  C: "OO",${materialId},${modelId}
}
`;

  return { fbx };
}

export async function writeFbxOutput(destinationFbxPath: string, data: FbxData): Promise<void> {
  await writeFile(destinationFbxPath, data.fbx, "utf8");
}
