import {describe, expect, it} from 'vitest';
import {AVATAR_PNG_MAX_BASE64, AVATAR_PNG_MAX_BYTES, decodeAvatarPng, validateAvatarPng, validateAvatarPngBytes} from '../apps/api/src/avatar-png';
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function checksum(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;}
  return (crc ^ 0xffffffff) >>> 0;
}
function concat(...arrays: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0)); let pos = 0;
  for (const array of arrays) {output.set(array, pos); pos += array.length;} return output;
}
function chunk(type: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer);
  view.setUint32(0, data.length); result.set(new TextEncoder().encode(type), 4); result.set(data, 8);
  view.setUint32(result.length - 4, checksum(result.subarray(4, -4))); return result;
}
const b64 = (bytes: Uint8Array) => {let output = ''; for (let i = 0; i < bytes.length; i += 8192) output += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(output);};
async function fixture(options: {width?: number; height?: number; bit?: number; color?: number; interlace?: number; raw?: Uint8Array; compressed?: Uint8Array} = {}) {
  const width = options.width ?? 1, height = options.height ?? 1, color = options.color ?? 6;
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = options.bit ?? 8; header[9] = color; header[12] = options.interlace ?? 0;
  const raw = options.raw ?? new Uint8Array(height * (1 + width * (color === 2 ? 3 : 4)));
  const compressed = options.compressed ?? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = chunk('IHDR', header), idat = chunk('IDAT', compressed), iend = chunk('IEND');
  return {ihdr, idat, iend, compressed, bytes: concat(signature, ihdr, idat, iend)};
}
const rejects = async (bytes: Uint8Array) => expect(decodeAvatarPng(b64(bytes))).rejects.toMatchObject({code: 'avatar_image_invalid'});
describe('strict bounded PNG avatar validation', () => {
  it('accepts canonical noninterlaced 8bit RGB/RGBA PNG and maximum 1024 dimensions', async () => {
    for (const options of [{}, {color: 2}, {width: 1024, height: 1024}]) {
      const {bytes} = await fixture(options);
      expect(await validateAvatarPng(b64(bytes))).toBe(b64(bytes));
      expect(await validateAvatarPngBytes(bytes)).toEqual(bytes);
      expect(await decodeAvatarPng(b64(bytes))).toEqual(bytes);
    }
  });
  it('strips ancillary metadata and remains canonical/idempotent', async () => {
    const {ihdr, idat, iend, bytes} = await fixture();
    const annotated = concat(signature, ihdr, chunk('tEXt', new TextEncoder().encode('Comment\0private metadata')), chunk('iTXt', new Uint8Array([1, 2, 3])), chunk('sRGB', new Uint8Array([0])), idat, chunk('eXIf', new Uint8Array([9])), iend);
    const normalized = await validateAvatarPng(b64(annotated));
    expect(normalized).toBe(b64(bytes)); expect(await validateAvatarPng(normalized)).toBe(normalized);
  });
  it('rejects noncanonical base64, URLs, data URIs, whitespace, alternate alphabets and excessive bytes before decompression', async () => {
    const {bytes} = await fixture(), value = b64(bytes);
    for (const bad of ['', value + '\n', ' ' + value, value.slice(0, -1), '-' + value.slice(1), 'data:image/png;base64,' + value, 'https://example.test/avatar.png', 'AB==']) {
      await expect(decodeAvatarPng(bad)).rejects.toMatchObject({code: 'avatar_image_invalid'});
    }
  });
  it('rejects oversized input with a clear durable-storage limit before PNG decoding', async () => {
    expect(AVATAR_PNG_MAX_BYTES).toBe(1024 * 1024);
    for (const value of ['A'.repeat(AVATAR_PNG_MAX_BASE64 + 4), b64(new Uint8Array(AVATAR_PNG_MAX_BYTES + 1))]) {
      await expect(decodeAvatarPng(value)).rejects.toMatchObject({code: 'avatar_image_limit', message: expect.stringContaining('1 MiB')});
    }
    await expect(validateAvatarPngBytes(new Uint8Array(AVATAR_PNG_MAX_BYTES + 1))).rejects.toMatchObject({code: 'avatar_image_limit'});
  });
  it('rejects CRC/signature corruption, truncation, oversized chunk lengths and trailing bytes', async () => {
    const {bytes} = await fixture();
    const signatureBad = bytes.slice(); signatureBad[1] ^= 1;
    const crcBad = bytes.slice(); crcBad[29] ^= 1;
    const lengthBad = bytes.slice(); new DataView(lengthBad.buffer).setUint32(8, 0xffffffff);
    for (const bad of [signatureBad, crcBad, lengthBad, bytes.slice(0, -1), concat(bytes, new Uint8Array([0]))]) await rejects(bad);
  });
  it('rejects invalid/oversized dimensions, palette/gray/16bit/interlace formats', async () => {
    for (const options of [{width: 0}, {height: 0}, {width: 1025}, {height: 1025}, {width: 65536, raw: new Uint8Array(5)}, {bit: 16}, {color: 0}, {color: 3}, {color: 4}, {interlace: 1}]) await rejects((await fixture(options)).bytes);
  });
  it('rejects chunk ordering/duplication, unknown critical chunks, APNG and invalid type flags', async () => {
    const {ihdr, idat, iend} = await fixture();
    for (const bad of [
      concat(signature, idat, ihdr, iend), concat(signature, ihdr, ihdr, idat, iend), concat(signature, ihdr, iend),
      concat(signature, ihdr, chunk('ABCD'), idat, iend), concat(signature, ihdr, chunk('abct'), idat, iend),
      concat(signature, ihdr, chunk('acTL', new Uint8Array(8)), idat, iend), concat(signature, ihdr, idat, chunk('fdAT'), iend),
      concat(signature, ihdr, idat, chunk('tEXt'), idat, iend), concat(signature, ihdr, idat, chunk('IEND', new Uint8Array([1]))),
      concat(signature, ihdr, ...Array.from({length: 257}, () => chunk('tEXt')), idat, iend),
    ]) await rejects(bad);
  });
  it('rejects invalid filters, truncated/extra scanlines and bounded decompression bombs', async () => {
    for (const raw of [new Uint8Array([5, 0, 0, 0, 0]), new Uint8Array(4), new Uint8Array(6), new Uint8Array(4_200_000)]) await rejects((await fixture({raw})).bytes);
    const rgb = await fixture({color: 2, raw: new Uint8Array([0, 0, 0, 0, 5, 0, 0, 0]), height: 2}); await rejects(rgb.bytes);
  });
  it('rejects malformed zlib, checksum errors and trailing compressed data', async () => {
    const {compressed} = await fixture(); const checksumBad = compressed.slice(); checksumBad[checksumBad.length - 1] ^= 1;
    for (const data of [new Uint8Array(), new Uint8Array([1, 2, 3]), compressed.slice(0, -1), checksumBad, concat(compressed, new Uint8Array([1, 2, 3]))]) await rejects((await fixture({compressed: data})).bytes);
  });
  it('permits contiguous split IDAT with complete exact decoded bytes', async () => {
    const {ihdr, compressed, iend, bytes} = await fixture();
    const split = concat(signature, ihdr, chunk('IDAT', compressed.slice(0, 5)), chunk('IDAT', compressed.slice(5)), iend);
    expect((await decodeAvatarPng(b64(split))).length).toBe(bytes.length + 12);
  });
});
