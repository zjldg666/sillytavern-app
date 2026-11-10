import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, source, writeConfig, waitForServer, session, verifySource, sha256 } from './common.mjs';
import { checkMobilePerformance } from './mobile-performance-checks.mjs';

// 仅使用本项目独立实验目录，不连接 ADB、不读取手机或旧客户端的数据。
const lab = path.join(root, '.tools/extension-lab');
const extensions = path.join(lab, 'data/default-user/extensions');
const output = path.join(root, 'artifacts/upstream/extensions-lab');
await mkdir(output, { recursive: true });
const report = { upstream: await verifySource(), environment: 'isolated-desktop-chromium-mobile-viewport', androidVerified: false, userDataAccessed: false, paidApiCalls: 0, checks: [], extensions: [] };
for (const name of ['JS-Slash-Runner', 'ST-Prompt-Template']) {
    const dir = path.join(extensions, name);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', `${name} 使用未修改的发布文件`);
    report.extensions.push({ name: manifest.display_name, directory: name, version: manifest.version, repository: git('remote', 'get-url', 'origin'), commit: git('rev-parse', 'HEAD'), entrySha256: sha256(await readFile(path.join(dir, manifest.js))) });
}
await cp(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile'), path.join(extensions, 'jiuguan-mobile'), { recursive: true });
const requests = [];
const mock = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'extensions-lab' }] })); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); requests.push(value);
    assert.equal(value.model, 'extensions-lab');
    const content = '普通测试回复：<%= 3 + 4 %>';
    if (value.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    }
});
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
const base = `http://127.0.0.1:${port}`;
const log = createWriteStream(path.join(lab, 'server.log'));
let child, browser, page;
const errors = [];
try {
    const config = await writeConfig(lab, { port });
    child = spawn(process.execPath, ['server.js', '--configPath', config], { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    await waitForServer(base, child);
    const post = await session(base);
    const chars = await post('/api/characters/all', {});
    const name = '通用扩展验收：城市向导';
    if (!chars.some(char => char.name === name)) {
        const form = new FormData(); form.set('file_type', 'json');
        form.set('avatar', new Blob([JSON.stringify({ name, description: '你是一位介绍城市天气的向导。城市：<%= "杭州" %>；校验：<%= 6 * 7 %>。', first_mes: '欢迎来到普通扩展测试。' })]), 'extensions-lab.json');
        await post('/api/characters/import', form, { form: true });
    }
    browser = await chromium.launch({ headless: true, ...(process.env.JIUGUAN_CHROME ? { executablePath: process.env.JIUGUAN_CHROME } : {}) });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(25000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
    report.stage = '原版加载两个扩展';
    await page.goto(base);
    await page.waitForFunction(() => window.SillyTavern?.getContext);
    await page.evaluate(async () => { window.__labApi = await import('/script.js'); window.__labReady = false; window.__labApi.eventSource.on(window.__labApi.event_types.APP_READY, () => { window.__labReady = true; }); });
    const deadline = Date.now() + 30000;
    while (!await page.evaluate(() => window.__labReady)) {
        const onboarding = page.locator('dialog.popup[open]:has(.onboarding)');
        if (await onboarding.isVisible()) { await onboarding.locator('.popup-input').fill('普通扩展测试'); await onboarding.locator('.popup-button-ok').click(); }
        if (Date.now() > deadline) throw new Error('原版初始化超时');
        await page.waitForTimeout(200);
    }
    await page.waitForFunction(() => window.TavernHelper?.getVariables && window.EjsTemplate?.evalTemplate && window.jiuguanMobile?.view === 'chats');
    report.checks.push('原版扩展机制加载酒馆助手、提示词模板和浅色手机 UI');
    await page.locator('[data-tab="settings"]').click();
    await page.locator('[data-panel="extensions-settings-button"]').click();
    await page.locator('#tavern_helper').waitFor({ state: 'visible' });
    await page.locator('#pt_enabled').waitFor({ state: 'attached' });
    await page.locator('#tavern_helper .inline-drawer-toggle').first().click();
    await page.locator('#tavern_helper').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, 'settings.png') });
    report.checks.push('手机设置 → 正则与扩展能找到两个原版扩展面板');
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.locator('[data-tab="roles"]').click();
    await page.getByRole('button', { name: `与 ${name} 聊天`, exact: true }).click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chat');
    report.stage = '助手变量与模板表达式';
    const values = await page.evaluate(async () => {
        window.TavernHelper.replaceVariables({ lab_city: '杭州', lab_counter: 2 }, { type: 'chat' });
        return { city: window.TavernHelper.getVariables({ type: 'chat' }).lab_city, expression: await window.EjsTemplate.evalTemplate('计算结果：<%= 6 * 7 %>'), shared: await window.EjsTemplate.evalTemplate('城市：<%- getvar("lab_city") %>') };
    });
    assert.equal(values.city, '杭州'); assert.equal(values.expression, '计算结果：42'); assert.equal(values.shared, '城市：杭州');
    report.checks.push('助手会话变量读写、EJS 算式及两个扩展共享变量通过');
    report.stage = '助手 HTML 按钮';
    const html = '<body><section style="padding:16px;background:#edf2eb;color:#23312c;font:16px system-ui"><h3>普通交互测试</h3><button id="lab-button">点击检查</button><p id="lab-result">等待点击</p></section><script>document.getElementById("lab-button").onclick=function(){document.getElementById("lab-result").textContent="按钮已响应";};</script></body>';
    await page.evaluate(async message => { await window.TavernHelper.createChatMessages([{ role: 'assistant', message }]); }, '```html\n' + html + '\n```');
    const frame = page.frameLocator('iframe[id^="TH-message"]').last();
    await frame.locator('#lab-button').click();
    assert.equal(await frame.locator('#lab-result').innerText(), '按钮已响应');
    await page.screenshot({ path: path.join(output, 'interaction.png') });
    report.checks.push('助手把普通 HTML 消息渲染为 iframe，按钮脚本执行通过');
    for (const stream of [false, true]) {
        report.stage = stream ? '流式模板链路' : '普通模板链路';
        await page.evaluate(async ({ url, stream }) => {
            const { oai_settings: s } = await import('/scripts/openai.js');
            s.chat_completion_source = 'custom'; s.custom_url = url; s.custom_model = 'extensions-lab'; s.stream_openai = stream; s.bypass_status_check = true; s.openai_max_tokens = 32;
            window.__labApi.changeMainAPI('openai'); window.__labApi.setOnlineStatus('extensions-lab');
        }, { url: `http://127.0.0.1:${mock.address().port}/v1`, stream });
        const before = requests.length;
        const chatLength = await page.evaluate(() => window.SillyTavern.getContext().chat.length);
        await page.locator('#send_textarea').fill('请介绍今天的天气。');
        await page.locator('#send_but').click();
        await page.waitForFunction(count => { const chat = window.SillyTavern.getContext().chat; return chat.length >= count + 2 && !chat.at(-1).is_user && chat.at(-1).mes.includes('普通测试回复'); }, chatLength);
        await page.waitForFunction(() => !window.__labApi.isGenerating() && !window.__labApi.isChatSaving);
        assert.equal(requests.length, before + 1);
        const prompt = requests.at(-1).messages.map(m => m.content).join('\n');
        assert.ok(prompt.includes('城市：杭州；校验：42'));
        assert.ok(!prompt.includes('<%= 6 * 7 %>'));
        assert.ok((await page.locator('#chat .mes').last().innerText()).includes('普通测试回复：7'));
        report.checks.push(`${stream ? 'SSE' : '普通'}模拟生成：请求前模板展开，回复模板渲染为 7`);
    }
    await page.screenshot({ path: path.join(output, 'generation.png') });
    report.stage = '刷新后变量保留';
    await page.evaluate(() => window.__labApi.saveChatConditional());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats' && window.TavernHelper?.getVariables && window.EjsTemplate?.evalTemplate);
    await page.locator('[data-tab="roles"]').click();
    await page.getByRole('button', { name: `与 ${name} 聊天`, exact: true }).click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chat');
    assert.equal(await page.evaluate(() => window.TavernHelper.getVariables({ type: 'chat' }).lab_city), '杭州');
    report.checks.push('刷新后两个扩展自动加载，会话变量保留');
    if (process.env.JIUGUAN_PERFORMANCE_PROBE === '1') {
        report.stage = '长聊天与工具栏';
        report.performance = await checkMobilePerformance(page, { screenshot: name => page.screenshot({ path: path.join(output, `${name}.png`) }) });
    }
    await verifySource();
    report.passed = true;
} catch (error) {
    report.passed = false; report.error = error.message; process.exitCode = 1;
    if (page) { await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); report.pageText = (await page.locator('body').innerText().catch(() => '')).slice(-1000); }
} finally {
    report.errors = [...new Set(errors)].slice(-20); report.modelRequests = requests.length;
    await browser?.close();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    log.end(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
