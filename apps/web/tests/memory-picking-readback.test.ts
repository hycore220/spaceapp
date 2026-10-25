import { afterEach, describe, expect, it, vi } from "vitest";
import { readMemoryPickingPixelAsync } from "../src/features/memory-workspace/memory-picking-readback.js";
import { encodeMemoryPickingIndex } from "../src/features/memory-workspace/memory-webgl-math.js";

afterEach(() => vi.unstubAllGlobals());
function harness() {
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const gl = {
    PIXEL_PACK_BUFFER: 1, STREAM_READ: 2, FRAMEBUFFER: 3, RGBA: 4, UNSIGNED_BYTE: 5, SYNC_GPU_COMMANDS_COMPLETE: 6,
    TIMEOUT_EXPIRED: 7, WAIT_FAILED: 8, CONDITION_SATISFIED: 9,
    createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(), bindFramebuffer: vi.fn(), readPixels: vi.fn(),
    fenceSync: vi.fn(() => ({})), flush: vi.fn(), isContextLost: vi.fn(() => false), clientWaitSync: vi.fn((_fence: WebGLSync, _flags: number, _timeout: number) => 9),
    getBufferSubData: vi.fn((_target: number, _offset: number, pixel: Uint8Array) => pixel.set(encodeMemoryPickingIndex(49999))),
    deleteSync: vi.fn(), deleteBuffer: vi.fn()
  };
  const tick = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(0); };
  return { gl, frames, tick, start: () => readMemoryPickingPixelAsync(gl as unknown as WebGL2RenderingContext, {} as WebGLFramebuffer, 42, 17) };
}
describe("nonblocking GPU picking readback", () => {
  it("uses pixel-pack offset readback and only copies a ready GPU result after zero-timeout fence polls", async () => {
    const h = harness(); h.gl.clientWaitSync.mockReturnValueOnce(7).mockReturnValue(9);
    const request = h.start();
    expect(h.gl.readPixels).toHaveBeenCalledWith(42, 17, 1, 1, 4, 5, 0);
    expect(h.gl.getBufferSubData).not.toHaveBeenCalled();
    h.tick(); expect(h.gl.getBufferSubData).not.toHaveBeenCalled(); expect(h.frames.size).toBe(1);
    h.tick(); expect(await request.promise).toBe(49999);
    expect(h.gl.clientWaitSync.mock.calls.every(call => call[1] === 0 && call[2] === 0)).toBe(true);
    expect(h.gl.deleteBuffer).toHaveBeenCalledTimes(1); expect(h.gl.deleteSync).toHaveBeenCalledTimes(1);
  });
  it("cancels on unmount/data replacement without leaving an animation callback or GPU resources", async () => {
    const h = harness(), request = h.start(); request.cancel(); request.cancel();
    expect(await request.promise).toBe(-1); expect(h.frames.size).toBe(0);
    expect(h.gl.getBufferSubData).not.toHaveBeenCalled(); expect(h.gl.deleteBuffer).toHaveBeenCalledTimes(1);
  });
  it.each(["loss", "failure"])("settles safely on context%s without reading invalid buffer contents", async mode => {
    const h = harness(); if (mode === "loss") h.gl.isContextLost.mockReturnValue(true); else h.gl.clientWaitSync.mockReturnValue(8);
    const request = h.start(); h.tick(); expect(await request.promise).toBe(-1);
    expect(h.gl.getBufferSubData).not.toHaveBeenCalled(); expect(h.gl.deleteSync).toHaveBeenCalledTimes(1);
  });
});
