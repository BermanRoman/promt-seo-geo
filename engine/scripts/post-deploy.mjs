// После заливки: находит новые и изменённые страницы и отправляет их
//   • в IndexNow (Яндекс и Bing узнают о странице сразу);
//   • в Яндекс Вебмастер на переобход (в пределах дневной квоты; сайт подтверждается командой node scripts/webmaster.mjs setup);
//   • в archive.org (снимок с датой — независимая копия и подтверждение авторства).
// Плюс раз в день — снимок статистики Вебмастера, Search Console и Bing в workspace/данные/.
// Сбой любого сервиса не ломает публикацию: ошибка пишется в лог, страница остаётся в очереди до следующего раза.
// Состояния не склеиваются (workflow.md, «Состояния выпуска»): «подача принята сервисом» и «снимок archive.org готов» —
// разные записи в workspace/.deploy/archive-jobs.json (pending → success/error); успешная заливка не доказывает успех подачи.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { client as wmClient, stats as wmStats } from './webmaster.mjs';
import { WmError } from './lib/webmaster.mjs';
import { stats as gscStats, GscError } from './gsc.mjs';
import { stats as bingStats, BingError } from './bing.mjs';

import { loadSite, readEnv, ws, ENGINE } from '../src/lib/workspace.mjs';

const DIST = path.join(ENGINE, 'dist');
const STATE = ws('.deploy');
const MANIFEST = path.join(STATE, 'manifest.json');
const QUEUE = path.join(STATE, 'queue.json');

const env = readEnv();
// без конфига работать нельзя: тихий откат к «индексация закрыта» прятал бы ошибку
const site = loadSite();
const SITE = site.url;
const host = site.host;

// 1. какие страницы изменились с прошлой заливки
const pages = {};
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name === 'index.html' && !p.includes(`${path.sep}preview${path.sep}`)) {  // черновики не отправляем никуда
      const rel = path.relative(DIST, path.dirname(p));
      const url = `${SITE}/${rel ? rel + '/' : ''}`;
      // сравниваем текст внутри <main> плюс title и description: смена оформления и разметки изменением не считается
      const html = fs.readFileSync(p, 'utf8');
      if (html.includes('<meta name="robots" content="noindex')) continue;  // закрытые страницы (404, пустые списки) — тоже нет
      // блок «Ещё по …» меняется при каждой новой соседней странице — это не правка самой страницы
      // служебные скрипты внутри <main> (включение анимаций и т. п.) — не текст страницы
      const main = (html.match(/<main[\s\S]*?<\/main>/) || [html])[0].replace(/<nav class="more"[\s\S]*?<\/nav>/, '').replace(/<script[\s\S]*?<\/script>/g, '');
      // заголовок и описание тоже считаются: их правка должна снова уйти в поисковики
      const head = [html.match(/<title>[^<]*<\/title>/)?.[0], html.match(/<meta name="description" content="[^"]*"/)?.[0]].join(' ');
      const text = (head + ' ' + main.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      pages[url] = crypto.createHash('sha1').update(text).digest('hex');
    }
  }
};
walk(DIST);
fs.mkdirSync(STATE, { recursive: true });
const prev = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
// очередь по сервисам: страница ждёт только у того сервиса, который её ещё не принял
let q = fs.existsSync(QUEUE) ? JSON.parse(fs.readFileSync(QUEUE, 'utf8')) : {};
if (Array.isArray(q)) q = { indexnow: q, archive: q };
if (!q.webmaster) q.webmaster = [];
// ALL=1 — отправить все страницы заново (например, после смены превью или оформления)
const changed = Object.keys(pages).filter((u) => process.env.ALL === '1' || prev[u] !== pages[u]);
// страница-источник — материал автора (/<materials.path>/<slug>/): разборы на него ссылаются, поэтому его подают первым
const isSourcePage = (u) => u.startsWith(`${SITE}/${site.materials.path}/`);
const newPages = changed.filter((u) => !prev[u]).sort((a, b) => Number(isSourcePage(b)) - Number(isSourcePage(a)));
const inQ = new Set([...(q.indexnow || []), ...changed]);
// новые публикации получают снимок раньше старого хвоста; все адреса сохраняются
const arQ = new Set([...newPages, ...changed, ...(q.archive || [])]);
// квота переобхода маленькая: первыми — главная и новые страницы этой заливки, потом остальные изменённые и хвост прошлых
const wmQ = new Set([...changed.filter((u) => u === `${SITE}/`), ...newPages, ...changed, ...q.webmaster]);
// сначала очередь, потом манифест: если процесс прервут, изменённые страницы останутся в очереди
fs.writeFileSync(QUEUE, JSON.stringify({ indexnow: [...inQ], archive: [...arQ], webmaster: [...wmQ] }));
fs.writeFileSync(MANIFEST, JSON.stringify(pages, null, 1));
console.log(`изменённых страниц: ${changed.length}; в очереди IndexNow: ${inQ.size}, Вебмастер: ${wmQ.size}, archive.org: ${arQ.size}`);

