import { layoutMemoryNetwork3D } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import { createMemoryAtlas } from "./memory-atlas.js";
import { createProgressiveMemoryLayout, packMemoryCoordinates } from "./memory-progressive-layout.js";
import { memoryRenderDataInitialTransferables, prepareMemoryRenderData } from "./memory-render-data.js";
import { memoryGraphFixture } from "./memory-graph-fixture.js";
import { memory3DVolumeRatio } from "./memory-3d.js";
import { refitMemoryPickingBounds } from "./memory-picking-index.js";

type Request = { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; mode?: "3d"; fixtureCount?: 100 | 2000 | 10000 | 50000 };
let generation = 0;
type Chunk = { kind: "begin" | "run" } | { kind: "nodes"; nodes: MemoryGraphNode[] } | { kind: "edges"; edges: MemoryGraphEdge[] };
let streamed: Request | null = null;
self.onmessage = (event: MessageEvent<Request | Chunk>) => {
  if ("kind" in event.data) {
    const message = event.data;
    if (message.kind === "begin") { streamed = { nodes: [], edges: [], mode: "3d" }; generation++; return; }
    if (!streamed) { self.postMessage({ kind: "error", message: "Graph stream was not initialized" }); return; }
    if (message.kind === "nodes") { for (const node of message.nodes) streamed.nodes.push(node); return; }
    if (message.kind === "edges") { for (const edge of message.edges) streamed.edges.push(edge); return; }
    const input = streamed; streamed = null;
    void stream3D(input, ++generation).catch(error => self.postMessage({ kind: "error", message: String(error) }));
    return;
  }
  const token = ++generation;
  if (event.data.mode === "3d") {
    void stream3D(event.data, token).catch(error => self.postMessage({ kind: "error", message: error instanceof Error ? error.message : "Layout failed" }));
    return;
  }
  const positions = layoutMemoryNetwork(event.data.nodes, event.data.edges);
  self.postMessage({ positions: [...positions], depth: [...layoutMemoryNetwork3D(event.data.nodes, event.data.edges)] });
};

/** Build typed render/BVH data in the worker, stream a usable seed and 4-step position updates, and stop superseded generations. Use the original final layout up to 2k and 60 progressive steps above it. */
async function stream3D(request: Request, token: number) {
  const input = request.fixtureCount ? memoryGraphFixture(request.fixtureCount) : request;
  const atlas = createMemoryAtlas(input.nodes, input.edges, false);
  const fallbackNodes = atlas.nodes.slice(0, 2000);
  const simulation = createProgressiveMemoryLayout(atlas.nodes, atlas.edges);
  let points = simulation.positions();
  const data = prepareMemoryRenderData(atlas.nodes, atlas.edges, atlas.positions, points);
  /** Publish at most 2k node/position pairs for the Canvas fallback; full graph coordinates remain in the transferable render buffers. */
  const fallback = () => fallbackNodes.map(node => [node.id, points.get(node.id)!]);
  // Bound the object-cloning task at the receiving thread. Edge topology is already packed.
  for (let offset = 0; offset < atlas.nodes.length; offset += 1000) {
    if (token !== generation) return;
    self.postMessage({ kind: "nodes", nodes: atlas.nodes.slice(offset, offset + 1000) });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const fallbackIds = new Set(fallbackNodes.map(node => node.id));
  const compactAtlas = { ...atlas, nodes: [], edges: atlas.edges.filter(edge => fallbackIds.has(edge.source) && fallbackIds.has(edge.target)).slice(0, 6000),
    positions: new Map(fallbackNodes.flatMap(node => { const position = atlas.positions.get(node.id); return position ? [[node.id, position] as const] : []; })) };
  const { nodes: _nodes, index: _index, ...packedData } = data;
  self.postMessage({ kind: "initial", data: packedData, atlas: compactAtlas, fullEdgeCount: atlas.edges.length,
    sourceLinkCount: atlas.edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length,
    depth: fallback(), volume: memory3DVolumeRatio([...points.values()]), done: false }, { transfer: memoryRenderDataInitialTransferables(data) });
  // Yield so the view can display and accept input before convergence.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (token !== generation) return;
  if (atlas.nodes.length <= 2000) {
    points = layoutMemoryNetwork3D(atlas.nodes, atlas.edges);
    const packed = packMemoryCoordinates(atlas.nodes, points);
    const pickingBounds = refitMemoryPickingBounds(data.picking, packed.coordinates);
    self.postMessage({ kind: "positions", ...packed, pickingBounds, depth: fallback(), volume: memory3DVolumeRatio([...points.values()]), iteration: 180, done: true }, { transfer: [packed.coordinates.buffer, pickingBounds.buffer] });
    return;
  }
  for (let iteration = 1; iteration <= 60; iteration++) {
    if (token !== generation) return;
    simulation.step();
    if (iteration % 4 === 0) {
      points = simulation.positions();
      const packed = packMemoryCoordinates(atlas.nodes, points);
      const pickingBounds = refitMemoryPickingBounds(data.picking, packed.coordinates);
      self.postMessage({ kind: "positions", ...packed, pickingBounds, depth: fallback(), volume: memory3DVolumeRatio([...points.values()]), iteration, done: iteration === 60 }, { transfer: [packed.coordinates.buffer, pickingBounds.buffer] });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}
