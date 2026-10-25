import { describe, expect, it } from "vitest";
import { createMemoryPickingIndex, pickMemoryNode, refitMemoryPickingBounds } from "../src/features/memory-workspace/memory-picking-index.js";
import { projectMemoryPoint, type MemoryCamera3D } from "../src/features/memory-workspace/memory-3d.js";

function fixture(count: number) {
  const coordinates = new Float32Array(count * 4), styles = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    coordinates.set([Math.sin(i * 2.7) * 310, Math.cos(i * 3.1) * 230, Math.sin(i * 5.1) * 700, 1], i * 4);
    styles[i * 4 + 3] = i % 17 === 0 ? 10 : 2.1;
  }
  return { coordinates, styles, index:createMemoryPickingIndex(coordinates, styles, count) };
}
function oracle(coordinates: Float32Array, styles: Float32Array, camera: MemoryCamera3D, x: number, y: number, focus: number) {
  let chosen = -1, bestZ = Infinity;
  for (let i = 0; i < coordinates.length / 4; i++) {
    const screen = projectMemoryPoint({x:coordinates[i*4]!,y:coordinates[i*4+1]!,z:coordinates[i*4+2]!},camera,2,1000,700);
    const z = Math.max(-.99,Math.min(.99,screen.z * 2 / 1000));
    const radius = Math.max(7,Math.max(1,styles[i*4+3]! * screen.perspective * Math.sqrt(camera.zoom)) * (i === focus ? 1.5 : 1) + 3);
    if ((x-screen.x)**2+(y-screen.y)**2 <= radius**2 && z <= bestZ) {chosen=i;bestZ=z;}
  }
  return chosen;
}
describe("world-space memory picking BVH", () => {
  it("matches a linear reference across rotation, zoom, focus, overlap and near-depth clamping", () => {
    const {coordinates,styles,index}=fixture(513);
    for (const camera of [{yaw:.3,pitch:-.15,zoom:1},{yaw:2,pitch:1,zoom:5},{yaw:-2,pitch:-1,zoom:.35}]) {
      for (const focus of [-1,17]) for (let j=0;j<200;j++) {
        const x=(j*71)%1000,y=(j*137)%700;
        expect(pickMemoryNode(index,coordinates,styles,camera,140,1000,700,x,y,focus)).toBe(oracle(coordinates,styles,camera,x,y,focus));
      }
    }
  });
  it("refits streamed positions without changing topology or missing newly moved nodes", () => {
    const {coordinates,styles,index}=fixture(513), previous=index.bounds.slice();
    for(let i=0;i<513;i++) {coordinates[i*4]!+=500;coordinates[i*4+2]!-=900;}
    const moved={...index,bounds:refitMemoryPickingBounds(index,coordinates)};
    expect(index.bounds).toEqual(previous);
    const camera={yaw:.3,pitch:-.15,zoom:1};
    for(let j=0;j<200;j++) {const x=(j*71)%1000,y=(j*137)%700;expect(pickMemoryNode(moved,coordinates,styles,camera,140,1000,700,x,y)).toBe(oracle(coordinates,styles,camera,x,y,-1));}
  });
  it("prunes even 50k coincident nodes by depth and deterministic draw-order bounds", () => {
    const coordinates=new Float32Array(50000*4),styles=new Float32Array(50000*4);for(let i=0;i<50000;i++) styles[i*4+3]=2.1;
    const index=createMemoryPickingIndex(coordinates,styles,50000),stats={boxes:0,points:0};
    expect(pickMemoryNode(index,coordinates,styles,{yaw:0,pitch:0,zoom:1},60,1000,700,500,350,-1,stats)).toBe(49999);
    expect(stats.points).toBeLessThanOrEqual(8);
  });
  it("does not scan a 50k graph for an isolated point or off-canvas query", () => {
    const {coordinates,styles,index}=fixture(50000),stats={boxes:0,points:0};
    pickMemoryNode(index,coordinates,styles,{yaw:.3,pitch:-.15,zoom:1},140,1000,700,900,50,-1,stats);
    expect(stats.points).toBeLessThan(2000);
    expect(pickMemoryNode(index,coordinates,styles,{yaw:0,pitch:0,zoom:1},60,1000,700,-1,350)).toBe(-1);
    expect(pickMemoryNode(createMemoryPickingIndex(new Float32Array(),new Float32Array(),0),new Float32Array(),new Float32Array(),{yaw:0,pitch:0,zoom:1},60,1000,700,500,350)).toBe(-1);
  });
  it("agrees with the frontmost-hit oracle for dense 50k hit queries, without visiting all points", () => {
    const {coordinates,styles,index}=fixture(50000),camera={yaw:.3,pitch:-.15,zoom:1};
    let queries=0;
    for(let id=0;id<50000 && queries<12;id+=997) {
      const p=projectMemoryPoint({x:coordinates[id*4]!,y:coordinates[id*4+1]!,z:coordinates[id*4+2]!},camera,2,1000,700);
      if(p.x<0||p.x>=1000||p.y<0||p.y>=700) continue;
      const stats={boxes:0,points:0};
      expect(pickMemoryNode(index,coordinates,styles,camera,140,1000,700,p.x,p.y,-1,stats)).toBe(oracle(coordinates,styles,camera,p.x,p.y,-1));
      expect(stats.points).toBeLessThan(5000);
      queries++;
    }
    expect(queries).toBe(12);
  });
});
