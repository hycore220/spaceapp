import { memoryGraphOverviewPayloadSchema } from "@space/contracts";
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(event.data));
    if (!raw || typeof raw !== "object" || !("data" in raw)) throw new Error("Invalid memory overview response");
    const { nodes, edges, ...metadata } = memoryGraphOverviewPayloadSchema.parse(raw.data);
    for (const [kind, items, size] of [["nodes", nodes, 1000], ["edges", edges, 2000]] as const) {
      for (let offset = 0; offset < items.length; offset += size) {
        self.postMessage({ kind, items: items.slice(offset, offset + size) });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    self.postMessage({ kind: "done", metadata });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "Invalid memory overview response" }); }
};
