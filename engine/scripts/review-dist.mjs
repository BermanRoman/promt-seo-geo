// Что изменится на живом сайте: сравнивает собранный сайт (engine/dist) с тем, что было залито в прошлый раз,
// и пишет отчёт для ревью (роль site-reviewer читает его вместе с диффом правил или текстов).
//   node scripts/review-dist.mjs                  — база: снимок последней заливки (workspace/.deploy/dist-live/)
//   node scripts/review-dist.mjs --old <папка>    — база: другая сборка (например, dist, собранный из прошлой версии движка)
//   node scripts/review-dist.mjs --new <папка>    — что сравнивать (по умолчанию engine/dist; сборку скрипт не запускает)
//   node scripts/review-dist.mjs --snapshot       — запомнить текущий dist как «залитое» (deploy.sh делает это после заливки)
// Нет базы — отчёт только о проверках текущей сборки. Отчёт: workspace/.deploy/review-dist.md.
// Плюс проверки текущей сборки: битые внутренние ссылки, OG-картинки, скрытые символы, вес страницы.
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE, ws } from '../src/lib/workspace.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? undefined : args[i + 1]; };
const NEW = path.resolve(opt('new') ?? path.join(ENGINE, 'dist'));
const LIVE = ws('.deploy/dist-live');
const OLD = path.resolve(opt('old') ?? LIVE);

if (args.includes('--snapshot')) {
  if (!fs.existsSync(path.join(NEW, 'index.html'))) { console.log(`нет ${NEW}/index.html — сначала npm run build`); process.exit(1); }
  fs.rmSync(LIVE, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(LIVE), { recursive: true });
  fs.cpSync(NEW, LIVE, { recursive: true });
  console.log(`снимок залитой версии: ${LIVE}`);
  process.exit(0);
}
if (!fs.existsSync(path.join(NEW, 'index.html'))) { console.log(`нет ${NEW}/index.html — сначала npm run build`); process.exit(1); }

const pick = (html, re) => html.match(re)?.[1] ?? '';
const sentences = (t) => t.split(/(?<=[.!?…»])\s+/).filter(Boolean);

report(fs.existsSync(OLD) ? OLD : null, NEW);

function walk(dir, out = {}, rel = '') {
  for (const f of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, f.name);
    if (f.isDirectory()) walk(dir, out, r); else out[r] = path.join(dir, r);
  }
  return out;
}
// что считается «страницей» для сравнения: всё, что видят поисковики, мессенджеры и читатель
function fields(html) {
  const main = (html.match(/<main[\s\S]*?<\/main>/) || [''])[0];
  const text = main.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ').trim();
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  return {
    title: pick(html, /<title>([^<]*)<\/title>/),
    description: pick(html, /<meta name="description" content="([^"]*)"/),
    robots: pick(html, /<meta name="robots" content="([^"]*)"/),
    canonical: pick(html, /<link rel="canonical" href="([^"]*)"/),
    'og:title': pick(html, /<meta property="og:title" content="([^"]*)"/),
    'og:description': pick(html, /<meta property="og:description" content="([^"]*)"/),
    'og:image': pick(html, /<meta property="og:image" content="([^"]*)"/),
    'JSON-LD': ld,
    // стили и скрипты — без хеша в имени: важно, какие подключены, а не их версия
    assets: [...html.matchAll(/(?:href|src)="\/_astro\/([^"]+)"/g)].map((m) => m[1].replace(/\.[\w-]{8}\./, '.')).sort().join(' '),
    goals: [...html.matchAll(/data-goal="([^"]+)"/g)].map((m) => m[1]).sort().join(' '),
    links: [...main.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]).sort().join(' '),
    text,
  };
}

