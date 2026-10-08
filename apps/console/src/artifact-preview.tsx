import {createContext, useContext, useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {CameraIcon, DownloadIcon, ExpandIcon, LoaderCircleIcon, RotateCwIcon, XIcon, ZoomInIcon, ZoomOutIcon} from 'lucide-react';
import './artifact-preview.css';

export type ArtifactLoader = (botId: string, artifactId: string, signal: AbortSignal) => Promise<Blob>;
const Loader = createContext<ArtifactLoader | null>(null);
export const ArtifactProvider = ({load,children}: {load:ArtifactLoader;children:ReactNode}) => <Loader.Provider value={load}>{children}</Loader.Provider>;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Authenticated immutable artifacts, fetched near the viewport, never a new screenshot. */
export function ArtifactPreview({botId,artifactId,compact=false}: {botId:string;artifactId:string;compact?:boolean}) {
  const load = useContext(Loader), trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  const [visible,setVisible] = useState(false), [attempt,setAttempt] = useState(0);
  const [image,setImage] = useState<{url:string;type:string}|null>(null), [error,setError] = useState(false);
  const [open,setOpen] = useState(false), [zoom,setZoom] = useState(false);
  const [size,setSize] = useState<{width:number;height:number}|null>(null);
  useEffect(()=>{
    const node=trigger.current;
    if(!node)return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'240px'});
    observer.observe(node);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if(!visible || !load)return;
    const controller=new AbortController();let url:string|undefined;
    setImage(null);setError(false);
    void (async()=>{
      try {
        if(!uuid.test(botId)||!uuid.test(artifactId))throw new Error('Invalid artifact');
        const blob=await load(botId,artifactId,controller.signal);
        if(controller.signal.aborted)return;
        if(!/^image\/(png|jpeg|webp|gif|avif)$/.test(blob.type))throw new Error('Not a supported image');
        url=URL.createObjectURL(blob);setImage({url,type:blob.type});
      } catch {if(!controller.signal.aborted)setError(true);}
    })();
    return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[visible,load,botId,artifactId,attempt]);
  useEffect(()=>{
    if(!open)return;
    const node=dialog.current;if(!node)return;
    node.showModal();
    return()=>{node.close();setZoom(false);trigger.current?.focus({preventScroll:true});};
  },[open]);
  const extension=image?.type.split('/')[1] || 'png';
  return <>
      <button ref={trigger} type="button" className={`timber-artifact-thumb${compact?' is-compact':''}`} data-artifact-id={artifactId} aria-label={error?'Retry screenshot preview':image?'Expand screenshot':'Loading screenshot'}
        onClick={event=>{event.preventDefault();event.stopPropagation();if(image){setOpen(true);}else{setVisible(true);if(error)setAttempt(value=>value+1);}}}>
        {image ? <img src={image.url} alt="Desktop screenshot" draggable={false} onLoad={event=>setSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} onError={()=>{setImage(null);setError(true);}}/>
          : <span className="timber-artifact-placeholder">{error?<RotateCwIcon/>:<LoaderCircleIcon className="timber-spinner"/>}<span>{error?'Retry preview':'Loading screenshot'}</span></span>}
        {image && <span className="timber-artifact-caption"><CameraIcon/><span>{compact?'Screenshot':size?`${size.width} × ${size.height}`:'Screenshot'}</span><ExpandIcon/></span>}
      </button>
    {open && createPortal(<dialog ref={dialog} className="timber-image-dialog" data-screenshot-dialog aria-labelledby={titleId} onCancel={event=>{event.preventDefault();setOpen(false);}} onClose={()=>setOpen(false)} onClick={event=>{event.stopPropagation();if(event.target===event.currentTarget)setOpen(false);}}>
        <div className="timber-image-toolbar">
          <h2 id={titleId}>Screenshot</h2>{size && <span className="timber-image-size">{size.width} × {size.height}</span>}
          <button type="button" onClick={()=>setZoom(value=>!value)} aria-label={zoom?'Fit image':'View actual size'} title={zoom?'Fit image':'View actual size'}>{zoom?<ZoomOutIcon/>:<ZoomInIcon/>}</button>
          {image && <a href={image.url} download={`screenshot-${artifactId}.${extension}`} aria-label="Download screenshot" title="Download screenshot"><DownloadIcon/></a>}
          <button type="button" onClick={()=>setOpen(false)} aria-label="Close screenshot" title="Close screenshot"><XIcon/></button>
        </div>
        <div className={`timber-image-viewport${zoom?' is-zoomed':''}`} tabIndex={0} aria-label="Screenshot image">
          {image && <img src={image.url} alt="Expanded desktop screenshot" draggable={false}/>}
        </div>
      </dialog>,document.fullscreenElement || document.body)}
  </>;
}
