// Импорт текстов автора из папки (.md и .txt) в материалы сайта.
//   node scripts/import-folder.mjs <папка> [--recursive] [--dry-run]
// Берёт файлы .md и .txt из папки (с --recursive — и из вложенных). .docx и .doc не читает:
// они перечислены в отчёте — сначала сохраните их как .md или .txt.
// Каждый файл — content/materials/<slug>.md в workspace (WORKSPACE, по умолчанию ../workspace от engine/):
//   frontmatter title, date, description, source, topics; ниже — текст в Markdown.
// Заголовок — title из frontmatter файла, иначе первый «# » (из текста убирается), иначе имя файла.
// Дата — date/дата из frontmatter, иначе дата в начале имени файла (2024-01-31 или 31.01.2024), иначе дата изменения файла.
// В .txt без пустых строк между абзацами каждая строка становится абзацем.
// Тексты короче MIN_WORDS слов (по умолчанию 250) не пишутся — они перечислены в отчёте.
// Повторный запуск не плодит дубли: состояние в .deploy/imported.json (путь файла → slug и хеши),
// изменившийся файл перезаписывается с полем updated, неизменённый пропускается; перенесённый файл узнаётся по содержимому.
// Отчёт — данные/импорт-<дата>.md, сводка — в консоль. --dry-run показывает план и ничего не пишет.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WS } from '../src/lib/workspace.mjs';
import { splitParagraph } from '../src/lib/sentences.mjs';

const USAGE = 'node scripts/import-folder.mjs <папка> [--recursive] [--dry-run]';
const fail = (msg) => { console.error(msg); process.exit(1); };

// ---------- аргументы ----------
const opts = { input: '', recursive: false, dryRun: false };
for (const a of process.argv.slice(2)) {
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--recursive' || a === '-r') opts.recursive = true;
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else if (a.startsWith('-')) fail(`Неизвестный флаг ${a}\n${USAGE}`);
  else if (!opts.input) opts.input = a;
  else fail(`Лишний аргумент ${a}\n${USAGE}`);
}
if (!opts.input) fail(USAGE);

const MIN_WORDS = Number.isFinite(Number.parseInt(process.env.MIN_WORDS, 10)) ? Number.parseInt(process.env.MIN_WORDS, 10) : 250;
const MATERIALS = path.join(WS, 'content', 'materials');
const STATE = path.join(WS, '.deploy', 'imported.json');
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = localDay(new Date());
const REPORT = path.join(WS, 'данные', `импорт-${TODAY}.md`);

