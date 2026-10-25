import { describe, expect, it } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { DEFAULT_MEMORY_CAMERA, projectMemoryPoint } from "../src/features/memory-workspace/memory-3d.js";
import { decodeMemoryPickingPixel, encodeMemoryPickingIndex, MAX_PICKING_INDEX, memoryClipToScreen, memoryGraphExtent, memoryLabelCandidateIndices, projectMemoryClipPoint, selectMemoryScreenLabels } from "../src/features/memory-workspace/memory-webgl-math.js";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY", label = id): MemoryGraphNode => ({ id, type, label, sourcePath: null, recordId: null });

describe("memory WebGL projection and interaction data", () => {
  it("preserves Canvas screen coordinates through rotations, zoom, depth and the near-plane clamp", () => {
    for (const point of [{ x: 0, y: 0, z: 0 }, { x: 45, y: -20, z: 70 }, { x: 20, y: 15, z: -900 }]) {
      for (const yaw of [0, 0.3, Math.PI / 2, Math.PI]) {
        for (const zoom of [0.35, 1, 5]) {
          const camera = { yaw, pitch: -0.15, zoom };
          const old = projectMemoryPoint(point, camera, 2, 1000, 700);
          const clip = projectMemoryClipPoint(point, camera, 2, 1000, 700);
          const current = memoryClipToScreen(clip, 1000, 700);
          expect(current.x).toBeCloseTo(old.x, 7);
          expect(current.y).toBeCloseTo(old.y, 7);
          expect(clip.w).toBeGreaterThan(0);
          expect(Math.abs(clip.z / clip.w)).toBeLessThan(1);
        }
      }
    }
  });

  it("distinguishes no hit from the first, channel-boundary,50k and last RGB24 node IDs", () => {
    expect(decodeMemoryPickingPixel([0, 0, 0, 0])).toBe(-1);
    for (const index of [0, 254, 255, 256, 49_999, 65_535, MAX_PICKING_INDEX]) expect(decodeMemoryPickingPixel(encodeMemoryPickingIndex(index))).toBe(index);
    for (const index of [-1, 0.5, NaN, Infinity, MAX_PICKING_INDEX + 1]) expect(() => encodeMemoryPickingIndex(index)).toThrow(RangeError);
  });

  it("computes graph extent from a large iterable without argument spreading", () => {
    function* points() { for (let i = 0; i < 200_000; i++) yield { x: i, y: 0, z: 0 }; }
    expect(memoryGraphExtent(points())).toBe(199_999);
    expect(memoryGraphExtent([])).toBe(60);
  });

  it("keeps candidate work bounded at50k while preserving the core/source label priority", () => {
    const nodes = Array.from({ length: 50_000 }, (_, i) => node(`n-${i}`));
    nodes[49_999] = node("root", "SOURCE", "gemini.md");
    nodes[49_998] = node("source", "SOURCE", "notes.md");
    const candidates = memoryLabelCandidateIndices(nodes);
    expect(candidates).toHaveLength(512);
    expect(candidates.slice(0, 2)).toEqual([49_999, 49_998]);
    expect(new Set(candidates).size).toBe(512);
    expect(memoryLabelCandidateIndices(nodes, 0)).toEqual([]);
  });

  it("caps text measurement despite collisions and includes an off-sample focused memory", () => {
    const nodes = Array.from({ length: 50_000 }, (_, i) => node(`source-${i}`, "SOURCE"));
    nodes[49_999] = node("chosen-memory");
    let measurements = 0;
    const labels = selectMemoryScreenLabels({ nodes, candidateIndices: Array.from({ length: 50_000 }, (_, i) => i), focusedIndex:49_999,
      pointAt: () => ({ x: 0, y: 0, z: 0 }), camera: DEFAULT_MEMORY_CAMERA, scale: 1, width:1000, height:700,
      measureText: () => { measurements++; return 70; } });
    expect(measurements).toBe(128);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.index).toBe(49_999);
  });
});
