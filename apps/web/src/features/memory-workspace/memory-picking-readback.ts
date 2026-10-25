import { decodeMemoryPickingPixel } from "./memory-webgl-math.js";

/** A pixel-pack buffer avoids waiting for the entire scene's GPU queue in a pointer event. */
export function readMemoryPickingPixelAsync(gl: WebGL2RenderingContext, framebuffer: WebGLFramebuffer, x: number, y: number) {
  /** Hold an idempotent cancellation callback once GPU readback resources exist; cancellation resolves no hit. */
  let cancel = () => {};
  const promise = new Promise<number>(resolve => {
    const buffer = gl.createBuffer();
    if (!buffer) { resolve(-1); return; }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer); gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) { gl.deleteBuffer(buffer); resolve(-1); return; }
    gl.flush();
    let frame = 0, settled = false;
    /** Settle the readback once, cancel polling and release both the fence and pixel-pack buffer. */
    const finish = (index: number) => {
      if (settled) return; settled = true; cancelAnimationFrame(frame);
      gl.deleteSync(fence); gl.deleteBuffer(buffer); resolve(index);
    };
    /** Check a nonblocking GPU fence, retry on a future frame and read one RGBA value only after completion; loss/failure resolves no hit. */
    const poll = () => {
      if (settled || gl.isContextLost()) { finish(-1); return; }
      const status = gl.clientWaitSync(fence, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) { frame = requestAnimationFrame(poll); return; }
      if (status === gl.WAIT_FAILED) { finish(-1); return; }
      const pixel = new Uint8Array(4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixel); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      finish(decodeMemoryPickingPixel(pixel));
    };
    cancel = () => finish(-1); frame = requestAnimationFrame(poll);
  });
  return { promise, cancel: () => cancel() };
}
