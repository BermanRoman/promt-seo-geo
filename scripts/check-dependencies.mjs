#!/usr/bin/env node
// Проверка закреплённых зависимостей из dependencies.json: только чтение, без сети.
// Для каждой: каталог vendor/<name> — отдельный git-клон, HEAD равен revision,
// нужные файлы есть и байт в байт совпадают с объектами коммита (защита от
// assume-unchanged / skip-worktree и подмены через git replace), рабочее дерево чистое.
// Использование: node scripts/check-dependencies.mjs [--root <каталог клонов>] [--install]
// --install клонирует недостающие зависимости и переключает их на revision (нужна сеть).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root = rootIdx >= 0 ? resolve(args[rootIdx + 1] || '') : join(REPO, 'vendor');
const install = args.includes('--install');

const git = (cwd, ...a) => execFileSync('git', ['--no-replace-objects', '--no-optional-locks', '-C', cwd, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });

function readManifest() {
  const data = JSON.parse(readFileSync(join(REPO, 'dependencies.json'), 'utf8'));
  if (!data || !Array.isArray(data.dependencies) || !data.dependencies.length) throw new Error('dependencies must be a nonempty list');
  const names = new Set();
  for (const d of data.dependencies) {
    const keys = Object.keys(d).sort().join(',');
    if (keys !== 'files,name,purpose,revision,url') throw new Error('dependency schema');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(d.name) || names.has(d.name)) throw new Error('invalid or duplicate name');
    names.add(d.name);
    if (!/^[0-9a-f]{40}$/.test(d.revision)) throw new Error('revision must be an exact 40-character SHA');
    if (!Array.isArray(d.files) || !d.files.length || new Set(d.files).size !== d.files.length) throw new Error('files must be a nonempty unique list');
    for (const f of d.files) {
      if (typeof f !== 'string' || !f || f.startsWith('/') || f.includes('\\') || f.split('/').some((p) => ['', '.', '..'].includes(p))) throw new Error('files must stay inside checkout');
    }
  }
  return data.dependencies;
}

function check(d) {
  const dir = join(root, d.name);
  if (!existsSync(dir)) {
    if (!install) return 'missing checkout (node scripts/check-dependencies.mjs --install)';
    execFileSync('git', ['clone', '--quiet', d.url, dir], { stdio: 'inherit' });
    git(dir, 'checkout', '--quiet', d.revision);
  }
  try {
    const top = resolve(git(dir, 'rev-parse', '--show-toplevel').toString().trim());
    if (top !== resolve(dir)) return 'invalid checkout';
    const problems = [];
    if (git(dir, 'rev-parse', 'HEAD').toString().trim() !== d.revision) problems.push('stale revision');
    for (const f of d.files) {
      const target = resolve(dir, f);
      if (!target.startsWith(resolve(dir) + sep) || !existsSync(target)) { problems.push(`missing ${f}`); continue; }
      let pinned;
      try { pinned = git(dir, 'show', `${d.revision}:${f}`); } catch { problems.push(`not in revision: ${f}`); continue; }
      if (!pinned.equals(readFileSync(target))) problems.push(`modified ${f}`);
    }
    if (git(dir, 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none').length) problems.push('dirty checkout');
    return problems.length ? problems.join(', ') : 'ok';
  } catch {
    return 'unreadable checkout';
  }
}

let deps;
try { deps = readManifest(); } catch (e) { console.error(`dependencies.json: ${e.message}`); process.exit(2); }
let failed = false;
for (const d of deps) {
  const status = check(d);
  console.log(`${join(root, d.name)}: ${status}`);
  if (status !== 'ok') failed = true;
}
process.exit(failed ? 1 : 0);
