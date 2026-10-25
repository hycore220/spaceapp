import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { listMemoryGraphOverviewQuerySchema, type MemoryGraphEdge, type MemoryGraphNode } from "@space/contracts";
import { registerMemoryGraphRoutes, selectOverviewNodes } from "../src/memory-graph-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function fixture(count: number) {
  const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, i) => ({ id: `node:${String(i).padStart(5, "0")}`, type: i === 0 ? "SOURCE" : "MEMORY",
    label: i === 0 ? "gemini.md" : i === 1 ? "token=raw-test-value" : `Synthetic memory ${i}`, recordId: null, sourcePath: null }));
  const edges: MemoryGraphEdge[] = [];
  for (let i = 0; i < count; i++) for (let j = 1; j <= 3; j++) edges.push({ id: `edge:${i}:${j}`, type: "CONTAINS", source: nodes[i]!.id, target: nodes[(i + j) % count]!.id });
  return { nodes, edges };
}
function taxonomyFixture() {
  const node = (id: string, type: MemoryGraphNode["type"], label = id): MemoryGraphNode => ({ id, type, label, recordId: null, sourcePath: null });
  const nodes = [node("topic:unlinked", "TOPIC"), node("source:root", "SOURCE", "gemini.md"),
    node("topic:tag", "TOPIC"), node("memory:tagged", "MEMORY"), node("memory:zz-filler", "MEMORY")];
  const edges: MemoryGraphEdge[] = [{ id: "tag:visible", type: "TAGGED_WITH", source: "memory:tagged", target: "topic:tag", origin: "EXPLICIT_TAG", confidence: 1, evidence: "Explicit canonical tag." }];
  return { nodes, edges, node };
}
function routeHarness(graph: ReturnType<typeof fixture>) {
  const app = Fastify(); apps.push(app);
  const snapshot = { ...graph, records: [], issues: [], version: 1, generatedAt: "2026-10-23T00:00:00.000Z", sourceHash: "a".repeat(64),
    summary: { sourceCount: 1, recordCount: 0, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, issueCount: 0 } };
  // Isolate the real route for platform-independent budget/redaction tests. The full-app suite
  // separately verifies its production authentication hook; this harness does not replace it.
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 422 : 500).send({ error: error.message }));
  registerMemoryGraphRoutes(app, { config: { memoryGraphEnabled: true }, service: {
    getSnapshot: async () => ({ snapshot, isStale: false }), listAvailableMonths: async () => []
  }, store: {}, consolidationCoordinator: {}, mutationCoordinator: {} } as unknown as Parameters<typeof registerMemoryGraphRoutes>[1]);
  return app;
}

