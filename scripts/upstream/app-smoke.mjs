import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { root, requireNode, verifySource, session, sha256, delay } from './common.mjs';

requireNode();
if (process.env.JIUGUAN_APP_PROBE !== '1') throw new Error('设置 JIUGUAN_APP_PROBE=1，仅测试已安装的开发包。');
const serial = process.env.ANDROID_DEVICE_ID;
if (!serial) throw new Error('必须显式指定 ANDROID_DEVICE_ID');
const adbPath = process.env.ADB_PATH || 'adb';
const pkg = 'io.jiuguan.mobile.debug';
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
const report = {
  ...await verifySource(), platform: 'android-app-sandbox', package: pkg,
  androidApi: adb('shell', 'getprop ro.build.version.sdk'), abi: adb('shell', 'getprop ro.product.cpu.abi'),
  apkSha256: sha256(await readFile(path.join(root, 'app/build/outputs/apk/debug/app-debug.apk'))),
  checks: [], paidApiCalls: 0, appSandboxVerified: false,
};
assert.equal(adb('shell', 'pm', 'list', 'packages', '--user', '0', pkg), `package:${pkg}`);
let previous;
try { previous = JSON.parse(await readFile(path.join(root, 'artifacts/upstream/app-smoke.json'), 'utf8')); } catch {}
let requests = 0;
const mock = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const value = JSON.parse(body || '{}');
  if (req.url !== '/v1/chat/completions' || value.model !== 'jiuguan-app-synthetic') { res.writeHead(400).end(); return; }
  requests++;
  if (value.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '独立 APK 流式验证成功' } }] })}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '独立 APK 回复成功' } }] }));
  }
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
let forward, reverse, originalPort;
async function launch() {
  adb('shell', 'am', 'start', '-W', '-n', `${pkg}/io.jiuguan.mobile.MainActivity`);
  const deadline = Date.now() + 180000;
  let port;
  while (Date.now() < deadline) {
    try {
      const prefs = adb('shell', 'run-as', pkg, 'cat', 'shared_prefs/runtime.xml');
      port = Number(prefs.match(/name="port" value="(\d+)"/)?.[1]);
      if (port > 0 && port < 65536) break;
    } catch { /* 首次解压中 */ }
    await delay(1000);
  }
  assert.ok(port > 0, 'App 自动分配并保存本机端口');
  if (originalPort) assert.equal(port, originalPort, '重启沿用 WebView origin');
  originalPort = port;
  if (!forward) forward = Number(adb('forward', 'tcp:0', `tcp:${port}`));
  const base = `http://127.0.0.1:${forward}`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/csrf-token', { signal: AbortSignal.timeout(1000) });
      if (response.ok && typeof (await response.json()).token === 'string') return base;
    } catch { /* 应用内 Node 正在初始化 */ }
    await delay(500);
  }
  throw new Error('App 内服务未就绪');
}
try {
  let base = await launch();
  assert.match(await (await fetch(base)).text(), /SillyTavern/);
  const services = adb('shell', 'dumpsys', 'activity', 'services', pkg);
  assert.match(services, /isForeground=true/);
  report.checks.push('安装的 App 自行启动原版首页与 CSRF；Android 前台服务生效');
  let post = await session(base);
  if (previous?.passed && previous.syntheticCharacter && previous.apkSha256 !== report.apkSha256) {
    const restored = await post('/api/chats/get', { avatar_url: previous.syntheticCharacter, file_name: 'app-smoke' });
    assert.equal(restored?.[1]?.mes, '强制停止后应仍存在。');
    report.checks.push('覆盖安装更新 APK 后，前一次合成聊天仍保留');
  }
  const card = new FormData();
  card.set('file_type', 'json');
  card.set('avatar', new Blob([JSON.stringify({ name: 'APK 合成验收角色', first_mes: '仅用于本机模拟验证。' })]), 'app-smoke.json');
  const imported = await post('/api/characters/import', card, { form: true });
  assert.ok(imported.file_name);
  report.checks.push('App 内原版后端导入合成角色卡');
  reverse = Number(adb('reverse', 'tcp:0', `tcp:${mock.address().port}`));
  const request = {
    chat_completion_source: 'custom', custom_url: `http://127.0.0.1:${reverse}/v1`, model: 'jiuguan-app-synthetic',
    messages: [{ role: 'user', content: '合成验证，不连接真实模型。' }], stream: false, max_tokens: 32,
  };
  assert.equal((await post('/api/backends/chat-completions/generate', request)).choices[0].message.content, '独立 APK 回复成功');
  assert.match(await post('/api/backends/chat-completions/generate', { ...request, stream: true }, { raw: true }), /独立 APK 流式验证成功/);
  report.checks.push('App 内原版后端普通回复与 SSE；只连接本机模拟模型');
  const identity = { avatar_url: imported.file_name, file_name: 'app-smoke' };
  const chat = [{ user_name: '合成测试', character_name: 'APK 合成验收角色', chat_metadata: {} }, { name: '合成测试', is_user: true, mes: '强制停止后应仍存在。' }];
  await post('/api/chats/get', identity);
  assert.equal((await post('/api/chats/save', { ...identity, chat, force: true })).ok, true);
  adb('shell', 'am', 'force-stop', '--user', '0', pkg);
  let stopped = false;
  try { await fetch(base + '/csrf-token', { signal: AbortSignal.timeout(1000) }); } catch { stopped = true; }
  assert.ok(stopped, '强制停止应用后子进程也停止');
  base = await launch();
  post = await session(base);
  assert.deepEqual(await post('/api/chats/get', identity), chat);
  report.checks.push('强制停止 App 后服务消失；重新打开自动启动且聊天数据与端口保留');
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await delay(5000);
  assert.ok((await fetch(base + '/csrf-token')).ok);
  adb('shell', 'am', 'start', '-W', '-n', `${pkg}/io.jiuguan.mobile.MainActivity`);
  report.checks.push('退到桌面 5 秒后服务仍响应；可返回 App（不是长时后台保证）');
  assert.equal(requests, 2);
  report.appSandboxVerified = true;
  report.syntheticCharacter = imported.file_name;
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  if (forward) adb('forward', '--remove', `tcp:${forward}`);
  if (reverse) adb('reverse', '--remove', `tcp:${reverse}`);
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  await mkdir(path.join(root, 'artifacts/upstream'), { recursive: true });
  await writeFile(path.join(root, 'artifacts/upstream/app-smoke.json'), JSON.stringify({ ...report, mockRequests: requests, completedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
