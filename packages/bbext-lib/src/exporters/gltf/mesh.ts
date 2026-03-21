import type { Vec3 } from "../../types";
import type { FaceBatch } from "../shared";
import type { GltfPrimitiveBuild } from "./types";
import { computeNormal, computePositionMinMax } from "./math";

export function buildMeshEntry(
  entries: Array<{ faceBatches: FaceBatch[]; jointIndex: number }>,
  positionOffset: Vec3,
  appendAccessor: (bytes: Uint8Array, componentType: number, count: number, type: string, target?: number, min?: number[], max?: number[]) => number,
  setBufferViewStride: (accessorIndex: number, byteStride: number) => void,
  materialIndexByName: Map<string, number>,
): { primitives: Array<Record<string, unknown>> } | null {
  if (entries.length === 0) {
    return null;
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const primitiveByMaterial = new Map<string, GltfPrimitiveBuild>();

  const orderedEntries = [...entries].sort((a, b) => a.jointIndex - b.jointIndex);

  for (const entry of orderedEntries) {
    for (const face of entry.faceBatches) {
      const baseVertex = positions.length / 3;
      const appliedOffset = entry.jointIndex === 0 ? positionOffset : [0, 0, 0];
      const faceVertexCount = face.positions.length;
      for (const p of face.positions) {
        positions.push(p[0] - appliedOffset[0], p[1] - appliedOffset[1], p[2] - appliedOffset[2]);
      }
      const n = computeNormal(face.positions[0], face.positions[1], face.positions[2]);
      for (let i = 0; i < faceVertexCount; i++) {
        normals.push(n[0], n[1], n[2]);
        joints.push(0, entry.jointIndex, 0, 0);
        weights.push(0, 1, 0, 0);
      }
      for (const uv of face.uvs) {
        uvs.push(uv[0], 1 - uv[1]);
      }

      let primitive = primitiveByMaterial.get(face.materialName);
      if (!primitive) {
        primitive = {
          materialName: face.materialName,
          indices: [],
        };
        primitiveByMaterial.set(face.materialName, primitive);
      }

      if (faceVertexCount === 3) {
        primitive.indices.push(baseVertex, baseVertex + 1, baseVertex + 2);
      } else if (faceVertexCount === 4) {
        primitive.indices.push(
          baseVertex,
          baseVertex + 1,
          baseVertex + 2,
          baseVertex,
          baseVertex + 2,
          baseVertex + 3,
        );
      }
    }
  }

  const vertexCount = positions.length / 3;
  if (vertexCount === 0) {
    return null;
  }

  const minMax = computePositionMinMax(positions);
  const positionAccessorIndex = appendAccessor(
    new Uint8Array(new Float32Array(positions).buffer),
    5126,
    vertexCount,
    "VEC3",
    34962,
    minMax.min,
    minMax.max,
  );

  const normalAccessorIndex = appendAccessor(
    new Uint8Array(new Float32Array(normals).buffer),
    5126,
    vertexCount,
    "VEC3",
    34962,
    [-1, -1, -1],
    [1, 1, 1],
  );

  const uvAccessorIndex = appendAccessor(
    new Uint8Array(new Float32Array(uvs).buffer),
    5126,
    uvs.length / 2,
    "VEC2",
    34962,
    [0, 0],
    [Math.max(...uvs.filter((_, index) => index % 2 === 0)), Math.max(...uvs.filter((_, index) => index % 2 === 1))],
  );

  const jointAccessorIndex = appendAccessor(
    new Uint8Array(new Uint16Array(joints).buffer),
    5123,
    vertexCount,
    "VEC4",
    34962,
    [0, Math.min(...joints.filter((_, index) => index % 4 === 1)), 0, 0],
    [0, Math.max(...joints.filter((_, index) => index % 4 === 1)), 0, 0],
  );

  const weightAccessorIndex = appendAccessor(
    new Uint8Array(new Float32Array(weights).buffer),
    5126,
    vertexCount,
    "VEC4",
    34962,
    [0, 1, 0, 0],
    [0, 1, 0, 0],
  );

  setBufferViewStride(positionAccessorIndex, 12);
  setBufferViewStride(normalAccessorIndex, 12);
  setBufferViewStride(uvAccessorIndex, 8);
  setBufferViewStride(jointAccessorIndex, 8);
  setBufferViewStride(weightAccessorIndex, 16);

  const useUint32 = vertexCount > 65535;
  const indexComponentType = useUint32 ? 5125 : 5123;
  const primitives = [...primitiveByMaterial.values()]
    .filter((primitive) => primitive.indices.length > 0)
    .map((primitive) => {
      const indexArray = useUint32 ? new Uint32Array(primitive.indices) : new Uint16Array(primitive.indices);
      const minIndex = primitive.indices.length > 0 ? Math.min(...primitive.indices) : 0;
      const maxIndex = primitive.indices.length > 0 ? Math.max(...primitive.indices) : 0;
      const indicesAccessor = appendAccessor(
        new Uint8Array(indexArray.buffer),
        indexComponentType,
        primitive.indices.length,
        "SCALAR",
        34963,
        [minIndex],
        [maxIndex],
      );

      return {
        mode: 4,
        attributes: {
          POSITION: positionAccessorIndex,
          NORMAL: normalAccessorIndex,
          TEXCOORD_0: uvAccessorIndex,
          JOINTS_0: jointAccessorIndex,
          WEIGHTS_0: weightAccessorIndex,
        },
        indices: indicesAccessor,
        material: materialIndexByName.get(primitive.materialName) ?? 0,
      };
    });

  if (primitives.length === 0) {
    return null;
  }

  return { primitives };
}
