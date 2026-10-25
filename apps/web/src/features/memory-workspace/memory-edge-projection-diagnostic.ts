import { DEFAULT_MEMORY_CAMERA } from "./memory-3d.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import type { MemoryRenderData } from "./memory-render-data.js";
import { createMemoryPickingIndex } from "./memory-picking-index.js";
import { MemoryWebGLRenderer } from "./memory-webgl-renderer.js";

/** An isolated diagnostic fixture. Offscreen padding only enables the renderer's
 * large-graph mask branch; its fixed extent preserves the four visible nodes.
 * All topology, textures and picking data belong to this fixture, not the input. */
function opaqueOverlapFixture(source: MemoryRenderData, opaqueFirst: boolean, equalDepth: boolean, focused: boolean) {
  const template=source.nodes[0];
  if(!template)throw new Error("Overlap diagnostic requires one source node as a schema template");
  const count=10000,opaque=opaqueFirst?0:1,translucent=opaqueFirst?1:0;
  const nodes=Array.from({length:count},(_,i)=>({...template,id:`mask-fixture-${i}`,label:`Mask fixture ${i}`}));
  const coordinates=new Float32Array(Math.ceil(count/256)*256*4),styles=new Float32Array(count*4);
  for(let i=0;i<count;i++){
    coordinates.set([100000+i,100000,0,1],i*4);
    styles.set([0.4,0.4,0.4,1],i*4);
  }
  coordinates.set([0,0,0,1],opaque*4);styles.set([0.15,0.65,0.9,8],opaque*4);
  coordinates.set([0,0,equalDepth?0:-10,1],translucent*4);styles.set([0.95,0.3,0.15,8],translucent*4);
  coordinates.set([-28,0,15,1],2*4);coordinates.set([28,0,15,1],3*4);
  styles.set([0.8,0.8,0.2,2.1],2*4);styles.set([0.8,0.8,0.2,2.1],3*4);
  // Node4 is an offscreen focus target. Only the opaque node is its neighbor;
  // the closer overlapping node therefore uses the actual 0.2 focus fade.
  const pairs=focused?[[2,3],[4,opaque]]:[[2,3]];
  const edgePairs=new Uint32Array(pairs.length*2),edgeKinds=new Float32Array(pairs.length);
  const edgeTexture=new Uint32Array(1024),edgeIndices=new Uint32Array(pairs.length*6);
  const neighborOffsets=new Uint32Array(count+1);
  pairs.forEach(([a,b],i)=>{
    edgePairs.set([a!,b!],i*2);edgeTexture.set([a!,b!,0,0],i*4);
    const vertex=i*4;edgeIndices.set([vertex,vertex+1,vertex+2,vertex+2,vertex+1,vertex+3],i*6);
    neighborOffsets[a!+1]!++;neighborOffsets[b!+1]!++;
  });
  for(let i=1;i<neighborOffsets.length;i++)neighborOffsets[i]!+=neighborOffsets[i-1]!;
  const cursor=neighborOffsets.slice(),neighbors=new Uint32Array(pairs.length*2);
  for(const [a,b] of pairs){neighbors[cursor[a!]!] = b!;cursor[a!]!++;neighbors[cursor[b!]!] = a!;cursor[b!]!++;}
  const fixture:MemoryRenderData={nodes,index:new Map(nodes.map((node,i)=>[node.id,i])),coordinates,styles,
    edgePairs,edgeKinds,edgeTexture,edgeIndices,neighborOffsets,neighbors,labelCandidates:[],extent:40,
    picking:createMemoryPickingIndex(coordinates,styles,count)};
  return {data:fixture,focus:focused?4:-1,opaqueIndex:opaque,translucentIndex:translucent,
    visibleNodeCount:4,offscreenPaddingAndFocusCount:count-4,
    edgeDescriptions:focused?["horizontal crossing edge 2-3","offscreen focus4 to opaque neighbor"]:["horizontal crossing edge 2-3"]};
}

/** Independent HEAD Canvas stroke reference. This owns a separate context and
 * never changes the data, mask state or readbacks of the comparisons below. */
