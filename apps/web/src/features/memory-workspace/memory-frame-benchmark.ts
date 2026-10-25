import type { MemoryCamera3D } from "./memory-3d.js";

export type MemoryBenchmarkScene = "full" | "edges-only" | "nodes-only" | "empty";

/** Export the actual raw result through an ordinary browser download, including failed runs. */
export function downloadMemoryFrameBenchmark(result: MemoryFrameBenchmarkResult) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url;
  link.download = `spaceapp-frame-${result.metadata.nodes}-${result.metadata.scene ?? "full"}-${Date.now()}.json`;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Sort a copy of all supplied durations and report sample count, floor-index p50/p95 and maximum; empty input has null metrics and no samples are discarded. */
export function memoryTimingSummary(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50: sorted[Math.floor(sorted.length * .5)] ?? null,
    p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null };
}
export type MemoryFrameBenchmarkResult = {
  status: "complete" | "aborted"; measuredAt: string; metadata: Record<string, unknown>;
  frameIntervalsMs: ReturnType<typeof memoryTimingSummary>; cpuSubmissionIncludingLabelsMs: ReturnType<typeof memoryTimingSummary>;
  rawFrameIntervalsMs: number[]; rawCpuSubmissionMs: number[]; limitation: string;
};
/** Run 270 real component draws:30 warmup callbacks and 240 measured intervals.
 * rAF interval i ends at callback i; CPU sample i measures that callback's draw
 * submission and can affect the following interval. Preserve both populations,
 * including aborted runs. Neither is GPU completion, presentation latency or
 * an automatic acceptance verdict. Returns an idempotent cancellation callback. */
export function runMemoryFrameBenchmark(options: {
  camera: MemoryCamera3D; render: () => void; valid: () => boolean;
  metadata: Record<string, unknown>; complete: (value: MemoryFrameBenchmarkResult) => void;
  recordTraceWindow?: (start:number,end:number,status:MemoryFrameBenchmarkResult["status"])=>void;
  requestFrame?: typeof requestAnimationFrame; cancelFrame?: typeof cancelAnimationFrame; now?: () => number;
}) {
  const request = options.requestFrame ?? requestAnimationFrame, cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const now = options.now ?? (() => performance.now()), original = { ...options.camera };
  const intervals: number[] = [], cpu: number[] = [];
  let frame = 0, count = 0, previous = 0, stopped = false;
  let windowStart:number|null=null,windowEnd:number|null=null;
  /** Stop once, restore the original camera, retain partial/failed samples, publish the exact rAF window and request a final ordinary draw. */
  const finish = (status: MemoryFrameBenchmarkResult["status"]) => {
    if (stopped) return;
    stopped = true; cancelFrame(frame); Object.assign(options.camera, original);
    if(windowStart!==null&&windowEnd!==null)options.recordTraceWindow?.(windowStart,windowEnd,status);
    options.complete({ status, measuredAt: new Date().toISOString(), metadata: {...options.metadata,
      measuredRafWindowMs:windowStart===null?null:[windowStart,windowEnd],
      cpuSampleAlignment:"CPU sample i executes at interval i's ending callback; its work can affect the following interval, not the preceding one."},
      frameIntervalsMs: memoryTimingSummary(intervals), cpuSubmissionIncludingLabelsMs: memoryTimingSummary(cpu),
      rawFrameIntervalsMs: intervals, rawCpuSubmissionMs: cpu,
      limitation: "30 warmup + 240 controlled rotating/zooming frames through the actual component. rAF intervals include browser scheduling; CPU submission includes labels but excludes asynchronous GPU completion and final presentation. No presented-frame or full input-to-present measurement is implied." });
    options.render();
  };
  /** Advance the controlled rotation/zoom stimulus, measure the real render callback, and retain 240 rAF intervals after 30 warmup callbacks; invalid conditions abort the run. */
  const run = (timestamp: number) => {
    if (stopped) return;
    if (!options.valid()) { finish("aborted"); return; }
    if (count >= 30 && previous) {
      if(windowStart===null)windowStart=previous;
      intervals.push(timestamp - previous);windowEnd=timestamp;
    }
    previous = timestamp;
    options.camera.yaw += .008; options.camera.zoom = 1 + .25 * Math.sin(count / 40);
    const start = now(); options.render();
    if (count >= 30) cpu.push(now() - start);
    if (++count < 270) frame = request(run);
    else finish("complete");
  };
  frame = request(run);
  return () => finish("aborted");
}
