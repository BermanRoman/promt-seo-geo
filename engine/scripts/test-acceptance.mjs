// Регрессия приёмки и публикации на временной копии examples/demo: реестр, SHA-256, запрос, блокеры, обновления из _pending,
// отметка материала в pipeline-check. Внешних сервисов не вызывает, настоящий workspace не читает.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.resolve(here, '../../examples/demo');

test('acceptance gate: publish stops without valid acceptance', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-test-'));
  try {
    fs.cpSync(demo, ws, { recursive: true });
    const node = (script, args, input) => spawnSync(process.execPath, [path.join(here, script), ...args], {
      env: { ...process.env, WORKSPACE: ws }, encoding: 'utf8', input, timeout: 60000,
    });
    const explained = path.join(ws, 'content/explained');
    const seed = (slug, dir = explained, query = 'порог ндс усн', card = 'decision: допущено') => {
      const src = fs.readFileSync(path.join(explained, 'porog-nds-usn.md'), 'utf8').replace(/^draft: false/m, 'draft: true')
        .replace(/^title: .*/m, `title: "Тест ${slug}?"`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${slug}.md`), src);
      fs.mkdirSync(path.join(ws, 'данные/разборы'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'данные/разборы', `${slug}-допуск.md`), `---\nquery: "${query}"\n${card}\n---\nКарточка\n`);
    };
    const published = (slug) => /^draft: false$/m.test(fs.readFileSync(path.join(explained, `${slug}.md`), 'utf8'));
    const by = ['--by', 'test-reader'];
    const record = (slug, stage, extra = []) => node('acceptance.mjs', ['record', slug, '--stage', stage, ...(stage === 'foreman' || stage === 'reader' ? [] : by), ...extra]);
    const packetSha = (slug) => node('acceptance.mjs', ['packet', slug]).stdout.match(/SHA-256 пакета: ([0-9a-f]{64})/)[1];
    const reader = (slug, extra = [], blockers = 0, independent = 'true') => record(slug, 'reader', ['--round', '1', '--blockers', String(blockers), '--verdict', blockers ? 'fail' : 'pass', '--packet-sha', packetSha(slug), '--independent', independent, ...extra]);
    const accept = (slug, blockers = 0, independent = 'true', extra = []) => {
      for (const st of ['edit', 'check', 'foreman']) assert.equal(record(slug, st).status, 0, `record ${st}`);
      return reader(slug, extra, blockers, independent);
    };

    // baseline до первого выпуска: legacy-страница без записи сначала стоп, потом проходит
    const pub = () => node('check-acceptance.mjs', ['--published']);
    assert.equal(pub().status, 1, 'legacy-страницы без published.json и baseline');
    assert.equal(node('acceptance.mjs', ['baseline']).status, 0);
    assert.equal(node('acceptance.mjs', ['baseline']).status, 1, 'повторный baseline — отказ');
    const bl = JSON.parse(fs.readFileSync(path.join(ws, 'данные/acceptance-baseline.json'), 'utf8'));
    assert.ok(bl.createdAt && bl.pages['porog-nds-usn']);
    assert.equal(pub().status, 0);

    seed('t-ok');
    assert.equal(node('publish.mjs', ['t-ok']).status, 1, 'нет записи — остановка');
    assert.equal(published('t-ok'), false);
    assert.equal(record('t-ok', 'reader', ['--round', '1', '--blockers', '0', '--verdict', 'pass', '--packet-sha', 'a'.repeat(64), '--independent', 'true']).status, 1, 'читатель раньше предыдущих этапов');
    assert.equal(accept('t-ok').status, 0);
    const reg = JSON.parse(fs.readFileSync(path.join(ws, 'данные/acceptance.json'), 'utf8'));
    assert.equal(reg['t-ok'].query, 'порог ндс усн');
    assert.equal(reg['t-ok'].stages.foreman.sha256, node('acceptance.mjs', ['sha', 't-ok']).stdout.trim());
    assert.equal(reg['t-ok'].stages.reader.openBlockers, 0);
    assert.equal(node('acceptance.mjs', ['check', 't-ok']).status, 0);

    // пачка: одна страница без приёмки останавливает обе
    seed('t-bad');
    assert.equal(node('publish.mjs', ['t-ok', 't-bad']).status, 1);
    assert.equal(published('t-ok'), false, 'в пачке ничего не записано');

    assert.equal(node('publish.mjs', ['t-ok']).status, 0);
    assert.equal(published('t-ok'), true);

    // --by обязателен для edit и check
    seed('t-by');
    assert.equal(node('acceptance.mjs', ['record', 't-by', '--stage', 'edit']).status, 1);

    // правка сверщика после edit: edit остаётся на раннем SHA, повторять его не нужно
    seed('t-fix');
    assert.equal(record('t-fix', 'edit').status, 0);
    fs.appendFileSync(path.join(explained, 't-fix.md'), '\n');
    assert.equal(record('t-fix', 'check').status, 0);
    assert.equal(record('t-fix', 'foreman').status, 0);
    assert.equal(reader('t-fix').status, 0);
    assert.equal(node('publish.mjs', ['t-fix']).status, 0);
    assert.equal(published('t-fix'), true);

    // правка после foreman: стоп
    seed('t-edit');
    assert.equal(accept('t-edit').status, 0);
    fs.appendFileSync(path.join(explained, 't-edit.md'), 'x');
    const changed = node('publish.mjs', ['t-edit']);
    assert.equal(changed.status, 1);
    assert.match(changed.stderr + changed.stdout, /SHA-256/);
    assert.equal(published('t-edit'), false);

    // независимость: false без override — стоп, с override — проходит
    seed('t-ind');
    assert.equal(accept('t-ind', 0, 'false').status, 0);
    assert.equal(node('publish.mjs', ['t-ind']).status, 1);
    assert.equal(reader('t-ind', ['--override', '2026-11-07, Роман'], 0, 'false').status, 0);
    assert.equal(node('publish.mjs', ['t-ind']).status, 0);

    // решение карточки: отклонено — стоп; для update нужно «обновить существующее»
    seed('t-no', explained, 'порог ндс усн', 'decision: отказ');
    assert.equal(record('t-no', 'edit').status, 1);
    seed('t-upd-bad', path.join(explained, '_pending'), 'порог ндс усн', 'page: update\ndecision: допущено');
    assert.equal(record('t-upd-bad', 'edit').status, 1);

    // открытый блокер
    seed('t-block');
    assert.equal(accept('t-block', 1).status, 0);
    assert.equal(node('publish.mjs', ['t-block']).status, 1);
    assert.equal(published('t-block'), false);

    // смена запроса в карточке
    seed('t-query');
    assert.equal(accept('t-query').status, 0);
    fs.writeFileSync(path.join(ws, 'данные/разборы/t-query-допуск.md'), '---\nquery: "другой запрос"\n---\n');
    assert.equal(node('publish.mjs', ['t-query']).status, 1);

    // пакет устарел: текст изменён после чтения, SHA файла перезаписан заново, а packetSha — старый
    seed('t-stale');
    for (const st of ['edit', 'check', 'foreman']) record('t-stale', st);
    const stale = packetSha('t-stale');
    fs.appendFileSync(path.join(explained, 't-stale.md'), 'x');
    for (const st of ['edit', 'check', 'foreman']) assert.equal(record('t-stale', st).status, 0);
    assert.equal(record('t-stale', 'reader', ['--round', '1', '--blockers', '0', '--verdict', 'pass', '--packet-sha', stale, '--independent', 'true']).status, 1);

    // обновление темы из _pending
    seed('t-upd', path.join(explained, '_pending'), 'порог ндс усн', 'page: update\ndecision: обновить существующее');
    assert.equal(node('publish.mjs', ['t-upd']).status, 1);
    assert.equal(accept('t-upd').status, 0);
    assert.equal(node('publish.mjs', ['t-upd']).status, 0);
    assert.equal(fs.existsSync(path.join(explained, '_pending/t-upd.md')), false);
    assert.equal(published('t-upd'), true);

    // обновление без page: (по умолчанию update для _pending) → publish → --published проходит
    seed('t-upd2', path.join(explained, '_pending'), 'порог ндс усн', 'decision: обновить существующее');
    assert.equal(accept('t-upd2').status, 0);
    assert.equal(node('publish.mjs', ['t-upd2']).status, 0);
    const pj = JSON.parse(fs.readFileSync(path.join(ws, 'данные/published.json'), 'utf8'));
    assert.equal(pj['t-upd2'].sha256, node('acceptance.mjs', ['sha', 't-upd2']).stdout.trim());
    assert.ok(pj['t-upd2'].acceptance);
    assert.equal(pub().status, 0, 'опубликованное через publish проходит');

    // незавершённое и rejected обновления _pending не блокируют --published и не становятся целью
    seed('t-wip', path.join(explained, '_pending'), 'порог ндс усн', 'decision: обновить существующее');
    fs.writeFileSync(path.join(explained, '_pending/t-rej.md'), fs.readFileSync(path.join(explained, '_pending/t-wip.md'), 'utf8').replace(/^draft: true/m, 'draft: true\nrejected: true'));
    assert.equal(pub().status, 0);
    assert.equal(node('acceptance.mjs', ['sha', 't-rej']).status, 1, 'rejected-обновления нет в целях');

    // новый черновик с page: update и обратная пара — стоп
    seed('t-badpage', explained, 'порог ндс усн', 'page: update\ndecision: обновить существующее');
    assert.equal(record('t-badpage', 'edit').status, 1);
    seed('t-badpend', path.join(explained, '_pending'), 'порог ндс усн', 'page: event\ndecision: допущено');
    assert.equal(record('t-badpend', 'edit').status, 1);

    // смена заголовка материала не ломает --published
    const mat = path.join(ws, 'content/materials/nds-na-usn-2026.md');
    fs.writeFileSync(mat, fs.readFileSync(mat, 'utf8').replace(/^title: .*/m, 'title: "Другой заголовок материала"'));
    assert.equal(pub().status, 0);

    // baseline при непустом published.json — отказ
    fs.unlinkSync(path.join(ws, 'данные/acceptance-baseline.json'));
    assert.equal(node('acceptance.mjs', ['baseline']).status, 1);
    fs.writeFileSync(path.join(ws, 'данные/acceptance-baseline.json'), JSON.stringify(bl));

    // ручная правка опубликованного файла и новая опубликованная без записи — стоп
    const okFile = path.join(explained, 't-ok.md');
    const okSrc = fs.readFileSync(okFile, 'utf8');
    fs.appendFileSync(okFile, 'x');
    assert.equal(pub().status, 1);
    fs.writeFileSync(okFile, okSrc);
    assert.equal(pub().status, 0);
    fs.writeFileSync(path.join(explained, 't-new.md'), okSrc);
    assert.equal(pub().status, 1, 'новая опубликованная без записи');
    fs.unlinkSync(path.join(explained, 't-new.md'));
    assert.equal(pub().status, 0);

    // снятие foreman снимает и верхнеуровневый sha256
    seed('t-top');
    assert.equal(record('t-top', 'edit').status, 0);
    assert.equal(record('t-top', 'check').status, 0);
    assert.equal(record('t-top', 'foreman').status, 0);
    fs.appendFileSync(path.join(explained, 't-top.md'), '\n');
    assert.equal(record('t-top', 'check').status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'данные/acceptance.json'), 'utf8'))['t-top'].sha256, undefined);

    // отметка материала обработанным — только с итогом выпуска
    const mark = (s) => node('pipeline-check.mjs', ['--mark', s]);
    assert.equal(mark('patent-limity').status, 1);
    fs.writeFileSync(path.join(ws, 'данные/разборы/patent-limity-итог.md'), 'Итог выпуска\n');
    assert.equal(mark('patent-limity').status, 0);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
