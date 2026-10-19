// Разбивка текста на предложения с учётом ссылок [..](..), инициалов и сокращений.
// Общая для скрипта split-sentences.mjs и блока «Коротко» в шаблоне разбора.
const ABBR = /(?:^|[\s(«])(?:т|г|гг|см|др|пр|им|ул|н|ок|млн|млрд|тыс|руб|долл|св|ст|рис|т\. е|т\. д|т\. п|и т)\.$/i;

export function splitParagraph(p) {
  const out = [];
  let buf = '';
  let depth = 0; // внутри [..](..) не делим
  let quote = 0; // и внутри «..»: цитата из нескольких предложений остаётся одним абзацем
  const track = (c) => { if (c === '«') quote++; if (c === '»' && quote > 0) quote--; };
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    buf += ch;
    track(ch);
    if (ch === '[' || ch === '(') depth++;
    if ((ch === ']' || ch === ')') && depth > 0) depth--;
    if (depth === 0 && /[.!?…]/.test(ch)) {
      // закрывающие кавычки и скобки, идущие сразу за точкой, остаются в предложении
      while (/[»")\]_*]/.test(p[i + 1] || '')) { buf += p[++i]; track(p[i]); }
      if (quote > 0) continue;
      const rest = p.slice(i + 1);
      const m = rest.match(/^\s+(?=[«"А-ЯЁA-Z0-9_*\[])/);
      if (!m) continue;
      const tail = buf.trimEnd();
      if (ABBR.test(tail) || /(?:^|\s)[А-ЯЁA-Z]\.$/.test(tail)) continue; // сокращение или инициал
      out.push(buf.trim());
      buf = '';
      i += m[0].length;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

