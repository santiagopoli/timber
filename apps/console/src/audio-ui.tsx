import {createContext,useContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {AudioLinesIcon,LoaderCircleIcon,MicIcon,PauseIcon,PlayIcon,RotateCcwIcon,SquareIcon,Trash2Icon,Volume2Icon} from 'lucide-react';
import {Button} from './components/ui/button';
import type {MessageAudio} from '../../../packages/contracts/src/index';
import {validateAudio,AudioValidationError,MAX_AUDIO_BYTES,MAX_AUDIO_DURATION_MS} from '../../../packages/contracts/src/audio-validation';
import './audio-ui.css';

export type LoadAudio=(botId:string,artifactId:string,signal:AbortSignal)=>Promise<Blob>;
const AudioLoadContext=createContext<LoadAudio|null>(null);
export function AudioProvider({load,children}:{load:LoadAudio;children:ReactNode}){return <AudioLoadContext.Provider value={load}>{children}</AudioLoadContext.Provider>;}
type Peaks=number[];
const MAX_COMPRESSED_WAVE_BYTES=2_000_000, MAX_COMPRESSED_WAVE_SECONDS=30, MAX_DECODED_WAVE_BYTES=32_000_000, MAX_PCM_WAVE_FRAMES=200_000;
let waveDecodeQueue:Promise<void>=Promise.resolve(),waitingWaveDecodes=0;
const MAX_QUEUED_WAVE_DECODES=4;
async function acquireWaveDecode(signal:AbortSignal):Promise<(()=>void)|null>{
  if(signal.aborted||waitingWaveDecodes>=MAX_QUEUED_WAVE_DECODES)return null;
  waitingWaveDecodes++;const previous=waveDecodeQueue;let release!:()=>void;waveDecodeQueue=new Promise(resolve=>{release=resolve;});
  await previous;waitingWaveDecodes--;if(signal.aborted){release();return null;}return release;
}
const formatTime=(seconds:number)=>{if(!Number.isFinite(seconds)||seconds<0)return '0:00';const n=Math.floor(seconds);return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;};
function pcmWavPeaks(bytes:Uint8Array,durationHint:number):Peaks|null{
  // Directly inspect validated, uncompressed PCM16 WAV. This parser never
  // expands compressed input; MP3/WebM use a separate, stricter preflighted
  // decoder and an honest waveform fallback outside its limits.
  if(bytes.length<44||bytes.length>MAX_AUDIO_BYTES||durationHint>MAX_AUDIO_DURATION_MS/1000)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const tag=(at:number)=>String.fromCharCode(bytes[at],bytes[at+1],bytes[at+2],bytes[at+3]);
  if(tag(0)!=='RIFF'||tag(8)!=='WAVE'||view.getUint32(4,true)!==bytes.length-8)return null;
  let pos=12,channels=0,rate=0,align=0,dataStart=-1,dataBytes=0,chunks=0;
  try{
    while(pos<bytes.length){
      if(++chunks>4096||pos+8>bytes.length)return null;
      const type=tag(pos),size=view.getUint32(pos+4,true),start=pos+8,end=start+size,padded=end+(size&1);
      if(!Number.isSafeInteger(padded)||padded>bytes.length||((size&1)&&bytes[end]!==0))return null;
      if(type==='fmt '){
        if(rate||dataStart>=0||(size!==16&&size!==18))return null;
        const format=view.getUint16(start,true);channels=view.getUint16(start+2,true);rate=view.getUint32(start+4,true);align=view.getUint16(start+12,true);
        if((format!==1)||(channels!==1&&channels!==2)||rate<8000||rate>192000||view.getUint16(start+14,true)!==16||align!==channels*2||view.getUint32(start+8,true)!==rate*align)return null;
        if(size===18&&view.getUint16(start+16,true)!==0)return null;
      }else if(type==='data'){
        if(!rate||dataStart>=0||!size||size%align)return null;dataStart=start;dataBytes=size;
      }else if(type!=='JUNK'&&type!=='PAD '&&type!=='LIST')return null;
      pos=padded;
    }
    if(pos!==bytes.length||!rate||dataStart<0)return null;
  }catch{return null;}
  const frames=dataBytes/align,seconds=frames/rate;
  if(!Number.isSafeInteger(frames)||!frames||seconds>MAX_AUDIO_DURATION_MS/1000||seconds>durationHint+0.01)return null;
  const bins=56,sampleStride=Math.max(1,Math.ceil(frames/MAX_PCM_WAVE_FRAMES)),raw=Array.from({length:bins},(_,bin)=>{
    const first=Math.floor(bin*frames/bins),last=Math.floor((bin+1)*frames/bins);let peak=0;
    for(let frame=first;frame<last;frame+=sampleStride)for(let channel=0;channel<channels;channel++)peak=Math.max(peak,Math.abs(view.getInt16(dataStart+frame*align+channel*2,true))/32768);
    return peak;
  });
  const maximum=Math.max(0,...raw);return raw.map(value=>maximum?value/maximum:0);
}
async function waveform(blob:Blob,durationHint:number,mimeType:string,signal:AbortSignal):Promise<Peaks|null>{
  if(blob.size>MAX_AUDIO_BYTES||durationHint>MAX_AUDIO_DURATION_MS/1000||durationHint<=0)return null;
  const typeHint=(mimeType||blob.type).split(';',1)[0].trim().toLowerCase(),wavHint=typeHint==='audio/wav'||typeHint==='audio/x-wav';
  // Long/large compressed clips never enter a decoder; keep native playback.
  if(!wavHint&&(blob.size>MAX_COMPRESSED_WAVE_BYTES||durationHint>MAX_COMPRESSED_WAVE_SECONDS))return null;
  let source:ArrayBuffer,checked;
  try{source=await blob.arrayBuffer();checked=validateAudio(new Uint8Array(source),mimeType||blob.type);if(checked.durationMs!==Math.round(durationHint*1000))return null;}catch{return null;}
  // Validated PCM16 WAV is already uncompressed: sample at most 200k frames
  // directly, covering the complete accepted WAV envelope without decode memory.
  if(checked.mimeType==='audio/wav')return pcmWavPeaks(new Uint8Array(source),durationHint);
  if(blob.size>MAX_COMPRESSED_WAVE_BYTES||durationHint>MAX_COMPRESSED_WAVE_SECONDS)return null;
  // For compressed formats, preflight the exact bytes before decoding and cap
  // the worst-case float output (two channels) independently of upload limits.
  if(typeof AudioContext==='undefined')return null;
  const release=await acquireWaveDecode(signal);if(!release)return null;let ctx:AudioContext|undefined;
  try{
    ctx=new AudioContext();const duration=checked.durationMs/1000;
    if(!Number.isFinite(ctx.sampleRate)||ctx.sampleRate<=0)return null;
    const estimatedBytes=Math.ceil(duration*ctx.sampleRate*2*Float32Array.BYTES_PER_ELEMENT);
    if(!Number.isFinite(estimatedBytes)||estimatedBytes>MAX_DECODED_WAVE_BYTES)return null;
    const buffer=await ctx.decodeAudioData(source.slice(0));
    const actualBytes=buffer.length*buffer.numberOfChannels*Float32Array.BYTES_PER_ELEMENT;
    if(buffer.duration>MAX_COMPRESSED_WAVE_SECONDS||buffer.length>ctx.sampleRate*MAX_COMPRESSED_WAVE_SECONDS||buffer.numberOfChannels>2||actualBytes>MAX_DECODED_WAVE_BYTES||actualBytes>estimatedBytes+buffer.numberOfChannels*Float32Array.BYTES_PER_ELEMENT)return null;
    const bins=56,step=Math.max(1,Math.floor(buffer.length/bins)),channels=Array.from({length:buffer.numberOfChannels},(_,c)=>buffer.getChannelData(c));
    const raw=Array.from({length:bins},(_,bin)=>{let peak=0;for(let c=0;c<channels.length;c++){const data=channels[c];for(let i=bin*step;i<Math.min(data.length,(bin+1)*step);i++)peak=Math.max(peak,Math.abs(data[i]));}return peak;});
    const maximum=Math.max(0,...raw);return raw.map(value=>maximum?value/maximum:0);
  }catch{return null;}finally{try{await ctx?.close().catch(()=>{});}finally{release();}}
}
function Wave({peaks,progress}:{peaks:Peaks|null;progress:number}){
  if(!peaks)return <div className="timber-audio-wave-unavailable"><span/><b>Waveform unavailable</b></div>;
  const current=Math.min(peaks.length,Math.round(progress*peaks.length));
  return <div className="timber-audio-wave" aria-hidden="true">{peaks.map((peak,i)=><i key={i} className={i<current?'is-played':''} style={{height:`${Math.round(peak*100)}%`}}/>)}</div>;
}
function Player({blob,durationMs,mimeType,loadError}:{blob:Blob|null;durationMs:number;mimeType:string;loadError?:string}){
  const audio=useRef<HTMLAudioElement>(null),[url,setUrl]=useState(''),[peaks,setPeaks]=useState<Peaks|null>(null),[peaksReady,setPeaksReady]=useState(false),[playing,setPlaying]=useState(false),[current,setCurrent]=useState(0),[duration,setDuration]=useState(durationMs/1000),[error,setError]=useState('');
  useEffect(()=>{if(!blob){setUrl('');return;}const next=URL.createObjectURL(blob);setUrl(next);setError('');setPeaks(null);setPeaksReady(false);let live=true;const ac=new AbortController();void waveform(blob,durationMs/1000,mimeType,ac.signal).then(value=>{if(live){setPeaks(value);setPeaksReady(true);}});return()=>{live=false;ac.abort();audio.current?.pause();URL.revokeObjectURL(next);};},[blob,durationMs,mimeType]);
  useEffect(()=>{const el=audio.current;if(!el)return;const update=()=>{setCurrent(el.currentTime||0);setDuration(Number.isFinite(el.duration)&&el.duration>0?el.duration:durationMs/1000);};setDuration(durationMs/1000);const ended=()=>setPlaying(false);el.addEventListener('timeupdate',update);el.addEventListener('durationchange',update);el.addEventListener('ended',ended);return()=>{el.removeEventListener('timeupdate',update);el.removeEventListener('durationchange',update);el.removeEventListener('ended',ended);};},[url,durationMs]);
  const toggle=async()=>{const el=audio.current;if(!el||!url)return;if(el.paused){try{await el.play();setPlaying(true);}catch{setError('This browser could not play the audio.');}}else{el.pause();setPlaying(false);}};
  const seek=(value:number)=>{const el=audio.current;if(!el)return;const max=Number.isFinite(el.duration)&&el.duration>0?el.duration:durationMs/1000;if(!Number.isFinite(max)||max<=0)return;let target=Math.max(0,Math.min(max,value));try{const ranges=el.seekable;if(ranges.length){let best=target,distance=Infinity;for(let i=0;i<ranges.length;i++){const start=ranges.start(i),end=ranges.end(i);if(target>=start&&target<=end){best=target;distance=0;break;}for(const bound of [start,end])if(Math.abs(target-bound)<distance){best=bound;distance=Math.abs(target-bound);}}target=best;}el.currentTime=target;setCurrent(target);}catch{setError('Seeking is unavailable for this audio in the current browser.');}};
  return <div className="timber-audio-player" role="group" aria-label="Audio playback controls" data-waveform={peaks?'decoded':'unavailable'}>
    <audio ref={audio} src={url||undefined} preload="metadata" onError={()=>setError('Audio could not be played in this browser.')} />
    <button className="timber-audio-play" type="button" onClick={()=>void toggle()} disabled={!url||Boolean(loadError)} aria-label={playing?'Pause audio':'Play audio'} title={playing?'Pause':'Play'}>{playing?<PauseIcon/>:<PlayIcon/>}</button>
    <div className="timber-audio-track"><Wave peaks={peaks} progress={duration>0?current/duration:0}/>
      <input aria-label="Seek audio" aria-valuetext={`${formatTime(current)} of ${formatTime(duration)}`} type="range" min="0" max={Math.max(0,duration)} step="0.01" value={Math.min(current,duration||0)} disabled={!url||!duration} onChange={event=>seek(Number(event.currentTarget.value))} />
      <div className="timber-audio-times"><span>{formatTime(current)}</span><span>{formatTime(duration)}</span></div>
    </div>
    <span className="timber-audio-icon" aria-hidden="true"><Volume2Icon/></span>
    {!peaksReady&&blob&&<span className="timber-sr-only" role="status">Preparing audio waveform</span>}
    {!peaks&&peaksReady&&<span className="timber-sr-only" role="status">Waveform unavailable for this recording; playback and seeking are available.</span>}
    {(loadError||error)&&<span className="timber-audio-error" role="alert">{loadError||error}</span>}
  </div>;
}

export function AudioMessage({botId,audio,onRetry,busy=false}:{botId:string;audio:MessageAudio;onRetry?:(operationId:string)=>void;busy?:boolean}){
  const loadAudio=useContext(AudioLoadContext);
  const host=useRef<HTMLElement>(null),[visible,setVisible]=useState(false);
  const [blob,setBlob]=useState<Blob|null>(null),[error,setError]=useState(''),[retryError,setRetryError]=useState(''),[retryBusy,setRetryBusy]=useState(false),[showTranscript,setShowTranscript]=useState(false),[attempt,setAttempt]=useState(0),[confirmRetry,setConfirmRetry]=useState(false),controller=useRef<AbortController|null>(null);
  useEffect(()=>{const node=host.current;if(!node)return;const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{rootMargin:'120px'});observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{const ac=new AbortController();controller.current=ac;let active=true;setBlob(null);setError('');if(!visible)return()=>ac.abort();if(!loadAudio){setError('Audio loader is unavailable.');return()=>ac.abort();}void loadAudio(botId,audio.artifactId,ac.signal).then(async value=>{
    if(value.size>MAX_AUDIO_BYTES)throw new AudioValidationError(413,'audio_too_large','Original audio exceeds the supported size limit.');
    const checked=validateAudio(new Uint8Array(await value.arrayBuffer()),value.type||audio.mimeType);
    if(checked.mimeType!==audio.mimeType||value.size!==audio.size||checked.durationMs!==audio.durationMs)throw new AudioValidationError(400,'audio_metadata_mismatch','Original audio does not match its validated message metadata.');
    if(active)setBlob(value);
  }).catch(reason=>{if(active&&reason?.name!=='AbortError')setError(reason instanceof AudioValidationError?'Original audio failed the local format or metadata safety check and was not loaded. Refresh the conversation before retrying.':'Original audio could not be loaded. Select Retry to fetch it again.');});return()=>{active=false;ac.abort();controller.current=null;};},[botId,audio.artifactId,audio.mimeType,audio.size,audio.durationMs,loadAudio,attempt,visible]);
  const t=audio.transcription,failed=t.status==='failed'||t.status==='uncertain';
  return <section ref={host} className="timber-audio-message" aria-label="Audio message" data-transcription-status={t.status}>
    <Player blob={blob} durationMs={audio.durationMs} mimeType={audio.mimeType} loadError={error}/>
    {!blob&&!error&&visible&&<p className="timber-audio-state" role="status">Loading original audio…</p>}
    <div className="timber-audio-original"><AudioLinesIcon aria-hidden="true"/><span>Original audio · {audio.mimeType.split('/')[1].toUpperCase()} · {formatTime(audio.durationMs/1000)}</span>
      {error&&<button type="button" className="timber-audio-text-button" onClick={()=>{setError('');setAttempt(v=>v+1);}}>Retry audio</button>}
    </div>
    <div className="timber-audio-transcription">
      {t.status==='pending'||t.status==='dispatching'?<p className="timber-audio-state" role="status">Transcription in progress…</p>:null}
      {t.status==='succeeded'&&t.text&&<><button type="button" className="timber-audio-text-button" aria-expanded={showTranscript} onClick={()=>setShowTranscript(v=>!v)}>{showTranscript?'Hide transcript':'Show transcript'}</button>{showTranscript&&<blockquote>{t.text}</blockquote>}</>}
      {failed&&<div className="timber-audio-failure" role="status"><strong>{t.status==='uncertain'?'Transcription outcome unknown':'Transcription failed'}</strong><p>{t.error||'Your original audio is saved. No transcript was generated.'}</p>{retryError&&<p className="timber-audio-error" role="alert">{retryError}</p>}{onRetry&&<Button type="button" size="sm" variant="outline" disabled={busy||retryBusy} onClick={()=>setConfirmRetry(true)}><RotateCcwIcon aria-hidden="true"/>Retry transcription</Button>}
      <AudioConsent open={confirmRetry} retrying onCancel={()=>setConfirmRetry(false)} onConfirm={()=>{setConfirmRetry(false);setRetryBusy(true);setRetryError('');void Promise.resolve(onRetry?.(audio.operationId)).catch(()=>setRetryError('Retry status is unknown. Refresh the conversation before submitting another attempt.')).finally(()=>setRetryBusy(false));}}/><p className="timber-audio-cost-note">A retry makes a new paid OpenAI API transcription request and may incur additional charges.</p></div>}
    </div>
  </section>;
}

function AudioConsent({open,onCancel,onConfirm,retrying=false}:{open:boolean;onCancel:()=>void;onConfirm:()=>void;retrying?:boolean}){
  const dialog=useRef<HTMLDialogElement>(null),label=useId();
  useEffect(()=>{const el=dialog.current;if(!el)return;if(open&&!el.open){el.showModal();}else if(!open&&el.open)el.close();},[open]);
  return <dialog ref={dialog} className="timber-audio-consent" aria-labelledby={label} onCancel={event=>{event.preventDefault();onCancel();}} onClick={event=>{if(event.target===event.currentTarget)onCancel();}}>
    <h2 id={label}>{retrying?'Retry audio transcription?':'Send audio for transcription?'}</h2>
    <p>The original audio will be stored with this conversation and sent to OpenAI's gpt-4o-mini-transcribe API. The published estimate is about $0.003 per minute; billing is separate and actual charges may vary. Sending audio also starts your bot. Timber will not silently switch providers.</p>
    {retrying&&<p>A retry is a new paid attempt. The previous uncertain attempt will not be repeated automatically.</p>}
    <div className="timber-audio-consent-actions"><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button><Button type="button" onClick={onConfirm}>{retrying?'Confirm paid retry':'Send audio'}</Button></div>
  </dialog>;
}

// Safari may offer only MP4 MediaRecorder output. Do not label those bytes as
// WebM or relax validation: record mono PCM16 WAV via Web Audio instead.
const WEBM_OPUS='audio/webm;codecs=opus',PCM_CAPTURE_RATE=16_000,PCM_PROCESS_FRAMES=4096;
function captureContextConstructor():typeof AudioContext|undefined{
  if(typeof window==='undefined')return undefined;
  return window.AudioContext||(window as Window & {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
}
function captureFormat():'webm'|'wav'|null{
  try{if(typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported(WEBM_OPUS))return 'webm';}catch{/* Never fall back to an unspecified codec. */}
  const Context=captureContextConstructor();return Context&&typeof Context.prototype.createScriptProcessor==='function'?'wav':null;
}
function pcmWaveHeader(frames:number,rate:number):ArrayBuffer{
  const header=new Uint8Array(44),view=new DataView(header.buffer),tag=(at:number,value:string)=>{for(let i=0;i<value.length;i++)header[at+i]=value.charCodeAt(i);};
  tag(0,'RIFF');view.setUint32(4,36+frames*2,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,frames*2,true);return header.buffer;
}

export type AudioCaptureMode='message'|'dictation';
export type AudioCaptureIds={operationId:string;audioId:string;attemptId:string};
export type AudioComposerControls={
  microphone:ReactNode;status:ReactNode;
  attachAudio:()=>void;recordAudio:()=>void;
  canAttachAudio:boolean;canRecordAudio:boolean;
  audioReady:boolean;audioSending:boolean;sendAudio:()=>void;
};
type AudioComposerProps={
  children:(controls:AudioComposerControls)=>ReactNode;
  textPresent:boolean;imagePresent:boolean;sending:boolean;
  onSend?:(file:File,ids:AudioCaptureIds,signal?:AbortSignal)=>Promise<void>;
  // Repeated calls for these IDs inspect the canonical receipt; they must not
  // automatically repeat a paid attempt after a failed/uncertain dispatch.
  onDictate?:(file:File,ids:AudioCaptureIds,signal?:AbortSignal)=>Promise<string>;
  onDictationStart?:()=>unknown;
  onDictationText?:(text:string,token:unknown)=>void;
  onDraftState?:(value:boolean,mode?:AudioCaptureMode)=>void;
};
export function AudioComposer({children,textPresent,imagePresent,sending,onSend,onDictate,onDictationStart,onDictationText,onDraftState}:AudioComposerProps){

  const captureStop=useRef<((reason?:string)=>void)|null>(null),sendController=useRef<AbortController|null>(null),dictationController=useRef<AbortController|null>(null);
  const mounted=useRef(false),captureGeneration=useRef(0),selectionGeneration=useRef(0),captureBusy=useRef(false),selectionBusy=useRef(false),flowGeneration=useRef(0);
  const modeRef=useRef<AudioCaptureMode>('message'),[mode,setMode]=useState<AudioCaptureMode>('message'),tokenRef=useRef<unknown>(undefined),interruptRef=useRef<()=>void>(()=>{});
  const [dictationSubmitted,setDictationSubmitted]=useState(false);
  const callbacks=useRef({onDictationText});callbacks.current={onDictationText};
  const [draft,setDraft]=useState<Blob|null>(null),idsRef=useRef<AudioCaptureIds|null>(null),[draftName,setDraftName]=useState(''),[durationMs,setDurationMs]=useState(0),[recording,setRecording]=useState(false),[requesting,setRequesting]=useState(false),[selecting,setSelecting]=useState(false),[elapsed,setElapsed]=useState(0),[error,setError]=useState(''),[consent,setConsent]=useState<'send'|null>(null),[busy,setBusy]=useState(false);
  const inAudioFlow=Boolean(draft||recording||requesting||selecting);
  useEffect(()=>onDraftState?.(inAudioFlow,mode),[inAudioFlow,mode,onDraftState]);
  useEffect(()=>{
    mounted.current=true;
    const interrupt=()=>interruptRef.current();
    const visibility=()=>{if(document.visibilityState!=='visible')interrupt();};
    // Cancel before the asynchronous logout request, not just eventual unmount.
    const logout=(event:MouseEvent)=>{if(event.target instanceof Element&&event.target.closest('#disconnect'))interrupt();};
    document.addEventListener('visibilitychange',visibility);document.addEventListener('click',logout,true);
    window.addEventListener('pagehide',interrupt);window.addEventListener('hashchange',interrupt);window.addEventListener('timber-audio-interrupt',interrupt);
    return()=>{mounted.current=false;interrupt();captureGeneration.current++;selectionGeneration.current++;document.removeEventListener('visibilitychange',visibility);document.removeEventListener('click',logout,true);window.removeEventListener('pagehide',interrupt);window.removeEventListener('hashchange',interrupt);window.removeEventListener('timber-audio-interrupt',interrupt);};
  },[]);
  // Audio is one standalone input; new normal-composer content cancels capture.
  useEffect(()=>{if(modeRef.current==='message'&&(textPresent||imagePresent))captureStop.current?.('Audio recording was stopped because the composer is no longer audio-only.');},[textPresent,imagePresent]);
  const eligible=!textPresent&&!imagePresent;
  const openPicker=()=>{
    if(!onSend||!eligible||sending||busy||draft||captureBusy.current||selectionBusy.current||sendController.current)return;
    modeRef.current='message';setMode('message');selectionBusy.current=true;setSelecting(true);onDraftState?.(true,'message');
    const generation=++selectionGeneration.current,input=document.createElement('input');input.type='file';input.accept='audio/wav,audio/mpeg,audio/webm,.wav,.mp3,.webm';
    input.addEventListener('change',()=>{if(mounted.current&&generation===selectionGeneration.current)void choose(input.files?.[0]);input.remove();},{once:true});
    input.addEventListener('cancel',()=>{if(generation===selectionGeneration.current){selectionBusy.current=false;if(mounted.current)setSelecting(false);}input.remove();},{once:true});input.click();
  };
  const choose=async(file?:File,captureMode:AudioCaptureMode='message')=>{
    if(!file||!mounted.current){selectionBusy.current=false;if(mounted.current)setSelecting(false);return;}const generation=++selectionGeneration.current;setError('');
    if(file.size>MAX_AUDIO_BYTES){selectionBusy.current=false;setSelecting(false);setError('Audio must be 20 MB or smaller.');return;}
    try{const bytes=new Uint8Array(await file.arrayBuffer()),valid=validateAudio(bytes,file.type||'');if(!mounted.current||generation!==selectionGeneration.current)return;modeRef.current=captureMode;setMode(captureMode);selectionBusy.current=false;setDictationSubmitted(false);setDraft(file);idsRef.current={operationId:crypto.randomUUID(),audioId:crypto.randomUUID(),attemptId:crypto.randomUUID()};setDraftName(file.name||`Recording.${valid.extension}`);setDurationMs(valid.durationMs);setSelecting(false);
      // Starting Dictate authorizes this one draft-only transcription. Stop
      // releases capture, validates the final bytes, then transcribes directly.
      if(captureMode==='dictation')void doDictate(file,idsRef.current);
    }
    catch(reason){if(!mounted.current||generation!==selectionGeneration.current)return;selectionBusy.current=false;setDraft(null);idsRef.current=null;setDraftName('');setDurationMs(0);setSelecting(false);setError(reason instanceof AudioValidationError?reason.message:'This audio format could not be checked safely.');}
  };
  const format=captureFormat(),canRecord=typeof navigator!=='undefined'&&!!navigator.mediaDevices?.getUserMedia&&Boolean(format);
  const start=async(captureMode:AudioCaptureMode='message')=>{
    if((captureMode==='message'&&(!onSend||!eligible))||(captureMode==='dictation'&&!onDictate)||sending||busy||draft||captureBusy.current||selectionBusy.current||sendController.current||!mounted.current||document.visibilityState!=='visible'||!canRecord||!format)return;
    // Capture the mode and insertion anchor synchronously before permission
    // awaits or React state updates can mix this with a newer flow.
    modeRef.current=captureMode;setMode(captureMode);flowGeneration.current++;
    tokenRef.current=captureMode==='dictation'?onDictationStart?.():undefined;
    const generation=++captureGeneration.current;captureBusy.current=true;setError('');setRequesting(true);onDraftState?.(true,captureMode);
    // Capture-local buffers prevent a stale onstop/permission grant from clearing
    // a newer recording's state or publishing into another conversation's draft.
    let acquired:MediaStream|null=null,r:MediaRecorder|null=null,ctx:AudioContext|null=null,source:MediaStreamAudioSourceNode|null=null,processor:ScriptProcessorNode|null=null,silence:GainNode|null=null;
    let pieces:BlobPart[]=[],bytes=0,frames=0,rate=PCM_CAPTURE_RATE,timer:number|undefined,finished=false,stopping=false,startedAt=0;
    const live=()=>mounted.current&&generation===captureGeneration.current;
    const release=()=>{
      clearInterval(timer);timer=undefined;
      if(acquired){for(const track of acquired.getTracks()){try{track.stop();}catch{}}acquired=null;}
      if(processor){processor.onaudioprocess=null;processor.disconnect();processor=null;}source?.disconnect();source=null;silence?.disconnect();silence=null;
      if(ctx){ctx.onstatechange=null;void ctx.close().catch(()=>{});ctx=null;}
    };
    const finish=(reason?:string)=>{
      if(finished)return;finished=true;release();if(captureStop.current===stopCapture)captureStop.current=null;
      if(!live()){pieces=[];return;}
      captureBusy.current=false;setRecording(false);setRequesting(false);
      if(reason){pieces=[];setError(reason);return;}
      if(format==='wav')pieces.unshift(pcmWaveHeader(frames,rate));
      const clip=new Blob(pieces,{type:format==='wav'?'audio/wav':r?.mimeType||WEBM_OPUS});pieces=[];
      if(!bytes){setError('No audio was captured. Try recording again.');return;}
      selectionBusy.current=true;setSelecting(true);onDraftState?.(true,captureMode);void choose(new File([clip],`Recording-${new Date().toISOString().replaceAll(':','-')}.${format}`,{type:clip.type}),captureMode);
    };
    const stopCapture=(reason?:string)=>{
      if(finished||(stopping&&!reason))return;stopping=true;
      // Release immediately, even while MediaRecorder flushes its final chunk.
      release();
      if(reason){if(r){r.ondataavailable=null;r.onstop=null;r.onerror=null;}finish(reason);captureGeneration.current++;}
      if(r&&r.state!=='inactive'){try{r.stop();}catch{finish('The browser could not finish this recording.');}}
      else finish();
    };
    captureStop.current=stopCapture;
    const fail=(reason:string)=>{if(live()&&!finished)stopCapture(reason);};
    try{
      if(format==='wav'){
        // Create/resume in the Record gesture, before awaiting permission. A
        // ScriptProcessor avoids new worklet URLs/CSP requirements on Safari.
        const Context=captureContextConstructor()!;ctx=new Context();
        void ctx.resume().catch(()=>fail('The browser could not start audio capture.'));
      }
      acquired=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1},video:false});
      if(!live()||finished){release();return;}
      if(document.visibilityState!=='visible'){stopCapture('Recording discarded because this tab is no longer visible.');return;}
      if(format==='webm'){
        r=new MediaRecorder(acquired,{mimeType:WEBM_OPUS});
        r.ondataavailable=e=>{if(!e.data.size||finished||!live())return;if(bytes+e.data.size>MAX_AUDIO_BYTES){fail('Recording stopped because audio reached the 20 MB limit. Start a shorter recording.');return;}pieces.push(e.data);bytes+=e.data.size;};
        r.onerror=()=>fail('The browser could not finish this recording.');r.onstop=()=>finish();r.start(250);
      }else{
        const context=ctx!;if(!Number.isFinite(context.sampleRate)||context.sampleRate<8000||context.sampleRate>192000)throw new Error('Unsupported capture sample rate');
        rate=Math.min(PCM_CAPTURE_RATE,context.sampleRate);
        const maxFrames=Math.min(Math.floor((MAX_AUDIO_BYTES-44)/2),Math.floor(rate*MAX_AUDIO_DURATION_MS/1000)),ratio=context.sampleRate/rate;
        // Streaming area-average resampling carries fractional weights between
        // callbacks without retaining Float32 source buffers. Mono 16 kHz PCM
        // uses 19.2 MB at 10 minutes, below the independent 20 MB cap.
        let weight=0,sum=0;
        source=context.createMediaStreamSource(acquired);processor=context.createScriptProcessor(PCM_PROCESS_FRAMES,1,1);silence=context.createGain();silence.gain.value=0;
        processor.onaudioprocess=event=>{
          if(finished||stopping||!live())return;
          if(document.visibilityState!=='visible'){stopCapture('Recording discarded because this tab is no longer visible.');return;}
          const input=event.inputBuffer.getChannelData(0);
          if(input.length>PCM_PROCESS_FRAMES){fail('The browser returned an unsupported audio capture buffer.');return;}
          const output=new Uint8Array(Math.min(maxFrames-frames,Math.ceil(input.length/ratio)+1)*2),view=new DataView(output.buffer);let count=0;
          for(let i=0;i<input.length&&frames+count<maxFrames;i++){
            const sample=Number.isFinite(input[i])?Math.max(-1,Math.min(1,input[i])):0;let left=1;
            while(left>0&&frames+count<maxFrames){const take=Math.min(left,ratio-weight);sum+=sample*take;weight+=take;left-=take;
              if(weight>=ratio-1e-9){const value=Math.max(-1,Math.min(1,sum/ratio));view.setInt16(count*2,Math.round(value*(value<0?32768:32767)),true);count++;sum=0;weight=0;}
            }
          }
          if(count){const chunk=output.subarray(0,count*2);pieces.push(chunk);frames+=count;bytes+=chunk.byteLength;}
          if(frames>=maxFrames)stopCapture();
        };
        source.connect(processor);processor.connect(silence);silence.connect(context.destination);
        await context.resume();if(!live()||finished){release();return;}
        if(context.state!=='running')throw new Error('Capture audio context did not start');
        context.onstatechange=()=>{if(context.state!=='running')fail('Recording discarded because audio capture was suspended.');};
      }
      if(!live()||finished)return;
      startedAt=performance.now();setRecording(true);setElapsed(0);setRequesting(false);
      timer=window.setInterval(()=>{if(!live()||finished)return;const seconds=Math.floor((performance.now()-startedAt)/1000);setElapsed(Math.min(seconds,MAX_AUDIO_DURATION_MS/1000));if(seconds>=MAX_AUDIO_DURATION_MS/1000)stopCapture();},250);
    }catch(reason){release();if(live()&&!finished)stopCapture(reason instanceof Error&&reason.name==='NotAllowedError'?(onSend?'Microphone permission was not granted. You can still choose an audio file.':'Microphone permission was not granted.'):'Microphone recording is unavailable in this browser.');}
  };
  const stop=()=>captureStop.current?.();
  const remove=()=>{dictationController.current=null;selectionGeneration.current++;selectionBusy.current=false;tokenRef.current=undefined;setSelecting(false);setDraft(null);idsRef.current=null;setDraftName('');setDurationMs(0);setDictationSubmitted(false);setError('');};
  // One interrupt owns microphone, validation and network cancellation in both
  // modes, including review/transcription when no captureStop remains.
  interruptRef.current=()=>{
    flowGeneration.current++;sendController.current?.abort();dictationController.current?.abort();dictationController.current=null;captureStop.current?.('Recording discarded because you left the active conversation.');
    captureGeneration.current++;selectionGeneration.current++;captureBusy.current=false;selectionBusy.current=false;tokenRef.current=undefined;
    if(modeRef.current==='dictation')sendController.current=null;
    if(mounted.current){setConsent(null);setRecording(false);setRequesting(false);setSelecting(false);if(modeRef.current==='dictation'){setBusy(false);remove();}}
  };
  const cancelDictation=()=>{interruptRef.current();if(mounted.current)remove();};
  const cancelAudio=()=>{if(sendController.current){sendController.current.abort();setConsent(null);setError('Audio send cancelled. Its status may be unknown if already submitted. Refresh the conversation before explicitly retrying; cancellation cannot undo a stored message.');return;}remove();};
  const doSend=async()=>{
    if(!onSend||modeRef.current!=='message'||!draft||busy||sending||!eligible||sendController.current)return;
    const controller=new AbortController(),generation=flowGeneration.current;sendController.current=controller;setBusy(true);setConsent(null);setError('');
    try{
      const ext=draftName.split('.').pop()||'audio',file=new File([draft],draftName||`audio.${ext}`,{type:draft.type}),ids=idsRef.current||{operationId:crypto.randomUUID(),audioId:crypto.randomUUID(),attemptId:crypto.randomUUID()};idsRef.current=ids;
      await onSend(file,ids,controller.signal);
      if(mounted.current&&!controller.signal.aborted&&generation===flowGeneration.current)remove();
    }catch(reason){if(mounted.current&&generation===flowGeneration.current)setError(controller.signal.aborted?'Audio send cancelled. Its status may be unknown if already submitted. Refresh the conversation before explicitly retrying; cancellation cannot undo a stored message.':reason instanceof Error?reason.message:'Audio was not sent. Inspect its status before retrying.');}
    finally{if(sendController.current===controller){sendController.current=null;if(mounted.current)setBusy(false);}}
  };
  const doDictate=async(capturedFile?:File,capturedIds?:AudioCaptureIds|null)=>{
    const clip=capturedFile??draft;
    if(!mounted.current||modeRef.current!=='dictation'||!clip||busy||sending||sendController.current||!onDictate)return;
    // Retain this signal through failed/unknown receipt checks so a later
    // explicit cancellation still discards the original durable operation.
    const controller=dictationController.current||new AbortController(),generation=flowGeneration.current,token=tokenRef.current,ids=capturedIds??idsRef.current;
    if(!ids)return;
    dictationController.current=controller;sendController.current=controller;setBusy(true);setConsent(null);setError('');setDictationSubmitted(true);
    const live=()=>mounted.current&&!controller.signal.aborted&&generation===flowGeneration.current&&modeRef.current==='dictation';
    try{
      const file=capturedFile??new File([clip],draftName||'Dictation.wav',{type:clip.type});
      const text=await onDictate(file,ids,controller.signal);
      if(!live())return;
      if(!text.trim())throw new Error('No transcript was returned. Check transcription status before retrying.');
      callbacks.current.onDictationText?.(text,token);
      if(live())remove();
    }catch(reason){if(live())setError(reason instanceof Error?reason.message:'Transcription status is unknown. Check its status before retrying.');}
    finally{if(sendController.current===controller){sendController.current=null;if(mounted.current)setBusy(false);}}
  };
  const idle=!inAudioFlow&&!busy;
  const audioReady=mode==='message'&&Boolean(draft);
  const microphone=onDictate||recording?<Button className="timber-dictate" type="button" variant="ghost" size="icon"
    disabled={recording?false:!idle||sending||!canRecord||!onDictate}
    aria-label={recording?'Stop recording':'Dictate text'}
    title={recording?'Stop recording':!canRecord?'Microphone recording is not supported in this browser':'Dictate text · Stop transcribes into your draft using the separately billed OpenAI API (about $0.003/minute); nothing is sent'}
    onClick={()=>{if(recording)stop();else void start('dictation');}}>
    {recording?<SquareIcon aria-hidden="true"/>:busy?<LoaderCircleIcon className="timber-spinner" aria-hidden="true"/>:<MicIcon aria-hidden="true"/>}
  </Button>:null;
  const status=inAudioFlow||busy||error?<div className="timber-audio-composer" data-audio-ready={Boolean(draft)} data-audio-mode={mode}>
    {selecting&&<div className="timber-audio-state" role="status">Checking audio file…<Button type="button" variant="ghost" onClick={mode==='dictation'?cancelDictation:()=>{interruptRef.current();remove();}}>{mode==='dictation'?'Cancel dictation':'Cancel audio'}</Button></div>}
    {requesting&&!recording&&<div className="timber-audio-state" role="status">Requesting microphone permission…<Button type="button" variant="ghost" onClick={mode==='dictation'?cancelDictation:()=>{interruptRef.current();remove();}}>{mode==='dictation'?'Cancel dictation':'Cancel audio'}</Button></div>}
    {recording&&<div className="timber-audio-recording" role="status"><span className="timber-audio-recording-dot"/><span>{mode==='dictation'?'Dictating':'Recording'} · {formatTime(elapsed)}</span><Button type="button" variant="ghost" onClick={()=>{if(modeRef.current==='dictation')cancelDictation();else captureStop.current?.('Recording discarded.');}}>{mode==='dictation'?'Cancel dictation':'Discard'}</Button></div>}
    {draft&&mode==='dictation'&&<div className="timber-audio-state" role="status"><span>{busy?'Transcribing…':'Dictation not inserted'}</span><Button type="button" variant="ghost" onClick={cancelDictation}>Cancel dictation</Button>{dictationSubmitted&&!busy&&<Button type="button" variant="outline" disabled={sending} onClick={()=>void doDictate()}>Check transcription status</Button>}</div>}
    {draft&&mode==='message'&&<div className="timber-audio-draft"><div><AudioLinesIcon aria-hidden="true"/><span>{draftName}</span><span>{formatTime(durationMs/1000)}</span></div><Player blob={draft} durationMs={durationMs} mimeType={draft.type}/><p>OpenAI API transcription · about $0.003/minute published estimate, billed separately; actual charges may vary. Sending audio also starts your bot.</p><div className="timber-audio-draft-actions"><Button type="button" variant="outline" disabled={sending&&!busy} onClick={cancelAudio}><Trash2Icon aria-hidden="true"/>Cancel audio</Button></div></div>}
    {error&&<p className="timber-audio-error" role="alert">{error}</p>}
  </div>:null;
  return <>{children({microphone,status,attachAudio:openPicker,recordAudio:()=>void start('message'),
    canAttachAudio:Boolean(onSend&&eligible&&idle&&!sending),canRecordAudio:Boolean(onSend&&eligible&&idle&&!sending&&canRecord),
    audioReady,audioSending:busy||sending,sendAudio:()=>{if(audioReady&&!busy&&!sending&&eligible)setConsent('send');}})}
    <AudioConsent open={consent==='send'&&mode==='message'} onCancel={()=>setConsent(null)} onConfirm={()=>void doSend()}/>
  </>;
}
