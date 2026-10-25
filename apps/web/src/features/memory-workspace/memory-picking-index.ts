import type { MemoryCamera3D } from "./memory-3d.js";

/** World-space BVH built/refitted in the layout worker. order stores original
 * node indices; tree stores child/range offsets; bounds stores conservative XYZ
 * boxes plus subtree radius/index maxima. Camera changes need no rebuild. */
export type MemoryPickingIndex = { order: Uint32Array; tree: Int32Array; bounds: Float32Array };
/** Build a deterministic world-space BVH over packed coordinates and node radii; caller buffers remain owned by the caller and camera changes need no rebuild. */
export function createMemoryPickingIndex(coordinates: Float32Array, styles: Float32Array, count: number): MemoryPickingIndex {
  const order = Uint32Array.from({ length: count }, (_, i) => i);
  const tree = new Int32Array(Math.max(1, count * 2) * 4);
  const bounds = new Float32Array(Math.max(1, count * 2) * 8);
  let used = 0;
  /** Median-partition this node-index range into conservative bounds and leaves of at most eight nodes; ties use the original node index. */
  const build = (start: number, end: number): number => {
    const node = used++, t = node * 4, b = node * 8;
    tree[t] = tree[t + 1] = -1; tree[t + 2] = start; tree[t + 3] = end;
    bounds[b] = bounds[b + 1] = bounds[b + 2] = Infinity;
    bounds[b + 3] = bounds[b + 4] = bounds[b + 5] = -Infinity;
    bounds[b + 7] = -1;
    for (let j = start; j < end; j++) {
      const id = order[j]!;
      for (let axis = 0; axis < 3; axis++) {
        const v = coordinates[id * 4 + axis]!;
        bounds[b + axis] = Math.min(bounds[b + axis]!, v);
        bounds[b + axis + 3] = Math.max(bounds[b + axis + 3]!, v);
      }
      bounds[b + 6] = Math.max(bounds[b + 6]!, styles[id * 4 + 3]!);
      bounds[b + 7] = Math.max(bounds[b + 7]!, id);
    }
    if (end - start <= 8) return node;
    let axis = 0;
    for (let a = 1; a < 3; a++) if (bounds[b + a + 3]! - bounds[b + a]! > bounds[b + axis + 3]! - bounds[b + axis]!) axis = a;
    const middle = (start + end) >>> 1;
    /** Order candidate indices along the chosen split axis with an index tie-breaker for deterministic BVH topology. */
    const compare = (a: number, c: number) => coordinates[a * 4 + axis]! - coordinates[c * 4 + axis]! || a - c;
    // Median partition, not a per-frame depth sort. Ties are deterministic by node index.
    let low = start, high = end - 1;
    while (low < high) {
      const pivot = order[(low + high) >>> 1]!;
      let i = low, j = high;
      while (i <= j) {
        while (compare(order[i]!, pivot) < 0) i++;
        while (compare(order[j]!, pivot) > 0) j--;
        if (i <= j) { const tmp = order[i]!; order[i++] = order[j]!; order[j--] = tmp; }
      }
      if (middle <= j) high = j;
      else if (middle >= i) low = i;
      else break;
    }
    tree[t] = build(start, middle); tree[t + 1] = build(middle, end);
    return node;
  };
  if (count) build(0, count);
  return { order, tree: tree.slice(0, used * 4), bounds: bounds.slice(0, used * 8) };
}

/** Same topology, new conservative boxes. No tree/Map/edge objects cross the thread per update. */
export function refitMemoryPickingBounds(index: MemoryPickingIndex, coordinates: Float32Array): Float32Array {
  const bounds = index.bounds.slice(), { tree, order } = index;
  for (let node = tree.length / 4 - 1; node >= 0; node--) {
    const t = node * 4, b = node * 8, left = tree[t]!, right = tree[t + 1]!;
    if (left >= 0) {
      for (let axis = 0; axis < 3; axis++) {
        bounds[b + axis] = Math.min(bounds[left * 8 + axis]!, bounds[right * 8 + axis]!);
        bounds[b + axis + 3] = Math.max(bounds[left * 8 + axis + 3]!, bounds[right * 8 + axis + 3]!);
      }
    } else {
      bounds[b] = bounds[b + 1] = bounds[b + 2] = Infinity;
      bounds[b + 3] = bounds[b + 4] = bounds[b + 5] = -Infinity;
      for (let j = tree[t + 2]!; j < tree[t + 3]!; j++) for (let axis = 0; axis < 3; axis++) {
        const v = coordinates[order[j]! * 4 + axis]!;
        bounds[b + axis] = Math.min(bounds[b + axis]!, v);
        bounds[b + axis + 3] = Math.max(bounds[b + axis + 3]!, v);
      }
    }
  }
  return bounds;
}

