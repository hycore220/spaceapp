import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryWorkspace } from "../src/features/memory-workspace/MemoryWorkspace.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import type { MemoryGraphOverviewResponse } from "../src/api.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { prepareMemoryRenderData } from "../src/features/memory-workspace/memory-render-data.js";
import type { MemoryRenderData } from "../src/features/memory-workspace/memory-render-data.js";
import { MemoryGraph3D as WebGLMemoryGraph3D } from "../src/features/memory-workspace/MemoryGraphWebGL3D.js";

const webglRenderer = vi.hoisted(() => {
  const instances: Renderer[] = [];
  class Renderer {
    graph: MemoryRenderData | null = null;
    edgeStrategy = "projected";
    edgeOcclusionEnabled = false;
    setData = vi.fn((data: MemoryRenderData) => { this.graph = data; });
    updateCoordinates = vi.fn();
    setFocus = vi.fn();
    render = vi.fn();
    resize = vi.fn();
    dispose = vi.fn();
    pick = vi.fn(() => this.graph?.nodes.length ? 0 : -1);
    constructor() { instances.push(this); }
  }
  return { instances, Renderer };
});

vi.mock("../src/features/memory-workspace/memory-webgl-renderer.js", () => ({ MemoryWebGLRenderer: webglRenderer.Renderer }));

const graphRenderer = vi.hoisted(() => vi.fn());
const graph3DRenderer = vi.hoisted(() => vi.fn());
const graphLifecycle = vi.hoisted(() => ({
  mounted: vi.fn(),
  unmounted: vi.fn()
}));

vi.mock("../src/features/memory-workspace/DesktopMemoryGraph.js", () => ({
  default: (props: {
    nodes: Array<{ id: string }>;
    edges: Array<{ id: string }>;
    displayMode: "SEMANTIC" | "FOCUSED";
    relationMode: "CLUSTERED" | "RELATIONS";
    selectedNodeId: string | null;
    onSelectNode: (nodeId: string) => void;
    showTitles: boolean;
    loading: boolean;
    error: string | null;
  }) => {
    useEffect(() => {
      graphLifecycle.mounted();
      return () => graphLifecycle.unmounted();
    }, []);
    graphRenderer(props);
    return (
      <div
        className="memory-graph-canvas"
        data-testid="memory-graph-renderer"
        data-node-ids={props.nodes.map((node) => node.id).join(",")}
        data-edge-ids={props.edges.map((edge) => edge.id).join(",")}
        data-display-mode={props.displayMode}
        data-relation-mode={props.relationMode}
        data-selected-node-id={props.selectedNodeId ?? ""}
        data-titles-visible={props.showTitles}
        data-error={props.error ?? ""}
        aria-busy={props.loading}
        role="button" tabIndex={0} aria-label="Open map memory" onClick={() => props.onSelectNode("memory:agent")}
      />
    );
  }
}));

vi.mock("../src/features/memory-workspace/MemoryGraph3D.js", () => ({
  MemoryGraph3D: (props: { nodes: Array<{ id: string }>; showTitles: boolean; loading: boolean; coordinates: Map<string, unknown>; onSelectNode: (id: string) => void }) => {
    graph3DRenderer(props);
    return <div data-testid="memory-graph-3d-renderer" data-node-ids={props.nodes.map(node => node.id).join(",")} data-titles-visible={props.showTitles} aria-busy={props.loading} />;
  }
}));

vi.mock("../src/features/memory-workspace/MemoryCalendarView.js", () => ({
  MemoryCalendarView: ({ onSelectNode }: { onSelectNode: (id: string) => void }) => <button onClick={() => onSelectNode("memory:agent")}>Open calendar memory</button>
}));
vi.mock("../src/features/memory-workspace/MemoryReviewView.js", () => ({
  MemoryReviewView: ({ onOpenRecord }: { onOpenRecord: (id: string) => void }) => <button onClick={() => onOpenRecord("memory:agent")}>Open review memory</button>
}));

