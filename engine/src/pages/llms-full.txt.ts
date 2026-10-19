import { getCollection } from 'astro:content';
import { site, getMaterials, materialUrl, pageUrl, formatDate } from '../lib/site';

// Полный текст сайта одним файлом для нейросетей: материалы автора, темы и разборы в Markdown.
export async function GET() {
  const list = await getMaterials();
  const explained = (await getCollection('explained', (e) => !e.data.draft)).sort((a, b) => b.data.published.getTime() - a.data.published.getTime());
  const parts = [
    `# ${site.name}`, '', `> ${site.description}`, '', `Автор: ${site.author.name}. Источник: ${site.url}`, '', '---', '',
    '# Темы и разборы',
    ...explained.flatMap((e) => ['', `## ${e.data.title}`, '', `URL: ${site.url}${pageUrl(e)}`, '', e.data.short, '', e.body ?? '']),
    '', '---', '', '# Материалы автора',
    ...list.flatMap((m) => ['', `## ${m.data.title}`, '', `URL: ${site.url}${materialUrl(m.id)} · ${formatDate(m.data.date)}`, '', m.body ?? '']),
    '',
  ];
  return new Response(parts.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
