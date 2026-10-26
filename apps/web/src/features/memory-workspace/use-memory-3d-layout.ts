import { useEffect, useState } from "react";
import type { MemoryGraphOverviewResponse } from "../../api.js";
import { createMemoryAtlas } from "./memory-atlas.js";
import { memory3DVolumeRatio, type MemoryPoint3D } from "./memory-3d.js";
import { prepareMemoryRenderData, type MemoryRenderData } from "./memory-render-data.js";
import { createProgressiveMemoryLayout } from "./memory-progressive-layout.js";
import { memoryGraphFixture } from "./memory-graph-fixture.js";
import type { MemoryGraphNode } from "@space/contracts";

type Atlas = ReturnType<typeof createMemoryAtlas>;
type Layout = { payload: MemoryGraphOverviewResponse | null; fixtureCount: number; atlas: Atlas; data: MemoryRenderData; depth: Map<string, MemoryPoint3D>; volume: number; done: boolean; fullEdgeCount: number; sourceLinkCount: number };
/** Build only a bounded emergency sample, with no UI-thread force steps. Counts
 * and picking describe this sample; done stays false because it did not converge. */
function recoveryLayout(payload: MemoryGraphOverviewResponse | null, fixtureCount: 0 | 100 | 2000 | 10000 | 50000): Layout {
  const input = fixtureCount ? memoryGraphFixture(fixtureCount, 2000) : payload!.data;
  const nodes = input.nodes.slice(0, 2000), ids = new Set(nodes.map(node => node.id));
  const edges: typeof input.edges = [];
  for (const edge of input.edges) {
    if (ids.has(edge.source) && ids.has(edge.target)) edges.push(edge);
    if (edges.length === 6000) break;
  }
  const atlas = createMemoryAtlas(nodes, edges, false);
  const depth = createProgressiveMemoryLayout(atlas.nodes, atlas.edges).positions();
  return { payload, fixtureCount, atlas, depth, data: prepareMemoryRenderData(atlas.nodes, atlas.edges, atlas.positions, depth),
    volume: memory3DVolumeRatio([...depth.values()]), done: false,
    fullEdgeCount: atlas.edges.length, sourceLinkCount: atlas.edges.filter(edge => edge.type === "CONTAINS" || edge.type === "DERIVED_FROM").length };
}
/** Own one worker per payload/fixture generation. Preserve its last usable layout
 * on failure, or build a bounded seed before the first publication. Failed and
 * superseded generations cannot publish or send more chunks. */
export function useMemory3DLayout(payload: MemoryGraphOverviewResponse | null, enabled: boolean, fixtureCount: 0 | 100 | 2000 | 10000 | 50000 = 0) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || (!payload && !fixtureCount)) return;
    setError(null);
    let active = true, worker: Worker | null = null, current: Layout | null = null;
    /** Stop once, retaining matching streamed data or a usable capped seed. */
    const fail = (message: string) => {
      if (!active) return;
      active = false;
      worker?.terminate();
      if (!current) {
        current = recoveryLayout(payload, fixtureCount);
        setLayout(current);
        setError(`${message}. Showing a recovery layout of up to 2,000 nodes; switch 3D off and on to retry.`);
      } else setError(message);
    };
    const cleanup = () => { active = false; worker?.terminate(); };
    if (typeof Worker === "undefined") { fail("Memory layout workers are unavailable"); return cleanup; }
    try {
      worker = new Worker(new URL("./memory-network-layout.worker.ts", import.meta.url), { type: "module" });
      const streamedNodes: MemoryGraphNode[] = [], streamedIndex = new Map<string, number>();
      worker.onmessage = event => {
        if (!active) return;
        const message = event.data;
        if (message.kind === "error") { fail(message.message); return; }
        if (message.kind === "nodes") for (const node of message.nodes as MemoryGraphNode[]) { streamedIndex.set(node.id, streamedNodes.length); streamedNodes.push(node); }
        if (message.kind === "initial") {
          current = { payload, fixtureCount, atlas: { ...message.atlas, nodes: streamedNodes }, data: { ...message.data, nodes: streamedNodes, index: streamedIndex },
            fullEdgeCount: message.fullEdgeCount, sourceLinkCount: message.sourceLinkCount, depth: new Map(message.depth), volume: message.volume, done: false };
          setLayout(current);
        }
        if (message.kind === "positions" && current) {
          current = { ...current, data: { ...current.data, coordinates: message.coordinates, extent: message.extent, picking: { ...current.data.picking, bounds: message.pickingBounds } }, depth: new Map(message.depth), volume: message.volume, done: message.done };
          setLayout(current);
        }
      };
      worker.onerror = event => fail(event.message || "Memory layout worker failed");
      worker.onmessageerror = () => fail("Memory layout worker response could not be read");
      if (!fixtureCount && payload && payload.data.nodes.length > 2000) {
        worker.postMessage({ kind: "begin" });
        const target = worker;
        void (async () => {
          for (let offset = 0; offset < payload.data.nodes.length && active; offset += 1000) {
            target.postMessage({ kind: "nodes", nodes: payload.data.nodes.slice(offset, offset + 1000) });
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          for (let offset = 0; offset < payload.data.edges.length && active; offset += 2000) {
            target.postMessage({ kind: "edges", edges: payload.data.edges.slice(offset, offset + 2000) });
            await new Promise(resolve => setTimeout(resolve, 0));
          }
          if (active) target.postMessage({ kind: "run" });
        })().catch(caught => fail(caught instanceof Error ? caught.message : "Memory layout could not be sent"));
      } else worker.postMessage({ nodes: payload?.data.nodes ?? [], edges: payload?.data.edges ?? [], mode: "3d", fixtureCount: fixtureCount || undefined });
    } catch (caught) { fail(caught instanceof Error ? caught.message : "Memory layout worker could not start"); }
    return cleanup;
  }, [payload, enabled, fixtureCount]);
  return { layout: enabled && layout?.payload === payload && layout.fixtureCount === fixtureCount ? layout : null, error };
}
