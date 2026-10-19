// Импорт постов Telegram-канала в материалы сайта.
//   node scripts/import-telegram.mjs <папка экспорта или result.json> [--channel имя_канала] [--dry-run]
// Вход — экспорт Telegram Desktop: «Экспорт истории чата», формат JSON (result.json рядом с папкой photos/).
// --channel — публичное имя канала без @: тогда у материала будет source https://t.me/<канал>/<id>.
// Каждый пост — файл content/materials/<slug>.md в workspace (WORKSPACE, по умолчанию ../workspace от engine/):
//   frontmatter title, date, updated (если пост правили), description, source, topics; ниже — текст в Markdown.
// Служебные сообщения, репосты, пустые посты и посты из одной ссылки или медиа пропускаются.
// Посты короче MIN_WORDS слов (по умолчанию 250) не пишутся — они перечислены в отчёте.
// Фото поста копируются в public/materials/<slug>/ и ставятся в начало текста (если есть в экспорте).
// Повторный запуск не плодит дубли: состояние в .deploy/imported.json (ключ поста → slug и хеш),
// изменившийся пост перезаписывается с полем updated, неизменённый пропускается.
// Отчёт — данные/импорт-<дата>.md, сводка — в консоль. --dry-run показывает план и ничего не пишет.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WS } from '../src/lib/workspace.mjs';
import { splitParagraph } from '../src/lib/sentences.mjs';

const USAGE = 'node scripts/import-telegram.mjs <папка экспорта или result.json> [--channel имя_канала] [--dry-run]';
const fail = (msg) => { console.error(msg); process.exit(1); };

// ---------- аргументы ----------
const opts = { input: '', channel: '', dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--channel') opts.channel = argv[++i] ?? '';
  else if (a.startsWith('--channel=')) opts.channel = a.slice('--channel='.length);
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else if (a.startsWith('-')) fail(`Неизвестный флаг ${a}\n${USAGE}`);
  else if (!opts.input) opts.input = a;
  else fail(`Лишний аргумент ${a}\n${USAGE}`);
}
if (!opts.input) fail(USAGE);
// принимаем и «@name», и «https://t.me/name»
opts.channel = opts.channel.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
if (opts.channel && !/^[A-Za-z0-9_]{4,64}$/.test(opts.channel)) fail(`--channel: «${opts.channel}» не похоже на публичное имя канала`);

