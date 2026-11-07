// CLI regression: only a disposable WORDSTAT_LOG; no MCP/API calls or real journal reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./wordstat-log.mjs', import.meta.url));
const mcp = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const legacy = (phrase, extra = {}) => ({
  date: today(), method: 'top_requests', phrase, key: phrase,
  region: '', devices: 'all', kind: 'news', by: 'CLI regression fixture',
  totalCount: 4021, top: [], ...extra,
});

test('wordstat-log CLI rejects false zeros and preserves confirmed measurements', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordstat-log-test-'));
  const log = path.join(tmp, 'journal.jsonl');
  const run = (args, input = '') => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, WORDSTAT_LOG: log },
      input, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'CLI was terminated by a signal');
    return result;
  };
  const seed = (records = []) => fs.writeFileSync(log, records.map((r) => JSON.stringify(r) + '\n').join(''));
  const contents = () => fs.readFileSync(log, 'utf8');
  const records = () => contents().trim().split('\n').filter(Boolean).map((s) => JSON.parse(s));
  const add = (phrase, payload) => run([
    'add', '--method', 'top_requests', '--phrase', phrase,
    '--kind', 'news', '--by', 'CLI regression fixture',
  ], JSON.stringify(payload));
  const absent = (phrase) => {
    assert.equal(run(['get', phrase]).status, 1, 'invalid measurement must not be returned by get');
    assert.equal(run(['find', phrase]).status, 1, 'invalid measurement must not be returned by find');
    assert.equal(run(['find', phrase, '--all']).status, 1, '--all must not bypass validation');
  };
  const rejects = async (name, payload) => t.test(name, () => {
    seed([legacy('untouched fixture')]);
    const before = contents();
    const result = add('invalid fixture', payload);
    assert.notEqual(result.status, 0, 'invalid response must fail instead of becoming a measurement');
    assert.equal(contents(), before, 'rejection must not append, truncate or rewrite the journal');
    absent('invalid fixture');
  });

  try {
    for (const [name, payload] of [
      ['empty object', {}], ['MCP empty object', mcp({})],
      ['null payload', null], ['MCP null payload', mcp(null)],
      ['blank string payload', '  '], ['array payload', []],
    ]) await rejects(name, payload);

    const invalidCounts = [null, '', ' \t ', [], [0], {}, -1, '-1', true, false, 'NaN', 'Infinity', 'not a count'];
    for (const [i, count] of invalidCounts.entries()) {
      await rejects(`invalid totalCount ${i}: ${JSON.stringify(count)}`, { totalCount: count, results: [] });
      await rejects(`invalid nested count ${i}: ${JSON.stringify(count)}`, {
        totalCount: 4021, results: [{ phrase: 'nested fixture', count }],
      });
    }

    for (const [name, results] of [
      ['null', null], ['object', {}], ['string', ''], ['boolean', false],
      ['null item', [null]], ['array item', [[]]], ['string item', ['bad']],
      ['missing phrase', [{ count: 1 }]], ['blank phrase', [{ phrase: ' ', count: 1 }]],
      ['non-string phrase', [{ phrase: 1, count: 1 }]], ['missing count', [{ phrase: 'nested fixture' }]],
    ]) {
      await rejects(`malformed results: ${name}`, { totalCount: 4021, results });
    }
    await rejects('MCP malformed results', mcp({ totalCount: 4021, results: [{ phrase: 'nested fixture' }] }));
    await rejects('explicit API error with count is not a confirmed zero', { error: 'upstream failed', totalCount: 0, results: [] });
    await rejects('error flag outside content is not a confirmed zero', { isError: true, totalCount: 0, results: [] });
    await rejects('MCP error flag with apparently valid data', { ...mcp({ totalCount: 0, results: [] }), isError: true });

    await t.test('malformed JSON and empty stdin preserve existing records', () => {
      seed([legacy('untouched fixture')]);
      const before = contents();
      for (const input of ['', '   ', '{']) {
        const result = run(['add', '--method', 'top_requests', '--phrase', 'invalid fixture', '--kind', 'news', '--by', 'CLI regression fixture'], input);
        assert.notEqual(result.status, 0);
        assert.equal(contents(), before);
      }
    });

    await t.test('successful MCP 4021 survives add/get/find', () => {
      seed();
      assert.equal(add('valid fixture', mcp({ totalCount: 4021, results: [{ phrase: 'nested fixture', count: 123 }] })).status, 0);
      assert.equal(records().length, 1);
      assert.equal(records()[0].totalCount, 4021);
      assert.deepEqual(records()[0].top, [['nested fixture', 123]]);
      const found = run(['get', 'valid fixture']);
      assert.equal(found.status, 0);
      assert.equal(JSON.parse(found.stdout).totalCount, 4021);
      assert.equal(run(['find', 'nested fixture']).status, 0, 'nested phrases remain searchable');
    });

    await t.test('numeric strings are normalized without losing valid data', () => {
      seed();
      assert.equal(add('string count fixture', { totalCount: '4021', results: [{ phrase: 'nested fixture', count: '123' }] }).status, 0);
      assert.equal(records()[0].totalCount, 4021);
      assert.deepEqual(records()[0].top, [['nested fixture', 123]]);
    });

    for (const payload of [{ totalCount: 0, results: [] }, mcp({ totalCount: '0', results: [] }), { totalCount: 0 }]) {
      await t.test(`explicit zero is confirmed and available: ${JSON.stringify(payload)}`, () => {
        seed();
        assert.equal(add('zero fixture', payload).status, 0);
        assert.equal(records()[0].zeroConfirmed, true);
        assert.equal(records()[0].totalCount, 0);
        const found = run(['get', 'zero fixture']);
        assert.equal(found.status, 0);
        assert.equal(JSON.parse(found.stdout).zeroConfirmed, true);
        const search = run(['find', 'zero fixture']);
        assert.equal(search.status, 0);
        assert.match(search.stdout, /totalCount 0/);
      });
    }

    for (const top of [[], undefined]) {
      await t.test(`legacy unconfirmed zero is skipped: top ${JSON.stringify(top)}`, () => {
        seed([legacy('old zero fixture', { totalCount: 0, top })]);
        absent('old zero fixture');
      });
    }

    for (const count of [undefined, null, '', '42', -1, true, false, [], {}]) {
      await t.test(`invalid legacy count is skipped: ${JSON.stringify(count)}`, () => {
        seed([legacy('old invalid fixture', { totalCount: count })]);
        absent('old invalid fixture');
      });
    }

    await t.test('invalid newer cache cannot hide a valid older measurement', () => {
      const yesterday = new Date(Date.now() - 864e5).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
      seed([
        legacy('fallback fixture', { date: yesterday }),
        legacy('fallback fixture', { totalCount: 0 }),
        legacy('fallback fixture', { totalCount: 'bad' }),
      ]);
      const found = run(['get', 'fallback fixture']);
      assert.equal(found.status, 0);
      assert.equal(JSON.parse(found.stdout).totalCount, 4021);
      const search = run(['find', 'fallback fixture', '--all']);
      assert.equal(search.status, 0);
      assert.equal(search.stdout.trim().split('\n').length, 1);
      assert.match(search.stdout, /totalCount 4021/);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