// снимок статистики Вебмастера — раз в день, при любой заливке, даже без изменённых страниц; сбой не мешает остальному
let wmDown = false;   // API не ответил в этой заливке — второй раз не ждём таймаут
async function webmasterStats() {
  if (process.env.MARK_ONLY) return;
  if (env.YANDEX_WEBMASTER_TOKEN && !wmDown) {
    try { await wmStats(wmClient(), { quiet: true }); } catch (e) {
      if (!(e instanceof WmError)) throw e;
      console.log(`Вебмастер, статистика: ${e.message}`);
    }
  }
  // Search Console: ключ workspace/.secrets/gsc.json; нет ключа — молча пропускаем
  if (fs.existsSync(ws('.secrets/gsc.json'))) {
    try { await gscStats({ quiet: true }); } catch (e) {
      if (!(e instanceof GscError)) throw e;
      console.log(`Search Console, статистика: ${e.message}`);
    }
  }
  if (env.BING_WEBMASTER_KEY) {
    try { await bingStats({ quiet: true }); } catch (e) {
      if (!(e instanceof BingError)) throw e;
      console.log(`Bing, статистика: ${e.message}`);
    }
  }
}

if (!inQ.size && !arQ.size && !wmQ.size) { await webmasterStats(); process.exit(0); }
if (process.env.MARK_ONLY) {  // только запомнить текущее состояние, ничего не отправлять
  fs.writeFileSync(QUEUE, JSON.stringify({ indexnow: [], archive: [], webmaster: [] }));
  console.log('состояние запомнено, отправка пропущена');
  process.exit(0);
}

if (!site?.indexing) {
  console.log('индексация закрыта (indexing: false) — в поисковики и архив не отправляем');
  fs.writeFileSync(QUEUE, JSON.stringify({ indexnow: [...inQ], archive: [...arQ], webmaster: [...wmQ] }));
  process.exit(0);
}

const failedIn = new Set(), failedAr = new Set(), failedWm = new Set();
const saveQueue = (arLeft) => fs.writeFileSync(QUEUE, JSON.stringify({ indexnow: [...failedIn], archive: [...new Set([...failedAr, ...arLeft])], webmaster: [...failedWm] }));

// 2. IndexNow: общий шлюз (Bing и др.) + Яндекс
const inUrls = [...inQ];
if (env.INDEXNOW_KEY && inUrls.length) {
  const body = JSON.stringify({ host, key: env.INDEXNOW_KEY, keyLocation: `${SITE}/${env.INDEXNOW_KEY}.txt`, urlList: inUrls });
  // По протоколу IndexNow любой шлюз пересылает адреса всем участникам (Яндекс, Bing и др.),
  // поэтому достаточно, чтобы принял хотя бы один.
  let accepted = false;
  for (const ep of ['https://api.indexnow.org/indexnow']) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body, signal: AbortSignal.timeout(20000) });
      // 200 — приняли, 202 — ключ ещё проверяют, но адреса уже у них; иначе печатаем ответ, чтобы была видна причина
      const why = r.status < 300 ? '' : ` ${(await r.text().catch(() => '')).slice(0, 200)}`;
      // 403 — ключ не подходит к хосту: у каждого сайта и поддомена свой ключ и свой файл <ключ>.txt в корне
      const hint = r.status === 403 ? ' — ключ не принят: у этого сайта должен быть свой ключ (node scripts/doctor.mjs indexnow) и файл ключа на сайте' : '';
      console.log(`IndexNow ${new URL(ep).host}: ${r.status}${why}${hint}`);
      if (r.status < 300) accepted = true;
    } catch (e) {
      console.log(`IndexNow ${new URL(ep).host}: ошибка ${e.message}`);
    }
  }
  if (!accepted) inUrls.forEach((u) => failedIn.add(u));
} else if (!env.INDEXNOW_KEY) { console.log('IndexNow: нет INDEXNOW_KEY в .env — пропуск'); inUrls.forEach((u) => failedIn.add(u)); }

// 3. Яндекс Вебмастер: переобход изменённых страниц в пределах дневной квоты.
// Не подтверждён сайт, нет токена, API не отвечает, кончилась квота — страницы ждут следующей заливки.
// Ошибка связи, перегрузка 429 или сбой 5xx останавливают отправку с сохранением хвоста очереди.
{
  const wmList = [...wmQ];
  if (!wmList.length) { /* нечего отправлять */ } else if (!env.YANDEX_WEBMASTER_TOKEN) {
    console.log('Вебмастер: нет YANDEX_WEBMASTER_TOKEN в .env — пропуск');
    wmList.forEach((u) => failedWm.add(u));
  } else {
    let sent = 0;
    try {
      const wm = wmClient();
      let left = (await wm.quota()).quota_remainder ?? 0;
      for (const [i, u] of wmList.entries()) {
        if (left <= 0) { wmList.slice(i).forEach((x) => failedWm.add(x)); console.log('Вебмастер: дневная квота переобхода кончилась, остальное — в очереди'); break; }
        try {
          const r = await wm.recrawl(u);
          sent++; left = r.quota_remainder ?? left - 1;
        } catch (e) {
          if (!(e instanceof WmError)) throw e;
          failedWm.add(u);
          if (!e.status || e.status === 429 || e.status >= 500) { wmList.slice(i + 1).forEach((x) => failedWm.add(x)); throw e; }   // нет связи, 429, 5xx — дальше не пробуем
          console.log(`Вебмастер: ${e.message}`);
        }
      }
      console.log(`Вебмастер: на переобход ${sent} из ${wmList.length}, квоты осталось ${left}`);
    } catch (e) {
      if (!(e instanceof WmError)) throw e;
      if (!sent) wmList.forEach((u) => failedWm.add(u));   // ошибка до первой отправки; иначе неотправленные уже в очереди
      if (!e.status || e.status === 429 || e.status >= 500) wmDown = true;
      console.log(`Вебмастер: ${e.message} — страницы в очереди до следующей заливки`);
    }
  }
}
await webmasterStats();

