import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { memoryGraphFixture } from "../src/features/memory-workspace/memory-graph-fixture.js";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("streamed Canvas fallback metadata", () => {
  it("retains every selected node's own group/color when atlas insertion order differs", async () => {
    const graph = memoryGraphFixture(10000);
    graph.nodes.forEach((node, i) => { node.sourcePath = `archive/history_2026-${i % 2 ? "06" : "07"}.md`; });
    const atlas = createMemoryAtlas(graph.nodes, graph.edges, false);
    const selected = atlas.nodes.slice(0, 2000), selectedIds = selected.map(node => node.id);
    // Real month grouping reorders the Map without reordering the input nodes.
    expect([...atlas.positions.keys()].slice(0, 2000)).not.toEqual(selectedIds);
    type Initial = { kind: "initial"; atlas: { positions: typeof atlas.positions }; depth: [string, unknown][] };
    let resolveInitial!: (message: Initial) => void, rejectInitial!: (error: Error) => void;
    const initial = new Promise<Initial>((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      /** Capture the worker's real initial publication and cancel its remaining layout work. */
      postMessage(message: { kind: string; message?: string }) {
        if (message.kind === "error") rejectInitial(new Error(message.message));
        if (message.kind === "initial") {
          resolveInitial(message as Initial);
          worker.onmessage?.({ data: { kind: "begin" } }); // Cancel after the actual initial publication.
        }
      }
    };
    vi.stubGlobal("self", worker);
    await import("../src/features/memory-workspace/memory-network-layout.worker.js");
    worker.onmessage?.({ data: { ...graph, mode: "3d" } });
    const published = await initial;
    expect([...published.atlas.positions.keys()]).toEqual(selectedIds);
    expect(published.depth.map(([id]) => id)).toEqual(selectedIds);
    expect(new Set([...published.atlas.positions.values()].map(point => point.color)).size).toBeGreaterThan(1);
    for (const id of selectedIds) expect(published.atlas.positions.get(id)).toEqual(atlas.positions.get(id));
    // Let the cancelled generation reach its yield before restoring the global.
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
