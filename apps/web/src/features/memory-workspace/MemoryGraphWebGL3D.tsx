import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { DEFAULT_MEMORY_CAMERA, memory3DVolumeRatio, type MemoryCamera3D, type MemoryPoint3D } from "./memory-3d.js";
import { MemoryGraphCanvas3D } from "./MemoryGraphCanvas3D.js";
import { memoryRenderPoint, prepareMemoryRenderData, type MemoryRenderData } from "./memory-render-data.js";
import { MemoryWebGLRenderer } from "./memory-webgl-renderer.js";
import { selectMemoryScreenLabels } from "./memory-webgl-math.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { runMemoryFrameBenchmark, type MemoryFrameBenchmarkResult, type MemoryBenchmarkScene } from "./memory-frame-benchmark.js";

export type MemoryGraph3DProps = {
  nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>; coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean; selectedNodeId: string | null; onSelectNode: (id: string) => void;
  loading: boolean; resetToken: number;
  renderData?: MemoryRenderData;
  layoutVolume?: number;
  /** Exercise fallback in the demo without changing browser settings. */
  forceCanvas?: boolean;
  /** Opt-in synthetic review only; ordinary workspaces never display these controls. */
  benchmarkToken?: number;
  /** GPU elapsed queries can change GPU scheduling; keep them off for frame acceptance. */
  benchmarkGpuTimings?: boolean;
  /** Scene isolation is explicitly ineligible for performance acceptance. */
  benchmarkScene?: MemoryBenchmarkScene;
  /** Synthetic-only appearance/performance diagnostic, never acceptance evidence. */
  benchmarkNativeEdges?: boolean;
  /** Legacy synthetic flag: screen-space analytic AA is now the default. When
   * explicitly set, it also takes precedence over the native-line diagnostic. */
  benchmarkProjectedEdges?: boolean;
  onBenchmarkRunningChange?: (running: boolean) => void;
  onBenchmarkResult?: (value: MemoryFrameBenchmarkResult) => void;
};

