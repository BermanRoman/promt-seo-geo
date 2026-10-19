// Рабочая папка пользователя (workspace/) и его конфиг сайта — общие для сборки, страниц и скриптов.
// Движок (engine/) — часть репозитория системы и обновляется через git pull; всё своё у пользователя лежит в workspace/:
//   site.config.json   — конфиг сайта (пишет навык «Знакомство», правит «Поменяй …»)
//   content/materials/  — материалы автора; content/explained/ — разборы и темы; content/explained/_pending/ — обновления тем
//   author.md          — текст страницы автора; design/ — дизайн-система; public/ — фото, иконки, файлы подтверждения
//   .env, .secrets/    — ключи; .deploy/ — состояние заливок; данные/ — снимки статистики и отчёты
// Путь — переменная WORKSPACE (абсолютный или от текущей папки), по умолчанию ../workspace от engine/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WS = process.env.WORKSPACE ? path.resolve(process.env.WORKSPACE) : path.resolve(ENGINE, '../workspace');
export const ws = (...p) => path.join(WS, ...p);

const DEFAULTS = {
  lang: 'ru',
  indexing: false,
  region: 'ru',
  ogVersion: '1',
  materials: { path: 'posts', disclaimer: [], ps: '' },
  cta: null,
  metrikaId: null,
  googleVerification: '',
  yandexVerification: '',
  rubrics: [],
  design: { og: { bg: '#ffffff', ink: '#111111', accent: '#1f5fbf' } },
};

// конфиг читается один раз; ошибка в нём останавливает сборку с понятным сообщением, а не пустым сайтом
let cached;
export function loadSite() {
  if (cached) return cached;
  const file = ws('site.config.json');
  if (!fs.existsSync(file)) throw new Error(`нет ${file} — сначала пройдите знакомство (навык onboarding)`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`site.config.json: ${e.message}`); }
  const site = {
    ...DEFAULTS, ...raw,
    materials: { ...DEFAULTS.materials, ...raw.materials },
    design: { ...DEFAULTS.design, ...raw.design, og: { ...DEFAULTS.design.og, ...raw.design?.og } },
  };
  for (const k of ['url', 'name', 'description']) if (!site[k]) throw new Error(`site.config.json: нет поля ${k}`);
  if (!site.author?.name) throw new Error('site.config.json: нет author.name');
  site.url = site.url.replace(/\/$/, '');
  site.host = new URL(site.url).host;
  if (!/^[a-z0-9-]+$/.test(site.materials.path)) throw new Error('site.config.json: materials.path — латиница, цифры и дефис');
  if (['explained', 'topics', 'rubrics', 'author', 'preview', 'og'].includes(site.materials.path)) throw new Error(`site.config.json: materials.path «${site.materials.path}» занят разделом сайта`);
  for (const r of site.rubrics) if (!/^[a-z0-9-]+$/.test(r.slug)) throw new Error(`site.config.json: рубрика «${r.slug}» — slug латиницей`);
  return (cached = site);
}

// .env из workspace: ключ=значение, без кавычек; значения в лог не выводятся
export function readEnv() {
  const p = ws('.env');
  return Object.fromEntries((fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
    .split('\n').filter((l) => /^\w+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1).trim()]));
}

// дата по Москве (или часовому поясу из TZ_REPORTS): сутки в отчётах поисковиков — местные
export const localDate = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: process.env.TZ_REPORTS || 'Europe/Moscow' });
