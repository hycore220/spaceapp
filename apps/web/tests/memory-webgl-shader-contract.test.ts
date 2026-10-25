import { describe, expect, it } from "vitest";
import { MemoryWebGLRenderer } from "../src/features/memory-workspace/memory-webgl-renderer.js";

type Shader = { type: number; source: string };
type LinkedProgram = { shaders: Shader[] };

// Capture the actual sources passed through the renderer's constructor. This
// verifies program assignment, not WebGL compilation or real GPU pixel equality.
function capturedPrograms(stencil: boolean) {
  const programs: LinkedProgram[] = [];
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    createProgram: () => { const p = { shaders: [] }; programs.push(p); return p; },
    createShader: (type: number) => ({ type, source: "" }),
    shaderSource: (shader: Shader, source: string) => { shader.source = source; },
    compileShader: () => {}, getShaderParameter: () => true,
    attachShader: (program: LinkedProgram, shader: Shader) => { program.shaders.push(shader); },
    linkProgram: () => {}, getProgramParameter: () => true,
    getUniformLocation: () => null,
    getContextAttributes: () => ({ stencil }),
    createVertexArray: () => ({}), createBuffer: () => ({}), createTexture: () => ({}),
    deleteProgram: () => {}, deleteShader: () => {}, deleteVertexArray: () => {},
    deleteBuffer: () => {}, deleteTexture: () => {},
    bindVertexArray: () => {}, bindBuffer: () => {}, enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {}, vertexAttribIPointer: () => {}, vertexAttribDivisor: () => {}
  };
  new MemoryWebGLRenderer(gl as unknown as WebGL2RenderingContext, false, true, true);
  return programs.map(program => ({
    vertex: program.shaders.find(shader => shader.type === gl.VERTEX_SHADER)!.source,
    fragment: program.shaders.find(shader => shader.type === gl.FRAGMENT_SHADER)!.source
  }));
}

const statements = (source: string) => source.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");

describe("memory WebGL shader program contracts", () => {
  it("shares the opaque color/mask program and keeps translucent quads on their own shader", () => {
    const programs = capturedPrograms(true);
    const opaque = programs.find(p => p.fragment.includes("color=vec4(v_color.rgb,1.0)"))!;
    const translucent = programs.find(p => p.fragment.includes("if(opaqueInterior)discard;"))!;
    expect(programs).toHaveLength(3);
    expect([opaque, translucent].every(Boolean)).toBe(true);
    const cull = "if(alpha<0.9999)gl_Position.z=2.0*clip.w;";
    expect(statements(opaque.vertex)).toContain(cull);
    expect(opaque.vertex.indexOf("float alpha=")).toBeLessThan(opaque.vertex.indexOf("if(alpha<0.9999)"));
    expect(statements(translucent.vertex)).not.toContain(cull);
    // The mask reuses the final opaque program, avoiding a second rounding or
    // alpha predicate. There is no separate bounding-quad depth proxy program.
    expect(programs.filter(p => p.fragment.includes("color=vec4(v_color.rgb,1.0)")).length).toBe(1);
    expect(programs.some(p => p.fragment.includes("void main(){color=vec4(0.0);}"))).toBe(false);
    expect(opaque.fragment).toContain("v_color.a>=1.0&&insideDistancePx>=0.501");
    expect(translucent.vertex).toContain("if((v_viewDepth>0.0)!=(u_translucentHemisphere>0))gl_Position.z=2.0*clip.w;");
  });

  it("keeps the same opaque specialization when stencil masking is unavailable", () => {
    const programs = capturedPrograms(false);
    expect(programs).toHaveLength(3);
    const opaque = programs.find(p => p.fragment.includes("color=vec4(v_color.rgb,1.0)"))!;
    expect(opaque.vertex).toContain("if(alpha<0.9999)gl_Position.z=2.0*clip.w;");
    expect(programs.filter(p => p.vertex.includes("if(alpha<0.9999)"))).toHaveLength(1);
    expect(programs.some(p => p.fragment.includes("void main(){color=vec4(0.0);}"))).toBe(false);
  });
});
