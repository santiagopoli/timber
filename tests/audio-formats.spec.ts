import {describe, expect, it} from 'vitest';
import {MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_MS, validateAudio} from '../apps/api/src/audio-formats';
import {AudioValidationError, validateAudio as preflightAudio} from '../packages/contracts/src/audio-validation';
import {ApiError} from '../apps/api/src/errors';

const ascii = (s: string) => new TextEncoder().encode(s);
function concat(...parts: Uint8Array[]): Uint8Array {const out = new Uint8Array(parts.reduce((n, x) => n+x.length, 0)); let p = 0; for (const part of parts) {out.set(part, p); p += part.length;} return out;}
function num(n: number, size: number, little = false): Uint8Array {const b = new Uint8Array(size); let x = BigInt(n); for (let i = 0; i < size; i++) {b[little ? i : size-1-i] = Number(x & 255n); x >>= 8n;} return b;}
function patch(b: Uint8Array, at: number, value: number, size = 4, little = false): Uint8Array {const out = b.slice(); out.set(num(value, size, little), at); return out;}
const rejects = (b: Uint8Array, mime: string) => expect(() => validateAudio(b, mime)).toThrowError(expect.objectContaining({code: 'invalid_audio', status: 400}));
function chunk(type: string, data: Uint8Array): Uint8Array {return concat(ascii(type), num(data.length, 4, true), data, data.length % 2 ? num(0, 1) : new Uint8Array());}
function riff(...chunks: Uint8Array[]): Uint8Array {const body = concat(ascii('WAVE'), ...chunks); return concat(ascii('RIFF'), num(body.length, 4, true), body);}
function wav(channels = 1, rate = 8000, samples = 8): Uint8Array {
  return riff(chunk('fmt ', concat(num(1,2,true), num(channels,2,true), num(rate,4,true), num(rate*channels*2,4,true), num(channels*2,2,true), num(16,2,true))), chunk('data', new Uint8Array(samples*channels*2)));
}
function bitPatch(b: Uint8Array, bit: number, count: number, value: number): Uint8Array {
  const out = b.slice(); for (let i = 0; i < count; i++) {const at = bit+i, mask = 1 << (7-(at & 7)); out[at >>> 3] = (out[at >>> 3] & ~mask) | (((value >>> (count-1-i)) & 1) ? mask : 0);} return out;
}
function mp3Frame(options: {version?: number; bitrate?: number; sr?: number; mode?: number; padding?: number} = {}): Uint8Array {
  const version = options.version ?? 3, bitrate = options.bitrate ?? 9, sr = options.sr ?? 0, mode = options.mode ?? 3, padding = options.padding ?? 0;
  const rate = [44100,48000,32000][sr] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const br = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrate];
  const size = Math.floor((version === 3 ? 144000 : 72000)*br/rate)+padding;
  const b = new Uint8Array(size); b.set(num((0xffe00000 | (version<<19) | (1<<17) | (1<<16) | (bitrate<<12) | (sr<<10) | (padding<<9) | (mode<<6)) >>> 0,4)); return b;
}
const opus = new Uint8Array([0xf8,0xff,0xfe]); // 20ms, one opaque codec frame
function head(channels = 1, preSkip = 312): Uint8Array {return concat(ascii('OpusHead'), num(1,1), num(channels,1), num(preSkip,2,true), num(48000,4,true), num(0,2), num(0,1));}
const tags = concat(ascii('OpusTags'), num(0,4,true), num(0,4,true));
function crc(bytes: Uint8Array): number {let x = 0; for (const byte of bytes) {x ^= byte << 24; for (let i = 0; i < 8; i++) x = (x << 1) ^ (x < 0 ? 0x04c11db7 : 0);} return x >>> 0;}
function page(seq: number, flags: number, granule: number, packets: Uint8Array[]): Uint8Array {
  const body = concat(...packets), laces = packets.flatMap(p => [...Array(Math.floor(p.length/255)).fill(255), p.length%255]);
  const out = concat(ascii('OggS'),num(0,1),num(flags,1),num(granule,8,true),num(42,4,true),num(seq,4,true),num(0,4),num(laces.length,1),new Uint8Array(laces),body);
  out.set(num(crc(out),4,true),22); return out;
}
function ogg(audio: Uint8Array[] = [opus, opus], options: {granule?: number; preSkip?: number} = {}): Uint8Array {return concat(page(0,2,0,[head(1,options.preSkip)]), page(1,0,0,[tags]), page(2,4,options.granule ?? audio.length*960,audio));}
function id(n: number): Uint8Array {const len = n > 0xffffff ? 4 : n > 0xffff ? 3 : n > 0xff ? 2 : 1; return num(n,len);}
function size(n: number): Uint8Array {for (let len = 1; len <= 8; len++) if (n < 2 ** (7*len)-1) return num(n + 2 ** (7*len),len); throw new Error('fixture size');}
function el(n: number, data: Uint8Array, unknown = false): Uint8Array {return concat(id(n), unknown ? new Uint8Array([0x01,255,255,255,255,255,255,255]) : size(data.length), data);}
function uel(n: number, value: number): Uint8Array {const len = value <= 255 ? 1 : value <= 65535 ? 2 : value <= 0xffffff ? 3 : 4; return el(n,num(value,len));}
function fel(n: number, value: number): Uint8Array {const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0,value); return el(n,b);}
const ebml = el(0x1a45dfa3,concat(uel(0x4286,1),uel(0x42f7,1),uel(0x42f2,4),uel(0x42f3,8),el(0x4282,ascii('webm')),uel(0x4287,4),uel(0x4285,2)));
function info(scale = 1000000, declaredDuration?: number): Uint8Array {return el(0x1549a966, concat(uel(0x2ad7b1,scale),...(declaredDuration === undefined ? [] : [fel(0x4489,declaredDuration)]),el(0x4d80,ascii('Chrome')),el(0x5741,ascii('Chrome'))));}
function tracks(options: {channels?: number; codec?: string; privateData?: Uint8Array; extra?: Uint8Array; duplicate?: boolean; type?: number; delay?: number; bitDepth?: number; lacing?: number} = {}): Uint8Array {
  const channels = options.channels ?? 1;
  const entry = el(0xae,concat(uel(0xd7,1),uel(0x73c5,1),uel(0x83,options.type ?? 2),uel(0x9c,options.lacing ?? 0),el(0x86,ascii(options.codec ?? 'A_OPUS')),el(0x63a2,options.privateData ?? head(channels)),uel(0x56aa,options.delay ?? 6500000),uel(0x56bb,80000000),el(0xe1,concat(fel(0xb5,48000),uel(0x9f,channels),...(options.bitDepth ? [uel(0x6264,options.bitDepth)] : []))),options.extra ?? new Uint8Array()));
  return el(0x1654ae6b,concat(entry,...(options.duplicate ? [entry] : [])));
}
function block(timestamp: number, packet = opus, flags = 128, track = 1): Uint8Array {return el(0xa3,concat(new Uint8Array([128|track]),num(timestamp & 0xffff,2),num(flags,1),packet));}
function cluster(time: number, blocks: Uint8Array[], unknown = false): Uint8Array {return el(0x1f43b675,concat(uel(0xe7,time),...blocks),unknown);}
function webm(options: {unknownSegment?: boolean; unknownCluster?: boolean; info?: Uint8Array; tracks?: Uint8Array; clusters?: Uint8Array[]} = {}): Uint8Array {
  return concat(ebml,el(0x18538067,concat(options.info ?? info(),options.tracks ?? tracks(),...(options.clusters ?? [cluster(0,[block(0),block(20)],options.unknownCluster)])),options.unknownSegment));
}

