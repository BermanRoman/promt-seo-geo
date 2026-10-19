// Прорабская проверка страниц перед публикацией: жёсткие правила, которые проверяются без чтения глазами.
//   node scripts/lint-drafts.mjs                 — все черновики и обновления из _pending
//   node scripts/lint-drafts.mjs slug-1 slug-2   — конкретные страницы (в том числе опубликованные)
//   node scripts/lint-drafts.mjs --links …       — плюс доступность каждой ссылки (curl с этого компьютера)
// Выход 1, если есть ошибки (публиковать нельзя); «внимание» — на усмотрение прораба.
// Правила — knowledge/razbor-rules.md и knowledge/legal-ru.md; свои запрещённые слова и домены — workspace/lint.json:
// { "bannedDomains": [...], "bannedWords": [...] }.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { val, list, explainerMeta } from './lib/frontmatter.mjs';
import { ws, loadSite } from '../src/lib/workspace.mjs';

const site = loadSite();
const DIR = ws('content/explained');
const PENDING = path.join(DIR, '_pending');
const MATERIALS = ws('content/materials');
const RUBRICS = site.rubrics.map((r) => r.slug);
const extra = fs.existsSync(ws('lint.json')) ? JSON.parse(fs.readFileSync(ws('lint.json'), 'utf8')) : {};
const args = process.argv.slice(2);
const checkLinks = args.includes('--links');
const slugs = args.filter((a) => !a.startsWith('--'));

// для России: нежелательные и экстремистские организации, СМИ-иноагенты, заблокированные ресурсы (knowledge/legal-ru.md).
// Списки меняются — сверять с реестрами Минюста и Генпрокуратуры; свои дополнения — в workspace/lint.json
const BANNED_RU = ['meduza.io', 'theins.ru', 'theins.press', 'bellingcat.com', 'proekt.media', 'svoboda.org', 'currenttime.tv',
  'rferl.org', 'themoscowtimes.com', 'novayagazeta.eu', 'tvrain.tv', 'tvrain.ru', 'dw.com', 'zona.media', 'ovd.info',
  'ovdinfo.org', 'fbk.info', 'instagram.com', 'facebook.com', 'istories.media', 'agents.media', 'verstka.media'];
const BANNED = [...(site.region === 'ru' ? BANNED_RU : []), ...(extra.bannedDomains ?? [])];
const HIDDEN = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u202A-\u202E]/g;
const AI_MARKS = /Claude|Anthropic|ChatGPT|Generated with|Co-Authored-By|нейросеть написала|сгенерирован/i;
const VPN = /(?<!\p{L})(VPN|ВПН)(?!\p{L})|обход\p{L}* блокировок/iu;
const WORDS = (extra.bannedWords ?? []).length ? new RegExp(`(?<!\\p{L})(${extra.bannedWords.join('|')})(?!\\p{L})`, 'iu') : null;

const mdIn = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f)) : []);
const files = slugs.length
  ? slugs.flatMap((s) => [path.join(PENDING, `${s}.md`), path.join(DIR, `${s}.md`)].filter(fs.existsSync).slice(0, 1))
  : [...mdIn(DIR).filter((p) => { const m = explainerMeta(fs.readFileSync(p, 'utf8')); return m.draft && !m.rejected; }), ...mdIn(PENDING)];
if (!files.length) { console.log('проверять нечего'); process.exit(0); }

const materialSlugs = mdIn(MATERIALS).map((p) => path.basename(p, '.md'));
const words = (t) => t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const norm = (t) => words(t.replace(/«[^»]*»/g, ' ')).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, ''));
const shingles = (arr, n = 12) => { const s = new Set(); for (let i = 0; i + n <= arr.length; i++) s.add(arr.slice(i, i + n).join(' ')); return s; };
const mPath = `/${site.materials.path}/`;

