// Поля frontmatter для скриптов (publish, lint, og-images) без YAML-парсера.
// Значение — JSON (строка в кавычках, число, true, ["a", "b"]) или как есть: `kind: topic` и `kind: "topic"` — одно и то же.
export const fmOf = (src) => src.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
export const val = (fm, key) => {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*?)\\s*$`, 'm'));
  if (!m || m[1] === '') return undefined;
  try { return JSON.parse(m[1]); } catch { return m[1].replace(/^(['"])(.*)\1$/, '$2'); }
};
// список строк: и `materials: ["a", "b"]`, и YAML-список с дефисами на следующих строках
export const list = (fm, key) => {
  const v = val(fm, key);
  if (Array.isArray(v)) return v.map(String);
  const block = fm.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)+)`, 'm'));
  return block ? [...block[1].matchAll(/^\s+-\s+(.*?)\s*$/gm)].map((m) => m[1].replace(/^(['"])(.*)\1$/, '$2')) : [];
};
// то, что скриптам нужно знать о разборе или теме; умолчания — как в схеме src/content.config.ts
export const explainerMeta = (src) => {
  const fm = fmOf(src);
  return {
    fm,
    title: val(fm, 'title') == null ? '' : String(val(fm, 'title')),
    kind: val(fm, 'kind') ?? 'event',
    material: val(fm, 'material') == null ? '' : String(val(fm, 'material')),
    materials: list(fm, 'materials'),
    draft: val(fm, 'draft') !== false,
    rejected: val(fm, 'rejected') === true,
  };
};