function report(oldDist, newDist) {
  const A = oldDist ? walk(oldDist) : {}, B = walk(newDist);
  const lines = [`# Что изменится на сайте: ${oldDist ? 'залитая версия → текущая сборка' : 'базы нет, только проверки текущей сборки'}`, ''];
  const pagesA = Object.keys(A).filter((f) => f.endsWith('.html')), pagesB = Object.keys(B).filter((f) => f.endsWith('.html'));
  const added = oldDist ? pagesB.filter((p) => !A[p]) : [], removed = pagesA.filter((p) => !B[p]);
  if (!oldDist) lines.push(`Страниц в сборке: ${pagesB.length}.`, ''); else lines.push(`Страниц: было ${pagesA.length}, стало ${pagesB.length}. Новые: ${added.join(', ') || 'нет'}. Пропали: ${removed.join(', ') || 'нет'}.`, '');
  let changed = 0;
  for (const p of pagesB.filter((x) => A[x]).sort()) {
    const a = fields(fs.readFileSync(A[p], 'utf8')), b = fields(fs.readFileSync(B[p], 'utf8'));
    const diff = Object.keys(b).filter((k) => a[k] !== b[k]);
    if (!diff.length) continue;
    changed++;
    lines.push(`## /${path.dirname(p) === '.' ? '' : `${path.dirname(p)}/`}`);
    for (const k of diff) {
      if (k === 'text') {
        const sa = new Set(sentences(a.text)), sb = new Set(sentences(b.text));
        const minus = [...sa].filter((s) => !sb.has(s)), plus = [...sb].filter((s) => !sa.has(s));
        lines.push(`- текст: −${minus.length} / +${plus.length} предложений`);
        for (const s of minus.slice(0, 4)) lines.push(`  - − ${s.slice(0, 200)}`);
        for (const s of plus.slice(0, 4)) lines.push(`  - + ${s.slice(0, 200)}`);
      } else if (k === 'JSON-LD' || k === 'links' || k === 'assets') {
        const sa = new Set(a[k].split(/[\s,]+/)), sb = new Set(b[k].split(/[\s,]+/));
        const minus = [...sa].filter((s) => !sb.has(s)), plus = [...sb].filter((s) => !sa.has(s));
        lines.push(`- ${k}: − ${minus.slice(0, 6).join(' ').slice(0, 300) || '—'} | + ${plus.slice(0, 6).join(' ').slice(0, 300) || '—'}`);
      } else lines.push(`- ${k}: «${a[k]}» → «${b[k]}»`);
    }
    lines.push('');
  }
  lines.splice(3, 0, `Изменённых страниц: ${changed}.`, '');
  // служебные файлы целиком
  for (const f of ['robots.txt', 'llms.txt', 'sitemap-0.xml', 'sitemap-index.xml']) {
    const a = A[f] && fs.readFileSync(A[f], 'utf8'), b = B[f] && fs.readFileSync(B[f], 'utf8');
    if (a !== b) {
      const la = new Set((a || '').split('\n')), lb = new Set((b || '').split('\n'));
      lines.push(`## ${f}`, ...[...la].filter((l) => !lb.has(l)).slice(0, 8).map((l) => `- − ${l.slice(0, 200)}`),
        ...[...lb].filter((l) => !la.has(l)).slice(0, 8).map((l) => `- + ${l.slice(0, 200)}`), '');
    }
  }
  const ogA = Object.keys(A).filter((f) => f.startsWith('og/')), ogB = Object.keys(B).filter((f) => f.startsWith('og/'));
  lines.push(`OG-картинок: было ${ogA.length}, стало ${ogB.length} (новых ${ogB.filter((f) => !A[f]).length}, удалено ${ogA.filter((f) => !B[f]).length}).`, '');

  // 3. проверки текущей сборки
  const problems = [];
  const exists = (u) => {
    const p = decodeURI(u.split('?')[0]).replace(/^\//, '');
    return B[p] || B[path.join(p, 'index.html')] || B[`${p.replace(/\/$/, '')}.html`];
  };
  const HIDDEN = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u202A-\u202E]/;
  for (const p of pagesB) {
    const html = fs.readFileSync(B[p], 'utf8');
    const url = `/${path.dirname(p) === '.' ? '' : `${path.dirname(p)}/`}`;
    for (const m of html.matchAll(/href="(\/[^"#]*)"/g)) if (!exists(m[1])) problems.push(`${url}: битая ссылка ${m[1]}`);
    const og = pick(html, /<meta property="og:image" content="https?:\/\/[^/]+(\/[^"]*)"/);
    if (og && !exists(og)) problems.push(`${url}: нет OG-картинки ${og}`);
    if (HIDDEN.test(html)) problems.push(`${url}: скрытые символы`);
    const kb = Buffer.byteLength(html) / 1024;
    if (kb > 400) problems.push(`${url}: HTML ${kb.toFixed(0)} КБ`);
  }
  lines.push('## Проверки текущей сборки', ...(problems.length ? [...new Set(problems)].map((x) => `- ${x}`) : ['- замечаний нет']), '');

  const out = ws('.deploy/review-dist.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`изменённых страниц ${changed}, новых ${added.length}, пропало ${removed.length}, замечаний ${problems.length}\nотчёт: ${out}`);
}
