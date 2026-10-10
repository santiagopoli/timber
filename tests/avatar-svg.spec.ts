import {describe, expect, it} from 'vitest';
import {sanitizeAvatarSvg} from '../apps/api/src/avatar-svg';

const wrap = (body: string, attrs = 'viewBox="0 0 128 128"') => `<svg ${attrs}>${body}</svg>`;
const simple = '<path d="M12 12L50 12L30 50Z" fill="#abc"/>';
describe('passive avatar SVG boundary', () => {
  it('normalizes a standalone root and retains only validated passive geometry', () => {
    const svg = sanitizeAvatarSvg(wrap(`<g fill="none" stroke="#123456" stroke-width="2"><rect x="4" y="4" width="24" height="20" rx="3"/><circle cx="35" cy="30" r="6"/><ellipse cx="50" cy="30" rx="5" ry="3"/><line x1="2" y1="4" x2="8" y2="9"/><polyline points="1,2 3,4"/><polygon points="1 2 3 4 5 6"/>${simple}</g>`, 'height="256" width="256" viewBox="0,0,128,128"'));
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">');
    expect(svg).not.toContain('height="256"');
    expect(sanitizeAvatarSvg(svg)).toBe(svg);
    expect(sanitizeAvatarSvg(`<svg>${simple}</svg>`)).toContain('viewBox="0 0 128 128"');
  });
  it('supports bounded arcs, bezier curves, exponent coordinates and explicit close tags', () => {
    const svg = wrap('<path d="M1e1 10 C12 10 12 12 14 14 Q20 20 25 25 A2 3 45 0 1 30 30 z"></path>');
    expect(sanitizeAvatarSvg(svg)).toContain('A2 3 45 0 1 30 30');
  });
  const attacks = [
    '<?xml version="1.0"?>' + wrap(simple),
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + wrap(simple),
    wrap(simple + '&x;'), wrap('<!-- comment -->' + simple), wrap('<![CDATA[<script/>]]>' + simple),
    wrap('<script>alert(1)</script>'), wrap('<foreignObject><div>active</div></foreignObject>'),
    wrap('<image href="https://evil.invalid/x"/>'), wrap('<use href="#x"/>'), wrap('<animate attributeName="href"/>'),
    wrap('<set attributeName="onload"/>'), wrap('<defs/>'), wrap('<style>* { fill: url(https://evil.invalid) }</style>'),
    wrap('<path d="M0 0L1 1" onload="alert(1)"/>'), wrap('<g onclick="x">' + simple + '</g>'),
    wrap('<path d="M0 0L1 1" href="javascript:alert(1)"/>'),
    wrap('<path d="M0 0L1 1" xlink:href="https://evil.invalid"/>'),
    wrap('<path d="M0 0L1 1" fill="url(#x)"/>'), wrap('<path d="M0 0L1 1" fill="u&#114;l(#x)"/>'),
    wrap('<path d="M0 0L1 1" style="fill:red"/>'), wrap('<path d="M0 0L1 1" class="active"/>'),
    wrap('<path d="M0 0L1 1" transform="scale(3)"/>'), wrap('<path d="M0 0L1 1" id="x"/>'),
    wrap('<svg:path d="M0 0L1 1"/>'), wrap('<g xmlns="http://www.w3.org/1999/xhtml">' + simple + '</g>'),
    wrap(simple, 'xmlns="http://www.w3.org/1999/xhtml"'), wrap(simple, 'xmlns:xlink="http://www.w3.org/1999/xlink"'),
    wrap('<text>hello</text>'), wrap('<a>' + simple + '</a>'), wrap('<SVG/>'),
    wrap('<path d=M0,0L1,1/>'), wrap('<path d="M0 0L1 1" fill="red" fill="blue"/>'),
    wrap('<path d="M0 0L1 1"/><!--x-->'), wrap('<path d="M0 0L1 1"/> trailing'),
    wrap('<g><path d="M0 0L1 1"/></svg>'), wrap('<path d="M0 0L1 1"><circle r="1"/></path>'),
    wrap('<svg>' + simple + '</svg>'), wrap(simple) + wrap(simple), wrap(simple) + '<script/>',
    wrap('<path d="M0 0L1 1"/>\0'), wrap('<path d="M0 0L1 1" fill="red\u0001"/>'),
    wrap('<path d="javascript:alert(1)"/>'), wrap('<path d="M0 0A2 2 0 2 1 5 5"/>'),
    wrap('<path d="M0 0L1"/>'), wrap('<path d="M0 0Z1 2"/>'), wrap('<path/>'), wrap('<polygon points="1 2 3"/>'),
    wrap(simple, 'viewBox="0 0 Infinity 128"'), wrap(simple, 'viewBox="0 0 1e999 128"'),
    wrap(simple, 'viewBox="0 0 0 128"'), wrap(simple, 'viewBox="0 0 4097 128"'), wrap(simple, 'viewBox="0 0 1 2 3"'),
    wrap('<rect width="100%" height="128"/>'), wrap('<circle cx="1" cy="1" r="-1"/>'),
    wrap('<path d="M0 0L9000 0"/>'), wrap('<g opacity="2">' + simple + '</g>'),
    '<svg/>', '<svg></svg>', '', 'not XML',
  ];
  for (const [i, svg] of attacks.entries()) it(`rejects malformed/active adversarial case ${i + 1}`, () => {
    expect(() => sanitizeAvatarSvg(svg)).toThrow('not a safe, supported SVG');
  });
  it('bounds bytes, element count, nesting and numeric complexity', () => {
    expect(() => sanitizeAvatarSvg(wrap(simple + ' '.repeat(33_000)))).toThrow();
    expect(() => sanitizeAvatarSvg(wrap('<circle r="1"/>'.repeat(256)))).toThrow();
    expect(() => sanitizeAvatarSvg(wrap('<g>'.repeat(16) + simple + '</g>'.repeat(16)))).toThrow();
    expect(() => sanitizeAvatarSvg(wrap(`<path d="M0 0${'L1 1'.repeat(600)}"/>`))).toThrow();
    expect(() => sanitizeAvatarSvg(wrap(`<polygon points="${'1 2 '.repeat(600)}"/>`))).toThrow();
  });
  it('rejects enclosing rounded-rect equivalents including mirrored and clipped radii', () => {
    for (const body of [
      '<rect x="0" y="0" width="128" height="128" rx="64" ry="64"/>',
      '<rect width="128" height="128" rx="64" fill="none" stroke="black"/>',
      '<rect width="128" height="128" ry="64"/>',
      '<g><rect width="128" height="128" rx="100" ry="100"/></g>',
    ]) expect(() => sanitizeAvatarSvg(wrap(body + simple))).toThrow();
    expect(() => sanitizeAvatarSvg(wrap('<rect x="-64" y="-64" width="128" height="128" rx="64"/>', 'viewBox="-64 -64 128 128"'))).toThrow();
    expect(sanitizeAvatarSvg(wrap('<rect x="10" y="10" width="24" height="24" rx="12"/>' + simple))).toContain('<rect');
    expect(sanitizeAvatarSvg(wrap('<rect width="128" height="128" rx="4" ry="4"/>' + simple))).toContain('<rect');
  });
  it('rejects circular backgrounds and frames even inside passive groups', () => {
    for (const body of ['<circle cx="64" cy="64" r="64" fill="#abc"/>', '<ellipse cx="64" cy="64" rx="60" ry="60" fill="none" stroke="black"/>', '<g><circle cx="64" cy="64" r="64"/></g>']) expect(() => sanitizeAvatarSvg(wrap(body + simple))).toThrow();
    expect(() => sanitizeAvatarSvg(wrap('<circle cx="0" cy="0" r="64"/>', 'viewBox="-64 -64 128 128"'))).toThrow();
  });
});
