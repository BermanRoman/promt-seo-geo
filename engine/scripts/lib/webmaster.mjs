// Клиент API Яндекс Вебмастера v4 (https://yandex.ru/dev/webmaster/doc/ru/): сайт, подтверждение, sitemap, переобход, статистика, мониторинг запросов.
// Токен — YANDEX_WEBMASTER_TOKEN в workspace/.env (права webmaster:hostinfo и webmaster:verify), в код и в git не попадает.
// host_id вида https:example.ru:443 идёт в путь как есть (двоеточия в пути допустимы, так в документации).
// user_id и host_id запоминаются в workspace/.deploy/webmaster.json, чтобы не спрашивать их при каждой заливке.
// Любой сбой — исключение WmError: вызывающий решает, что делать (post-deploy оставляет страницы в очереди).
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.WEBMASTER_API || 'https://api.webmaster.yandex.net/v4';   // подмена — только для проверки на подставном сервере

export class WmError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

export function webmaster({ token, siteUrl, stateFile, timeout = 15000 }) {
  if (!token) throw new WmError('нет YANDEX_WEBMASTER_TOKEN в .env');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const save = () => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); };
  const site = siteUrl.replace(/\/$/, '');

  async function api(method, url, body) {
    let r;
    try {
      r = await fetch(API + url, {
        method,
        headers: { Authorization: `OAuth ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      // таймаут или обрыв соединения: API не отвечает (у Яндекса бывают сбои на дни — страницы ждут в очереди)
      throw new WmError(`API Вебмастера не отвечает (${e.name === 'TimeoutError' ? 'таймаут' : e.message})`);
    }
    const text = await r.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; } })() : {};
    if (!r.ok) throw new WmError(`${method} ${url}: ${r.status} ${json.error_code || ''} ${json.error_message || json.raw || ''}`.trim(), r.status);
    return json;
  }

  async function userId() {
    if (!state.user_id) { state.user_id = (await api('GET', '/user')).user_id; save(); }
    return state.user_id;
  }

  // сайт в списке Вебмастера; add — добавить, если его там нет
  async function host({ add = false } = {}) {
    const uid = await userId();
    const { hosts = [] } = await api('GET', `/user/${uid}/hosts`);
    let h = hosts.find((x) => (x.ascii_host_url || '').replace(/\/$/, '') === site);
    if (!h && add) {
      const { host_id } = await api('POST', `/user/${uid}/hosts`, { host_url: site });
      h = { host_id, verified: false };
    }
    if (h) { state.host_id = h.host_id; state.verified = !!h.verified; save(); }
    return h || null;
  }

  // путь к сайту в API; если сайт ещё не подтверждён — исключение, а не пустые запросы
  async function hostPath() {
    const uid = await userId();
    if (!state.host_id || !state.verified) await host();
    if (!state.host_id) throw new WmError('сайта нет в Вебмастере — запустите node scripts/webmaster.mjs setup');
    if (!state.verified) throw new WmError('сайт не подтверждён в Вебмастере — запустите node scripts/webmaster.mjs setup');
    return `/user/${uid}/hosts/${state.host_id}`;
  }

  return {
    state, api, userId, host, hostPath,
    async verification() {
      const uid = await userId();
      return api('GET', `/user/${uid}/hosts/${state.host_id}/verification`);
    },
    async verify(type = 'HTML_FILE') {
      const uid = await userId();
      return api('POST', `/user/${uid}/hosts/${state.host_id}/verification?verification_type=${type}`);
    },
    async sitemaps() { return (await api('GET', `${await hostPath()}/user-added-sitemaps`)).sitemaps || []; },
    async addSitemap(url) { return api('POST', `${await hostPath()}/user-added-sitemaps`, { url }); },
    async quota() { return api('GET', `${await hostPath()}/recrawl/quota`); },
    async recrawl(url) { return api('POST', `${await hostPath()}/recrawl/queue`, { url }); },
    async summary() { return api('GET', `${await hostPath()}/summary`); },
    async diagnostics() { return api('GET', `${await hostPath()}/diagnostics`); },
    async queries(dateFrom, dateTo) {
      const q = new URLSearchParams({ order_by: 'TOTAL_SHOWS', date_from: dateFrom, date_to: dateTo });
      for (const i of ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION']) q.append('query_indicator', i);
      return api('GET', `${await hostPath()}/search-queries/popular?${q}`);
    },
    // «Мониторинг запросов» (POST query-analytics/list): данные за последние 2 недели, все строки страницами по 500 (не больше 10 000)
    async queryAnalytics(body) {
      const hp = await hostPath(), rows = [];
      for (let offset = 0; offset < 10000; offset += 500) {
        const r = await api('POST', `${hp}/query-analytics/list`, { ...body, offset, limit: 500 });
        const page = r.text_indicator_to_statistics || [];
        rows.push(...page);
        if (!page.length || rows.length >= (r.count || 0)) break;
      }
      return rows;
    },
  };
}