// ---------- текст ----------
// невидимые символы (zero-width, BOM, мягкий перенос, управление направлением) из текста убираем всегда
const HIDDEN = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// эмодзи: пиктограммы, флаги, оттенки кожи, вариации и keycap — в заголовке и описании их нет
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u20E3]/gu;
const clean = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(HIDDEN, '').replace(/\u00A0/g, ' ');
const noEmoji = (s) => s.replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').trim();
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
const LIST_RE = /^\s*(?:[-*+•–·▪]|\d{1,3}[.)])\s+/;
const wordCount = (s) => (s.replace(URL_RE, ' ').match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;
const hasWords = (s) => /[\p{L}\p{N}]/u.test(s.replace(URL_RE, ' ').replace(EMOJI, ''));

// обрезка по границе слова, без многоточия; хвостовые запятые, тире и открывающие скобки убираем
function cutWords(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const i = head.lastIndexOf(' ');
  return (i > max / 2 ? head.slice(0, i) : s.slice(0, max)).replace(/[\s,;:—–\-(«"]+$/, '');
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};
function slugify(title) {
  const s = [...title.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join('')
    .normalize('NFKD').replace(/[\u0300-\u036F]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length <= 60) return s;
  const head = s.slice(0, 61);
  const i = head.lastIndexOf('-');
  return (i > 0 ? head.slice(0, i) : s.slice(0, 60)).replace(/-+$/, '');
}

// строка Markdown → простой текст (для заголовка, описания и подсчёта слов)
const inlinePlain = (l) => l
  .replace(/^#{1,6}\s+/, '').replace(/^(?:>\s?)+/, '').replace(LIST_RE, '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/<[^>]+>/g, '').replace(URL_RE, '')
  .replace(/\*\*|__|~~|`/g, '')
  .replace(/(^|[\s(«"])[_*]([^_*\n]+)[_*](?=$|[\s).,!?:;»"])/g, '$1$2')
  .replace(/\s{2,}/g, ' ').trim();

// абзацы Markdown как простой текст; код не берём, заголовки — по запросу
function paragraphs(md, withHeadings = false) {
  const out = [];
  for (const block of md.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '').split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length || (!withHeadings && /^#{1,6}\s/.test(lines[0]))) continue;
    const list = lines.every((l) => LIST_RE.test(l));
    const s = lines.map(inlinePlain).filter(Boolean).join(list ? '; ' : ' ').trim();
    if (s) out.push(s);
  }
  return out;
}

// описание: первые содержательные предложения, 100–160 знаков, без разметки и эмодзи
function makeDescription(body) {
  const sentences = [];
  for (const p of paragraphs(body).map(noEmoji)) {
    if (!hasWords(p)) continue;
    for (const s of splitParagraph(p)) if (s.trim()) sentences.push(s.trim());
  }
  while (sentences.length > 1 && wordCount(sentences[0]) < 4) sentences.shift(); // «Привет!» и подобное
  let d = '';
  for (const s of sentences) {
    if (d.length >= 100) break;
    d = d ? `${/[.!?…:;]$/.test(d) ? d : `${d}.`} ${s}` : s;
  }
  return cutWords(d, 160);
}

// заголовки ## из текста — topics
function headingsOf(body) {
  const out = [];
  let fence = false;
  for (const l of body.split('\n')) {
    if (/^```/.test(l)) fence = !fence;
    const m = !fence && l.match(/^##\s+(.+?)\s*#*\s*$/);
    if (m) { const h = noEmoji(inlinePlain(m[1])); if (h) out.push(h); }
  }
  return out;
}

const q = (s) => JSON.stringify(s);
function render(m) {
  const fm = ['---', `title: ${q(m.title)}`, `date: ${m.date}`];
  if (m.updated) fm.push(`updated: ${m.updated}`);
  fm.push(`description: ${q(m.description)}`);
  if (m.source) fm.push(`source: ${q(m.source)}`);
  fm.push(`topics: [${m.topics.map(q).join(', ')}]`, '---');
  return `${fm.join('\n')}\n\n${m.body.trim()}\n`;
}
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ---------- файл → материал ----------
// простой frontmatter: строки «ключ: значение», значения в кавычках или без
function splitFrontmatter(text) {
  const m = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { fm: {}, rest: text };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\p{L}\p{N}_-]+)[ \t]*:[ \t]*(.*?)[ \t]*$/u);
    if (!kv || !kv[2]) continue;
    let v = kv[2];
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.replace(/^"|"$/g, ''); } }
    else if (v.startsWith("'")) v = v.replace(/^'|'$/g, '').replace(/''/g, "'");
    fm[kv[1].toLowerCase()] = String(v).trim();
  }
  return { fm, rest: text.slice(m[0].length) };
}

// 2024-01-31, 2024-01-31T10:00 или 31.01.2024 → 2024-01-31
function normDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const ymd = m ? [m[1], m[2], m[3]] : (m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/)) ? [m[3], m[2], m[1]] : null;
  if (!ymd || +ymd[1] < 1 || +ymd[1] > 12 || +ymd[2] < 1 || +ymd[2] > 31) return '';
  return ymd.join('-');
}

// .txt без пустых строк: каждая строка — абзац, подряд идущие пункты — один список
function linesToParagraphs(text) {
  const blocks = [];
  let list = [];
  const flush = () => { if (list.length) blocks.push(list.join('\n')); list = []; };
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    if (LIST_RE.test(l)) { list.push(l.replace(/^[•–·▪]\s+/, '- ')); continue; }
    flush();
    blocks.push(l);
  }
  flush();
  return blocks.join('\n\n');
}

// первый «# » вне блоков кода
function findH1(lines) {
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fence = !fence;
    const m = !fence && lines[i].match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) return { idx: i, text: m[1] };
  }
  return null;
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})(?=$|[\s_.-])[\s_.-]*/;
const preview = (s) => { const t = noEmoji(s.replace(/\s+/g, ' ')); return t.length > 80 ? `${t.slice(0, 80)}…` : t; };