async function compareOriginalCanvasStrokes(source: MemoryRenderData) {
  const canvas=document.createElement("canvas"),reference=document.createElement("canvas");
  const gl=canvas.getContext("webgl2",{alpha:true,antialias:false,depth:true,stencil:true,premultipliedAlpha:true});
  const context=reference.getContext("2d",{willReadFrequently:true});
  if(!gl||!context){gl?.getExtension("WEBGL_lose_context")?.loseContext();return {status:"unsupported",reason:"Canvas2D or WebGL2 unavailable"};}
  let renderer:MemoryWebGLRenderer|null=null;
  try{
    const template=source.nodes[0];
    if(!template)throw new Error("Original Canvas stroke diagnostic requires a node schema template");
    const cssWidth=320,cssHeight=200,extent=120,camera={yaw:0,pitch:0,zoom:1};
    const background=[9,17,27] as const;
    // Literal values copied from HEAD MemoryGraph3D, independent of GPU shader
    // helpers/constants. A focused unrelated node selects the original muted style.
    const styles=[
      {name:"regular",color:"#203343",lineWidthCss:0.55,derived:false,focus:-1},
      {name:"derived",color:"#385068",lineWidthCss:0.55,derived:true,focus:-1},
      {name:"muted by unrelated focus",color:"#14202b",lineWidthCss:0.55,derived:false,focus:2},
      {name:"incident to focus",color:"#98dafa",lineWidthCss:1.15,derived:false,focus:0}
    ] as const;
    // At yaw=pitch=0, z=0 and extent120, the renderer's scale is 2/3.
    // Reference CSS endpoints are literal, rather than shared projection helpers.
    const segments=[
      {name:"horizontal",worldA:[-120,0,0],worldB:[120,0,0],a:[80,100],b:[240,100]},
      {name:"diagonal",worldA:[-105,45,0],worldB:[105,-45,0],a:[90,70],b:[230,130]}
    ] as const;
    /** Fail this explicit pixel diagnostic at the named stage when WebGL reports an error; never turn a failed draw into empty passing evidence. */
    const assertNoError=(stage:string)=>{const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`Original Canvas stroke GL error ${error} at ${stage}`);};
    renderer=new MemoryWebGLRenderer(gl,false,true);
    assertNoError("construct");
    /** Build independent synthetic geometry and picking buffers for this pixel-reference case; no application memory data is mutated. */
    const fixture=(segment:typeof segments[number],derived:boolean):MemoryRenderData=>{
      // Third node is offscreen and disconnected: only a focus target. Nodes are
      // never drawn; this fixture does not exercise node/glow/depth-mask quality.
      const nodes=Array.from({length:3},(_,i)=>({...template,id:`stroke-fixture-${i}`,label:`Stroke fixture ${i}`}));
      const coordinates=new Float32Array(1024),nodeStyles=new Float32Array(12);
      coordinates.set([...segment.worldA,1],0);coordinates.set([...segment.worldB,1],4);coordinates.set([3000,3000,0,1],8);
      for(let i=0;i<3;i++)nodeStyles.set([0.4,0.4,0.4,2.1],i*4);
      const edgeTexture=new Uint32Array(1024);edgeTexture.set([0,1,Number(derived),0]);
      return {nodes,index:new Map(nodes.map((node,i)=>[node.id,i])),coordinates,styles:nodeStyles,
        edgePairs:new Uint32Array([0,1]),edgeKinds:new Float32Array([Number(derived)]),edgeTexture,
        edgeIndices:new Uint32Array([0,1,2,2,1,3]),neighborOffsets:new Uint32Array([0,1,2,2]),neighbors:new Uint32Array([1,0]),
        labelCandidates:[],extent,picking:createMemoryPickingIndex(coordinates,nodeStyles,3)};
    };
    /** Convert readback orientation and alpha representation, then measure stroke coverage over the fixed background; preserve both raw alpha and opaque composite pixels. */
    const compositeAndMeasure=(bytes:Uint8Array|Uint8ClampedArray,width:number,height:number,ratio:number,premultiplied:boolean,bottomUp:boolean,lengthCss:number)=>{
      const opaque=new Float32Array(bytes.length),alpha=new Float32Array(width*height);
      let nonTransparentPixels=0,coverage=0;
      const premultipliedRgb=[0,0,0],aboveBackgroundRgb=[0,0,0];
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const pixel=y*width+x,sourcePixel=((bottomUp?height-1-y:y)*width+x)*4,opacity=bytes[sourcePixel+3]!/255;
        alpha[pixel]=opacity;coverage+=opacity;if(opacity>0)nonTransparentPixels++;
        for(let channel=0;channel<3;channel++){
          const premultipliedByte=bytes[sourcePixel+channel]!*(premultiplied?1:opacity);
          const value=premultipliedByte+background[channel]!*(1-opacity);
          opaque[pixel*4+channel]=value;premultipliedRgb[channel]!+=premultipliedByte;
          aboveBackgroundRgb[channel]!+=value-background[channel]!;
        }
        opaque[pixel*4+3]=255;
      }
      const cssArea=ratio*ratio;
      return {opaque,alpha,metrics:{nonTransparentPixels,alphaCoverageCssPixels:coverage/cssArea,
        integratedCoverageWidthCss:coverage/cssArea/lengthCss,
        alphaWeightedStrokeColorRgb:coverage?premultipliedRgb.map(value=>value/coverage):null,
        integratedColorAboveBackgroundRgbCss:aboveBackgroundRgb.map(value=>value/cssArea)}};
    };
    /** Compare all corresponding capture pixels and preserve maximum/mean differences; no differing pixels are removed. */
    const difference=(left:ReturnType<typeof compositeAndMeasure>,right:ReturnType<typeof compositeAndMeasure>,segment:typeof segments[number],ratio:number)=>{
      let maximum=0,total=0,activeTotal=0,changedPixels=0,activePixels=0;
      const width=cssWidth*ratio,ax=segment.a[0]*ratio,ay=segment.a[1]*ratio;
      const dx=(segment.b[0]-segment.a[0])*ratio,dy=(segment.b[1]-segment.a[1])*ratio,length=Math.hypot(dx,dy);
      /** Locate a physical pixel center relative to the reference geometry so body and boundary differences can be reported separately. */
      const geometry=(pixel:number)=>{
        const x=pixel%width,y=Math.floor(pixel/width),px=x+0.5,py=y+0.5;
        const along=((px-ax)*dx+(py-ay)*dy)/length;
        return {pixel:[x,y],pixelCenterCss:[px/ratio,py/ratio],segmentParameterT:along/length,
          signedPerpendicularDistancePhysicalPx:(dx*(py-ay)-dy*(px-ax))/length,
          nearestNominalCapPlaneDistancePhysicalPx:Math.min(Math.abs(along),Math.abs(length-along)),
          nearestEndpointDistancePhysicalPx:Math.min(Math.hypot(px-ax,py-ay),Math.hypot(px-ax-dx,py-ay-dy)),
          region:along>2&&along<length-2?"body":"cap-band-or-beyond"};
      };
      /** Return raw reference/candidate values and geometric context for a selected diagnostic pixel; negative indices mean no sample. */
      const sample=(pixel:number)=>pixel<0?null:{...geometry(pixel),
        reference:{opaqueCompositeRgb:Array.from(left.opaque.subarray(pixel*4,pixel*4+3)),rawAlpha:left.alpha[pixel],rawAlphaByte:Math.round(left.alpha[pixel]!*255)},
        webgl:{opaqueCompositeRgb:Array.from(right.opaque.subarray(pixel*4,pixel*4+3)),rawAlpha:right.alpha[pixel],rawAlphaByte:Math.round(right.alpha[pixel]!*255)},
        rgbChannelDifferences:[0,1,2].map(channel=>Math.abs(left.opaque[pixel*4+channel]!-right.opaque[pixel*4+channel]!)),
        absoluteAlphaDifference:Math.abs(left.alpha[pixel]!-right.alpha[pixel]!)};
      /** Initialize independent counters for a diagnostic pixel region; it does not filter or change the underlying captures. */
      const makeRegion=()=>({activePixels:0,rgbTotal:0,maxRgb:0,referenceAlpha:0,webglAlpha:0,absoluteAlpha:0,maxAlpha:0,worstRgbPixel:-1,worstAlphaPixel:-1});
      const body=makeRegion(),caps=makeRegion();
      let worstRgbPixel=-1,worstAlphaPixel=-1,worstRgbCount=0,worstAlphaCount=0,maxAlpha=0;
      for(let pixel=0;pixel<left.alpha.length;pixel++){
        const active=left.alpha[pixel]!>0||right.alpha[pixel]!>0;
        const previousMaximum=maximum;
        let pixelMaximum=0,pixelTotal=0;
        for(let channel=0;channel<3;channel++){
          const delta=Math.abs(left.opaque[pixel*4+channel]!-right.opaque[pixel*4+channel]!);
          pixelTotal+=delta;
          total+=delta;if(active)activeTotal+=delta;maximum=Math.max(maximum,delta);pixelMaximum=Math.max(pixelMaximum,delta);
        }
        if(pixelMaximum>previousMaximum){worstRgbPixel=pixel;worstRgbCount=1;}
        else if(pixelMaximum>0&&pixelMaximum===maximum)worstRgbCount++;
        const alphaDifference=Math.abs(left.alpha[pixel]!-right.alpha[pixel]!);
        if(alphaDifference>maxAlpha){maxAlpha=alphaDifference;worstAlphaPixel=pixel;worstAlphaCount=1;}
        else if(alphaDifference>0&&alphaDifference===maxAlpha)worstAlphaCount++;
        if(pixelMaximum>1e-4)changedPixels++;if(active)activePixels++;
        if(active){
          const region=geometry(pixel).region==="body"?body:caps;
          region.activePixels++;region.rgbTotal+=pixelTotal;
          region.referenceAlpha+=left.alpha[pixel]!;region.webglAlpha+=right.alpha[pixel]!;region.absoluteAlpha+=alphaDifference;
          if(pixelMaximum>region.maxRgb){region.maxRgb=pixelMaximum;region.worstRgbPixel=pixel;}
          if(alphaDifference>region.maxAlpha){region.maxAlpha=alphaDifference;region.worstAlphaPixel=pixel;}
        }
      }
      /** Normalize region counters and retain the worst raw pixels so alpha and color differences remain independently inspectable. */
      const summarizeRegion=(region:ReturnType<typeof makeRegion>)=>({activeStrokeRegionPixels:region.activePixels,
        maxRgbChannelDifference:region.maxRgb,meanAbsoluteRgbDifference:region.activePixels?region.rgbTotal/(region.activePixels*3):0,
        maxAlphaDifference:region.maxAlpha,maxAlphaDifferenceByte:region.maxAlpha*255,
        meanAbsoluteAlphaDifference:region.activePixels?region.absoluteAlpha/region.activePixels:0,
        referenceAlphaCoverageCssPixels:region.referenceAlpha/(ratio*ratio),webglAlphaCoverageCssPixels:region.webglAlpha/(ratio*ratio),
        signedAlphaCoverageDifferenceCssPixels:(region.webglAlpha-region.referenceAlpha)/(ratio*ratio),
        integratedAbsoluteAlphaDifferenceCssPixels:region.absoluteAlpha/(ratio*ratio),
        worstRgbPixel:sample(region.worstRgbPixel),worstAlphaPixel:sample(region.worstAlphaPixel)});
      return {maxRgbChannelDifference:maximum,meanAbsoluteRgbDifference:total/(left.alpha.length*3),changedPixels,
        activeStrokeRegionPixels:activePixels,activeStrokeRegionMeanAbsoluteRgbDifference:activePixels?activeTotal/(activePixels*3):0,
        worstRgbPixel:sample(worstRgbPixel),worstRgbPixelCount:worstRgbCount,
        maxAlphaDifference:maxAlpha,maxAlphaDifferenceByte:maxAlpha*255,worstAlphaPixel:sample(worstAlphaPixel),worstAlphaPixelCount:worstAlphaCount,
        body:summarizeRegion(body),capBandsAndBeyond:summarizeRegion(caps)};
    };
    const results=[];
    for(const ratio of [1,2])for(const segment of segments)for(const style of styles){
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      const width=cssWidth*ratio,height=cssHeight*ratio;
      reference.width=width;reference.height=height;
      context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,cssWidth,cssHeight);
      context.globalAlpha=1;context.globalCompositeOperation="source-over";
      context.strokeStyle=style.color;context.lineWidth=style.lineWidthCss;context.lineCap="butt";
      context.beginPath();context.moveTo(segment.a[0],segment.a[1]);context.lineTo(segment.b[0],segment.b[1]);context.stroke();
      const referenceBytes=context.getImageData(0,0,width,height).data;
      renderer.resize(cssWidth,cssHeight,ratio);renderer.setData(fixture(segment,style.derived));renderer.setFocus(style.focus);
      renderer.render(camera,{edges:true,nodes:false},assertNoError);assertNoError("edge-only draw");
      const gpuBytes=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,gpuBytes);assertNoError("edge-only readback");
      const lengthCss=Math.hypot(segment.b[0]-segment.a[0],segment.b[1]-segment.a[1]);
      const canvasResult=compositeAndMeasure(referenceBytes,width,height,ratio,false,false,lengthCss);
      const webglResult=compositeAndMeasure(gpuBytes,width,height,ratio,true,true,lengthCss);
      if(!canvasResult.metrics.nonTransparentPixels||!webglResult.metrics.nonTransparentPixels)throw new Error(`Empty original Canvas stroke scene: ${style.name}, ${segment.name}, DPR${ratio}`);
      results.push({style:style.name,segment:segment.name,devicePixelRatio:ratio,drawingBuffer:[width,height],
        expectedOriginalCanvas:{color:style.color,lineWidthCss:style.lineWidthCss,globalAlpha:1,lineCap:"butt",endpointsCss:[segment.a,segment.b],lengthCss},
        focus:style.focus,reference:canvasResult.metrics,webgl:webglResult.metrics,
        integratedCoverageWidthDifferenceCss:webglResult.metrics.integratedCoverageWidthCss-canvasResult.metrics.integratedCoverageWidthCss,
        imageDifference:difference(canvasResult,webglResult,segment,ratio)});
    }
    return {status:"complete",scope:"Isolated edge-only diagnostic: one edge, two endpoint nodes plus one disconnected offscreen focus target. Actual MemoryWebGLRenderer draws edges:true,nodes:false; no node, label, glow or opaque-mask equivalence is tested.",
      originalReference:"HEAD MemoryGraph3D.tsx strokes: literal #203343/#385068/#14202b/#98dafa; 0.55 CSS px or 1.15 CSS px for incident focus; alpha 1; Canvas2D source-over, butt caps.",
      cssViewport:[cssWidth,cssHeight],edgeStrategy:renderer.edgeStrategy,contextPremultipliedAlpha:gl.getContextAttributes()?.premultipliedAlpha,
      comparison:"Canvas2D getImageData straight-alpha RGB is multiplied by its alpha. WebGL readPixels RGB is treated as premultiplied after source-over blending. Both are composited in byte RGB onto the same opaque #09111b, with WebGL rows flipped to top-down. Alpha coverage and weighted stroke color are reported independently, so wrong alpha/color cannot be hidden by a shared reference helper.",
      measurements:"Coverage is the alpha sum divided by DPR squared. Integrated coverage width is that CSS-pixel area divided by segment CSS length; it measures average stroke energy, not a binary pixel bounding box. Color integrals and RGB errors use 0–255 byte-channel units. Full-image and active-stroke-region mean errors are both reported.",
      errorLocalization:"Pixel indices are top-down physical pixels; geometry is evaluated at pixel centers. Segment t is unclamped: 0/1 are the literal Canvas endpoints. Signed perpendicular distance and cap-plane/endpoint distances are physical pixels. Body means the axial projection lies more than 2 physical pixels inward from both nominal butt-cap planes; remaining active stroke pixels are cap bands or beyond the nominal endpoints. Regional errors/coverage use only the union of pixels with nonzero Canvas or GL alpha. RGB values/errors use 0–255 units after opaque compositing, raw alpha and alpha error use 0–1, and alphaByte uses 0–255. Null worst pixels mean zero error; counts report exact ties for the global maximum. Neither worst-pixel location nor region membership is a quality verdict.",
      results,limitation:"Canvas and analytic GPU rasterizers may differ at caps, diagonals and subpixel coverage. Same style/coverage intent does not require bit-identical pixels. This report makes no automatic visual-quality pass and is not a frame, picking, load or presentation benchmark. It does not prove complete original Canvas graph equivalence."};
  }catch(error){return {status:"error",reason:error instanceof Error?error.message:String(error)};}
  finally{renderer?.dispose();gl.getExtension("WEBGL_lose_context")?.loseContext();}
}