/** Return the frontmost original node index within the Canvas-compatible CSS hit radius, or-1. Traverse conservative BVH boxes using the rendered camera; optional counters are diagnostic only. */
export function pickMemoryNode(index: MemoryPickingIndex, coordinates: Float32Array, styles: Float32Array,
  camera: MemoryCamera3D, extent: number, width: number, height: number, x: number, y: number, focus = -1,
  stats?: { boxes: number; points: number }): number {
  if (!index.tree.length || width <= 0 || height <= 0 || x < 0 || y < 0 || x >= width || y >= height) return -1;
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const scale = Math.min(width, height) * .4 / extent, k = scale * camera.zoom, sqrtZoom = Math.sqrt(camera.zoom);
  const { bounds, tree, order } = index;
  let best = -1, bestZ = Infinity;
  /** Clamp view depth exactly as the vertex projection so equal-depth hit ordering follows the renderer. */
  const depth = (z: number) => Math.max(-.99, Math.min(.99, z * scale / 1000));
  /** Reject projected BVH boxes that cannot cover this CSS-pixel query or beat the current depth; accepted boxes return their conservative near depth. */
  const score = (node: number) => {
    if (stats) stats.boxes++;
    const b = node * 8;
    const cx = (bounds[b]! + bounds[b + 3]!) / 2, hx = (bounds[b + 3]! - bounds[b]!) / 2;
    const py = (bounds[b + 1]! + bounds[b + 4]!) / 2, hy = (bounds[b + 4]! - bounds[b + 1]!) / 2;
    const pz = (bounds[b + 2]! + bounds[b + 5]!) / 2, hz = (bounds[b + 5]! - bounds[b + 2]!) / 2;
    const rx = cx * cy + pz * sy, ry = py * cp + cx * sy * sp - pz * cy * sp;
    const rz = py * sp - cx * sy * cp + pz * cy * cp;
    const dx = Math.abs(cy) * hx + Math.abs(sy) * hz;
    const dy = Math.abs(sy * sp) * hx + Math.abs(cp) * hy + Math.abs(cy * sp) * hz;
    const dz = Math.abs(sy * cp) * hx + Math.abs(sp) * hy + Math.abs(cy * cp) * hz;
    const near = depth(rz - dz);
    if (near > bestZ || (near === bestZ && bounds[b + 7]! <= best)) return Infinity;
    const w0 = Math.max(120, 650 + (rz - dz) * scale) / 650, w1 = Math.max(120, 650 + (rz + dz) * scale) / 650;
    const radius = Math.max(7, bounds[b + 6]! / w0 * sqrtZoom * (focus < 0 ? 1 : 1.5) + 3);
    const minX = width / 2 + (rx - dx) / (rx - dx < 0 ? w0 : w1) * k - radius;
    const maxX = width / 2 + (rx + dx) / (rx + dx > 0 ? w0 : w1) * k + radius;
    const minY = height / 2 - (ry + dy) / (ry + dy > 0 ? w0 : w1) * k - radius;
    const maxY = height / 2 - (ry - dy) / (ry - dy < 0 ? w0 : w1) * k + radius;
    return x < minX || x > maxX || y < minY || y > maxY ? Infinity : near;
  };
  const stack = new Int32Array(64);
  let size = 0;
  if (score(0) !== Infinity) stack[size++] = 0;
  while (size) {
    const node = stack[--size]!;
    if (score(node) === Infinity) continue;
    const t = node * 4, left = tree[t]!, right = tree[t + 1]!;
    if (left >= 0) {
      const a = score(left), b = score(right);
      const leftFirst = a < b || (a === b && bounds[left * 8 + 7]! > bounds[right * 8 + 7]!);
      const first = leftFirst ? left : right, second = leftFirst ? right : left;
      if ((leftFirst ? b : a) !== Infinity) stack[size++] = second;
      if ((leftFirst ? a : b) !== Infinity) stack[size++] = first;
      continue;
    }
    for (let j = tree[t + 2]!; j < tree[t + 3]!; j++) {
      if (stats) stats.points++;
      const id = order[j]!, p = id * 4, px = coordinates[p]!, py = coordinates[p + 1]!, pz = coordinates[p + 2]!;
      const z = py * sp + (-px * sy + pz * cy) * cp, zClip = depth(z);
      if (zClip > bestZ || (zClip === bestZ && id < best)) continue;
      const w = Math.max(120, 650 + z * scale) / 650;
      const sx = width / 2 + (px * cy + pz * sy) / w * k;
      const syScreen = height / 2 - (py * cp - (-px * sy + pz * cy) * sp) / w * k;
      const radius = Math.max(7, Math.max(1, styles[p + 3]! / w * sqrtZoom) * (id === focus ? 1.5 : 1) + 3);
      if ((x - sx) ** 2 + (y - syScreen) ** 2 <= radius ** 2) { best = id; bestZ = zClip; }
    }
  }
  return best;
}
