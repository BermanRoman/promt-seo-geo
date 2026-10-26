// Публикация черновиков разборов и обновлений тем, которые прошли проверку прораба.
//   node scripts/publish.mjs --material <slug>   — всё по одному материалу (поле material)
//   node scripts/publish.mjs --material a,b,c    — пачка: всё по нескольким материалам, потом одна заливка
//   node scripts/publish.mjs slug-1 slug-2        — конкретные страницы
// Черновик: draft: true → false. Обновление темы (explained/_pending/<slug>.md) заменяет опубликованную страницу.
// Снятый прорабом черновик (rejected: true) не публикуется никогда. Перед публикацией — lint-drafts.mjs:
// при ошибках ничего не публикуется. Потом — npm run deploy.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { explainerMeta } from './lib/frontmatter.mjs';
import { ws } from '../src/lib/workspace.mjs';

const DIR = ws('content/explained');
const PENDING = path.join(DIR, '_pending');
const args = process.argv.slice(2);
const materials = args[0] === '--material' ? (args[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean) : [];
if (args[0] === '--material' && !materials.length) { console.log('после --material нужен slug материала (или несколько через запятую)'); process.exit(1); }
const wanted = (slug, src) => args.includes(slug) || materials.includes(explainerMeta(src).material);
const read = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.md')) : [])
  .map((f) => [f.replace(/\.md$/, ''), path.join(dir, f)]).map(([slug, p]) => [slug, p, fs.readFileSync(p, 'utf8')]);
const drafts = read(DIR).filter(([slug, , src]) => explainerMeta(src).draft && !explainerMeta(src).rejected && wanted(slug, src));
const updates = read(PENDING).filter(([slug, , src]) => !explainerMeta(src).rejected && wanted(slug, src));
if (!drafts.length && !updates.length) { console.log('нечего публиковать'); process.exit(0); }
try {
  execFileSync('node', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'lint-drafts.mjs'), ...new Set([...drafts, ...updates].map(([s]) => s))], { stdio: 'inherit' });
} catch {
  console.log('\nlint нашёл ошибки — ничего не опубликовано');
  process.exit(1);
}
for (const [slug, p, src] of drafts) { fs.writeFileSync(p, src.replace(/^draft:\s*true\s*$/m, 'draft: false')); console.log(`опубликовано: ${slug}`); }
for (const [slug, p, src] of updates) {
  fs.writeFileSync(path.join(DIR, `${slug}.md`), src.replace(/^draft:\s*true\s*$/m, 'draft: false'));
  fs.unlinkSync(p);
  console.log(`обновлено: ${slug}`);
}
