// Проверка, что всё на месте: от рабочей папки до поисковых консолей. Ничего не меняет, кроме команды indexnow.
//   node scripts/doctor.mjs            — список «готово / нет» по всем этапам; ключи не печатает, только есть они или нет
//   node scripts/doctor.mjs indexnow   — создать ключ IndexNow: INDEXNOW_KEY в .env и файл <ключ>.txt в workspace/public/
// Навыки вызывают его в начале работы и после каждого шага настройки.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WS, ws, readEnv, loadSite } from '../src/lib/workspace.mjs';

const ok = (b) => (b ? '✓' : '✗');
const line = (b, t, hint = '') => console.log(`${ok(b)} ${t}${!b && hint ? ` — ${hint}` : ''}`);

if (process.argv[2] === 'indexnow') {
  const env = readEnv();
  if (env.INDEXNOW_KEY) { console.log('ключ IndexNow уже есть'); process.exit(0); }
  const key = crypto.randomBytes(16).toString('hex');
  const p = ws('.env');
  const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  fs.writeFileSync(p, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}INDEXNOW_KEY=${key}\n`, { mode: 0o600 });
  fs.mkdirSync(ws('public'), { recursive: true });
  fs.writeFileSync(ws('public', `${key}.txt`), key);
  console.log('ключ IndexNow создан: записан в .env, файл ключа — в workspace/public/ (уйдёт на сайт со следующей заливкой)');
  process.exit(0);
}

console.log(`рабочая папка: ${WS}`);
line(fs.existsSync(WS), 'рабочая папка есть', 'навык onboarding создаст её');
let site = null;
try { site = loadSite(); line(true, `конфиг сайта: ${site.url}`); } catch (e) { line(false, 'конфиг сайта', e.message); }
line(fs.existsSync(ws('brief.md')), 'бриф', 'навык onboarding');
line(fs.existsSync(ws('voice.md')), 'голос автора', 'навык voice');
line(fs.existsSync(ws('author.md')), 'страница автора', 'навык onboarding');
line(fs.existsSync(ws('design/theme.css')), 'своя дизайн-система', 'навык design (до неё — нейтральная тема)');
const mats = fs.existsSync(ws('content/materials')) ? fs.readdirSync(ws('content/materials')).filter((f) => f.endsWith('.md')).length : 0;
line(mats > 0, `материалов: ${mats}`, 'навык import');

const env = readEnv();
const has = (k) => Boolean(env[k]);
line(has('DEPLOY_HOST') && has('DEPLOY_DIR'), 'куда заливать (DEPLOY_HOST, DEPLOY_DIR)', 'навык infrastructure');
if (has('DEPLOY_HOST')) {
  let sshOk = false;
  try { execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', env.DEPLOY_HOST, 'echo ok'], { stdio: 'pipe', timeout: 20000 }); sshOk = true; } catch {}
  line(sshOk, 'SSH до хостинга', 'ключ не добавлен на хостинг или хостинг временно не пускает');
}
if (site) {
  let code = 0;
  try { code = (await fetch(site.url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })).status; } catch {}
  line(code === 200, `сайт отвечает (${code || 'нет ответа'})`, 'домен не направлен на хостинг, нет сертификата или сайт ещё не залит');
  line(Boolean(site.indexing), 'индексация открыта (indexing: true)', 'открываем после «лей» на первой выкладке');
  line(Boolean(site.metrikaId), 'Яндекс Метрика (metrikaId)', 'навык infrastructure');
  line(Boolean(site.yandexVerification) || fs.existsSync(ws('.deploy/webmaster.json')), 'Яндекс Вебмастер', 'навык infrastructure');
  line(Boolean(site.googleVerification || site.gscProperty), 'Google Search Console', 'навык infrastructure');
}
line(has('INDEXNOW_KEY') && fs.existsSync(ws('public', `${env.INDEXNOW_KEY}.txt`)), 'IndexNow', 'node scripts/doctor.mjs indexnow');
line(has('YANDEX_WEBMASTER_TOKEN'), 'токен API Вебмастера', 'по желанию: переобход и статистика из Яндекса');
line(fs.existsSync(ws('.secrets/gsc.json')), 'ключ API Search Console', 'по желанию: статистика из Google');
line(has('BING_WEBMASTER_KEY'), 'ключ API Bing', 'по желанию: статистика из Bing');
line(has('IA_ACCESS_KEY') && has('IA_SECRET_KEY'), 'ключи archive.org', 'по желанию: снимки страниц в веб-архиве');
// права на файлы с ключами: читать может только владелец
for (const p of [ws('.env'), ws('.secrets/gsc.json')]) {
  if (fs.existsSync(p) && (fs.statSync(p).mode & 0o077)) console.log(`! ${p}: доступ не только у владельца — chmod 600`);
}
