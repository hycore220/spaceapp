import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";

/** Synthetic only: fixed seed, exactly three edges per node, no backend/provider or personal data. */
export function memoryGraphFixture(count: 100 | 2000 | 10000 | 50000) {
  const sourceInterval = count / 20;
  const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, i) => ({ id: `fixture-${String(i).padStart(5, "0")}`,
    type: i % sourceInterval === 0 ? "SOURCE" : "MEMORY", label: i === 0 ? "gemini.md" : i % sourceInterval === 0 ? `Source ${i / sourceInterval}` : `Memory ${i}`,
    sourcePath: i % sourceInterval === 0 ? `/synthetic/2026-10/source-${i}.md` : null, recordId: null }));
  const edges: MemoryGraphEdge[] = [];
  for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++) {
    const target = j === 0 ? i % sourceInterval === 0 ? (i + count - sourceInterval) % count : Math.floor(i / sourceInterval) * sourceInterval : (Math.imul(i + 1, j === 1 ? 131 : 8191) >>> 0) % count;
    edges.push({ id: `edge-${i}-${j}`, source: nodes[target]!.id, target: nodes[i]!.id,
      type: j === 0 ? "CONTAINS" : "SEMANTICALLY_RELATED",
      ...(j ? { origin: "DETERMINISTIC_TFIDF" as const, confidence: .5, evidence: "Synthetic fixture edge; no real similarity or embedding claim." } : {}) });
  }
  return { nodes, edges };
}
