import {ApiError, json} from './errors';
export const MAX_IMAGE_BYTES = 5_000_000;
export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  if ([137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value)) return 'image/png';
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  throw new ApiError(400,'invalid_image','Only PNG and JPEG images are supported.');
}
export async function uploadChatImage(request:Request, files:R2Bucket, botId:string, id:string):Promise<Response> {
  const reader=request.body?.getReader();
  if(!reader) throw new ApiError(400,'invalid_image','An image is required.');
  let size=0; const chunks:Uint8Array[]=[];
  while(true) {
    const part=await reader.read(); if(part.done) break;
    size+=part.value.length;
    if(size>MAX_IMAGE_BYTES) {await reader.cancel();throw new ApiError(413,'image_too_large','Images must be at most 5 MB.');}
    chunks.push(part.value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
  const mimeType=imageType(bytes);
  if(request.headers.get('content-type')!==mimeType) throw new ApiError(400,'invalid_image','Image content does not match its type.');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  const key=`bots/${botId}/artifacts/${id}`;
  const previous=await files.head(key);
  if(previous && (previous.customMetadata?.chatImage!=='true' || previous.customMetadata?.sha256!==hash)) throw new ApiError(409,'idempotency_conflict','Image ID already identifies different content.');
  if(!previous) {
    const written=await files.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:mimeType},customMetadata:{chatImage:'true',sha256:hash}});
    if(!written) {
      const winner=await files.head(key);
      if(winner?.customMetadata?.chatImage!=='true' || winner.customMetadata.sha256!==hash) throw new ApiError(409,'idempotency_conflict','Image ID already identifies different content.');
    }
  }
  return json({attachment:{artifactId:id,mimeType,size}});
}
