import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryGraphOverviewResponse } from "../src/api.js";
import { useMemory3DLayout } from "../src/features/memory-workspace/use-memory-3d-layout.js";
import { memoryGraphFixture } from "../src/features/memory-workspace/memory-graph-fixture.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { createProgressiveMemoryLayout } from "../src/features/memory-workspace/memory-progressive-layout.js";
import { prepareMemoryRenderData } from "../src/features/memory-workspace/memory-render-data.js";

class LayoutWorker {
  static instances: LayoutWorker[] = [];
  onmessage: ((event: { data: Record<string, unknown> }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { LayoutWorker.instances.push(this); }
}

beforeEach(() => { LayoutWorker.instances = []; vi.stubGlobal("Worker", LayoutWorker); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("memory worker failure recovery", () => {
  it("clears a previous layout failure while a replacement fetch is pending or 3D is disabled", () => {
    const payload = { data: memoryGraphFixture(100) } as MemoryGraphOverviewResponse;
    const { result, rerender } = renderHook(({ payload, enabled }: { payload: MemoryGraphOverviewResponse | null; enabled: boolean }) => useMemory3DLayout(payload, enabled), { initialProps: { payload: payload as MemoryGraphOverviewResponse | null, enabled: true } });
    const failed = LayoutWorker.instances[0]!;
    act(() => failed.onerror?.({ message: "Previous layout failed" }));
    expect(result.current.error).toContain("Previous layout failed");
    rerender({ payload: null, enabled: true });
    expect(result.current.error).toBeNull();
    expect(result.current.layout).toBeNull();
    expect(LayoutWorker.instances).toHaveLength(1);
    act(() => failed.onmessageerror?.());
    expect(result.current.error).toBeNull();
    rerender({ payload, enabled: true });
    act(() => LayoutWorker.instances[1]!.onerror?.({ message: "Another layout failed" }));
    expect(result.current.error).toContain("Another layout failed");
    rerender({ payload, enabled: false });
    expect(result.current.error).toBeNull();
    expect(result.current.layout).toBeNull();
  });
  it.each(["native", "protocol", "messageerror"])("keeps distinct, pickable nodes after a pre-initial %s error", mode => {
    const { result } = renderHook(() => useMemory3DLayout(null, true, 50000));
    const worker = LayoutWorker.instances[0]!;
    act(() => {
      if (mode === "native") worker.onerror?.({ message: "worker failed" });
      else if (mode === "protocol") worker.onmessage?.({ data: { kind: "error", message: "worker failed" } });
      else worker.onmessageerror?.();
    });
    const layout = result.current.layout!;
    expect(layout.atlas.nodes).toHaveLength(2000);
    expect(layout.depth.size).toBe(2000);
    expect(new Set([...layout.depth.values()].map(p => `${p.x},${p.y},${p.z}`)).size).toBe(2000);
    expect(layout.data.index.size).toBe(2000);
    expect(layout.data.picking).toBeTruthy();
    expect(layout.atlas.edges.length).toBeLessThanOrEqual(6000);
    expect(layout.fullEdgeCount).toBe(layout.atlas.edges.length);
    expect(layout.done).toBe(false);
    expect(result.current.error).toContain("recovery layout");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    act(() => worker.onmessage?.({ data: { kind: "positions", done: true, depth: [] } }));
    expect(result.current.layout).toBe(layout); // Queued publications cannot corrupt recovery.
  });

  it.each(["missing", "constructor", "send"])("recovers when the worker is %s", mode => {
    if (mode === "missing") vi.stubGlobal("Worker", undefined);
    else if (mode === "constructor") vi.stubGlobal("Worker", class { constructor() { throw new Error("blocked worker"); } });
    if (mode === "send") vi.stubGlobal("Worker", class extends LayoutWorker { postMessage = vi.fn(() => { throw new Error("send failed"); }); });
    const { result } = renderHook(() => useMemory3DLayout(null, true, 2000));
    expect(result.current.layout?.atlas.nodes).toHaveLength(2000);
    expect(result.current.layout?.depth.size).toBe(2000);
    expect(result.current.error).toContain("recovery layout");
  });

  it.each([false, true])("retains the last publication after a later failure (completed: %s)", completed => {
    const { result } = renderHook(() => useMemory3DLayout(null, true, 100));
    const worker = LayoutWorker.instances[0]!;
    const graph = memoryGraphFixture(100), atlas = createMemoryAtlas(graph.nodes, graph.edges, false);
    const points = createProgressiveMemoryLayout(atlas.nodes, atlas.edges).positions();
    const data = prepareMemoryRenderData(atlas.nodes, atlas.edges, atlas.positions, points);
    act(() => {
      worker.onmessage?.({ data: { kind: "nodes", nodes: atlas.nodes } });
      worker.onmessage?.({ data: { kind: "initial", atlas, data, depth: [...points], volume: 1, fullEdgeCount: atlas.edges.length, sourceLinkCount: 0 } });
      if (completed) worker.onmessage?.({ data: { kind: "positions", coordinates: data.coordinates, extent: data.extent, pickingBounds: data.picking.bounds, depth: [...points], volume: 1, done: true } });
    });
    const initial = result.current.layout;
    expect(initial?.done).toBe(completed);
    act(() => worker.onerror?.({ message: "convergence stopped" }));
    expect(result.current.layout).toBe(initial);
    expect(result.current.error).toBe("convergence stopped");
  });

  it("stops queued chunks and ignores superseded worker errors", async () => {
    vi.useFakeTimers();
    const payload = { data: memoryGraphFixture(10000) } as MemoryGraphOverviewResponse;
    const { result, rerender } = renderHook(({ enabled }) => useMemory3DLayout(payload, enabled), { initialProps: { enabled: true } });
    const failed = LayoutWorker.instances[0]!;
    act(() => failed.onerror?.({ message: "interrupted upload" }));
    const count = failed.postMessage.mock.calls.length;
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(failed.postMessage).toHaveBeenCalledTimes(count);
    expect(result.current.layout?.atlas.nodes).toHaveLength(2000);
    rerender({ enabled: false });
    rerender({ enabled: true });
    act(() => failed.onerror?.({ message: "late error" }));
    expect(result.current.error).toBeNull();
    expect(result.current.layout?.done).toBe(false);
  });
});

describe("bounded synthetic recovery input", () => {
  it.each([2000, 10000, 50000] as const)("matches the induced prefix of the full %i-node fixture", count => {
    const full = memoryGraphFixture(count), limited = memoryGraphFixture(count, 2000);
    const ids = new Set(limited.nodes.map(node => node.id));
    expect(limited.nodes).toEqual(full.nodes.slice(0, 2000));
    expect(limited.edges).toEqual(full.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)));
    expect(limited.edges.length).toBeLessThanOrEqual(6000);
  });
});
