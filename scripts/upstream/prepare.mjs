import { access, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { root, lock, source, requireNode, verifySource } from './common.mjs';

requireNode();
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
});
try { await access(source); } catch {
  const proxy = process.env.JIUGUAN_GIT_NO_PROXY === '1' ? ['-c', 'http.proxy='] : [];
  await run('git', [...proxy, 'clone', '--depth', '1', '--branch', lock.tag, lock.repository, source], root);
}
const baseline = await verifySource();
const npmCli = process.env.JIUGUAN_NPM_CLI || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
try { await access(npmCli); } catch { throw new Error('找不到 npm CLI。请用 JIUGUAN_NPM_CLI 指定 npm-cli.js 的绝对路径。'); }
await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], source);
await verifySource();
await mkdir(path.join(root, 'artifacts/upstream'), { recursive: true });
await writeFile(path.join(root, 'artifacts/upstream/prepared.json'), JSON.stringify({ ...baseline, node: process.version, preparedAt: new Date().toISOString(), dependencyInstall: 'npm ci --omit=dev --ignore-scripts', androidVerified: false }, null, 2));
console.log('原版源码与依赖已准备；未修改上游核心。此步骤不是安卓运行验证。');
