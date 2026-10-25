import { memoryGraphFixture } from "./memory-graph-fixture.js";
self.onmessage = (event: MessageEvent<100 | 2000 | 10000 | 50000>) => {
  if (![100, 2000, 10000, 50000].includes(event.data)) { self.postMessage({ error: "Unsupported synthetic graph size" }); return; }
  self.postMessage({ value: memoryGraphFixture(event.data) });
};
