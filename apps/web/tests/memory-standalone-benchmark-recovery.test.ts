// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../src/features/memory-workspace/memory-webgl-renderer.js", () => ({
  MemoryWebGLRenderer: class {
    setData() {}
    updateCoordinates() {}
    resize() {}
    dispose() {}
    setFocus() {}
    render() {}
    pick() { return -1; }
  }
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); document.body.innerHTML = ""; });

it("allows a new measurement after context loss aborts the standalone benchmark", async () => {
  document.body.innerHTML = '<div><canvas id="graph"></canvas><canvas id="labels"></canvas></div><div id="state"></div><pre id="result"></pre><select id="size"><option value="2000">2k</option></select><button id="load"></button><button id="titles"></button><button id="benchmark"></button><button id="context"></button>';
  const gl = { isContextLost: () => false };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type: string) => (type === "webgl2" ? gl : { setTransform() {} }) as never);
  vi.stubGlobal("ResizeObserver", class { observe() {} });
  let worker: { onmessage: ((event: { data: unknown }) => void) | null };
  vi.stubGlobal("Worker", class {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    constructor() { worker = this; }
    postMessage() {}
    terminate() {}
  });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  await import("../src/features/memory-workspace/memory-graph-benchmark.js");
  worker!.onmessage?.({ data: { kind: "initial", data: { nodes: [], index: new Map(), edgeKinds: new Uint8Array(), picking: { bounds: new Float32Array() } } } });
  worker!.onmessage?.({ data: { kind: "positions", coordinates: new Float32Array(), extent: 1, pickingBounds: new Float32Array(), volume: 0, done: true } });
  const button = document.querySelector<HTMLButtonElement>("#benchmark")!;
  button.click();
  expect(button.disabled).toBe(true);
  const canvas = document.querySelector<HTMLCanvasElement>("#graph")!;
  canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  const callback = [...frames.values()].at(-1)!;
  frames.clear(); callback(16);
  expect(button.disabled).toBe(false);
  expect(document.querySelector("#state")!.textContent).toContain("aborted");
  expect(document.querySelector("#result")!.textContent).toBe("");
  canvas.dispatchEvent(new Event("webglcontextrestored"));
  button.click();
  expect(button.disabled).toBe(true);
  expect(document.querySelector("#state")!.textContent).toContain("Measuring");
});
