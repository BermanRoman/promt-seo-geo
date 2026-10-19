// Общие помощники страниц: конфиг сайта, адреса, даты, склонения, разметка автора.
import { getCollection, type CollectionEntry } from 'astro:content';
import { loadSite } from './workspace.mjs';

export const site = loadSite();
export type Material = CollectionEntry<'materials'>;

// материалы автора, свежие выше; черновики (draft: true) на сайт не попадают
export async function getMaterials(): Promise<Material[]> {
  return (await getCollection('materials', (m) => !m.data.draft))
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || a.id.localeCompare(b.id));
}

export const materialUrl = (slug: string) => `/${site.materials.path}/${slug}/`;
export const rubricOf = (slug: string) => site.rubrics.find((r: { slug: string }) => r.slug === slug) ?? { slug, title: slug, description: '' };
export const rubricUrl = (slug: string) => `/rubrics/${slug}/`;
// разборы — /explained/<slug>/, живые темы — /topics/<slug>/
export const pageUrl = (e: { id: string; data: { kind: 'event' | 'topic' } }) =>
  `/${e.data.kind === 'topic' ? 'topics' : 'explained'}/${e.id}/`;
// все материалы темы: materials плюс материал последнего эпизода
export const topicMaterials = (d: { material: string; materials: string[] }) => [...new Set([...d.materials, d.material])];

// склонение после числа: plural(21, 'материале', 'материалах', 'материалах') → «материале»
export const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;

// «6 октября 2026»
export const formatDate = (d: Date) =>
  d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/\s*г\.$/, '');

export const authorLd = {
  '@type': 'Person',
  '@id': `${site.url}/author/#person`,
  name: site.author.name,
  ...(site.author.jobTitle ? { jobTitle: site.author.jobTitle } : {}),
  ...(site.author.bio ? { description: site.author.bio } : {}),
  url: `${site.url}/author/`,
  ...(site.author.photo ? { image: `${site.url}${site.author.photo}` } : {}),
  ...(site.author.sameAs?.length ? { sameAs: site.author.sameAs } : {}),
};
