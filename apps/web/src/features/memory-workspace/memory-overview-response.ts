/** Decode a successful overview response and validate it in a short-lived worker.
 * The caller owns HTTP authentication/status handling. Transfer body bytes to
 * the worker and assemble bounded object chunks; terminate on success, schema,
 * runtime or message-deserialization failure. Worker-less callers use JSON
 * decoding and retain their existing downstream validation. */
export async function readLargeMemoryOverview(response: Response): Promise<unknown> {
  if (typeof Worker === "undefined") return response.json();
  const bytes = await response.arrayBuffer();
  const worker = new Worker(new URL("./memory-overview-parser.worker.ts", import.meta.url), { type: "module" });
  const nodes: unknown[] = [], edges: unknown[] = [];
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = event => {
        const message = event.data;
        if (message.error) reject(new Error(message.error));
        else if (message.kind === "nodes" || message.kind === "edges") {
          const target = message.kind === "nodes" ? nodes : edges;
          for (const item of message.items) target.push(item);
        } else if (message.kind === "done") resolve({ data: { ...message.metadata, nodes, edges } });
      };
      worker.onerror = event => reject(new Error(event.message || "Memory overview parsing failed"));
      worker.onmessageerror = () => reject(new Error("Memory overview worker response could not be deserialized"));
      worker.postMessage(bytes, [bytes]);
    });
  } finally { worker.terminate(); }
}