const sourceHash = "a".repeat(64);
const sourcePath = "/opt/spaceapp/docs/gemini_history_2026-07.md";
const memoryNode = {
  id: "memory:agent",
  type: "MEMORY",
  label: "Agent Memory",
  sourcePath,
  recordId: "memory:agent",
  position: {
    clustered: { x: 10, y: 20 },
    relations: { x: 30, y: 40 }
  }
} as const;
const roomNode = {
  id: "room:test",
  type: "ROOM",
  label: "room:test",
  sourcePath: null,
  recordId: null,
  position: {
    clustered: { x: 12, y: 22 },
    relations: { x: 32, y: 42 }
  }
} as const;
const explicitTopicNode = {
  id: "topic:space",
  type: "TOPIC",
  label: "Space",
  sourcePath: null,
  recordId: null,
  position: {
    clustered: { x: 14, y: 24 },
    relations: { x: 34, y: 44 }
  }
} as const;
const derivedTopicNode = {
  id: "topic:agent-context",
  type: "TOPIC",
  label: "Agent context",
  sourcePath: null,
  recordId: null,
  position: {
    clustered: { x: 16, y: 26 },
    relations: { x: 36, y: 46 }
  }
} as const;
const sectionNode = {
  id: "section:agent",
  type: "SECTION",
  label: "Agent section",
  sourcePath,
  recordId: null,
  position: {
    clustered: { x: 18, y: 28 },
    relations: { x: 38, y: 48 }
  }
} as const;
const provenanceNode = {
  id: "provenance:operator",
  type: "PROVENANCE",
  label: "operator",
  sourcePath,
  recordId: null,
  position: {
    clustered: { x: 20, y: 30 },
    relations: { x: 40, y: 50 }
  }
} as const;
const sourceNode = {
  id: "source:monthly",
  type: "SOURCE",
  label: "gemini_history_2026-07.md",
  sourcePath,
  recordId: null,
  position: {
    clustered: { x: 22, y: 32 },
    relations: { x: 42, y: 52 }
  }
} as const;

const graphEdges = [{
  id: "edge:room",
  type: "BELONGS_TO_ROOM",
  source: memoryNode.id,
  target: roomNode.id
}, {
  id: "edge:explicit",
  type: "TAGGED_WITH",
  source: memoryNode.id,
  target: explicitTopicNode.id,
  origin: "EXPLICIT_TAG",
  confidence: 1
}, {
  id: "edge:derived",
  type: "TAGGED_WITH",
  source: memoryNode.id,
  target: derivedTopicNode.id,
  origin: "DERIVED_TFIDF",
  confidence: 0.86
}, {
  id: "edge:section",
  type: "CONTAINS",
  source: sectionNode.id,
  target: memoryNode.id
}, {
  id: "edge:provenance",
  type: "DERIVED_FROM",
  source: memoryNode.id,
  target: provenanceNode.id
}, {
  id: "edge:source",
  type: "CONTAINS",
  source: sourceNode.id,
  target: sectionNode.id
}] as const;

const extraSpaceNodes = Array.from({ length: 9 }, (_, index) => ({
  id: `memory:space:${index + 1}`,
  type: "MEMORY" as const,
  label: `Space Memory ${index + 1}`,
  sourcePath,
  recordId: `record:space:${index + 1}`,
  position: {
    clustered: { x: 10 + index, y: 20 + index },
    relations: { x: 30 + index, y: 40 + index }
  }
}));

const extraSpaceEdges = extraSpaceNodes.map((extraNode, index) => ({
  id: `edge:explicit:extra:${index + 1}`,
  type: "TAGGED_WITH" as const,
  source: extraNode.id,
  target: explicitTopicNode.id,
  origin: "EXPLICIT_TAG" as const,
  confidence: 1
}));

const smallTagNode = {
  id: "topic:small",
  type: "TOPIC" as const,
  label: "small-tag",
  sourcePath: null,
  recordId: null,
  position: { clustered: { x: 15, y: 25 }, relations: { x: 35, y: 45 } }
} as const;

