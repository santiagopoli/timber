import {useEffect,useRef} from 'react';
import type {SecretMetadata} from '../../../packages/contracts/src/index';
import {useKeychain} from './keychain';
import {secureReference,privateDraftReference,privateDraftPattern,createLockIcon,createDots,readSecurePrompt,createSavedSecurePill} from './secure-prompt';

type Swap={start:number;oldLength:number;newLength:number};
type Draft={element:HTMLSpanElement;input:HTMLTextAreaElement;error:HTMLSpanElement;replacement?:SecretMetadata;pending?:Promise<string>};
export function useInlineSecrets(value:string,onChange:(text:string,swap?:Swap)=>void){
  const {save}=useKeychain(),drafts=useRef(new Map<string,Draft>()),current=useRef(value),mounted=useRef(true);current.current=value;
  useEffect(()=>{for(const [id,draft] of drafts.current)if(!value.includes(privateDraftReference(id))&&!draft.pending){draft.input.value='';drafts.current.delete(id);}},[value]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const draft of drafts.current.values())draft.input.value='';drafts.current.clear();};},[]);
  const commit=async(id:string):Promise<string>=>{
    const draft=drafts.current.get(id);if(!draft)throw new Error('Add this secure input again.');if(draft.pending)return draft.pending;
    if(!draft.input.value){draft.error.textContent='Paste a value first.';draft.input.focus();throw new Error('Complete the secure input first.');}
    const editing=document.activeElement===draft.input;
    const entries=[{value:draft.input.value,...(draft.replacement?{id:draft.replacement.id,expectedRevision:draft.replacement.revision}:{})}];draft.input.value='';draft.input.disabled=true;draft.element.setAttribute('aria-busy','true');draft.error.textContent='';
    // Masking is immediate, not an acknowledgement that persistence finished.
    // Let the user continue after this pending pill without waiting for the
    // network; completion will replace only the pill, never the typed text.
    const editor=draft.element.closest<HTMLElement>('.timber-secure-prompt');
    if(editor&&editing){editor.focus({preventScroll:true});const range=document.createRange();range.setStartAfter(draft.element);range.collapse(true);getSelection()?.removeAllRanges();getSelection()?.addRange(range);}
    const pending=(async()=>{
      try{
        const saved=await save({operationId:crypto.randomUUID(),entries}),reference=secureReference(saved[0].id);
        if(mounted.current&&drafts.current.get(id)===draft){
          const marker=privateDraftReference(id),editor=draft.element.closest<HTMLElement>('.timber-secure-prompt');
          // DOM text can be newer than the last React value when a save and a
          // keystroke complete together. Opaque markers exclude private values.
          const source=editor?readSecurePrompt(editor):current.current,start=source.indexOf(marker);
          if(start>=0){
            if(editor){
              const selection=getSelection(),range=selection?.rangeCount?selection.getRangeAt(0):null;
              const preserve=editor===document.activeElement&&range&&editor.contains(range.startContainer)&&editor.contains(range.endContainer);
              const points=preserve?{start:range.startContainer,startOffset:range.startOffset,end:range.endContainer,endOffset:range.endOffset}:null;
              draft.element.replaceWith(createSavedSecurePill(reference));
              // Replacing a sibling can move a live Range boundary. Preserve
              // the actual nodes/offsets, including a non-collapsed selection.
              if(points&&editor.contains(points.start)&&editor.contains(points.end)){
                const restored=document.createRange();restored.setStart(points.start,points.startOffset);restored.setEnd(points.end,points.endOffset);selection?.removeAllRanges();selection?.addRange(restored);
              }
            }
            const text=source.replaceAll(marker,reference);current.current=text;onChange(text,{start,oldLength:marker.length,newLength:reference.length});
          }
          drafts.current.delete(id);
        }return reference;
      }catch(reason){const message=reason instanceof Error?reason.message:'Could not save the private input.';draft.error.textContent=message;throw new Error(message);}
      finally{entries[0].value='';draft.input.disabled=false;draft.element.removeAttribute('aria-busy');draft.pending=undefined;}
    })();draft.pending=pending;return pending;
  };
  const create=(start:number,end:number,replacement?:SecretMetadata,convert=true)=>{
    const id=crypto.randomUUID(),element=document.createElement('span'),field=document.createElement('span'),input=document.createElement('textarea'),error=document.createElement('span');
    element.className='timber-private-chip timber-private-edit';element.contentEditable='false';element.dataset.secureRef=privateDraftReference(id);element.title='Private input · Enter to save';
    field.className='timber-private-field';
    input.className='timber-private-text timber-private-inline';input.rows=1;input.wrap='off';input.maxLength=16_000;input.setAttribute('aria-label','Private input');input.autocomplete='off';input.spellcheck=false;input.setAttribute('autocapitalize','none');input.setAttribute('autocorrect','off');input.dataset.secureValue='';input.dataset.focusPrivate='';
    input.value=convert?current.current.slice(start,end):'';field.dataset.empty=String(!input.value);
    const measure=document.createElement('canvas').getContext('2d');
    const size=()=>{
      field.dataset.empty=String(!input.value);
      if(measure)measure.font=getComputedStyle(input).font;
      const width=Math.max(48,...input.value.split('\n').map(line=>measure?.measureText(line).width??line.length*8));
      field.style.setProperty('--private-input-width',`${Math.min(240,Math.ceil(width)+4)}px`);
    };
    input.onfocus=size;input.oninput=size;
    error.className='timber-secure-inline-error';error.setAttribute('role','alert');
    const remove=()=>{input.value='';drafts.current.delete(id);const text=current.current.replaceAll(privateDraftReference(id),'');current.current=text;onChange(text);};
    input.onkeydown=event=>{event.stopPropagation();if(event.isComposing)return;if(event.key==='Escape'||event.key==='Backspace'&&!input.value){event.preventDefault();remove();}else if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void commit(id).catch(()=>{});}};
    input.onblur=()=>{if(input.value&&!drafts.current.get(id)?.pending)void commit(id).catch(()=>{});};
    // Show the DOM field only while editing. Blur clears it before the save
    // request, and the same six-dot artwork used by saved pills takes its place.
    // Measure width without copying the value into text nodes or React state.
    field.append(input,createDots());element.append(createLockIcon(),field,error);drafts.current.set(id,{element,input,error,replacement});
    const text=current.current.slice(0,start)+privateDraftReference(id)+current.current.slice(end);current.current=text;onChange(text);
    if(convert&&end>start)void commit(id).catch(()=>{});
    return start+privateDraftReference(id).length;
  };
  const render=(id:string)=>{
    const draft=drafts.current.get(id);if(draft)return draft.element;
    const missing=document.createElement('span');missing.dataset.secureRef=privateDraftReference(id);missing.className='timber-private-edit';missing.contentEditable='false';missing.textContent='Private input cleared · remove and add again';return missing;
  };
  const flush=async(text:string)=>{for(const match of text.matchAll(privateDraftPattern))text=text.replaceAll(match[0],await commit(match[1]));return text;};
  return {create,render,flush};
}
