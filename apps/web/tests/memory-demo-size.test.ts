import { describe, expect, it } from "vitest";
import { memoryGraphOverviewPayloadSchema } from "@space/contracts";
import { DemoStore } from "../src/demo/DemoStore.js";

describe("offline demo memory graph sizes", () => {
  it.each([
    { query: { q: "  GeMiNi.MD  " }, indexes: [0], sources: 1 },
    { query: { nodeType: "SOURCE" as const }, indexes: Array.from({ length: 20 }, (_, index) => index * 5), sources: 20 },
    { query: { q: "Memory 1" }, indexes: [1, 11, 12, 13, 14, 16, 17, 18, 19], sources: 0 },
    { query: { q: "gemini.md", nodeType: "MEMORY" as const }, indexes: [], sources: 0 },
    { query: { q: "no-such-synthetic-node" }, indexes: [], sources: 0 },
    { query: { sourcePath: "/synthetic/2026-10/source-5.md" }, indexes: [5], sources: 1 }
  ])("filters synthetic nodes, edges and counts for $query", async ({ query, indexes, sources }) => {
    const store = new DemoStore();
    const normal = await store.api.memoryGraphOverview();
    const full = memoryGraphOverviewPayloadSchema.parse((await store.api.memoryGraphOverview({ demoNodes: 100 })).data);
    const data = memoryGraphOverviewPayloadSchema.parse((await store.api.memoryGraphOverview({ ...query, demoNodes: 100 })).data);
    const expectedIds = indexes.map(index => `fixture-${String(index).padStart(5, "0")}`);
    const retainedIds = new Set(expectedIds);
    const expectedEdges = full.edges.filter(edge => retainedIds.has(edge.source) && retainedIds.has(edge.target));

    expect(data.nodes.map(node => node.id)).toEqual(expectedIds);
    expect(data.edges).toEqual(expectedEdges);
    expect(data.summary).toEqual({ sourceCount: sources, recordCount: indexes.length - sources, nodeCount: indexes.length, edgeCount: expectedEdges.length, issueCount: 0 });
    expect(data.totalMatchingNodes).toBe(indexes.length);
    expect(data.totalMatchingEdges).toBe(expectedEdges.length);
    expect(data.filters).toMatchObject(query);
    expect(data.truncated).toBe(false);
    expect(await store.api.memoryGraphOverview()).toEqual(normal);
  });

  it("keeps the normal archive unchanged and supports explicit2k/10k/50k fixtures", async () => {
    const store = new DemoStore();
    const normal = await store.api.memoryGraphOverview();
    for (const count of [2000, 10000, 50000] as const) {
      const response = await store.api.memoryGraphOverview({ demoNodes: count, limit: count });
      const data = memoryGraphOverviewPayloadSchema.parse(response.data);
      expect(data.nodes).toHaveLength(count); expect(data.edges).toHaveLength(count * 3);
      expect(data.summary.nodeCount).toBe(count); expect(data.truncated).toBe(false);
    }
    expect(await store.api.memoryGraphOverview()).toEqual(normal);
  });
});
