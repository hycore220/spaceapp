import type { MemoryCamera3D } from "./memory-3d.js";
import type { MemoryRenderData } from "./memory-render-data.js";
import { pickMemoryNode, type MemoryPickingIndex } from "./memory-picking-index.js";
import { memoryGraph3DEdgeStroke } from "./memory-graph-visuals.js";

// Resolve the shared Canvas style contract once, outside every draw/input path.
const edgeStrokes = {
  incident: memoryGraph3DEdgeStroke({ incident: true, hasFocus: true, derived: false }),
  focusedOther: memoryGraph3DEdgeStroke({ incident: false, hasFocus: true, derived: true }),
  derived: memoryGraph3DEdgeStroke({ incident: false, hasFocus: false, derived: true }),
  regular: memoryGraph3DEdgeStroke({ incident: false, hasFocus: false, derived: false })
};

/** Encode a shared six-digit CSS stroke color as a constant GLSL vector so Canvas and WebGL use the same base RGB. */
const edgeColorGLSL = (hex: string) => {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return `vec4(vec3(${rgb >>> 16}.0,${(rgb >>> 8) & 255}.0,${rgb & 255}.0)/255.0,1.0)`;
};
const edgeStyleGLSL = `
vec4 memoryEdgeColor(bool incident, bool derived) {
  return incident?${edgeColorGLSL(edgeStrokes.incident.color)}:
    u_focus>=0?${edgeColorGLSL(edgeStrokes.focusedOther.color)}:
    derived?${edgeColorGLSL(edgeStrokes.derived.color)}:${edgeColorGLSL(edgeStrokes.regular.color)};
}
float memoryEdgeWidthCss(bool incident) {
  return incident?${edgeStrokes.incident.lineWidthCss}:${edgeStrokes.regular.lineWidthCss};
}`;

