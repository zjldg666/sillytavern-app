import { access, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, sha256 } from './common.mjs';
const lock = JSON.parse(await readFile(path.join(root, 'platform/upstream/extensions.lock.json'), 'utf8'));
for (const extension of lock.extensions) {
    const directory = path.resolve(root, extension.sourceDirectory);
    const git = (...args) => execFileSync('git', [...(process.env.JIUGUAN_GIT_NO_PROXY === '1' ? ['-c', 'http.proxy=', '-c', 'https.proxy='] : []), '-C', directory, ...args], { encoding: 'utf8', windowsHide: true, timeout: 180000 }).trim();
    let exists = true;
    try { await access(directory); } catch { exists = false; }
    if (!exists) {
        await mkdir(directory, { recursive: true });
        git('init'); git('remote', 'add', 'origin', extension.repository);
        git('fetch', '--depth', '1', 'origin', extension.commit);
        git('checkout', '--detach', extension.commit);
    }
    if (git('rev-parse', 'HEAD') !== extension.commit || git('status', '--porcelain', '--untracked-files=no')) throw new Error(`${extension.name} 缓存不匹配，不自动覆盖`);
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (sha256(await readFile(path.join(directory, manifest.js))) !== extension.entrySha256) throw new Error(`${extension.name} 入口散列不匹配`);
    console.log(`${extension.name} ${extension.version}: ${extension.commit}`);
}