function toMaterial(file) {
  const raw = clean(fs.readFileSync(file, 'utf8'));
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, path.extname(file));
  const { fm, rest } = splitFrontmatter(raw);
  const text = rest.replace(/\n{3,}/g, '\n\n').trim();
  let body = ext === '.txt' && !/\n[ \t]*\n/.test(text) ? linesToParagraphs(text) : text;

  const lines = body.split('\n');
  const h1 = findH1(lines);
  const firstIdx = lines.findIndex((l) => l.trim());
  const bare = base.replace(DATE_PREFIX, '');
  // в имени без пробелов дефис и подчёркивание — разделители слов: «итоги-года» → «Итоги года»
  const fromName = noEmoji((bare.includes(' ') ? bare : bare.replace(/-+/g, ' ')).replace(/_+/g, ' ')) || base;
  const nameTitle = fromName[0].toUpperCase() + fromName.slice(1);
  const title = fm.title || (h1 && noEmoji(inlinePlain(h1.text))) || nameTitle;
  // «# » убираем, если он и есть заголовок или стоит первой строкой (иначе на странице два H1)
  if (h1 && (!fm.title || h1.idx === firstIdx)) lines.splice(h1.idx, 1);
  body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const known = normDate(fm.date ?? fm['дата']) || normDate(base.match(DATE_PREFIX)?.[1]);
  const date = known || localDay(stat.mtime);
  const src = fm.source || fm.url || '';
  return {
    raw,
    dateFromMtime: !known,
    mtime: localDay(stat.mtime),
    fmUpdated: normDate(fm.updated),
    material: {
      title,
      date,
      description: fm.description || makeDescription(body),
      source: /^https?:\/\//i.test(src) ? src : '',
      topics: headingsOf(body),
      body,
    },
  };
}

// ---------- вход ----------
const SRC = path.resolve(opts.input);
if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) fail(`Нет такой папки: ${SRC}`);
if (SRC === MATERIALS || SRC.startsWith(MATERIALS + path.sep)) fail('Это папка готовых материалов сайта — импортировать её в себя нельзя.');

const files = [];
const docx = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue; // скрытые и временные файлы Word
    if (e.isDirectory()) {
      if (opts.recursive && e.name !== 'node_modules' && p !== MATERIALS && p !== WS) walk(p);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (ext === '.md' || ext === '.markdown' || ext === '.txt') files.push(p);
    else if (ext === '.docx' || ext === '.doc') docx.push(p);
  }
})(SRC);

let state = { version: 1, items: {} };
if (fs.existsSync(STATE)) {
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); state.items ??= {}; } catch (e) { fail(`${STATE} повреждён: ${e.message}`); }
}
const slugOwner = new Map(Object.entries(state.items).map(([k, v]) => [v.slug, k]));
function allocSlug(base, key) {
  for (let n = 1; ; n++) {
    const s = n === 1 ? base : `${base}-${n}`;
    const owner = slugOwner.get(s);
    if (owner === key) return s;
    if (owner || fs.existsSync(path.join(MATERIALS, `${s}.md`))) continue; // занят другим источником или файлом автора
    slugOwner.set(s, key);
    return s;
  }
}

const rel = (f) => path.relative(SRC, f);
const res = { added: [], updated: [], same: [], short: [], skipped: [] };
const plan = [];

for (const file of files) {
  let parsed;
  try { parsed = toMaterial(file); } catch (e) { res.skipped.push({ file: rel(file), reason: `не читается: ${e.message}` }); continue; }
  const { material, raw, mtime, fmUpdated, dateFromMtime } = parsed;
  if (!hasWords(material.body)) { res.skipped.push({ file: rel(file), reason: 'пустой' }); continue; }
  const words = wordCount(paragraphs(material.body, true).join(' '));
  if (words < MIN_WORDS) {
    res.short.push({ file: rel(file), date: material.date, text: preview(paragraphs(material.body, true).join(' ')), words });
    continue;
  }

  const key = `file:${file}`;
  const srcHash = sha1(raw);
  // файл перенесли в другую папку: узнаём по содержимому, если по старому пути его больше нет
  if (!state.items[key]) {
    const moved = Object.entries(state.items).find(([k, v]) => k.startsWith('file:') && v.srcHash === srcHash && !fs.existsSync(k.slice(5)));
    if (moved) {
      state.items[key] = moved[1];
      delete state.items[moved[0]];
      slugOwner.set(moved[1].slug, key);
    }
  }
  const prev = state.items[key];
  // дата из времени изменения файла сдвигается при каждой правке — у импортированного держим первую
  if (prev?.date && dateFromMtime) material.date = prev.date;
  const slug = prev?.slug ?? allocSlug(slugify(material.title) || `post-${srcHash.slice(0, 8)}`, key);
  const hash = sha1(render(material));
  const item = { title: material.title, slug, date: material.date, file: rel(file) };
  if (prev?.hash === hash) { res.same.push(item); continue; }
  if (prev) material.updated = [fmUpdated, mtime, TODAY].find((d) => d && d >= material.date);
  (prev ? res.updated : res.added).push(item);
  plan.push({ file: path.join(MATERIALS, `${slug}.md`), content: render(material) });
  state.items[key] = { slug, hash, srcHash, date: material.date, source: file, importedAt: prev?.importedAt ?? TODAY, ...(prev ? { updatedAt: TODAY } : {}) };
}

