import { describe,expect,it,vi } from "vitest";
import { memoryLoadTaskOverlaps,startMemoryLoadObservation } from "../src/features/memory-workspace/memory-load-benchmark.js";
const task=(startTime:number,duration:number)=>({name:"self",entryType:"longtask",startTime,duration,toJSON:()=>({startTime,duration,attribution:[{name:"unknown"}]})});
describe("bounded diagnostic load task observation",()=>{
  it("keeps whole tasks crossing either boundary and excludes disjoint tasks",()=>{
    expect(memoryLoadTaskOverlaps(task(90,120),100,200)).toBe(true);
    expect(memoryLoadTaskOverlaps(task(190,120),100,200)).toBe(true);
    expect(memoryLoadTaskOverlaps(task(1,98),100,200)).toBe(false);
    expect(memoryLoadTaskOverlaps(task(201,120),100,200)).toBe(false);
  });
  it("drains a late final-task record without truncating its >100ms duration",async()=>{
    let pending:ReturnType<typeof task>[]=[],yields=0;
    const disconnect=vi.fn();
    const observation=startMemoryLoadObservation({now:()=>100,supported:true,
      createObserver:record=>({observe:()=>record([],0),takeRecords:()=>pending.splice(0),disconnect}),
      yieldTask:async()=>{if(++yields===1)pending.push(task(190,120));}});
    const result:any=await observation.finish(200);
    expect(result.entries).toHaveLength(1);expect(result.entriesOver100ms[0].duration).toBe(120);
    expect(result.uiTaskBound.status).toBe("exceeded");expect(result.windowMs).toEqual([100,200]);
    expect(yields).toBe(2);expect(disconnect).toHaveBeenCalledOnce();
    expect(await observation.finish(999)).toBe(result);
  });
  it("filters previously buffered tasks and preserves native raw attribution",async()=>{
    const pending=[task(1,80),task(90,60),task(300,120)];
    const observation=startMemoryLoadObservation({now:()=>100,supported:true,yieldTask:async()=>{},
      createObserver:record=>({observe:()=>record([],0),takeRecords:()=>pending.splice(0),disconnect:vi.fn()})});
    const result:any=await observation.finish(200);
    expect(result.entries).toHaveLength(1);expect(result.entries[0].attribution).toEqual([{name:"unknown"}]);
    expect(result.uiTaskBound.status).toBe("no-exceedance-observed");
  });
  it("reports unsupported or failed registration as unknown rather than zero",async()=>{
    const unsupported:any=await startMemoryLoadObservation({now:()=>100,supported:false,yieldTask:async()=>{}}).finish(200);
    expect(unsupported.uiTaskBound.status).toBe("unknown");expect(unsupported.entries).toBeNull();expect(unsupported.maxTaskDurationMs).toBeNull();
    const failed:any=await startMemoryLoadObservation({now:()=>100,supported:true,yieldTask:async()=>{},
      createObserver:()=>({observe:()=>{throw Error("registration failed");},takeRecords:()=>[],disconnect:vi.fn()})}).finish(200);
    expect(failed.uiTaskBound.status).toBe("unknown");expect(failed.maxTaskDurationMs).toBeNull();
  });
  it("retains evidence but withholds a clean bound after dropped entries or incomplete load",async()=>{
    const make=(dropped:number,complete:boolean)=>startMemoryLoadObservation({now:()=>100,supported:true,yieldTask:async()=>{},
      createObserver:record=>({observe:()=>record([task(150,110)],dropped),takeRecords:()=>[],disconnect:vi.fn()})}).finish(200,complete);
    for(const result of [await make(1,true),await make(0,false)] as any[]){
      expect(result.entriesOver100ms).toHaveLength(1);expect(result.uiTaskBound.status).toBe("unknown");
    }
  });
  it("does not invent zero drops without explicit browser metadata",async()=>{
    for(const mode of ["no-callback","missing","invalid","missing-after-zero"]){
      const observation=startMemoryLoadObservation({now:()=>100,supported:true,yieldTask:async()=>{},
        createObserver:record=>({observe:()=>{
          if(mode==="missing-after-zero")record([],0);
          if(mode!=="no-callback")record([],mode==="invalid"?NaN:undefined);
        },takeRecords:()=>[task(150,60)],disconnect:vi.fn()})});
      const result:any=await observation.finish(200);
      expect(result.status).toBe("unknown");expect(result.uiTaskBound.status).toBe("unknown");
      expect(result.dropMetadata.status).toBe("unknown");expect(result.maxTaskDurationMs).toBeNull();
      expect(result.entries[0].duration).toBe(60);
      if(mode!=="missing-after-zero")expect(result.droppedEntriesCount).toBeNull();
    }
  });
});