const smallTagEdge = {
  id: "edge:explicit:small",
  type: "TAGGED_WITH" as const,
  source: memoryNode.id,
  target: smallTagNode.id,
  origin: "EXPLICIT_TAG" as const,
  confidence: 1
} as const;

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function graphPayload(input: {
  isStale?: boolean;
  issueCount?: number;
  relationMode?: "CLUSTERED" | "RELATIONS";
  nodes?: unknown[];
  edges?: unknown[];
}) {
  const nodes = input.nodes ?? [
    memoryNode,
    ...extraSpaceNodes,
    roomNode,
    explicitTopicNode,
    smallTagNode,
    derivedTopicNode,
    sectionNode,
    provenanceNode,
    sourceNode
  ];
  const edges = input.edges ?? [...graphEdges, ...extraSpaceEdges, smallTagEdge];
  return {
    data: {
      version: 2,
      layoutVersion: 2,
      taxonomyVersion: 1,
      revisionHash: "c".repeat(64),
      generatedAt: "2026-07-16T08:00:00.000Z",
      sourceHash,
      isStale: input.isStale ?? false,
      summary: {
        sourceCount: 2,
        recordCount: 21,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        issueCount: input.issueCount ?? 2
      },
      nodes,
      edges,
      totalMatchingNodes: nodes.length,
      totalMatchingEdges: edges.length,
      truncated: false,
      filters: {
        q: null,
        nodeType: null,
        scope: null,
        roomId: null,
        sourcePath: null,
        lifecycleStatus: null,
        relationMode: input.relationMode ?? "CLUSTERED"
      }
    }
  };
}

function nodeDetail() {
  return {
    node: memoryNode,
    record: {
      id: memoryNode.id,
      sourcePath,
      sectionId: sectionNode.id,
      title: memoryNode.label,
      body: "## Agent Memory\n- Durable fact.",
      createdAt: "2026-07-13T08:00:00.000Z",
      scope: "SYSTEM",
      roomId: null,
      provenance: "operator",
      contentHash: "b".repeat(64),
      lifecycleStatus: "ACTIVE",
      tags: ["Space"],
      topics: [{ label: "Agent context", origin: "DERIVED_TFIDF", confidence: 0.86 }]
    },
    relatedNodes: [roomNode, explicitTopicNode, derivedTopicNode, sectionNode, provenanceNode],
    relatedEdges: graphEdges.filter((edge) => edge.id !== "edge:source"),
    issues: []
  };
}

beforeEach(() => {
  installSpaceRuntime(liveRuntime);
});

