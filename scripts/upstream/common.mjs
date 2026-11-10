import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const lock = JSON.parse(await readFile(path.join(root, 'platform/upstream/upstream.lock.json'), 'utf8'));
export const source = path.resolve(root, lock.sourceDirectory);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function requireNode() {
  if (Number(process.versions.node.split('.')[0]) < lock.minimumNodeMajor) {
    throw new Error(`原版酒馆需要 Node >= ${lock.minimumNodeMajor}，当前为 ${process.version}。请使用合适的 Node 执行本脚本。`);
  }
}

export async function verifySource() {
  const head = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (head !== lock.commit) throw new Error('上游提交不匹配；不自动重置或覆盖本地修改。');
  const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', windowsHide: true }).trim();
  if (dirty) throw new Error('上游已跟踪源码有改动；不能作为未修改原版基线。');
  if (sha256(await readFile(path.join(source, 'package-lock.json'))) !== lock.packageLockSha256) throw new Error('上游依赖锁散列不匹配。');
  return { version: lock.tag, commit: head, packageLockSha256: lock.packageLockSha256, patches: [] };
}

export async function writeConfig(directory, { dataRoot = path.join(directory, 'data'), port } = {}) {
  await mkdir(directory, { recursive: true });
  const config = YAML.parse(await readFile(path.join(source, 'default/config.yaml'), 'utf8'));
  config.dataRoot = dataRoot;
  config.port = port;
  config.listen = false;
  config.browserLaunch.enabled = false;
  config.extensions.autoUpdate = false;
  config.extensions.models.autoDownload = false;
  config.enableServerPlugins = false;
  config.enableServerPluginsAutoUpdate = false;
  config.enableDownloadableTokenizers = false;
  config.git = { backend: 'builtin' };
  const configPath = path.join(directory, 'config.yaml');
  await writeFile(configPath, YAML.stringify(config));
  return configPath;
}

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitForServer(base, processHandle, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (processHandle && processHandle.exitCode !== null) throw new Error('原版进程提前退出，请检查隔离目录中的日志。');
    try {
      const response = await fetch(`${base}/csrf-token`, { signal: AbortSignal.timeout(1500) });
      if (response.ok && typeof (await response.json()).token === 'string') return;
    } catch { /* 启动和 webpack 编译尚未完成。 */ }
    await delay(500);
  }
  throw new Error('原版服务未在时限内就绪。');
}

export async function session(base) {
  const response = await fetch(`${base}/csrf-token`);
  if (!response.ok) throw new Error(`CSRF 初始化失败：${response.status}`);
  const { token } = await response.json();
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return async (route, body, { form = false, raw = false } = {}) => {
    const result = await fetch(base + route, {
      method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': token, ...(form ? {} : { 'Content-Type': 'application/json' }) },
      body: form ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    if (!result.ok) throw new Error(`${route} 返回 ${result.status}: ${(await result.text()).slice(0, 250)}`);
    return raw ? result.text() : result.json();
  };
}
