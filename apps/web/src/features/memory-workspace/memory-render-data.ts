import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { memoryGraphExtent, memoryLabelCandidateIndices } from "./memory-webgl-math.js";
import { createMemoryPickingIndex, type MemoryPickingIndex } from "./memory-picking-index.js";

export type MemoryRenderData = {
  nodes: MemoryGraphNode[];
  index: Map<string, number>;
  coordinates: Float32Array;
  styles: Float32Array;
  edgePairs: Uint32Array;
  edgeKinds: Float32Array;
  /** One integer texel per edge: endpoint pair and kind, in original blend order. */
  edgeTexture: Uint32Array;
  /** Six indices reuse four projected corners per edge, retaining triangle/blend order. */
  edgeIndices: Uint32Array;
  neighborOffsets: Uint32Array;
  neighbors: Uint32Array;
  labelCandidates: number[];
  extent: number;
  picking: MemoryPickingIndex;
};

/** Hand render-only buffers to the UI once; retain picking buffers for later worker refits. */
export function memoryRenderDataInitialTransferables(data: MemoryRenderData): ArrayBuffer[] {
  return [data.coordinates.buffer, data.styles.buffer, data.edgePairs.buffer, data.edgeKinds.buffer,
    data.edgeTexture.buffer, data.edgeIndices.buffer, data.neighborOffsets.buffer, data.neighbors.buffer].map(buffer => {
      if (!(buffer instanceof ArrayBuffer)) throw new TypeError("Memory render buffers must be transferable ArrayBuffers.");
      return buffer;
    });
}

/** Linear preparation, reused until graph topology changes; also safe to run in a worker. */
export function prepareMemoryRenderData(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[],
  positions: Map<string, MemoryAtlasPosition>, points: Map<string, MemoryPoint3D>): MemoryRenderData {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const coordinates = new Float32Array(Math.ceil(Math.max(1, nodes.length) / 256) * 256 * 4);
  const styles = new Float32Array(nodes.length * 4);
  nodes.forEach((node, i) => {
    const p = points.get(node.id) ?? { x: 0, y: 0, z: 0 };
    coordinates.set([p.x, p.y, p.z, 1], i * 4);
    const color = positions.get(node.id)?.color ?? "#7395ad";
    const rgb = /^#[0-9a-f]{6}$/i.test(color) ? Number.parseInt(color.slice(1), 16) : 0x7395ad;
    styles.set([(rgb >>> 16) / 255, ((rgb >>> 8) & 255) / 255, (rgb & 255) / 255,
      node.type === "SOURCE" && isMemoryCoreLabel(node.label) ? 10 : node.type === "SOURCE" ? 4.6 : 2.1], i * 4);
  });
  const valid = edges.flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    return a === undefined || b === undefined ? [] : [{ a, b, derived: edge.type === "DERIVED_FROM" }];
  });
  const edgePairs = new Uint32Array(valid.length * 2), edgeKinds = new Float32Array(valid.length);
  const edgeTexture = new Uint32Array(Math.ceil(Math.max(1, valid.length) / 256) * 256 * 4);
  const edgeIndices = new Uint32Array(valid.length * 6);
  const neighborOffsets = new Uint32Array(nodes.length + 1);
  valid.forEach(({ a, b, derived }, i) => {
    edgePairs.set([a, b], i * 2); edgeKinds[i] = Number(derived);
    edgeTexture.set([a, b, Number(derived), 0], i * 4);
    const vertex = i * 4;
    edgeIndices.set([vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3], i * 6);
    neighborOffsets[a + 1]!++; neighborOffsets[b + 1]!++;
  });
  for (let i = 1; i < neighborOffsets.length; i++) neighborOffsets[i]! += neighborOffsets[i - 1]!;
  const cursor = neighborOffsets.slice(), neighbors = new Uint32Array(valid.length * 2);
  for (const { a, b } of valid) { neighbors[cursor[a]!] = b; cursor[a]!++; neighbors[cursor[b]!] = a; cursor[b]!++; }
  return { nodes, index, coordinates, styles, edgePairs, edgeKinds, edgeTexture, edgeIndices, neighborOffsets, neighbors,
    labelCandidates: memoryLabelCandidateIndices(nodes), extent: memoryGraphExtent(points.values()), picking: createMemoryPickingIndex(coordinates, styles, nodes.length) };
}

/** Read one packed node xyz coordinate by render index without allocating or rebuilding graph-wide lookup state. */
export function memoryRenderPoint(data: MemoryRenderData, index: number): MemoryPoint3D {
  return { x: data.coordinates[index * 4]!, y: data.coordinates[index * 4 + 1]!, z: data.coordinates[index * 4 + 2]! };
}