// 4. archive.org Save Page Now. 401/403/429 останавливают отправку (остаток очереди сохраняется).
// Принятая подача — задание в archive-jobs.json со статусом pending; снимок готов, только когда сервис вернул success.
if (env.IA_ACCESS_KEY && env.IA_SECRET_KEY) {
  const arList = [...arQ];
  const auth = { Authorization: `LOW ${env.IA_ACCESS_KEY}:${env.IA_SECRET_KEY}` };
  const jobsFile = path.join(STATE, 'archive-jobs.json');
  const jobs = fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, 'utf8')) : [];
  const saveJobs = () => fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
  let archiveBlocked = false;
  // сначала узнаём судьбу прошлых заданий (до 20 за заливку)
  for (const job of jobs.filter((j) => j.status === 'pending' && j.job_id).slice(0, 20)) {
    try {
      const r = await fetch(`https://web.archive.org/save/status/${encodeURIComponent(job.job_id)}`, { headers: { Accept: 'application/json', ...auth }, signal: AbortSignal.timeout(20000) });
      if ([401, 403, 429].includes(r.status) || r.status >= 500) { console.log(`archive.org, статус заданий: ${r.status} — проверка отложена`); break; }
      const j = await r.json().catch(() => ({}));
      if (j.status === 'success') { job.status = 'success'; job.timestamp = j.timestamp ?? job.timestamp; }
      else if (j.status === 'error') { job.status = 'error'; job.message = String(j.message || j.status_ext || '').slice(0, 200); failedAr.add(job.url); }
    } catch (e) { console.log(`archive.org, статус задания: ${e.message}`); break; }
  }
  saveJobs();
  for (const [i, u] of arList.entries()) {
    saveQueue(arList.slice(i));  // прогресс сохраняется по ходу: прерывание не теряет оставшиеся страницы
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await fetch('https://web.archive.org/save', {
          method: 'POST',
          headers: { Accept: 'application/json', ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ url: u, if_not_archived_within: '0', skip_first_archive: '1' }),
          signal: AbortSignal.timeout(30000),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 429 && attempt === 1) {  // лимит одновременных сохранений — один раз ждём минуту
          console.log(`archive.org: лимит, жду минуту ← ${u}`);
          await new Promise((res) => setTimeout(res, 60000));
          continue;
        }
        if ([401, 403, 429].includes(r.status) || r.status >= 500) {
          console.log(`archive.org: ${r.status}, оставшиеся адреса сохранены в очереди`);
          arList.slice(i).forEach((url) => failedAr.add(url));
          archiveBlocked = true;
          break;
        }
        console.log(`archive.org ${r.status} ${j.job_id ? 'задание принято' : j.message || ''} ← ${u}`);
        if (r.ok && (j.job_id || j.timestamp)) {
          jobs.push({ url: u, job_id: j.job_id ?? null, timestamp: j.timestamp ?? null, submitted_at: new Date().toISOString(), status: j.timestamp ? 'success' : 'pending' });
          saveJobs();
        } else failedAr.add(u);
      } catch (e) {
        console.log(`archive.org ошибка ${e.message} ← ${u}`);
        failedAr.add(u);
      }
      break;
    }
    if (archiveBlocked) break;
    // пауза между страницами (у SPN лимит активных сессий) — но не после последней
    if (i < arList.length - 1) await new Promise((res) => setTimeout(res, 8000));
  }
  const by = (st) => jobs.filter((j) => j.status === st).length;
  console.log(`archive.org: подача принята (ждёт снимка) ${by('pending')}, снимок готов ${by('success')}, ошибка задания ${by('error')}`);
} else { console.log('archive.org: нет IA_ACCESS_KEY / IA_SECRET_KEY в .env — пропуск'); arQ.forEach((u) => failedAr.add(u)); }

fs.writeFileSync(QUEUE, JSON.stringify({ indexnow: [...failedIn], archive: [...failedAr], webmaster: [...failedWm] }));
console.log(`осталось в очереди: IndexNow ${failedIn.size}, Вебмастер ${failedWm.size}, archive.org ${failedAr.size}`);
