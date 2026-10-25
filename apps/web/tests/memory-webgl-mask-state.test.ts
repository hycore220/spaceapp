import { describe, expect, it } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { prepareMemoryRenderData } from "../src/features/memory-workspace/memory-render-data.js";
import { MemoryWebGLRenderer } from "../src/features/memory-workspace/memory-webgl-renderer.js";

type Handle = { id: number };
type Uniform = { program: Handle; name: string };

// Command orchestration only: this mock does not compile GLSL, rasterize pixels,
// emulate stencil/depth coverage, or establish real GPU correctness/performance.
function commandContext() {
  const enums = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, FLOAT: 0x1406, UNSIGNED_INT: 0x1405,
    STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8, TEXTURE0: 0x84c0, TEXTURE1: 0x84c1,
    TEXTURE_2D: 0x0de1, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, NEAREST: 0x2600,
    RGBA32UI: 0x8d70, RGBA_INTEGER: 0x8d99, RGBA32F: 0x8814, RGBA: 0x1908,
    FRAMEBUFFER: 0x8d40, BLEND: 0x0be2, DEPTH_TEST: 0x0b71, STENCIL_TEST: 0x0b90,
    LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203, ALWAYS: 0x0207, KEEP: 0x1e00, REPLACE: 0x1e01,
    COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100, STENCIL_BUFFER_BIT: 0x0400,
    SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303, ONE: 1, TRIANGLES: 4, TRIANGLE_STRIP: 5
  };
  let nextId = 0, program: Handle | null = null, depthWrite = true, depthFunction = enums.LESS;
  let colors = [true, true, true, true], stencilWrite = 0xff;
  let stencilFunction = [enums.ALWAYS, 0, 0xff], stencilOperations = [enums.KEEP, enums.KEEP, enums.KEEP];
  const enabled = new Set<number>(), uniforms = new Map<Handle, Map<string, number>>();
  const programs: Handle[] = [], deletedPrograms: Array<Handle | null> = [];
  const handle = () => ({ id: ++nextId });
  const snapshot = () => ({
    program, depthTest: enabled.has(enums.DEPTH_TEST), depthWrite, depthFunction,
    colors: [...colors], blend: enabled.has(enums.BLEND), stencilTest: enabled.has(enums.STENCIL_TEST),
    stencilWrite, stencilFunction: [...stencilFunction], stencilOperations: [...stencilOperations],
    hemisphere: program ? uniforms.get(program)?.get("u_translucentHemisphere") : undefined
  });
  const draws: Array<{ kind: string; mode: number; count: number; instances: number | null; state: ReturnType<typeof snapshot> }> = [];
  const clears: Array<{ mask: number; state: ReturnType<typeof snapshot> }> = [];
  const gl = {
    ...enums, canvas: { width: 1, height: 1 },
    createProgram: () => { const value = handle(); programs.push(value); return value; },
    createShader: handle, createVertexArray: handle, createBuffer: handle, createTexture: handle,
    shaderSource: () => {}, compileShader: () => {}, getShaderParameter: () => true,
    attachShader: () => {}, linkProgram: () => {}, getProgramParameter: () => true,
    getUniformLocation: (value: Handle, name: string): Uniform => ({ program: value, name }),
    getContextAttributes: () => ({ stencil: true }), isContextLost: () => false,
    useProgram: (value: Handle) => { program = value; },
    uniform1i: (location: Uniform, value: number) => {
      const values = uniforms.get(location.program) ?? new Map<string, number>();
      values.set(location.name, value); uniforms.set(location.program, values);
    },
    uniform1f: () => {}, uniform2f: () => {}, uniform4f: () => {},
    bindVertexArray: () => {}, bindBuffer: () => {}, bufferData: () => {}, bufferSubData: () => {},
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribIPointer: () => {}, vertexAttribDivisor: () => {},
    activeTexture: () => {}, bindTexture: () => {}, texParameteri: () => {}, texImage2D: () => {},
    viewport: () => {}, bindFramebuffer: () => {}, clearColor: () => {}, clearDepth: () => {}, clearStencil: () => {},
    enable: (capability: number) => { enabled.add(capability); },
    disable: (capability: number) => { enabled.delete(capability); },
    depthMask: (value: boolean) => { depthWrite = value; }, depthFunc: (value: number) => { depthFunction = value; },
    colorMask: (...values: boolean[]) => { colors = values; }, blendFuncSeparate: () => {},
    stencilMask: (value: number) => { stencilWrite = value; },
    stencilFunc: (...values: number[]) => { stencilFunction = values; },
    stencilOp: (...values: number[]) => { stencilOperations = values; },
    clear: (mask: number) => { clears.push({ mask, state: snapshot() }); },
    drawArraysInstanced: (mode: number, _first: number, count: number, instances: number) => {
      draws.push({ kind: "instances", mode, count, instances, state: snapshot() });
    },
    drawElements: (mode: number, count: number) => { draws.push({ kind: "elements", mode, count, instances: null, state: snapshot() }); },
    deleteProgram: (value: Handle | null) => { deletedPrograms.push(value); },
    deleteShader: () => {}, deleteVertexArray: () => {}, deleteBuffer: () => {}, deleteTexture: () => {}
  };
  return { gl, draws, clears, programs, deletedPrograms };
}

