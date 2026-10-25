import { describe, expect, it } from "vitest";
import type { MemoryGraphEdge, MemoryGraphNode } from "@space/contracts";
import {
  memoryGraph3DEdgeStroke,
  memoryGraphEdgeStyle,
  memoryGraphNodeStyle,
  memoryGraphTaxonomySummary,
  orderMemoryGraphNodes,
  resolveMemoryGraphPosition,
  shouldForceMemoryGraphLabel
} from "../src/features/memory-workspace/memory-graph-visuals.js";

function node(id: string, type: MemoryGraphNode["type"] = "MEMORY"): MemoryGraphNode {
  return { id, type, label: id, sourcePath: null, recordId: type === "MEMORY" ? id : null };
}

describe("memory graph visuals", () => {
  it("preserves original 3D stroke colors, opacity and focus precedence", () => {
    const stroke = (incident: boolean, hasFocus: boolean, derived: boolean) => memoryGraph3DEdgeStroke({ incident, hasFocus, derived });
    expect(stroke(false, false, false)).toMatchObject({ color: "#203343", lineWidthCss: 0.55, opacity: 1 });
    expect(stroke(false, false, true)).toMatchObject({ color: "#385068", lineWidthCss: 0.55, opacity: 1 });
    expect(stroke(false, true, true)).toMatchObject({ color: "#14202b", lineWidthCss: 0.55, opacity: 1 });
    expect(stroke(true, true, true)).toMatchObject({ color: "#98dafa", lineWidthCss: 1.15, opacity: 1 });
  });

  it("scales CSS stroke widths at fractional and Retina DPR without changing apparent width", () => {
    for (const pixelRatio of [1, 1.25, 2]) {
      const regular = memoryGraph3DEdgeStroke({ incident: false, hasFocus: false, derived: false, pixelRatio });
      const incident = memoryGraph3DEdgeStroke({ incident: true, hasFocus: true, derived: false, pixelRatio });
      expect(regular.lineWidthPixels).toBeCloseTo(0.55 * pixelRatio, 12);
      expect(incident.lineWidthPixels).toBeCloseTo(1.15 * pixelRatio, 12);
      expect(regular.lineWidthPixels / pixelRatio).toBeCloseTo(0.55, 12);
      expect(incident.lineWidthPixels / pixelRatio).toBeCloseTo(1.15, 12);
      expect(regular.halfWidthPixels * 2).toBeCloseTo(regular.lineWidthPixels, 12);
      expect(incident.outerRadiusPixels - incident.halfWidthPixels).toBe(0.5);
      expect(regular.outerRadiusPixels - regular.halfWidthPixels).toBe(0.5);
    }
    expect(memoryGraph3DEdgeStroke({ incident: false, hasFocus: false, derived: false, pixelRatio: 2 })).toMatchObject({ lineWidthPixels: 1.1, halfWidthPixels: 0.55, outerRadiusPixels: 1.05 });
    expect(memoryGraph3DEdgeStroke({ incident: true, hasFocus: true, derived: false, pixelRatio: 2 })).toMatchObject({ lineWidthPixels: 2.3, halfWidthPixels: 1.15, outerRadiusPixels: 1.65 });
  });

  it("uses versioned positions and gives legacy nodes distinct deterministic fallbacks", () => {
    const positioned: MemoryGraphNode = {
      ...node("memory:positioned"),
      position: {
        clustered: { x: 12.5, y: -7.25 },
        relations: { x: -2.5, y: 4.75 }
      }
    };
    expect(resolveMemoryGraphPosition(positioned, 0, "CLUSTERED")).toEqual({ x: 12.5, y: -7.25 });
    expect(resolveMemoryGraphPosition(positioned, 0, "RELATIONS")).toEqual({ x: -2.5, y: 4.75 });

    const legacyNodes = [node("memory:alpha"), node("memory:beta"), node("topic:space", "TOPIC")];
    const firstPass = legacyNodes.map((candidate, index) => resolveMemoryGraphPosition(candidate, index, "CLUSTERED"));
    const secondPass = legacyNodes.map((candidate, index) => resolveMemoryGraphPosition(candidate, index, "CLUSTERED"));
    expect(firstPass).toEqual(secondPass);
    expect(firstPass.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(new Set(firstPass.map(({ x, y }) => `${x}:${y}`)).size).toBe(legacyNodes.length);
  });

  it("reveals connected anchors first and gives tag and semantic edges distinct visual semantics", () => {
    const nodes = [node("memory:leaf-a"), node("source:canonical", "SOURCE"), node("topic:space", "TOPIC"), node("memory:leaf-b")];
    const edges: MemoryGraphEdge[] = [{
      id: "edge:contains-a",
      type: "CONTAINS",
      source: "source:canonical",
      target: "memory:leaf-a"
    }, {
      id: "edge:contains-b",
      type: "CONTAINS",
      source: "source:canonical",
      target: "memory:leaf-b"
    }, {
      id: "edge:tag",
      type: "TAGGED_WITH",
      source: "memory:leaf-a",
      target: "topic:space",
      origin: "EXPLICIT_TAG",
      confidence: 1,
      evidence: "Explicit tag: Space."
    }];

    expect(orderMemoryGraphNodes(nodes, edges)[0]?.id).toBe("source:canonical");
    const tagStyle = memoryGraphEdgeStyle(edges[2]!);
    const semanticStyle = memoryGraphEdgeStyle({
      id: "edge:semantic",
      type: "SEMANTICALLY_RELATED",
      source: "memory:leaf-a",
      target: "memory:leaf-b",
      origin: "DETERMINISTIC_TFIDF",
      confidence: 0.82,
      evidence: "Shared TF-IDF terms: memory."
    });
    expect(tagStyle).not.toEqual(semanticStyle);
    expect(tagStyle.label).toBe("Explicit tag");
    expect(semanticStyle.label).toBe("Semantic similarity");
  });

  it("keeps the overview readable while distinguishing explicit tags from derived topics", () => {
    const nodes = [
      node("source:canonical", "SOURCE"),
      node("memory:one"),
      node("memory:two"),
      node("topic:explicit", "TOPIC"),
      node("topic:derived", "TOPIC")
    ];
    const edges: MemoryGraphEdge[] = [{
      id: "edge:explicit",
      type: "TAGGED_WITH",
      source: "memory:one",
      target: "topic:explicit",
      origin: "EXPLICIT_TAG",
      confidence: 1,
      evidence: "Explicit canonical tag."
    }, {
      id: "edge:derived",
      type: "TAGGED_WITH",
      source: "memory:two",
      target: "topic:derived",
      origin: "DERIVED_TFIDF",
      confidence: 0.84,
      evidence: "Deterministic TF-IDF topic."
    }, {
      id: "edge:semantic",
      type: "SEMANTICALLY_RELATED",
      source: "memory:one",
      target: "memory:two",
      origin: "DETERMINISTIC_TFIDF",
      confidence: 0.72,
      evidence: "Shared terms."
    }];

    expect(memoryGraphTaxonomySummary(nodes, edges)).toEqual({
      explicitTags: 1,
      derivedTopics: 1,
      semanticLinks: 1
    });
    expect(shouldForceMemoryGraphLabel(nodes[0]!, null, 3, 0)).toBe(true);
    expect(shouldForceMemoryGraphLabel(nodes[3]!, "EXPLICIT_TAG", 2, 1)).toBe(false);
    expect(shouldForceMemoryGraphLabel(nodes[4]!, "DERIVED_TFIDF", 1, 2)).toBe(false);
    expect(shouldForceMemoryGraphLabel(nodes[1]!, null, 4, 3)).toBe(true);
    expect(shouldForceMemoryGraphLabel(nodes[1]!, null, 4, 4)).toBe(false);
    expect(memoryGraphNodeStyle(nodes[3]!, "EXPLICIT_TAG")).toMatchObject({ label: "Explicit tag" });
    expect(memoryGraphNodeStyle(nodes[4]!, "DERIVED_TFIDF")).toMatchObject({ label: "Derived topic" });
  });
});