let failed = false;
const allUrls = new Map();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const slug = path.basename(file, '.md') + (file.startsWith(PENDING) ? ' (обновление)' : '');
  const fmMatch = src.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = fmMatch?.[1] ?? '';
  const body = src.slice(fmMatch?.[0].length ?? 0);
  const err = [], warn = [];

  if (!fmMatch) err.push('нет frontmatter');
  const hidden = src.match(HIDDEN); if (hidden) err.push(`скрытые символы: ${hidden.length}`);
  if (AI_MARKS.test(src)) err.push(`пометка ИИ: «${src.match(AI_MARKS)[0]}»`);
  if (site.region === 'ru' && VPN.test(body + fm)) err.push(`VPN/обход блокировок: «${(body + fm).match(VPN)[0]}»`);
  if (WORDS && WORDS.test(body + fm)) err.push(`запрещённое слово из lint.json: «${(body + fm).match(WORDS)[0]}»`);
  if (/\p{Extended_Pictographic}/u.test(src)) err.push('эмодзи');

  for (const u of [...src.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)].map((m) => m[0])) {
    let host = '';
    try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { err.push(`битая ссылка: ${u}`); continue; }
    if (BANNED.some((b) => host === b || host.endsWith(`.${b}`))) err.push(`запрещённый домен: ${u}`);
    allUrls.set(u, slug);
  }
  const sources = list(fm, 'sources');
  for (const u of new Set([...body.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))) if (!sources.includes(u)) warn.push(`ссылки нет в sources: ${u}`);
  if (site.region === 'ru') for (const m of body.matchAll(/(Instagram|Facebook|Инстаграм|Фейсбук)/g)) {
    if (!/экстремист/i.test(body)) { err.push(`${m[1]} без пометки о Meta (knowledge/legal-ru.md)`); break; }
  }

  const meta = explainerMeta(src);
  const kind = meta.kind;
  const seoTitle = String(val(fm, 'seoTitle') ?? val(fm, 'title') ?? '');
  const description = String(val(fm, 'description') ?? '');
  const short = String(val(fm, 'short') ?? '');
  if (!meta.title) err.push('нет title');
  if (seoTitle.length > 70) err.push(`seoTitle ${seoTitle.length} знаков (до 70)`);
  if (description.length < 120 || description.length > 160) warn.push(`description ${description.length} знаков (120–160)`);
  if (!short) err.push('нет «Коротко» (short)');
  if (words(short).length > 60) warn.push(`«Коротко» ${words(short).length} слов (до 60)`);
  if (/по-моему|я считаю|моё мнение|на мой взгляд/i.test(short)) warn.push('мнение в «Коротко» — оценки только в «Что это значит?»');
  const rubric = val(fm, 'rubric');
  if (RUBRICS.length && !RUBRICS.includes(rubric)) err.push(`rubric: ${rubric ?? 'нет'} — одна из: ${RUBRICS.join(', ')}`);
  if (!['event', 'topic'].includes(kind)) err.push(`kind: ${kind} — только event или topic`);
  if (!materialSlugs.includes(meta.material)) err.push(`material: «${meta.material}» — нет такого материала`);
  for (const m of meta.materials) if (!materialSlugs.includes(m)) err.push(`materials: «${m}» — нет такого материала`);
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(val(fm, 'published') ?? ''))) err.push('published — дата ГГГГ-ММ-ДД');

  // ссылки внутри сайта: только на материалы (на соседние разборы ведёт блок «Ещё по …» шаблона)
  const own = [...body.matchAll(new RegExp(`\\]\\((?:${site.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?(/[^)\\s]*)\\)`, 'g'))].map((m) => m[1]);
  for (const href of own) {
    if (href.startsWith(mPath)) {
      const s = href.slice(mPath.length).replace(/\/.*$/, '');
      if (!materialSlugs.includes(s)) err.push(`ссылка на несуществующий материал: ${href}`);
      else if (kind === 'topic' && s !== meta.material && !meta.materials.includes(s)) warn.push(`ссылка на материал «${s}», которого нет в materials`);
    } else err.push(`ссылка на другую страницу сайта: ${href} — разбор ведёт только на материалы`);
  }
  if (kind !== 'topic' && !own.some((h) => h.startsWith(`${mPath}${meta.material}/`))) warn.push(`в тексте нет ссылки на материал-основу ${mPath}${meta.material}/`);

  const n = words(body).length;
  const [min, max] = kind === 'topic' ? [1200, file.startsWith(PENDING) ? 3000 : 2500] : [500, 1200];
  if (n < min * 0.9 || n > max * 1.1) warn.push(`объём ${n} слов (норма ${min}–${max})`);

  // голос: страница подписана автором — о себе от первого лица, а не «автор считает»
  const third = body.match(/(?<!\p{L})(?:по (?:мнению|словам|оценке) автора|(?:вывод|мнение|взгляд) автора|автор(?:у|ом)?\s+(?:считает|отмет|разобра|разбира|писал|пишет|называ|назвал|видит|предупрежд|сравнива|объясня|описыва|делает))/giu);
  if (third) err.push(`о себе в третьем лице («${third[0]}») — писать от первого лица`);
  const paras = body.split(/\n{2,}/).map((x) => x.trim()).filter((x) => x && !/^(#|>|-|\||\d+\.|```)/.test(x));
  const torn = paras.filter((x) => (x.match(/«/g) || []).length > (x.match(/»/g) || []).length);
  if (torn.length) err.push(`цитата разрезана на абзацы: ${torn.length} (первая: «${torn[0].slice(0, 60)}…»)`);
  const noDot = paras.filter((x) => /[»)]$/.test(x) && !/[.!?…]»$/.test(x));
  if (noDot.length) warn.push(`абзацы без точки в конце: ${noDot.length}`);
  // куски материалов 12+ слов подряд вне кавычек — копипаст вместо разбора
  const mine = shingles(norm(body));
  for (const s of new Set([meta.material, ...meta.materials])) {
    const p = path.join(MATERIALS, `${s}.md`);
    if (!fs.existsSync(p)) continue;
    const hit = [...shingles(norm(fs.readFileSync(p, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')))].find((x) => mine.has(x));
    if (hit) warn.push(`12+ слов подряд из материала «${s}»: «${hit}»`);
  }

  console.log(`\n${err.length ? '✗' : '✓'} ${slug} — ${kind}, ${n} слов, источников ${sources.length}`);
  for (const e of err) console.log(`  ошибка: ${e}`);
  for (const w of warn) console.log(`  внимание: ${w}`);
  if (err.length) failed = true;
}

if (checkLinks && allUrls.size) {
  let bad = 0;
  for (const [u, slug] of allUrls) {
    let code = '000';
    try { code = execFileSync('curl', ['-s', '-o', '/dev/null', '-m', '15', '-L', '-A', 'Mozilla/5.0', '-w', '%{http_code}', u], { encoding: 'utf8' }); } catch {}
    if (!/^(200|301|302|303|307|308|403)$/.test(code)) { bad++; console.log(`  внимание: ${code} ${u} (${slug})`); }
  }
  console.log(`\nссылки: проверено ${allUrls.size}, недоступно ${bad}`);
}
process.exit(failed ? 1 : 0);