const MIN_WORDS = Number.isFinite(Number.parseInt(process.env.MIN_WORDS, 10)) ? Number.parseInt(process.env.MIN_WORDS, 10) : 250;
const MATERIALS = path.join(WS, 'content', 'materials');
const PUBLIC = path.join(WS, 'public', 'materials');
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
const HASHTAGS_ONLY = /^\s*(?:#[\p{L}\p{N}_]+[\s,]*)+$/u;
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

// ---------- Telegram → Markdown ----------
function entitiesOf(m) {
  if (Array.isArray(m.text_entities) && m.text_entities.length) return m.text_entities;
  if (typeof m.text === 'string') return m.text ? [{ type: 'plain', text: m.text }] : [];
  if (Array.isArray(m.text)) return m.text.map((t) => (typeof t === 'string' ? { type: 'plain', text: t } : t));
  return [];
}

// пробелы по краям выносим за разметку: «**слово **» Markdown не понимает
function wrap(part, mark, close = mark) {
  const [, lead, mid, trail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return mid ? `${lead}${mark}${mid}${close}${trail}` : part;
}

function inline(e, part) {
  switch (e.type) {
    case 'bold': return wrap(part, '**');
    case 'italic': return wrap(part, '_');
    case 'strikethrough': return wrap(part, '~~');
    case 'code': return wrap(part, '`');
    case 'text_link': {
      const href = String(e.href ?? '');
      if (!/^(https?:|mailto:)/i.test(href)) return part; // tg:// и прочее на сайте не откроется
      return wrap(part.replace(/[[\]]/g, '\\$&'), '[', `](${href.replace(/ /g, '%20').replace(/\)/g, '%29')})`);
    }
    default: return part; // plain, link, email, mention, hashtag, spoiler, underline, custom_emoji…
  }
}

// сущности → строки с видом (text, quote, code) и долей жирного — по ней узнаём заголовок
function toLines(entities) {
  const lines = [];
  const fresh = () => ({ kind: 'text', md: '', plain: '', chars: 0, bold: 0 });
  let cur = fresh();
  const push = () => { lines.push(cur); cur = fresh(); };
  for (const e of entities) {
    const text = clean(e.text);
    if (!text) continue;
    if (e.type === 'pre') {
      if (cur.md.trim()) push(); else cur = fresh();
      lines.push({ kind: 'code', md: `\`\`\`${e.language || ''}\n${text.replace(/\n+$/, '')}\n\`\`\``, plain: '', chars: 0, bold: 0 });
      continue;
    }
    const quote = /blockquote/.test(e.type);
    text.split('\n').forEach((part, i) => {
      if (i > 0) push();
      if (quote) cur.kind = 'quote';
      if (!part) return;
      cur.md += inline(e, part);
      cur.plain += part;
      const n = part.replace(/\s/g, '').length;
      cur.chars += n;
      if (e.type === 'bold') cur.bold += n;
    });
  }
  if (cur.md.trim()) push();
  // строки из одних хештегов на сайте не нужны
  return lines.filter((l) => l.kind === 'code' || !HASHTAGS_ONLY.test(l.plain));
}

// строки → Markdown: каждая строка — абзац, кроме списков, цитат и кода
function toMarkdown(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l.kind === 'code') { blocks.push(l.md); i++; continue; }
    if (l.kind === 'quote') {
      const q = [];
      while (i < lines.length && lines[i].kind === 'quote') q.push(lines[i++].md.trim());
      while (q.length && !q.at(-1)) q.pop();
      while (q.length && !q[0]) q.shift();
      if (q.length) blocks.push(q.map((s) => (s ? `> ${s}` : '>')).join('\n'));
      continue;
    }
    if (!l.md.trim()) { i++; continue; }
    if (LIST_RE.test(l.plain)) {
      const items = [];
      while (i < lines.length && lines[i].kind === 'text' && lines[i].md.trim() && LIST_RE.test(lines[i].plain)) {
        items.push(lines[i++].md.trim().replace(/^[•–·▪]\s+/, '- '));
      }
      blocks.push(items.join('\n'));
      continue;
    }
    // «# » или «> » в начале обычной строки — не разметка
    blocks.push(l.md.trim().replace(/^(#{1,6}\s|>)/, '\\$1'));
    i++;
  }
  return blocks.join('\n\n');
}

const cleanTitle = (s) => noEmoji(inlinePlain(s)).replace(/^[\s\-–—•*·▪]+/, '').replace(/[\s:：,;—–-]+$/, '').trim();

// заголовок: первая строка, если похожа на заголовок; иначе — первое предложение до 90 знаков
function pickTitle(lines) {
  const idx = lines.findIndex((l) => l.kind !== 'code' && hasWords(l.plain));
  if (idx === -1) return null;
  const first = lines[idx];
  const raw = noEmoji(first.plain).trim();
  const bold = first.chars > 0 && first.bold / first.chars >= 0.9;
  const t = cleanTitle(first.plain);
  if (first.kind === 'text' && t && raw.length <= 120 && !LIST_RE.test(first.plain)
    && raw.replace(URL_RE, '').trim() && (bold || !/[.!?…]$/.test(raw))) {
    return { title: t, drop: idx };
  }
  const para = paragraphs(toMarkdown(lines)).map(noEmoji).find(hasWords) || '';
  const sentence = splitParagraph(para)[0] || para;
  return { title: cleanTitle(cutWords(sentence, 90)).replace(/\.$/, ''), drop: -1 };
}

// ---------- вход ----------
let jsonPath = path.resolve(opts.input);
if (!fs.existsSync(jsonPath)) fail(`Нет такого пути: ${jsonPath}`);
if (fs.statSync(jsonPath).isDirectory()) jsonPath = path.join(jsonPath, 'result.json');
if (!fs.existsSync(jsonPath)) fail(`В папке нет result.json. Экспорт: Telegram Desktop → канал → ⋮ → «Экспорт истории чата» → формат JSON.`);
const exportDir = path.dirname(jsonPath);
let data;
try { data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (e) { fail(`result.json не читается: ${e.message}`); }
if (!Array.isArray(data.messages)) {
  fail(data.chats ? 'Это экспорт всего аккаунта. Нужен экспорт одного канала: откройте канал → ⋮ → «Экспорт истории чата».' : 'В result.json нет messages — это не экспорт чата Telegram.');
}
const chatKey = String(data.id ?? data.name ?? 'channel');

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

// альбом в экспорте — несколько сообщений с одним временем; текст у одного из них, фото — у всех
const groups = [];
for (const m of data.messages) {
  const g = groups.at(-1);
  const same = g && m.type === 'message' && g[0].type === 'message' && m.date_unixtime && m.date_unixtime === g[0].date_unixtime
    && (m.from_id ?? '') === (g[0].from_id ?? '') && ('forwarded_from' in m) === ('forwarded_from' in g[0]);
  if (same) g.push(m); else groups.push([m]);
}

const photoOf = (m) => {
  if (typeof m.photo !== 'string' || m.photo.startsWith('(')) return null; // «(File not included…)»
  const abs = path.resolve(exportDir, m.photo);
  return abs.startsWith(exportDir + path.sep) && fs.existsSync(abs) ? abs : null;
};
const textOf = (m) => entitiesOf(m).map((e) => clean(e.text)).join('');
const preview = (s) => { const t = noEmoji(s.replace(/\s+/g, ' ')); return t.length > 80 ? `${t.slice(0, 80)}…` : t; };

const res = { added: [], updated: [], same: [], short: [], skipped: [], album: 0 };
const plan = []; // что записать: [путь, содержимое] и фото

for (const g of groups) {
  const withText = g.filter((m) => m.type === 'message' && hasWords(textOf(m)));
  const posts = withText.length === 1 && g.length > 1 ? [withText[0]] : g;
  if (posts.length === 1 && g.length > 1) res.album += g.length - 1;
  for (const m of posts) {
    const photos = (posts.length === 1 ? g : [m]).map(photoOf).filter(Boolean);
    const date = String(m.date ?? '').slice(0, 10);
    const text = textOf(m);
    const skip = (reason) => res.skipped.push({ id: m.id, date, reason, text: preview(text) });
    if (m.type !== 'message') { skip('служебное'); continue; }
    if ('forwarded_from' in m) { skip('репост'); continue; }
    if (!text.trim()) { skip(m.photo || m.file || m.media_type || m.poll ? 'только медиа' : 'пустое'); continue; }
    if (!hasWords(text)) { skip('только ссылка или эмодзи'); continue; }

    const key = `telegram:${chatKey}:${m.id}`;
    const lines = toLines(entitiesOf(m));
    const picked = pickTitle(lines);
    if (!picked?.title) { skip('нет текста для заголовка'); continue; }
    const body = toMarkdown(lines.filter((_, i) => i !== picked.drop));
    const words = wordCount(paragraphs(body, true).join(' '));
    if (words < MIN_WORDS) { res.short.push({ id: m.id, date, text: preview(text), words }); continue; }

    const prev = state.items[key];
    const slug = prev?.slug ?? allocSlug(slugify(picked.title) || `post-${m.id}`, key);
    const images = photos.map((p) => `![](/materials/${slug}/${path.basename(p)})`);
    const material = {
      title: picked.title,
      date,
      description: makeDescription(body),
      source: opts.channel ? `https://t.me/${opts.channel}/${m.id}` : '',
      topics: headingsOf(body),
      body: [...images, body].join('\n\n'),
    };
    const hash = sha1(render(material));
    const edited = m.edited ? String(m.edited).slice(0, 10) : '';
    const item = { title: material.title, slug, date };
    if (prev?.hash === hash) { res.same.push(item); continue; }
    if (prev) material.updated = edited || TODAY;
    else if (edited && edited !== date) material.updated = edited;
    (prev ? res.updated : res.added).push(item);
    plan.push({ file: path.join(MATERIALS, `${slug}.md`), content: render(material), photos, slug });
    state.items[key] = { slug, hash, source: material.source || jsonPath, importedAt: prev?.importedAt ?? TODAY, ...(prev ? { updatedAt: TODAY } : {}) };
  }
}

// ---------- отчёт ----------
const cell = (s) => String(s).replace(/\|/g, '\\|');
const byReason = res.skipped.reduce((a, s) => ({ ...a, [s.reason]: (a[s.reason] || 0) + 1 }), {});
const report = [
  `# Импорт из Telegram — ${TODAY}`,
  '',
  `Источник: ${jsonPath}${data.name ? ` (канал «${data.name}»${opts.channel ? `, t.me/${opts.channel}` : ''})` : ''}`,
  `Порог: ${MIN_WORDS} слов.${opts.dryRun ? ' Пробный запуск: ничего не записано.' : ''}`,
  '',
  '## Итого',
  '',
  `- Сообщений в экспорте: ${data.messages.length}`,
  `- Импортировано новых: ${res.added.length}`,
  `- Обновлено: ${res.updated.length}`,
  `- Без изменений: ${res.same.length}`,
  `- Короткие, не импортированы: ${res.short.length}`,
  `- Пропущено прочих: ${res.skipped.length}${res.skipped.length ? ` (${Object.entries(byReason).map(([r, n]) => `${r} — ${n}`).join(', ')})` : ''}`,
  ...(res.album ? [`- Фото альбомов, приложенные к постам: ${res.album}`] : []),
];
const list = (title, items) => (items.length ? ['', `## ${title}`, '', ...items.map((i) => `- ${i.title} → \`${i.slug}\` (${i.date})`)] : []);
report.push(...list('Импортировано', res.added), ...list('Обновлено', res.updated));
if (res.short.length) {
  report.push('', `## Короткие посты (меньше ${MIN_WORDS} слов, не импортированы)`, '',
    'Можно дописать и импортировать заново или объединить несколько в один материал.', '',
    '| Дата | Пост | Начало текста | Слов |', '|---|---|---|---|',
    ...res.short.map((s) => `| ${s.date} | ${opts.channel ? `[${s.id}](https://t.me/${opts.channel}/${s.id})` : s.id} | ${cell(s.text)} | ${s.words} |`));
}
const notable = res.skipped.filter((s) => s.reason !== 'служебное' && s.reason !== 'пустое');
if (res.skipped.length) {
  report.push('', '## Пропущено', '', ...Object.entries(byReason).map(([r, n]) => `- ${r}: ${n}`));
  if (notable.length) {
    report.push('', '| Дата | Пост | Причина | Начало текста |', '|---|---|---|---|',
      ...notable.map((s) => `| ${s.date} | ${s.id} | ${s.reason} | ${cell(s.text)} |`));
  }
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
  console.log('Пробный запуск (--dry-run): файлы, фото, состояние и отчёт не записаны.');
  process.exit(0);
}
fs.mkdirSync(MATERIALS, { recursive: true });
for (const p of plan) {
  fs.writeFileSync(p.file, p.content);
  if (p.photos.length) {
    const dir = path.join(PUBLIC, p.slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const src of p.photos) {
      const dst = path.join(dir, path.basename(src));
      if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
    }
  }
}
fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
saveReport(reportText);
console.log(`Импорт из Telegram: новых ${res.added.length}, обновлено ${res.updated.length}, без изменений ${res.same.length}, `
  + `коротких ${res.short.length}, пропущено ${res.skipped.length}.`);
console.log(`Материалы: ${MATERIALS}`);
console.log(`Отчёт: ${REPORT}`);
