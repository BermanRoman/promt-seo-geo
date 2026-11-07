// Проверка реестра приёмки для пачки страниц; публикацию без неё не разрешаем.
//   node scripts/check-acceptance.mjs slug-1,slug-2   (то же, что acceptance.mjs check)
//   node scripts/check-acceptance.mjs --published     — у каждой опубликованной страницы SHA-256 файла равен записи publish.mjs
//                                                    (published.json) или baseline (deploy.sh)
// Останавливает при: нет записи, SHA-256 файла не совпал, сменился запрос в карточке допуска, не хватает этапа,
// у читателя открытые блокеры или вердикт не pass, пакет читателя устарел, читатель не независим и без override,
// решение карточки не разрешает выпуск. foreman и reader должны быть на текущем SHA-256 файла. Обхода нет.
// Из publish.mjs вызывается assertAcceptance(items) для всей пачки до записи файлов.
import { fileURLToPath } from 'node:url';
import { acceptanceErrors } from './lib/acceptance.mjs';
import { runCheck, runPublished } from './acceptance.mjs';

export function assertAcceptance(items) {
  const errors = acceptanceErrors(items);
  if (errors.length) throw new Error(errors.join('\n'));
  return items.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--published')) process.exit(runPublished() ? 0 : 1);
  const slugs = process.argv.slice(2).join(',').split(',').map((s) => s.trim()).filter(Boolean);
  if (!slugs.length) { console.error('check-acceptance.mjs slug-1,slug-2'); process.exit(1); }
  process.exit(runCheck(slugs) ? 0 : 1);
}
