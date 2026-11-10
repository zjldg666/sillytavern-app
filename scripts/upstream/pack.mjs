import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { root, source, lock, requireNode, verifySource, sha256 } from './common.mjs';

requireNode();
const baseline = await verifySource();
const nativeFiles = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) await scan(name);
    else if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') nativeFiles.push(path.relative(source, name));
  }
}
await scan(path.join(source, 'node_modules'));
if (nativeFiles.length) throw new Error(`发现需要独立审查的原生依赖，停止打包：${nativeFiles.join(', ')}`);
const directory = path.join(root, '.tools/upstream-runtime');
await mkdir(directory, { recursive: true });
const archive = path.join(directory, `sillytavern-${lock.tag}.tar`);
// 显式列出根目录条目，不用递归 exclude：Windows bsdtar 的 cache 过滤会误伤 webpack 源码。
const excluded = new Set(['.git', '.github', 'cache', 'data', 'config.yaml', 'backups']);
const entries = (await readdir(source)).filter(name => !excluded.has(name));
execFileSync('tar', ['-cf', archive, '-C', source, '--', ...entries], { windowsHide: true, stdio: 'inherit' });
const list = execFileSync('tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).split(/\r?\n/).map(name => name.replace(/^\.\//, ''));
for (const file of ['server.js', 'public/index.html', 'node_modules/webpack/lib/cache/getLazyHashedEtag.js', 'LICENSE']) {
  if (!list.includes(file)) throw new Error(`原版包缺少 ${file}`);
}
if (list.some(name => /^(?:\.git|cache|data|backups)(?:\/|$)/.test(name) || name === 'config.yaml')) throw new Error('归档包含禁止的源码根目录数据。');
const receipt = { ...baseline, archive: path.basename(archive), sha256: sha256(await readFile(archive)), entries: list.filter(Boolean).length, nativeAddons: nativeFiles };
await writeFile(path.join(directory, 'source-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
