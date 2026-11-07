// Журнал Wordstat: результаты вызовов MCP yandex-ads (yd_wordstat_top_requests, yd_wordstat_dynamics) с датой и сроком годности.
// Скрипт сам Wordstat не вызывает — он только журнал ответов подключённого MCP. Порядок для агента:
//   get → есть свежая запись — берём её; нет (код выхода 1) → вызов MCP → add.
//
//   node scripts/wordstat-log.mjs get "<фраза>" [--method top_requests (по умолчанию)|dynamics] [--kind news|evergreen]
//        [--region 213,2] [--devices all] [--period monthly|weekly|daily] [--from ГГГГ-ММ-ДД --to ГГГГ-ММ-ДД]
//        — самая свежая подходящая запись одной строкой JSON (код 0) или «нет свежей записи» (код 1).
//   node scripts/wordstat-log.mjs add --method top_requests|dynamics --phrase "<фраза>" --kind news|evergreen|unknown
//        --by "<материал / тема>" [--region …] [--devices …] [--period … --from … --to …] < ответ.json
//        — ответ MCP целиком через stdin (можно только totalCount и первые 10 results). Ошибка MCP: --error "<текст>" без stdin.
//        Ответ-ошибка, пустой ответ {} или неполный (нет явного totalCount) в журнал как данные не попадает: скрипт отказывает (код 2),
//        сбой записывается только через --error. Нулевой спрос (zeroConfirmed) — лишь при явном totalCount: 0.
//        Полный ответ (после разворачивания content[].text) хранится в поле response.
//   node scripts/wordstat-log.mjs find "<часть фразы>" [--method …] [--kind …] [--region …] [--all]
//        — поиск по фразам и топ-формулировкам (печатает и их — для H2 и FAQ); по умолчанию только свежие, --all — и просроченные;
//        --kind, как в get, — для срока.
//   node scripts/wordstat-log.mjs spent — сколько вызовов записано за последний час и за сегодня (квота — в knowledge/semantics.md).
//
// Срок годности: top_requests (окно 30 дней) — вечнозелёная фраза 30 дней, новостная или «не знаю» — 7;
// dynamics помесячно — до 1-го числа следующего месяца (тогда выходят данные нового месяца), понедельно — 7 дней, по дням — 1.
// Тип фразы решает агент при get (--kind); если хоть одна сторона считает фразу новостной — срок 7 дней.
// Ключ фразы: нижний регистр, ё→е, лишние пробелы убраны. Порядок слов сохраняется: на практике порядок
// и лишние слова меняют цифру Wordstat.
// Журнал — workspace/данные/wordstat/журнал.jsonl (переменная WORDSTAT_LOG — другой файл, например для проверки).
// Запись — одной строкой через appendFileSync: несколько агентов параллельно не портят файл.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ws, localDate } from '../src/lib/workspace.mjs';

const LOG = process.env.WORDSTAT_LOG ? path.resolve(process.env.WORDSTAT_LOG) : ws('данные/wordstat/журнал.jsonl');
const mskDate = localDate;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const nextMonth = (d) => { const [y, m] = d.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };

const die = (msg, code = 2) => { console.log(msg); process.exit(code); };

export const normKey = (phrase) => String(phrase).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const normMethod = (m) => ({ top: 'top_requests', top_requests: 'top_requests', yd_wordstat_top_requests: 'top_requests', dynamics: 'dynamics', yd_wordstat_dynamics: 'dynamics' })[m];
const normKind = (k) => (!k ? undefined : /^(news|новост)/i.test(k) ? 'news' : /^(evergreen|вечнозел)/i.test(k) ? 'evergreen' : 'unknown');
const normRegion = (r) => (!r || r === 'all' ? '' : String(r).split(',').map((x) => x.trim()).filter(Boolean).sort((a, b) => a - b).join(','));

// до какой даты (не включая) запись свежая
export function expires(rec, askKind) {
  if (rec.method === 'dynamics') {
    if (rec.period === 'monthly') return nextMonth(rec.date);
    return addDays(rec.date, rec.period === 'daily' ? 1 : 7);
  }
  const kinds = [rec.kind, askKind];
  const evergreen = !kinds.includes('news') && kinds.includes('evergreen');
  return addDays(rec.date, evergreen ? 30 : 7);
}

