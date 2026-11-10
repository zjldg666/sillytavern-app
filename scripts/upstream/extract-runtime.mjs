import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { root, source, sha256 } from './common.mjs';

// 只提取公开发布包中的 Android Node 运行时和许可证；不安装第三方 App。
const require = createRequire(path.join(source, 'package.json'));
const yauzl = require('yauzl');
const directory = path.join(root, '.tools/upstream-runtime');
const apk = path.join(directory, 'ST-android-0.5.1.apk');
const runtimeLock = JSON.parse(await readFile(path.join(root, 'platform/upstream/runtime.lock.json'), 'utf8'));
if (sha256(await readFile(apk)) !== runtimeLock.apkSha256) throw new Error('下载包与固定原型运行时散列不匹配。');
const extracted = [];
await new Promise((resolve, reject) => {
  yauzl.open(apk, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', async entry => {
      try {
        const name = entry.fileName;
        if (!/^lib\/arm64-v8a\/[a-zA-Z0-9_.+-]+\.so$/.test(name) && !/^assets\/legal\/[a-zA-Z0-9_.+-]+$/.test(name) && name !== 'assets/node_payload/manifest.json') {
          zip.readEntry(); return;
        }
        const target = path.join(directory, 'extracted', name);
        await mkdir(path.dirname(target), { recursive: true });
        const stream = await new Promise((ok, fail) => zip.openReadStream(entry, (err, value) => err ? fail(err) : ok(value)));
        await pipeline(stream, createWriteStream(target));
        extracted.push({ path: name, sha256: sha256(await readFile(target)), bytes: entry.uncompressedSize });
        zip.readEntry();
      } catch (err) { zip.close(); reject(err); }
    });
    zip.readEntry();
  });
});
if (!extracted.some(item => item.path === 'lib/arm64-v8a/libnode.so')) throw new Error('发布包没有预期的 arm64 Node 可执行文件。');
const receipt = { release: 'https://github.com/Sanitised/ST-android/releases/tag/v0.5.1', asset: 'ST-android-0.5.1.apk', apkSha256: sha256(await readFile(apk)), purpose: '运行时可行性测试；未安装第三方 APK、未确定分发方案', files: extracted };
await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