/** Literal original circles and CPU depth sorting are reference-only. Production
 * rendering/picking/layout and the existing comparisons are not changed. */
async function compareOriginalCanvasNodes(source:MemoryRenderData){
  const canvas=document.createElement("canvas"),reference=document.createElement("canvas");
  const gl=canvas.getContext("webgl2",{alpha:true,antialias:false,depth:true,stencil:true,premultipliedAlpha:true});
  // Keep repeated reference readbacks on an explicitly readback-optimized
  // context; an unspecified policy may change Canvas raster backends mid-test.
  const context=reference.getContext("2d",{willReadFrequently:true});
  if(!gl||!context){gl?.getExtension("WEBGL_lose_context")?.loseContext();return {status:"unsupported",reason:"Canvas2D or WebGL2 unavailable"};}
  let renderer:MemoryWebGLRenderer|null=null;
  try{
    const template=source.nodes[0];if(!template)throw new Error("Original Canvas node diagnostic requires a node schema template");
    const cssWidth=320,cssHeight=200,extent=60,camera={yaw:0,pitch:0,zoom:2},background=[9,17,27] as const;
    // Non-core, unfocused SOURCE nodes: exact original base radius4.6 and no glow.
    // The far body lies behind the right AA boundary of the opaque near node.
    const descriptors=[
      {id:"near",label:"Near source",x:0,y:0,z:-15,color:"#72c0b1",rgb:[114/255,192/255,177/255]},
      {id:"far",label:"Far source",x:2,y:0,z:15,color:"#79a7df",rgb:[121/255,167/255,223/255]}
    ] as const;
    // Original HEAD projection/radius/alpha formulas, without renderer helpers.
    const projected=descriptors.map(node=>{
      const scale=Math.min(cssWidth,cssHeight)*0.4/extent;
      const x=node.x*Math.cos(camera.yaw)+node.z*Math.sin(camera.yaw),depth=-node.x*Math.sin(camera.yaw)+node.z*Math.cos(camera.yaw);
      const y=node.y*Math.cos(camera.pitch)-depth*Math.sin(camera.pitch),z=node.y*Math.sin(camera.pitch)+depth*Math.cos(camera.pitch);
      const perspective=650/Math.max(120,650+z*scale);
      return {...node,screenX:cssWidth/2+x*scale*camera.zoom*perspective,screenY:cssHeight/2-y*scale*camera.zoom*perspective,depth:z,
        perspective,radius:Math.max(1,4.6*perspective*Math.sqrt(camera.zoom)),alpha:Math.max(0.4,Math.min(1,perspective))};
    });
    const near=projected[0]!,far=projected[1]!;
    /** Build independent synthetic geometry and picking buffers for this pixel-reference case; no application memory data is mutated. */
    const fixture=(nearFirst:boolean):MemoryRenderData=>{
      const ordered=nearFirst?[descriptors[0],descriptors[1]]:[descriptors[1],descriptors[0]];
      const nodes=ordered.map(node=>({...template,id:`node-reference-${node.id}`,label:node.label,type:"SOURCE" as const}));
      const coordinates=new Float32Array(1024),styles=new Float32Array(8);
      ordered.forEach((node,i)=>{coordinates.set([node.x,node.y,node.z,1],i*4);styles.set([...node.rgb,4.6],i*4);});
      return {nodes,index:new Map(nodes.map((node,i)=>[node.id,i])),coordinates,styles,
        edgePairs:new Uint32Array(0),edgeKinds:new Float32Array(0),edgeTexture:new Uint32Array(1024),edgeIndices:new Uint32Array(0),
        neighborOffsets:new Uint32Array(3),neighbors:new Uint32Array(0),labelCandidates:[],extent,picking:createMemoryPickingIndex(coordinates,styles,2)};
    };
    /** Fail this explicit pixel diagnostic at the named stage when WebGL reports an error; never turn a failed draw into empty passing evidence. */
    const assertNoError=(stage:string)=>{const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`Original Canvas node GL error ${error} at ${stage}`);};
    renderer=new MemoryWebGLRenderer(gl);assertNoError("construct");
    /** Composite the native readback over the fixed background with explicit premultiplication and row-order handling. */
    const compose=(bytes:Uint8Array|Uint8ClampedArray,width:number,height:number,premultiplied:boolean,bottomUp:boolean)=>{
      const opaque=new Float32Array(bytes.length),alpha=new Float32Array(width*height);let nonTransparentPixels=0,coverage=0;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const pixel=y*width+x,index=((bottomUp?height-1-y:y)*width+x)*4,a=bytes[index+3]!/255;
        alpha[pixel]=a;coverage+=a;if(a>0)nonTransparentPixels++;
        for(let c=0;c<3;c++)opaque[pixel*4+c]=bytes[index+c]!*(premultiplied?1:a)+background[c]!*(1-a);
        opaque[pixel*4+3]=255;
      }
      return {opaque,alpha,nonTransparentPixels,alphaCoveragePhysicalPixels:coverage};
    };
    type NodeImage=ReturnType<typeof compose>;
    /** Measure node-image differences across active bodies and nominal boundary rings; keep worst pixels and alpha deficits for each region. */
    const compare=(left:NodeImage,right:NodeImage,ratio:number)=>{
      const width=cssWidth*ratio;
      /** Locate a physical pixel center relative to the reference geometry so body and boundary differences can be reported separately. */
      const geometry=(pixel:number)=>{
        const x=pixel%width,y=Math.floor(pixel/width),cx=(x+0.5)/ratio,cy=(y+0.5)/ratio;
        const nearDistance=(Math.hypot(cx-near.screenX,cy-near.screenY)-near.radius)*ratio;
        const farDistance=(Math.hypot(cx-far.screenX,cy-far.screenY)-far.radius)*ratio;
        return {pixel:[x,y],pixelCenterCss:[cx,cy],nearBoundarySignedDistancePhysicalPx:nearDistance,farBoundarySignedDistancePhysicalPx:farDistance};
      };
      /** Return raw reference/candidate values and geometric context for a selected diagnostic pixel; negative indices mean no sample. */
      const sample=(pixel:number)=>pixel<0?null:{...geometry(pixel),
        reference:{opaqueCompositeRgb:Array.from(left.opaque.subarray(pixel*4,pixel*4+3)),rawAlpha:left.alpha[pixel],rawAlphaByte:Math.round(left.alpha[pixel]!*255)},
        candidate:{opaqueCompositeRgb:Array.from(right.opaque.subarray(pixel*4,pixel*4+3)),rawAlpha:right.alpha[pixel],rawAlphaByte:Math.round(right.alpha[pixel]!*255)}};
      /** Initialize independent counters for a diagnostic pixel region; it does not filter or change the underlying captures. */
      const makeRegion=()=>({pixels:0,rgbTotal:0,maxRgb:0,maxAlpha:0,referenceAlpha:0,candidateAlpha:0,alphaDeficit:0,closerToBackgroundPixels:0,worstRgbPixel:-1,worstAlphaPixel:-1});
      const all=makeRegion(),ring=makeRegion(),body=makeRegion(),ringOverFarBody=makeRegion();
      for(let pixel=0;pixel<left.alpha.length;pixel++){
        if(left.alpha[pixel]===0&&right.alpha[pixel]===0)continue;
        const point=geometry(pixel);let rgbTotal=0,maxRgb=0,leftBackgroundDistance=0,rightBackgroundDistance=0;
        for(let c=0;c<3;c++){
          const delta=Math.abs(left.opaque[pixel*4+c]!-right.opaque[pixel*4+c]!);rgbTotal+=delta;maxRgb=Math.max(maxRgb,delta);
          leftBackgroundDistance+=(left.opaque[pixel*4+c]!-background[c]!)**2;rightBackgroundDistance+=(right.opaque[pixel*4+c]!-background[c]!)**2;
        }
        const alphaDifference=Math.abs(left.alpha[pixel]!-right.alpha[pixel]!);
        const regions=[all];
        if(Math.abs(point.nearBoundarySignedDistancePhysicalPx)<=2){regions.push(ring);if(point.farBoundarySignedDistancePhysicalPx<-2)regions.push(ringOverFarBody);}
        if(point.nearBoundarySignedDistancePhysicalPx<-2)regions.push(body);
        for(const region of regions){
          region.pixels++;region.rgbTotal+=rgbTotal;region.referenceAlpha+=left.alpha[pixel]!;region.candidateAlpha+=right.alpha[pixel]!;
          region.alphaDeficit+=Math.max(0,left.alpha[pixel]!-right.alpha[pixel]!);
          if(Math.sqrt(rightBackgroundDistance)+1<Math.sqrt(leftBackgroundDistance))region.closerToBackgroundPixels++;
          if(maxRgb>region.maxRgb){region.maxRgb=maxRgb;region.worstRgbPixel=pixel;}
          if(alphaDifference>region.maxAlpha){region.maxAlpha=alphaDifference;region.worstAlphaPixel=pixel;}
        }
      }
      /** Normalize the accumulated node-image region counters and retain the worst reference/candidate pixels. */
      const summarize=(region:ReturnType<typeof makeRegion>)=>({activeRegionPixels:region.pixels,
        maxRgbChannelDifference:region.maxRgb,activeRegionMeanAbsoluteRgbDifference:region.pixels?region.rgbTotal/(region.pixels*3):0,
        maxAlphaDifference:region.maxAlpha,referenceAlphaCoverageCssPixels:region.referenceAlpha/(ratio*ratio),candidateAlphaCoverageCssPixels:region.candidateAlpha/(ratio*ratio),
        positiveReferenceMinusCandidateAlphaCoverageCssPixels:region.alphaDeficit/(ratio*ratio),candidateCloserToBackgroundPixels:region.closerToBackgroundPixels,
        worstRgbPixel:sample(region.worstRgbPixel),worstAlphaPixel:sample(region.worstAlphaPixel)});
      return {allActivePixels:summarize(all),nearNominalBoundaryRing:summarize(ring),nearNominalBody:summarize(body),nearRingOverFarNominalBody:summarize(ringOverFarBody)};
    };
    const results=[],orderComparisons=[];
    for(const ratio of [1,2]){
      const width=cssWidth*ratio,height=cssHeight*ratio;
      let first:{canvas:NodeImage;webgl:NodeImage}|null=null;
      for(const nearFirst of [true,false]){
        await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
        /** Draw the literal original Canvas node reference back-to-front at the requested DPR, returning raw pixels and actual draw order. */
        const captureOriginal=()=>{
          reference.width=width;reference.height=height;context.setTransform(ratio,0,0,ratio,0,0);
          context.clearRect(0,0,cssWidth,cssHeight);context.globalCompositeOperation="source-over";
          // Original Canvas sorts back-to-front even when input order is reversed.
          const ordered=nearFirst?[...projected]:[...projected].reverse();ordered.sort((a,b)=>b.depth-a.depth);
          for(const node of ordered){
            context.globalAlpha=node.alpha;context.fillStyle=node.color;context.shadowBlur=0;
            context.beginPath();context.arc(node.screenX,node.screenY,node.radius,0,Math.PI*2);context.fill();
          }
          context.globalAlpha=1;
          return {image:compose(context.getImageData(0,0,width,height).data,width,height,false,false),drawOrder:ordered.map(node=>node.id)};
        };
        const original=captureOriginal(),canvasImage=original.image;
        renderer.resize(cssWidth,cssHeight,ratio);renderer.setData(fixture(nearFirst));renderer.setFocus(-1);
        renderer.render(camera,{edges:false,nodes:true},assertNoError);assertNoError("node-only draw");
        const bytes=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);assertNoError("node-only readback");
        const webglImage=compose(bytes,width,height,true,true);
        const referenceRepeat=captureOriginal();
        if(!canvasImage.nonTransparentPixels||!webglImage.nonTransparentPixels)throw new Error(`Empty original Canvas node scene: DPR${ratio}, nearFirst=${nearFirst}`);
        results.push({devicePixelRatio:ratio,drawingBuffer:[width,height],inputOrder:nearFirst?["near","far"]:["far","near"],canvasDrawOrder:original.drawOrder,
          reference:{nonTransparentPixels:canvasImage.nonTransparentPixels,alphaCoverageCssPixels:canvasImage.alphaCoveragePhysicalPixels/(ratio*ratio)},
          webgl:{nonTransparentPixels:webglImage.nonTransparentPixels,alphaCoverageCssPixels:webglImage.alphaCoveragePhysicalPixels/(ratio*ratio)},imageDifference:compare(canvasImage,webglImage,ratio),
          referenceRepeatControl:{scope:"Same literal Canvas commands redrawn and read after the WebGL capture; reference/candidate mean first/repeated Canvas capture. Not a renderer comparison.",
            repeatedDrawOrder:referenceRepeat.drawOrder,imageDifference:compare(canvasImage,referenceRepeat.image,ratio)}});
        if(!first)first={canvas:canvasImage,webgl:webglImage};
        else orderComparisons.push({devicePixelRatio:ratio,scope:"Same scene with input order reversed. In these records reference/candidate mean near-first/far-first captures, respectively.",
          canvasInputOrderDifference:compare(first.canvas,canvasImage,ratio),webglInputOrderDifference:compare(first.webgl,webglImage,ratio)});
      }
    }
    return {status:"complete",scope:"Independent node-only original Canvas reference: two overlapping non-core, unfocused SOURCE circles, both input orders at DPR1 and DPR2. Actual MemoryWebGLRenderer draws nodes:true,edges:false. No labels, edges or stencil-mask quality is tested.",
      originalReference:"Literal HEAD Canvas projection, SOURCE radius 4.6 times perspective and sqrt(zoom), perspective alpha clamped 0.4–1, positions colors #72c0b1/#79a7df, circles sorted far-to-near, source-over. Both labels are non-core and no node is focused, so original shadowBlur is 0.",
      referenceReadbackPolicy:{requestedWillReadFrequently:true,reportedContextAttributes:context.getContextAttributes(),
        scope:"Readback-optimized Canvas2D reference. This fixes a previously unspecified diagnostic context policy; it does not establish the same raster backend as the production original Canvas. Prior reports remain separate evidence."},
      cssViewport:[cssWidth,cssHeight],camera,extent,projectedNodes:projected,results,orderComparisons,
      comparison:"Canvas straight-alpha and GL premultiplied-alpha readbacks are composited onto the same opaque #09111b. GL rows are flipped top-down. No renderer style, circle coverage or depth helper is reused by the Canvas reference.",
      regions:"Ring is within 2 physical pixels of the near circle's nominal boundary; body is more than 2 physical pixels inside it. Ring-over-far-body additionally lies more than 2 physical pixels inside the far circle. Only pixels with nonzero alpha in either capture contribute. Regions can overlap; they are reported separately.",
      units:"Pixel indices are physical, top-down, and distances use pixel centers. Negative boundary distance means inside the nominal circle. RGB/error units are 0–255, raw alpha/error 0–1, alpha coverage is CSS-pixel area. candidateCloserToBackgroundPixels counts an RGB-distance deficit greater than 1 byte-unit; it is an observation, not proof of a particular cause or a quality pass.",
      limitation:"This targets missing far-body color near AA fringes and input-order dependence. Inspect every referenceRepeatControl and the Canvas input-order control before attributing differences to the candidate; nonzero controls mean the reference is unstable. Original Canvas and analytic GPU circle rasterization may differ at subpixel boundaries. Original shadowBlur 13 versus GPU exponential glow remains an approximation and is deliberately absent from this no-glow fixture. No automatic quality pass, full-graph equivalence or performance claim is made."};
  }catch(error){return {status:"error",reason:error instanceof Error?error.message:String(error)};}
  finally{renderer?.dispose();gl.getExtension("WEBGL_lose_context")?.loseContext();}
}

