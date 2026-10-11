/** Shared byte preflight, usable before browser WebAudio decoding and on uploads.
 * Pure container/framing validation: no network, worker bindings or codec decoder.
 */
export class AudioValidationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message); this.name = 'AudioValidationError';
  }
}

export const MAX_AUDIO_BYTES = 20_000_000;
export const MAX_AUDIO_DURATION_MS = 600_000;
export type SupportedAudioMime = 'audio/wav' | 'audio/mpeg' | 'audio/webm';
export interface ValidatedAudio {mimeType: SupportedAudioMime; durationMs: number; extension: string}

// Deliberately container/framing validators, not codec decoders. No metadata
// duration, bitrate estimate, decompression, allocation from a declared length,
// or scan-for-next-magic recovery is used. Unsupported features fail closed.
function invalid(): never {throw new AudioValidationError(400, 'invalid_audio', 'Unsupported, ambiguous or malformed audio.');}
function check(ok: unknown): asserts ok {if (!ok) invalid();}
function duration(ms: number): number {
  check(Number.isFinite(ms) && ms > 0);
  if (ms > MAX_AUDIO_DURATION_MS) throw new AudioValidationError(400, 'audio_too_long', 'Audio must be at most 10 minutes.');
  return Math.ceil(ms);
}
class Bytes {
  readonly view: DataView;
  constructor(readonly b: Uint8Array) {this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);}
  range(p: number, n: number, end = this.b.length): void {check(Number.isSafeInteger(p) && Number.isSafeInteger(n) && p >= 0 && n >= 0 && p <= end && n <= end - p);}
  str(p: number, n: number): string {this.range(p, n); let s = ''; for (let i = p; i < p + n; i++) s += String.fromCharCode(this.b[i]); return s;}
  u16(p: number, le = false): number {this.range(p, 2); return this.view.getUint16(p, le);}
  u32(p: number, le = false): number {this.range(p, 4); return this.view.getUint32(p, le);}
}
function mime(contentType: string): SupportedAudioMime {
  check(typeof contentType === 'string' && contentType.length <= 128);
  const match = /^\s*(audio\/[a-z0-9-]+)\s*(?:;\s*codecs\s*=\s*(?:"([a-z0-9., -]+)"|([a-z0-9.,-]+))\s*)?$/i.exec(contentType);
  check(match);
  const type = match[1].toLowerCase(), codec = (match[2] ?? match[3])?.toLowerCase();
  const aliases: Record<string, SupportedAudioMime> = {'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/wav', 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg', 'audio/webm': 'audio/webm'};
  const canonical = aliases[type]; check(canonical);
  check(!codec || (canonical === 'audio/webm' && codec === 'opus'));
  return canonical;
}
export function validateAudio(bytes: Uint8Array, contentType: string): ValidatedAudio {
  check(bytes instanceof Uint8Array && bytes.length > 0);
  if (bytes.length > MAX_AUDIO_BYTES) throw new AudioValidationError(413, 'audio_too_large', 'Audio must be at most 20 MB.');
  const mimeType = mime(contentType), r = new Bytes(bytes);
  const parsers: Record<SupportedAudioMime, (r: Bytes) => number> = {'audio/wav': wav, 'audio/mpeg': mp3, 'audio/webm': webm};
  return {mimeType, durationMs: duration(parsers[mimeType](r)), extension: {'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/webm': 'webm'}[mimeType]};
}

function wav(r: Bytes): number {
  check(r.str(0, 4) === 'RIFF' && r.str(8, 4) === 'WAVE' && r.u32(4, true) === r.b.length - 8);
  let pos = 12, rate = 0, align = 0, data = -1, chunks = 0;
  while (pos < r.b.length) {
    check(++chunks <= 4096); r.range(pos, 8);
    const type = r.str(pos, 4), size = r.u32(pos + 4, true), start = pos + 8;
    r.range(start, size + (size & 1));
    if (size & 1) check(r.b[start + size] === 0);
    if (type === 'fmt ') {
      check(!rate && data < 0 && (size === 16 || (size === 18 && r.u16(start + 16, true) === 0)));
      const channels = r.u16(start + 2, true); rate = r.u32(start + 4, true); align = channels * 2;
      check(r.u16(start, true) === 1 && (channels === 1 || channels === 2) && rate >= 8000 && rate <= 192000 && r.u16(start + 14, true) === 16 && r.u16(start + 12, true) === align && r.u32(start + 8, true) === rate * align);
    } else if (type === 'data') {
      check(rate && data < 0 && size > 0 && size % align === 0); data = size;
    } else {
      check(type === 'JUNK' || type === 'PAD ' || type === 'LIST');
      if (type === 'LIST') {
        check(size >= 4 && r.str(start, 4) === 'INFO'); let q = start + 4, entries = 0;
        while (q < start + size) {
          check(++entries <= 4096); r.range(q, 8, start + size); check(/^I[A-Z0-9 ]{3}$/.test(r.str(q, 4)));
          const len = r.u32(q+4, true); r.range(q+8, len + (len & 1), start + size);
          if (len & 1) check(r.b[q+8+len] === 0); q += 8 + len + (len & 1);
        }
      }
    }
    pos = start + size + (size & 1);
  }
  check(pos === r.b.length && rate && data > 0);
  return data / align / rate * 1000;
}

function id3(r: Bytes): number {
  if (r.b.length < 3 || r.str(0, 3) !== 'ID3') return 0;
  r.range(0, 10); const version = r.b[3];
  check((version === 3 || version === 4) && r.b[4] === 0 && r.b[5] === 0);
  function sync(p: number): number {r.range(p, 4); check(!(r.b[p] & 128) && !(r.b[p+1] & 128) && !(r.b[p+2] & 128) && !(r.b[p+3] & 128)); return r.b[p] * 2097152 + r.b[p+1] * 16384 + r.b[p+2] * 128 + r.b[p+3];}
  const size = sync(6); check(size <= 65536); const end = 10 + size; r.range(10, size);
  let p = 10;
  while (p < end) {
    if (r.b[p] === 0) {for (; p < end; p++) check(r.b[p] === 0); break;}
    r.range(p, 10, end); check(/^[A-Z0-9]{4}$/.test(r.str(p, 4)) && r.u16(p + 8) === 0);
    const n = version === 4 ? sync(p + 4) : r.u32(p + 4); check(n > 0); r.range(p + 10, n, end); p += 10 + n;
  }
  return end;
}
function mp3Side(r: Bytes, start: number, size: number, mpeg1: boolean, mono: boolean): {back: number; used: number} {
  let bit = start * 8;
  function bits(n: number): number {check(bit + n <= (start + size) * 8); let v = 0; for (let i = 0; i < n; i++, bit++) v = v * 2 + ((r.b[bit >>> 3] >>> (7 - (bit & 7))) & 1); return v;}
  const channels = mono ? 1 : 2, back = bits(mpeg1 ? 9 : 8); bits(mpeg1 ? (mono ? 5 : 3) : (mono ? 1 : 2));
  if (mpeg1) bits(4 * channels);
  let used = 0;
  function table(): void {const t = bits(5); check(t !== 4 && t !== 14);}
  for (let gr = 0; gr < (mpeg1 ? 2 : 1); gr++) for (let channel = 0; channel < channels; channel++) {
    used += bits(12); check(bits(9) <= 288); bits(8); bits(mpeg1 ? 4 : 9);
    if (bits(1)) {check(bits(2) !== 0); bits(1); table(); table(); bits(9);}
    else {table(); table(); table(); const region0 = bits(4), region1 = bits(3); check(region0 + region1 <= 20);}
    if (mpeg1) bits(1); bits(1); bits(1);
  }
  check(bit === (start + size) * 8); return {back, used};
}
function mp3(r: Bytes): number {
  let p = id3(r), end = r.b.length, frames = 0, samples = 0, rate = 0, streamKey = -1, reservoir = 0;
  if (end - p >= 128 && r.str(end - 128, 3) === 'TAG') end -= 128;
  const br1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
  const br2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  while (p < end) {
    r.range(p, 4, end); const h = r.u32(p), version = (h >>> 19) & 3, layer = (h >>> 17) & 3, bitrate = (h >>> 12) & 15, sr = (h >>> 10) & 3, mode = (h >>> 6) & 3;
    check((h >>> 21) === 0x7ff && version !== 1 && layer === 1 && bitrate > 0 && bitrate < 15 && sr < 3 && (h & 3) !== 2);
    const sampleRate = [44100,48000,32000][sr] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const key = (version << 8) | (sr << 4) | (mode === 3 ? 1 : 2);
    if (streamKey < 0) {streamKey = key; rate = sampleRate;} else check(streamKey === key);
    const size = Math.floor((version === 3 ? 144000 : 72000) * (version === 3 ? br1 : br2)[bitrate] / sampleRate) + ((h >>> 9) & 1);
    const side = version === 3 ? (mode === 3 ? 17 : 32) : (mode === 3 ? 9 : 17), crc = ((h >>> 16) & 1) ? 0 : 2;
    check(size > 4 + crc + side); r.range(p, size, end);
    // Reject protected streams rather than silently ignoring their CRC, and
    // reject a truncated reservoir-dependent beginning.
    check(crc === 0);
    const {back, used} = mp3Side(r, p+4, side, version === 3, mode === 3);
    const available = back + size - 4 - side;
    check(back <= reservoir && used <= available * 8);
    reservoir = Math.min(version === 3 ? 511 : 255, Math.floor((available * 8 - used) / 8));
    // Seek/gapless headers alter presentation duration. Do not guess trim.
    const payload = p + 4 + crc + side;
    check(!['Xing', 'Info'].includes(r.str(payload, 4)));
    if (size >= 40) check(r.str(p + 36, 4) !== 'VBRI');
    samples += version === 3 ? 1152 : 576; check(++frames <= 100000);
    duration(samples / rate * 1000); p += size;
  }
  check(frames > 0 && p === end); return samples / rate * 1000;
}

function opusHead(r: Bytes, start: number, size: number): {channels: number; preSkip: number} {
  check(size === 19 && r.str(start, 8) === 'OpusHead' && r.b[start+8] === 1 && (r.b[start+9] === 1 || r.b[start+9] === 2) && r.b[start+18] === 0);
  return {channels: r.b[start+9], preSkip: r.u16(start+10, true)};
}
function opusSamples(packet: Uint8Array): number {
  check(packet.length >= 1 && packet.length <= 65536);
  const config = packet[0] >>> 3, code = packet[0] & 3;
  const frameSamples = config >= 16 ? 120 * 2 ** (config & 3) : config >= 12 ? 480 * 2 ** (config & 1) : (config & 3) === 3 ? 2880 : 480 * 2 ** (config & 3);
  let p = 1, end = packet.length, count = code === 0 ? 1 : 2;
  function length(): number {check(p < end); const x = packet[p++]; if (x < 252) return x; check(p < end); return x + 4 * packet[p++];}
  const lengths: number[] = [];
  if (code === 0) lengths.push(end - p);
  if (code === 1) {check((end - p) % 2 === 0); lengths.push((end - p) / 2, (end - p) / 2);}
  if (code === 2) {const n = length(); lengths.push(n, end - p - n);}
  if (code === 3) {
    check(p < end); const flags = packet[p++]; count = flags & 63; check(count > 0 && count <= 48);
    if (flags & 64) {let padding = 0, x: number; do {check(p < end); x = packet[p++]; padding += x === 255 ? 254 : x; check(padding <= end - p);} while (x === 255); end -= padding;}
    if (flags & 128) {let used = 0; for (let i = 0; i < count - 1; i++) {const n = length(); used += n; lengths.push(n);} lengths.push(end - p - used);}
    else {check((end - p) % count === 0); for (let i = 0; i < count; i++) lengths.push((end - p) / count);}
  }
  check(lengths.every(n => n >= 0 && n <= 1275) && count * frameSamples <= 5760);
  return count * frameSamples;
}
interface Element {id: number; start: number; end: number; unknown: boolean}
function vint(r: Bytes, p: number, end: number, id = false): {value: number; next: number; unknown: boolean} {
  r.range(p, 1, end); const first = r.b[p]; check(first !== 0);
  let len = 1, mask = 128; while (!(first & mask)) {mask >>>= 1; len++;}
  check(len <= (id ? 4 : 8)); r.range(p, len, end);
  let n = BigInt(id ? first : first & (mask - 1)); for (let i = 1; i < len; i++) n = (n << 8n) | BigInt(r.b[p+i]);
  const unknown = !id && n === (1n << BigInt(7 * len)) - 1n;
  check(unknown || n <= BigInt(Number.MAX_SAFE_INTEGER)); return {value: unknown ? 0 : Number(n), next: p + len, unknown};
}
function element(r: Bytes, p: number, end: number): Element {
  const id = vint(r, p, end, true), size = vint(r, id.next, end); if (!size.unknown) r.range(size.next, size.value, end);
  return {id: id.value, start: size.next, end: size.unknown ? end : size.next + size.value, unknown: size.unknown};
}
function elements(r: Bytes, start: number, end: number, allowed: number[]): Map<number, Element> {
  const out = new Map<number, Element>(); let count = 0;
  for (let p = start; p < end;) {check(++count <= 4096); const e = element(r, p, end); check(!e.unknown && allowed.includes(e.id)); if (e.id !== 0xec) {check(!out.has(e.id)); out.set(e.id, e);} p = e.end;}
  return out;
}
function uint(r: Bytes, e: Element | undefined, fallback?: number): number {
  if (!e) {check(fallback !== undefined); return fallback;}
  const n = e.end - e.start; check(n > 0 && n <= 8); let v = 0n; for (let p = e.start; p < e.end; p++) v = (v << 8n) | BigInt(r.b[p]); check(v <= BigInt(Number.MAX_SAFE_INTEGER)); return Number(v);
}
function float(r: Bytes, e: Element): number {const n = e.end - e.start; check(n === 4 || n === 8); const x = n === 4 ? r.view.getFloat32(e.start) : r.view.getFloat64(e.start); check(Number.isFinite(x)); return x;}
function text(r: Bytes, e: Element | undefined): string {check(e && e.end - e.start <= 256); return r.str(e.start, e.end - e.start);}
function seekHead(r: Bytes, e: Element, offsets: Map<number, number>): void {
  let count = 0; const ids = new Set<number>();
  for (let p = e.start; p < e.end;) {
    check(++count <= 4096); const seek = element(r, p, e.end); check(!seek.unknown && seek.id === 0x4dbb);
    const fields = elements(r, seek.start, seek.end, [0x53ab,0x53ac]); const target = fields.get(0x53ab); check(target);
    const targetId = vint(r, target.start, target.end, true); check(targetId.next === target.end && !ids.has(targetId.value)); ids.add(targetId.value);
    check([0x1549a966,0x1654ae6b,0x1f43b675,0x1c53bb6b].includes(targetId.value) && offsets.get(uint(r, fields.get(0x53ac))) === targetId.value);
    p = seek.end;
  }
  check(count > 0);
}
function cues(r: Bytes, e: Element, segmentStart: number, track: number, clusters: Map<number, {time: number; relative: number}>): void {
  let count = 0, last = -1;
  for (let p = e.start; p < e.end;) {
    check(++count <= 100000); const point = element(r, p, e.end); check(!point.unknown && point.id === 0xbb);
    const c = elements(r, point.start, point.end, [0xb3,0xb7]); const time = uint(r, c.get(0xb3)); check(time >= last); last = time;
    const positions = c.get(0xb7); check(positions); const t = elements(r, positions.start, positions.end, [0xf7,0xf1,0xf0,0x5378]);
    check(uint(r, t.get(0xf7)) === track && uint(r, t.get(0x5378), 1) === 1);
    const offset = uint(r, t.get(0xf1)); check(offset < r.b.length - segmentStart); const cluster = clusters.get(offset); check(cluster && cluster.time === time);
    if (t.has(0xf0)) check(uint(r, t.get(0xf0)) === cluster.relative);
    p = point.end;
  }
  check(count > 0);
}
function webm(r: Bytes): number {
  const header = element(r, 0, r.b.length); check(header.id === 0x1a45dfa3 && !header.unknown);
  const h = elements(r, header.start, header.end, [0x4286,0x42f7,0x42f2,0x42f3,0x4282,0x4287,0x4285,0xec]);
  check(text(r, h.get(0x4282)) === 'webm' && uint(r, h.get(0x4286), 1) === 1 && uint(r, h.get(0x42f7), 1) === 1 && uint(r, h.get(0x42f2), 4) === 4 && uint(r, h.get(0x42f3), 8) === 8 && uint(r, h.get(0x4287), 1) >= 1 && uint(r, h.get(0x4287), 1) <= 4 && uint(r, h.get(0x4285), 1) >= 1 && uint(r, h.get(0x4285), 1) <= 2);
  const segment = element(r, header.end, r.b.length); check(segment.id === 0x18538067 && segment.end === r.b.length);
  let p = segment.start, scale = 1000000, track = 0, preSkip = 0, total = 0, firstTime = -1, lastStart = -1, maxEnd = 0, maxPacketMs = 0, declaredDurationMs: number | undefined, clusters = 0, count = 0, haveInfo = false, haveTracks = false, haveCues = false;
  const clusterOffsets = new Map<number, {time: number; relative: number}>(), topOffsets = new Map<number, number>(); let seeks: Element | undefined;
  const top = [0x114d9b74,0x1549a966,0x1654ae6b,0x1f43b675,0x1c53bb6b,0xec];
  while (p < segment.end) {
    check(++count <= 200000); const e = element(r, p, segment.end); check(top.includes(e.id)); topOffsets.set(p - segment.start, e.id);
    if (e.id === 0x114d9b74) {check(!e.unknown && !seeks); seeks = e;}
    else if (e.id === 0x1549a966) {
      check(!e.unknown && !haveInfo && !clusters); haveInfo = true;
      const info = elements(r, e.start, e.end, [0x2ad7b1,0x4d80,0x5741,0x4489,0x73a4,0x4461,0xec]); scale = uint(r, info.get(0x2ad7b1), 1000000); check(scale >= 1000 && scale <= 1000000);
      if (info.has(0x4489)) {
        declaredDurationMs = float(r, info.get(0x4489)!) * scale / 1000000;
        check(declaredDurationMs > 0);
        // Native decoders may allocate from Duration even though we do not.
        // Apply the hard limit before allowing these bytes to reach a decoder.
        if (declaredDurationMs > MAX_AUDIO_DURATION_MS) duration(declaredDurationMs);
      }
    } else if (e.id === 0x1654ae6b) {
      check(!e.unknown && !haveTracks && !clusters); haveTracks = true;
      const tracks = elements(r, e.start, e.end, [0xae,0xec]); const entry = tracks.get(0xae); check(entry);
      const t = elements(r, entry.start, entry.end, [0xd7,0x73c5,0x83,0xb9,0x88,0x55aa,0x9c,0x22b59c,0x86,0x63a2,0x56aa,0x56bb,0xe1,0x536e,0xec]);
      track = uint(r, t.get(0xd7)); check(track > 0 && track <= 126 && uint(r, t.get(0x83)) === 2 && uint(r, t.get(0xb9), 1) === 1 && uint(r, t.get(0x9c), 1) <= 1 && text(r, t.get(0x86)) === 'A_OPUS');
      const privateData = t.get(0x63a2); check(privateData); const head = opusHead(r, privateData.start, privateData.end - privateData.start); preSkip = head.preSkip;
      const delay = uint(r, t.get(0x56aa), 0); check(delay === preSkip * 1000000000 / 48000 && uint(r, t.get(0x56bb), 80000000) <= 1000000000);
      const audio = t.get(0xe1); check(audio); const a = elements(r, audio.start, audio.end, [0xb5,0x9f,0x6264,0x78b5,0xec]);
      check(a.has(0xb5) && float(r, a.get(0xb5)!) === 48000 && uint(r, a.get(0x9f), 1) === head.channels);
      if (a.has(0x78b5)) check(float(r, a.get(0x78b5)!) === 48000);
      if (a.has(0x6264)) check([16, 32].includes(uint(r, a.get(0x6264))));
    } else if (e.id === 0x1f43b675) {
      check(haveInfo && haveTracks && !haveCues && ++clusters <= 100000); let q = e.start, time = -1, blocks = 0, firstBlock = -1;
      while (q < e.end) {
        const c = element(r, q, e.end);
        if (e.unknown && top.includes(c.id) && c.id !== 0xec) break;
        check(!c.unknown && ++count <= 200000);
        if (c.id === 0xe7) {check(time < 0 && !blocks); time = uint(r, c);}
        else if (c.id === 0xa3) {
          check(time >= 0); if (!blocks) firstBlock = q - e.start; const tr = vint(r, c.start, c.end); check(!tr.unknown && tr.value === track); r.range(tr.next, 3, c.end);
          const relative = r.view.getInt16(tr.next), flags = r.b[tr.next+2]; check((flags & 0x7f) === 0);
          const timestamp = (time + relative) * scale / 1000000; check(timestamp >= 0 && Number.isSafeInteger(time + relative));
          const samples = opusSamples(r.b.subarray(tr.next + 3, c.end));
          // Chromium capture-clock jitter can overlap encoded packet ends.
          // Order packet starts instead; sample totals still bound decode work.
          if (firstTime < 0) {firstTime = timestamp; check(firstTime <= scale / 1000000);} else check(timestamp >= lastStart);
          // Positive capture gaps are part of the media timeline, not silently
          // discarded. Bound both decoded samples and the packet-end timeline.
          lastStart = timestamp; maxEnd = Math.max(maxEnd, timestamp + samples / 48);
          maxPacketMs = Math.max(maxPacketMs, samples / 48); total += samples;
          duration(Math.max(1, Math.max(total / 48, maxEnd) - preSkip / 48)); blocks++;
        } else check(c.id === 0xec);
        q = c.end;
      }
      check(time >= 0 && blocks > 0); clusterOffsets.set(p - segment.start, {time, relative: firstBlock}); p = q; continue;
    } else if (e.id === 0x1c53bb6b) {
      check(!e.unknown && clusters > 0 && !haveCues); haveCues = true; cues(r, e, segment.start, track, clusterOffsets);
    } else check(!e.unknown);
    p = e.end;
  }
  check(clusters > 0 && total > preSkip); if (seeks) seekHead(r, seeks, topOffsets);
  const encodedDurationMs = Math.max(total / 48, maxEnd);
  if (declaredDurationMs !== undefined) {
    // Matroska Duration is in timecode ticks; Opus presentation may subtract
    // CodecDelay (pre-skip), and recorders may report the final packet start
    // rather than its end. Permit at most one actual maximum packet + delay +
    // one timecode tick of rounding, never an unbounded metadata discrepancy.
    check(Math.abs(declaredDurationMs - encodedDurationMs) <= maxPacketMs + preSkip / 48 + scale / 1000000);
  }
  return encodedDurationMs - preSkip / 48;
}

// Ogg/M4A are intentionally outside the admitted provider-compatible subset.
