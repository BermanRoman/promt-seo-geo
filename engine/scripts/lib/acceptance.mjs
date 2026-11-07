// Общая часть реестра приёмки (контракт — workflow.md, «Реестр приёмки»).
// Используют acceptance.mjs (команды sha/packet/record/check/baseline), check-acceptance.mjs и publish.mjs.
//
// Реестр: workspace/данные/acceptance.json. Ключ — slug. SHA-256 считается от БУДУЩЕГО опубликованного файла:
// итоговые байты с `draft: false` (для черновика — сам файл, для обновления темы — файл из explained/_pending/).
// Каждый этап хранит свой sha256 — то, что видел исполнитель. Запись:
//   { sha256: <SHA последнего foreman, для справки>, query, stages: { edit|check|foreman|reader: { date, sha256, … } } }
// Выпуск разрешён, если есть все четыре этапа, foreman.sha256 и reader.sha256 равны SHA-256 текущей цели,
// reader.packetSha256 равен текущему пакету; edit и check могут быть на более раннем SHA (прораб читает итог
// после правок сверщика и принимает их). Правка после foreman обесценивает foreman и reader.
// Читатель независим (independent: true) или у этапа reader есть override — запись человека о решении выпускать без него.
//
// Карточка допуска: workspace/данные/разборы/<slug>-допуск.md, frontmatter:
//   ---
//   query: "порог ндс на усн 2026"      # исходный запрос
//   page: event | topic | update         # какая страница (нет — update для файла из _pending, иначе event)
//   decision: допущено                   # для event/topic; для update — «обновить существующее»
//   ---
//   (дальше свободный текст: спрос, выдача, выбор страницы)
// Запрос и решение проверяются при record и при выпуске. Изменённый запрос в карточке останавливает выпуск.
//
// Опубликованные страницы (check-acceptance.mjs --published) проверяются только по SHA-256 файла:
//   workspace/данные/published.json — { slug: { sha256, date, acceptance } }, пишет publish.mjs после записи файла
//   (acceptance — SHA foreman, по которому выпущено);
//   workspace/данные/acceptance-baseline.json — { createdAt, pages: { slug: sha256 } } для страниц, опубликованных
//   до появления приёмки; создаётся один раз командой acceptance.mjs baseline (отказ, если файл есть или published.json не пуст).
// Записи acceptance.json, карточки и пакеты в этом режиме не участвуют: их проверяет publish.mjs при выпуске.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { ws, loadSite } from '../../src/lib/workspace.mjs';
import { splitParagraph } from '../../src/lib/sentences.mjs';

export const STAGES = ['edit', 'check', 'foreman', 'reader'];
export const REGISTRY = () => ws('данные/acceptance.json');
export const EXPLAINED = () => ws('content/explained');
export const PENDING = () => path.join(EXPLAINED(), '_pending');
export const cardPath = (slug) => ws('данные/разборы', `${slug}-допуск.md`);

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
// итоговые байты публикации: то, что publish.mjs запишет в explained/<slug>.md
export const finalRaw = (raw) => raw.replace(/^draft:\s*true\s*$/m, 'draft: false');

export function splitFm(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { data: null, body: raw };
  let data;
  try { data = parseYaml(m[1]) ?? {}; } catch (e) { return { data: null, body: raw.slice(m[0].length), error: e.message.split('\n')[0] }; }
  return { data, body: raw.slice(m[0].length) };
}

// какой файл будет опубликован: обновление из _pending важнее опубликованной страницы и черновика (как в preview),
// но снятое прорабом (rejected: true) пропускается. kind: pending | published | draft
export function targetOf(slug) {
  for (const file of [path.join(PENDING(), `${slug}.md`), path.join(EXPLAINED(), `${slug}.md`)]) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const data = splitFm(raw).data;
    const pending = file.startsWith(PENDING());
    if (pending && data?.rejected === true) continue;
    return { slug, file, raw: finalRaw(raw), pending, kind: pending ? 'pending' : data?.draft === false ? 'published' : 'draft' };
  }
  return null;
}

