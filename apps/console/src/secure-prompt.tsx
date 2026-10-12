import {useLayoutEffect,useRef,type KeyboardEvent} from 'react';

// References are public opaque IDs. Only the keychain endpoint receives values.
const lockPath='M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Z';
export function SecurePill(){return <span className="timber-private-chip" aria-label="Secure input" title="Secure input · value hidden"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={lockPath} fillRule="evenodd"/></svg><svg className="timber-private-dots" viewBox="0 0 30 11" aria-hidden="true">{[2.5,7.5,12.5,17.5,22.5,27.5].map(cx=><circle key={cx} cx={cx} cy="5.5" r="1.8"/>)}</svg><span className="sr-only">••••••</span></span>;}
export function createLockIcon(){const icon=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS('http://www.w3.org/2000/svg','path');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');path.setAttribute('d',lockPath);path.setAttribute('fill-rule','evenodd');icon.append(path);return icon;}
export function createDots(){const dots=document.createElementNS('http://www.w3.org/2000/svg','svg');dots.setAttribute('viewBox','0 0 30 11');dots.setAttribute('class','timber-private-dots');dots.setAttribute('aria-hidden','true');for(const x of [2.5,7.5,12.5,17.5,22.5,27.5]){const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('cx',String(x));dot.setAttribute('cy','5.5');dot.setAttribute('r','1.8');dots.append(dot);}return dots;}
export const privateDraftReference=(id:string)=>`[private-draft:${id}]`;
export const privateDraftPattern=/\[private-draft:([a-f0-9-]{36})\]/gi;
const editorPattern=/\[private(-draft)?:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]/gi;
export const secureReference=(id:string)=>`[private:${id}]`;
export const secureReferencePattern=/\[private:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\]/gi;
export const hasSecureReference=(text:string)=>/\[private(?:-draft)?:[a-f0-9-]{36}\]/i.test(text);
export const maskSecureReferences=(text:string)=>text.replace(secureReferencePattern,'`🔒 ••••••`');
export function readSecurePrompt(node:Node):string {
  if(node instanceof HTMLElement&&node.dataset.secureRef)return node.dataset.secureRef;
  if(node.nodeType===Node.TEXT_NODE)return node.textContent??'';
  if(node.nodeName==='BR')return '\n';
  return Array.from(node.childNodes).map((child,index)=>(index>0&&/^(DIV|P)$/.test(child.nodeName)?'\n':'')+readSecurePrompt(child)).join('');
}
function selectAt(root:HTMLElement,offset:number) {
  const range=document.createRange();let left=offset;
  for(const node of root.childNodes){const size=readSecurePrompt(node).length;if(left<=size){if(node.nodeType===Node.TEXT_NODE)range.setStart(node,left);else if(left===0)range.setStartBefore(node);else range.setStartAfter(node);range.collapse(true);const selection=getSelection();selection?.removeAllRanges();selection?.addRange(range);return;}left-=size;}
  range.selectNodeContents(root);range.collapse(false);getSelection()?.removeAllRanges();getSelection()?.addRange(range);
}
export function createSavedSecurePill(reference:string) {
  const chip=document.createElement('span');chip.className='timber-private-chip';chip.contentEditable='false';chip.dataset.secureRef=reference;chip.setAttribute('aria-label','Secure input');chip.title='Secure input · value hidden';
  const hidden=document.createElement('span');hidden.className='sr-only';hidden.textContent='••••••';chip.append(createLockIcon(),createDots(),hidden);return chip;
}

export function SecurePrompt({value,name,disabled,caret,onChange,onCaret,onRange,renderDraft,onKeyDown}:{value:string;name:string;disabled:boolean;caret:number;onChange:(text:string)=>void;onCaret:(offset:number)=>void;onRange:(start:number,end:number)=>void;renderDraft:(id:string)=>HTMLElement;onKeyDown:(event:KeyboardEvent<HTMLElement>)=>void}) {
  const root=useRef<HTMLDivElement>(null),initialized=useRef(false);
  useLayoutEffect(()=>{
    const node=root.current;if(!node||readSecurePrompt(node)===value)return;
    const editing=!initialized.current||node===document.activeElement||node.contains(document.activeElement);initialized.current=true;
    node.replaceChildren();let last=0;
    for(const match of value.matchAll(editorPattern)){
      node.append(document.createTextNode(value.slice(last,match.index)));
      if(match[1])node.append(renderDraft(match[2]));else node.append(createSavedSecurePill(match[0]));last=match.index!+match[0].length;
    }
    node.append(document.createTextNode(value.slice(last)));const privateInput=node.querySelector<HTMLTextAreaElement>('[data-focus-private]');if(privateInput){delete privateInput.dataset.focusPrivate;privateInput.focus({preventScroll:true});}else if(editing){node.focus({preventScroll:true});selectAt(node,caret);}
  },[value,caret]);
  const selection=()=>{
    const node=root.current,current=getSelection();if(!node||!current?.rangeCount||!node.contains(current.focusNode))return;
    const prefix=document.createRange();prefix.selectNodeContents(node);prefix.setEnd(current.focusNode!,current.focusOffset);onCaret(readSecurePrompt(prefix.cloneContents()).length);const range=current.getRangeAt(0),start=document.createRange();start.selectNodeContents(node);start.setEnd(range.startContainer,range.startOffset);const end=document.createRange();end.selectNodeContents(node);end.setEnd(range.endContainer,range.endOffset);onRange(readSecurePrompt(start.cloneContents()).length,readSecurePrompt(end.cloneContents()).length);
  };
  return <><input type="hidden" name="message" value={value}/><div ref={root} id="message" className="timber-secure-prompt" role="textbox" aria-label={name} aria-multiline="true" aria-disabled={disabled} contentEditable={!disabled} suppressContentEditableWarning spellCheck={false}
    onInput={()=>{if(root.current){onChange(readSecurePrompt(root.current));selection();}}} onKeyUp={selection} onMouseUp={selection} onBlur={selection}
    onPaste={event=>{if(event.target instanceof HTMLTextAreaElement)return;event.preventDefault();if(!disabled)document.execCommand('insertText',false,event.clipboardData.getData('text/plain'));}}
    onDrop={event=>event.preventDefault()}
    onKeyDown={event=>{if(event.target instanceof HTMLTextAreaElement)return;onKeyDown(event);if(event.defaultPrevented)return;if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();if(!disabled)document.execCommand('insertText',false,'\n');}}}
  /></>;
}
