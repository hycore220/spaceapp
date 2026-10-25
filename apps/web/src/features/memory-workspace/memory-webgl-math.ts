import type { MemoryGraphNode } from "@space/contracts";
import type { MemoryCamera3D, MemoryPoint3D } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";

export const MAX_PICKING_INDEX = 0xfffffe;
export const MEMORY_LABEL_CANDIDATES = 512;
export const MEMORY_LABEL_MEASUREMENTS = 128;
export const MEMORY_LABEL_COUNT = 80;

/** Zero is reserved for an empty picking framebuffer. */
export function encodeMemoryPickingIndex(index: number): [number, number, number, number] {
  if (!Number.isInteger(index) || index < 0 || index > MAX_PICKING_INDEX) throw new RangeError("Picking index is outside the RGB24 range");
  const value = index + 1;
  return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, 255];
}

/** Decode RGB24 index+1 with transparent/zero pixels reserved for no hit; never interpret missing alpha as a valid node. */
export function decodeMemoryPickingPixel(pixel: ArrayLike<number>): number {
  if (pixel.length < 4 || pixel[3] === 0) return -1;
  return ((pixel[0]! | (pixel[1]! << 8) | (pixel[2]! << 16)) >>> 0) - 1;
}

/** Compute once per position update, without a graph-sized argument spread. */
export function memoryGraphExtent(points: Iterable<MemoryPoint3D>): number {
  let extent = 60;
  for (const point of points) {
    const radius = Math.hypot(point.x, point.y, point.z);
    if (Number.isFinite(radius)) extent = Math.max(extent, radius);
  }
  return extent;
}

/** The same projection as the Canvas renderer, expressed in homogeneous clip coordinates. */
export function projectMemoryClipPoint(point: MemoryPoint3D, camera: MemoryCamera3D, scale: number, width: number, height: number) {
  const x = point.x * Math.cos(camera.yaw) + point.z * Math.sin(camera.yaw);
  const depth = -point.x * Math.sin(camera.yaw) + point.z * Math.cos(camera.yaw);
  const y = point.y * Math.cos(camera.pitch) - depth * Math.sin(camera.pitch);
  const z = point.y * Math.sin(camera.pitch) + depth * Math.cos(camera.pitch);
  const w = Math.max(120, 650 + z * scale) / 650;
  return { x: 2 * x * scale * camera.zoom / width, y: 2 * y * scale * camera.zoom / height,
    z: Math.max(-0.99, Math.min(0.99, z * scale / 1000)) * w, w };
}

/** Convert homogeneous clip coordinates into top-left CSS viewport pixels; the projection caller supplies positive clip W. */
export function memoryClipToScreen(point: { x: number; y: number; w: number }, width: number, height: number) {
  return { x: width * (1 + point.x / point.w) / 2, y: height * (1 - point.y / point.w) / 2 };
}

/** Order core labels before other sources and ordinary nodes for deterministic bounded candidate selection. */
const labelPriority = (node: MemoryGraphNode) => isMemoryCoreLabel(node.label) ? 0 : node.type === "SOURCE" ? 1 : 2;

/** Called when graph data changes, preferably in the layout worker, never for every frame. */
export function memoryLabelCandidateIndices(nodes: readonly MemoryGraphNode[], maximum = MEMORY_LABEL_CANDIDATES): number[] {
  const budget = Math.max(0, Math.min(MEMORY_LABEL_CANDIDATES, Math.floor(maximum)));
  const tiers: number[][] = [[], [], []];
  nodes.forEach((node, index) => tiers[labelPriority(node)]!.push(index));
  const result: number[] = [];
  for (const tier of tiers) {
    tier.sort((a, b) => nodes[a]!.id.localeCompare(nodes[b]!.id));
    const count = Math.min(budget - result.length, tier.length);
    for (let i = 0; i < count; i++) result.push(tier[Math.floor(i * tier.length / count)]!);
    if (result.length >= budget) break;
  }
  return result;
}

export type MemoryScreenLabel = { index: number; text: string; x: number; y: number; width: number; core: boolean };

/** Select visible collision-free CSS labels under the hard candidate/measurement/draw budgets; preserve focus and core/source priority without scanning the full graph each frame. */
export function selectMemoryScreenLabels(options: {
  nodes: readonly MemoryGraphNode[]; candidateIndices: readonly number[]; focusedIndex: number | null;
  pointAt: (index: number) => MemoryPoint3D | undefined;
  camera: MemoryCamera3D; scale: number; width: number; height: number;
  measureText: (text: string) => number;
  /** Render data already stores deterministic core/source-first candidates. */
  orderedCandidates?: boolean;
}): MemoryScreenLabel[] {
  const { nodes, camera, scale, width, height, measureText } = options;
  if (width <= 0 || height <= 0) return [];
  const focused = options.focusedIndex;
  const indices = [...new Set([
    ...(focused !== null && Number.isInteger(focused) && focused >= 0 && focused < nodes.length ? [focused] : []),
    ...options.candidateIndices.slice(0, MEMORY_LABEL_CANDIDATES)
  ])].filter(index => Number.isInteger(index) && index >= 0 && index < nodes.length);
  if (!options.orderedCandidates) indices.sort((a, b) => Number(b === focused) - Number(a === focused) || labelPriority(nodes[a]!) - labelPriority(nodes[b]!) || nodes[a]!.id.localeCompare(nodes[b]!.id));
  const labels: MemoryScreenLabel[] = [];
  let measured = 0;
  for (const index of indices) {
    const node = nodes[index]!;
    if (node.type !== "SOURCE" && index !== focused && camera.zoom < 1.6) continue;
    const point = options.pointAt(index);
    if (!point) continue;
    const screen = memoryClipToScreen(projectMemoryClipPoint(point, camera, scale, width, height), width, height);
    const x = screen.x + 9, y = screen.y;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= width || y < 14 || y > height - 5) continue;
    const text = node.label.length > 48 ? `${node.label.slice(0, 45)}…` : node.label;
    const labelWidth = measureText(text);
    measured++;
    if (x + labelWidth <= width && !labels.some(box => Math.abs(box.y - y) < 16 && x < box.x + box.width + 5 && x + labelWidth + 5 > box.x)) {
      labels.push({ index, text, x, y, width: labelWidth, core: isMemoryCoreLabel(node.label) });
    }
    if (measured >= MEMORY_LABEL_MEASUREMENTS || labels.length >= MEMORY_LABEL_COUNT) break;
  }
  return labels;
}