describe("Memory atlas search-only experience", () => {
  afterEach(() => { graphRenderer.mockReset(); graph3DRenderer.mockReset(); graphLifecycle.mounted.mockReset(); graphLifecycle.unmounted.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function installFetch() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/memory/graph/overview")) return json(graphPayload({}));
      if (url === "/api/admin/memory/nodes/memory%3Aagent") return json(nodeDetail());
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  it("clears synthetic selection on return to 2D and opens canonical details normally", async () => {
    installSpaceRuntime({ ...liveRuntime, kind: "demo" });
    const requests = installFetch();
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await screen.findByTestId("memory-graph-renderer");
    const toggle = screen.getByRole("button", { name: "Toggle 3D memory view" });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole("combobox", { name: "Synthetic memory graph size" }), { target: { value: "100" } });
    act(() => graph3DRenderer.mock.lastCall![0].onSelectNode("fixture-00001"));
    expect(screen.getByLabelText("Synthetic memory detail")).toBeTruthy();
    expect(screen.queryByLabelText("Memory node detail")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Synthetic memory detail")).toBeNull();
    expect(screen.queryByLabelText("Memory node detail")).toBeNull();
    expect((await screen.findByTestId("memory-graph-renderer")).getAttribute("data-selected-node-id")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Open map memory" }));
    await within(await screen.findByLabelText("Memory node detail")).findByText("Durable fact.");
    expect(requests.mock.calls.some(([url]) => String(url).includes("/memory/nodes/fixture-"))).toBe(false);
  });

  it("keeps pending 3D data empty and stable across unrelated workspace renders", async () => {
    class PendingWorker {
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal("Worker", PendingWorker);
    vi.spyOn(liveRuntime.api, "memoryGraphOverview").mockResolvedValue(graphPayload({}) as MemoryGraphOverviewResponse);
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await screen.findByTestId("memory-graph-renderer");
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" }));
    await waitFor(() => expect(graph3DRenderer.mock.lastCall?.[0].loading).toBe(true));
    const pendingCoordinates = graph3DRenderer.mock.lastCall![0].coordinates;
    expect(pendingCoordinates.size).toBe(0);
    const pendingNodes = graph3DRenderer.mock.lastCall![0].nodes;
    expect(pendingNodes).toEqual([]);
    expect(document.querySelector(".memory-graph-layout")?.getAttribute("data-visible-node-count")).toBe("0");
    expect(screen.getByText("Connecting your memories…").getAttribute("role")).toBe("status");
    fireEvent.click(screen.getByRole("button", { name: "Toggle memory titles" }));
    expect(graph3DRenderer.mock.lastCall![0].coordinates).toBe(pendingCoordinates);
    expect(graph3DRenderer.mock.lastCall![0].nodes).toBe(pendingNodes);
  });
  it("shows the first usable publication during convergence without remounting the 3D view", async () => {
    let layoutWorker: PendingWorker | undefined;
    class PendingWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      terminate() {}
      postMessage(message: { mode?: string }) { if (message.mode === "3d") layoutWorker = this; }
    }
    vi.stubGlobal("Worker", PendingWorker);
    const payload = graphPayload({ nodes: [memoryNode, roomNode], edges: [] }) as MemoryGraphOverviewResponse;
    vi.spyOn(liveRuntime.api, "memoryGraphOverview").mockResolvedValue(payload);
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await screen.findByTestId("memory-graph-renderer");
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" }));
    await waitFor(() => expect(layoutWorker).toBeDefined());
    const surface = screen.getByTestId("memory-graph-3d-renderer");
    expect(surface.getAttribute("data-node-ids")).toBe("");
    const atlas = createMemoryAtlas(payload.data.nodes, [], false);
    const points = new Map(atlas.nodes.map((node, index) => [node.id, { x: index * 10, y: index * 20, z: index * 30 }]));
    const data = prepareMemoryRenderData(atlas.nodes, [], atlas.positions, points);
    act(() => {
      layoutWorker!.onmessage?.({ data: { kind: "nodes", nodes: atlas.nodes } });
      layoutWorker!.onmessage?.({ data: { kind: "initial", atlas, data, depth: [...points], volume: 0, fullEdgeCount: 0, sourceLinkCount: 0 } });
    });
    expect(screen.getByTestId("memory-graph-3d-renderer")).toBe(surface);
    expect(surface.getAttribute("data-node-ids")).toBe(atlas.nodes.map(node => node.id).join(","));
    expect(surface.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("Connecting your memories…")).toBeNull();
    act(() => layoutWorker!.onmessage?.({ data: { kind: "positions", coordinates: data.coordinates, extent: data.extent, pickingBounds: data.picking.bounds, depth: [...points], volume: 0, done: true } }));
    expect(surface.getAttribute("aria-busy")).toBe("false");
    expect(screen.getByTestId("memory-graph-3d-renderer")).toBe(surface);
  });
  it.each(["Calendar", "Review"])("opens canonical details in %s after leaving a synthetic 3D graph", async mode => {
    installSpaceRuntime({ ...liveRuntime, kind: "demo" });
    installFetch();
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await screen.findByTestId("memory-graph-renderer");
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Synthetic memory graph size" }), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: mode }));
    expect((screen.getByRole("searchbox") as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: `Open ${mode.toLowerCase()} memory` }));
    const panel = await screen.findByLabelText("Memory node detail");
    await within(panel).findByText("Durable fact.");
    expect(screen.queryByLabelText("Synthetic memory detail")).toBeNull();
    expect(screen.queryByText(/No canonical memory record/)).toBeNull();
  });
  it("does not advertise synthetic graph nodes as search matches and restores archive search", async () => {
    installSpaceRuntime({ ...liveRuntime, kind: "demo" });
    installFetch();
    const overview = vi.spyOn(liveRuntime.api, "memoryGraphOverview");
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await screen.findByTestId("memory-graph-renderer");
    const search = screen.getByRole("searchbox") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Agent" } });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByText(/matching nodes/);
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" }));
    const size = screen.getByRole("combobox", { name: "Synthetic memory graph size" });
    fireEvent.change(size, { target: { value: "50000" } });
    expect(search.disabled).toBe(true);
    expect(search.value).toBe("Agent");
    expect(screen.getByText("Search is unavailable for synthetic graphs. Select Archive to search your memories.").id).toBe(search.getAttribute("aria-describedby"));
    expect(screen.queryByText(/matching nodes/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear memory search" })).toBeNull();
    const calls = overview.mock.calls.length;
    fireEvent.submit(screen.getByRole("search"));
    expect(overview).toHaveBeenCalledTimes(calls);
    fireEvent.change(size, { target: { value: "0" } });
    await waitFor(() => expect(search.disabled).toBe(false));
    await screen.findByText(/matching nodes/);
    expect(search.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText(/Search is unavailable/)).toBeNull();
    expect(overview).toHaveBeenLastCalledWith(expect.objectContaining({ q: "Agent", limit: 2000 }));
    fireEvent.change(size, { target: { value: "2000" } });
    fireEvent.click(screen.getByRole("button", { name: "Toggle 3D memory view" }));
    expect(search.disabled).toBe(false);
    expect(search.value).toBe("Agent");
    await screen.findByText(/matching nodes/);
  });
  it.each(["desktop", "tablet"] as const)("offers only search and the interactive map on %s", async shellMode => {
    const requests = installFetch();
    render(<MemoryWorkspace shellMode={shellMode} activeRoomId="room:test" onClose={() => undefined} initialMode="atlas" />);
    await waitFor(() => expect(screen.getByTestId("memory-graph-renderer").getAttribute("data-node-ids")).toContain("memory:agent"));
    expect(screen.getAllByRole("searchbox")).toHaveLength(1);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Toggle 3D memory view" }).getAttribute("aria-pressed")).toBe("false");
    const titles = screen.getByRole("button", { name: "Toggle memory titles" });
    expect(titles.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(titles);
    expect(titles.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(titles);
    expect(titles.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "Filters" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Current room" })).toBeNull();
    expect(requests.mock.calls.every(([url]) => String(url).includes("month=all"))).toBe(true);
    expect(screen.getByLabelText("Map topics").textContent).toContain("Space");
    expect(screen.getByLabelText("Map topics").textContent).not.toContain("small-tag");
  });
  it("searches the archive, preserves the renderer and clears search", async () => {
    const requests = installFetch();
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await screen.findByTestId("memory-graph-renderer");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "backup" } });
    await waitFor(() => expect(requests.mock.calls.some(([url]) => String(url).includes("q=backup") && String(url).includes("month=all"))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Clear memory search" }));
    await waitFor(() => expect(String(requests.mock.calls.at(-1)?.[0])).not.toContain("q=backup"));
    expect(graphLifecycle.mounted).toHaveBeenCalledTimes(1);
  });
  it("unmounts the 2D renderer in 3D and restores its archive and workspace state on return", async () => {
    vi.stubGlobal("Worker", undefined);
    const threeDNode = { ...memoryNode, id: "memory:3d-only", recordId: "memory:3d-only", label: "3D-only memory" };
    const requests = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/admin/memory/graph/overview")) {
        const is3D = new URL(url, "http://localhost").searchParams.has("limit");
        return json(is3D ? graphPayload({ nodes: [threeDNode], edges: [] }) : graphPayload({}));
      }
      if (url === "/api/admin/memory/nodes/memory%3Aagent") return json(nodeDetail());
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", requests);
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await screen.findByTestId("memory-graph-renderer");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "backup" } });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByText(/\d+ matching nodes/);
    fireEvent.click(screen.getByRole("button", { name: "Toggle memory titles" }));
    fireEvent.click(screen.getByRole("button", { name: "Open map memory" }));
    await within(await screen.findByLabelText("Memory node detail")).findByText("Durable fact.");
    const original = screen.getByTestId("memory-graph-renderer");
    const originalNodeIds = original.getAttribute("data-node-ids"), originalEdgeIds = original.getAttribute("data-edge-ids");
    const mountsBefore3D = graphLifecycle.mounted.mock.calls.length, unmountsBefore3D = graphLifecycle.unmounted.mock.calls.length;
    const toggle = screen.getByRole("button", { name: "Toggle 3D memory view" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(graphLifecycle.unmounted).toHaveBeenCalledTimes(unmountsBefore3D + 1);
    expect(screen.queryByTestId("memory-graph-renderer")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("memory-graph-3d-renderer").getAttribute("data-node-ids")).toBe(threeDNode.id));
    expect(screen.getByTestId("memory-graph-3d-renderer").getAttribute("data-titles-visible")).toBe("false");
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    const restored = await screen.findByTestId("memory-graph-renderer");
    expect(restored.getAttribute("data-node-ids")).toBe(originalNodeIds);
    expect(restored.getAttribute("data-edge-ids")).toBe(originalEdgeIds);
    expect(restored.getAttribute("data-selected-node-id")).toBe(memoryNode.id);
    expect(restored.getAttribute("data-titles-visible")).toBe("false");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("backup");
    expect(screen.getByLabelText("Memory node detail").textContent).toContain("Durable fact.");
    expect(screen.queryByTestId("memory-graph-3d-renderer")).toBeNull();
    expect(graphLifecycle.mounted).toHaveBeenCalledTimes(mountsBefore3D + 1);
    expect(graphLifecycle.unmounted).toHaveBeenCalledTimes(unmountsBefore3D + 1);
    expect(document.activeElement).toBe(toggle);
    expect(requests.mock.calls.filter(([url]) => String(url).includes("/overview") && !String(url).includes("limit="))).toHaveLength(2);
  });
  it.each(["fetch", "layout"] as const)("reports a failed 50k %s without corrupting 2D and recovers when 3D is reopened", async failureStage => {
    const archive = graphPayload({}) as MemoryGraphOverviewResponse;
    const fullNode = { ...memoryNode, id: "memory:full-graph", recordId: "memory:full-graph" };
    const full = graphPayload({ nodes: [fullNode], edges: [] }) as MemoryGraphOverviewResponse;
    let failUpgrade: (error: Error) => void = () => undefined;
    let finishUpgrade: (value: MemoryGraphOverviewResponse) => void = () => undefined;
    const pendingUpgrade = new Promise<MemoryGraphOverviewResponse>((resolve, reject) => { finishUpgrade = resolve; failUpgrade = reject; });
    const failureMessage = failureStage === "fetch" ? "Large 3D overview failed" : "Large 3D layout failed";
    let attempts = 0;
    const overview = vi.spyOn(liveRuntime.api, "memoryGraphOverview").mockImplementation(query => {
      if (query?.limit === 50000) return ++attempts === 1 ? pendingUpgrade : Promise.resolve(full);
      return Promise.resolve(archive);
    });
    class LayoutWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: unknown;
      private stopped = false;
      terminate() { this.stopped = true; }
      postMessage(message: { nodes: typeof archive.data.nodes; edges: typeof archive.data.edges; mode?: "3d" }) {
        const atlas = createMemoryAtlas(message.nodes, message.edges, false);
        const points = new Map(message.nodes.map((node, index) => [node.id, { x: index * 10, y: 0, z: 0 }]));
        queueMicrotask(() => {
          if (this.stopped) return;
          if (message.mode !== "3d") {
            this.onmessage?.({ data: { positions: [...atlas.positions], depth: [...points] } });
            return;
          }
          const data = prepareMemoryRenderData(atlas.nodes, atlas.edges, atlas.positions, points);
          for (const reply of [
            { kind: "nodes", nodes: atlas.nodes },
            { kind: "initial", atlas, data, fullEdgeCount: atlas.edges.length, sourceLinkCount: 0, depth: [...points], volume: 0 },
            failureStage === "layout" && attempts === 1 ? { kind: "error", message: failureMessage } :
              { kind: "positions", coordinates: data.coordinates, extent: data.extent, pickingBounds: data.picking.bounds, depth: [...points], volume: 0, done: true }
          ]) this.onmessage?.({ data: reply });
        });
      }
    }
    vi.stubGlobal("Worker", LayoutWorker);
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    await waitFor(() => expect(screen.getByTestId("memory-graph-renderer").getAttribute("aria-busy")).toBe("false"));
    const originalNodeIds = screen.getByTestId("memory-graph-renderer").getAttribute("data-node-ids");
    const toggle = screen.getByRole("button", { name: "Toggle 3D memory view" });
    fireEvent.click(toggle);
    await waitFor(() => expect(attempts).toBe(1));
    expect(screen.getByTestId("memory-graph-3d-renderer").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      if (failureStage === "fetch") failUpgrade(new Error(failureMessage));
      else finishUpgrade(full);
    });
    expect((await screen.findByRole("alert")).textContent).toBe(failureMessage);
    expect(screen.getByTestId("memory-graph-3d-renderer").getAttribute("aria-busy")).toBe("false");

    fireEvent.click(toggle);
    const restored = await screen.findByTestId("memory-graph-renderer");
    expect(restored.getAttribute("data-node-ids")).toBe(originalNodeIds);
    expect(restored.getAttribute("data-error")).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(restored.getAttribute("aria-busy")).toBe("false"));

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("memory-graph-3d-renderer").getAttribute("data-node-ids")).toBe(fullNode.id));
    await waitFor(() => expect(screen.getByTestId("memory-graph-3d-renderer").getAttribute("aria-busy")).toBe("false"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(attempts).toBe(2);
    expect(overview.mock.calls.filter(([query]) => query?.limit === undefined)).toHaveLength(1);
  });
  it("opens readable evidence from the graph and Escape closes detail before the workspace", async () => {
    installFetch(); const onClose = vi.fn();
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={onClose} initialMode="atlas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open map memory" }));
    const panel = await screen.findByLabelText("Memory node detail");
    await within(panel).findByText("Durable fact.");
    expect(within(panel).getByText("#Space")).toBeTruthy();
    expect(within(panel).queryByText("Guarded proposals")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Toggle 3D memory view" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Toggle memory titles" })).toBeNull();
    expect(document.querySelector(".memory-atlas-header .memory-atlas-view-controls")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByLabelText("Memory node detail")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(graphLifecycle.mounted).toHaveBeenCalledTimes(1);
  });
  it("ignores stale search responses and reports request failures", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    let count = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { count++; if (count === 1) return first; return json(graphPayload({ nodes: [], edges: [] })); }));
    render(<MemoryWorkspace shellMode="desktop" activeRoomId={null} onClose={() => undefined} initialMode="atlas" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } });
    fireEvent.submit(screen.getByRole("search"));
    await screen.findByText("No memories found. Try another search.");
    await act(async () => resolveFirst(json(graphPayload({}))));
    expect(screen.getByTestId("memory-graph-renderer").getAttribute("data-node-ids")).toBe("");
  });
});

