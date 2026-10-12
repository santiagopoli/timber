import {createContext,useContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {AudioLinesIcon,MicIcon,PauseIcon,PlayIcon,RotateCcwIcon,SquareIcon,Trash2Icon,UploadIcon,Volume2Icon} from 'lucide-react';
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

export function AudioComposer({textPresent,imagePresent,sending,onSend,onDraftState}:{textPresent:boolean;imagePresent:boolean;sending:boolean;onSend:(file:File,ids:{operationId:string;audioId:string;attemptId:string})=>Promise<void>;onDraftState?:(value:boolean)=>void} ){
  const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),chunks=useRef<BlobPart[]>([]),chunkBytes=useRef(0),timer=useRef<number|undefined>(undefined);
  const mounted=useRef(false),captureGeneration=useRef(0),selectionGeneration=useRef(0),captureBusy=useRef(false),recordingNow=useRef(false),discardRecording=useRef(false),recordingFailure=useRef(''),elapsedSeconds=useRef(0),finishCapture=useRef<(()=>void)|null>(null);
  const [draft,setDraft]=useState<Blob|null>(null),idsRef=useRef<{operationId:string;audioId:string;attemptId:string}|null>(null),[draftName,setDraftName]=useState(''),[durationMs,setDurationMs]=useState(0),[recording,setRecording]=useState(false),[requesting,setRequesting]=useState(false),[selecting,setSelecting]=useState(false),[elapsed,setElapsed]=useState(0),[error,setError]=useState(''),[consent,setConsent]=useState<'send'|'retry'|null>(null),[busy,setBusy]=useState(false);
  const clearTimer=()=>{clearInterval(timer.current);timer.current=undefined;};
  const stopTracks=(target:MediaStream|null)=>{if(!target)return;for(const track of target.getTracks()){try{track.stop();}catch{}}if(stream.current===target)stream.current=null;};
  const inAudioFlow=Boolean(draft||recording||requesting||selecting);
  useEffect(()=>onDraftState?.(inAudioFlow),[inAudioFlow,onDraftState]);
  useEffect(()=>{mounted.current=true;return()=>{
    mounted.current=false;captureGeneration.current++;selectionGeneration.current++;captureBusy.current=false;recordingNow.current=false;discardRecording.current=true;clearTimer();chunks.current=[];chunkBytes.current=0;
    const active=recorder.current,acquired=stream.current;stopTracks(acquired);if(active&&active.state!=='inactive'){try{active.stop();}catch{}}recorder.current=null;finishCapture.current=null;
  };},[]);
  // If normal composer content appears during an audio draft/recording, keep
  // the one-audio-message invariant by discarding the capture before admission.
  useEffect(()=>{if((!textPresent&&!imagePresent)||!captureBusy.current)return;const reason='Audio recording was stopped because the composer is no longer audio-only.';captureGeneration.current++;captureBusy.current=false;recordingNow.current=false;discardRecording.current=true;recordingFailure.current=reason;chunks.current=[];chunkBytes.current=0;clearTimer();const active=recorder.current;const acquired=stream.current;stopTracks(acquired);if(active&&active.state!=='inactive'){try{active.stop();}catch{finishCapture.current?.();}}else finishCapture.current?.();if(mounted.current){setRequesting(false);setRecording(false);setError(reason);}},[textPresent,imagePresent]);
  const eligible=!textPresent&&!imagePresent;
  const openPicker=()=>{if(!eligible||sending||busy||requesting||selecting)return;setSelecting(true);onDraftState?.(true);const input=document.createElement('input');input.type='file';input.accept='audio/wav,audio/mpeg,audio/webm,.wav,.mp3,.webm';input.addEventListener('change',()=>{void choose(input.files?.[0]);input.remove();},{once:true});input.addEventListener('cancel',()=>{if(mounted.current)setSelecting(false);input.remove();},{once:true});input.click();};
  const choose=async(file?:File)=>{
    if(!file||!mounted.current){if(mounted.current)setSelecting(false);return;}const generation=++selectionGeneration.current;setError('');
    if(file.size>MAX_AUDIO_BYTES){setSelecting(false);setError('Audio must be 20 MB or smaller.');return;}
    try{const bytes=new Uint8Array(await file.arrayBuffer()),valid=validateAudio(bytes,file.type||'');if(!mounted.current||generation!==selectionGeneration.current)return;setDraft(file);idsRef.current={operationId:crypto.randomUUID(),audioId:crypto.randomUUID(),attemptId:crypto.randomUUID()};setDraftName(file.name||`Recording.${valid.extension}`);setDurationMs(valid.durationMs);setSelecting(false);}
    catch(reason){if(!mounted.current||generation!==selectionGeneration.current)return;setDraft(null);idsRef.current=null;setDraftName('');setDurationMs(0);setSelecting(false);setError(reason instanceof AudioValidationError?reason.message:'This audio format could not be checked safely.');}
  };
  const canRecord=typeof navigator!=='undefined'&&!!navigator.mediaDevices?.getUserMedia&&typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported('audio/webm;codecs=opus');
  const start=async()=>{
    if(!eligible||sending||busy||captureBusy.current||recordingNow.current||!mounted.current)return;
    const generation=++captureGeneration.current;captureBusy.current=true;discardRecording.current=false;recordingFailure.current='';setError('');setRequesting(true);onDraftState?.(true);
    let acquired:MediaStream|null=null,r:MediaRecorder|null=null,finished=false;
    const finish=()=>{
      if(finished)return;finished=true;clearTimer();if(acquired)stopTracks(acquired);if(recorder.current===r)recorder.current=null;if(finishCapture.current===finish)finishCapture.current=null;
      const live=mounted.current&&generation===captureGeneration.current;if(generation===captureGeneration.current){recordingNow.current=false;captureBusy.current=false;if(live){setRecording(false);setRequesting(false);}}
      const discard=discardRecording.current||!live;discardRecording.current=false;const reason=recordingFailure.current;recordingFailure.current='';const pieces=chunks.current;chunks.current=[];chunkBytes.current=0;
      if(!live)return;if(discard){if(reason)setError(reason);return;}const clip=new Blob(pieces,{type:r?.mimeType||'audio/webm'});if(!clip.size){setError('No audio was captured. Try recording again.');return;}setSelecting(true);onDraftState?.(true);void choose(new File([clip],`Recording-${new Date().toISOString().replaceAll(':','-')}.webm`,{type:clip.type}));
    };
    const fail=(message:string)=>{
      if(!mounted.current||generation!==captureGeneration.current||!captureBusy.current){if(acquired)stopTracks(acquired);return;}
      if(discardRecording.current&&recordingFailure.current)return;discardRecording.current=true;recordingFailure.current=message;chunks.current=[];chunkBytes.current=0;clearTimer();if(acquired)stopTracks(acquired);setError(message);
      try{if(r&&r.state!=='inactive')r.stop();else finish();}catch{finish();}
    };
    try{
      acquired=await navigator.mediaDevices.getUserMedia({audio:true});
      if(!mounted.current||generation!==captureGeneration.current){stopTracks(acquired);return;}
      stream.current=acquired;r=new MediaRecorder(acquired,{mimeType:'audio/webm;codecs=opus'});recorder.current=r;chunks.current=[];chunkBytes.current=0;elapsedSeconds.current=0;
      r.ondataavailable=e=>{if(!e.data.size||discardRecording.current||!mounted.current||generation!==captureGeneration.current)return;if(chunkBytes.current+e.data.size>MAX_AUDIO_BYTES){fail('Recording stopped because audio reached the 20 MB limit. Start a shorter recording.');return;}chunks.current.push(e.data);chunkBytes.current+=e.data.size;};
      r.onerror=()=>fail('The browser could not finish this recording.');r.onstop=finish;finishCapture.current=finish;r.start(250);
      recordingNow.current=true;setRecording(true);setElapsed(0);setRequesting(false);
      timer.current=window.setInterval(()=>{if(!mounted.current||generation!==captureGeneration.current)return;if(elapsedSeconds.current>=599){setElapsed(600);stop();return;}elapsedSeconds.current++;setElapsed(elapsedSeconds.current);},1000);
    }catch(reason){if(acquired)stopTracks(acquired);if(r){r.ondataavailable=null;r.onerror=null;r.onstop=null;}if(recorder.current===r)recorder.current=null;if(generation===captureGeneration.current){captureBusy.current=false;recordingNow.current=false;finishCapture.current=null;if(mounted.current){setRecording(false);setRequesting(false);setError(reason instanceof Error&&reason.name==='NotAllowedError'?'Microphone permission was not granted. You can still choose an audio file.':'Microphone recording is unavailable in this browser.');}}}
  };
  const stop=()=>{clearTimer();const active=recorder.current;if(active&&active.state!=='inactive'){try{active.stop();}catch{finishCapture.current?.();}}else finishCapture.current?.();};
  const remove=()=>{selectionGeneration.current++;setDraft(null);idsRef.current=null;setDraftName('');setDurationMs(0);setError('');};
  const doSend=async()=>{if(!draft||busy||sending)return;setBusy(true);setConsent(null);setError('');try{const ext=draftName.split('.').pop()||'audio',file=new File([draft],draftName||`audio.${ext}`,{type:draft.type}),ids=idsRef.current||{operationId:crypto.randomUUID(),audioId:crypto.randomUUID(),attemptId:crypto.randomUUID()};idsRef.current=ids;await onSend(file,ids);if(mounted.current)remove();}catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'Audio was not sent. Inspect its status before retrying.');}finally{if(mounted.current)setBusy(false);}};
  return <div className="timber-audio-composer" data-audio-ready={Boolean(draft)}>
    {!draft&&!recording&&<div className="timber-audio-tools" title={!eligible?'Clear text and image attachments to send audio as its own message.':undefined}><Button type="button" variant="ghost" disabled={!eligible||sending||busy||requesting||selecting} onClick={openPicker} aria-label="Attach audio file"><UploadIcon aria-hidden="true"/>Audio file</Button>
      {canRecord?<Button type="button" variant="ghost" disabled={!eligible||sending||busy||requesting||selecting} onClick={()=>void start()} aria-label="Start recording audio"><MicIcon aria-hidden="true"/>{requesting?'Requesting microphone…':'Record'}</Button>:eligible?<span className="timber-audio-browser-note">Microphone recording is not supported here. Choose a WAV, MP3 or WebM Opus file.</span>:null}
      {/* Keep disabled tools compact so ordinary drafts do not shrink the model comparison panel. */}
      {eligible&&<span className="timber-audio-format-note">WAV, MP3, or WebM Opus · up to 20 MB and 10 minutes. M4A/MP4 and Ogg are not supported.</span>}
    </div>}
    {selecting&&<p className="timber-audio-state" role="status">Checking audio file…</p>}
    {requesting&&!recording&&<p className="timber-audio-state" role="status">Requesting microphone permission…</p>}
    {recording&&<div className="timber-audio-recording" role="status"><span className="timber-audio-recording-dot"/><span>Recording · {formatTime(elapsed)}</span><Button type="button" variant="outline" onClick={stop}><SquareIcon aria-hidden="true"/>Stop recording</Button><Button type="button" variant="ghost" onClick={()=>{discardRecording.current=true;recordingFailure.current='Recording discarded.';stop();}}>Discard</Button></div>}
    {draft&&<div className="timber-audio-draft"><div><AudioLinesIcon aria-hidden="true"/><span>{draftName}</span><span>{formatTime(durationMs/1000)}</span></div><Player blob={draft} durationMs={durationMs} mimeType={draft.type}/><p>OpenAI API transcription · about $0.003/minute published estimate, billed separately; actual charges may vary. Sending audio also starts your bot.</p><div className="timber-audio-draft-actions"><Button type="button" variant="outline" disabled={busy||sending} onClick={remove}><Trash2Icon aria-hidden="true"/>Cancel audio</Button><Button type="button" disabled={busy||sending||!eligible} onClick={()=>setConsent('send')}>{busy||sending?'Sending…':'Review & send'}</Button></div></div>}
    {error&&<p className="timber-audio-error" role="alert">{error}</p>}
    <AudioConsent open={consent==='send'} onCancel={()=>setConsent(null)} onConfirm={()=>void doSend()}/>
  </div>;
}
