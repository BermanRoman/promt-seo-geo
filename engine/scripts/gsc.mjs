// Google Search Console API для сайта из workspace/site.config.json. Ресурс — gscProperty в конфиге:
// доменный «sc-domain:example.ru» (все поддомены) или «https://blog.example.ru/» (префикс адреса).
// Вход — сервисный аккаунт: ключ workspace/.secrets/gsc.json (в git не попадает), аккаунт добавлен в Search Console с правами «Полный».
//   node scripts/gsc.mjs status            — доступ к ресурсу, карты сайта и их статус.
//   node scripts/gsc.mjs sitemap           — отправить sitemap-index.xml (повторная отправка безопасна).
//   node scripts/gsc.mjs stats             — снимок за 28 дней (запросы, страницы) в workspace/данные/google/<дата>.json; раз в день.
//   node scripts/gsc.mjs inspect [url…]    — в индексе ли страницы; без адресов — все страницы из dist/ (лимит Google 2000 в день).
// Попросить Google проиндексировать обычную страницу через API нельзя (Indexing API — только вакансии и трансляции).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSite, ws, ENGINE, localDate } from '../src/lib/workspace.mjs';

const KEY_FILE = ws('.secrets/gsc.json');
const DATA = ws('данные/google');
const site = loadSite();
const SITE = site.url;
const HOST = site.host;
const PROPERTY = site.gscProperty || `${SITE}/`;
const mskDate = localDate;

export class GscError extends Error {}

// токен доступа по ключу сервисного аккаунта (JWT, RS256) — без внешних библиотек
let cached = null;
async function token() {
  if (cached && cached.exp > Date.now() + 60000) return cached.value;
  if (!fs.existsSync(KEY_FILE)) throw new GscError('нет ключа workspace/.secrets/gsc.json');
  const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/webmasters', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const r = await call('POST', 'https://oauth2.googleapis.com/token', new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }), false);
  cached = { value: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
  return cached.value;
}

async function call(method, url, body, auth = true) {
  const headers = auth ? { Authorization: `Bearer ${await token()}` } : {};
  if (body && !(body instanceof URLSearchParams)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) }); } catch (e) {
    throw new GscError(`Google API не отвечает (${e.name === 'TimeoutError' ? 'таймаут' : e.message})`);
  }
  const text = await r.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; } })() : {};
  if (!r.ok) throw new GscError(`${r.status} ${json.error?.message || json.error_description || json.error || json.raw || ''}`.trim());
  return json;
}

const V3 = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(PROPERTY)}`;
const sitemapUrl = `${SITE}/sitemap-index.xml`;

async function status() {
  const { siteEntry = [] } = await call('GET', 'https://searchconsole.googleapis.com/webmasters/v3/sites');
  const me = siteEntry.find((s) => s.siteUrl === PROPERTY);
  if (!me) throw new GscError(`ресурса ${PROPERTY} нет у сервисного аккаунта — добавьте его в Search Console («Пользователи и разрешения»)`);
  console.log(`ресурс ${PROPERTY}: права ${me.permissionLevel}`);
  const { sitemap = [] } = await call('GET', `${V3}/sitemaps`);
  for (const m of sitemap) {
    const sub = (m.contents || []).map((c) => `${c.type}: отправлено ${c.submitted ?? '—'}`).join(', ');
    console.log(`sitemap ${m.path}: прочитан ${m.lastDownloaded?.slice(0, 10) || 'ещё нет'}, ошибок ${m.errors || 0}, предупреждений ${m.warnings || 0}${sub ? `, ${sub}` : ''}`);
  }
  if (!sitemap.length) console.log('карт сайта нет — node scripts/gsc.mjs sitemap');
}

async function sitemap() {
  await call('PUT', `${V3}/sitemaps/${encodeURIComponent(sitemapUrl)}`);
  console.log(`sitemap отправлен: ${sitemapUrl}`);
}

// снимок за 28 дней по сайту: запросы и страницы; Google отдаёт данные с задержкой 2–3 дня
export async function stats({ quiet = false } = {}) {
  const today = mskDate(Date.now());
  const file = path.join(DATA, `${today}.json`);
  if (fs.existsSync(file) && process.env.FORCE !== '1') { if (!quiet) console.log(`снимок Google за ${today} уже есть`); return false; }
  const end = mskDate(Date.now() - 2 * 864e5), start = mskDate(Date.now() - 30 * 864e5);
  const onHost = [{ filters: [{ dimension: 'page', operator: 'contains', expression: `//${HOST}/` }] }];
  const q = (dimensions) => call('POST', `${V3}/searchAnalytics/query`, { startDate: start, endDate: end, dimensions, dimensionFilterGroups: onHost, rowLimit: 1000 });
  const [queries, pages, total] = await Promise.all([q(['query']), q(['page']), q([])]);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ date: today, period: [start, end], host: HOST, total: total.rows?.[0] || null, queries: queries.rows || [], pages: pages.rows || [] }, null, 1));
  const t = total.rows?.[0];
  console.log(`Google: снимок → workspace/данные/google/${today}.json (${start}…${end}: показов ${t?.impressions ?? 0}, кликов ${t?.clicks ?? 0})`);
  return true;
}

// все страницы сайта из dist/ (как в post-deploy: index.html, кроме черновиков и noindex)
function distPages() {
  const out = [], dist = path.join(ENGINE, 'dist');
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name === 'index.html' && !p.includes(`${path.sep}preview${path.sep}`) && !fs.readFileSync(p, 'utf8').includes('<meta name="robots" content="noindex')) {
        const rel = path.relative(dist, path.dirname(p));
        out.push(`${SITE}/${rel ? rel + '/' : ''}`);
      }
    }
  };
  walk(dist);
  return out.sort();
}

async function inspect(urls) {
  const list = urls.length ? urls : distPages();
  const res = [];
  for (const u of list) {
    const r = await call('POST', 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { inspectionUrl: u, siteUrl: PROPERTY, languageCode: 'ru' });
    const i = r.inspectionResult?.indexStatusResult || {};
    res.push({ url: u, verdict: i.verdict, coverage: i.coverageState, lastCrawl: i.lastCrawlTime, googleCanonical: i.googleCanonical, userCanonical: i.userCanonical, robots: i.robotsTxtState, fetch: i.pageFetchState });
    if (urls.length) console.log(`${u}\n  ${i.coverageState || '—'}; обход ${i.lastCrawlTime?.slice(0, 10) || 'не было'}${i.googleCanonical && i.googleCanonical !== u ? `; канонический у Google: ${i.googleCanonical}` : ''}`);
  }
  if (!urls.length) {
    const by = {};
    for (const r of res) by[r.coverage || '—'] = (by[r.coverage || '—'] || 0) + 1;
    fs.mkdirSync(DATA, { recursive: true });
    const file = path.join(DATA, `inspect-${mskDate(Date.now())}.json`);
    fs.writeFileSync(file, JSON.stringify(res, null, 1));
    console.log(`проверено ${res.length} страниц → workspace/данные/google/${path.basename(file)}`);
    for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${v} — ${k}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = { status, sitemap, stats: () => stats(), inspect: () => inspect(args) }[cmd];
  if (!run) { console.log('команды: status | sitemap | stats | inspect [url…]'); process.exit(1); }
  try { await run(); } catch (e) {
    if (!(e instanceof GscError)) throw e;
    console.log(`Search Console: ${e.message}`);
    process.exit(1);
  }
}
