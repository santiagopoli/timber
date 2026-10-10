export interface AvatarFrame {left:number;top:number;width:number;height:number}
interface Crop {x:number;y:number;width:number;height:number}
const SAMPLE_SIZE=256;
const DEFAULT_FRAME:AvatarFrame={left:.07,top:.07,width:.86,height:.86};

/** Match visible ink area, not the file's transparent padding. Fit the actual
 * silhouette to a circle, so diagonal ears get the same margin as the chin. */
export function measureAvatarFrame(pixels:Uint8ClampedArray,width:number,height:number):AvatarFrame {
  let left=width,top=height,right=-1,bottom=-1,area=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const alpha=pixels[(y*width+x)*4+3]/255;
    if(alpha<.15)continue;
    area+=alpha;
    if(alpha<.5)continue;
    left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
  }
  if(right<left||bottom<top||area<4)return DEFAULT_FRAME;
  const centerX=(left+right+1)/(2*width),centerY=(top+bottom+1)/(2*height);
  let radius=0;
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++)if(pixels[(y*width+x)*4+3]>=128){
    radius=Math.max(radius,Math.hypot((x+.5)/width-centerX,(y+.5)/height-centerY));
  }
  const scale=Math.min(Math.sqrt(.34*width*height/area),.44/Math.max(radius,1/width));
  return {left:.5-centerX*scale,top:.5-centerY*scale,width:scale,height:scale};
}

function canvas(size:number){const element=document.createElement('canvas');element.width=element.height=size;return element;}
function drawContained(context:CanvasRenderingContext2D,image:HTMLImageElement,size:number,crop?:Crop,frame:AvatarFrame={left:0,top:0,width:1,height:1}){
  const source=crop??{x:0,y:0,width:image.naturalWidth,height:image.naturalHeight};
  const fit=Math.min(1/source.width,1/source.height);
  const w=source.width*fit*size*frame.width,h=source.height*fit*size*frame.height;
  const x=frame.left*size+(frame.width*size-w)/2,y=frame.top*size+(frame.height*size-h)/2;
  // The source-rectangle overload interprets dimensionless SVG source sizes
  // differently in Chromium. Draw the complete vector with the 5-argument form.
  if(crop)context.drawImage(image,source.x,source.y,source.width,source.height,x,y,w,h);
  else context.drawImage(image,x,y,w,h);
}

export function imageAvatarFrame(image:HTMLImageElement,crop?:Crop):AvatarFrame {
  const sample=canvas(SAMPLE_SIZE),context=sample.getContext('2d',{willReadFrequently:true});
  if(!context)return DEFAULT_FRAME;
  drawContained(context,image,SAMPLE_SIZE,crop);
  return measureAvatarFrame(context.getImageData(0,0,SAMPLE_SIZE,SAMPLE_SIZE).data,SAMPLE_SIZE,SAMPLE_SIZE);
}

export function applyAvatarFrame(image:HTMLImageElement,frame:AvatarFrame):void {
  image.style.position='absolute';image.style.left=`${frame.left*100}%`;image.style.top=`${frame.top*100}%`;
  image.style.width=`${frame.width*100}%`;image.style.height=`${frame.height*100}%`;
  image.style.maxWidth='none';image.style.objectFit='contain';
}

/** SVG keeps its vector bytes; only its viewport placement changes. PNG is
 * normalized before making the small thumbnail, so padding cannot erase detail. */
export async function normalizeAvatarHead(blob:Blob,mime:string):Promise<{blob:Blob;frame?:AvatarFrame}> {
  const url=URL.createObjectURL(blob),image=new Image();
  try{
    image.src=url;await image.decode();const frame=imageAvatarFrame(image);
    if(mime==='image/svg+xml')return {blob,frame};
    const target=canvas(96),context=target.getContext('2d');if(!context)return {blob,frame};
    drawContained(context,image,96,undefined,frame);
    const thumbnail=await new Promise<Blob|null>(resolve=>target.toBlob(resolve,'image/png'));
    return thumbnail?{blob:thumbnail}:{blob,frame};
  }finally{URL.revokeObjectURL(url);}
}

const previewCache=new Map<string,string[]>();
/** Find the transparent valleys between the five heads. Generated strips need
 * not align to exact fifths: fixed CSS slices can leak a neighboring character. */
function stripCrops(image:HTMLImageElement):Crop[]{
  const source=document.createElement('canvas');source.width=image.naturalWidth;source.height=image.naturalHeight;
  const context=source.getContext('2d',{willReadFrequently:true});if(!context)return [];
  context.drawImage(image,0,0);
  const width=source.width,height=source.height,pixels=context.getImageData(0,0,width,height).data,columns=new Float64Array(width);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const alpha=pixels[(y*width+x)*4+3];if(alpha>=128)columns[x]+=alpha/255;}
  const cuts=[0];
  for(let index=1;index<5;index++){
    const expected=width*index/5,radius=width/5*.18;let best=Math.round(expected),score=Infinity;
    for(let x=Math.floor(expected-radius);x<=Math.ceil(expected+radius);x++){
      const candidate=columns[x]+Math.abs(x-expected)*.001;
      if(candidate<score){score=candidate;best=x;}
    }
    cuts.push(best);
  }
  cuts.push(width);
  return cuts.slice(0,5).map((x,index)=>({x,y:0,width:cuts[index+1]-x,height}));
}

export function prepareAvatarPreview(image:HTMLImageElement,kind:'vector'|'image',index:number):void {
  if(kind==='vector')applyAvatarFrame(image,imageAvatarFrame(image));
  else{
    const url=image.src;
    let previews=previewCache.get(url);
    if(!previews){
      previews=stripCrops(image).map(crop=>{
        const target=canvas(256),context=target.getContext('2d');if(!context)return url;
        drawContained(context,image,256,crop,imageAvatarFrame(image,crop));
        return target.toDataURL('image/png');
      });
      previewCache.set(url,previews);
    }
    if(previews[index])image.src=previews[index];
  }
  image.dataset.framed='true';
}
