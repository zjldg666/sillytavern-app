import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, copyFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { root, source, requireNode, verifySource, writeConfig, sha256 } from './common.mjs';
import { prepareExtensions } from './prepare-extensions.mjs';

requireNode();
const baseline = await verifySource();
const runtime = path.join(root, '.tools/upstream-runtime/extracted');
const runtimeLock = JSON.parse(await readFile(path.join(root, 'platform/upstream/runtime.lock.json')));
const out = path.join(root, 'app/build/generated/upstream');
const assets = path.join(out, 'assets/upstream');
const native = path.join(out, 'jniLibs/arm64-v8a');
await mkdir(assets, { recursive: true });
await mkdir(native, { recursive: true });
for (const [name, expected, target] of [
  ['libnode.so', runtimeLock.nodeSha256, path.join(native, 'libjiuguan_node.so')],
  ['libc++_shared.so', runtimeLock.cxxSha256, path.join(native, 'libc++_shared.so')],
]) {
  const input = path.join(runtime, 'lib/arm64-v8a', name);
  if (sha256(await readFile(input)) !== expected) throw new Error(`运行时散列不匹配: ${name}`);
  await copyFile(input, target);
}
// 原生工程无 DCloud 同名库冲突，交由 Android 安装器提取到可执行库目录。
try { await unlink(path.join(assets, 'libc++_shared.so')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const payload = path.join(assets, 'server.zip');
// 每次验证基线；仅复用先前已验证且内容散列仍一致的资源包。
let receipt;
try { receipt = JSON.parse(await readFile(path.join(assets, 'payload.json'), 'utf8')); } catch {}
let valid = false;
if (receipt?.commit === baseline.commit && receipt?.packageLockSha256 === baseline.packageLockSha256) {
  try { valid = sha256(await readFile(payload)) === receipt.sha256; } catch {}
}
if (!valid || process.env.JIUGUAN_REPACK === '1') {
  const require = createRequire(path.join(source, 'package.json'));
  const archiver = require('archiver');
  const excluded = new Set(['.git', '.github', 'cache', 'data', 'backups', 'config.yaml']);
  const output = createWriteStream(payload);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve); output.on('error', reject);
    archive.on('error', reject); archive.on('warning', reject);
  });
  archive.pipe(output);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    if (entry.isDirectory()) archive.directory(path.join(source, entry.name), entry.name);
    else archive.file(path.join(source, entry.name), { name: entry.name });
  }
  await archive.finalize(); await completed;
  receipt = { ...baseline, sha256: sha256(await readFile(payload)), bytes: (await stat(payload)).size };
  await writeFile(path.join(assets, 'payload.json'), JSON.stringify(receipt, null, 2));
}
await writeFile(path.join(assets, 'payload.sha256'), receipt.sha256);
await writeConfig(assets, { dataRoot: './data', port: 18796 });
await mkdir(path.join(assets, 'legal'), { recursive: true });
for (const name of await readdir(path.join(runtime, 'assets/legal'))) {
  await copyFile(path.join(runtime, 'assets/legal', name), path.join(assets, 'legal', name));
}
for (const name of ['runtime.lock.json', 'upstream.lock.json']) {
  await copyFile(path.join(root, 'platform/upstream', name), path.join(assets, name));
}
await copyFile(path.join(source, 'LICENSE'), path.join(assets, 'legal/SILLYTAVERN-LICENSE'));
const extensions = await prepareExtensions();
await verifySource();
console.log(JSON.stringify({ prepared: true, ...receipt, ...extensions }));
