import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, ClipboardCheck, Network, Search, X } from "../ui-theme/app-icons.js";
import type { MemoryGraphNodeDetail } from "@space/contracts";
import { api, type MemoryGraphOverviewResponse } from "../../api.js";
import { MemoryGraphErrorBoundary } from "./MemoryGraphErrorBoundary.js";
import { MemoryNodeDetail } from "./MemoryNodeDetail.js";
import { createMemoryAtlas, type MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import { MemoryGraph3D } from "./MemoryGraph3D.js";
import type { MemoryPoint3D } from "./memory-3d.js";
import { useMemory3DLayout } from "./use-memory-3d-layout.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { downloadMemoryFrameBenchmark, type MemoryFrameBenchmarkResult, type MemoryBenchmarkScene } from "./memory-frame-benchmark.js";
import { MemoryCalendarView } from "./MemoryCalendarView.js";
import { MemoryReviewView } from "./MemoryReviewView.js";
import "./memory-atlas.css";

const DesktopMemoryGraph = lazy(() => import("./DesktopMemoryGraph.js"));
const EMPTY_DEPTH = new Map<string, MemoryPoint3D>();

/** Coordinate canonical memory search/details,2D and streamed3D views. Demo-only synthetic graphs have local details and disable canonical search until Archive is restored. */
export function MemoryWorkspace({ shellMode, onClose, initialMode = "calendar" }: {
  shellMode: "desktop" | "tablet" | "mobile";
  activeRoomId: string | null;
  onClose: () => void;
  initialMode?: "atlas" | "calendar" | "review";
}) {
  const [selectedMode, setWorkspaceMode] = useState<"atlas" | "calendar" | "review">(initialMode);
  // Mobile shows the Calendar list only: no graph canvas (ADR-006) and no review panels.
  const workspaceMode = shellMode === "mobile" ? "calendar" : selectedMode;
  const [view3D, setView3D] = useState(false);
  const [showTitles, setShowTitles] = useState(true);
  const [reset3D, setReset3D] = useState(0);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [graph, setGraph] = useState<MemoryGraphOverviewResponse | null>(null);
  const [graph3D, setGraph3D] = useState<MemoryGraphOverviewResponse | null>(null);
  const [loading3D, setLoading3D] = useState(false);
  const [fetchError3D, setFetchError3D] = useState<string | null>(null);
  const [fixtureCount, setFixtureCount] = useState<0 | 100 | 2000 | 10000 | 50000>(0);
  const benchmarkMode = getSpaceRuntimeKind() === "demo" && typeof window !== "undefined" && new URLSearchParams(window.location.search).has("memoryBenchmark");
  const benchmarkNativeEdges = benchmarkMode && new URLSearchParams(window.location.search).has("memoryNativeEdges");
  const benchmarkProjectedEdges = benchmarkMode && new URLSearchParams(window.location.search).has("memoryProjectedEdges");
  const [benchmarkToken, setBenchmarkToken] = useState(0);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkGpuTimings, setBenchmarkGpuTimings] = useState(false);
  const [benchmarkScene, setBenchmarkScene] = useState<MemoryBenchmarkScene>("full");
  const [benchmarkResult, setBenchmarkResult] = useState<MemoryFrameBenchmarkResult | null>(null);
  const synthetic3D = getSpaceRuntimeKind() === "demo" ? fixtureCount : 0;
  const syntheticGraphActive = workspaceMode === "atlas" && view3D && synthetic3D > 0;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryGraphNodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeDetail = useCallback(() => {
    detailRequest.current++;
    setSelectedNodeId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
  }, []);

  /** Clear synthetic-only selection when returning to 2D while preserving canonical Archive details. */
  const toggle3D = () => {
    if (syntheticGraphActive) closeDetail();
    setView3D(value => !value);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryDraft.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [queryDraft]);

  useEffect(() => {
    /** Focus memory search for the slash shortcut unless focus is already in an editable control or synthetic search is unavailable. */
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (selectedNodeId) closeDetail();
        else if (queryDraft) { setQueryDraft(""); setQuery(""); }
        else onClose();
      }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLElement && event.target.isContentEditable)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDetail, onClose, queryDraft, selectedNodeId]);

  useEffect(() => {
    if (workspaceMode !== "atlas") return;
    let active = true;
    setLoading(true);
    setError(null);
    closeDetail();
    // Search covers the entire archive; removing the month picker must not hide old memories.
    void api.memoryGraphOverview({ q: query || undefined, month: "all", relationMode: "RELATIONS" })
      .then(payload => { if (active) setGraph(payload); })
      .catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "Memory could not be loaded."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceMode, query, closeDetail]);

  useEffect(() => {
    if (workspaceMode !== "atlas" || !view3D) return;
    let active = true;
    setLoading3D(true); setGraph3D(null); setFetchError3D(null);
    // Let the layout worker generate and pack the synthetic graph directly. Avoid cloning
    // 150k edge objects to the UI and back into a second worker before it can render.
    if (synthetic3D) { setLoading3D(false); return; }
    void api.memoryGraphOverview({ q: query || undefined, month: "all", relationMode: "RELATIONS", limit: typeof Worker === "undefined" ? 2000 : 50000,
      ...(getSpaceRuntimeKind() === "demo" && fixtureCount ? { demoNodes: fixtureCount } : {}) })
      .then(payload => { if (active) setGraph3D(payload); })
      .catch(caught => { if (active) setFetchError3D(caught instanceof Error ? caught.message : "3D memory could not be loaded."); })
      .finally(() => { if (active) setLoading3D(false); });
    return () => { active = false; };
  }, [workspaceMode, view3D, query, fixtureCount, synthetic3D]);

  useEffect(() => () => { detailRequest.current++; }, []);
  const selectNode = useCallback((nodeId: string) => {
    const request = ++detailRequest.current;
    setSelectedNodeId(nodeId);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    void api.memoryGraphNode(nodeId)
      .then(payload => { if (request === detailRequest.current) setDetail(payload); })
      .catch(caught => { if (request === detailRequest.current) setDetailError(caught instanceof Error ? caught.message : "This memory could not be opened."); })
      .finally(() => { if (request === detailRequest.current) setDetailLoading(false); });
  }, []);

  const smallAtlas = useMemo(() => createMemoryAtlas(graph?.data.nodes ?? [], graph?.data.edges ?? [], false), [graph]);
  const { layout: layout3D, error: layout3DError } = useMemory3DLayout(synthetic3D ? null : graph3D, workspaceMode === "atlas" && view3D, synthetic3D);
  const error3D = fetchError3D ?? layout3DError;
  const atlas = view3D && layout3D ? layout3D.atlas : smallAtlas;
  const [layout, setLayout] = useState<{ atlas: typeof smallAtlas; positions: Map<string, MemoryAtlasPosition>; depth: Map<string, MemoryPoint3D> } | null>(null);
  useEffect(() => {
    if (workspaceMode !== "atlas" || view3D || !smallAtlas.nodes.length || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ positions: Array<[string, { x: number; y: number }]>; depth: Array<[string, MemoryPoint3D]> }>) => {
      const coordinates = new Map(event.data.positions);
      setLayout({ atlas: smallAtlas, depth: new Map(event.data.depth), positions: new Map([...smallAtlas.positions].map(([id, position]) => [id, { ...position, ...coordinates.get(id) }])) });
      worker.terminate();
    };
    worker.onerror = event => { setError(`Memory layout could not be calculated: ${event.message || "worker unavailable"}`); worker.terminate(); };
    worker.postMessage({ nodes: smallAtlas.nodes, edges: smallAtlas.edges });
    return () => worker.terminate();
  }, [workspaceMode, view3D, smallAtlas]);
  const layoutPending = view3D ? !error3D && (!layout3D || !layout3D.done) : typeof Worker !== "undefined" && smallAtlas.nodes.length > 0 && layout?.atlas !== smallAtlas;
  const atlasPositions = view3D ? atlas.positions : layout?.atlas === smallAtlas ? layout.positions : smallAtlas.positions;
  const summary = view3D && synthetic3D ? (layout3D ? { recordCount: layout3D.atlas.nodes.filter(node => node.type === "MEMORY").length } : undefined) : graph?.data.summary;
  const visibleEdgeCount = view3D && layout3D ? layout3D.fullEdgeCount : atlas.edges.length;
  const sourceLinkCount = view3D && layout3D ? layout3D.sourceLinkCount : atlas.edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length;
  const rawNodeCount = view3D ? (synthetic3D ? atlas.nodes.length : graph3D?.data.nodes.length ?? 0) : graph?.data.nodes.length ?? 0;
  const memoryCount = atlas.nodes.filter(node => node.type === "MEMORY").length;
  const displayGroups = useMemo(() => atlas.groups.filter(group => group.kind !== "tag" || group.count >= 10), [atlas.groups]);
  return (
    <section id="memory-atlas" className="memory-workspace memory-atlas" aria-label="Memory workspace" data-shell-mode={shellMode} data-workspace-mode={workspaceMode} data-view-mode={view3D ? "3D" : "2D"} data-titles-visible={showTitles} data-atlas-layout="network" data-layout-ready={view3D ? Boolean(layout3D?.done) : layout?.atlas === smallAtlas} data-layout-root-x={atlasPositions.get(atlas.nodes.find(node => isMemoryCoreLabel(node.label))?.id ?? "")?.x} data-atlas-group-count={displayGroups.length} data-atlas-color-count={new Set(displayGroups.map(group => group.color)).size}>
      <header className="memory-atlas-header memory-workspace-header">
        <div className="memory-atlas-brand">
          {workspaceMode === "calendar" ? <CalendarIcon aria-hidden="true" /> : workspaceMode === "review" ? <ClipboardCheck aria-hidden="true" /> : <Network aria-hidden="true" />}
          <h2>Memory</h2>
          <span>{workspaceMode.toUpperCase()}</span>
        </div>
        <form className="memory-workspace-controls memory-workspace-search" role="search" onSubmit={event => { event.preventDefault(); if (!syntheticGraphActive) setQuery(queryDraft.trim()); }}>
          <label className="memory-search-input">
            <Search aria-hidden="true" />
            <input ref={searchRef} type="search" name="memoryQuery" aria-label="Search canonical memory" disabled={syntheticGraphActive} aria-describedby={syntheticGraphActive ? "memory-synthetic-search-status" : undefined} placeholder="Search your memory…" value={queryDraft} onChange={event => setQueryDraft(event.currentTarget.value)} />
            {queryDraft && !syntheticGraphActive ? <button type="button" aria-label="Clear memory search" onClick={() => { setQueryDraft(""); setQuery(""); searchRef.current?.focus(); }}><X aria-hidden="true" /></button> : <kbd>/</kbd>}
          </label>
        </form>
        <div className="memory-atlas-actions">
          {shellMode === "mobile" ? null : <div className="memory-workspace-mode-selector" role="group" aria-label="Memory mode switcher">
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "atlas" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "atlas"}
              onClick={() => { setWorkspaceMode("atlas"); closeDetail(); }}
            >
              <Network aria-hidden="true" /> Atlas
            </button>
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "calendar" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "calendar"}
              onClick={() => { setWorkspaceMode("calendar"); closeDetail(); }}
            >
              <CalendarIcon aria-hidden="true" /> Calendar
            </button>
            <button
              type="button"
              className={`memory-mode-pill ${workspaceMode === "review" ? "is-active" : ""}`}
              aria-pressed={workspaceMode === "review"}
              onClick={() => { setWorkspaceMode("review"); closeDetail(); }}
            >
              <ClipboardCheck aria-hidden="true" /> Review
            </button>
          </div>}
          {workspaceMode === "atlas" ? (
            <div className="memory-atlas-view-controls" aria-label="Memory view controls">
              <button type="button" aria-label="Toggle 3D memory view" aria-pressed={view3D} onClick={toggle3D}><span aria-hidden="true">◇</span> {view3D ? "2D" : "3D"}</button>
              <button type="button" aria-label="Toggle memory titles" aria-pressed={showTitles} onClick={() => setShowTitles(value => !value)}>Aa <span>Titles</span></button>
              {view3D ? <button type="button" aria-label="Reset 3D memory view" onClick={() => setReset3D(value => value + 1)}>↺</button> : null}
              {view3D && getSpaceRuntimeKind() === "demo" ? <label>Synthetic nodes <select aria-label="Synthetic memory graph size" value={fixtureCount} onChange={event => { closeDetail(); setFixtureCount(Number(event.currentTarget.value) as typeof fixtureCount); }}><option value="0">Archive</option><option value="100">100</option><option value="2000">2,000</option><option value="10000">10,000</option><option value="50000">50,000</option></select></label> : null}
            </div>
          ) : null}
          <button type="button" className="icon-button memory-atlas-close" aria-label="Close memory workspace" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>
      <div className="memory-atlas-stage memory-workspace-body">
        {workspaceMode === "calendar" ? (
          <MemoryCalendarView
            onSelectNode={selectNode}
            selectedNodeId={selectedNodeId}
            onCloseDetail={closeDetail}
          />
        ) : workspaceMode === "review" ? (
          <MemoryReviewView onOpenRecord={selectNode} />
        ) : (
          <>
            <div className="memory-atlas-intro" aria-label="Memory overview">
              <span className="memory-atlas-eyebrow"><i /> YOUR KNOWLEDGE, CONNECTED</span>
              <h3>Everything you know.<br /><em>Connected.</em></h3>
              <p>Your files, memories and<br />their real connections.</p>
              <dl className="memory-atlas-stats">
                <div><dt>{view3D && fixtureCount ? "Demo memories" : "Memories"}</dt><dd>{summary?.recordCount.toLocaleString() ?? "—"}</dd></div>
                <div><dt>In this map</dt><dd>{memoryCount.toLocaleString()}</dd></div>
                <div><dt>Connections</dt><dd>{visibleEdgeCount.toLocaleString()}</dd></div>
              </dl>
            </div>
            <div className="memory-graph-layout" data-detail-open={Boolean(selectedNodeId)} data-graph-mode="ATLAS" data-source-count={atlas.nodes.filter(node => node.type === "SOURCE").length} data-source-link-count={sourceLinkCount} data-root-visible={atlas.nodes.some(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label))} data-raw-node-count={rawNodeCount} data-visible-node-count={atlas.nodes.length} data-visible-edge-count={visibleEdgeCount}>
              <div className="memory-atlas-2d" hidden={view3D}>{!view3D ? <MemoryGraphErrorBoundary>
                <Suspense fallback={<div className="memory-graph-loading" role="status">Connecting your memories…</div>}>
                  <DesktopMemoryGraph nodes={smallAtlas.nodes} edges={smallAtlas.edges} displayMode="SEMANTIC" relationMode="RELATIONS" selectedNodeId={selectedNodeId} onSelectNode={selectNode} loading={loading || (typeof Worker !== "undefined" && layout?.atlas !== smallAtlas)} error={error} totalNodes={graph?.data.totalMatchingNodes ?? 0} totalEdges={graph?.data.totalMatchingEdges ?? 0} truncated={graph?.data.truncated ?? false} atlasPositions={layout?.atlas === smallAtlas ? layout.positions : smallAtlas.positions} showTitles={showTitles} />
                </Suspense>
              </MemoryGraphErrorBoundary> : null}</div>
              {view3D ? <MemoryGraph3D nodes={atlas.nodes} edges={atlas.edges} positions={atlasPositions} coordinates={layout3D?.depth ?? EMPTY_DEPTH} renderData={layout3D?.data} layoutVolume={layout3D?.volume} forceCanvas={typeof Worker === "undefined"} showTitles={showTitles} selectedNodeId={selectedNodeId} onSelectNode={fixtureCount ? id => setSelectedNodeId(id) : selectNode} loading={loading3D || layoutPending} resetToken={reset3D} benchmarkToken={benchmarkMode ? benchmarkToken : 0} benchmarkGpuTimings={benchmarkGpuTimings} benchmarkScene={benchmarkScene} benchmarkNativeEdges={benchmarkNativeEdges} benchmarkProjectedEdges={benchmarkProjectedEdges} onBenchmarkRunningChange={setBenchmarkRunning} onBenchmarkResult={setBenchmarkResult} /> : null}
              {view3D && error3D ? <div role="alert">{error3D}</div> : null}
            </div>
            {!selectedNodeId && displayGroups.length > 0 ? <aside className="memory-atlas-topics" aria-label="Map topics">
              <span className="memory-atlas-eyebrow">COLOR GUIDE</span>
              <p>Tags, themes & archive months</p>
              <ul>{displayGroups.map(group => <li key={group.id}><i style={{ background: group.color }} /><span title={group.label}>{group.label}</span><small>{group.kind}</small><b>{group.count}</b></li>)}</ul>
            </aside> : null}
            {!selectedNodeId ? <aside className="memory-atlas-insight"><span className="memory-atlas-eyebrow">THE BIGGER PICTURE</span><strong>{atlas.semanticCount.toLocaleString()}</strong><p>semantic connections</p><small>Explore the links between your memories.</small><div className="memory-atlas-spectrum" /></aside> : null}
            {graph?.data.isStale ? <div className="memory-atlas-stale" role="status"><AlertTriangle aria-hidden="true" /> Snapshot awaiting refresh</div> : null}
            {syntheticGraphActive ? <div id="memory-synthetic-search-status" className="memory-atlas-search-status" role="status">Search is unavailable for synthetic graphs. Select Archive to search your memories.</div> : query && !loading && !error ? <div className="memory-atlas-search-status" role="status">{atlas.nodes.length ? `${atlas.nodes.length.toLocaleString()} matching nodes` : "No memories found. Try another search."}</div> : null}
          </>
        )}
        {selectedNodeId && syntheticGraphActive ? <div className="memory-atlas-detail"><aside aria-label="Synthetic memory detail"><h3>{atlas.nodes.find(node => node.id === selectedNodeId)?.label}</h3><p>Synthetic benchmark node. No canonical memory record or backend request.</p><button onClick={closeDetail}>Close</button></aside></div> : selectedNodeId ? <div className="memory-atlas-detail">
          {detailError ? <div className="memory-workspace-error" role="alert"><AlertTriangle /><span>{detailError}</span><button onClick={closeDetail}>Close</button></div> : <MemoryNodeDetail detail={detail} loading={detailLoading} onClose={closeDetail} onSelectNode={selectNode} backLabel={workspaceMode === "calendar" ? "Back to day memories" : undefined} />}
        </div> : null}
      </div>
      {benchmarkMode && view3D ? <aside aria-label="Synthetic workspace frame diagnostic" style={{position:"fixed",left:12,top:80,zIndex:100,width:340,maxHeight:260,overflow:"auto",background:"#09111bf5",color:"#c6dfed",padding:12,border:"1px solid #385068"}}>
        {benchmarkNativeEdges && !benchmarkProjectedEdges ? <p>Experimental native lines without line antialiasing. Appearance not validated; timings are diagnostic only.</p> : null}
        <button disabled={loading3D || layoutPending || benchmarkRunning} onClick={() => {setBenchmarkResult(null);setBenchmarkToken(value=>value+1);}}>{benchmarkRunning ? "Measuring frames…" : "Measure actual workspace frames"}</button>
        <SpaceToggle compact label="Include GPU stage timing (diagnostic overhead)" disabled={benchmarkRunning} checked={benchmarkGpuTimings} onChange={setBenchmarkGpuTimings} />
        <label>Scene <select aria-label="Frame diagnostic scene" disabled={benchmarkRunning} value={benchmarkScene} onChange={event=>{setBenchmarkScene(event.target.value as MemoryBenchmarkScene);setBenchmarkResult(null);}}><option value="full">Full graph (acceptance)</option><option value="edges-only">Edges only (diagnostic)</option><option value="nodes-only">Nodes only (diagnostic)</option><option value="empty">Empty (diagnostic)</option></select></label>
        <button disabled={!benchmarkResult} onClick={()=>{if(benchmarkResult)downloadMemoryFrameBenchmark(benchmarkResult);}}>Download frame JSON</button>
        <pre style={{whiteSpace:"pre-wrap",fontSize:11}}>{benchmarkResult ? JSON.stringify(benchmarkResult,null,2) : "Explicit synthetic diagnostic. 30 warmup + 240 rotating/zooming frames through the real component; keep Chrome focused. CPU submission and rAF intervals are reported separately."}</pre>
      </aside> : null}
    </section>
  );
}