function renderData(count: number) {
  const nodes: MemoryGraphNode[] = Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`, type: "MEMORY", label: `Node ${index}`, sourcePath: null, recordId: null
  }));
  const points = new Map(nodes.map((node, index) => [node.id, { x: index % 100, y: Math.floor(index / 100), z: index % 7 }]));
  return prepareMemoryRenderData(nodes, [{ id: "edge", source: nodes[0]!.id, target: nodes[count - 1]!.id, type: "CONTAINS" }], new Map(), points);
}

describe("memory WebGL opaque-union mask command state", () => {
  it("shares the final opaque program and resets stencil across full, edges-only, nodes-only and sub-threshold scenes", () => {
    const mock = commandContext(), { gl, draws, clears } = mock;
    const renderer = new MemoryWebGLRenderer(gl as unknown as WebGL2RenderingContext, false, true, true);
    renderer.resize(640, 400, 2);
    renderer.setData(renderData(10_000));
    const camera = { yaw: .3, pitch: -.15, zoom: 1 };
    expect(renderer.edgeOcclusionEnabled).toBe(true);
    renderer.render(camera);
    expect(draws).toHaveLength(5);
    const [mask, edge, opaque, far, near] = draws;
    expect(mask).toMatchObject({ kind: "instances", mode: gl.TRIANGLE_STRIP, count: 4, instances: 10_000,
      state: { depthTest: false, depthWrite: false, colors: [false, false, false, false], blend: false,
        stencilTest: true, stencilWrite: 0xff, stencilFunction: [gl.ALWAYS, 1, 0xff], stencilOperations: [gl.KEEP, gl.KEEP, gl.REPLACE] } });
    expect(mask!.state.program).toBe(opaque!.state.program);
    expect(edge).toMatchObject({ kind: "elements", mode: gl.TRIANGLES, count: 6,
      state: { depthTest: true, depthFunction: gl.LEQUAL, depthWrite: false, colors: [true, true, true, true], blend: true,
        stencilTest: true, stencilWrite: 0, stencilFunction: [gl.EQUAL, 0, 0xff], stencilOperations: [gl.KEEP, gl.KEEP, gl.KEEP] } });
    expect(opaque).toMatchObject({ kind: "instances", count: 4, instances: 10_000,
      state: { depthTest: true, depthFunction: gl.LEQUAL, depthWrite: true, colors: [true, true, true, true], blend: false, stencilTest: false } });
    for (const [draw, hemisphere] of [[far, 1], [near, -1]] as const) {
      expect(draw).toMatchObject({ kind: "instances", count: 4, instances: 10_000,
        state: { depthTest: true, depthFunction: gl.LEQUAL, depthWrite: false, colors: [true, true, true, true], blend: true, stencilTest: false, hemisphere } });
    }
    expect(far!.state.program).toBe(near!.state.program);
    expect(far!.state.program).not.toBe(opaque!.state.program);
    expect(edge!.state.program).not.toBe(opaque!.state.program);

    // Reuse this context; previously read-only stencil must not mask an edge-only render.
    draws.length = 0;
    renderer.render(camera, { edges: true, nodes: false });
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ kind: "elements", count: 6,
      state: { depthTest: true, depthFunction: gl.LEQUAL, depthWrite: false, colors: [true, true, true, true], blend: true, stencilTest: false } });

    draws.length = 0;
    renderer.render(camera, { edges: false, nodes: true });
    expect(draws).toHaveLength(3);
    expect(draws[0]!.state).toMatchObject({ program: opaque!.state.program, depthWrite: true, blend: false, stencilTest: false });
    expect(draws.slice(1).map(draw => [draw.state.depthWrite, draw.state.stencilTest, draw.state.hemisphere])).toEqual([[false, false, 1], [false, false, -1]]);

    draws.length = 0;
    renderer.setData(renderData(9_999));
    expect(renderer.edgeOcclusionEnabled).toBe(false);
    renderer.render(camera);
    expect(draws).toHaveLength(4);
    expect(draws[0]).toMatchObject({ kind: "elements", state: { stencilTest: false, depthWrite: false, colors: [true, true, true, true] } });
    expect(draws.slice(1).map(draw => draw.instances)).toEqual([9_999, 9_999, 9_999]);
    expect(draws.every(draw => !draw.state.stencilTest)).toBe(true);

    expect(clears).toHaveLength(4);
    for (const clear of clears) expect(clear).toMatchObject({
      mask: gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT,
      state: { depthWrite: true, colors: [true, true, true, true], stencilTest: false, stencilWrite: 0xff }
    });
    // One translucent, one shared opaque/mask, one edge program: no ghost proxy.
    expect(mock.programs).toHaveLength(3);
    renderer.dispose();
    expect(mock.deletedPrograms).toEqual(mock.programs);
  });
});