describe('bounded strict audio container validation', () => {
  it('exports exact limits, rejects empty/oversized bytes before parsing', () => {
    expect(MAX_AUDIO_BYTES).toBe(20_000_000); expect(MAX_AUDIO_DURATION_MS).toBe(600_000);
    rejects(new Uint8Array(),'audio/wav');
    expect(() => validateAudio(new Uint8Array(MAX_AUDIO_BYTES+1),'audio/wav')).toThrowError(expect.objectContaining({code:'audio_too_large',status:413}));
  });
  it('checks MIME+magic, canonicalizes only explicit audio aliases and codecs', () => {
    expect(validateAudio(wav(),'Audio/X-Wav').mimeType).toBe('audio/wav');
    expect(validateAudio(mp3Frame(),'audio/mp3').extension).toBe('mp3');
    expect(validateAudio(webm(),'audio/webm;codecs=opus').mimeType).toBe('audio/webm');
    for (const mime of ['application/octet-stream','video/webm','audio/wave','audio/wav; codecs=pcm','audio/webm;codecs="opus,vp8"','audio/webm;codecs=vorbis','audio/wav; charset=binary','audio/wav;','audio/webm; codecs=opus;codecs=opus']) rejects(wav(),mime);
    const fixtures: [string,Uint8Array][] = [['audio/wav',wav()],['audio/mpeg',mp3Frame()],['audio/webm',webm()]];
    for (const [mime,b] of fixtures) for (const [other] of fixtures) if (other !== mime) rejects(b,other);
  });
  it('shares byte-for-byte validation results between pure browser preflight and API', () => {
    for (const [mime,b] of [['audio/wav',wav()],['audio/mpeg',mp3Frame()],['audio/webm',webm()]] as const) expect(preflightAudio(b,mime)).toEqual(validateAudio(b,mime));
  });
  it('exposes portable typed validation errors and maps only those to the API envelope', () => {
    for (const [b,mime,code,status] of [[new Uint8Array(),'audio/wav','invalid_audio',400],[new Uint8Array(MAX_AUDIO_BYTES+1),'audio/webm','audio_too_large',413],[webm({clusters:[cluster(0,[block(0)]),cluster(600001,[block(0)])]}),'audio/webm','audio_too_long',400]] as const) {
      expect(() => preflightAudio(b,mime)).toThrowError(AudioValidationError);
      expect(() => preflightAudio(b,mime)).toThrowError(expect.objectContaining({code,status,name:'AudioValidationError'}));
      expect(() => validateAudio(b,mime)).toThrowError(ApiError);
      expect(() => validateAudio(b,mime)).toThrowError(expect.objectContaining({code,status}));
    }
  });
  it('works on nonzero-offset Uint8Arrays and does not mutate input', () => {
    for (const [mime,b] of [['audio/wav',wav()],['audio/mpeg',mp3Frame()],['audio/webm',webm()]] as const) {
      const buffer = concat(num(123,1),b,num(123,1)), original = buffer.slice();
      expect(validateAudio(buffer.subarray(1,-1),mime).durationMs).toBeGreaterThan(0); expect(buffer).toEqual(original);
    }
  });
  it('rejects all truncated WAV, Ogg and known-length WebM prefixes', () => {
    for (const [mime,b] of [['audio/wav',wav()],['audio/webm',webm()]] as const) for (let n = 0; n < b.length; n++) rejects(b.subarray(0,n),mime);
  });
  it('never throws native range errors on hostile random/truncated bytes', () => {
    let state = 0x12345678;
    for (let i = 0; i < 100; i++) {const b = new Uint8Array(i); for (let p = 0; p < b.length; p++) {state ^= state<<13; state ^= state>>>17; state ^= state<<5; b[p] = state & 255;} for (const mime of ['audio/wav','audio/mpeg','audio/ogg','audio/webm','audio/mp4']) rejects(b,mime);}
  });
});

