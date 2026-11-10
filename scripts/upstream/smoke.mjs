import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, source, requireNode, verifySource, writeConfig, waitForServer, session } from './common.mjs';

requireNode();
const baseline = await verifySource();
await mkdir(path.join(root, '.tools/upstream-smoke'), { recursive: true });
const sandbox = await mkdtemp(path.join(root, '.tools/upstream-smoke/run-'));
const checks = [];
let received = 0;
const mock = createServer(async (req, res) => {
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const value = JSON.parse(body);
  received++;
  if (value.model !== 'jiuguan-synthetic' || value.messages.at(-1)?.content !== '合成测试，请回复。') {
    res.writeHead(400).end('Unexpected synthetic request'); return;
  }
  if (value.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '原版流式正常' }, finish_reason: null }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '原版非流式正常' }, finish_reason: 'stop' }] }));
  }
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const reserve = createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const config = await writeConfig(sandbox, { port });
let child;
let log;
const base = `http://127.0.0.1:${port}`;
async function start() {
  log = createWriteStream(path.join(sandbox, 'server.log'), { flags: 'a' });
  child = spawn(process.execPath, ['server.js', '--configPath', config], { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_ENV: 'production' } });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('error', error => log.write(String(error)));
  await waitForServer(base, child);
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  if (log) await new Promise(resolve => log.end(resolve));
}
const report = { ...baseline, platform: 'desktop', node: process.version, sandbox: path.relative(root, sandbox), checks, androidVerified: false, pluginsVerified: false, paidApiCalls: 0 };
try {
  await start();
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /SillyTavern/);
  checks.push('原版首页 HTTP 200（不代表浏览器交互验收）');
  let post = await session(base);
  const withoutCsrf = await fetch(base + '/api/chats/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(withoutCsrf.status, 403);
  checks.push('保留原版 CSRF 防护');
  const card = new FormData();
  card.set('file_type', 'json');
  card.set('avatar', new Blob([JSON.stringify({ name: '原版合成验收', description: '仅用于测试的角色。', first_mes: '你好。' })], { type: 'application/json' }), 'synthetic.json');
  const imported = await post('/api/characters/import', card, { form: true });
  assert.ok(imported.file_name);
  checks.push('原版角色 JSON 导入');
  const request = { chat_completion_source: 'custom', custom_url: `http://127.0.0.1:${mock.address().port}/v1`, model: 'jiuguan-synthetic', messages: [{ role: 'user', content: '合成测试，请回复。' }], max_tokens: 32, stream: false };
  const reply = await post('/api/backends/chat-completions/generate', request);
  assert.equal(reply.choices[0].message.content, '原版非流式正常');
  checks.push('原版后端 → 本机模拟模型：非流式');
  const streamed = await post('/api/backends/chat-completions/generate', { ...request, stream: true }, { raw: true });
  assert.match(streamed, /原版流式正常/);
  assert.match(streamed, /\[DONE\]/);
  checks.push('原版后端 → 本机模拟模型：SSE 流式');
  const chat = [{ user_name: '验收用户', character_name: '原版合成验收', chat_metadata: {} }, { name: '原版合成验收', is_user: false, mes: '只保存合成内容。', send_date: '2026-11-05' }];
  const identity = { avatar_url: imported.file_name, file_name: 'synthetic-smoke' };
  await post('/api/chats/get', identity);
  assert.equal((await post('/api/chats/save', { ...identity, chat, force: true })).ok, true);
  assert.deepEqual(await post('/api/chats/get', identity), chat);
  checks.push('原版聊天保存与读取');
  await stop();
  await start();
  post = await session(base);
  assert.deepEqual(await post('/api/chats/get', identity), chat);
  checks.push('原版进程重启后聊天恢复');
  assert.equal(received, 2);
  await verifySource();
  checks.push('测试后固定上游已跟踪源码仍无修改');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await stop();
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await mkdir(path.join(root, 'artifacts/upstream'), { recursive: true });
  await writeFile(path.join(root, 'artifacts/upstream/desktop-smoke.json'), JSON.stringify({ ...report, completedAt: new Date().toISOString(), mockRequests: received }, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
