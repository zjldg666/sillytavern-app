import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import path from 'node:path';
import { root, source, writeConfig, waitForServer, session, verifySource } from './common.mjs';
import { checkChatDisplay } from './chat-display-checks.mjs';

// 独立数据目录 + 本地模型模拟，比较 UI 改造前后的原版生成请求；不读取手机配置。
const report = { ...await verifySource(), checks: [], paidApiCalls: 0 };
await mkdir(path.join(root, '.tools/mobile-ui-regression'), { recursive: true });
const sandbox = await mkdtemp(path.join(root, '.tools/mobile-ui-regression/run-'));
const requests = [];
let child, browser, page;
const mock = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'ui-synthetic' }] })); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let text = ''; for await (const bytes of req) text += bytes;
    const request = JSON.parse(text); requests.push(request);
    if (request.model !== 'ui-synthetic') { res.writeHead(400).end(); return; }
    const content = '手机界面回归测试成功';
    if (request.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
    }
});
mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
const base = `http://127.0.0.1:${port}`;
const log = createWriteStream(path.join(sandbox, 'server.log'));
try {
    const config = await writeConfig(sandbox, { port });
    child = spawn(process.execPath, ['server.js', '--configPath', config], { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    await waitForServer(base, child);
    const post = await session(base);
    const form = new FormData(); form.set('file_type', 'json');
    form.set('avatar', new Blob([JSON.stringify({ name: 'APK 合成验收角色', description: '只用于 UI 回归的合成角色。', first_mes: '你好。' })]), 'ui-test.json');
    const imported = await post('/api/characters/import', form, { form: true });
    browser = await chromium.launch({ headless: true, ...(process.env.JIUGUAN_CHROME ? { executablePath: process.env.JIUGUAN_CHROME } : {}) });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.setDefaultTimeout(30000);
    const consoleTail = [];
    page.on('console', message => { consoleTail.push(message.text()); if (consoleTail.length > 35) consoleTail.shift(); });
    report.consoleTail = consoleTail;
    await page.goto(base);
    report.stage = '等待原版初始化';
    await page.waitForFunction(() => window.SillyTavern?.getContext);
    await page.evaluate(async () => {
        const api = await import('/script.js');
        window.__testApi = api;
        window.__testAppReady = false;
        api.eventSource.on(api.event_types.APP_READY, () => { window.__testAppReady = true; });
    });
    const readyDeadline = Date.now() + 25000;
    while (!await page.evaluate(() => window.__testAppReady)) {
        const onboarding = page.locator('dialog.popup[open]:has(.onboarding)');
        if (await onboarding.isVisible()) {
            await onboarding.locator('.popup-input').fill('UI回归测试');
            await onboarding.locator('.popup-button-ok').click();
        }
        if (Date.now() > readyDeadline) throw new Error('原版初始化没有完成');
        await page.waitForTimeout(200);
    }
    const identity = await page.evaluate(async () => {
        const api = await import('/script.js'); const oai = await import('/scripts/openai.js');
        const context = window.SillyTavern.getContext();
        const id = context.characters.findIndex(char => char.name === 'APK 合成验收角色');
        await context.selectCharacterById(id, { switchMenu: false });
        for (const el of document.querySelectorAll('#top-settings-holder > .drawer > .openDrawer')) await api.doNavbarIconClick.call(el.parentElement.querySelector('.drawer-toggle'));
        return { avatar_url: context.characters[id].avatar, file_name: window.SillyTavern.getContext().chatId };
    });
    const seed = await post('/api/chats/get', identity);
    report.stage = '发送原版基线请求';
    const configure = stream => page.evaluate(async ({ mockUrl, stream }) => {
        const api = await import('/script.js'); const { oai_settings: settings } = await import('/scripts/openai.js');
        settings.chat_completion_source = 'custom'; settings.custom_url = mockUrl; settings.custom_model = 'ui-synthetic';
        settings.stream_openai = stream; settings.bypass_status_check = true; settings.openai_max_tokens = 32;
        api.changeMainAPI('openai'); api.setOnlineStatus('ui-synthetic');
    }, { mockUrl: `http://127.0.0.1:${mock.address().port}/v1`, stream });
    async function send(stream) {
        await configure(stream);
        await page.locator('#send_textarea').fill('合成消息：验证界面不改变提示词。');
        const before = requests.length;
        await page.locator('#send_but').click();
        await page.waitForFunction(() => window.SillyTavern.getContext().chat.at(-1)?.mes === '手机界面回归测试成功');
        await page.waitForFunction(() => !window.__testApi.isGenerating() && !window.__testApi.isChatSaving);
        assert.equal(requests.length, before + 1);
    }
    await send(false);
    report.afterBaseline = await page.evaluate(async () => { const api = await import('/script.js'); const groups = await import('/scripts/group-chats.js'); return { send: api.is_send_press, group: groups.is_group_generating }; });
    report.stage = '安装手机 UI 并恢复相同历史';
    const css = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/style.css'), 'utf8');
    const js = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/index.js'), 'utf8');
    for (const name of ['connection-guard.js', 'chat-display.js']) {
        const body = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile', name), 'utf8');
        await page.route(`**/scripts/extensions/third-party/jiuguan-mobile/${name}`, route => route.fulfill({ contentType: 'text/javascript', body }));
    }
    await page.addStyleTag({ content: css });
    await page.evaluate(js);
    report.stage = '等待手机首页';
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
    await page.locator('[data-tab="roles"]').click();
    report.beforeClick = await page.evaluate(async () => { const api = await import('/script.js'); const groups = await import('/scripts/group-chats.js'); return { saving: api.isChatSaving, generating: api.isGenerating(), send: api.is_send_press, group: groups.is_group_generating, count: api.chat.length }; });
    report.stage = '点击角色进入聊天';
    await page.locator('.jg-role-open').filter({ hasText: 'APK 合成验收角色' }).click();
    report.afterClick = await page.evaluate(async () => { const api = await import('/script.js'); return { view: window.jiuguanMobile.view, busy: document.getElementById('jg-app').getAttribute('aria-busy'), saving: api.isChatSaving, generating: api.isGenerating(), toast: document.querySelector('#toast-container')?.textContent }; });
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chat');
    await post('/api/chats/save', { ...identity, chat: seed, force: true });
    await page.evaluate(() => window.SillyTavern.getContext().reloadCurrentChat());
    report.stage = '发送手机界面请求';
    await send(false);
    assert.deepEqual(requests[1], requests[0], '界面改造前后完整模型请求一致');
    report.checks.push('手机 UI 前后同卡同历史同输入，发送按钮产生的完整模型请求一致');
    await post('/api/chats/save', { ...identity, chat: seed, force: true });
    await page.evaluate(() => window.SillyTavern.getContext().reloadCurrentChat());
    report.stage = '发送流式请求';
    await send(true);
    const { stream: baselineStream, ...baseline } = requests[0];
    const { stream, ...streaming } = requests[2];
    assert.equal(stream, true); assert.equal(baselineStream, false);
    assert.deepEqual(streaming, baseline);
    report.checks.push('原版 SSE 流式消息在手机聊天页正常渲染；切换流式不改变其余请求内容');
    await page.screenshot({ path: path.join(root, 'artifacts/upstream/mobile-ui/generation-regression.png') });
    report.stage = '验证首页导入入口';
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.locator('[data-tab="roles"]').click();
    const beforeImport = await page.locator('.jg-role-card').count();
    const chooserEvent = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '导入角色卡', exact: true }).click();
    const chooser = await chooserEvent;
    await chooser.setFiles({ name: 'ui-import.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ name: '界面导入验收角色', first_mes: '仅用于隔离测试。' })) });
    await page.waitForFunction(count => document.querySelectorAll('.jg-role-card').length === count, beforeImport + 1);
    assert.equal(await page.locator('#jg-content .jg-count').innerText(), String(beforeImport + 1));
    report.checks.push('首页导入按钮触发原版文件输入，合成 JSON 卡导入后卡片和数量同步刷新（桌面隔离浏览器）');
    report.chatDisplay = await checkChatDisplay(page);
    await verifySource();
    report.checks.push('上游跟踪源码未修改，测试数据与手机用户数据隔离');
    report.passed = true;
    delete report.consoleTail; delete report.afterBaseline; delete report.beforeClick; delete report.afterClick;
} catch (error) {
    report.passed = false; report.error = error.message; process.exitCode = 1;
    if (page) { await page.screenshot({ path: path.join(root, 'artifacts/upstream/mobile-ui/regression-failure.png') }); report.pageText = (await page.locator('body').innerText()).slice(-1200); }
}
finally {
    await browser?.close();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    log.end(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
    report.modelRequests = requests.length;
    await mkdir(path.join(root, 'artifacts/upstream/mobile-ui'), { recursive: true });
    await writeFile(path.join(root, 'artifacts/upstream/mobile-ui/generation-regression.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
