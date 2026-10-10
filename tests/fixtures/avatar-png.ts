/** Deterministic, poorly compressible RGBA: exercises real 1024px image sizes,
 * including varying alpha, instead of a tiny single-color PNG. No network. */
export async function largeAvatarPng() {
  const width = 1024, height = 1024, stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  let seed = 0x5eed1234;
  for (let row = 0; row < height; row++) {
    for (let x = 1; x < stride; x++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      raw[row * stride + x] = seed & 255;
    }
  }
  const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[n] = crc;
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer);
    view.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < out.length - 4; i++) crc = table[(crc ^ out[i]) & 255] ^ (crc >>> 8);
    view.setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0);
    return out;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  for (let i = 0; i < compressed.length; i += 65536) parts.push(chunk('IDAT', compressed.subarray(i, i + 65536)));
  parts.push(chunk('IEND', new Uint8Array()));
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return {bytes, base64: btoa(binary)};
}