const projection = `
uniform sampler2D u_positions;
uniform vec2 u_size;
uniform vec4 u_rotation;
uniform float u_scale;
uniform float u_zoom;
uniform int u_focus;
vec4 projectPoint(uint index) {
  vec3 p = texelFetch(u_positions, ivec2(int(index)%256, int(index)/256), 0).xyz;
  float cy=u_rotation.x, sy=u_rotation.y, cp=u_rotation.z, sp=u_rotation.w;
  float x=p.x*cy+p.z*sy, depth=-p.x*sy+p.z*cy;
  float y=p.y*cp-depth*sp, z=p.y*sp+depth*cp;
  float w=max(120.0,650.0+z*u_scale)/650.0;
  return vec4(2.0*vec2(x,y)*u_scale*u_zoom/u_size, clamp(z*u_scale/1000.0,-0.99,0.99)*w,w);
}`;
const translucentHemisphereMismatch = "(v_viewDepth>0.0)!=(u_translucentHemisphere>0)";
/** Generate instanced node projection and coverage bounds; select opaque-interior or translucent passes without CPU depth sorting. */
const nodeVertex = (translucent = false, opaqueOnly = false) => `#version 300 es
precision highp float;
precision highp int;
${translucent ? "uniform int u_translucentHemisphere;" : ""}
invariant gl_Position;
layout(location=0) in vec4 a_style;
layout(location=1) in float a_neighbor;
${projection}
out vec2 v_local;
out vec4 v_color;
out float v_radius;
out float v_extent;
flat out float v_viewDepth;
void main() {
  uint index=uint(gl_InstanceID);
  vec4 clip=projectPoint(index);
  bool focused=int(index)==u_focus;
  float radius=max(1.0,a_style.w/clip.w*sqrt(u_zoom))*(focused?1.5:1.0);
  float extent=radius+((a_style.w>9.0||focused)?13.0:1.0);
  vec2 corner=vec2((gl_VertexID==1||gl_VertexID==3)?1.0:-1.0,gl_VertexID>=2?1.0:-1.0);
  gl_Position=clip+vec4(corner*extent*2.0/u_size*clip.w,0.0,0.0);
  // Positive clip W means the clip-Z sign is also camera-depth sign. Keep
  // classification on the GPU, constant across every node's four corners.
  v_viewDepth=clip.z;
  ${translucent ? `
  // Reject the other hemisphere before rasterization. All four corners keep
  // positive W and lie beyond the same far clip plane; zero belongs to near.
  if(${translucentHemisphereMismatch})gl_Position.z=2.0*clip.w;
  ` : ""}
  v_local=corner; v_radius=radius; v_extent=extent;
  float alpha=(u_focus>=0&&!focused&&a_neighbor<0.5)?0.2:clamp(1.0/clip.w,0.4,1.0);
  v_color=vec4(focused?vec3(1.0):a_style.rgb,alpha);${opaqueOnly ? `
  // Only the opaque color/mask pass rejects clearly subopaque whole quads.
  // Keep alpha near one on the original fragment path to avoid rounding ties.
  // Alpha is instance-constant; all four corners leave the same clip plane.
  if(alpha<0.9999)gl_Position.z=2.0*clip.w;` : ""}
}`;
/** Generate node antialias/focus coverage for the requested pass; opaque and translucent fragments keep separate depth-write rules. */
const nodeFragment = (pass: "opaque" | "translucent") => `#version 300 es
precision highp float;
precision highp int;
uniform float u_pixelRatio;
uniform int u_translucentHemisphere;
in vec2 v_local;
in vec4 v_color;
in float v_radius;
in float v_extent;
flat in float v_viewDepth;
out vec4 color;
void main() {
  ${pass === "translucent" ? `
  // Draw the far depth hemisphere first, then the near hemisphere. Zero-depth
  // ties belong only to the near pass. Instance order within each half remains.
  if(${translucentHemisphereMismatch})discard;
  ` : ""}
  float distance=length(v_local)*v_extent;
  float insideDistancePx=(v_radius-distance)*u_pixelRatio;
  // Both passes use this same conservative partition. Every covered fragment
  // belongs to one pass. Coverage is one at >=0.5 physical pixels inside;
  // the extra0.001 physical pixel is a conservative rounding margin.
  bool opaqueInterior=v_color.a>=1.0&&insideDistancePx>=0.501;
  ${pass === "opaque" ? `
  if(!opaqueInterior)discard;
  color=vec4(v_color.rgb,1.0);
  ` : `
  if(opaqueInterior)discard;
  // A one-physical-pixel radial coverage ramp stays sharp at Retina DPR;
  // radius, color and the existing CSS-space glow remain unchanged.
  float body=clamp(insideDistancePx+0.5,0.0,1.0);
  float glow=v_extent>v_radius+2.0?0.28*exp(-max(0.0,distance-v_radius)*0.32):0.0;
  float alpha=max(body,glow)*v_color.a;
  if(alpha<0.015) discard;
  color=vec4(v_color.rgb,alpha);
  `}
}`;
const edgeGeometry = `
void edgeGeometry(uvec2 pair, float outerRadiusPx, out vec4 a, out vec4 b, out vec2 offset) {
  a=projectPoint(pair.x); b=projectPoint(pair.y);
  vec2 delta=(b.xy/b.w-a.xy/a.w)*u_size;
  float edgeLength=length(delta);
  vec2 normal=edgeLength>0.00001?vec2(-delta.y,delta.x)/edgeLength:vec2(0.0);
  offset=normal*outerRadiusPx*2.0/u_size/u_pixelRatio;
}`;
/** Generate batched endpoint expansion at original CSS widths; the optional screen-space variant uses affine signed-distance interpolation. */
const edgeVertex = (screenSpace = false) => `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D u_edges;
${projection}
${edgeStyleGLSL}
flat out vec4 v_color;
flat out float v_halfWidthPx;
out float v_distanceTimesW;
uniform float u_pixelRatio;
${edgeGeometry}
void main() {
  int edge=gl_VertexID/4, corner=gl_VertexID%4;
  uvec3 edgeInfo=texelFetch(u_edges,ivec2(edge%256,edge/256),0).xyz;
  uvec2 a_pair=edgeInfo.xy; uint a_derived=edgeInfo.z;
  bool incident=int(a_pair.x)==u_focus||int(a_pair.y)==u_focus;
  float halfWidthPx=memoryEdgeWidthCss(incident)*u_pixelRatio*0.5;
  float outerRadiusPx=halfWidthPx+0.5;
  vec4 a,b; vec2 offset; edgeGeometry(a_pair,outerRadiusPx,a,b,offset);
  bool positive=corner==1||corner==3;
  bool endpointB=corner>=2;
  float side=positive?1.0:-1.0;
  vec4 clip=endpointB?b:a;
  // Preserve the original CSS width at every DPR. The extra half physical pixel
  // bounds a unit-width box filter; endpoint positions retain original butt caps.
  // The baseline uses reciprocal clip W; the screen-space variant is affine.
  vec4 expanded=clip+vec4(offset*side*clip.w,0.0,0.0);
  // Screen-space distance AA: normalize positive clip W once per vertex.
  // The screen positions and window depth stay the same; coverage is affine.
  gl_Position=${screenSpace ? "vec4(expanded.xyz/expanded.w,1.0)" : "expanded"};
  v_distanceTimesW=${screenSpace ? "side*outerRadiusPx" : "side*outerRadiusPx*clip.w"};
  v_halfWidthPx=halfWidthPx;
  v_color=memoryEdgeColor(incident,a_derived>0u);
}`;
/** Generate box-filtered physical-pixel stroke coverage, preserving subpixel peak opacity and integrated width. */
const edgeFragment = (screenSpace = false) => `#version 300 es
precision highp float;
flat in vec4 v_color;
flat in float v_halfWidthPx;
in float v_distanceTimesW;
out vec4 color;
void main(){
  // Baseline: undo perspective interpolation with gl_FragCoord.w (GLSL ES3 §7.2).
  // Screen-space variant: W is already one, so signed distance is affine.
  float distancePx=abs(${screenSpace ? "v_distanceTimesW" : "v_distanceTimesW*gl_FragCoord.w"});
  // Box-filter a straight stroke in physical pixels. The second term preserves
  // subpixel peak opacity and integrated width when the CSS stroke is <1px.
  float coverage=clamp(v_halfWidthPx+0.5-distancePx,0.0,1.0)
    -clamp(0.5-v_halfWidthPx-distancePx,0.0,1.0);
  color=vec4(v_color.rgb,coverage);
}`;

