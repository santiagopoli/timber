import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measureAvatarFrame} from '../../apps/console/src/avatar-framing.ts';
const size=128;
function pixels({x,y,width,height}){
  const data=new Uint8ClampedArray(size*size*4);
  for(let row=y;row<y+height;row++)for(let column=x;column<x+width;column++)data[(row*size+column)*4+3]=255;
  return data;
}
test('transparent padding and off-center art do not change visible size or centering',()=>{
  const results=[{x:20,y:15,width:20,height:24},{x:35,y:23,width:60,height:72}].map(bounds=>{
    const frame=measureAvatarFrame(pixels(bounds),size,size);
    return {width:bounds.width*frame.width,height:bounds.height*frame.height,cx:frame.left*size+(bounds.x+bounds.width/2)*frame.width,cy:frame.top*size+(bounds.y+bounds.height/2)*frame.height};
  });
  for(const key of ['width','height','cx','cy'])assert.ok(Math.abs(results[0][key]-results[1][key])<.001,`${key} should be independent of image padding`);
  assert.equal(results[0].cx,64);assert.equal(results[0].cy,64);
});
test('optical normalization equalizes painted area across differently shaped heads',()=>{
  const bounds=[{x:25,y:35,width:75,height:55},{x:40,y:25,width:50,height:75}];
  const areas=bounds.map(b=>{const f=measureAvatarFrame(pixels(b),size,size);return b.width*b.height*f.width*f.height;});
  assert.ok(Math.abs(areas[0]-areas[1])<1);
});
test('long ears keep headroom and empty or faint images have a finite fallback',()=>{
  const b={x:49,y:4,width:30,height:120},frame=measureAvatarFrame(pixels(b),size,size);
  assert.ok(frame.height*b.height<=size*.9+.001);
  assert.ok(frame.top*size+b.y*frame.height>=0);
  for(const alpha of [0,1]){
    const data=new Uint8ClampedArray(size*size*4).fill(alpha),fallback=measureAvatarFrame(data,size,size);
    assert.deepEqual(fallback,{left:.07,top:.07,width:.86,height:.86});
  }
});
test('diagonal corners fit the circular boundary with an even safety margin',()=>{
  const bounds={x:10,y:20,width:100,height:90},data=pixels(bounds),frame=measureAvatarFrame(data,size,size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(data[(y*size+x)*4+3]){
    const dx=frame.left+(x+.5)/size*frame.width-.5,dy=frame.top+(y+.5)/size*frame.height-.5;
    assert.ok(Math.hypot(dx,dy)<=.440001,'no visible point should approach the circular edge');
  }
});