describe('PCM16 full RIFF WAV subset', () => {
  it('derives exact rounded duration from mono/stereo PCM byte count', () => {
    expect(validateAudio(wav(),'audio/wav')).toEqual({mimeType:'audio/wav',durationMs:1,extension:'wav'});
    expect(validateAudio(wav(2,48000,481),'audio/wav').durationMs).toBe(11);
  });
  it('accepts bounded padding and fully framed LIST INFO metadata', () => {
    const base = wav(), fmt = base.subarray(12,36), data = base.subarray(36);
    expect(validateAudio(riff(chunk('JUNK',num(1,1)),fmt,chunk('LIST',concat(ascii('INFO'),chunk('INAM',ascii('x\0')))),data),'audio/wav').durationMs).toBe(1);
    const extended = concat(fmt.subarray(0,4),num(18,4,true),fmt.subarray(8),num(0,2));
    expect(validateAudio(riff(extended,data),'audio/wav').durationMs).toBe(1);
  });
  it('rejects lying sizes/rates, compressed/extensible PCM, duplicates, trailing bytes and nested invalid chunks', () => {
    const b = wav(), fmt = b.subarray(12,36), data = b.subarray(36);
    for (const bad of [patch(b,4,0xffffffff,4,true),patch(b,16,0xffffffff,4,true),patch(b,20,3,2,true),patch(b,22,3,2,true),patch(b,24,0,4,true),patch(b,28,1,4,true),patch(b,32,1,2,true),patch(b,34,24,2,true),riff(data,fmt),riff(fmt,fmt,data),riff(fmt,data,data),riff(fmt,chunk('data',num(1,1))),riff(fmt,chunk('fact',num(1,4)),data),riff(fmt,chunk('LIST',ascii('wavl')),data),riff(fmt,chunk('LIST',ascii('INFOx')),data),concat(b,num(0,1))]) rejects(bad,'audio/wav');
  });
  it('bounds playable duration independently from bytes (10 minute exact boundary)', () => {
    const exact = wav(1,8000,8000*600);
    expect(validateAudio(exact,'audio/wav').durationMs).toBe(600000);
    expect(() => validateAudio(wav(1,8000,8000*600+1),'audio/wav')).toThrowError(expect.objectContaining({code:'audio_too_long'}));
  });
});