// Explicit diagnostic prototype: native one-pixel lines have no analytic edge
// coverage and cannot preserve the original CSS stroke widths. Never acceptance.
// Ordinary workspaces retain the analytic triangle renderer above.
const nativeEdgeVertex = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D u_edges;
${projection}
${edgeStyleGLSL}
flat out vec4 v_color;
void main() {
  int edge=gl_VertexID/2;
  uvec3 edgeInfo=texelFetch(u_edges,ivec2(edge%256,edge/256),0).xyz;
  gl_Position=projectPoint(gl_VertexID%2==0?edgeInfo.x:edgeInfo.y);
  bool incident=int(edgeInfo.x)==u_focus||int(edgeInfo.y)==u_focus;
  v_color=memoryEdgeColor(incident,edgeInfo.z>0u);
}`;
const nativeEdgeFragment = `#version 300 es
precision highp float;
flat in vec4 v_color;
out vec4 color;
void main(){color=v_color;}`;

type Program = { value: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
/** Batched analytic edge triangles and instanced nodes; picking uses the worker's BVH. */
export class MemoryWebGLRenderer {
  private readonly nodeProgram: Program;
  private readonly opaqueNodeProgram: Program;
  private readonly occlusionProgram: Program | null;
  private readonly edgeProgram: Program;
  private readonly projectedEdges: boolean;
  private readonly nodeVAO: WebGLVertexArrayObject;
  private readonly edgeVAO: WebGLVertexArrayObject;
  private readonly styles: WebGLBuffer;
  private readonly focusFlags: WebGLBuffer;
  private readonly edgeIndices: WebGLBuffer;
  private readonly edges: WebGLTexture;
  private readonly positions: WebGLTexture;
  private data: MemoryRenderData | null = null;
  private focus = -1;
  private focusValues = new Float32Array(0);
  private camera: MemoryCamera3D = { yaw: 0, pitch: 0, zoom: 1 };
  private width = 0;
  private height = 0;
  private ratio = 1;
  private gpuTimer: { extension: TimerExtension; pending: Array<{ query: WebGLQuery; stage: "edges" | "nodes" }>;
    edges: number[]; nodes: number[]; disjoint: boolean } | null = null;

  /** Optional asynchronous diagnostics. Never wait for GPU completion on the main thread. */
  beginGpuBenchmark() {
    this.finishGpuBenchmark();
    const extension = this.gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExtension | null;
    if (extension) this.gpuTimer = { extension, pending: [], edges: [], nodes: [], disjoint: false };
  }

  /** Collect only completed asynchronous timer queries and record disjoint status; never wait for queued GPU work. */
  private collectGpuTimings() {
    const timer = this.gpuTimer, gl = this.gl;
    if (!timer) return;
    if (gl.getParameter(timer.extension.GPU_DISJOINT_EXT)) timer.disjoint = true;
    while (timer.pending.length && gl.getQueryParameter(timer.pending[0]!.query, gl.QUERY_RESULT_AVAILABLE)) {
      const { query, stage } = timer.pending.shift()!;
      timer[stage].push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6); gl.deleteQuery(query);
    }
  }

  /** Begin an optional stage timer only while pending query count is bounded; return whether this draw owns an active query. */
  private beginGpuStage(stage: "edges" | "nodes") {
    const timer = this.gpuTimer, gl = this.gl;
    if (!timer || timer.pending.length >= 16) return false;
    const query = gl.createQuery(); if (!query) return false;
    gl.beginQuery(timer.extension.TIME_ELAPSED_EXT, query); timer.pending.push({ query, stage }); return true;
  }

  /** Close the stage query only when beginGpuStage actually started it. */
  private endGpuStage(active: boolean) {
    if (active && this.gpuTimer) this.gl.endQuery(this.gpuTimer.extension.TIME_ELAPSED_EXT);
  }

  /** Drain completed queries, delete unresolved queries and report stage samples/disjoint state. Stage timings exclude labels and presentation and cannot replace frame cadence. */
  finishGpuBenchmark() {
    this.collectGpuTimings();
    const timer = this.gpuTimer; this.gpuTimer = null;
    if (!timer) return { available: false };
    for (const { query } of timer.pending) this.gl.deleteQuery(query);
    return { available: true, disjoint: timer.disjoint, pendingSamplesDiscarded: timer.pending.length,
      edgeScope:"Framebuffer clear, optional union-of-opaque-interiors stencil mask preparation, and edge drawing; excludes final node pass, labels, compositing and presentation.",
      nodeScope:"Three GPU instance draws of the same unique nodes: opaque interiors with depth writes, far translucent hemisphere, then near/zero-depth translucent hemisphere. Both translucent draws disable depth writes; each translucent fragment belongs to exactly one hemisphere. No CPU node sorting. Queries exclude labels/compositing/presentation.",
      rawEdgesGpuMs: timer.disjoint ? [] : timer.edges, rawNodesGpuMs: timer.disjoint ? [] : timer.nodes,
      limitation: "Asynchronous GPU stage queries include warmup frames, exclude labels/compositing/presentation, and never replace rAF frame measurements." };
  }

  /** Allocate owned programs, VAOs, buffers and textures for this context; roll back every prior allocation if initialization fails. Diagnostic native-edge flags never qualify as normal visual acceptance. */
  constructor(private readonly gl: WebGL2RenderingContext, private readonly nativeEdges = false, requestProjectedEdges = false, requestOcclusion = true) {
    const resources: Array<() => void> = [];
    // A failed shader/allocation must release earlier resources before falling back.
    /** Register a successfully allocated WebGL resource for constructor rollback, throwing before a null handle can be used. */
    const own = <T>(resource: T | null, dispose: (value: T) => void): T => {
      if (!resource) throw new Error("WebGL allocation failed");
      resources.push(() => dispose(resource)); return resource;
    };
    try {
      this.projectedEdges = requestProjectedEdges && !nativeEdges;
      this.nodeProgram = this.program(nodeVertex(true), nodeFragment("translucent")); resources.push(() => gl.deleteProgram(this.nodeProgram.value));
      this.opaqueNodeProgram = this.program(nodeVertex(false,true),nodeFragment("opaque")); resources.push(() => gl.deleteProgram(this.opaqueNodeProgram.value));
      // The mask and final opaque pass share the exact interior predicate.
      this.occlusionProgram = requestOcclusion && this.projectedEdges && gl.getContextAttributes()?.stencil ? this.opaqueNodeProgram : null;
      this.edgeProgram = this.program(nativeEdges ? nativeEdgeVertex : edgeVertex(this.projectedEdges), nativeEdges ? nativeEdgeFragment : edgeFragment(this.projectedEdges)); resources.push(() => gl.deleteProgram(this.edgeProgram.value));

      this.nodeVAO = own(gl.createVertexArray(), value => gl.deleteVertexArray(value));
      this.edgeVAO = own(gl.createVertexArray(), value => gl.deleteVertexArray(value));
      this.styles = own(gl.createBuffer(), value => gl.deleteBuffer(value));
      this.focusFlags = own(gl.createBuffer(), value => gl.deleteBuffer(value));
      this.edgeIndices = own(gl.createBuffer(), value => gl.deleteBuffer(value));
      this.edges = own(gl.createTexture(), value => gl.deleteTexture(value));
      this.positions = own(gl.createTexture(), value => gl.deleteTexture(value));
      gl.bindVertexArray(this.nodeVAO);
      this.attribute(this.styles, 0, 4, false); this.attribute(this.focusFlags, 1, 1, false);
      gl.bindVertexArray(this.edgeVAO);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeIndices);

      // Indexed corners reuse two vertices per edge. No per-edge GPU instances.
      gl.bindVertexArray(null);
    } catch (error) { for (const dispose of resources.reverse()) dispose(); throw error; }
  }

  /** Compile/link one shader pair, cache uniform locations and delete intermediate shaders on success or failure; failed programs are also released. */
  private program(vertex: string, fragment: string): Program {
    const gl = this.gl, shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    if (!program) throw new Error("WebGL program allocation failed");
    try {
      for (const [source, type] of [[vertex, gl.VERTEX_SHADER], [fragment, gl.FRAGMENT_SHADER]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("WebGL shader allocation failed");
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "WebGL shader failed");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "WebGL link failed");
      const uniforms: Program["uniforms"] = {};
      for (const name of ["u_positions", "u_edges", "u_size", "u_rotation", "u_scale", "u_zoom", "u_focus", "u_pixelRatio", "u_translucentHemisphere"]) uniforms[name] = gl.getUniformLocation(program, name);
      return { value: program, uniforms };
    } catch (error) { gl.deleteProgram(program); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
  }

  /** Bind an instanced float or integer attribute to the currently bound VAO; the supplied buffer remains owned by this renderer. */
  private attribute(buffer: WebGLBuffer, location: number, size: number, integer: boolean) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.enableVertexAttribArray(location);
    if (integer) gl.vertexAttribIPointer(location, size, gl.UNSIGNED_INT, 0, 0);
    else gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(location, 1);
  }

  /** Upload topology/styles/coordinates once for a new render model and reset focus. Camera-only frames reuse these resources. */
  setData(data: MemoryRenderData) {
    const gl = this.gl;
    this.data = data; this.focus = -1;
    this.focusValues = new Float32Array(data.nodes.length);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.styles); gl.bufferData(gl.ARRAY_BUFFER, data.styles, gl.STATIC_DRAW);
    gl.bindVertexArray(this.edgeVAO); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.edgeIndices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.edgeIndices, gl.STATIC_DRAW); gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.edges);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 256, data.edgeTexture.length / 1024, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data.edgeTexture);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.focusFlags); gl.bufferData(gl.ARRAY_BUFFER, data.nodes.length * 4, gl.DYNAMIC_DRAW);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.positions);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 256, data.coordinates.length / 1024, 0, gl.RGBA, gl.FLOAT, data.coordinates);

  }

  /** Expose the active edge representation so diagnostic reports can distinguish analytic, projected and ineligible native-line variants. */
  get edgeStrategy() { return this.nativeEdges ? "native" : this.projectedEdges ? "projected" : "analytic"; }
  /** Report whether the large-graph stencil optimization is active for this context and current model. */
  get edgeOcclusionEnabled() { return Boolean(this.occlusionProgram && this.data && this.data.nodes.length>=10000); }

  /** The union of final opaque-interior coverage is sufficient.
   * Edges never write depth. At each masked pixel, some final opaque fragment
   * therefore wins LEQUAL against the clear depth and overwrites color/alpha
   * with blending disabled. Later transparent source-over cannot restore any
   * edge contribution. Reuse the exact final opaque program and geometry. */
  private prepareOpaqueNodeMask(camera:MemoryCamera3D) {
    if(!this.occlusionProgram || !this.data)return;
    const gl=this.gl;
    gl.disable(gl.BLEND);gl.colorMask(false,false,false,false);
    gl.disable(gl.DEPTH_TEST);gl.depthMask(false);
    gl.enable(gl.STENCIL_TEST);gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS,1,0xff);gl.stencilOp(gl.KEEP,gl.KEEP,gl.REPLACE);
    this.use(this.opaqueNodeProgram,camera);gl.bindVertexArray(this.nodeVAO);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.data.nodes.length);
    // Depth testing was disabled, so the cleared depth buffer is untouched.
    // Retain only the stencil union for the original edge-first color pass.
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.depthMask(true);
    gl.colorMask(true,true,true,true);gl.enable(gl.BLEND);
    gl.stencilMask(0);gl.stencilFunc(gl.EQUAL,0,0xff);gl.stencilOp(gl.KEEP,gl.KEEP,gl.KEEP);
  }


  /** Replace only same-shaped position/BVH data and update the coordinate texture; ignore incompatible topology until setData installs it. */
  updateCoordinates(coordinates: Float32Array, extent: number, picking?: MemoryPickingIndex) {
    if (!this.data || coordinates.length !== this.data.coordinates.length) return;
    this.data.coordinates = coordinates; this.data.extent = extent;
    if (picking) this.data.picking = picking;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.positions);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, coordinates.length / 1024, gl.RGBA, gl.FLOAT, coordinates);
  }

  /** Sparse CSR neighbors: pointer interaction does not scan every node or edge. */
  setFocus(index: number) {
    if (index === this.focus || !this.data) return;
    const gl = this.gl, data = this.data;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.focusFlags);
    if (this.focus >= 0) {
      for (let i = data.neighborOffsets[this.focus]!; i < data.neighborOffsets[this.focus + 1]!; i++) this.focusValues[data.neighbors[i]!] = 0;
    }
    this.focus = index;
    if (index < 0 || index >= data.nodes.length) this.focus = -1;
    else for (let i = data.neighborOffsets[index]!; i < data.neighborOffsets[index + 1]!; i++) this.focusValues[data.neighbors[i]!] = 1;
    // One upload even for a source hub with thousands of neighbors.
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.focusValues);
  }

  /** Set CSS-to-physical viewport dimensions and backing-buffer size using the caller supplied positive DPR. */
  resize(width: number, height: number, ratio: number) {
    const gl = this.gl;
    this.width = Math.max(1, Math.round(width * ratio)); this.height = Math.max(1, Math.round(height * ratio)); this.ratio = ratio;
    gl.canvas.width = this.width; gl.canvas.height = this.height;
  }

  /** Bind one program and upload the current CSS viewport, projection, focus and texture uniforms for a draw pass. */
  private use(program: Program, camera: MemoryCamera3D) {
    const gl = this.gl, u = program.uniforms;
    gl.useProgram(program.value);
    gl.uniform1i(u.u_positions!, 0); gl.uniform2f(u.u_size!, this.width / this.ratio, this.height / this.ratio);
    gl.uniform1i(u.u_edges!, 1);
    gl.uniform4f(u.u_rotation!, Math.cos(camera.yaw), Math.sin(camera.yaw), Math.cos(camera.pitch), Math.sin(camera.pitch));
    gl.uniform1f(u.u_scale!, Math.min(this.width, this.height) / this.ratio * 0.4 / (this.data?.extent ?? 60));
    gl.uniform1f(u.u_zoom!, camera.zoom); gl.uniform1i(u.u_focus!, this.focus);
    gl.uniform1f(u.u_pixelRatio!, this.ratio);
  }

  /** Submit batched edges and instanced opaque/translucent node passes for the cached model, leaving labels to the component. CPU return is not GPU completion or presented-frame timing. */
  render(camera: MemoryCamera3D, scene: { edges: boolean; nodes: boolean } = { edges: true, nodes: true }, diagnosticCheck?: (stage:string)=>void) {
    if (!this.data || this.gl.isContextLost()) return;
    this.camera = { ...camera };
    const gl = this.gl;
    this.collectGpuTimings();
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.edges);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.positions);
    const edgesTimer=scene.edges?this.beginGpuStage("edges"):false;
    gl.viewport(0, 0, this.width, this.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.STENCIL_TEST);gl.stencilMask(0xff);gl.clearStencil(0);gl.colorMask(true,true,true,true);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    // Shaders emit straight RGB; the default premultiplied-alpha drawing buffer
    // stores RGB*srcA but source-over alpha is srcA+dstA*(1-srcA), not srcA^2.
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if(scene.edges && scene.nodes && this.edgeOcclusionEnabled)this.prepareOpaqueNodeMask(camera);
    diagnosticCheck?.("opaque node mask");
    if (scene.edges) {
      this.use(this.edgeProgram, camera); gl.bindVertexArray(this.edgeVAO);
      // Analytic one-pixel coverage avoids native line/MSAA rasterization costs.
      // Every edge retains its original endpoints, color, depth and blend order.
      gl.depthMask(false);
      if (this.nativeEdges) { gl.lineWidth(1); gl.drawArrays(gl.LINES, 0, this.data.edgeKinds.length * 2); }
      else gl.drawElements(gl.TRIANGLES, this.data.edgeIndices.length, gl.UNSIGNED_INT, 0);
      this.endGpuStage(edgesTimer);
      diagnosticCheck?.("edge drawing");
    }
    gl.disable(gl.STENCIL_TEST);
    if (scene.nodes) {
      const nodesTimer = this.beginGpuStage("nodes");
      gl.bindVertexArray(this.nodeVAO);
      // Build/color the nearest opaque interiors first. Writing transparent
      // fringe depth would hide farther bodies and produce dark node outlines.
      this.use(this.opaqueNodeProgram,camera);gl.disable(gl.BLEND);gl.depthMask(true);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.data.nodes.length);
      this.use(this.nodeProgram, camera);
      // Depth halves are ordered on the GPU; fragments within each half retain
      // instance order. This is not full sorted/independent transparency.
      gl.enable(gl.BLEND);gl.depthMask(false);
      gl.uniform1i(this.nodeProgram.uniforms.u_translucentHemisphere!,1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.data.nodes.length);
      gl.uniform1i(this.nodeProgram.uniforms.u_translucentHemisphere!,-1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP,0,4,this.data.nodes.length);this.endGpuStage(nodesTimer);
      gl.depthMask(true);
      diagnosticCheck?.("node drawing");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindVertexArray(null);
  }

  /** Query the uploaded world-space BVH in CSS pixels with the last rendered camera; invalid/lost/outside queries return-1 without GPU readback. */
  pick(x: number, y: number): number {
    const gl = this.gl;
    if (!this.data || gl.isContextLost() || x < 0 || y < 0 || x * this.ratio >= this.width || y * this.ratio >= this.height) return -1;
    return pickMemoryNode(this.data.picking, this.data.coordinates, this.data.styles, this.camera, this.data.extent,
      this.width / this.ratio, this.height / this.ratio, x, y, this.focus);
  }

  /** Provide a promise-shaped adapter for the same synchronous BVH query; this method does not schedule a separate GPU picking pass. */
  pickAsync(x: number, y: number): Promise<number> {
    return Promise.resolve(this.pick(x, y));
  }

  /** Delete owned timer queries, buffers, textures, VAOs and programs and clear the model; call before abandoning or replacing a renderer. */
  dispose() {
    const gl = this.gl;
    this.finishGpuBenchmark();
    for (const buffer of [this.styles, this.focusFlags, this.edgeIndices]) gl.deleteBuffer(buffer);
    gl.deleteTexture(this.positions); gl.deleteTexture(this.edges);
    gl.deleteVertexArray(this.nodeVAO); gl.deleteVertexArray(this.edgeVAO);
    gl.deleteProgram(this.nodeProgram.value); gl.deleteProgram(this.opaqueNodeProgram.value); gl.deleteProgram(this.edgeProgram.value);
    this.data = null;
  }
}
