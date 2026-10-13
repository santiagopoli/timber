/** A draft insertion anchor follows edits; it never owns or replaces draft text. */
export type DictationAnchor = {botId:string;text:string;position:number};
export function remapDraftPosition(previous:string,next:string,position:number):number {
  const at=Math.max(0,Math.min(previous.length,position));
  if(previous===next)return at;
  // Two disjoint boundary edits can preserve the complete old draft. Follow
  // that intact span instead of treating it as one wholesale replacement.
  const retained=previous.length?next.indexOf(previous):-1;
  if(retained>0&&retained+previous.length<next.length)return at===previous.length?next.length:retained+at;
  let start=0,end=0;
  while(start<previous.length&&start<next.length&&previous[start]===next[start])start++;
  while(end<previous.length-start&&end<next.length-start&&previous[previous.length-1-end]===next[next.length-1-end])end++;
  // An insertion exactly at the anchor precedes dictation. A replaced region
  // containing it moves the anchor after the replacement, never over its text.
  if(at<start)return at;
  if(at>=previous.length-end)return at+next.length-previous.length;
  return next.length-end;
}
export function updateDictationAnchor(anchor:DictationAnchor,next:string):void {
  anchor.position=remapDraftPosition(anchor.text,next,anchor.position);anchor.text=next;
}
export function insertDictation(text:string,position:number,transcript:string):{text:string;position:number;length:number;end:number} {
  let at=Math.max(0,Math.min(text.length,position));
  // Do not split surrogate pairs or opaque private-input references.
  if(at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]))at++;
  for(const match of text.matchAll(/\[private(?:-draft)?:[a-f0-9-]{36}\]/gi))if(at>match.index!&&at<match.index!+match[0].length)at=match.index!+match[0].length;
  const words=transcript.trim();
  if(!words)return {text,position:at,length:0,end:at};
  const before=text.slice(0,at),after=text.slice(at);
  const addition=(before&&!/\s$/.test(before)?' ':'')+words+(after&&!/^\s/.test(after)?' ':'');
  return {text:before+addition+after,position:at,length:addition.length,end:at+addition.length};
}