/** Explicit synthetic diagnostic, never used during input, layout or frame timing. */
export async function compareMemoryEdgeProjection(data: MemoryRenderData) {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { alpha:true,antialias:false,depth:true,stencil:true });
  if (!gl) return { status:"unsupported",reason:"WebGL2 unavailable" };
  let baseline: MemoryWebGLRenderer | null = null, projected: MemoryWebGLRenderer | null = null, screenOnly:MemoryWebGLRenderer|null=null;
  try {
    /** Fail this explicit pixel diagnostic at the named stage when WebGL reports an error; never turn a failed draw into empty passing evidence. */
    const assertNoError=(stage:string)=>{const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`Pixel diagnostic GL error ${error} at ${stage}`);};
    baseline = new MemoryWebGLRenderer(gl); projected = new MemoryWebGLRenderer(gl,false,true);
    screenOnly=new MemoryWebGLRenderer(gl,false,true,false);
    assertNoError("construct");baseline.setData(data);assertNoError("baseline data");projected.setData(data);assertNoError("projected data");screenOnly.setData(data);assertNoError("screen-only data");
    if (projected.edgeStrategy !== "projected") return { status:"unsupported",reason:"Screen-space AA unavailable" };
    const width=640,height=400;
    baseline.resize(width,height,1); projected.resize(width,height,1);screenOnly.resize(width,height,1);
    const a=new Uint8Array(width*height*4),b=new Uint8Array(a.length),control=new Uint8Array(a.length),screen=new Uint8Array(a.length);
    const core=data.nodes.findIndex(node=>isMemoryCoreLabel(node.label));
    const cases=[
      {camera:{...DEFAULT_MEMORY_CAMERA},focus:-1},
      {camera:{yaw:1.1,pitch:-.65,zoom:1.6},focus:core},
      {camera:{yaw:-.9,pitch:.5,zoom:2.4},focus:Math.min(25,data.nodes.length-1)},
      {camera:{yaw:2,pitch:1.15,zoom:5},focus:core}
    ];
    /** Draw one explicit diagnostic camera/focus case and synchronously read its pixels. This readback is outside load/frame acceptance measurements. */
    const capture=(renderer:MemoryWebGLRenderer,camera:typeof DEFAULT_MEMORY_CAMERA,focus:number,bytes:Uint8Array)=>{
      renderer.setFocus(focus);assertNoError(`${renderer.edgeStrategy} focus`);renderer.render(camera,undefined,assertNoError);assertNoError(`${renderer.edgeStrategy} render`);
      gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
      assertNoError(`${renderer.edgeStrategy} readback`);
    };
    /** Compare all corresponding capture pixels and preserve maximum/mean differences; no differing pixels are removed. */
    const difference=(left:Uint8Array,right:Uint8Array)=>{
      let changedPixels=0,pixelsOverOneByte=0,maxChannelDifference=0,total=0,nonTransparentPixels=0;
      for(let i=0;i<left.length;i+=4){
        let maximum=0;
        for(let c=0;c<4;c++){const delta=Math.abs(left[i+c]!-right[i+c]!);maximum=Math.max(maximum,delta);total+=delta;}
        if(maximum)changedPixels++;if(maximum>1)pixelsOverOneByte++;
        maxChannelDifference=Math.max(maxChannelDifference,maximum);
        if(left[i+3])nonTransparentPixels++;
      }
      return {changedPixels,pixelsOverOneByte,maxChannelDifference,meanAbsoluteChannelDifference:total/left.length,nonTransparentPixels};
    };
    const results=[];
    const realDataOpaqueNodeMask=projected.edgeOcclusionEnabled;
    for(const item of cases){
      // Yield between explicit readbacks; this is not a load or frame benchmark.
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      capture(baseline,item.camera,item.focus,a);capture(projected,item.camera,item.focus,b);
      capture(screenOnly,item.camera,item.focus,screen);
      capture(baseline,item.camera,item.focus,control);
      const imageDifference=difference(a,b),repeatControl=difference(a,control);
      if(!imageDifference.nonTransparentPixels)throw new Error("Empty baseline is not valid pixel evidence");
      results.push({...item,imageDifference,maskOnlyDifference:difference(screen,b),repeatControl});
    }
    const controlledCases=[
      {name:"near faded first, far opaque second",opaqueFirst:false,equalDepth:false,focused:true},
      {name:"far opaque first, near faded second",opaqueFirst:true,equalDepth:false,focused:true},
      {name:"equal depth: faded first, opaque second",opaqueFirst:false,equalDepth:true,focused:true},
      {name:"equal depth: opaque first, faded second",opaqueFirst:true,equalDepth:true,focused:true},
      {name:"fully opaque nearest-node control",opaqueFirst:false,equalDepth:false,focused:false}
    ];
    const controlledResults=[];
    const camera={yaw:0,pitch:0,zoom:1};
    // The same640x400 readback now represents320x200 CSS pixels at Retina DPR2.
    baseline.resize(width/2,height/2,2);projected.resize(width/2,height/2,2);screenOnly.resize(width/2,height/2,2);
    /** Return one unmodified RGBA pixel at physical readback coordinates for the diagnostic report. */
    const pixelAt=(bytes:Uint8Array,x:number,y:number)=>Array.from(bytes.subarray((y*width+x)*4,(y*width+x)*4+4));
    for(const item of controlledCases){
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      const fixture=opaqueOverlapFixture(data,item.opaqueFirst,item.equalDepth,item.focused);
      baseline.setData(fixture.data);projected.setData(fixture.data);screenOnly.setData(fixture.data);
      assertNoError(`controlled fixture ${item.name} upload`);
      capture(baseline,camera,fixture.focus,a);capture(projected,camera,fixture.focus,b);
      capture(screenOnly,camera,fixture.focus,screen);capture(baseline,camera,fixture.focus,control);
      const imageDifference=difference(a,b);
      if(!imageDifference.nonTransparentPixels)throw new Error(`Empty controlled baseline: ${item.name}`);
      controlledResults.push({...item,camera,focus:fixture.focus,nodes:fixture.data.nodes.length,edges:fixture.data.edgeKinds.length,
        opaqueIndex:fixture.opaqueIndex,translucentIndex:fixture.translucentIndex,
        visibleNodeCount:fixture.visibleNodeCount,offscreenPaddingAndFocusCount:fixture.offscreenPaddingAndFocusCount,
        edgeDescriptions:fixture.edgeDescriptions,candidateOpaqueNodeMask:projected.edgeOcclusionEnabled,
        imageDifference,maskOnlyDifference:difference(screen,b),repeatControl:difference(a,control),
        samplePixels:{overlapCenter:{ordinary:pixelAt(a,width/2,height/2),screenOnly:pixelAt(screen,width/2,height/2),masked:pixelAt(b,width/2,height/2)},
          crossingEdgeOutsideNodes:{ordinary:pixelAt(a,width/2+40,height/2),screenOnly:pixelAt(screen,width/2+40,height/2),masked:pixelAt(b,width/2+40,height/2)}}});
    }
    const originalCanvasStrokeReference=await compareOriginalCanvasStrokes(data);
    const originalCanvasNodeReference=await compareOriginalCanvasNodes(data);
    const debug=gl.getExtension("WEBGL_debug_renderer_info");
    return {status:"complete",nodes:data.nodes.length,edges:data.edgeKinds.length,drawingBuffer:[width,height],
      candidateOpaqueNodeMask:realDataOpaqueNodeMask,contextStencil:gl.getContextAttributes()?.stencil,
      gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
      method:"Same real renderer/data/AA: ordinary clip-space versus screen-space with opaque-nearest-node mask. Also compare mask on/off to isolate new culling from screen-space rounding. Four camera/focus cases include maximum zoom/clipping; baseline repeat controls detect state leakage.",
      results,originalCanvasStrokeReference,originalCanvasNodeReference,controlledOverlap:{scope:"Separate synthetic overlap fixture, not the original real-data graph. Four visible nodes and offscreen padding reach10000 nodes solely to exercise the mask branch. Valid crossing/focus-neighbor edges and CSR adjacency; no production data is changed.",
        cssViewport:[width/2,height/2],devicePixelRatio:2,drawingBuffer:[width,height],
        purpose:"Test near translucent/far opaque overlap in both draw orders, equal-depth LEQUAL ties in both orders, and fully opaque control. Mask-on/off differences isolate stencil behavior from pre-existing screen-space AA rounding.",results:controlledResults},
      limitation:"Explicit one-shot offscreen pixel readbacks, no labels. These are not frame-time, input-latency, main-thread-load or presentation measurements; no automatic quality pass is claimed."};
  }catch(error){return {status:"error",reason:error instanceof Error?error.message:String(error)};}
  finally{baseline?.dispose();projected?.dispose();screenOnly?.dispose();gl.getExtension("WEBGL_lose_context")?.loseContext();}
}
