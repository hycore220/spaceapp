import { describe, expect, it } from "vitest";
import { memoryGraphOverviewPayloadSchema } from "@space/contracts";
import { DemoStore } from "../src/demo/DemoStore.js";

describe("offline demo memory graph sizes", () => {
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
