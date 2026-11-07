// Приёмка страниц (контракт — workflow.md, «Реестр приёмки»). Реестр: workspace/данные/acceptance.json.
//   node scripts/acceptance.mjs sha <slug>        — SHA-256 будущего опубликованного файла (draft: false;
//                                                   для обновления темы — файл из explained/_pending/)
//   node scripts/acceptance.mjs packet <slug> [--out файл]
//                                                 — читательский пакет (то, что видит читатель и поиск) и его SHA-256 последней строкой
//   node scripts/acceptance.mjs record <slug> --stage edit|check|foreman|reader [--by кто (обязателен для edit и check)] [--query "…"]
//        [--round N --blockers N --verdict pass|fail --packet-sha <SHA-256 пакета> --independent true|false [--override "дата, кто решил"]]
//                                                 — запись этапа после фактического чтения. Одобрение скрипт сам не выставляет.
//                                                   Каждый этап хранит свой sha256; порядок edit → check → foreman → reader обязателен.
//                                                   Нужна карточка допуска с решением (формат — lib/acceptance.mjs).
//   node scripts/acceptance.mjs baseline          — один раз: зафиксировать SHA-256 страниц, опубликованных до приёмки
//                                                   (данные/acceptance-baseline.json); отказ, если файл есть или published.json не пуст
//   node scripts/acceptance.mjs check <slug>[,<slug>…] — то же, что check-acceptance.mjs: код 1, если выпуск нельзя разрешать
// Запрос и решение берутся из карточки допуска workspace/данные/разборы/<slug>-допуск.md; --query только подтверждает запрос.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from '../src/lib/workspace.mjs';
import { STAGES, targetOf, sha256, packetSha, buildPacket, readRegistry, writeRegistry, cardQuery, cardProblem, acceptanceErrors, publishedPages, publishedErrors, readPublished, BASELINE } from './lib/acceptance.mjs';

const die = (msg) => { console.error(msg); process.exit(1); };

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (i + 1 >= argv.length) die(`нет значения у ${argv[i]}`);
      opt[argv[i].slice(2)] = argv[++i];
    } else pos.push(argv[i]);
  }
  return { pos, opt };
}
const need = (slug) => {
  if (!slug) die('нужен slug страницы');
  const t = targetOf(slug);
  if (!t) die(`${slug}: нет файла ни в content/explained/, ни в content/explained/_pending/`);
  return t;
};

function sha(slug) { console.log(sha256(need(slug).raw)); }

function packet(slug, opt) {
  const t = need(slug);
  const text = buildPacket(slug, t.raw);
  const full = `${text}\nSHA-256 пакета: ${sha256(text)}\n`;
  if (opt.out) { fs.mkdirSync(path.dirname(path.resolve(opt.out)), { recursive: true }); fs.writeFileSync(opt.out, full); console.log(`пакет записан: ${opt.out}\nSHA-256 пакета: ${sha256(text)}`); } else process.stdout.write(full);
}

