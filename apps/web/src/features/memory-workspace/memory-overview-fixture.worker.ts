import { memoryGraphFixture } from "./memory-graph-fixture.js";

// Diagnostic only: the real overview decoder/validator and layout-input path receive
// these bytes. Generation/serialization never execute on the UI thread.
self.onmessage = (event: MessageEvent<2000 | 10000 | 50000>) => {
  const count = event.data;
  if (![2000, 10000, 50000].includes(count)) { self.postMessage({ error: "Unsupported fixture size" }); return; }
  const fixture = memoryGraphFixture(count);
  const payload = { data: { ...fixture, version: 2, generatedAt: "2026-10-24T00:00:00.000Z", sourceHash: "0".repeat(64), isStale: false,
    summary: { sourceCount: 20, recordCount: count - 20, nodeCount: count, edgeCount: count * 3, issueCount: 0 },
    filters: { q: null, nodeType: null, roomId: null, sourcePath: null, lifecycleStatus: null, relationMode: "RELATIONS", month: "all" },
    months: [], totalMatchingNodes: count, totalMatchingEdges: count * 3, truncated: false } };
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).buffer;
  self.postMessage({ bytes }, { transfer: [bytes] });
};
