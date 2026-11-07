// Шаг 0 конвейера «материал готов»: какие материалы ещё не обработаны (по ним не подобраны темы и не написаны разборы).
// Печатает JSON {"new": ["slug", …]}. Состояние — workspace/.deploy/pipeline.json.
//   --mark slug1,slug2  — отметить обработанными. Разрешено только при итоге выпуска по каждому материалу:
//                         непустой файл workspace/данные/разборы/<slug-материала>-итог.md (workflow.md, «Состояния выпуска»:
//                         публикация, сверка реестра событий из карточек и проверка подач записаны в итоге). Нет итога — отказ.
//   --mark-all          — отметить все текущие без итога (только осознанно: архив, по которому разборы делать не стали)
import fs from 'node:fs';
import path from 'node:path';
import { ws } from '../src/lib/workspace.mjs';

const STATE = ws('.deploy/pipeline.json');
fs.mkdirSync(path.dirname(STATE), { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { processed: [] };
const dir = ws('content/materials');
const all = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')) : [];
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const i = process.argv.indexOf('--mark');
if (i !== -1 || process.argv.includes('--mark-all')) {
  const list = i !== -1 ? (process.argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : all;
  if (i !== -1 && !list.length) { console.log('после --mark нужен slug материала (или несколько через запятую)'); process.exit(1); }
  for (const s of list) {
    if (!all.includes(s)) { console.log(`нет такого материала: ${s}`); process.exit(1); }
  }
  if (i !== -1) {
    const noReport = list.filter((s) => {
      const f = ws('данные/разборы', `${s}-итог.md`);
      return !fs.existsSync(f) || !fs.readFileSync(f, 'utf8').trim();
    });
    if (noReport.length) {
      console.log(`отметка отклонена: нет итога выпуска (данные/разборы/<slug>-итог.md) по материалам: ${noReport.join(', ')}`);
      process.exit(1);
    }
  }
  for (const s of list) if (!state.processed.includes(s)) state.processed.push(s);
  save();
  console.log(`отмечено обработанными: ${list.length}`);
  process.exit(0);
}
console.log(JSON.stringify({ new: all.filter((s) => !state.processed.includes(s)).sort() }));
