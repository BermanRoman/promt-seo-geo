// Имена OG-картинок — одни для шаблонов страниц и для scripts/og-images.mjs.
// В имени — хеш заголовка и версия оформления (site.ogVersion): поменяли заголовок или оформление —
// у картинки новый адрес, и мессенджеры берут свежее превью, а не кэш.
import crypto from 'node:crypto';

const h = (s) => crypto.createHash('md5').update(s).digest('hex').slice(0, 8);
export const ogFile = {
  material: (slug, title, v) => `m-${slug}-${h(title)}-${v}.jpg`,
  explained: (slug, title, v) => `e-${slug}-${h(title)}-${v}.jpg`,
  default: (v) => `default-${v}.jpg`,
};
