import { describe, expect, it } from "vitest";
import { memoryTimingSummary, runMemoryFrameBenchmark, type MemoryFrameBenchmarkResult } from "../src/features/memory-workspace/memory-frame-benchmark.js";

describe("actual component diagnostic timing", () => {
  it("measures rendered work and 240 active intervals after warmup, retaining raw samples and restoring the camera", () => {
    const camera={yaw:.3,pitch:-.15,zoom:1}, original={...camera};
    const queue:FrameRequestCallback[]=[], reports:MemoryFrameBenchmarkResult[]=[];
    let time=0, draws=0;
    const windows:Array<[number,number,string]>=[];
    runMemoryFrameBenchmark({camera,render:()=>{time+=2;draws++;},valid:()=>true,metadata:{nodes:50000},complete:r=>reports.push(r),
      recordTraceWindow:(start,end,status)=>windows.push([start,end,status]),
      requestFrame:cb=>{queue.push(cb);return queue.length;},cancelFrame:()=>{},now:()=>time});
    let timestamp=0;
    while(queue.length) {timestamp+=16;queue.shift()!(timestamp);}
    expect(draws).toBe(271);expect(camera).toEqual(original);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.status).toBe("complete");expect(reports[0]!.rawFrameIntervalsMs).toHaveLength(240);
    expect(reports[0]!.cpuSubmissionIncludingLabelsMs).toMatchObject({samples:240,p95:2});
    expect(reports[0]!.frameIntervalsMs).toMatchObject({samples:240,p95:16});
    expect(windows).toEqual([[480,4320,"complete"]]);
    expect(reports[0]!.metadata.measuredRafWindowMs).toEqual([480,4320]);
    expect(reports[0]!.rawFrameIntervalsMs.reduce((a,b)=>a+b,0)).toBe(windows[0]![1]-windows[0]![0]);
  });
  it("marks invalid/hidden runs aborted rather than manufacturing passing zero timings", () => {
    const reports:MemoryFrameBenchmarkResult[]=[], queue:FrameRequestCallback[]=[];
    runMemoryFrameBenchmark({camera:{yaw:0,pitch:0,zoom:1},render:()=>{},valid:()=>false,metadata:{},complete:r=>reports.push(r),
      requestFrame:cb=>{queue.push(cb);return 1;},cancelFrame:()=>{}});
    queue.shift()!(16);
    expect(reports[0]).toMatchObject({status:"aborted",frameIntervalsMs:{samples:0,p95:null}});
    expect(memoryTimingSummary([]).max).toBeNull();
  });
});
