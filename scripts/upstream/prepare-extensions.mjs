import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root, sha256 } from './common.mjs';

export async function prepareExtensions() {
    const lock = JSON.parse(await readFile(path.join(root, 'platform/upstream/extensions.lock.json'), 'utf8'));
    const generated = path.resolve(root, 'app/build/generated/upstream/assets');
    const target = path.resolve(generated, 'bundled-extensions');
    if (path.dirname(target) !== generated) throw new Error('扩展输出目录越界');
    // 仅清理本脚本拥有的生成目录，避免旧版本文件混入 APK。
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const files = {};
    for (const extension of lock.extensions) {
        const source = path.resolve(root, extension.sourceDirectory);
        const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
        if (git('rev-parse', 'HEAD') !== extension.commit || git('status', '--porcelain', '--untracked-files=no')) throw new Error(`${extension.name} 源码提交不一致或有修改`);
        const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
        if (sha256(await readFile(path.join(source, manifest.js))) !== extension.entrySha256) throw new Error(`${extension.name} 入口校验失败`);
        async function copy(relative) {
            const input = path.join(source, relative);
            const output = path.join(target, extension.directory, relative);
            await mkdir(path.dirname(output), { recursive: true });
            await copyFile(input, output);
            files[`assets/bundled-extensions/${extension.directory}/${relative.replaceAll('\\', '/')}`] = sha256(await readFile(input));
        }
        async function tree(relative) {
            for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
                const child = path.join(relative, entry.name);
                if (entry.isDirectory()) await tree(child);
                else if (entry.isFile()) await copy(child);
                else throw new Error(`拒绝打包非普通文件: ${child}`);
            }
        }
        for (const entry of extension.deploy) {
            if (entry.includes('.')) await copy(entry);
            else if (entry === 'LICENSE') await copy(entry);
            else await tree(entry);
        }
        const receipt = JSON.stringify({ commit: extension.commit, entrySha256: extension.entrySha256 });
        const marker = `assets/bundled-extensions/${extension.directory}/bundled-revision.json`;
        await writeFile(path.join(target, extension.directory, 'bundled-revision.json'), receipt);
        files[marker] = sha256(receipt);
    }
    await writeFile(path.join(generated, 'upstream/extensions-receipt.json'), JSON.stringify({ extensions: lock.extensions, files }, null, 2));
    await copyFile(path.join(root, 'platform/upstream/extensions.lock.json'), path.join(generated, 'upstream/extensions.lock.json'));
    return { extensions: lock.extensions.map(e => `${e.name} ${e.version}`), files: Object.keys(files).length };
}
