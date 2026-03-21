import { BufferGeometry, Float32BufferAttribute } from "three";
import type { Vec2, Vec3 } from "../../types";
import type { FaceBatch } from "../shared";
import { computeNormal } from "../gltf/math";

function pushTriangle(
  positions: number[],
  normals: number[],
  uvs: number[],
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  uv0: Vec2,
  uv1: Vec2,
  uv2: Vec2,
): void {
  const normal = computeNormal(p0, p1, p2);

  positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
  normals.push(normal[0], normal[1], normal[2], normal[0], normal[1], normal[2], normal[0], normal[1], normal[2]);
  uvs.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
}

export function buildGeometryForFaceBatches(faceBatches: FaceBatch[]): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  for (const face of faceBatches) {
    if (face.positions.length < 3 || face.uvs.length < 3) {
      continue;
    }

    if (face.positions.length === 3) {
      pushTriangle(
        positions,
        normals,
        uvs,
        face.positions[0],
        face.positions[1],
        face.positions[2],
        face.uvs[0],
        face.uvs[1],
        face.uvs[2],
      );
      continue;
    }

    pushTriangle(
      positions,
      normals,
      uvs,
      face.positions[0],
      face.positions[1],
      face.positions[2],
      face.uvs[0],
      face.uvs[1],
      face.uvs[2],
    );
    pushTriangle(
      positions,
      normals,
      uvs,
      face.positions[0],
      face.positions[2],
      face.positions[3],
      face.uvs[0],
      face.uvs[2],
      face.uvs[3],
    );
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  return geometry;
}
