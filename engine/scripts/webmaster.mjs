// Яндекс Вебмастер для сайта из workspace/site.config.json.
//   node scripts/webmaster.mjs setup  — добавить сайт, подтвердить файлом yandex_<код>.html, отправить sitemap.
//                                       Запускать, пока не скажет «готово»: после создания файла нужна заливка (npm run deploy).
//   node scripts/webmaster.mjs status — подтверждён ли сайт, sitemap, квота переобхода, страницы в поиске, проблемы.
//   node scripts/webmaster.mjs stats  — снимок статистики и пар «запрос × страница» в workspace/данные/вебмастер/<дата>.json
//                                       (раз в день; post-deploy зовёт сам).
// Переобход изменённых страниц после каждой заливки — в post-deploy.mjs (очередь webmaster в workspace/.deploy/queue.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webmaster, WmError } from './lib/webmaster.mjs';
import { loadSite, readEnv, ws, localDate } from '../src/lib/workspace.mjs';

const STATS_DIR = ws('данные/вебмастер');
const site = loadSite();
const SITE = site.url;
const SITEMAP = `${SITE}/sitemap-index.xml`;

export function client() {
  return webmaster({ token: readEnv().YANDEX_WEBMASTER_TOKEN, siteUrl: SITE, stateFile: ws('.deploy/webmaster.json') });
}

// файл подтверждения — в workspace/public/, оттуда попадает в dist/ и на сервер (deploy.sh не удаляет yandex_*.html)
const verifyFile = (uin) => ({
  name: `yandex_${uin}.html`,
  body: `<html>\n    <head>\n        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">\n    </head>\n    <body>Verification: ${uin}</body>\n</html>\n`,
});