// ---------- отчёт ----------
const cell = (s) => String(s).replace(/\|/g, '\\|');
const report = [
  `# Импорт из папки — ${TODAY}`,
  '',
  `Источник: ${SRC}${opts.recursive ? ' (со вложенными папками)' : ''}`,
  `Порог: ${MIN_WORDS} слов.${opts.dryRun ? ' Пробный запуск: ничего не записано.' : ''}`,
  '',
  '## Итого',
  '',
  `- Файлов .md и .txt: ${files.length}`,
  `- Импортировано новых: ${res.added.length}`,
  `- Обновлено: ${res.updated.length}`,
  `- Без изменений: ${res.same.length}`,
  `- Короткие, не импортированы: ${res.short.length}`,
  `- Пропущено прочих: ${res.skipped.length}`,
  ...(docx.length ? [`- Файлов Word, которые нужно сконвертировать: ${docx.length}`] : []),
];
const list = (title, items) => (items.length ? ['', `## ${title}`, '', ...items.map((i) => `- ${i.title} → \`${i.slug}\` (${i.date}, ${i.file})`)] : []);
report.push(...list('Импортировано', res.added), ...list('Обновлено', res.updated));
if (res.short.length) {
  report.push('', `## Короткие тексты (меньше ${MIN_WORDS} слов, не импортированы)`, '',
    'Можно дописать и импортировать заново или объединить несколько в один материал.', '',
    '| Дата | Файл | Начало текста | Слов |', '|---|---|---|---|',
    ...res.short.map((s) => `| ${s.date} | ${cell(s.file)} | ${cell(s.text)} | ${s.words} |`));
}
if (res.skipped.length) report.push('', '## Пропущено', '', ...res.skipped.map((s) => `- ${s.file}: ${s.reason}`));
if (docx.length) {
  report.push('', '## Сначала сконвертировать в .md', '',
    'Файлы Word скрипт не читает. Сохраните их как .md (Google Docs: Файл → Скачать → Markdown) или как .txt и запустите импорт снова.', '',
    ...docx.map((f) => `- ${rel(f)}`));
}
const reportText = `${report.join('\n')}\n`;

// отчёт за день общий для обоих импортов: свой блок (заголовок + источник) заменяем, чужие оставляем
function saveReport(text) {
  const id = text.split('\n').slice(0, 3).join('\n');
  const old = fs.existsSync(REPORT) ? fs.readFileSync(REPORT, 'utf8') : '';
  const keep = old.split(/(?=^# Импорт из )/m).filter((b) => b.trim() && !b.startsWith(id)).map((b) => `${b.trimEnd()}\n`);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, [...keep, text].join('\n'));
}

// ---------- запись ----------
if (opts.dryRun) {
  console.log(reportText);
  console.log('Пробный запуск (--dry-run): файлы, состояние и отчёт не записаны.');
  process.exit(0);
}
fs.mkdirSync(MATERIALS, { recursive: true });
for (const p of plan) fs.writeFileSync(p.file, p.content);
fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
saveReport(reportText);
console.log(`Импорт из папки: новых ${res.added.length}, обновлено ${res.updated.length}, без изменений ${res.same.length}, `
  + `коротких ${res.short.length}, пропущено ${res.skipped.length}${docx.length ? `, Word на конвертацию ${docx.length}` : ''}.`);
console.log(`Материалы: ${MATERIALS}`);
console.log(`Отчёт: ${REPORT}`);
