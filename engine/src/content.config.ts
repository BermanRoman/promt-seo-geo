import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { loadSite, ws } from './lib/workspace.mjs';

const site = loadSite();
const rubricSlugs = site.rubrics.map((r: { slug: string }) => r.slug) as [string, ...string[]];

// Материалы автора — его посты и статьи (импорт из Telegram или папки, дальше — «материал готов»).
// Текст автора не меняется; SEO-заголовок и описание — в полях seoTitle и description.
const materials = defineCollection({
  loader: glob({ pattern: '*.md', base: ws('content/materials') }),
  schema: z.object({
    title: z.string(),
    seoTitle: z.string().optional(),          // <title> до 70 знаков, если заголовок автора не похож на поисковый
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    description: z.string(),
    keywords: z.array(z.string()).default([]),
    source: z.string().url().optional(),      // оригинал: пост в Telegram и т. п.
    topics: z.array(z.string()).default([]),  // заголовки разделов — в списках и llms.txt
    draft: z.boolean().default(false),
  }),
});

// Разборы (kind: event) и живые страницы тем (kind: topic) — пишет конвейер агентов по материалам автора.
// material — материал-основа (у темы — материал последнего эпизода), materials — все материалы темы.
// Готовое обновление опубликованной темы лежит в explained/_pending/<slug>.md (та же схема): его видно только
// на /preview/<slug>/, на сайт оно встаёт через scripts/publish.mjs.
const schema = z.object({
  title: z.string(),                       // H1 — поисковый вопрос или сущность
  seoTitle: z.string().optional(),          // <title>, до 70 знаков; если нет — title
  description: z.string(),                  // 120–160 знаков
  kind: z.enum(['event', 'topic']).default('event'),
  material: z.string(),                     // slug материала-основы
  materials: z.array(z.string()).default([]),
  rubric: rubricSlugs.length ? z.enum(rubricSlugs) : z.string(),
  published: z.coerce.date(),
  updated: z.coerce.date().optional(),
  short: z.string(),                        // «Коротко», до 60 слов
  faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
  sources: z.array(z.string().url()).default([]),
  draft: z.boolean().default(true),         // true — не публикуется, пока прораб не выпустит
  rejected: z.boolean().optional(),         // снят прорабом: publish.mjs его не публикует
});
const explained = defineCollection({ loader: glob({ pattern: '*.md', base: ws('content/explained') }), schema });
const pending = defineCollection({ loader: glob({ pattern: '*.md', base: ws('content/explained/_pending') }), schema });

// страница автора — workspace/author.md (текст голосом автора; пишет навык «Знакомство»)
const author = defineCollection({ loader: glob({ pattern: 'author.md', base: ws() }), schema: z.object({}).passthrough() });

export const collections = { materials, explained, pending, author };
