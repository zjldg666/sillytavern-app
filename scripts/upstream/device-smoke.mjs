import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { root, requireNode, verifySource, writeConfig, waitForServer, session, sha256 } from './common.mjs';

requireNode();
if (process.env.JIUGUAN_DEVICE_PROBE !== '1') throw new Error('真机测试需显式设置 JIUGUAN_DEVICE_PROBE=1；仅使用 /data/local/tmp 下独立合成目录。');
const serial = process.env.ANDROID_DEVICE_ID;
if (!serial) throw new Error('请通过 ANDROID_DEVICE_ID 指定设备，避免操作其他设备。');
const adbPath = process.env.ADB_PATH || 'adb';
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024 }).trim();
const q = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const baseline = await verifySource();
const runtime = path.join(root, '.tools/upstream-runtime');
const receipt = JSON.parse(await readFile(path.join(runtime, 'receipt.json'), 'utf8'));
const deviceRoot = process.env.JIUGUAN_DEVICE_ROOT || adb('shell', 'mktemp -d /data/local/tmp/jiuguan-upstream-XXXXXX');
if (!/^\/data\/local\/tmp\/jiuguan-upstream-[A-Za-z0-9]{6}$/.test(deviceRoot)) throw new Error('拒绝使用非原型隔离目录。');
const deviceServer = `${deviceRoot}/server`;
const localRun = path.join(runtime, path.posix.basename(deviceRoot));
await mkdir(localRun, { recursive: true });
const report = { ...baseline, platform: 'android-adb-shell', androidApi: adb('shell', 'getprop ro.build.version.sdk'), abi: adb('shell', 'getprop ro.product.cpu.abi'), deviceRoot, runtimeApkSha256: receipt.apkSha256, checks: [], paidApiCalls: 0, appSandboxVerified: false, hbuilderHostVerified: false, apkVerified: false, pluginsVerified: false };
assert.equal(report.abi, 'arm64-v8a');
const exists = adb('shell', `if [ -f ${q(deviceServer + '/server.js')} ]; then echo yes; fi`);
if (exists !== 'yes') {
  adb('push', path.join(runtime, 'sillytavern-1.19.0.tar'), `${deviceRoot}/source.tar`);
  adb('shell', `mkdir -p ${q(deviceServer)} && tar -xf ${q(deviceRoot + '/source.tar')} -C ${q(deviceServer)}`);
}
const sourceHash = sha256(await readFile(path.join(runtime, 'sillytavern-1.19.0.tar')));
assert.equal(adb('shell', `sha256sum ${q(deviceRoot + '/source.tar')}`).split(/\s+/)[0], sourceHash, '手机源码包散列');
for (const name of await readdir(path.join(runtime, 'extracted/lib/arm64-v8a'))) {
  const file = path.join(runtime, 'extracted/lib/arm64-v8a', name);
  const expected = receipt.files.find(item => item.path === `lib/arm64-v8a/${name}`);
  assert.equal(sha256(await readFile(file)), expected?.sha256);
  adb('push', file, `${deviceRoot}/${name}`);
}
const node = `${deviceRoot}/libnode.so`;
adb('shell', `chmod 700 ${q(node)}`);
const environment = `LD_LIBRARY_PATH=${q(deviceRoot)} TMPDIR=${q(deviceRoot)} NODE_ENV=production`;
report.node = adb('shell', `${environment} ${q(node)} --version`);
report.checks.push('Android arm64 Node 可执行文件运行');
const choosePort = `const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})`;
const port = Number(adb('shell', `${environment} ${q(node)} -e ${q(choosePort)}`));
assert.ok(Number.isInteger(port) && port > 1024);
const config = await writeConfig(localRun, { port, dataRoot: `${deviceRoot}/data` });
adb('push', config, `${deviceRoot}/config.yaml`);
let requests = 0;
const mock = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const value = JSON.parse(body || '{}');
  if (req.url !== '/v1/chat/completions' || value.model !== 'jiuguan-device-synthetic') { res.writeHead(400).end(); return; }
  requests++;
  if (value.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '手机原版流式成功' } }] })}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '手机原版回复成功' } }] }));
  }
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
let forward;
let reverse;
let remotePid;
async function start() {
  const command = `cd ${q(deviceServer)} && echo $$ > ${q(deviceRoot + '/pid')} && exec ${environment} ${q(node)} server.js --configPath ${q(deviceRoot + '/config.yaml')}`;
  // env 是 exec 的程序；不能将环境赋值当成可执行文件。
  const processHandle = spawn(adbPath, ['-s', serial, 'shell', command.replace('exec LD_LIBRARY_PATH=', 'exec env LD_LIBRARY_PATH=')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  processHandle.stdout.on('data', value => { log = (log + value).slice(-200000); });
  processHandle.stderr.on('data', value => { log = (log + value).slice(-200000); });
  processHandle.on('exit', () => { void writeFile(path.join(localRun, 'server.log'), log); });
  try { await waitForServer(`http://127.0.0.1:${forward}`, processHandle, 180000); }
  finally { remotePid = adb('shell', `cat ${q(deviceRoot + '/pid')}`).trim(); }
}
async function stop() {
  if (!remotePid || !/^\d+$/.test(remotePid)) return;
  const command = adb('shell', `cat /proc/${remotePid}/cmdline 2>/dev/null || true`);
  if (command.includes(node)) adb('shell', `kill -TERM ${remotePid}`);
  remotePid = undefined;
  for (let i = 0; i < 30; i++) {
    try { await fetch(`http://127.0.0.1:${forward}/csrf-token`, { signal: AbortSignal.timeout(200) }); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('原版进程停止后端口仍在响应。');
}
try {
  forward = Number(adb('forward', 'tcp:0', `tcp:${port}`));
  reverse = Number(adb('reverse', 'tcp:0', `tcp:${mock.address().port}`));
  await start();
  const base = `http://127.0.0.1:${forward}`;
  assert.match(await (await fetch(base)).text(), /SillyTavern/);
  report.checks.push('手机本地原版服务与首页响应');
  let post = await session(base);
  const card = new FormData();
  card.set('file_type', 'json');
  card.set('avatar', new Blob([JSON.stringify({ name: '手机原版合成角色', first_mes: '仅作合成验证。' })]), 'device.json');
  const imported = await post('/api/characters/import', card, { form: true });
  assert.ok(imported.file_name);
  report.checks.push('手机原版角色导入');
  const request = { chat_completion_source: 'custom', custom_url: `http://127.0.0.1:${reverse}/v1`, model: 'jiuguan-device-synthetic', messages: [{ role: 'user', content: '合成测试。' }], stream: false, max_tokens: 32 };
  assert.equal((await post('/api/backends/chat-completions/generate', request)).choices[0].message.content, '手机原版回复成功');
  assert.match(await post('/api/backends/chat-completions/generate', { ...request, stream: true }, { raw: true }), /手机原版流式成功/);
  report.checks.push('手机原版后端非流式与 SSE（ADB 反向连接本机模拟模型）');
  const identity = { avatar_url: imported.file_name, file_name: 'device-smoke' };
  const chat = [{ user_name: '测试', character_name: '手机原版合成角色', chat_metadata: {} }, { name: '测试', is_user: true, mes: '合成内容，仅验证恢复。' }];
  await post('/api/chats/get', identity);
  assert.equal((await post('/api/chats/save', { ...identity, chat, force: true })).ok, true);
  await stop();
  await start();
  post = await session(base);
  assert.deepEqual(await post('/api/chats/get', identity), chat);
  report.checks.push('手机进程停止/重启，原版聊天持久化恢复');
  assert.equal(requests, 2);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  try { await stop(); } catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
  if (forward) adb('forward', '--remove', `tcp:${forward}`);
  if (reverse) adb('reverse', '--remove', `tcp:${reverse}`);
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await mkdir(path.join(root, 'artifacts/upstream'), { recursive: true });
  await writeFile(path.join(root, 'artifacts/upstream/device-smoke.json'), JSON.stringify({ ...report, mockRequests: requests, completedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
