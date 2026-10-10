import {ApiError} from './errors';

/** Keep base64 plus job snapshots below the SQLite 2 MB row/string limit. */
export const AVATAR_PNG_MAX_BYTES = 1024 * 1024;
export const AVATAR_PNG_MAX_DIMENSION = 1024;
export const AVATAR_PNG_MAX_BASE64 = 4 * Math.ceil(AVATAR_PNG_MAX_BYTES / 3);
export const AVATAR_PNG_MAX_JSON_BYTES = AVATAR_PNG_MAX_BASE64 + 65_536;
const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const tooLarge = (): never => { throw new ApiError(502, 'avatar_image_limit', 'The PNG avatar exceeded the 1 MiB safe durable-storage limit. No automatic retry was attempted.'); };
const invalid = (): never => { throw new ApiError(502, 'avatar_image_invalid', 'The image provider returned an invalid or unsafe PNG avatar. No automatic retry was attempted.'); };
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc(bytes: Uint8Array, start: number, end: number): number {
  let result = 0xffffffff;
  for (let i = start; i < end; i++) result = crcTable[(result ^ bytes[i]) & 255] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
}
/** Canonical base64 only: no URLs, data URIs, whitespace or alternate alphabets. */
function base64Bytes(value: string): Uint8Array {
  if (typeof value === 'string' && value.length > AVATAR_PNG_MAX_BASE64) tooLarge();
  if (typeof value !== 'string' || !value || value.length % 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid();
  let binary = '';
  try { binary = atob(value); } catch { invalid(); }
  if (binary.length > AVATAR_PNG_MAX_BYTES) tooLarge();
  if (btoa(binary) !== value) invalid();
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
/**
 * Validate before journaling AND after journal/R2 reads. Accept only bounded,
 * non-interlaced 8-bit RGB/RGBA PNG. CRCs, chunk order, zlib data, exact decoded
 * size and scanline filters are checked. Ancillary chunks are removed, including
 * metadata, leaving only IHDR/IDAT/IEND; animated PNG is explicitly rejected.
 */
export async function decodeAvatarPng(value: string): Promise<Uint8Array> {
  const bytes = base64Bytes(value);
  if (bytes.length < 57 || !SIGNATURE.every((n, i) => bytes[i] === n)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keep: Uint8Array[] = [SIGNATURE], compressed: Uint8Array[] = [];
  let offset = 8, count = 0, width = 0, height = 0, channels = 0, dataSeen = false, dataEnded = false, ended = false, size = 8;
  while (offset < bytes.length) {
    if (++count > 256 || offset + 12 > bytes.length || ended) invalid();
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (length > AVATAR_PNG_MAX_BYTES || end > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase() || crc(bytes, offset + 4, offset + 8 + length) !== view.getUint32(offset + 8 + length)) invalid();
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (count === 1 && type !== 'IHDR' || count !== 1 && type === 'IHDR') invalid();
    if (type === 'IHDR') {
      if (length !== 13) invalid();
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      channels = data[9] === 2 ? 3 : data[9] === 6 ? 4 : 0;
      if (!width || !height || width > AVATAR_PNG_MAX_DIMENSION || height > AVATAR_PNG_MAX_DIMENSION || data[8] !== 8 || !channels || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) invalid();
    } else if (type === 'IDAT') {
      if (dataEnded) invalid();
      dataSeen = true; compressed.push(data);
    } else {
      if (dataSeen) dataEnded = true;
      if (type === 'IEND') {
        if (length || !dataSeen || end !== bytes.length) invalid();
        ended = true;
      } else if (['acTL', 'fcTL', 'fdAT'].includes(type) || type[0] === type[0].toUpperCase()) invalid();
    }
    if (['IHDR', 'IDAT', 'IEND'].includes(type)) { const chunk = bytes.subarray(offset, end); keep.push(chunk); size += chunk.length; }
    offset = end;
  }
  if (!ended) invalid();
  const compressedSize = compressed.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!compressedSize) invalid();
  const joined = new Uint8Array(compressedSize);
  let position = 0;
  for (const chunk of compressed) { joined.set(chunk, position); position += chunk.length; }
  const stride = width * channels + 1, expected = stride * height;
  let decoded = 0;
  const reader = new Blob([joined]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      if (decoded + part.value.length > expected) invalid();
      for (let i = (stride - decoded % stride) % stride; i < part.value.length; i += stride) if (part.value[i] > 4) invalid();
      decoded += part.value.length;
    }
    if (decoded !== expected) invalid();
  } catch { invalid(); }
  finally { await reader.cancel().catch(() => {}); }
  const canonical = new Uint8Array(size);
  position = 0;
  for (const chunk of keep) { canonical.set(chunk, position); position += chunk.length; }
  return canonical;
}
export async function validateAvatarPng(value: string): Promise<string> { return base64(await decodeAvatarPng(value)); }
/** Validate R2 bytes using the same decoder; no MIME/signature-only shortcut. */
export async function validateAvatarPngBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!(bytes instanceof Uint8Array)) invalid();
  if (bytes.length > AVATAR_PNG_MAX_BYTES) tooLarge();
  return decodeAvatarPng(base64(bytes));
}