describe('full MPEG Layer III frame-stream subset', () => {
  it('scans complete MPEG1/2/2.5 CBR/VBR streams, not a bitrate estimate', () => {
    expect(validateAudio(concat(mp3Frame(),mp3Frame({bitrate:10,padding:1})),'audio/mpeg').durationMs).toBe(53);
    expect(validateAudio(mp3Frame({version:2}),'audio/mpeg').durationMs).toBe(27);
    expect(validateAudio(mp3Frame({version:0}),'audio/mpeg').durationMs).toBe(53);
  });
  it('supports bounded ID3v2.3/2.4 unflagged frames and ID3v1 trailer', () => {
    const frame = concat(ascii('TIT2'),num(2,4),num(0,2),num(0,2));
    for (const version of [3,4]) {
      const id3 = concat(ascii('ID3'),num(version,1),num(0,2),num(frame.length,4),frame);
      const id1 = concat(ascii('TAG'),new Uint8Array(125));
      expect(validateAudio(concat(id3,mp3Frame(),id1),'audio/mpeg').durationMs).toBe(27);
    }
  });
  it('rejects truncation, junk/recovery, non-LayerIII, free bitrate, protected CRC, inconsistent streams and missing reservoir', () => {
    const b = mp3Frame(); for (let n = 0; n < b.length; n++) rejects(b.subarray(0,n),'audio/mpeg');
    for (const bad of [concat(b,num(0,1)),concat(num(0,1),b),patch(b,0,0,4),patch(b,2,0,1),patch(b,1,0xfd,1),patch(b,1,0xfa,1),patch(b,4,255,1),concat(b,mp3Frame({sr:1})),concat(b,mp3Frame({mode:0})),concat(b,new Uint8Array(4),b)]) rejects(bad,'audio/mpeg');
  });
  it('validates complete side-information bounds and the interframe bit reservoir', () => {
    const b = mp3Frame(), side = 4*8;
    for (const bad of [bitPatch(b,side+18,12,4095),bitPatch(b,side+30,9,289),bitPatch(b,side+52,5,4),bitPatch(b,side+52,5,14),bitPatch(b,side+51,1,1),bitPatch(bitPatch(b,side+67,4,15),side+71,3,7)]) rejects(bad,'audio/mpeg');
    const back = bitPatch(b,side,9,10); rejects(back,'audio/mpeg');
    expect(validateAudio(concat(b,back),'audio/mpeg').durationMs).toBe(53);
  });
  it('rejects unsupported ID3 flags/sizes/versions and duration-altering seek/gapless metadata', () => {
    const id3 = concat(ascii('ID3'),new Uint8Array([3,0,0,0,0,0,0]));
    for (const bad of [patch(id3,3,2,1),patch(id3,5,128,1),patch(id3,6,128,1),patch(id3,6,0x00040001,4)]) rejects(concat(bad,mp3Frame()),'audio/mpeg');
    for (const name of ['Xing','Info','VBRI']) {const b = mp3Frame(); b.set(ascii(name),name === 'VBRI' ? 36 : 21); rejects(b,'audio/mpeg');}
  });
});

it('rejects even completely framed Ogg Opus: outside provider-compatible subset', () => {
  for (const type of ['audio/ogg','audio/ogg;codecs=opus','audio/ogg;codecs="opus"']) {
    rejects(ogg(),type); expect(() => preflightAudio(ogg(),type)).toThrowError(AudioValidationError);
  }
  for (const type of ['audio/wav','audio/mpeg','audio/webm']) rejects(ogg(),type);
});