function record(slug, opt) {
  const t = need(slug);
  if (!STAGES.includes(opt.stage)) die(`--stage: ${STAGES.join(' | ')}`);
  const problem = cardProblem(slug, t.kind);
  if (problem) die(problem);
  const card = cardQuery(slug);
  if (opt.query && opt.query.trim() !== card) die(`${slug}: --query не совпадает с карточкой допуска («${card}»)`);
  const reg = readRegistry();
  const sha = sha256(t.raw);
  let rec = reg[slug];
  if (rec && rec.query !== card) { console.log('запрос в карточке изменился — прежние этапы сброшены'); rec = null; }
  rec ??= { query: card, stages: {} };
  const prior = STAGES.slice(0, STAGES.indexOf(opt.stage));
  const gap = prior.filter((s) => !rec.stages[s]);
  if (gap.length) die(`${slug}: этап ${opt.stage} записывается после ${gap.join(', ')}`);
  const entry = { date: localDate(Date.now()), sha256: sha };
  if (opt.stage === 'edit' || opt.stage === 'check') {
    if (!opt.by || !opt.by.trim()) die('--by обязателен для edit и check: кто фактически читал (роль или имя)');
    entry.by = opt.by.trim();
  }
  if (opt.stage === 'reader') {
    const round = Number(opt.round), blockers = Number(opt.blockers);
    if (!Number.isInteger(round) || round < 1 || round > 3) die('--round: целое 1–3');
    if (!Number.isInteger(blockers) || blockers < 0) die('--blockers: целое 0 и больше');
    if (!['pass', 'fail'].includes(opt.verdict)) die('--verdict: pass | fail');
    if (!['true', 'false'].includes(opt.independent)) die('--independent: true | false (false — читатель тот же агент)');
    if (opt.independent === 'false' && !(opt.override || '').trim()) console.log('внимание: без --override "<дата, кто решил>" ненезависимый читатель выпуск не откроет');
    if (!/^[0-9a-f]{64}$/.test(opt['packet-sha'] || '')) die('--packet-sha: SHA-256 пакета из acceptance.mjs packet');
    if (opt['packet-sha'] !== packetSha(slug, t.raw)) die(`${slug}: --packet-sha не совпадает с текущим пакетом — страница изменилась после сборки пакета`);
    Object.assign(entry, { packetSha256: opt['packet-sha'], round, openBlockers: blockers, verdict: opt.verdict, independent: opt.independent === 'true' });
    if ((opt.override || '').trim()) entry.override = opt.override.trim();
    if (blockers > 0 || opt.verdict !== 'pass') console.log('внимание: запись не открывает публикацию (блокеры или вердикт не pass)');
  }
  rec.stages[opt.stage] = entry;
  // более поздние этапы относятся к прежней версии файла и в проверке всё равно не совпадут по SHA-256; удаляем, чтобы не вводить в заблуждение
  for (const later of STAGES.slice(STAGES.indexOf(opt.stage) + 1)) if (rec.stages[later] && rec.stages[later].sha256 !== sha) delete rec.stages[later];
  if (rec.stages.foreman) rec.sha256 = rec.stages.foreman.sha256; else delete rec.sha256;
  reg[slug] = rec;
  writeRegistry(reg);
  console.log(`записано: ${slug}, этап ${opt.stage}, sha256 ${sha.slice(0, 12)}…`);
}

// один раз для страниц, опубликованных до приёмки: workspace/данные/acceptance-baseline.json = { createdAt, pages: { slug: sha256 } }
function baseline() {
  if (fs.existsSync(BASELINE())) die(`${BASELINE()} уже есть — baseline создаётся один раз`);
  if (Object.keys(readPublished()).length) die('published.json не пуст — через publish.mjs уже что-то выпущено, baseline создаётся только до первого выпуска');
  const pages = {};
  for (const { slug, raw } of publishedPages()) pages[slug] = sha256(raw);
  fs.mkdirSync(path.dirname(BASELINE()), { recursive: true });
  fs.writeFileSync(BASELINE(), JSON.stringify({ createdAt: new Date().toISOString(), pages }, null, 2) + '\n');
  console.log(`baseline: ${Object.keys(pages).length} опубликованных страниц → ${BASELINE()}`);
}

export function runPublished() {
  const errors = publishedErrors();
  if (errors.length) { console.log(errors.join('\n')); console.log('\nесть опубликованные страницы, которых нет в published.json и baseline, — заливка остановлена'); return false; }
  console.log(`опубликованные страницы: все совпадают с published.json или baseline (${publishedPages().length})`);
  return true;
}

export function runCheck(slugs) {
  const items = slugs.map((slug) => need(slug));
  const errors = acceptanceErrors(items);
  const reg = readRegistry();
  for (const s of slugs) if (reg[s]?.stages?.reader?.override) console.log(`внимание: ${s} — выпуск без независимого читателя по решению: ${reg[s].stages.reader.override}`);
  if (errors.length) { console.log(errors.join('\n')); console.log('\nприёмка не действует — выпуск остановлен'); return false; }
  console.log(`приёмка действует: ${slugs.join(', ')}`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  if (cmd === 'sha') sha(pos[0]);
  else if (cmd === 'packet') packet(pos[0], opt);
  else if (cmd === 'record') record(pos[0], opt);
  else if (cmd === 'check') { if (!pos[0]) die('check <slug>[,<slug>…]'); process.exit(runCheck(pos.join(',').split(',').map((s) => s.trim()).filter(Boolean)) ? 0 : 1); }
  else if (cmd === 'baseline') baseline();
  else die('команды: sha | packet | record | baseline | check (подробно — в шапке scripts/acceptance.mjs)');
}
