// Authored vector examples for the built-in gallery, never substituted for a
// bot's generated avatar. Keep geometry within the passive avatar SVG subset.
import {mkdir, writeFile} from 'node:fs/promises';
const root = new URL('../apps/console/public/avatar-themes/', import.meta.url);
await mkdir(root, {recursive:true});
const p=(d,fill,stroke='',w=3)=>`<path d="${d}" fill="${fill}"${stroke?` stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`:''}/>`;
const c=(x,y,r,fill)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const e=(x,y,rx,ry,fill)=>`<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;
const r=(x,y,w,h,fill,rx=0)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"/>`;
const ink='#29383a',cream='#fff1d8',ivory='#faf5e9';
const eyes=(y=65,x=45,gap=38)=>c(x,y,3,ink)+c(x+gap,y,3,ink);
const nose=(y=80)=>p(`M59 ${y}L69 ${y}L64 ${y+6}Z`,ink);
const smile=(y=86)=>p(`M57 ${y}Q64 ${y+7}71 ${y}`,'none',ink,2.5);
const paper=[
  p('M23 23L48 34L64 29L80 34L105 23L103 79L83 104L64 113L44 104L25 79Z','#74866f')+p('M23 23L64 52L25 79Z','#aaba9b')+p('M105 23L64 52L103 79Z','#526b60')+p('M25 79L64 52L103 79L64 113Z','#8fa089')+p('M34 53L61 57L53 79L33 74Z',cream)+p('M94 53L67 57L75 79L95 74Z',cream)+eyes(64,46,36)+p('M58 78L70 78L64 91Z','#d39a4e'),
  p('M20 22L47 39L81 39L108 22L101 77L64 111L27 77Z','#ce754a')+p('M20 22L39 39L28 63Z','#9a493d')+p('M108 22L89 39L100 63Z','#9a493d')+p('M20 22L64 62L64 111L27 77Z','#e59b63')+p('M29 70L56 72L64 96L64 111Z',ivory)+p('M99 70L72 72L64 96L64 111Z',cream)+eyes(65)+nose(88),
  p('M24 20L47 39L80 39L104 20L102 86L82 104L45 104L25 86Z','#bd9b84')+p('M24 20L42 42L26 62Z','#d48d78')+p('M104 20L86 42L102 62Z','#a17465')+p('M47 39L64 52L45 104L25 86L26 62Z','#dcc1a4')+p('M64 52L82 104L45 104Z',cream)+eyes(66)+nose(79)+smile(89),
  p('M26 27L43 25L53 39L76 39L87 25L104 27L111 44L98 59L99 84L80 105L48 105L29 84L30 59L17 44Z','#ab7758')+p('M26 27L43 25L42 47L30 59L17 44Z','#cb946b')+p('M87 25L104 27L111 44L98 59L85 47Z','#795b47')+p('M30 59L64 45L64 105L48 105L29 84Z','#c0906b')+p('M48 76L80 76L88 91L64 104L40 91Z',cream)+eyes(65)+nose(82)+smile(91),
  p('M37 12L50 18L56 56L72 56L78 18L91 12L96 26L86 65L101 82L89 104L64 113L39 104L27 82L42 65L32 26Z','#d5bfab')+p('M37 12L50 18L56 56L46 62Z','#f0dcd0')+p('M91 12L96 26L86 65L75 60Z','#b29189')+p('M27 82L64 67L64 113L39 104Z',ivory)+p('M64 67L101 82L89 104L64 113Z',cream)+eyes(82,46,36)+nose(91),
];
const bauhaus=[
  r(30,30,68,69,'#e5b64c',18)+r(17,56,13,25,'#3565a1',6)+r(98,56,13,25,'#df6345',6)+r(61,15,6,18,ink)+c(64,14,7,'#df6345')+c(48,61,14,cream)+c(48,61,6,ink)+r(70,47,16,28,'#3565a1',8)+r(44,84,40,6,ink,3),
  p('M28 37L100 37L106 96L22 96Z','#3565a1')+r(39,21,51,17,'#df6345')+r(16,56,9,26,'#e5b64c')+r(104,56,9,26,'#e5b64c')+r(35,51,24,24,cream,3)+c(47,63,6,ink)+c(83,63,12,'#e5b64c')+c(83,63,5,ink)+r(48,86,31,5,cream),
  p('M64 24L106 56L98 92L64 109L30 92L22 56Z','#df6345')+p('M64 24L106 56L98 92L64 109Z','#bd4634')+c(21,60,10,'#e5b64c')+c(107,60,10,'#e5b64c')+r(36,52,56,24,cream,12)+c(48,64,5,ink)+c(80,64,5,ink)+p('M52 87Q64 102 76 87Z','#e5b64c'),
  r(31,28,65,75,cream,9)+r(31,28,32,75,'#e5b64c',9)+p('M63 28H96V65H63Z','#df6345')+r(14,46,17,34,ink,8)+r(96,46,17,34,ink,8)+c(47,58,10,ink)+c(47,58,3,cream)+c(79,58,10,cream)+c(79,58,4,ink)+r(47,84,35,8,'#3565a1',4),
  p('M32 35Q64 9 96 35L100 86Q64 115 28 86Z','#3565a1')+r(24,22,5,23,ink)+c(26,20,7,'#e5b64c')+r(99,22,5,23,ink)+c(101,20,7,'#df6345')+r(34,48,60,27,cream,10)+r(45,54,8,15,ink,4)+r(74,54,8,15,ink,4)+p('M51 86Q64 97 77 86','none',cream,5),
];
const monoShapes=[
  'M26 28L45 39Q64 30 83 39L102 28L101 74Q98 105 64 110Q30 105 27 74Z',
  'M25 22L49 43Q64 39 79 43L103 22L100 74Q89 96 64 109Q39 96 28 74Z',
  'M27 25L48 40Q64 34 80 40L101 25L102 79Q97 106 64 108Q31 106 26 79Z',
  'M30 51C4 44 19 14 38 25L47 39Q64 32 81 39L90 25C109 14 124 44 98 51Q113 75 94 98Q64 120 34 98Q15 75 30 51Z',
  'M40 62C19 22 39 5 48 22L58 56L70 56L80 22C89 5 109 22 88 62Q110 86 89 103Q64 120 39 103Q18 86 40 62Z',
];
const mono=monoShapes.map((shape,i)=>p(shape,ivory,'#344855',4)+(
  i===0?e(46,65,15,18,'#efe5d1')+e(82,65,15,18,'#efe5d1')+eyes(64,46,36)+p('M58 80L70 80L64 90Z','#d28673'):
  i===1?p('M29 72Q44 65 64 94Q84 65 99 72','none','#344855',3)+eyes(63)+nose(88):
  i===2?eyes(64)+nose(78)+p('M64 84V91M64 91Q54 97 51 88M64 91Q74 97 77 88M18 77L36 81M92 81L110 77','none','#344855',2.5):
  i===3?e(64,84,20,16,'#efe5d1')+eyes(63)+nose(78)+smile(88):
  p('M41 27L49 53M87 27L79 53','none','#d28673',5)+eyes(78)+nose(88)+smile(97)
)+c(35,i===4?89:78,4,'#d99382')+c(93,i===4?89:78,4,'#d99382'));
const palette={'.':'',d:'#303745',s:'#e8b88e',l:'#f8d8ac',h:'#8b5646',g:'#60816a',G:'#365b4a',p:'#8f73b2',P:'#5e5081',a:'#b8c9d4',A:'#758798',r:'#be645c',R:'#873f48',y:'#e9bb5d',w:'#f6ecd9'};
const pixelBase=[
'................','................','................','................',
'....dddddddd....','...dhhhhhhhhd...','...dssssssssd...',
'..dssllssllssd..','..dssddssddssd..','..dssddssddssd..',
'...dssssssssd...','...dsssddsssd...','....dssssssd....',
'.....dddddd.....','................','................'];
const hats=[
 {2:'.......ggd......',3:'.....gggggd.....',4:'....ggggggggd...',5:'..dGGGGGGGGGGd..'},
 {1:'.......yp.......',2:'......dppd......',3:'.....dppppd.....',4:'....dppppppd....',5:'..dPPPPPPPPPPd..'},
 {2:'......aaaa......',3:'....daaaaaad....',4:'...daaawaaaad...',5:'...dAAAaAAAAd...',6:'...dasassasad...',10:'...dassssssad...',11:'...daaassa aad...'.replaceAll(' ','')},
 {2:'.....hhhhhd.....',3:'...dhhhhhhhhd...',4:'..dhhhhhhrrrrd..',5:'..dhhhhhRRRRRd..',6:'..dhsssssrrsd...'},
 {2:'.....wwwwwd.....',3:'...dwwwwwwwd....',4:'...dwwrwrwwd....',5:'...dwwrrrwwd....',6:'...dwwrwrwwd....'},
];
const pixels=hats.map(hat=>{
 const rows=pixelBase.map((row,index)=>hat[index]??row);
 return rows.flatMap((row,y)=>[...row].map((color,x)=>palette[color]?r(x*7+8,y*7+8,7,7,palette[color]):'')).join('');
});
const botanical=[
  p('M29 77C8 69 13 47 32 43C20 26 38 19 50 36C49 9 72 8 76 31C92 14 109 30 96 47C120 49 116 74 99 80Q96 108 64 112Q31 108 29 77Z','#65876a')+p('M33 67Q35 40 64 45Q94 40 96 69L89 94Q64 115 39 94Z','#a8ba89')+p('M64 17V43M28 34L45 48M100 33L84 48','none','#d8dfae',3)+eyes(74)+smile(87),
  p('M33 55Q25 98 64 111Q103 98 95 55Z','#c79361')+p('M26 56Q25 27 59 25L61 15Q65 10 71 14L69 25Q103 28 102 56Z','#795b45')+p('M34 43L96 43M42 32L49 52M57 29L65 53M73 30L81 53','none','#ae8860',3)+e(64,82,28,23,'#dfb980')+eyes(77)+smile(91),
  p('M41 51C9 48 18 20 41 25C39 0 69 7 71 25C90 6 110 27 94 44C122 48 111 77 91 76L91 92Q64 119 37 92L35 73C10 78 7 50 41 51Z','#c77964')+e(64,70,33,34,'#f1d6a1')+p('M62 17L64 35M98 31L84 44M21 53L34 58','none','#efb398',3)+eyes(68)+smile(84)+c(40,80,4,'#d99178')+c(88,80,4,'#d99178'),
  p('M27 49L19 38L37 37L36 23L52 32L63 14L74 31L92 23L90 41L109 41L99 57Q113 88 88 102L64 113L37 101Q14 82 27 49Z','#4e7661')+p('M30 58Q64 33 97 58L90 91Q64 112 38 91Z','#96af7a')+p('M27 49L43 58M99 49L84 58','none','#c5ce98',3)+eyes(71)+smile(86),
  p('M63 42C30 45 24 19 31 17C54 17 65 25 63 42Z','#6b9365')+p('M64 43C63 16 88 12 100 18C98 37 85 46 64 43Z','#3e7057')+p('M64 32V55','none','#496f53',4)+p('M31 67Q28 44 64 46Q100 44 97 67L93 92Q64 113 35 92Z','#c9cca0')+p('M31 67L42 95Q64 108 78 100L64 108L35 92Z','#a9b581')+eyes(72)+smile(87),
];
for(const [slug,heads] of Object.entries({paperfold:paper,bauhaus,monoline:mono,pixel:pixels,botanical})){
 for(const [index,head] of heads.entries()) await writeFile(new URL(`${slug}-${index+1}.svg`,root),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${head}</svg>\n`);
}
