import { DEFAULT_MEMORY_CAMERA, projectMemoryPoint } from "./memory-3d.js";
import { MemoryWebGLRenderer } from "./memory-webgl-renderer.js";
import { memoryRenderPoint, type MemoryRenderData } from "./memory-render-data.js";
import { selectMemoryScreenLabels } from "./memory-webgl-math.js";
import type { MemoryGraphNode } from "@space/contracts";

const canvas = document.querySelector<HTMLCanvasElement>("#graph")!;
const labels = document.querySelector<HTMLCanvasElement>("#labels")!;
const context = labels.getContext("2d")!;
const state = document.querySelector<HTMLElement>("#state")!, output = document.querySelector<HTMLElement>("#result")!;
const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: true });
const camera = { ...DEFAULT_MEMORY_CAMERA };
let renderer: MemoryWebGLRenderer | null = null, data: MemoryRenderData | null = null;
let worker: Worker | null = null, width = 1, height = 1, frame = 0, showTitles = true, selected = -1;
let benchmarking = false, done = false;
const longTasks: number[] = [];
const textWidths = new Map<string, number>();
/** Measure a label in CSS pixels using a bounded text-width cache; clear the cache before it can grow with the graph. */
const measureLabel = (text: string) => {
  const cached = textWidths.get(text); if (cached !== undefined) return cached;
  const value = context.measureText(text).width;
  if (textWidths.size >= 1024) textWidths.clear();
  textWidths.set(text, value); return value;
};
try { new PerformanceObserver(list => { for (const task of list.getEntries()) longTasks.push(task.duration); }).observe({ type: "longtask", buffered: true }); } catch { /* Unsupported browsers report no long-task evidence. */ }
/** Summarize every diagnostic timing sample without treating an empty population as zero-duration success. */
const percentiles = (values: number[]) => { const ordered = [...values].sort((a, b) => a - b); return { samples: values.length, p50: ordered[Math.floor(ordered.length * .5)] ?? null, p95: ordered[Math.floor(ordered.length * .95)] ?? null, max: ordered.at(-1) ?? null }; };
/** Project bounded priority candidates and draw collision-free labels for this standalone diagnostic scene. */
function drawLabels() {
  context.clearRect(0, 0, width, height);
  if (!data || !showTitles) return;
  context.font = "11px system-ui,sans-serif";
  const items = selectMemoryScreenLabels({ nodes: data.nodes, candidateIndices: data.labelCandidates, focusedIndex: selected >= 0 ? selected : null,
    pointAt: index => memoryRenderPoint(data!, index), camera, scale: Math.min(width, height) * .4 / data.extent, width, height, measureText: measureLabel, orderedCandidates: true });
  for (const item of items) { context.fillStyle = "#09111bea"; context.fillRect(item.x - 3, item.y - 11, item.width + 6, 16); context.fillStyle = item.core ? "#fff0b0" : "#c6dfed"; context.fillText(item.text, item.x, item.y + 1); }
  canvas.dataset.labelCount = String(items.length);
}
/** Submit the standalone graph scene and labels; keep this diagnostic page separate from full workspace acceptance claims. */
function draw() {
  frame = 0;
  if (!renderer || !data) return;
  renderer.setFocus(selected); renderer.render(camera); drawLabels();
  canvas.dataset.rotation = `${camera.yaw.toFixed(3)},${camera.pitch.toFixed(3)}`;
}
/** Coalesce redraw requests into one animation frame; keep input handlers from synchronously redrawing the whole graph. */
function schedule() { if (!frame && !benchmarking) frame = requestAnimationFrame(draw); }
/** Update the backing buffer and label transform from the visible CSS bounds and capped device-pixel ratio, then request a redraw. */
function resize() {
  const rect = canvas.parentElement!.getBoundingClientRect(); width = rect.width; height = rect.height;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  renderer?.resize(width, height, ratio); labels.width = Math.round(width * ratio); labels.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0); schedule();
}
/** Create renderer resources for the current context and schedule a draw; allocation failures select the fallback path. */
function initialize() {
  if (!gl) { state.textContent = "WebGL2 unavailable. Open the workspace to exercise its Canvas fallback."; return; }
  try { renderer = new MemoryWebGLRenderer(gl); if (data) renderer.setData(data); resize(); canvas.dataset.renderer = "webgl2"; schedule(); }
  catch (error) { output.textContent = `Renderer initialization failed: ${String(error)}`; }
}
/** Replace the synthetic graph worker and clear prior diagnostics before collecting the requested graph and its convergence updates. */
function load() {
  worker?.terminate(); longTasks.length = 0; done = false;
  const count = Number(document.querySelector<HTMLSelectElement>("#size")!.value);
  canvas.setAttribute("aria-busy", "true"); state.textContent = `Generating ${count.toLocaleString()} synthetic nodes in worker…`;
  const started = performance.now();
  const nodes: MemoryGraphNode[] = [], index = new Map<string, number>();
  worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = event => {
    const message = event.data;
    if (message.kind === "error") { state.textContent = message.message; return; }
    if (message.kind === "nodes") for (const node of message.nodes as MemoryGraphNode[]) { index.set(node.id, nodes.length); nodes.push(node); }
    if (message.kind === "initial") { data = { ...message.data, nodes, index }; renderer?.setData(data!); canvas.dataset.nodeCount = String(data!.nodes.length); state.textContent = `Usable seed at ${(performance.now() - started).toFixed(1)} ms; layout running. You can rotate now.`; }
    if (message.kind === "positions" && data) {
      data.coordinates = message.coordinates; data.extent = message.extent; data.picking.bounds = message.pickingBounds; renderer?.updateCoordinates(data.coordinates, data.extent, data.picking);
      done = message.done;
      canvas.dataset.layoutVolume = message.volume.toFixed(4);
      if (done) { state.textContent = `${data.nodes.length.toLocaleString()} nodes / ${data.edgeKinds.length.toLocaleString()} edges; converged in ${(performance.now() - started).toFixed(1)} ms. Ready to measure.`; canvas.setAttribute("aria-busy", "false"); }
    }
    schedule();
  };
  worker.onerror = event => { state.textContent = `Worker failed: ${event.message}`; };
  worker.postMessage({ mode: "3d", fixtureCount: count });
}
document.querySelector("#load")!.addEventListener("click", load);
document.querySelector("#titles")!.addEventListener("click", event => { showTitles = !showTitles; (event.target as HTMLElement).textContent = `Titles: ${showTitles ? "on" : "off"}`; schedule(); });
document.querySelector("#benchmark")!.addEventListener("click", () => {
  if (!data || !renderer || !done || benchmarking) { state.textContent = "Wait for layout convergence before measurement."; return; }
  benchmarking = true; cancelAnimationFrame(frame); frame = 0;
  state.textContent = `Measuring ${data.nodes.length.toLocaleString()} nodes. Keep this tab visible; background tabs throttle animation frames.`;
  (document.querySelector("#benchmark") as HTMLButtonElement).disabled = true;
  const loadLayoutLongTasks = [...longTasks];
  const intervals: number[] = [], submission: number[] = [], picking: number[] = [];
  let previous = 0, count = 0;
  /** Measure controlled camera draws after warmup and preserve all raw interval/submission data for this standalone diagnostic. */
  const run = (timestamp: number) => {
    if (!renderer || !data || gl?.isContextLost()) {
      benchmarking = false;
      (document.querySelector("#benchmark") as HTMLButtonElement).disabled = false;
      state.textContent = "Measurement aborted: renderer or context unavailable. Measure again after restoration.";
      return;
    }
    if (count % 30 === 0) state.textContent = `Measurement frame ${count}/270 · visibility ${document.visibilityState}`;
    if (count >= 30 && previous) intervals.push(timestamp - previous);
    previous = timestamp; camera.yaw += .008; camera.zoom = 1 + .25 * Math.sin(count / 40);
    const start = performance.now(); draw();
    if (count >= 30) submission.push(performance.now() - start);
    if (++count < 270) { requestAnimationFrame(run); return; }
    for (let i = 0; i < 200; i++) { const before = performance.now(); renderer.pick(width * (.1 + .8 * (i % 20) / 20), height * (.1 + .8 * Math.floor(i / 20) / 10)); picking.push(performance.now() - before); }
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    output.textContent = JSON.stringify({ measuredAt: new Date().toISOString(), nodes: data.nodes.length, edges: data.edgeKinds.length, titles: showTitles,
      viewport: [width, height], devicePixelRatio, userAgent: navigator.userAgent,
      gpu: gl ? debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) : null,
      frameIntervalsMs: percentiles(intervals), cpuSubmissionIncludingLabelsMs: percentiles(submission), cachedPickingMs: percentiles(picking),
      loadLayoutLongTasksMs: loadLayoutLongTasks, hardwareCriterion: "Hardware model must be verified separately; a desktop run does not prove the named integrated-GPU laptop requirement." }, null, 2);
    benchmarking = false; (document.querySelector("#benchmark") as HTMLButtonElement).disabled = false;
    state.textContent = "Measurement complete. Copy the report with its hardware limitation.";
  };
  requestAnimationFrame(run);
});
const pointers = new Map<number, { x: number; y: number }>();
canvas.addEventListener("pointerdown", event => { canvas.focus(); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); canvas.setPointerCapture(event.pointerId); });
canvas.addEventListener("pointermove", event => {
  const p = pointers.get(event.pointerId);
  if (p) { camera.yaw += (event.clientX - p.x) * .009; camera.pitch += (event.clientY - p.y) * .009; pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); schedule(); }
  else if (renderer && data) { const rect = canvas.getBoundingClientRect(); const index = renderer.pick(event.clientX - rect.left, event.clientY - rect.top); if (index !== selected) { selected = index; schedule(); } }
});
canvas.addEventListener("pointerup", event => { pointers.delete(event.pointerId); if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); if (data && selected >= 0) state.textContent = `Selected ${data.nodes[selected]!.label}`; });
canvas.addEventListener("pointercancel", event => pointers.delete(event.pointerId));
canvas.addEventListener("wheel", event => { event.preventDefault(); camera.zoom = Math.max(.35, Math.min(5, camera.zoom * Math.exp(-event.deltaY * .001))); schedule(); }, { passive: false });
canvas.addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-"].includes(event.key)) return;
  event.preventDefault(); camera.yaw += event.key === "ArrowLeft" ? -.15 : event.key === "ArrowRight" ? .15 : 0;
  camera.pitch += event.key === "ArrowUp" ? -.15 : event.key === "ArrowDown" ? .15 : 0;
  if (["+", "=", "-"].includes(event.key)) camera.zoom = Math.max(.35, Math.min(5, camera.zoom * (event.key === "-" ? .9 : 1.1)));
  schedule();
});
canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); renderer?.dispose(); renderer = null; state.textContent = "Context lost; restoring in one second. Workspace uses its bounded Canvas fallback during loss."; });
canvas.addEventListener("webglcontextrestored", initialize);
document.querySelector("#context")!.addEventListener("click", () => { const extension = gl?.getExtension("WEBGL_lose_context"); extension?.loseContext(); setTimeout(() => extension?.restoreContext(), 1000); });
new ResizeObserver(resize).observe(canvas.parentElement!);
initialize(); load();