/** Own WebGL resources, input and bounded labels for the3D view. Streamed render data is reused; loss or unavailable WebGL selects the2k Canvas fallback. */
export function MemoryGraph3D(props: MemoryGraph3DProps) {
  const { nodes, edges, positions, coordinates, renderData, forceCanvas = false, benchmarkNativeEdges = false, benchmarkProjectedEdges = false } = props;
  const nativeEdges = benchmarkNativeEdges && !benchmarkProjectedEdges;
  const data = useMemo(() => renderData ?? prepareMemoryRenderData(nodes, edges, positions, coordinates), [renderData, nodes, edges, positions, coordinates]);
  const volume = useMemo(() => props.layoutVolume ?? memory3DVolumeRatio([...coordinates.values()]), [coordinates, props.layoutVolume]);
  const [fallback, setFallback] = useState(forceCanvas);
  const canvasRef = useRef<HTMLCanvasElement>(null), labelsRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const scheduleRef = useRef<() => void>(() => {});
  const benchmarkRef = useRef<() => void>(() => {});
  const latest = useRef({ props, data }); latest.current = { props, data };
  const fallbackData = useMemo(() => {
    const subset = nodes.slice(0, 2000), ids = new Set(subset.map(node => node.id));
    return { nodes: subset, edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, 6000),
      coordinates: new Map(subset.flatMap(node => { const p = coordinates.get(node.id); return p ? [[node.id, p] as const] : []; })),
      positions: new Map(subset.flatMap(node => { const p = positions.get(node.id); return p ? [[node.id, p] as const] : []; })) };
  }, [nodes, edges, coordinates, positions]);
  useEffect(() => { cameraRef.current = { ...DEFAULT_MEMORY_CAMERA }; scheduleRef.current(); }, [props.resetToken]);
  useEffect(() => {
    const canvas = canvasRef.current, labelCanvas = labelsRef.current;
    if (!canvas || !labelCanvas || forceCanvas) { setFallback(true); return; }
    const context = labelCanvas.getContext("2d");
    // Nodes and edges implement their own pixel coverage. Do not multisample the
    // full Retina framebuffer as well; labels keep their separate full-DPR canvas.
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: true, stencil:true });
    if (!gl || !context) { setFallback(true); return; }
    let renderer: MemoryWebGLRenderer | null = null;
    let uploaded: MemoryRenderData | null = null;
    let frame = 0, width = 1, height = 1, hover = -1, downX = 0, downY = 0, dragged = false, benchmarking = false;
    let cancelBenchmark: (() => void) | null = null;
    let benchmarkScene: MemoryBenchmarkScene = "full";
    const pointers = new Map<number, { x: number; y: number }>();
    const textWidths = new Map<string, number>();
    /** Measure a label in CSS pixels using a bounded text-width cache; clear the cache before it can grow with the graph. */
    const measureLabel = (text: string) => {
      const cached = textWidths.get(text); if (cached !== undefined) return cached;
      const value = context.measureText(text).width;
      if (textWidths.size >= 1024) textWidths.clear();
      textWidths.set(text, value); return value;
    };
    /** Upload changed topology or coordinates, draw the requested scene and bounded labels, and publish draw-end attributes. A return means CPU submission, not GPU completion or presentation. */
    const render = () => {
      frame = 0;
      if (!renderer || gl.isContextLost()) return;
      const { props: current, data: graph } = latest.current;
      if (uploaded !== graph) {
        if (uploaded?.styles === graph.styles) renderer.updateCoordinates(graph.coordinates, graph.extent, graph.picking);
        else { renderer.setData(graph); hover = -1; }
        uploaded = graph;
      }
      const focus = hover >= 0 ? hover : graph.index.get(current.selectedNodeId ?? "") ?? -1;
      renderer.setFocus(focus); renderer.render(cameraRef.current, {
        edges: benchmarkScene === "full" || benchmarkScene === "edges-only",
        nodes: benchmarkScene === "full" || benchmarkScene === "nodes-only"
      });
      context.clearRect(0, 0, width, height);
      let labelCount = 0;
      if (current.showTitles && benchmarkScene === "full") {
        context.font = "11px system-ui, sans-serif";
        const labels = selectMemoryScreenLabels({ nodes: graph.nodes, candidateIndices: graph.labelCandidates, focusedIndex: focus >= 0 ? focus : null,
          pointAt: index => memoryRenderPoint(graph, index), camera: cameraRef.current,
          scale: Math.min(width, height) * 0.4 / graph.extent, width, height, measureText: measureLabel, orderedCandidates: true });
        for (const label of labels) {
          context.fillStyle = "#09111bea"; context.fillRect(label.x - 3, label.y - 11, label.width + 6, 16);
          context.fillStyle = label.core ? "#fff0b0" : "#c6dfed"; context.fillText(label.text, label.x, label.y + 1);
        }
        labelCount = labels.length;
      }
      canvas.dataset.labelCount = String(labelCount);
      canvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };
    /** Coalesce redraw requests into one animation frame; keep input handlers from synchronously redrawing the whole graph. */
    const schedule = () => { if (!benchmarking && !frame && renderer && !gl.isContextLost()) frame = requestAnimationFrame(render); };
    scheduleRef.current = schedule;
    benchmarkRef.current = () => {
      if (benchmarking || !renderer || latest.current.props.loading || gl.isContextLost()) return;
      const graph = latest.current.data, expectedWidth = width, expectedHeight = height;
      const expectedTitles = latest.current.props.showTitles;
      const benchmarkCamera = cameraRef.current;
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      cancelAnimationFrame(frame); frame = 0; benchmarking = true;
      latest.current.props.onBenchmarkRunningChange?.(true);
      benchmarkScene = latest.current.props.benchmarkScene ?? "full";
      const edgesIncluded = benchmarkScene === "full" || benchmarkScene === "edges-only";
      const nodesIncluded = benchmarkScene === "full" || benchmarkScene === "nodes-only";
      const gpuTimings = Boolean(latest.current.props.benchmarkGpuTimings);
      if (gpuTimings) renderer.beginGpuBenchmark();
      cancelBenchmark = runMemoryFrameBenchmark({ camera: benchmarkCamera, render,
        recordTraceWindow:(start,end,status)=>{
          if(status==="complete")try{performance.measure("spaceapp-memory-frame-window",{start,end,detail:{nodes:graph.nodes.length,edges:graph.edgeKinds.length,scene:benchmarkScene}});}catch{/* Raw rAF measurements remain available if User Timing is unsupported. */}
        },
        valid: () => Boolean(renderer && !gl.isContextLost() && latest.current.data.styles === graph.styles && !latest.current.props.loading &&
          cameraRef.current === benchmarkCamera && latest.current.props.showTitles === expectedTitles &&
          width === expectedWidth && height === expectedHeight && document.visibilityState === "visible" && document.hasFocus()),
        metadata: { nodes: graph.nodes.length, edges: graph.edgeKinds.length, viewport: [width, height], devicePixelRatio: window.devicePixelRatio,
          titles: expectedTitles, labelsIncluded: expectedTitles && benchmarkScene === "full", scene: benchmarkScene,
          performanceAcceptanceEligible: benchmarkScene === "full" && expectedTitles && !gpuTimings && renderer.edgeStrategy !== "native",
          renderedNodes: nodesIncluded ? graph.nodes.length : 0, renderedEdges: edgesIncluded ? graph.edgeKinds.length : 0,
          gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          renderer: "actual MemoryGraph3D WebGL2 component", pickingMethod: "world-bvh", gpuTimingEnabled: gpuTimings,
          edgeStrategy: renderer.edgeStrategy,
          edgeOcclusionEnabled:renderer.edgeOcclusionEnabled,contextStencil:gl.getContextAttributes()?.stencil,
          edgeRendering: renderer.edgeStrategy === "native" ? "native GL_LINES prototype; no line antialiasing; full original edge count" : renderer.edgeStrategy === "projected" ? "single-pass screen-space analytic triangles; same coverage and window depth, no per-fragment reciprocal-W multiplication" : "indexed batched analytic triangles, shared corners and native reciprocal-W coverage", contextAntialias: gl.getContextAttributes()?.antialias,
          drawingBuffer: [gl.drawingBufferWidth,gl.drawingBufferHeight], performanceTimeOriginMs:performance.timeOrigin,userAgent: navigator.userAgent },
        complete: value => { value.metadata.gpuStages = renderer?.finishGpuBenchmark() ?? { available: false };
          benchmarkScene = "full"; benchmarking = false; cancelBenchmark = null;
          latest.current.props.onBenchmarkRunningChange?.(false); latest.current.props.onBenchmarkResult?.(value); }
      });
    };
    /** Update the backing buffer and label transform from the visible CSS bounds and capped device-pixel ratio, then request a redraw. */
    const resize = () => {
      const rect = canvas.parentElement!.getBoundingClientRect(); width = rect.width; height = rect.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      try { renderer?.resize(width, height, ratio); } catch { renderer?.dispose(); renderer = null; setFallback(true); }
      labelCanvas.width = Math.max(1, Math.round(width * ratio)); labelCanvas.height = Math.max(1, Math.round(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0); schedule();
    };
    /** Create renderer resources for the current context and schedule a draw; allocation failures select the fallback path. */
    const initialize = () => {
      try { renderer = new MemoryWebGLRenderer(gl, nativeEdges, !nativeEdges); uploaded = null; hover = -1; setFallback(false); resize(); schedule(); }
      catch { renderer?.dispose(); renderer = null; setFallback(true); }
    };
    /** Prevent permanent context loss, stop outstanding rendering/benchmark work, release resources and expose the bounded Canvas fallback. */
    const lost = (event: Event) => {
      event.preventDefault(); cancelAnimationFrame(frame); frame = 0; renderer?.dispose(); renderer = null;
      cancelBenchmark?.();
      context.clearRect(0, 0, width, height); pointers.clear(); setFallback(true);
    };
    /** Convert viewport pointer coordinates to CSS pixels relative to this canvas. */
    const local = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    /** Time synchronous BVH selection against the last uploaded model and cached camera. Pending model uploads return no hit; this interval excludes input scheduling and presentation. */
    const pick = (x: number, y: number) => {
      // Match the rendered camera without forcing another scene draw in an input task.
      // React can commit a new model before the scheduled frame uploads it. An
      // old renderer index must not be decoded against that new node array.
      const started = performance.now(), index = uploaded === latest.current.data ? renderer?.pick(x, y) ?? -1 : -1;
      const durationMs = performance.now() - started;
      canvas.dataset.pickDurationMs = durationMs.toFixed(3);
      canvas.dispatchEvent(new CustomEvent("memory-graph-pick", { detail: { index, durationMs, method: "world-bvh" } }));
      return index;
    };
    /** Focus and capture the pointer, initialize drag tracking, and schedule a camera redraw. */
    const down = (event: PointerEvent) => {
      canvas.focus(); canvas.setPointerCapture(event.pointerId);
      const p = local(event); pointers.set(event.pointerId, p); downX = p.x; downY = p.y; dragged = false; hover = -1; schedule();
    };
    /** Update drag or pinch camera state; without a captured pointer, update the hovered node using the current rendered model. */
    const move = (event: PointerEvent) => {
      const p = local(event), previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * after / before));
        } else { cameraRef.current.yaw += (p.x - previous.x) * 0.009; cameraRef.current.pitch += (p.y - previous.y) * 0.009; }
        pointers.set(event.pointerId, p); schedule();
      } else {
        const index = pick(p.x, p.y);
        canvas.style.cursor = index >= 0 ? "pointer" : "grab";
        if (index !== hover) { hover = index; schedule(); }
      }
    };
    /** Select the hit node only for a click without dragging, then release this pointer capture. */
    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) { const index = pick(p.x, p.y), node = uploaded?.nodes[index]; if (node) latest.current.props.onSelectNode(node.id); }
      pointers.delete(event.pointerId); if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    /** Discard the cancelled pointer so it cannot become a click selection. */
    const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); dragged = true; };
    /** Clear hover only when no pointer is captured, preserving an active drag. */
    const leave = () => { if (!pointers.size && hover !== -1) { hover = -1; schedule(); } };
    /** Consume the wheel gesture, clamp camera zoom, and schedule drawing outside the input task. */
    const wheel = (event: WheelEvent) => { event.preventDefault(); cameraRef.current.zoom = Math.max(0.35, Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))); schedule(); };
    /** Handle keyboard rotation and zoom while preserving the canvas focus and selection contract. */
    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-"].includes(event.key)) {
        event.preventDefault(); cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        if (["+", "=", "-"].includes(event.key)) cameraRef.current.zoom = Math.max(.35, Math.min(5, cameraRef.current.zoom * (event.key === "-" ? .9 : 1.1)));
        schedule();
      } else if (event.key === "Enter") {
        const current = latest.current, chosen = current.data.index.get(current.props.selectedNodeId ?? "");
        const node = chosen !== undefined ? current.data.nodes[chosen] : current.data.nodes.find(item => isMemoryCoreLabel(item.label));
        if (node) current.props.onSelectNode(node.id);
      }
    };
    canvas.addEventListener("webglcontextlost", lost); canvas.addEventListener("webglcontextrestored", initialize);
    canvas.addEventListener("pointerdown", down); canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel); canvas.addEventListener("pointerleave", leave); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("keydown", key);
    const observer = new ResizeObserver(resize); observer.observe(canvas.parentElement!); initialize();
    return () => {
      cancelBenchmark?.(); observer.disconnect(); cancelAnimationFrame(frame); renderer?.dispose(); scheduleRef.current = () => {}; benchmarkRef.current = () => {};
      canvas.removeEventListener("webglcontextlost", lost); canvas.removeEventListener("webglcontextrestored", initialize);
      canvas.removeEventListener("pointerdown", down); canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel); canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("keydown", key);
    };
  }, [forceCanvas, nativeEdges]);
  useEffect(() => { scheduleRef.current(); }, [data, props.showTitles, props.selectedNodeId]);
  useEffect(() => { if (props.benchmarkToken) benchmarkRef.current(); }, [props.benchmarkToken]);
  return <div className="memory-3d-surface" data-renderer={fallback ? "canvas2d" : "webgl2"}>
    <canvas ref={canvasRef} style={{ visibility: fallback ? "hidden" : "visible" }} tabIndex={fallback ? -1 : 0} role="application" aria-hidden={fallback} aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open." aria-busy={props.loading} data-titles-visible={props.showTitles} data-layout-volume={volume.toFixed(4)} />
    <canvas ref={labelsRef} className="memory-3d-labels" aria-hidden="true" style={{ visibility: fallback ? "hidden" : "visible" }} />
    {fallback ? <div className="memory-3d-fallback"><MemoryGraphCanvas3D {...props} {...fallbackData} /><span className="memory-3d-fallback-notice" role="status">Canvas fallback · showing up to 2,000 nodes</span></div> : <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>}
  </div>;
}