describe('streaming single-track WebM Opus subset', () => {
  it('accepts known/unknown Segment+Cluster, continuous multi-cluster capture and canonical MIME', () => {
    for (const unknownSegment of [false,true]) for (const unknownCluster of [false,true]) expect(validateAudio(webm({unknownSegment,unknownCluster}),'audio/webm;codecs=opus')).toEqual({mimeType:'audio/webm',durationMs:34,extension:'webm'});
    expect(validateAudio(webm({unknownSegment:true,clusters:[cluster(0,[block(0)],true),cluster(20,[block(0)],true)]}),'audio/webm').durationMs).toBe(34);
    expect(validateAudio(webm({tracks:tracks({channels:2})}),'audio/webm').durationMs).toBe(34);
  });
  it('supports Chromium Opus capture headers with 32bit output and no pre-skip/delay', () => {
    expect(validateAudio(webm({tracks:tracks({privateData:head(1,0),delay:0,bitDepth:32,lacing:1}),clusters:[cluster(0,[block(0,new Uint8Array([0xfb,3,255,254,255,254,255,254])),block(110,new Uint8Array([0xfb,3,255,254,255,254,255,254]))])]}),'audio/webm').durationMs).toBe(170);
    rejects(webm({tracks:tracks({bitDepth:8})}),'audio/webm');
  });
  it('cross-validates bounded SeekHead and Cues against actual element/block boundaries', () => {
    const cl = cluster(0,[block(0),block(20)]), offset = info().length + tracks().length;
    const cue = (pos = offset, time = 0, relative = 3) => el(0x1c53bb6b,el(0xbb,concat(uel(0xb3,time),el(0xb7,concat(uel(0xf7,1),uel(0xf1,pos),uel(0xf0,relative),uel(0x5378,1))))));
    const seek = (pos = 0, target = 0x1549a966) => el(0x114d9b74,el(0x4dbb,concat(el(0x53ab,id(target)),uel(0x53ac,pos))));
    expect(validateAudio(webm({clusters:[cl,cue(),seek()]}),'audio/webm').durationMs).toBe(34);
    for (const extra of [cue(offset+1),cue(offset,1),cue(offset,0,0),seek(1),seek(0,0x1654ae6b)]) rejects(webm({clusters:[cl,extra]}),'audio/webm');
    rejects(webm({clusters:[cl,cue(),cue()]}),'audio/webm');
  });
  it('derives duration from packets, but bounds and cross-checks optional Duration before native decoding', () => {
    // Encoded duration 40ms; presentation duration 33.5ms after CodecDelay.
    // Metadata can describe either presentation, encoded end or final start.
    for (const declaredDuration of [20,33.5,40,67.5]) expect(validateAudio(webm({info:info(1000000,declaredDuration)}),'audio/webm').durationMs).toBe(34);
    for (const declaredDuration of [-1,0,1,67.501,5000,NaN,Infinity]) rejects(webm({info:info(1000000,declaredDuration)}),'audio/webm');
    for (const declaredDuration of [600000.001,999999999]) expect(() => preflightAudio(webm({info:info(1000000,declaredDuration)}),'audio/webm')).toThrowError(expect.objectContaining({code:'audio_too_long'}));
    rejects(webm({info:info(1000000,0),clusters:[cluster(0,[block(0)])]}),'audio/webm');
    // Duration uses the declared timebase, not assumed milliseconds.
    expect(validateAudio(webm({info:info(1000,40000),clusters:[cluster(0,[block(0),block(20000)])]}),'audio/webm').durationMs).toBe(34);
    rejects(webm({info:info(1000,40),clusters:[cluster(0,[block(0),block(20000)])]}),'audio/webm');
  });
  it('rejects incomplete/trailing elements, impossible EBML lengths and arbitrary unknown-length nested elements', () => {
    const b = webm(); rejects(concat(b,num(0,1)),'audio/webm');
    rejects(concat(ebml,id(0x18538067),new Uint8Array([0])),'audio/webm');
    rejects(concat(ebml,id(0x18538067),new Uint8Array([1,127,255,255,255,255,255,255])),'audio/webm');
    rejects(webm({tracks:el(0x1654ae6b,tracks(),true)}),'audio/webm');
    rejects(webm({clusters:[cluster(0,[el(0xa3,new Uint8Array([0x81,0,0,128,0xf8]),true)])]}),'audio/webm');
  });
  it('rejects video/multiple tracks/unsupported codec, lacing, encryption, CodecDelay mismatch and BlockGroup', () => {
    for (const t of [tracks({type:1}),tracks({duplicate:true}),tracks({codec:'A_VORBIS'}),tracks({privateData:patch(head(),18,1,1)}),tracks({delay:0}),tracks({extra:el(0x6d80,new Uint8Array())})]) rejects(webm({tracks:t}),'audio/webm');
    for (const b of [block(0,opus,130),block(0,opus,129),block(0,opus,136),block(0,opus,128,2),el(0xa0,block(0)),block(0,new Uint8Array([0xfb,0]))]) rejects(webm({clusters:[cluster(0,[b])]}),'audio/webm');
  });
  it('bounds timestamp gaps in duration and rejects backwards starts and malformed timebases', () => {
    for (const blocks of [[block(0),block(20),block(19)],[block(-1)],[block(1000)]]) rejects(webm({clusters:[cluster(0,blocks)]}),'audio/webm');
    expect(validateAudio(webm({clusters:[cluster(0,[block(0),block(40)])]}),'audio/webm').durationMs).toBe(54);
    expect(() => validateAudio(webm({clusters:[cluster(0,[block(0)]),cluster(600001,[block(0)])]}),'audio/webm')).toThrowError(expect.objectContaining({code:'audio_too_long'}));
    rejects(webm({info:info(1000001)}),'audio/webm'); rejects(webm({info:info(1000000,NaN)}),'audio/webm');
  });
  it('accepts Chromium clock jitter with monotonic starts even when packets overlap', () => {
    const packet60 = new Uint8Array([0xfb,3,255,254,255,254,255,254]);
    const starts = [0,60,120,180,240,273,320];
    expect(validateAudio(webm({tracks:tracks({privateData:head(1,0),delay:0}),clusters:[cluster(0,starts.map(t=>block(t,packet60)))]}),'audio/webm').durationMs).toBe(420);
    rejects(webm({clusters:[cluster(0,[block(0),block(20),block(19)])]}),'audio/webm');
  });
  it('retains maximum packet end when variable-duration packets have decreasing ends', () => {
    const packet120 = new Uint8Array([0x1b,2]), packet2point5 = new Uint8Array([0x80]);
    // The 1000ms packet ends at 1120ms, the following packet at 1003.5ms.
    const fixture = webm({clusters:[cluster(0,[block(0),block(1000,packet120),block(1001,packet2point5)])]});
    expect(validateAudio(fixture,'audio/webm').durationMs).toBe(1114);
    expect(preflightAudio(fixture,'audio/webm').durationMs).toBe(1114);
    rejects(webm({info:info(1000000,145),clusters:[cluster(0,[block(0),block(1000,packet120),block(1001,packet2point5)])]}),'audio/webm');
    expect(() => preflightAudio(webm({clusters:[cluster(0,[block(0)]),cluster(599900,[block(0,packet120),block(1,packet2point5)])]}),'audio/webm')).toThrowError(expect.objectContaining({code:'audio_too_long'}));
  });
  it('bounds decoded total independently of overlapping packet timestamps and plausible metadata', () => {
    const packet120 = new Uint8Array([0x1b,2]);
    const fixture = webm({unknownSegment:true,info:info(1000000,600000),clusters:[cluster(0,Array.from({length:5001},(_,i)=>block(i,packet120)))]});
    expect(() => validateAudio(fixture,'audio/webm')).toThrowError(expect.objectContaining({code:'audio_too_long'}));
  });
  it('rejects tiny highly compressed >10-minute captures independent of declared duration', () => {
    // Two 60ms frames with zero-byte DTX bodies; 5001 packets need <60KB.
    const packet = new Uint8Array([0x1b,2]), groups: Uint8Array[] = [];
    for (let start = 0; start < 5001; start += 250) {const blocks = []; for (let i = start; i < Math.min(start+250,5001); i++) blocks.push(block((i-start)*120,packet)); groups.push(cluster(start*120,blocks,true));}
    expect(() => validateAudio(webm({unknownSegment:true,clusters:groups}),'audio/webm')).toThrowError(expect.objectContaining({code:'audio_too_long'}));
  });
});

it('honestly rejects all M4A/MP4 rather than trusting duration-only metadata', () => {
  const fake = concat(num(24,4),ascii('ftyp'),ascii('M4A '),num(0,4),ascii('M4A '),ascii('mp42'));
  for (const mime of ['audio/mp4','audio/x-m4a','audio/mp4;codecs=mp4a.40.2']) rejects(fake,mime);
});