export function readRegistry() {
  const p = REGISTRY();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error(`${p}: не JSON (${e.message})`); }
}
export function writeRegistry(reg) {
  const p = REGISTRY();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// карточка допуска: { query, page, decision } или null, если файла нет
export function cardInfo(slug) {
  const p = cardPath(slug);
  if (!fs.existsSync(p)) return null;
  const { data } = splitFm(fs.readFileSync(p, 'utf8'));
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return { query: str(data?.query), page: str(data?.page), decision: str(data?.decision) };
}
export const cardQuery = (slug) => cardInfo(slug)?.query || null;
// понятная причина, если карточка не разрешает выпуск; null — разрешает. kind — pending | published | draft (см. targetOf)
export function cardProblem(slug, kind) {
  const c = cardInfo(slug);
  const rel = path.relative(ws(), cardPath(slug));
  if (!c) return `${slug}: нет карточки допуска (${rel})`;
  if (!c.query) return `${slug}: в карточке допуска нет query:`;
  const page = c.page || (kind === 'pending' ? 'update' : 'event');
  if (!['event', 'topic', 'update'].includes(page)) return `${slug}: page: «${page}» — только event, topic или update`;
  if (page === 'update' && kind === 'draft') return `${slug}: page: update допустимо только для обновления из _pending или опубликованной страницы, а это новый черновик`;
  if (page !== 'update' && kind === 'pending') return `${slug}: файл из _pending — это обновление, в карточке нужно page: update (сейчас ${page})`;
  const need = page === 'update' ? 'обновить существующее' : 'допущено';
  if (c.decision !== need) return `${slug}: решение карточки допуска «${c.decision || 'не указано'}», для page: ${page} нужно «${need}»`;
  return null;
}

const countWords = (t) => t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// Читательский пакет: всё, что страница показывает читателю и поиску, без переписки и методичек.
// Сверено с src/components/Razbor.astro: <title> (seoTitle или title), description, H1, строка автора и время чтения,
// «Коротко» (по предложениям), основной текст, «Вопросы и ответы», подпись нижнего перехода к материалу.
// Блок «Ещё по теме» (заголовки соседних страниц) в пакет и его SHA-256 не входит: он зависит от других выпусков.
export function buildPacket(slug, rawFinal) {
  const site = loadSite();
  const { data: d, body, error } = splitFm(rawFinal);
  if (!d) throw new Error(`${slug}: невалидный frontmatter${error ? ` (${error})` : ''}`);
  const faq = Array.isArray(d.faq) ? d.faq : [];
  const isTopic = d.kind === 'topic';
  const mats = [...new Set([...(d.materials ?? []), d.material])].filter(Boolean);
  const matTitle = (s) => {
    const p = ws('content/materials', `${s}.md`);
    if (!fs.existsSync(p)) return s;
    return String(splitFm(fs.readFileSync(p, 'utf8')).data?.title ?? s);
  };
  const minutes = Math.max(1, Math.round(countWords([body, d.short ?? '', ...faq.flatMap((f) => [f.q, f.a])].join(' ')) / 180));
  const out = [];
  out.push('# Читательский пакет страницы', '');
  out.push('## В поиске', `Заголовок в выдаче: ${d.seoTitle ?? d.title}`, `Описание в выдаче: ${d.description ?? ''}`, '');
  const day = (v) => new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/\s*г\.$/, '');
  const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);
  const dateLine = isTopic
    ? `обновлено ${day(d.updated ?? d.published)} · по ${mats.length} ${plural(mats.length, 'материалу', 'материалам', 'материалам')}`
    : `${day(d.published)}${d.updated ? ` · обновлено ${day(d.updated)}` : ''}`;
  out.push('## На странице', `# ${d.title}`, `${site.author.name} · ${minutes} мин чтения`, dateLine, '');
  out.push('### Коротко', ...splitParagraph(String(d.short ?? '')), '');
  out.push('### Основной текст', body.trim(), '');
  if (faq.length) { out.push('### Вопросы и ответы'); for (const f of faq) out.push(`**${f.q}**`, f.a, ''); }
  out.push('### Переход внизу страницы');
  out.push(isTopic
    ? `Эта тема разбиралась в материалах: ${mats.length}; последний раз — в материале «${matTitle(d.material)}» (ссылка).`
    : `Подробнее — в материале «${matTitle(d.material)}» (ссылка).`, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
export const packetSha = (slug, rawFinal) => sha256(buildPacket(slug, rawFinal));

// Проверка пачки. items — [{ slug, raw, kind }], raw — итоговые байты. Возвращает список ошибок (пусто — приёмка действует).
export function acceptanceErrors(items) {
  const errors = [];
  let reg;
  try { reg = readRegistry(); } catch (e) { return [e.message]; }
  for (const { slug, raw, kind } of items) {
    const rec = reg[slug];
    if (!rec) { errors.push(`${slug}: нет записи приёмки (node scripts/acceptance.mjs record ${slug} --stage …)`); continue; }
    const sha = sha256(raw);
    const st = rec.stages ?? {};
    const missing = STAGES.filter((s) => !st[s]);
    if (missing.length) { errors.push(`${slug}: не хватает этапов: ${missing.join(', ')}`); continue; }
    for (const s of ['foreman', 'reader']) {
      if (st[s].sha256 !== sha) errors.push(`${slug}: файл изменён после этапа ${s} (SHA-256 не совпадает) — этап нужно пройти заново`);
    }
    const problem = cardProblem(slug, kind);
    if (problem) errors.push(problem);
    else if (cardQuery(slug) !== rec.query) errors.push(`${slug}: запрос в карточке допуска изменён после приёмки («${rec.query}» → «${cardQuery(slug)}»)`);
    const r = st.reader;
    if (r.openBlockers !== 0) errors.push(`${slug}: у читателя открытых блокеров: ${r.openBlockers}`);
    if (r.verdict !== 'pass') errors.push(`${slug}: вердикт читателя — ${r.verdict ?? 'нет'}, нужен pass`);
    if (!Number.isInteger(r.round) || r.round < 1 || r.round > 3) errors.push(`${slug}: круг читателя ${r.round} (допустимо 1–3)`);
    if (r.independent !== true && !(typeof r.override === 'string' && r.override.trim())) {
      errors.push(`${slug}: читатель не независимый и нет override (запись человека: дата и кто решил выпускать без независимого читателя)`);
    }
    try {
      if (r.packetSha256 !== packetSha(slug, raw)) errors.push(`${slug}: читатель смотрел другой пакет — собрать новый (acceptance.mjs packet) и прочитать заново`);
    } catch (e) { errors.push(e.message); }
  }
  return errors;
}

export const BASELINE = () => ws('данные/acceptance-baseline.json');
export const PUBLISHED = () => ws('данные/published.json');
const readJson = (p) => {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error(`${p}: не JSON (${e.message})`); }
};
export const readBaseline = () => readJson(BASELINE())?.pages ?? {};
export const readPublished = () => readJson(PUBLISHED()) ?? {};
export function writePublished(obj) {
  fs.mkdirSync(path.dirname(PUBLISHED()), { recursive: true });
  const tmp = `${PUBLISHED()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, PUBLISHED());
}
// опубликованные страницы (draft: false, не _pending) с их байтами
export function publishedPages() {
  const dir = EXPLAINED();
  return (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : []).map((f) => {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    return { slug: f.replace(/\.md$/, ''), raw, data: splitFm(raw).data };
  }).filter((x) => x.data?.draft === false);
}
// каждая опубликованная страница: SHA-256 файла записан publish.mjs или есть в baseline
export function publishedErrors() {
  let pub, base;
  try { pub = readPublished(); base = readBaseline(); } catch (e) { return [e.message]; }
  const errors = [];
  for (const { slug, raw } of publishedPages()) {
    const sha = sha256(raw);
    if (pub[slug]?.sha256 === sha || base[slug] === sha) continue;
    errors.push(`опубликовано: ${slug}: файл не совпадает с записью publish.mjs (published.json) и baseline — правка в обход выпуска или страница без приёмки`);
  }
  return errors;
}
