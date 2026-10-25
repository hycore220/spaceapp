import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryPoint3D } from "./memory-3d.js";

/** Derive a stable noncryptographic unit value from a node/axis seed; no time or ambient random source influences placement. */
const unit = (seed: string) => {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d); hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};

/** Create deterministic large-graph placement with bounded cell representatives.
 * Node/edge IDs determine iteration order and independent XYZ seeds; no time or
 * ambient randomness enters the calculation. positions() returns copied points,
 * and step() advances private state once. The worker publishes the initial seed
 * and every fourth update through step 60; identical input need not reproduce
 * the original 180-step algorithm's coordinates. */
export function createProgressiveMemoryLayout(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const index = new Map(ordered.map((node, i) => [node.id, i]));
  const root = ordered.findIndex(node => node.type === "SOURCE" && isMemoryCoreLabel(node.label));
  const extent = Math.max(260, Math.cbrt(nodes.length) * 18);
  const points = ordered.map(node => ({ x: (unit(`${node.id}:x`) - .5) * extent, y: (unit(`${node.id}:y`) - .5) * extent, z: (unit(`${node.id}:z`) - .5) * extent }));
  if (root >= 0) points[root] = { x: 0, y: 0, z: 0 };
  const links = [...edges].sort((a, b) => a.id.localeCompare(b.id)).flatMap(edge => {
    const a = index.get(edge.source), b = index.get(edge.target);
    return a === undefined || b === undefined || a === b ? [] : [{ a, b, contains: edge.type === "CONTAINS" }];
  });
  const parented = new Set<number>();
  for (const link of links) {
    if (!link.contains || ordered[link.a]!.type !== "SOURCE" || ordered[link.b]!.type !== "MEMORY" || parented.has(link.b)) continue;
    const parent = points[link.a]!, id = ordered[link.b]!.id;
    points[link.b] = { x: parent.x + (unit(`${id}:dx`) - .5) * 70, y: parent.y + (unit(`${id}:dy`) - .5) * 70, z: parent.z + (unit(`${id}:dz`) - .5) * 70 };
    parented.add(link.b);
  }
  const forces = new Float64Array(nodes.length * 3);
  const offsets = [[0, 0, 0], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
  let iteration = 0;
  return {
    positions: () => new Map(ordered.map((node, i) => [node.id, { ...points[i]! }])),
    step: () => {
      forces.fill(0);
      const grid = new Map<string, number[]>();
      points.forEach((p, i) => {
        const key = `${Math.floor(p.x / 32)},${Math.floor(p.y / 32)},${Math.floor(p.z / 32)}`;
        let bucket = grid.get(key); if (!bucket) { bucket = []; grid.set(key, bucket); }
        // Deterministic stratified representatives; dense hubs cannot cause quadratic repulsion.
        if (bucket.length < 12) bucket.push(i);
      });
      points.forEach((p, i) => {
        const gx = Math.floor(p.x / 32), gy = Math.floor(p.y / 32), gz = Math.floor(p.z / 32);
        for (const [x, y, z] of offsets) for (const j of grid.get(`${gx + x!},${gy + y!},${gz + z!}`) ?? []) {
          if (j === i) continue;
          const q = points[j]!, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
          const force = 12 / Math.max(1, dx * dx + dy * dy + dz * dz);
          forces[i * 3]! += dx * force; forces[i * 3 + 1]! += dy * force; forces[i * 3 + 2]! += dz * force;
        }
      });
      for (const { a, b, contains } of links) {
        const p = points[a]!, q = points[b]!, dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
        const distance = Math.max(.01, Math.hypot(dx, dy, dz)), force = (distance - (contains ? 34 : 80)) * (contains ? .028 : .0015) / distance;
        forces[a * 3]! += dx * force; forces[a * 3 + 1]! += dy * force; forces[a * 3 + 2]! += dz * force;
        forces[b * 3]! -= dx * force; forces[b * 3 + 1]! -= dy * force; forces[b * 3 + 2]! -= dz * force;
      }
      const cooling = Math.max(.1, 1 - iteration++ / 80);
      points.forEach((p, i) => {
        if (i === root) return;
        const dx = forces[i * 3]! - p.x * .0002, dy = forces[i * 3 + 1]! - p.y * .0002, dz = forces[i * 3 + 2]! - p.z * .0002;
        const step = Math.min(1, 4 / Math.max(.01, Math.hypot(dx, dy, dz))) * cooling;
        p.x += dx * step; p.y += dy * step; p.z += dz * step;
      });
    }
  };
}

/** Pack positions as padded Float32 xyzw texels in the supplied node order, using zeros for missing positions and a finite scene extent floor of 60. */
export function packMemoryCoordinates(nodes: MemoryGraphNode[], positions: Map<string, MemoryPoint3D>) {
  const values = new Float32Array(Math.ceil(Math.max(1, nodes.length) / 256) * 1024);
  let extent = 60;
  nodes.forEach((node, i) => { const p = positions.get(node.id); if (!p) return;
    values.set([p.x, p.y, p.z, 1], i * 4); extent = Math.max(extent, Math.hypot(p.x, p.y, p.z)); });
  return { coordinates: values, extent };
}
