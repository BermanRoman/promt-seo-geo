import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { loadSite, ws, ENGINE } from './src/lib/workspace.mjs';

const site = loadSite();

// Даты для sitemap (lastmod): материал — дата правки или публикации, разбор и тема — тоже; рубрика и списки —
// по самому свежему, что в них есть.
const lastmod = {};
// frontmatter читает настоящий YAML-парсер: кавычки, комментарии и даты в любом допустимом виде
const day = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
const readDir = (dir, fn) => fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
  .forEach((f) => {
    const source = fs.readFileSync(path.join(dir, f), 'utf8');
    let data;
    try { data = parse(source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '') ?? {}; } catch (e) { throw new Error(`${f}: невалидный YAML во frontmatter (${e.message.split('\n')[0]})`); }
    fn(f.replace(/\.md$/, ''), data);
  });
readDir(ws('content/materials'), (slug, data) => {
  if (data.draft === true) return;
  const d = day(data.updated) || day(data.date);
  if (d) lastmod[`${site.url}/${site.materials.path}/${slug}/`] = d;
});
readDir(ws('content/explained'), (slug, data) => {
  if (data.draft !== false) return;
  const d = day(data.updated) || day(data.published);
  if (!d) return;
  lastmod[`${site.url}/${data.kind === 'topic' ? 'topics' : 'explained'}/${slug}/`] = d;
  // страница рубрики обновляется вместе с самым свежим своим разбором или темой
  const rubric = typeof data.rubric === 'string' && /^[a-z0-9-]+$/.test(data.rubric) ? data.rubric : '';
  const ru = rubric && `${site.url}/rubrics/${rubric}/`;
  if (ru && !(lastmod[ru] > d)) lastmod[ru] = d;
});
const latest = (part) => Object.entries(lastmod).filter(([u]) => u.includes(part)).map(([, d]) => d).sort().pop();
lastmod[`${site.url}/`] = latest(`/${site.materials.path}/`);
lastmod[`${site.url}/explained/`] = latest('/explained/');
lastmod[`${site.url}/topics/`] = latest('/topics/');
lastmod[`${site.url}/rubrics/`] = latest('/rubrics/');
if (site.author.updated) lastmod[`${site.url}/author/`] = site.author.updated;

// оформление: своя дизайн-система пользователя (workspace/design/theme.css) или нейтральная тема движка
const userTheme = ws('design/theme.css');
const theme = fs.existsSync(userTheme) ? userTheme : path.join(ENGINE, 'src/styles/default-theme.css');

export default defineConfig({
  site: site.url,
  trailingSlash: 'always',
  publicDir: ws('public'),
  // стили (~10 КБ) встраиваются в страницу: без лишнего запроса, который задерживает первую отрисовку
  build: { format: 'directory', inlineStylesheets: 'always' },
  vite: {
    resolve: { alias: { '@theme': theme } },
    server: { fs: { allow: [ENGINE, ws()] } },
  },
  integrations: [sitemap({
    // черновики, 404 и пустые списки (они закрыты noindex) в sitemap не попадают
    filter: (page) => !page.includes('/preview/') && !page.endsWith('/404/') && (!(page.endsWith('/explained/') || page.endsWith('/topics/')) || !!lastmod[page]),
    serialize: (item) => (lastmod[item.url] ? { ...item, lastmod: new Date(lastmod[item.url]).toISOString() } : item),
  })],
});
