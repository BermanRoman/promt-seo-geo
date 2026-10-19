// Для авторов, у которых в голосе (workspace/voice.md) «каждое предложение — отдельный абзац».
// Делит обычные абзацы разбора по предложениям. Не трогает frontmatter, заголовки, списки, цитаты-блоки,
// а также точки внутри ссылок [текст](url), инициалы («Н. Калашник») и сокращения («т. е.», «г.»).
// Запуск: node scripts/split-sentences.mjs <файл.md> [...]
import fs from 'node:fs';

import { splitParagraph } from '../src/lib/sentences.mjs';

for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, 'utf8');
  const fm = src.match(/^---\n[\s\S]*?\n---\n/);
  const head = fm ? fm[0] : '';
  const body = src.slice(head.length);
  const blocks = body.split(/\n{2,}/);
  let changed = 0;
  const res = blocks.map((b) => {
    const t = b.trim();
    if (!t || /^(#|>|-|\*\s|\d+\.\s|\||```)/.test(t) || t.includes('\n')) return b;
    const parts = splitParagraph(t);
    if (parts.length > 1) changed++;
    return parts.join('\n\n');
  });
  fs.writeFileSync(file, head + res.join('\n\n'));
  console.log(`${file.split('/').pop()}: разделено абзацев ${changed}`);
}
