import { describe, expect, it } from "vitest";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { memoryGraphFixture } from "../src/features/memory-workspace/memory-graph-fixture.js";
import { createProgressiveMemoryLayout, packMemoryCoordinates } from "../src/features/memory-workspace/memory-progressive-layout.js";
import { memoryRenderDataInitialTransferables, memoryRenderPoint, prepareMemoryRenderData } from "../src/features/memory-workspace/memory-render-data.js";
import { refitMemoryPickingBounds } from "../src/features/memory-workspace/memory-picking-index.js";

describe("large memory render and streamed layout data", () => {
  it("builds indexed edges and sparse symmetric neighbors, discarding dangling endpoints", () => {
    const { nodes, edges } = memoryGraphFixture(2000);
    const atlas = createMemoryAtlas(nodes, edges, false), simulation = createProgressiveMemoryLayout(nodes, edges);
    const data = prepareMemoryRenderData(nodes, [...edges, { id: "invalid", source: "missing", target: nodes[0]!.id, type: "CONTAINS" }], atlas.positions, simulation.positions());
    expect(data.edgePairs).toHaveLength(12000);
    expect(data.edgeTexture).toHaveLength(Math.ceil(6000 / 256) * 1024);
    expect(data.edgeIndices).toHaveLength(6000 * 6);
    expect(data.neighborOffsets.at(-1)).toBe(12000);
    for (let i = 0; i < data.edgePairs.length; i += 2) {
      const a = data.edgePairs[i]!, b = data.edgePairs[i + 1]!;
      const kind = data.edgeKinds[i / 2]!;
      // One texel per edge, without sorting/dropping edges or changing their kind.
      expect([...data.edgeTexture.slice(i * 2, i * 2 + 4)]).toEqual([a, b, kind, 0]);
      // Expanding the shared corners must reproduce the previous two triangles,
      // including endpoint, side, winding and edge order (alpha blending).
      const corners = ["A-", "A+", "B-", "B+"];
      const edge = i / 2;
      const triangle = [...data.edgeIndices.slice(edge * 6, edge * 6 + 6)];
      expect(triangle.every(vertex => Math.floor(vertex / 4) === edge)).toBe(true);
      expect(triangle.map(vertex => corners[vertex % 4])).toEqual(["A-", "A+", "B-", "B-", "A+", "B+"]);
      expect(data.neighbors.slice(data.neighborOffsets[a], data.neighborOffsets[a + 1])).toContain(b);
      expect(data.neighbors.slice(data.neighborOffsets[b], data.neighborOffsets[b + 1])).toContain(a);
    }
    expect(data.styles[3]).toBe(10);
    expect(memoryRenderPoint(data, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });
  it("publishes a finite volumetric seed before any step, then converges deterministically under input reordering", () => {
    const { nodes, edges } = memoryGraphFixture(2000);
    const first = createProgressiveMemoryLayout(nodes, edges), second = createProgressiveMemoryLayout([...nodes].reverse(), [...edges].reverse());
    expect(first.positions()).toEqual(second.positions());
    const seed = first.positions();
    for (let i = 0; i < 3; i++) { first.step(); second.step(); }
    expect(first.positions()).toEqual(second.positions());
    expect(first.positions().get(nodes[1]!.id)).not.toEqual(seed.get(nodes[1]!.id));
    expect(first.positions().get(nodes[0]!.id)).toEqual({ x: 0, y: 0, z: 0 });
    const packed = packMemoryCoordinates(nodes, first.positions());
    expect(packed.coordinates.length % 1024).toBe(0);
    expect([...packed.coordinates].every(Number.isFinite)).toBe(true);
    expect(packed.extent).toBeGreaterThan(60);
  });
  it("transfers initial render buffers intact while retaining the worker picking index for subsequent refits", () => {
    const { nodes, edges } = memoryGraphFixture(100);
    const atlas = createMemoryAtlas(nodes, edges, false), simulation = createProgressiveMemoryLayout(atlas.nodes, atlas.edges);
    const data = prepareMemoryRenderData(atlas.nodes, atlas.edges, atlas.positions, simulation.positions());
    const fields = ["coordinates", "styles", "edgePairs", "edgeKinds", "edgeTexture", "edgeIndices", "neighborOffsets", "neighbors"] as const;
    const before = fields.map(field => Array.from(data[field]));
    const pickingBefore = { order: Array.from(data.picking.order), tree: Array.from(data.picking.tree), bounds: Array.from(data.picking.bounds) };
    const transfer = memoryRenderDataInitialTransferables(data);
    const received = structuredClone(data, { transfer });

    expect(transfer).toHaveLength(fields.length);
    fields.forEach((field, i) => {
      expect(data[field].buffer.byteLength).toBe(0);
      expect(Array.from(received[field])).toEqual(before[i]);
    });
    expect(received.nodes).toEqual(nodes);
    expect(Array.from(received.index)).toEqual(Array.from(data.index));
    for (const field of ["order", "tree", "bounds"] as const) {
      expect(transfer).not.toContain(data.picking[field].buffer);
      expect(data.picking[field].buffer.byteLength).toBeGreaterThan(0);
      expect(Array.from(data.picking[field])).toEqual(pickingBefore[field]);
      expect(Array.from(received.picking[field])).toEqual(pickingBefore[field]);
    }

    // Follow the worker's later position messages after the initial ownership handoff.
    // Independently check the refitted root against all new coordinates, then transfer
    // that fresh update and refit again using the same retained topology and bounds.
    for (let iteration = 0; iteration < 2; iteration++) {
      simulation.step();
      const packed = packMemoryCoordinates(atlas.nodes, simulation.positions());
      const pickingBounds = refitMemoryPickingBounds(data.picking, packed.coordinates);
      for (let axis = 0; axis < 3; axis++) {
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < atlas.nodes.length; i++) {
          min = Math.min(min, packed.coordinates[i * 4 + axis]!);
          max = Math.max(max, packed.coordinates[i * 4 + axis]!);
        }
        expect(pickingBounds[axis]).toBe(min);
        expect(pickingBounds[axis + 3]).toBe(max);
      }
      expect(Array.from(pickingBounds)).not.toEqual(pickingBefore.bounds);
      const update = structuredClone({ coordinates: packed.coordinates, pickingBounds }, {
        transfer: [packed.coordinates.buffer, pickingBounds.buffer]
      });
      expect(packed.coordinates.byteLength).toBe(0);
      expect(pickingBounds.byteLength).toBe(0);
      expect(update.coordinates.length).toBe(received.coordinates.length);
      expect(update.pickingBounds.length).toBe(received.picking.bounds.length);
      for (const field of ["order", "tree", "bounds"] as const) expect(Array.from(data.picking[field])).toEqual(pickingBefore[field]);
    }
  });
  it("generates the reproducible50k/150k synthetic topology without a provider", () => {
    const fixture = memoryGraphFixture(50000);
    expect(fixture.nodes).toHaveLength(50000); expect(fixture.edges).toHaveLength(150000);
    const ids = new Set(fixture.nodes.map(node => node.id));
    expect(fixture.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(new Set(fixture.edges.map(edge => edge.id)).size).toBe(150000);
    const initial = createProgressiveMemoryLayout(fixture.nodes, fixture.edges);
    expect(initial.positions().size).toBe(50000);
  });
});
