import { ApiError } from './errors';

const XMLNS = 'http://www.w3.org/2000/svg';
const MAX_BYTES = 32_768;
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const scalar = new RegExp(`^${NUMBER}$`);
const numberToken = new RegExp(NUMBER, 'g');
const shapes: Record<string, readonly string[]> = {
  svg: ['xmlns', 'viewBox', 'width', 'height'], g: [],
  path: ['d'], rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'], polygon: ['points'],
};
const paint = ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'stroke-linecap', 'stroke-linejoin'];
const colors = new Set(['none', 'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'silver', 'navy', 'teal', 'aqua', 'lime', 'maroon', 'olive', 'fuchsia', 'transparent']);
function invalid(): never { throw new ApiError(502, 'avatar_svg_invalid', 'The generated avatar is not a safe, supported SVG.'); }
function numeric(value: string, min = -8192, max = 8192): number {
  if (!scalar.test(value)) invalid();
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) invalid();
  return n;
}
function numbers(value: string, limit: number): number[] {
  // A restricted numeric list, not CSS or an arbitrary XML attribute.
  if (!value.trim() || /[^\d.eE+\-,\s]/.test(value)) invalid();
  const tokens = value.match(numberToken) ?? [];
  if (!tokens.length || tokens.length > limit || value.replace(numberToken, '').replace(/[\s,]/g, '')) invalid();
  return tokens.map(v => numeric(v));
}
function path(value: string): string {
  if (!value.length || value.length > 16_384 || /[^MmLlHhVvCcSsQqTtAaZz\d.eE+\-,\s]/.test(value)) invalid();
  const commands = value.match(/[MmLlHhVvCcSsQqTtAaZz][^MmLlHhVvCcSsQqTtAaZz]*/g);
  if (!commands || !/^[Mm]/.test(value.trim()) || commands.length > 512) invalid();
  const arity: Record<string, number> = {M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0};
  let count = 0;
  for (const command of commands) {
    const op = command[0].toUpperCase(), tail = command.slice(1).trim();
    if (op === 'Z') { if (tail) invalid(); continue; }
    const values = numbers(tail, 2048), width = arity[op];
    count += values.length;
    if (values.length % width || count > 2048) invalid();
    if (op === 'A') for (let i = 0; i < values.length; i += 7) {
      if (values[i] < 0 || values[i + 1] < 0 || ![0, 1].includes(values[i + 3]) || ![0, 1].includes(values[i + 4])) invalid();
    }
  }
  return value.trim();
}
function attribute(name: string, value: string): string {
  if (name === 'fill' || name === 'stroke') {
    if (!colors.has(value) && !/^#(?:[\da-fA-F]{3}|[\da-fA-F]{6}|[\da-fA-F]{8})$/.test(value)) invalid();
    return value;
  }
  if (name === 'fill-rule') { if (!['nonzero', 'evenodd'].includes(value)) invalid(); return value; }
  if (name === 'stroke-linecap') { if (!['butt', 'round', 'square'].includes(value)) invalid(); return value; }
  if (name === 'stroke-linejoin') { if (!['miter', 'round', 'bevel'].includes(value)) invalid(); return value; }
  if (name.endsWith('opacity')) return String(numeric(value, 0, 1));
  if (name === 'd') return path(value);
  if (name === 'points') {
    const values = numbers(value, 1024);
    if (values.length < 4 || values.length % 2) invalid();
    return values.join(' ');
  }
  return String(numeric(value, ['r', 'rx', 'ry', 'width', 'height', 'stroke-width'].includes(name) ? 0 : -8192));
}

/**
 * Fail-closed parser for a tiny, passive XML subset, not an HTML sanitizer.
 * We never repair malformed XML or preserve unknown markup. No DOM/dependency
 * is required in Workers: every accepted token is validated and reserialized.
 * No entities, namespaces other than the root SVG namespace, CSS, references,
 * transforms, text, animation, filters, definitions, or external resources exist
 * in this grammar. Do not widen it without adversarial browser/parser review.
 */
export function sanitizeAvatarSvg(input: string): string {
  if (typeof input !== 'string' || input.length > MAX_BYTES || new TextEncoder().encode(input).length > MAX_BYTES || /[&\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<\?|<!/.test(input)) invalid();
  let pos = 0, nodes = 0, drawn = 0, closed = false;
  let viewport: number[] = [];
  const stack: string[] = [], output: string[] = [];
  while (pos < input.length) {
    const whitespace = /^[\t\n\r ]*/.exec(input.slice(pos))![0]; pos += whitespace.length;
    if (pos === input.length) break;
    if (closed || input[pos] !== '<') invalid();
    const end = input.indexOf('>', pos);
    if (end < 0) invalid();
    const token = input.slice(pos + 1, end); pos = end + 1;
    if (token.startsWith('/')) {
      const close = /^\/([a-z]+)[\t\n\r ]*$/.exec(token);
      if (!close || stack.pop() !== close[1]) invalid();
      output.push(`</${close[1]}>`);
      if (!stack.length) closed = true;
      continue;
    }
    const open = /^([a-z]+)([\s\S]*)$/.exec(token);
    if (!open || !Object.hasOwn(shapes, open[1])) invalid();
    const tag = open[1];
    if ((!nodes && tag !== 'svg') || (nodes && (!stack.length || tag === 'svg')) || (stack.length && !['svg', 'g'].includes(stack[stack.length - 1]))) invalid();
    if (++nodes > 256 || stack.length >= 16) invalid();
    let tail = open[2], selfClosing = false;
    if (tail.endsWith('/')) { selfClosing = true; tail = tail.slice(0, -1); }
    const attrs: Record<string, string> = Object.create(null);
    while (tail.trim()) {
      const match = /^[\t\n\r ]+([A-Za-z][A-Za-z0-9-]*)[\t\n\r ]*=[\t\n\r ]*(?:"([^"<>]*)"|'([^'<>]*)')/.exec(tail);
      if (!match) invalid();
      const name = match[1], value = match[2] ?? match[3];
      if (Object.hasOwn(attrs, name) || (!shapes[tag].includes(name) && !paint.includes(name))) invalid();
      attrs[name] = value; tail = tail.slice(match[0].length);
    }
    if (tag === 'svg') {
      if (attrs.xmlns !== undefined && attrs.xmlns !== XMLNS) invalid();
      viewport = numbers(attrs.viewBox ?? '0 0 128 128', 4);
      if (viewport.length !== 4 || viewport[2] < 1 || viewport[2] > 4096 || viewport[3] < 1 || viewport[3] > 4096) invalid();
      if (attrs.width !== undefined) numeric(attrs.width, 1, 4096);
      if (attrs.height !== undefined) numeric(attrs.height, 1, 4096);
      delete attrs.width; delete attrs.height; delete attrs.xmlns; delete attrs.viewBox;
      output.push(`<svg xmlns="${XMLNS}" viewBox="${viewport.join(' ')}"`);
    } else output.push(`<${tag}`);
    for (const [name, value] of Object.entries(attrs)) output.push(` ${name}="${attribute(name, value)}"`);
    if (tag === 'path' && !attrs.d || ['polygon', 'polyline'].includes(tag) && !attrs.points) invalid();
    if (!['svg', 'g'].includes(tag)) drawn++;
    // No transforms are admitted, so geometry is in root coordinates even in g.
    // Conservative aesthetic checks, NOT an exhaustive geometry proof. Arbitrary
    // paths can encode equivalent circles; prompt/UI enforce no circular framing.
    // Passive-markup safety is independently guaranteed by the grammar above.
    // These checks include an inscribed disk and its rounded-rect equivalent.
    if (tag === 'circle' || tag === 'ellipse') {
      const cx = Number(attrs.cx ?? 0), cy = Number(attrs.cy ?? 0);
      const rx = Number(tag === 'circle' ? attrs.r ?? 0 : attrs.rx ?? 0), ry = Number(tag === 'circle' ? attrs.r ?? 0 : attrs.ry ?? 0);
      const [x, y, w, h] = viewport;
      if (Math.abs(cx - (x + w / 2)) <= w * .1 && Math.abs(cy - (y + h / 2)) <= h * .1 && rx >= w * .45 && ry >= h * .45) invalid();
    }
    if (tag === 'rect') {
      const x = Number(attrs.x ?? 0), y = Number(attrs.y ?? 0);
      const w = Number(attrs.width ?? 0), h = Number(attrs.height ?? 0);
      // SVG mirrors the specified radius when the other radius is omitted, and
      // clips each radius at half its corresponding dimension.
      const rx = Math.min(Number(attrs.rx ?? attrs.ry ?? 0), w / 2);
      const ry = Math.min(Number(attrs.ry ?? attrs.rx ?? 0), h / 2);
      const [vx, vy, vw, vh] = viewport;
      if (w >= vw * .9 && h >= vh * .9 && rx >= w * .45 && ry >= h * .45
        && Math.abs(x + w / 2 - (vx + vw / 2)) <= vw * .1
        && Math.abs(y + h / 2 - (vy + vh / 2)) <= vh * .1) invalid();
    }
    output.push(selfClosing ? '/>' : '>');
    if (!selfClosing) stack.push(tag);
    else if (tag === 'svg') closed = true;
  }
  if (!nodes || !drawn || stack.length || !closed) invalid();
  const result = output.join('');
  if (new TextEncoder().encode(result).length > MAX_BYTES) invalid();
  return result;
}