describe("memory overview explicit large limit", () => {
  it.each([2000, 50000])("does not reuse another search variant's ETag at limit %i", async limit => {
    const graph = fixture(5); graph.edges = [];
    const app = routeHarness(graph);
    const plain = await app.inject({ method: "GET", url: `/api/admin/memory/graph/overview?limit=${limit}` });
    const firstUrl = `/api/admin/memory/graph/overview?limit=${limit}&q=Synthetic%20memory%202`;
    const first = await app.inject({ method: "GET", url: firstUrl, headers: { "if-none-match": plain.headers.etag! } });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.nodes.map((node: MemoryGraphNode) => node.id)).toEqual(["node:00002"]);
    expect(first.headers.etag).not.toBe(plain.headers.etag);
    const secondUrl = `/api/admin/memory/graph/overview?q=Synthetic%20memory%203&limit=${limit}`;
    const second = await app.inject({ method: "GET", url: secondUrl, headers: { "if-none-match": first.headers.etag! } });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.nodes.map((node: MemoryGraphNode) => node.id)).toEqual(["node:00003"]);
    expect(second.headers.etag).not.toBe(first.headers.etag);
    const unchanged = await app.inject({ method: "GET", url: secondUrl, headers: { "if-none-match": second.headers.etag! } });
    expect(unchanged.statusCode).toBe(304);
  });
  it("defaults to2000 and rejects fractional, empty, negative and over50k limits", () => {
    expect(listMemoryGraphOverviewQuerySchema.parse({}).limit).toBe(2000);
    expect(listMemoryGraphOverviewQuerySchema.parse({ limit: "50000" }).limit).toBe(50000);
    for (const limit of ["", "0", "-1", "1.5", "50001", "NaN", Infinity]) expect(listMemoryGraphOverviewQuerySchema.safeParse({ limit }).success).toBe(false);
  });
  it("keeps root priority and never exceeds a small caller budget or server maximum", () => {
    const graph = fixture(50001);
    expect(selectOverviewNodes(graph.nodes, graph.edges)).toHaveLength(2000);
    expect(selectOverviewNodes(graph.nodes, graph.edges, 1).map(node => node.label)).toEqual(["gemini.md"]);
    expect(selectOverviewNodes(graph.nodes, graph.edges, 100000)).toHaveLength(50000);
  });
  it.each([
    { limit: 1, ids: ["source:root"] },
    { limit: 2, ids: ["source:root", "topic:unlinked"] },
    { limit: 3, ids: ["source:root", "topic:tag", "memory:tagged"] }
  ])("reserves a topic and visible memory together at limit $limit", ({ limit, ids }) => {
    const graph = taxonomyFixture();
    expect(selectOverviewNodes(graph.nodes, graph.edges, limit).map(node => node.id)).toEqual(ids);
  });
  it("keeps source priority when only one slot remains for taxonomy", () => {
    const graph = taxonomyFixture();
    graph.nodes.unshift(graph.node("source:notes", "SOURCE", "notes.md"));
    expect(selectOverviewNodes(graph.nodes, graph.edges, 3).map(node => node.id)).toEqual(["source:root", "source:notes", "topic:unlinked"]);
  });
  it("reuses an already visible shared member instead of dropping an affordable topic", () => {
    const graph = taxonomyFixture();
    graph.nodes.push(graph.node("memory:aaa", "MEMORY"), graph.node("topic:derived", "TOPIC"));
    graph.edges.push(
      { id: "tag:shared", type: "TAGGED_WITH", source: "memory:tagged", target: "topic:derived", origin: "DERIVED_TFIDF", confidence: 0.8, evidence: "Shared deterministic topic." },
      { id: "tag:other", type: "TAGGED_WITH", source: "memory:aaa", target: "topic:derived", origin: "DERIVED_TFIDF", confidence: 0.8, evidence: "Additional deterministic topic member." }
    );
    const selected = selectOverviewNodes(graph.nodes, graph.edges, 4).map(node => node.id);
    expect(selected).toEqual(["source:root", "topic:tag", "memory:tagged", "topic:derived"]);
    expect(selectOverviewNodes(graph.nodes, [...graph.edges].reverse(), 4).map(node => node.id)).toEqual(selected);
  });
  it("fills unlinked topics without letting member-backed topics bypass the pair budget", () => {
    const graph = taxonomyFixture();
    expect(selectOverviewNodes(graph.nodes, graph.edges, 4).map(node => node.id)).toEqual(["source:root", "topic:tag", "memory:tagged", "topic:unlinked"]);
    // An edge whose MEMORY is outside the filtered input is not an eligible
    // visible member. This topic remains an ordinary fill candidate.
    graph.edges.push({ id: "tag:outside-filter", type: "TAGGED_WITH", source: "memory:not-in-filter", target: "topic:unlinked", origin: "EXPLICIT_TAG", confidence: 1, evidence: "Member outside this filtered graph." });
    expect(selectOverviewNodes(graph.nodes, graph.edges, 2).map(node => node.id)).toEqual(["source:root", "topic:unlinked"]);
    expect(selectOverviewNodes(graph.nodes, graph.edges, 4).map(node => node.id)).toEqual(["source:root", "topic:tag", "memory:tagged", "topic:unlinked"]);
    // Even when encountered first by generic fill, a member-backed topic that
    // could not reserve its pair must yield the slot to the ordinary topic.
    const linkedTopic = graph.nodes.find(node => node.id === "topic:tag")!;
    const linkedFirst = [linkedTopic, ...graph.nodes.filter(node => node !== linkedTopic)];
    expect(selectOverviewNodes(linkedFirst, graph.edges, 2).map(node => node.id)).toEqual(["source:root", "topic:unlinked"]);
  });
  it("preserves a TOPIC-only clustered overview when the budget is smaller than its matches", async () => {
    const app = routeHarness(taxonomyFixture());
    const response = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?nodeType=TOPIC&relationMode=CLUSTERED&limit=1" });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.nodes.map((node: MemoryGraphNode) => node.id)).toEqual(["topic:tag"]);
    expect(data.edges).toEqual([]);
    expect(data.totalMatchingNodes).toBe(2);
    expect(data.truncated).toBe(true);
    expect(data.filters).toMatchObject({ nodeType: "TOPIC", relationMode: "CLUSTERED" });
  });
  it("serializes the visible tag edge only when its topic and memory fit", async () => {
    const app = routeHarness(taxonomyFixture());
    const tooSmall = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=2" });
    expect(tooSmall.statusCode).toBe(200);
    expect(tooSmall.json().data.nodes.map((node: MemoryGraphNode) => node.id)).toEqual(["source:root", "memory:tagged"]);
    expect(tooSmall.json().data.edges).toEqual([]);
    const pairFits = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=3" });
    expect(pairFits.statusCode).toBe(200);
    expect(pairFits.json().data.nodes.map((node: MemoryGraphNode) => node.id)).toEqual(["source:root", "topic:tag", "memory:tagged"]);
    expect(pairFits.json().data.edges.map((edge: MemoryGraphEdge) => edge.id)).toEqual(["tag:visible"]);
  });
  it("serves50k/150k through real serialization and redaction and separates its ETag from the default", async () => {
    const app = routeHarness(fixture(50000));
    const before = performance.now();
    const large = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=50000" });
    const serverMs = performance.now() - before;
    expect(large.statusCode).toBe(200);
    const body = large.json();
    expect(body.data.nodes).toHaveLength(50000); expect(body.data.edges).toHaveLength(150000);
    expect(body.data.truncated).toBe(false); expect(large.body).not.toContain("raw-test-value");
    const small = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview", headers: { "if-none-match": large.headers.etag! } });
    expect(small.statusCode).toBe(200); expect(small.json().data.nodes).toHaveLength(2000);
    expect(small.headers.etag).not.toBe(large.headers.etag);
    const unchanged = await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=50000", headers: { "if-none-match": large.headers.etag! } });
    expect(unchanged.statusCode).toBe(304);
    process.stdout.write(`\nMEMORY_OVERVIEW_MEASUREMENT ${JSON.stringify({ nodes: 50000, edges: 150000, bytes: Buffer.byteLength(large.body), injectServerAndSerializationMs: serverMs, transport: "Fastify.inject, no network", includesPreparation: false })}\n`);
  });
  it("rejects an oversized query before reading the snapshot", async () => {
    const app = routeHarness(fixture(2));
    expect((await app.inject({ method: "GET", url: "/api/admin/memory/graph/overview?limit=50001" })).statusCode).toBe(422);
  });
});
