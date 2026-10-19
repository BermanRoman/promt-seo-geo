import { loadSite } from '../lib/workspace.mjs';

// Пока индексация закрыта (indexing: false) — закрыто для всех. Потом — открыто всем, включая ботов нейросетей (GEO).
// Clean-param — для Яндекса: адреса с utm-метками и рекламными id склеиваются с основным, а не считаются дублями.
// Отдельный раздел для Яндекса: Google эту директиву не знает; свой раздел Яндекса отменяет общий, поэтому правила повторены.
export const GET = () => {
  const site = loadSite();
  const body = site.indexing
    ? `User-agent: *\nAllow: /\nDisallow: /preview/\n\nUser-agent: Yandex\nAllow: /\nDisallow: /preview/\nClean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&gclid&fbclid&from&etext&ybaip&y_ref&ypppil\n\nSitemap: ${site.url}/sitemap-index.xml\n`
    : 'User-agent: *\nDisallow: /\n';
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
