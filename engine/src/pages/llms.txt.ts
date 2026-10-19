import { getCollection } from 'astro:content';
import { site, getMaterials, materialUrl, pageUrl, formatDate, rubricUrl } from '../lib/site';

// Каталог сайта для нейросетей (llms.txt): что за сайт, кто автор, разделы и все страницы с описаниями.
export async function GET() {
  const list = await getMaterials();
  const explained = (await getCollection('explained', (e) => !e.data.draft)).sort((a, b) => b.data.published.getTime() - a.data.published.getTime());
  const lines = [
    `# ${site.name}`, '', `> ${site.description}`, '',
    `Автор: ${site.author.name}.${site.author.bio ? ` ${site.author.bio}` : ''} Об авторе: ${site.url}/author/`, '',
    ...(site.rubrics.length ? ['## Рубрики', '', ...site.rubrics.map((r) => `- [${r.title}](${site.url}${rubricUrl(r.slug)}): ${r.description}`), ''] : []),
    '## Материалы автора', '',
    ...list.map((m) => `- [${m.data.title}](${site.url}${materialUrl(m.id)}) (${formatDate(m.data.date)}): ${m.data.description}`), '',
    '## Темы', '',
    ...explained.filter((e) => e.data.kind === 'topic').map((e) => `- [${e.data.title}](${site.url}${pageUrl(e)}): ${e.data.description}`), '',
    '## Разборы', '',
    ...explained.filter((e) => e.data.kind !== 'topic').map((e) => `- [${e.data.title}](${site.url}${pageUrl(e)}): ${e.data.description}`), '',
    `Полный текст всех материалов: ${site.url}/llms-full.txt`, '',
  ];
  return new Response(lines.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
