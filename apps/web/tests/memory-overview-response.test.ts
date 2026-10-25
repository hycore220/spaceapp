import { afterEach, describe, expect, it, vi } from "vitest";
import { readLargeMemoryOverview } from "../src/features/memory-workspace/memory-overview-response.js";

afterEach(() => vi.unstubAllGlobals());
describe("chunked worker overview decoding", () => {
  it("assembles node/edge chunks without dropping redacted fields or metadata, then releases the worker", async () => {
    const stopped=vi.fn(), post=vi.fn();
    class WorkerStub {
      onmessage: ((event:{data:unknown})=>void)|null=null;
      onerror:unknown;
      terminate=stopped;
      postMessage(bytes: ArrayBuffer, transfer: ArrayBuffer[]) {
        post(bytes,transfer);
        queueMicrotask(() => {
          for(const data of [{kind:"nodes",items:[{id:"a",sourcePath:null}]},{kind:"nodes",items:[{id:"b",label:"redacted"}]},
            {kind:"edges",items:[{source:"a",target:"b"}]},{kind:"done",metadata:{truncated:false,totalMatchingNodes:2}}]) this.onmessage?.({data});
        });
      }
    }
    vi.stubGlobal("Worker",WorkerStub);
    const bytes=new ArrayBuffer(8);
    await expect(readLargeMemoryOverview({arrayBuffer:async()=>bytes} as Response)).resolves.toEqual({data:{nodes:[{id:"a",sourcePath:null},{id:"b",label:"redacted"}],edges:[{source:"a",target:"b"}],truncated:false,totalMatchingNodes:2}});
    expect(post).toHaveBeenCalledWith(bytes,[bytes]);expect(stopped).toHaveBeenCalledOnce();
  });
  it("propagates worker validation failure rather than resolving a partial response", async () => {
    const stopped=vi.fn();
    class WorkerStub {
      onmessage:((event:{data:unknown})=>void)|null=null;
      terminate=stopped;
      postMessage(){queueMicrotask(()=>this.onmessage?.({data:{error:"Invalid redacted graph"}}));}
    }
    vi.stubGlobal("Worker",WorkerStub);
    await expect(readLargeMemoryOverview({arrayBuffer:async()=>new ArrayBuffer(1)} as Response)).rejects.toThrow("Invalid redacted graph");
    expect(stopped).toHaveBeenCalledOnce();
  });
  it("rejects a deserialization error and releases the worker instead of waiting forever", async () => {
    const stopped=vi.fn();
    class WorkerStub {
      onmessageerror:((event:unknown)=>void)|null=null;
      terminate=stopped;
      postMessage(){queueMicrotask(()=>this.onmessageerror?.({}));}
    }
    vi.stubGlobal("Worker",WorkerStub);
    await expect(readLargeMemoryOverview({arrayBuffer:async()=>new ArrayBuffer(1)} as Response)).rejects.toThrow("deserialized");
    expect(stopped).toHaveBeenCalledOnce();
  },1000);
});