async function setup(wm) {
  const h = await wm.host({ add: true });
  console.log(`сайт в Вебмастере: ${h.host_id}${h.verified ? ', подтверждён' : ', не подтверждён'}`);
  if (!h.verified) {
    const v = await wm.verification();
    if (v.verification_state === 'IN_PROGRESS') { console.log('проверка прав уже идёт — запустите setup через минуту'); return; }
    const f = verifyFile(v.verification_uin);
    const local = ws('public', f.name);
    if (!fs.existsSync(local)) {
      fs.writeFileSync(local, f.body);
      console.log(`создан workspace/public/${f.name} — выложите сайт (npm run deploy) и запустите setup ещё раз`);
      return;
    }
    const live = await fetch(`${SITE}/${f.name}`, { signal: AbortSignal.timeout(15000) }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    if (!live.includes(`Verification: ${v.verification_uin}`)) {
      console.log(`файл ${f.name} ещё не на сайте — выложите сайт (npm run deploy) и запустите setup ещё раз`);
      return;
    }
    await wm.verify('HTML_FILE');
    for (let i = 0; i < 12; i++) {   // проверка обычно занимает секунды; ждём до минуты
      await new Promise((r) => setTimeout(r, 5000));
      const s = await wm.verification();
      if (s.verification_state === 'VERIFIED') break;
      if (s.verification_state && s.verification_state !== 'IN_PROGRESS') {
        console.log(`подтверждение не прошло: ${s.verification_state} ${s.fail_info?.reason || ''} ${s.fail_info?.message || ''}`);
        return;
      }
    }
    const again = await wm.host();
    if (!again?.verified) { console.log('Вебмастер ещё проверяет права — запустите setup через пару минут'); return; }
    console.log('сайт подтверждён');
  }
  const maps = await wm.sitemaps();
  if (maps.some((m) => m.sitemap_url === SITEMAP)) console.log(`sitemap уже отправлен: ${SITEMAP}`);
  else { await wm.addSitemap(SITEMAP); console.log(`sitemap отправлен: ${SITEMAP}`); }
  console.log('готово: дальше post-deploy сам ставит изменённые страницы на переобход и раз в день сохраняет статистику');
}

async function status(wm) {
  const h = await wm.host();
  if (!h) { console.log('сайта нет в Вебмастере — node scripts/webmaster.mjs setup'); return; }
  console.log(`сайт: ${h.host_id}, ${h.verified ? 'подтверждён' : 'НЕ подтверждён — node scripts/webmaster.mjs setup'}`);
  if (!h.verified) return;
  const [maps, q, s, d] = await Promise.all([wm.sitemaps(), wm.quota(), wm.summary(), wm.diagnostics()]);
  console.log(`sitemap: ${maps.map((m) => m.sitemap_url).join(', ') || 'не отправлен'}`);
  console.log(`переобход: осталось ${q.quota_remainder} из ${q.daily_quota} на сегодня`);
  console.log(`в поиске страниц: ${s.searchable_pages_count ?? '—'}, исключено: ${s.excluded_pages_count ?? '—'}, ИКС: ${s.sqi ?? '—'}`);
  const probs = Object.entries(d.problems || {}).filter(([, p]) => p.state === 'PRESENT');
  console.log(probs.length ? `проблемы: ${probs.map(([k, p]) => `${k} (${p.severity})`).join(', ')}` : 'проблем нет');
}

const mskDate = localDate;   // сутки в отчётах Вебмастера — московские

// сумма показов, кликов и спроса за период и средняя позиция, взвешенная по показам (statistics — по дням и полям)
function total(statistics = []) {
  const day = {};
  for (const { date, field, value } of statistics) (day[date] ??= {})[field] = value;
  let impressions = 0, clicks = 0, demand = 0, posW = 0;
  for (const d of Object.values(day)) {
    impressions += d.IMPRESSIONS || 0; clicks += d.CLICKS || 0; demand += d.DEMAND || 0;
    if (d.IMPRESSIONS && d.POSITION) posW += d.POSITION * d.IMPRESSIONS;
  }
  return { impressions, clicks, demand, position: impressions ? Math.round((posW / impressions) * 10) / 10 : null };
}

// пары «запрос × страница» из «Мониторинга запросов» (query-analytics/list, последние 2 недели) — для будущей проверки
// каннибализации. Готовой выгрузки пар в API нет: строка с text_indicator=URL несёт только самый частый запрос страницы,
// строка с QUERY — самую частую страницу запроса. Поэтому: список страниц, затем по каждой странице её запросы
// (filters.text_filters: URL TEXT_MATCH; адрес страницы в API — путь вида /about/). Фильтр проверен на живых данных:
// каждая страница возвращает только свои запросы. Если когда-нибудь все страницы вернут один и тот же полный список
// запросов — фильтр перестал работать: pairsCheck это отметит.
async function queryPairs(wm) {
  // строка без text_indicator.value пропускается: сбой формата не должен ронять post-deploy (он ловит только WmError)
  const val = (r) => r?.text_indicator?.value;
  const pages = (await wm.queryAnalytics({ text_indicator: 'URL' })).filter(val);
  const queries = (await wm.queryAnalytics({ text_indicator: 'QUERY' })).filter(val);
  const pairs = [], perPage = [];
  for (let i = 0; i < pages.length; i += 5) {   // по 5 страниц параллельно: у сайта на 100+ страниц снимок не тянется минутами
    const batch = pages.slice(i, i + 5).map(val);
    const res = await Promise.all(batch.map((url) => wm.queryAnalytics({ text_indicator: 'QUERY', filters: { text_filters: [{ text_indicator: 'URL', operation: 'TEXT_MATCH', value: url }] } })));
    res.forEach((rows, k) => {
      perPage.push(rows.length);
      for (const r of rows.filter(val)) pairs.push({ query: val(r), url: batch[k], ...total(r.statistics) });
    });
  }
  const suspect = pages.length > 1 && queries.length > 1 && perPage.every((n) => n === queries.length);
  return {
    pages: pages.map((r) => ({ url: val(r), topQuery: r.popular_complementary_indicator?.value ?? null, ...total(r.statistics) })),
    queries: queries.map((r) => ({ query: val(r), topUrl: r.popular_complementary_indicator?.value ?? null, ...total(r.statistics) })),
    pairs,
    pairsCheck: suspect ? 'фильтр по URL, похоже, не сработал: у всех страниц полный список запросов — пары не использовать' : 'ok',
  };
}

// снимок: сводка, диагностика и популярные запросы за 7 дней + «Мониторинг запросов» за 2 недели (queryAnalytics);
// если сегодняшний уже есть — ничего не делает (FORCE=1 — перезаписать).
// Каждая часть берётся отдельно: пока Вебмастер не «загрузил» сайт, summary и search-queries отвечают 404 HOST_NOT_LOADED
// (у нового сайта это бывает неделями, и снимков не было бы вовсе), а мониторинг запросов уже работает. Такая часть пишется как { error }.
export async function stats(wm, { quiet = false } = {}) {
  const today = mskDate(Date.now());
  const file = path.join(STATS_DIR, `${today}.json`);
  if (fs.existsSync(file) && process.env.FORCE !== '1') { if (!quiet) console.log(`снимок за ${today} уже есть`); return false; }
  const from = mskDate(Date.now() - 7 * 864e5);
  const part = (p) => p.catch((e) => {
    if (!(e instanceof WmError) || e.status !== 404) throw e;
    return { error: e.message.slice(e.message.indexOf(': ') + 2) };   // без пути запроса: в нём user_id
  });
  const [summary, diagnostics, queries, queryAnalytics] = await Promise.all([part(wm.summary()), part(wm.diagnostics()), part(wm.queries(from, today)), part(queryPairs(wm))]);
  fs.mkdirSync(STATS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ date: today, period: [from, today], summary, diagnostics, queries, queryAnalytics }, null, 1));
  const n = (x) => (x.error ? x.error.split(' ').slice(0, 2).join(' ') : 'есть');
  console.log(`Вебмастер: снимок статистики → workspace/данные/вебмастер/${today}.json (сводка: ${n(summary)}; запросы: ${n(queries)}; пар «запрос × страница»: ${queryAnalytics.error ? n(queryAnalytics) : `${queryAnalytics.pairs.length}, страниц ${queryAnalytics.pages.length}, запросов ${queryAnalytics.queries.length}`})`);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const run = { setup, status, stats }[cmd];
  if (!run) { console.log('команды: setup | status | stats'); process.exit(1); }
  try { await run(client()); } catch (e) {
    if (!(e instanceof WmError)) throw e;
    console.log(`Вебмастер: ${e.message}`);
    process.exit(1);
  }
}
