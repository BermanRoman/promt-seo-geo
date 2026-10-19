// Иконки сайта: favicon.ico (16, 32, 48), favicon-120.png (Яндекс просит 120×120), apple-touch-icon.png (180).
// Источник — workspace/design/icon.png или icon.svg (квадрат, от 512 px). Нет своего — монограмма из инициалов автора
// в цветах design.og. Пересобираются, только если источник новее готовых иконок.
import fs from 'node:fs';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import path from 'node:path';
import { loadSite, ws, ENGINE } from '../src/lib/workspace.mjs';

const site = loadSite();
const OUT = ws('public');
fs.mkdirSync(OUT, { recursive: true });
const src = ['icon.svg', 'icon.png'].map((f) => ws('design', f)).find(fs.existsSync);
const ico = path.join(OUT, 'favicon.ico');
const cfg = ws('site.config.json');
if (fs.existsSync(ico) && fs.statSync(ico).mtimeMs > Math.max(src ? fs.statSync(src).mtimeMs : 0, fs.statSync(cfg).mtimeMs)) process.exit(0);

let base;
if (src) base = await sharp(src).resize(512, 512, { fit: 'contain', background: site.design.og.bg }).png().toBuffer();
else {
  const initials = site.author.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const font = fs.readFileSync(path.join(ENGINE, 'node_modules/@fontsource/golos-text/files/golos-text-cyrillic-700-normal.woff'));
  const fontLat = fs.readFileSync(path.join(ENGINE, 'node_modules/@fontsource/golos-text/files/golos-text-latin-700-normal.woff'));
  const svg = await satori({ type: 'div', props: {
    style: { width: 512, height: 512, display: 'flex', alignItems: 'center', justifyContent: 'center', background: site.design.og.accent, borderRadius: 96,
      color: '#ffffff', fontFamily: 'C, L', fontWeight: 700, fontSize: 230, letterSpacing: -6 },
    children: initials } }, { width: 512, height: 512, fonts: [{ name: 'C', data: font, weight: 700 }, { name: 'L', data: fontLat, weight: 700 }] });
  base = new Resvg(svg).render().asPng();
}
const png = (s) => sharp(base).resize(s, s).png().toBuffer();
await sharp(await png(120)).toFile(path.join(OUT, 'favicon-120.png'));
await sharp(base).resize(180, 180).flatten({ background: site.design.og.bg }).png().toFile(path.join(OUT, 'apple-touch-icon.png'));
// ICO: заголовок, каталог картинок, сами PNG
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map(png));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let off = head.length;
sizes.forEach((s, i) => {
  const o = 6 + 16 * i;
  head.writeUInt8(s, o); head.writeUInt8(s, o + 1); head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(pngs[i].length, o + 8); head.writeUInt32LE(off, o + 12); off += pngs[i].length;
});
fs.writeFileSync(ico, Buffer.concat([head, ...pngs]));
console.log(`иконки сайта: ${src ? `из ${path.basename(src)}` : 'монограмма из инициалов автора'}`);