function readLog() {
  if (!fs.existsSync(LOG)) return [];
  const out = [];
  for (const [i, line] of fs.readFileSync(LOG, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { console.error(`журнал, строка ${i + 1}: не JSON — пропущена`); }
  }
  return out;
}
const append = (recs) => {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, recs.map((r) => JSON.stringify(r) + '\n').join(''));
};

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opt.all = true;
    else if (a.startsWith('--')) {
      if (i + 1 >= argv.length) die(`нет значения у ${a}`);
      opt[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

// подходит ли запись под запрос get/find (метод, регион, устройства, период и диапазон динамики)
function matches(rec, q) {
  if (rec.error) return false;
  if (rec.method === 'top_requests' && (typeof rec.totalCount !== 'number' || !Number.isFinite(rec.totalCount) || rec.totalCount < 0)) return false;
  // Старые версии превращали {} в 0. Без явного подтверждения нуля такой кэш не доказывает отсутствие спроса.
  if (rec.method === 'top_requests' && rec.totalCount === 0 && !rec.top?.length && rec.zeroConfirmed !== true) return false;
  if (q.method && rec.method !== q.method) return false;
  if (q.region !== undefined && (rec.region || '') !== q.region) return false;
  if (q.devices && (rec.devices || 'all') !== q.devices) return false;
  if (q.period && rec.period !== q.period) return false;
  if (q.from && !(rec.from <= q.from)) return false;
  if (q.to && !(rec.to >= q.to)) return false;
  return true;
}

function query(opt) {
  const method = opt.method && normMethod(opt.method);
  if (opt.method && !method) die(`--method: top_requests или dynamics, а не «${opt.method}»`);
  if (opt.period && !['monthly', 'weekly', 'daily'].includes(opt.period)) die('--period: monthly | weekly | daily');
  return { method, region: opt.region === undefined ? undefined : normRegion(opt.region), devices: opt.devices, period: opt.period, from: opt.from, to: opt.to };
}

function get(pos, opt) {
  if (!pos[0]) die('get "<фраза>" [--method …] [--kind …] [--region …]');
  const key = normKey(pos[0]), today = mskDate(Date.now()), askKind = normKind(opt.kind);
  const q = query(opt);
  q.method ??= 'top_requests';   // без --method — топ запросов, основной метод
  q.region ??= '';   // без --region — вся Россия, как вызов MCP без regions
  const hits = readLog().filter((r) => r.key === key && matches(r, q)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const fresh = hits.filter((r) => today < expires(r, askKind));
  if (!fresh.length) {
    const last = hits.at(-1);
    die(`нет свежей записи для «${pos[0]}»${last ? ` (последняя — ${last.date}, ${last.method}, годна была до ${expires(last, askKind)})` : ''}: вызвать MCP, затем add`, 1);
  }
  const r = fresh.at(-1);
  console.log(JSON.stringify({ ...r, fresh_until: expires(r, askKind) }));
}

function find(pos, opt) {
  if (!pos[0]) die('find "<часть фразы>" [--method …] [--kind …] [--region …] [--all]');
  const needle = String(pos[0]).toLowerCase().replace(/ё/g, 'е').trim(), today = mskDate(Date.now());
  const q = query(opt), askKind = normKind(opt.kind);
  const hay = (r) => [r.phrase, ...(r.top || []).map((t) => t[0])].join('\n').toLowerCase().replace(/ё/g, 'е');
  const hits = readLog().filter((r) => matches(r, q) && hay(r).includes(needle))
    .map((r) => ({ r, until: expires(r, askKind) })).filter((x) => opt.all || today < x.until);
  if (!hits.length) die(`ничего не найдено по «${pos[0]}»${opt.all ? '' : ' среди свежих (--all — и просроченные)'}`, 1);
  for (const { r, until } of hits.slice(-30)) {
    const val = r.method === 'dynamics' ? `${r.period} ${r.from}…${r.to}: ${(r.series || []).map((s) => s[1]).join(',')}`
      : `totalCount ${r.totalCount}${r.top?.length ? ` (${r.top.map(([p, n]) => `${p} ${n}`).join('; ')})` : ''}`;
    console.log(`${r.date} ${r.method} «${r.phrase}»${r.region ? ` регион ${r.region}` : ''} ${r.kind} — ${val}; ${today < until ? `годна до ${until}` : 'просрочена'}; ${r.by || ''}`);
  }
  if (hits.length > 30) console.log(`… и ещё ${hits.length - 30}, уточните фразу`);
}

function add(pos, opt) {
  const method = normMethod(opt.method || '');
  if (!method || !opt.phrase || !opt.kind || !opt.by) die('add --method top_requests|dynamics --phrase "<фраза>" --kind news|evergreen|unknown --by "<для чего>" < ответ.json');
  const rec = {
    date: mskDate(Date.now()), at: new Date().toISOString(), method, phrase: opt.phrase.trim(), key: normKey(opt.phrase),
    region: normRegion(opt.region), devices: opt.devices || 'all', kind: normKind(opt.kind), by: opt.by,
  };
  if (method === 'dynamics') {
    if (!['monthly', 'weekly', 'daily'].includes(opt.period) || !opt.from || !opt.to) die('для dynamics нужны --period monthly|weekly|daily, --from и --to');
    Object.assign(rec, { period: opt.period, from: opt.from, to: opt.to });
  }
  if (opt.error) { append([{ ...rec, error: opt.error.slice(0, 300) }]); console.log(`записан сбой: ${rec.method} «${rec.phrase}»`); return; }
  if (process.stdin.isTTY) die('stdin: нужен JSON-ответ MCP через < файл или heredoc (или --error "<текст>" для сбоя)');
  let res;
  try { res = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { die('stdin: нужен JSON-ответ MCP (или --error "<текст>" для сбоя)'); }
  if (Array.isArray(res?.content)) {
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (res.isError || /^Error\b/i.test(text.trim())) die('MCP вернул ошибку: записать через --error, не как нулевой спрос');
    try { res = JSON.parse(text); } catch { die('MCP content.text не содержит JSON: записать через --error'); }
  }
  // ответ-ошибка API (code/message/error без данных) — не «спроса нет»: записывать через --error
  if (!res || typeof res !== 'object' || Array.isArray(res) || res.isError || res.error
      || ((res.code || res.message) && !('results' in res) && !('totalCount' in res))) {
    die('это ответ с ошибкой, а не данные: add … --error "<текст ошибки>"');
  }
  const num = (v) => typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : null;
  if (method === 'top_requests') {
    const count = num(res.totalCount);
    if (typeof res.totalCount === 'boolean' || count === null || !Number.isFinite(count) || count < 0
        || (res.results !== undefined && !Array.isArray(res.results))) {
      die('неполный ответ Wordstat: нужен явный totalCount; пустой ответ не означает нулевой спрос. Записать через --error');
    }
    if ((res.results || []).some((x) => !x || typeof x.phrase !== 'string' || !x.phrase.trim()
        || typeof x.count === 'boolean' || num(x.count) === null || !Number.isFinite(num(x.count)) || num(x.count) < 0)) {
      die('неверные results Wordstat: записать через --error, не использовать как измерение');
    }
    rec.totalCount = count;
    rec.top = (res.results || []).slice(0, 10).map((x) => [x.phrase, num(x.count)]);
    if (count === 0) rec.zeroConfirmed = true;
  } else {
    rec.series = (res.results || []).map((x) => [String(x.date).slice(0, 10), num(x.count)]);
    if (!rec.series.length) console.log('внимание: в ответе нет results — записан пустой ряд');
  }
  rec.response = res;   // полный ответ как есть: top хранит только первые 10 фраз
  if (opt.note) rec.note = opt.note;
  append([rec]);
  console.log(`записано: ${rec.method} «${rec.phrase}» ${rec.kind}, годна до ${expires(rec)}`);
}

function spent() {
  const now = Date.now(), today = mskDate(now);
  const calls = readLog().filter((r) => r.at);
  const hour = calls.filter((r) => now - Date.parse(r.at) < 3600e3).length;
  const day = calls.filter((r) => r.date === today).length;
  console.log(`вызовов Wordstat в журнале: за последний час ${hour}, сегодня ${day} (считаются только записанные через add, включая сбои)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const run = { get, find, add, spent }[cmd];
  if (!run) die('команды: get | add | find | spent (подробно — в шапке scripts/wordstat-log.mjs)');
  run(pos, opt);
}
