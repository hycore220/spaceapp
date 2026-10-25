import { useEffect, useState } from "react";
import type { MemoryGraphOverviewResponse } from "../../api.js";
import { createMemoryAtlas } from "./memory-atlas.js";
import { layoutMemoryNetwork3D, memory3DVolumeRatio, type MemoryPoint3D } from "./memory-3d.js";
import { prepareMemoryRenderData, type MemoryRenderData } from "./memory-render-data.js";
import type { MemoryGraphNode } from "@space/contracts";

type Atlas = ReturnType<typeof createMemoryAtlas>;
type Layout = { payload: MemoryGraphOverviewResponse | null; fixtureCount: number; atlas: Atlas; data: MemoryRenderData; depth: Map<string, MemoryPoint3D>; volume: number; done: boolean; fullEdgeCount: number; sourceLinkCount: number };
/** Own one layout worker per payload/fixture generation and expose only matching streamed results. Cleanup cancels further chunk sends and terminates the worker; unsupported Workers use a bounded canonical fallback. */
export function useMemory3DLayout(payload: MemoryGraphOverviewResponse | null, enabled: boolean, fixtureCount: 0 | 100 | 2000 | 10000 | 50000 = 0) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || (!payload && !fixtureCount)) return;
    setError(null);
    if (typeof Worker === "undefined") {
      if (!payload) { setError("Web Workers are required for this synthetic generator."); return; }
      const nodes = payload.data.nodes.slice(0, 2000), ids = new Set(nodes.map(node => node.id));
      const edges = payload.data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, 6000);
      const atlas = createMemoryAtlas(nodes, edges, false), depth = layoutMemoryNetwork3D(atlas.nodes, atlas.edges);
      setLayout({ payload, fixtureCount, atlas, depth, data: prepareMemoryRenderData(atlas.nodes, atlas.edges, atlas.positions, depth), volume: memory3DVolumeRatio([...depth.values()]), done: true,
        fullEdgeCount: edges.length, sourceLinkCount: edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length });
      return;
    }
    const worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
    const streamedNodes: MemoryGraphNode[] = [], streamedIndex = new Map<string, number>();
    worker.onmessage = event => {
      const message = event.data;
      if (message.kind === "error") { setError(message.message); worker.terminate(); return; }
      if (message.kind === "nodes") for (const node of message.nodes as MemoryGraphNode[]) { streamedIndex.set(node.id, streamedNodes.length); streamedNodes.push(node); }
      if (message.kind === "initial") setLayout({ payload, fixtureCount, atlas: { ...message.atlas, nodes: streamedNodes }, data: { ...message.data, nodes: streamedNodes, index: streamedIndex },
        fullEdgeCount: message.fullEdgeCount, sourceLinkCount: message.sourceLinkCount, depth: new Map(message.depth), volume: message.volume, done: false });
      if (message.kind === "positions") setLayout(previous => previous?.payload === payload && previous.fixtureCount === fixtureCount
        ? { ...previous, data: { ...previous.data, coordinates: message.coordinates, extent: message.extent, picking: { ...previous.data.picking, bounds: message.pickingBounds } }, depth: new Map(message.depth), volume: message.volume, done: message.done } : previous);
    };
    worker.onerror = event => { setError(event.message || "Memory layout worker failed"); worker.terminate(); };
    let active = true;
    if (!fixtureCount && payload && payload.data.nodes.length > 2000) {
      worker.postMessage({ kind: "begin" });
      void (async () => {
        for (let offset = 0; offset < payload.data.nodes.length && active; offset += 1000) {
          worker.postMessage({ kind: "nodes", nodes: payload.data.nodes.slice(offset, offset + 1000) });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        for (let offset = 0; offset < payload.data.edges.length && active; offset += 2000) {
          worker.postMessage({ kind: "edges", edges: payload.data.edges.slice(offset, offset + 2000) });
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (active) worker.postMessage({ kind: "run" });
      })();
    } else worker.postMessage({ nodes: payload?.data.nodes ?? [], edges: payload?.data.edges ?? [], mode: "3d", fixtureCount: fixtureCount || undefined });
    return () => { active = false; worker.terminate(); };
  }, [payload, enabled, fixtureCount]);
  return { layout: enabled && layout?.payload === payload && layout.fixtureCount === fixtureCount ? layout : null, error };
}
