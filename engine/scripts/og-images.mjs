// OG-картинки (превью ссылки в мессенджерах и соцсетях), 1200×630, JPEG.
// Оформление — из site.config.json → design.og (цвета фона, текста, акцента) и шрифты темы:
// workspace/design/og/head.woff и workspace/design/og/text.woff (woff или ttf, с кириллицей), а если их нет — Golos Text движка.
// Картинки: общая (название сайта и автор), по одной на материал и на разбор или тему. Готовые не пересобираются;
// в имени — хеш заголовка и версия оформления (src/lib/og.mjs), устаревшие удаляются.
import fs from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { loadSite, ws, ENGINE } from '../src/lib/workspace.mjs';
import { glue } from '../src/lib/text.mjs';
import { ogFile } from '../src/lib/og.mjs';
import { fmOf, val } from './lib/frontmatter.mjs';

const site = loadSite();
const OUT = ws('public/og');
const { bg, ink, accent } = site.design.og;
const userFont = (n) => ['woff', 'ttf', 'otf'].map((x) => ws(`design/og/${n}.${x}`)).find(fs.existsSync);
const golos = (w, sub) => path.join(ENGINE, `node_modules/@fontsource/golos-text/files/golos-text-${sub}-${w}-normal.woff`);
// у каждого набора своё имя: satori берёт первый шрифт с подходящим именем, а знаки препинания — в латинском наборе
const fonts = [
  ...(userFont('head') ? [{ name: 'Head', data: fs.readFileSync(userFont('head')), weight: 700 }] : []),
  ...(userFont('text') ? [{ name: 'Text', data: fs.readFileSync(userFont('text')), weight: 400 }] : []),
  { name: 'GolosCyr', data: fs.readFileSync(golos(700, 'cyrillic')), weight: 700 },
  { name: 'GolosLat', data: fs.readFileSync(golos(700, 'latin')), weight: 700 },
  { name: 'GolosCyrR', data: fs.readFileSync(golos(400, 'cyrillic')), weight: 400 },
  { name: 'GolosLatR', data: fs.readFileSync(golos(400, 'latin')), weight: 400 },
];
const HEAD = `${userFont('head') ? 'Head, ' : ''}GolosCyr, GolosLat`;
const TEXT = `${userFont('text') ? 'Text, ' : ''}GolosCyrR, GolosLatR`;

async function card(file, title, caption) {
  const size = title.length > 80 ? 60 : title.length > 50 ? 72 : 88;
  const svg = await satori({
    type: 'div',
    props: {
      style: { width: 1200, height: 630, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '72px 80px', background: bg },
      children: [
        { type: 'div', props: { style: { display: 'flex', width: 120, height: 10, background: accent } } },
        { type: 'div', props: { style: { display: 'flex', fontFamily: HEAD, fontWeight: 700, fontSize: size, lineHeight: 1.1, color: ink, letterSpacing: -1 }, children: glue(title) } },
        { type: 'div', props: { style: { display: 'flex', fontFamily: TEXT, fontWeight: 400, fontSize: 32, color: accent }, children: caption } },
      ],
    },
  }, { width: 1200, height: 630, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
  await sharp(png).jpeg({ quality: 84, mozjpeg: true }).toFile(path.join(OUT, file));
}

fs.mkdirSync(OUT, { recursive: true });
const keep = new Set([ogFile.default(site.ogVersion)]);
let made = 0;
const ensure = async (file, title, caption) => {
  keep.add(file);
  if (fs.existsSync(path.join(OUT, file))) return;
  await card(file, title, caption);
  made++;
};

await ensure(ogFile.default(site.ogVersion), site.name, site.author.name);
const mdIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)) : []);
for (const p of mdIn(ws('content/materials'))) {
  const title = String(val(fmOf(fs.readFileSync(p, 'utf8')), 'title') ?? '');
  if (title) await ensure(ogFile.material(path.basename(p, '.md'), title, site.ogVersion), title, site.author.name);
}
for (const p of [...mdIn(ws('content/explained')), ...mdIn(ws('content/explained/_pending'))]) {
  const fm = fmOf(fs.readFileSync(p, 'utf8'));
  const title = String(val(fm, 'title') ?? '');
  if (!title) continue;
  await ensure(ogFile.explained(path.basename(p, '.md'), title, site.ogVersion), title, `${site.author.name} · ${val(fm, 'kind') === 'topic' ? 'тема' : 'разбор'}`);
}
let gone = 0;
for (const f of fs.readdirSync(OUT)) if (f.endsWith('.jpg') && !keep.has(f) && !f.startsWith('author')) { fs.unlinkSync(path.join(OUT, f)); gone++; }
console.log(`OG-картинки: новых ${made}, всего ${keep.size}${gone ? `, удалено устаревших ${gone}` : ''}`);
