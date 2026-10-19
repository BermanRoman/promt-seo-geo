// Яндекс Вебмастер для сайта из workspace/site.config.json.
//   node scripts/webmaster.mjs setup  — добавить сайт, подтвердить файлом yandex_<код>.html, отправить sitemap.
//                                       Запускать, пока не скажет «готово»: после создания файла нужна заливка (npm run deploy).
//   node scripts/webmaster.mjs status — подтверждён ли сайт, sitemap, квота переобхода, страницы в поиске, проблемы.
//   node scripts/webmaster.mjs stats  — снимок статистики в workspace/данные/вебмастер/<дата>.json (раз в день; post-deploy зовёт сам).
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

// снимок за последние 7 дней; если сегодняшний уже есть — ничего не делает (FORCE=1 — перезаписать)
export async function stats(wm, { quiet = false } = {}) {
  const today = mskDate(Date.now());
  const file = path.join(STATS_DIR, `${today}.json`);
  if (fs.existsSync(file) && process.env.FORCE !== '1') { if (!quiet) console.log(`снимок за ${today} уже есть`); return false; }
  const from = mskDate(Date.now() - 7 * 864e5);
  const [summary, diagnostics, queries] = await Promise.all([wm.summary(), wm.diagnostics(), wm.queries(from, today)]);
  fs.mkdirSync(STATS_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ date: today, period: [from, today], summary, diagnostics, queries }, null, 1));
  console.log(`Вебмастер: снимок статистики → workspace/данные/вебмастер/${today}.json`);
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
