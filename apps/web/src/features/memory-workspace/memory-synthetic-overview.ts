import { memoryGraphFixture } from "./memory-graph-fixture.js";
/** Generate the fixed synthetic topology off-thread when available, propagate generator errors and terminate its worker; unsupported Workers use the same pure fixture. */
export async function generateSyntheticMemoryGraph(count: 100 | 2000 | 10000 | 50000) {
  if (typeof Worker === "undefined") return memoryGraphFixture(count);
  const worker = new Worker(new URL("./memory-synthetic-overview.worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<ReturnType<typeof memoryGraphFixture>>((resolve, reject) => {
      worker.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.value);
      worker.onerror = event => reject(new Error(event.message || "Synthetic graph generation failed"));
      worker.postMessage(count);
    });
  } finally { worker.terminate(); }
}
