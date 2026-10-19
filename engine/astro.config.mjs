import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';
import { loadSite, ws, ENGINE } from './src/lib/workspace.mjs';

const site = loadSite();

// Даты для sitemap (lastmod): материал — дата правки или публикации, разбор и тема — тоже; рубрика и списки —
// по самому свежему, что в них есть.
const lastmod = {};
const fmDate = (s, key) => s.match(new RegExp(`^${key}:\\s*"?(\\d{4}-\\d{2}-\\d{2})`, 'm'))?.[1];
const readDir = (dir, fn) => fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
  .forEach((f) => fn(f.replace(/\.md$/, ''), fs.readFileSync(path.join(dir, f), 'utf8')));
readDir(ws('content/materials'), (slug, s) => {
  if (/^draft:\s*true/m.test(s)) return;
  const d = fmDate(s, 'updated') || fmDate(s, 'date');
  if (d) lastmod[`${site.url}/${site.materials.path}/${slug}/`] = d;
});
readDir(ws('content/explained'), (slug, s) => {
  if (!/^draft:\s*false/m.test(s)) return;
  const topic = /^kind:\s*"?topic"?\s*$/m.test(s);
  const d = fmDate(s, 'updated') || fmDate(s, 'published');
  if (!d) return;
  lastmod[`${site.url}/${topic ? 'topics' : 'explained'}/${slug}/`] = d;
  const rubric = s.match(/^rubric:\s*"?([a-z0-9-]+)"?/m)?.[1];
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