describe("MemoryGraph3D input and uploaded graph coherence", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); webglRenderer.instances.length = 0; });

  it("starts with the bounded Canvas fallback when WebGL2 is unavailable", () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => kind === "webgl2" ? null : { setTransform: vi.fn() }) as HTMLCanvasElement["getContext"]);
    const atlas = createMemoryAtlas([memoryNode], [], false);
    render(<WebGLMemoryGraph3D nodes={[memoryNode]} edges={[]} positions={atlas.positions} coordinates={new Map([[memoryNode.id, { x: 0, y: 0, z: 0 }]])} showTitles={true} selectedNodeId={null} onSelectNode={() => undefined} loading={true} resetToken={0} />);
    expect(screen.getByText("Canvas fallback · showing up to 2,000 nodes")).toBeTruthy();
    expect(screen.getByRole("application").getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector('[data-renderer="canvas2d"]')).not.toBeNull();
    expect(webglRenderer.instances).toHaveLength(0);
  });

  it.each([false, true])("defers stale picking while accepting current uploaded nodes (layout loading=%s)", loading => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("PointerEvent", class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; }
    });
    const context = { clearRect: vi.fn(), setTransform: vi.fn() };
    const gl = { isContextLost: () => false };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => kind === "webgl2" ? gl : context) as HTMLCanvasElement["getContext"]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) });
    const flushFrame = () => act(() => {
      const pending = [...frames.values()]; frames.clear();
      for (const callback of pending) callback(16);
    });
    const model = (id: string, x: number) => {
      const nodes = [{ ...memoryNode, id, recordId: id }], edges: typeof graphEdges[number][] = [];
      const atlas = createMemoryAtlas(nodes, edges, false), coordinates = new Map([[id, { x, y: 0, z: 0 }]]);
      return { nodes, edges, positions: atlas.positions, coordinates, renderData: prepareMemoryRenderData(nodes, edges, atlas.positions, coordinates) };
    };
    const first = model("memory:first", 0), replacement = model("memory:replacement", 20);
    expect(first.nodes).toHaveLength(replacement.nodes.length);
    expect(first.renderData.styles).not.toBe(replacement.renderData.styles);
    const selected = vi.fn(), common = { showTitles: false, selectedNodeId: null, onSelectNode: selected, loading, resetToken: 0 };
    const { rerender } = render(<WebGLMemoryGraph3D {...first} {...common} />);
    const canvas = screen.getByRole("application") as HTMLCanvasElement;
    expect(canvas.getAttribute("aria-busy")).toBe(String(loading));
    canvas.setPointerCapture = vi.fn(); canvas.hasPointerCapture = () => false;
    const clickNode = () => {
      fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 400, clientY: 300 });
      fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 400, clientY: 300 });
    };
    flushFrame();
    const renderer = webglRenderer.instances.at(-1)!;
    clickNode();
    expect(selected).toHaveBeenLastCalledWith("memory:first");
    flushFrame(); selected.mockClear();

    rerender(<WebGLMemoryGraph3D {...replacement} {...common} />);
    expect(renderer.graph).toBe(first.renderData);
    const drawsBeforeClick = renderer.render.mock.calls.length;
    clickNode();
    expect(selected).not.toHaveBeenCalled();
    expect(renderer.render).toHaveBeenCalledTimes(drawsBeforeClick);
    expect(renderer.setData).toHaveBeenCalledTimes(1);
    flushFrame();
    clickNode();
    expect(selected).toHaveBeenLastCalledWith("memory:replacement");
    expect(renderer.setData).toHaveBeenCalledTimes(2);

    flushFrame(); selected.mockClear();
    const streamed = { ...replacement.renderData, coordinates: replacement.renderData.coordinates.slice() };
    streamed.coordinates[0] = 40;
    rerender(<WebGLMemoryGraph3D {...replacement} {...common} renderData={streamed} />);
    clickNode();
    expect(selected).not.toHaveBeenCalled();
    flushFrame();
    clickNode();
    expect(selected).toHaveBeenLastCalledWith("memory:replacement");
    expect(renderer.updateCoordinates).toHaveBeenCalledWith(streamed.coordinates, streamed.extent, streamed.picking);
    expect(renderer.setData).toHaveBeenCalledTimes(2);
  });
});
