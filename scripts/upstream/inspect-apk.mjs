import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root, source, sha256 } from './common.mjs';

const require = createRequire(path.join(source, 'package.json'));
const yauzl = require('yauzl');
const variant = process.env.JIUGUAN_APK_VARIANT || 'debug';
assert.ok(['debug', 'release'].includes(variant));
const apk = path.join(root, `app/build/outputs/apk/${variant}/app-${variant}.apk`);
const runtime = JSON.parse(await readFile(path.join(root, 'platform/upstream/runtime.lock.json')));
const payload = JSON.parse(await readFile(path.join(root, 'app/build/generated/upstream/assets/upstream/payload.json')));
const expected = {
  'lib/arm64-v8a/libjiuguan_node.so': runtime.nodeSha256,
  'lib/arm64-v8a/libc++_shared.so': runtime.cxxSha256,
  'assets/upstream/server.zip': payload.sha256,
};
const extensions = JSON.parse(await readFile(path.join(root, 'app/build/generated/upstream/assets/upstream/extensions-receipt.json'), 'utf8'));
Object.assign(expected, extensions.files);
for (const name of ['manifest.json', 'index.js', 'style.css', 'connection-guard.js', 'chat-display.js']) {
  expected[`assets/extensions/jiuguan-mobile/${name}`] = sha256(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile', name)));
}
const report = { apkSha256: sha256(await readFile(apk)), entries: {} };
await new Promise((resolve, reject) => {
  yauzl.open(apk, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', entry => {
      if (!(entry.fileName in expected) && !entry.fileName.startsWith('assets/upstream/legal/')) { zip.readEntry(); return; }
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const digest = createHash('sha256');
        stream.on('error', reject);
        stream.on('data', bytes => digest.update(bytes));
        stream.on('end', () => {
          report.entries[entry.fileName] = { bytes: entry.uncompressedSize, sha256: digest.digest('hex') };
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
});
for (const [name, hash] of Object.entries(expected)) assert.equal(report.entries[name]?.sha256, hash, name);
assert.ok(report.entries['assets/upstream/legal/node_MIT.txt']);
assert.ok(report.entries['assets/upstream/legal/SILLYTAVERN-LICENSE']);
await mkdir(path.join(root, 'artifacts/upstream'), { recursive: true });
await writeFile(path.join(root, `artifacts/upstream/apk-inspection${variant === 'release' ? '-release' : ''}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
