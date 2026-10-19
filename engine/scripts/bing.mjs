// Bing Webmaster Tools API для сайта из workspace/site.config.json. Ключ — BING_WEBMASTER_KEY в workspace/.env (Settings → API Access).
//   node scripts/bing.mjs status   — сайт подтверждён ли, карты сайта, обход за последние дни (обошёл, в индексе, ошибки).
//   node scripts/bing.mjs sitemap  — отправить sitemap-index.xml (повторная отправка безопасна).
//   node scripts/bing.mjs stats    — снимок (запросы, страницы, обход) в workspace/данные/bing/<дата>.json; раз в день.
//   node scripts/bing.mjs submit   — отправить все страницы из dist/ через API (до 100 в день): на старте, пока Bing не знает сайт.
// Новые страницы Bing узнаёт через IndexNow (post-deploy).
// Индекс Bing — основа поиска ChatGPT, Copilot и DuckDuckGo: присутствие здесь важно для ответов нейросетей.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSite, readEnv, ws, ENGINE, localDate } from '../src/lib/workspace.mjs';

const DATA = ws('данные/bing');
const API = 'https://ssl.bing.com/webmaster/api.svc/json';
const site = loadSite();
const SITE = `${site.url}/`;   // Bing хранит адрес сайта со слешем на конце
const mskDate = localDate;
// даты Bing приходят как "/Date(1697000000000-0700)/"
const bDate = (s) => { const m = /\((\d+)/.exec(s || ''); return m ? mskDate(+m[1]) : null; };

export class BingError extends Error {}

async function call(method, name, params = {}, body) {
  const key = readEnv().BING_WEBMASTER_KEY;
  if (!key) throw new BingError('нет BING_WEBMASTER_KEY в workspace/.env');
  const q = new URLSearchParams({ apikey: key, ...params });
  let r;
  try {
    r = await fetch(`${API}/${name}?${q}`, { method, headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) { throw new BingError(`API Bing не отвечает (${e.name === 'TimeoutError' ? 'таймаут' : e.message})`); }
  const text = await r.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; } })() : {};
  if (!r.ok) throw new BingError(`${name}: ${r.status} ${json.Message || json.raw || ''}`.trim());   // ключ в текст ошибки не попадает
  return json.d ?? json;
}

async function status() {
  const sites = await call('GET', 'GetUserSites');
  const me = sites.find((s) => s.Url === SITE);
  if (!me) throw new BingError(`сайта ${SITE} нет в Bing Webmaster`);
  console.log(`сайт ${SITE}: ${me.IsVerified ? 'подтверждён' : 'НЕ подтверждён'}`);
  const feeds = await call('GET', 'GetFeeds', { siteUrl: SITE });
  for (const f of feeds) console.log(`sitemap ${f.Url}: ${f.Status || '—'}, адресов ${f.UrlCount ?? '—'}, прочитан ${bDate(f.LastCrawled) || 'ещё нет'}`);
  if (!feeds.length) console.log('карт сайта нет — node scripts/bing.mjs sitemap');
  const crawl = (await call('GET', 'GetCrawlStats', { siteUrl: SITE })).slice(-7);
  for (const c of crawl) console.log(`${bDate(c.Date)}: обошёл ${c.CrawledPages}, в индексе ${c.InIndex}, ошибок ${c.CrawlErrors}`);
}

async function sitemap() {
  await call('POST', 'SubmitFeed', {}, { siteUrl: SITE, feedUrl: `${SITE}sitemap-index.xml` });
  console.log(`sitemap отправлен: ${SITE}sitemap-index.xml`);
}

export async function stats({ quiet = false } = {}) {
  const today = mskDate(Date.now());
  const file = path.join(DATA, `${today}.json`);
  if (fs.existsSync(file) && process.env.FORCE !== '1') { if (!quiet) console.log(`снимок Bing за ${today} уже есть`); return false; }
  const [queries, pages, crawl] = await Promise.all(['GetQueryStats', 'GetPageStats', 'GetCrawlStats'].map((n) => call('GET', n, { siteUrl: SITE })));
  const norm = (rows) => rows.map(({ __type, ...r }) => ({ ...r, Date: bDate(r.Date) }));
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ date: today, site: SITE, queries: norm(queries), pages: norm(pages), crawl: norm(crawl) }, null, 1));
  const last = crawl.at(-1);
  console.log(`Bing: снимок → workspace/данные/bing/${today}.json (запросов ${queries.length}, страниц с показами ${pages.length}${last ? `, в индексе ${last.InIndex}` : ''})`);
  return true;
}

// все страницы из dist/ (кроме черновиков и noindex) — одной пачкой через SubmitUrlBatch, в пределах дневной квоты
async function submit() {
  const out = [], dist = path.join(ENGINE, 'dist');
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name === 'index.html' && !p.includes(`${path.sep}preview${path.sep}`) && !fs.readFileSync(p, 'utf8').includes('<meta name="robots" content="noindex')) {
      const rel = path.relative(dist, path.dirname(p)); out.push(`${SITE}${rel ? rel + '/' : ''}`);
    } } };
  walk(dist);
  const q = await call('GET', 'GetUrlSubmissionQuota', { siteUrl: SITE });
  const list = out.slice(0, q.DailyQuota ?? 10);
  await call('POST', 'SubmitUrlBatch', {}, { siteUrl: SITE, urlList: list });
  console.log(`Bing: отправлено ${list.length} из ${out.length} страниц (квота на сегодня ${q.DailyQuota})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = { status, sitemap, submit, stats: () => stats() }[process.argv[2]];
  if (!run) { console.log('команды: status | sitemap | submit | stats'); process.exit(1); }
  try { await run(); } catch (e) {
    if (!(e instanceof BingError)) throw e;
    console.log(`Bing: ${e.message}`);
    process.exit(1);
  }
}
