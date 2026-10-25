import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryGraph3D } from "./MemoryGraphWebGL3D.js";
import { compareMemoryEdgeProjection } from "./memory-edge-projection-diagnostic.js";
import { useMemory3DLayout } from "./use-memory-3d-layout.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { readLargeMemoryOverview } from "./memory-overview-response.js";
import type { MemoryGraphOverviewResponse } from "../../api.js";
import { downloadMemoryFrameBenchmark, type MemoryFrameBenchmarkResult, type MemoryBenchmarkScene } from "./memory-frame-benchmark.js";
import { startMemoryLoadObservation, type MemoryLoadObservation } from "./memory-load-benchmark.js";
import "./memory-atlas.css";

type ApiLoadRun = { observation:MemoryLoadObservation; count:number; payload:MemoryGraphOverviewResponse|null;
  bytes:number|null; decodedAtMs:number|null; layoutDoneAtMs:number|null; ending:boolean; finishing:boolean;
  deadline:ReturnType<typeof setTimeout>|null; cancelFixture?:()=>void };

/** Mount the real3D component with backend-free synthetic controls and explicit diagnostic reports; no operator credentials or canonical data are used. */
function MemoryGraphReview() {
  const benchmarkNativeEdges = new URLSearchParams(window.location.search).has("nativeEdges");
  const benchmarkProjectedEdges = new URLSearchParams(window.location.search).has("projectedEdges");
  const [count, setCount] = useState<2000 | 10000 | 50000>(2000), [titles, setTitles] = useState(true);
  const [forceCanvas, setForceCanvas] = useState(false), [reset, setReset] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [apiPayload, setApiPayload] = useState<MemoryGraphOverviewResponse | null>(null);
  const [apiStatus, setApiStatus] = useState("");
  const [apiLoading, setApiLoading] = useState(false);
  const apiLoadRun = useRef<ApiLoadRun|null>(null);
  const [apiLoadReport,setApiLoadReport] = useState<Record<string,unknown>|null>(null);
  const [benchmarkToken, setBenchmarkToken] = useState(0), [benchmarkResult, setBenchmarkResult] = useState<MemoryFrameBenchmarkResult | null>(null);
  const [benchmarkGpuTimings, setBenchmarkGpuTimings] = useState(false);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [pixelRunning,setPixelRunning] = useState(false),[pixelReport,setPixelReport] = useState<unknown>(null);
  const [benchmarkScene, setBenchmarkScene] = useState<MemoryBenchmarkScene>("full");
  const { layout, error } = useMemory3DLayout(apiPayload, true, apiPayload ? 0 : count);
  /** Freeze the load observation boundary, drain whole overlapping tasks and publish completion plus observer provenance. Rendering submission does not establish GPU completion. */
  const finishApiLoad = async (run:ApiLoadRun,status:string,renderBoundary:Record<string,unknown>={}) => {
    if(apiLoadRun.current!==run||run.finishing)return;
    run.finishing=true;if(run.deadline)clearTimeout(run.deadline);
    const endedAtMs=performance.now();
    const complete=status==="complete"&&renderBoundary.renderReturnObserved===true;
    try{performance.measure("spaceapp-memory-api-load-window",{start:run.observation.startedAtMs,end:endedAtMs,detail:{nodes:run.count,status}});}catch{}
    const taskObservation=await run.observation.finish(endedAtMs,complete);
    if(apiLoadRun.current!==run)return;
    const observed=complete&&(taskObservation as {status:string}).status==="observed";
    setApiLoadReport({status:observed?"observed":"unknown",loadCompletion:complete?"complete":"unknown",completionReason:status,requestedNodes:run.count,bytes:run.bytes,
      performanceTimeOriginMs:performance.timeOrigin,decodedAtMs:run.decodedAtMs,layoutDoneAtMs:run.layoutDoneAtMs,
      renderBoundary,taskObservation,
      scope:"Load click before fixture request through real parser/Zod, UI chunk accumulation, React commit, matching-payload layout.done, then two rAF callbacks and a task. Whole overlapping UI tasks retained.",
      initialGpuUpload:{exactTimestampMs:null,status:complete?"submission-bounded":"unknown",boundMs:[run.decodedAtMs,endedAtMs],
        limitation:"A render-end data-rotation mutation bounds CPU draw submission only; exact initial upload time, asynchronous GPU completion and presentation are not measured."},
      priorDiagnosticCorrection:"The earlier API-shaped decode wall time had no LongTask observer and did not cover React/layout/GPU upload; it was not evidence of no >100ms loading task.",
      limitation:"Synthetic API-shaped bytes exercise production decoder and chunked layout input, not HTTP/auth/server latency or the entire production workspace."});
    apiLoadRun.current=null;setApiLoading(false);setApiStatus("API-shaped load task observation "+(observed?"complete":"unknown")+"; download the raw API-load JSON for scope and limitations.");
  };
  /** Generate API-shaped bytes off-thread, run production decoding/validation and observe the matching streamed layout/render; retain errors and incomplete outcomes. */
  const loadApiFixture = async () => {
    if (apiLoadRun.current) return;
    const run:ApiLoadRun={observation:startMemoryLoadObservation(),count,payload:null,bytes:null,decodedAtMs:null,layoutDoneAtMs:null,ending:false,finishing:false,deadline:null};
    apiLoadRun.current=run;
    run.deadline=setTimeout(()=>{void finishApiLoad(run,"120-second timeout");run.cancelFixture?.();},120000);
    setApiLoading(true);
    setApiLoadReport(null);
    setApiStatus("Generating API-shaped JSON in worker…"); setSelected(null);
    let worker:Worker|null=null;
    try {
      worker = new Worker(new URL("./memory-overview-fixture.worker.ts", import.meta.url), { type: "module" });
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        run.cancelFixture=()=>{worker?.terminate();reject(new Error("Fixture observation cancelled"));};
        worker!.onmessage = event => event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.bytes);
        worker!.onerror = event => reject(new Error(event.message || "Fixture worker failed"));
        worker!.postMessage(count);
      });
      run.bytes=bytes.byteLength;
      const decoded = await readLargeMemoryOverview(new Response(bytes)) as MemoryGraphOverviewResponse;
      if(apiLoadRun.current!==run||run.finishing)return;
      run.payload=decoded;run.decodedAtMs=performance.now();
      setApiPayload(decoded);
      setApiStatus(`API-shaped JSON: ${run.bytes.toLocaleString()} bytes decoded/validated in ${(run.decodedAtMs-run.observation.startedAtMs).toFixed(1)} ms; observing matching layout and bounded component render. No HTTP/admin/server benchmark is implied.`);
    } catch (caught) { if(apiLoadRun.current===run){setApiStatus(String(caught));void finishApiLoad(run,"load error: "+String(caught));} }
    finally { worker?.terminate();run.cancelFixture=undefined; }
  };
  useEffect(()=>{
    const run=apiLoadRun.current;
    if(!run||run.finishing)return;
    if(run.payload&&apiPayload===run.payload&&error){void finishApiLoad(run,"layout error: "+error);return;}
    if(run.ending||!run.payload||apiPayload!==run.payload||layout?.payload!==run.payload||!layout.done)return;
    run.ending=true;run.layoutDoneAtMs=performance.now();
    let active=true,renderReturns=0;
    const renderObserver=new MutationObserver(records=>{renderReturns+=records.filter(record=>record.attributeName==="data-rotation").length;});
    if(host.current)renderObserver.observe(host.current,{attributes:true,subtree:true,attributeFilter:["data-rotation"]});
    void(async()=>{
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      await new Promise(resolve=>setTimeout(resolve,0));
      renderReturns+=renderObserver.takeRecords().length;renderObserver.disconnect();
      if(!active||apiLoadRun.current!==run||run.finishing)return;
      const canvas=host.current?.querySelector<HTMLCanvasElement>('canvas[role="application"]');
      const renderer=host.current?.querySelector<HTMLElement>("[data-renderer]")?.dataset.renderer;
      void finishApiLoad(run,"complete",{renderReturnObserved:renderReturns>0&&renderer==="webgl2"&&Boolean(canvas?.width&&canvas?.height)&&document.visibilityState==="visible",
        nodes:layout.data.nodes.length,edges:layout.data.edgeKinds.length,layoutVolume:layout.volume,
        observedRenderEndMutations:renderReturns,renderer,visible:document.visibilityState==="visible",drawingBuffer:canvas?[canvas.width,canvas.height]:null,
        endPolicy:"Matching-payload layout.done React effect; observe actual component render-end attribute; wait two rAF callbacks plus one task. Exact initial GPU upload time remains unknown."});
    })();
    return()=>{active=false;renderObserver.disconnect();};
  },[layout?.done,layout?.payload,apiPayload,error]);
  useEffect(()=>()=>{const run=apiLoadRun.current;if(run){apiLoadRun.current=null;if(run.deadline)clearTimeout(run.deadline);run.observation.cancel();run.cancelFixture?.();}},[]);
  /** Invoke WEBGL_lose_context on the real component and request later restoration as an explicit functional diagnostic. */
  const loseContext = () => {
    const canvas = host.current?.querySelector("canvas"), gl = canvas?.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context");
    extension?.loseContext(); setTimeout(() => extension?.restoreContext(), 2000);
  };
  return <>
    <style>{`body{margin:0;background:#09111b;color:#c6dfed;font:14px system-ui}header{display:flex;gap:12px;padding:16px;align-items:center;flex-wrap:wrap}button,select{font:inherit;padding:8px}p{margin:12px 16px}.review-stage{position:relative;height:70vh;margin:16px;border:1px solid #385068}.review-stage>.memory-3d-surface{inset:0}.memory-3d-hint{color:#c6dfed}`}</style>
    <fieldset disabled={apiLoading} style={{border:0,margin:0,padding:0}}><header><strong>Actual MemoryGraph3D component</strong><label>Nodes <select aria-label="Review graph size" disabled={apiLoading} value={count} onChange={event => { setSelected(null); setApiPayload(null); setApiStatus(""); setCount(Number(event.currentTarget.value) as typeof count); }}><option value="2000">2,000</option><option value="10000">10,000</option><option value="50000">50,000</option></select></label>
      <button onClick={() => setTitles(value => !value)}>Titles: {titles ? "on" : "off"}</button><button onClick={() => setReset(value => value + 1)}>Reset camera</button>
      <SpaceToggle compact label="Force bounded Canvas fallback" checked={forceCanvas} onChange={setForceCanvas} />
      <button disabled={forceCanvas} onClick={loseContext}>Lose context for 2 seconds</button></header>
    <p><button disabled={apiLoading||benchmarkRunning||pixelRunning||forceCanvas} onClick={() => void loadApiFixture()}>Load API-shaped JSON through real parser</button> <span role="status">{apiStatus}</span></p>
    <button disabled={!apiLoadReport} onClick={()=>{if(!apiLoadReport)return;const url=URL.createObjectURL(new Blob([JSON.stringify(apiLoadReport,null,2)],{type:"application/json"}));const link=document.createElement("a");link.href=url;link.download="spaceapp-api-shaped-load.json";link.click();setTimeout(()=>URL.revokeObjectURL(url),5000);}}>Download API-load JSON</button>
    <p><button disabled={!layout?.done || forceCanvas || benchmarkRunning || pixelRunning} onClick={() => {setBenchmarkResult(null);setBenchmarkToken(value=>value+1);}}>{benchmarkRunning ? "Measuring frames…" : "Measure actual component frames"}</button></p>
    <SpaceToggle compact label="Include GPU stage timing (diagnostic overhead)" disabled={benchmarkRunning} checked={benchmarkGpuTimings} onChange={setBenchmarkGpuTimings} />
    <label>Scene <select aria-label="Frame diagnostic scene" disabled={benchmarkRunning} value={benchmarkScene} onChange={event=>{setBenchmarkScene(event.target.value as MemoryBenchmarkScene);setBenchmarkResult(null);}}><option value="full">Full graph (acceptance)</option><option value="edges-only">Edges only (diagnostic)</option><option value="nodes-only">Nodes only (diagnostic)</option><option value="empty">Empty (diagnostic)</option></select></label>
    <button disabled={!benchmarkResult} onClick={()=>{if(benchmarkResult)downloadMemoryFrameBenchmark(benchmarkResult);}}>Download frame JSON</button>
    <button disabled={!layout?.done || benchmarkRunning || pixelRunning} onClick={async()=>{if(!layout)return;setPixelRunning(true);try{setPixelReport(await compareMemoryEdgeProjection(layout.data));}finally{setPixelRunning(false);}}}>{pixelRunning?"Comparing pixels…":"Compare analytic projection pixels"}</button>
    </fieldset><p role="status">{error ?? (layout ? `${layout.data.nodes.length.toLocaleString()} nodes / ${layout.data.edgeKinds.length.toLocaleString()} edges · ${layout.done ? "layout complete" : "layout converging; view already usable"}` : "Preparing synthetic graph in worker…")}</p>
    {benchmarkNativeEdges && !benchmarkProjectedEdges ? <p>Experimental native lines without line antialiasing. Appearance not validated; timings are diagnostic only.</p> : null}
    <div className="review-stage" ref={host} style={{pointerEvents:apiLoading?"none":undefined}}>{layout ? <MemoryGraph3D nodes={layout.atlas.nodes} edges={layout.atlas.edges} positions={layout.atlas.positions} coordinates={layout.depth} renderData={layout.data} layoutVolume={layout.volume} showTitles={titles} selectedNodeId={selected} onSelectNode={setSelected} loading={!layout.done} resetToken={reset} forceCanvas={forceCanvas} benchmarkToken={benchmarkToken} benchmarkGpuTimings={benchmarkGpuTimings} benchmarkScene={benchmarkScene} benchmarkNativeEdges={benchmarkNativeEdges} benchmarkProjectedEdges={benchmarkProjectedEdges} onBenchmarkRunningChange={setBenchmarkRunning} onBenchmarkResult={setBenchmarkResult} /> : null}</div>
    {apiLoadReport?<pre aria-label="API-shaped load task report" style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(apiLoadReport,null,2)}</pre>:null}
    {benchmarkResult ? <pre aria-label="Actual component frame result" style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(benchmarkResult,null,2)}</pre> : null}
    {pixelReport ? <pre aria-label="Analytic projection pixel comparison" style={{whiteSpace:"pre-wrap"}}>{JSON.stringify(pixelReport,null,2)}</pre> : null}
    <p aria-live="polite">Selected: {selected ? layout?.data.nodes[layout.data.index.get(selected) ?? -1]?.label ?? selected : "none"}</p>
    <p>No backend, credentials, wallet or real memory. Drag, arrow keys, scroll/pinch and +/- operate the actual component. Forced fallback is a branch check; context loss/restoration is a separate real WebGL event test.</p>
  </>;
}
createRoot(document.getElementById("root")!).render(<MemoryGraphReview />);
