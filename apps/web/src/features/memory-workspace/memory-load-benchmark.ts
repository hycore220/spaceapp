/** Diagnostic only: bounded UI-thread task evidence, not GPU completion or a frame gate. */
type TaskEntry = { name:string; entryType:string; startTime:number; duration:number; toJSON?:()=>unknown };
type Observer = { observe:(options:{type:string;buffered:boolean})=>void; takeRecords:()=>TaskEntry[]; disconnect:()=>void };
type Dependencies = { now?:()=>number; yieldTask?:()=>Promise<void>; supported?:boolean;
  createObserver?:(record:(entries:TaskEntry[],dropped?:number)=>void)=>Observer };
export type MemoryLoadObservation = ReturnType<typeof startMemoryLoadObservation>;
/** Include tasks touching either observation boundary and retain their whole duration instead of clipping it to the window. */
export function memoryLoadTaskOverlaps(entry:{startTime:number;duration:number},start:number,end:number) {
  // Include boundary-touching tasks conservatively; never trim their duration.
  return entry.startTime<=end&&entry.startTime+entry.duration>=start;
}
/** Observe UI LongTasks across a bounded load and future-task drain. Missing optional drop metadata remains unknown; no callback cannot establish zero loss. */
export function startMemoryLoadObservation(dependencies:Dependencies={}) {
  const now=dependencies.now??(()=>performance.now()),startedAtMs=now();
  const yieldTask=dependencies.yieldTask??(()=>new Promise<void>(resolve=>setTimeout(resolve,0)));
  const supported=dependencies.supported??(typeof PerformanceObserver!=="undefined"&&PerformanceObserver.supportedEntryTypes?.includes("longtask")===true);
  const entries:Array<Record<string,unknown>&{startTime:number;duration:number}>=[];
  const problems:string[]=[];let droppedEntriesCount:number|null=null,observer:Observer|null=null,finished:Promise<unknown>|null=null;
  let dropMetadataCallbacks=0,missingDropMetadata=false;
  /** Append raw task entries and attribution after validating finite timestamps; taking records does not imply knowledge of dropped entries. */
  const record=(batch:TaskEntry[])=>{
    for(const entry of batch){
      if(!Number.isFinite(entry.startTime)||!Number.isFinite(entry.duration)||entry.duration<0){problems.push("Invalid observer entry");continue;}
      const raw=entry.toJSON?.();
      entries.push({...(raw&&typeof raw==="object"?raw:{}),name:entry.name,entryType:entry.entryType,startTime:entry.startTime,duration:entry.duration});
    }
  };
  // takeRecords supplies entries, not drop metadata. No callback (or an older
  // browser omitting its optional third argument) cannot establish zero loss.
  /** Record callback entries and explicit browser drop counts separately; missing or invalid optional metadata prevents a clean completeness claim. */
  const delivered=(batch:TaskEntry[],dropped?:number)=>{
    if(typeof dropped==="number"&&Number.isSafeInteger(dropped)&&dropped>=0){
      dropMetadataCallbacks++;droppedEntriesCount=Math.max(droppedEntriesCount??0,dropped);
    }else missingDropMetadata=true;
    record(batch);
  };
  if(supported)try{
    observer=dependencies.createObserver?dependencies.createObserver(delivered):new PerformanceObserver(
      (list,_observer,options?:{droppedEntriesCount?:number})=>delivered(list.getEntries(),options?.droppedEntriesCount));
    observer.observe({type:"longtask",buffered:true});
  }catch(error){problems.push(String(error));try{observer?.disconnect();}catch{}observer=null;}
  else problems.push("Long Tasks observation unsupported");
  /** Take pending observer records while preserving registration/drain failures as unknown observations. */
  const drain=()=>{try{if(observer)record(observer.takeRecords());}catch(error){problems.push(String(error));}};
  /** Freeze the requested end, drain across two future tasks, disconnect and report whole overlapping entries; unsupported, incomplete or unverifiable observations remain unknown. */
  const finish=async(endedAtMs:number,complete=true)=>{
    if(finished)return finished;
    finished=(async()=>{
      if(!Number.isFinite(endedAtMs)||endedAtMs<startedAtMs)problems.push("Invalid observation window");
      drain();
      // The task containing the end boundary must finish before it can generate
      // a longtask entry. Freeze the boundary, then drain across future tasks.
      for(let i=0;i<2;i++){try{await yieldTask();}catch(error){problems.push(String(error));}drain();}
      try{observer?.disconnect();}catch(error){problems.push(String(error));}
      const selected=entries.filter(entry=>memoryLoadTaskOverlaps(entry,startedAtMs,endedAtMs));
      const over100=selected.filter(entry=>entry.duration>100);
      const dropMetadataKnown=dropMetadataCallbacks>0&&!missingDropMetadata;
      const known=supported&&problems.length===0&&dropMetadataKnown&&droppedEntriesCount===0&&complete;
      return {status:known?"observed":"unknown",windowMs:[startedAtMs,endedAtMs],supported,problems,droppedEntriesCount,
        dropMetadata:{status:dropMetadataKnown?"reported":"unknown",callbacksWithExplicitCount:dropMetadataCallbacks,callbackWithMissingCount:missingDropMetadata},
        drainPolicy:"takeRecords before and after two future tasks; end boundary frozen before draining; overlapping whole tasks retained",
        entries:supported?selected:null,entriesOver100ms:supported?over100:null,
        maxTaskDurationMs:known?Math.max(0,...selected.map(entry=>entry.duration)):null,
        uiTaskBound:{thresholdMs:100,comparison:">",status:known?(over100.length?"exceeded":"no-exceedance-observed"):"unknown"},
        limitation:"Window longtask entries describe UI-thread tasks, not worker execution, GPU completion, presentation or full application acceptance."};
    })();
    return finished;
  };
  return {startedAtMs,finish,cancel:()=>{problems.push("Observation cancelled");try{observer?.disconnect();}catch{}}};
}
