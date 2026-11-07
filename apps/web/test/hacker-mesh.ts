import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { HandMesh } from "@/components/rig/hands";

/** The hacker's mesh as the scene has it: hacker.glb's body, in scene metres. */
export async function hackerMesh(model = "hacker.glb"): Promise<HandMesh> {
  const file = readFileSync(join(import.meta.dir, "../public/rig", model));
  const jsonLength = file.readUInt32LE(12);
  const gltf = JSON.parse(file.subarray(20, 20 + jsonLength).toString("utf8"));
  const bin = file.subarray(20 + jsonLength + 8);
  await MeshoptDecoder.ready;
  const views: Uint8Array[] = gltf.bufferViews.map((view: { byteOffset?: number; byteLength: number; extensions?: Record<string, { byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string }> }) => {
    const meshopt = view.extensions?.EXT_meshopt_compression;
    if (!meshopt) return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const out = new Uint8Array(meshopt.count * meshopt.byteStride);
    MeshoptDecoder.decodeGltfBuffer(out, meshopt.count, meshopt.byteStride, bin.subarray(meshopt.byteOffset ?? 0, (meshopt.byteOffset ?? 0) + meshopt.byteLength), meshopt.mode, meshopt.filter ?? "NONE");
    return out;
  });
  const SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const TYPES = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5126: Float32Array };
  const MAX = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535, 5126: 1 };
  /** `count` rows of `n` values from a view, copied out (views needn't be aligned). */
  const rows = (viewIndex: number, offset: number, count: number, n: number, type: keyof typeof TYPES, normalized: boolean): number[] => {
    const Type = TYPES[type];
    const stride = gltf.bufferViews[viewIndex].byteStride ?? n * Type.BYTES_PER_ELEMENT;
    const bytes = views[viewIndex]!;
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const start = bytes.byteOffset + offset + i * stride;
      const row = new Type(Uint8Array.prototype.slice.call(new Uint8Array(bytes.buffer), start, start + n * Type.BYTES_PER_ELEMENT).buffer);
      for (const v of row) out.push(normalized ? Math.max(v / MAX[type], -1) : v);
    }
    return out;
  };
  const read = (index: number): number[] => {
    const accessor = gltf.accessors[index];
    const n = SIZE[accessor.type]!;
    const out = accessor.bufferView === undefined ? Array<number>(accessor.count * n).fill(0) : rows(accessor.bufferView, accessor.byteOffset ?? 0, accessor.count, n, accessor.componentType, !!accessor.normalized);
    const sparse = accessor.sparse;
    if (sparse) {
      const at = rows(sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, sparse.count, 1, sparse.indices.componentType, false);
      const values = rows(sparse.values.bufferView, sparse.values.byteOffset ?? 0, sparse.count, n, accessor.componentType, !!accessor.normalized);
      at.forEach((v, i) => {
        for (let c = 0; c < n; c++) out[v * n + c] = values[i * n + c]!;
      });
    }
    return out;
  };
  const node = gltf.nodes[0];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const mesh: { positions: number[]; normals: number[]; finger: number[]; digit: number[]; arm: number[] } = { positions: [], normals: [], finger: [], digit: [], arm: [] };
  for (const primitive of gltf.meshes[node.mesh].primitives) {
    const p = read(primitive.attributes.POSITION);
    for (let i = 0; i < p.length; i += 3) mesh.positions.push(p[i]! * sx + tx, p[i + 1]! * sy + ty, p[i + 2]! * sz + tz);
    mesh.normals.push(...read(primitive.attributes.NORMAL));
    mesh.finger.push(...read(primitive.attributes._FINGER));
    mesh.digit.push(...read(primitive.attributes._DIGIT));
    mesh.arm.push(...read(primitive.attributes._ARM));
  }
  return mesh;
}

