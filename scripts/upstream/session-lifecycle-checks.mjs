import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, source, writeConfig, waitForServer, verifySource, session } from './common.mjs';

const baseline = process.argv.includes('--baseline');
const out = path.join(root, 'artifacts/upstream/session-lifecycle');
await mkdir(out, { recursive: true });
const sandbox = await mkdtemp(path.join(root, '.tools/mobile-ui-regression/sessions-'));
const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
const base = `http://127.0.0.1:${port}`;
const report = { upstream: await verifySource(), baseline, checks: [], paidApiCalls: 0 };
let child, browser;
const log = createWriteStream(path.join(sandbox, 'server.log'));
try {
    const config = await writeConfig(sandbox, { port });
    child = spawn(process.execPath, ['server.js', '--configPath', config], { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    await waitForServer(base, child);
    const post = await session(base);
    const avatars = [];
    for (const name of ['会话验收甲', '会话验收乙']) {
        const form = new FormData(); form.set('file_type', 'json');
        form.set('avatar', new Blob([JSON.stringify({ name, first_mes: `${name}的开场白。` })]), 'synthetic.json');
        const result = await post('/api/characters/import', form, { form: true });
        avatars.push(result.file_name.endsWith('.png') ? result.file_name : `${result.file_name}.png`);
    }
    const history = [{ user_name: '合成用户', character_name: '合成角色', chat_metadata: {} },
        { name: '合成用户', is_user: true, mes: 'A 的旧消息必须完整保留', send_date: '2026-11-12T08:00:00Z' }];
    for (const [i, avatar] of avatars.entries()) {
        for (const file of ['session-A', 'session-B']) await post('/api/chats/save', { avatar_url: avatar, file_name: file, chat: history, force: true });
        await post('/api/characters/merge-attributes', { avatar, chat: 'session-A' }, { raw: true });
    }
    const group = await post('/api/groups/create', { name: '合成会话测试群', members: avatars, chat_id: 'group-A', chats: ['group-A', 'group-B'] });
    for (const id of group.chats) await post('/api/chats/group/save', { id, chat: history, force: true });
    browser = await chromium.launch({ headless: true, executablePath: process.env.JIUGUAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => localStorage.setItem('language', 'zh-cn'));
    await page.goto(base);
    await page.waitForFunction(() => window.SillyTavern?.getContext);
    await page.evaluate(async () => { const api = await import('/script.js'); api.eventSource.on(api.event_types.APP_READY, () => { window.__ready = true; }); });
    const deadline = Date.now() + 60000;
    while (!await page.evaluate(() => window.__ready)) {
        const onboarding = page.locator('dialog.popup[open]:has(.onboarding)');
        if (await onboarding.isVisible()) { await onboarding.locator('.popup-input').fill('会话验收'); await onboarding.locator('.popup-button-ok').evaluate(el => el.click()).catch(() => {}); }
        if (Date.now() > deadline) throw new Error('APP_READY timeout');
        await page.waitForTimeout(100);
    }
    for (const file of ['connection-guard.js', 'chat-display.js']) {
        const body = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile', file), 'utf8');
        await page.route(`**/scripts/extensions/third-party/jiuguan-mobile/${file}`, route => route.fulfill({ contentType: 'text/javascript', body }));
    }
    await page.addStyleTag({ content: await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/style.css'), 'utf8') });
    await page.evaluate(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/index.js'), 'utf8'));
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
    await page.locator('.jg-chat-row').first().waitFor();
    const check = (name, passed, detail) => report.checks.push({ name, passed, ...(detail ? { detail } : {}) });
    const idle = () => page.waitForFunction(() => document.getElementById('jg-app').getAttribute('aria-busy') === 'false');
    const requests = [];
    page.on('request', request => { if (request.method() === 'POST') requests.push(new URL(request.url()).pathname); });

    await page.locator('[data-tab="roles"]').click();
    check('role_grid_uses_thumbnails', await page.locator('.jg-portrait img').evaluateAll(images => images.every(img => img.src.includes('/thumbnail?'))));
    if (!baseline) {
        requests.length = 0;
        await page.locator('[data-tab="chats"]').click(); await page.locator('.jg-chat-row').first().waitFor();
        await page.waitForTimeout(100);
        check('quick_list_return_reuses_recent_result', !requests.includes('/api/chats/recent'));
        await page.locator('[data-tab="roles"]').click();
    }
    requests.length = 0;
    const started = Date.now();
    await page.getByRole('button', { name: '与 会话验收甲 聊天', exact: true }).click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chat'); await idle();
    check('open_role_without_global_chat_scan', !requests.includes('/api/chats/recent'), { requests: [...requests], elapsedMs: Date.now() - started });

    // 真实原版“创建角色”状态会在同角色、switchMenu=false 的返回路径残留。
    await page.evaluate(async () => { const api = await import('/script.js'); api.setMenuType('create'); });
    const old = await page.evaluate(() => window.SillyTavern.getContext().chatId);
    await page.locator('#jg-header button[aria-label="聊天菜单"]').click();
    await page.getByRole('button', { name: '新开对话', exact: true }).click();
    await page.locator('dialog.popup[open] .popup-button-ok').click();
    await idle(); await page.waitForTimeout(350);
    const newId = await page.evaluate(() => window.SillyTavern.getContext().chatId);
    check('new_session_survives_stale_create_menu', newId !== old);
    const savedA = await post('/api/chats/get', { avatar_url: avatars[0], file_name: 'session-A' });
    check('new_session_preserves_A', savedA.some(message => message.mes === history[1].mes));
    if (!baseline) {
        await page.locator('#jg-header button[aria-label="聊天菜单"]').click();
        await page.getByRole('button', { name: '新开对话', exact: true }).click();
        await page.locator('dialog.popup[open] .popup-button-cancel').click(); await idle();
        check('cancel_new_session_keeps_current_identity', await page.evaluate(id => window.SillyTavern.getContext().chatId === id, newId));
        await page.route('**/api/chats/save', route => route.fulfill({ status: 500, json: { error: 'synthetic-save-failure' } }));
        await page.locator('#jg-header button[aria-label="聊天菜单"]').click();
        await page.getByRole('button', { name: '新开对话', exact: true }).click();
        await page.locator('dialog.popup[open] .popup-button-ok').click(); await idle();
        check('failed_save_aborts_new_session', await page.evaluate(id => window.SillyTavern.getContext().chatId === id && document.querySelector('#toast-container').textContent.includes('已取消新建'), newId));
        await page.unroute('**/api/chats/save');
    }
    // 在旧版新建失败时恢复标准菜单，继续独立验证删除路径。
    await page.evaluate(async () => { const api = await import('/script.js'); api.setMenuType('character_edit'); });

    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.locator('[data-tab="chats"]').click();
    const row = page.locator('.jg-chat-row[data-chat="session-B.jsonl"]').filter({ hasText: '会话验收乙' });
    await row.waitFor(); requests.length = 0;
    await row.click(); await page.waitForFunction(() => window.jiuguanMobile.view === 'chat'); await idle();
    check('open_target_session_reads_history_once', requests.filter(url => url === '/api/chats/get').length === 1, { requests: [...requests] });
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.locator('.jg-chat-row').first().waitFor();
    let delayed = false;
    await page.route('**/api/chats/delete', async route => {
        const response = await route.fetch();
        if (!delayed) { delayed = true; await page.waitForTimeout(1400); }
        await route.fulfill({ response });
    });
    const deleting = page.locator('.jg-chat-row[data-chat="session-B.jsonl"]').filter({ hasText: '会话验收乙' });
    await deleting.dispatchEvent('contextmenu');
    await page.getByRole('button', { name: '删除该聊天', exact: true }).click();
    await page.evaluate(async () => { const api = await import('/script.js'); api.saveChatDebounced(); });
    await page.locator('dialog.popup[open] .popup-button-ok').click();
    await idle();
    let chats = Object.values(await post('/api/characters/chats', { avatar_url: avatars[1] })).filter(x => x?.file_name);
    check('deleted_current_session_not_recreated_by_pending_save', !chats.some(x => x.file_name === 'session-B.jsonl'));
    check('delete_B_preserves_A', chats.some(x => x.file_name === 'session-A.jsonl'));
    await page.unroute('**/api/chats/delete');
    // 单独保留最后一段会话，删除后不应自动又创建一段空白聊天。
    for (const chat of chats.filter(x => x.file_name !== 'session-A.jsonl')) await post('/api/chats/delete', { avatar_url: avatars[1], chatfile: chat.file_name });
    await page.locator('[data-tab="roles"]').click();
    await page.getByRole('button', { name: '与 会话验收乙 聊天', exact: true }).click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chat'); await idle();
    await page.locator('#jg-header button[aria-label="返回"]').click(); await page.locator('[data-tab="chats"]').click();
    const last = page.locator('.jg-chat-row[data-chat="session-A.jsonl"]').filter({ hasText: '会话验收乙' });
    await last.waitFor(); await last.dispatchEvent('contextmenu');
    await page.getByRole('button', { name: '删除该聊天', exact: true }).click();
    await page.locator('dialog.popup[open] .popup-button-ok').click(); await idle();
    chats = Object.values(await post('/api/characters/chats', { avatar_url: avatars[1] })).filter(x => x?.file_name);
    check('delete_last_session_leaves_no_phantom_session', chats.length === 0);
    if (!baseline) {
        // 非当前会话删除被后端拒绝时，列表与原文件均保留，不能报告成功。
        const failed = page.locator('.jg-chat-row[data-chat="session-A.jsonl"]').filter({ hasText: '会话验收甲' });
        await failed.waitFor();
        await page.route('**/api/chats/delete', route => route.fulfill({ status: 500, json: { error: 'synthetic-delete-failure' } }));
        await failed.dispatchEvent('contextmenu'); await page.getByRole('button', { name: '删除该聊天', exact: true }).click();
        await page.locator('dialog.popup[open] .popup-button-ok').click(); await idle();
        check('failed_delete_preserves_session_and_reports_error', (await post('/api/chats/get', { avatar_url: avatars[0], file_name: 'session-A' })).some(message => message.mes === history[1].mes) && await page.locator('#toast-container').innerText().then(text => text.includes('删除没有成功')));
        await page.unroute('**/api/chats/delete');
        // 从角色菜单新开会话，不需要先删旧会话。
        await page.locator('[data-tab="roles"]').click();
        await page.getByRole('button', { name: '会话验收甲 的选项', exact: true }).click();
        await page.getByRole('button', { name: '新开对话', exact: true }).click();
        await page.locator('dialog.popup[open] .popup-button-ok').click(); await idle();
        check('role_menu_creates_additional_session', await page.evaluate(id => window.SillyTavern.getContext().chatId !== id, newId));
        await page.locator('#jg-header button[aria-label="返回"]').click(); await page.locator('[data-tab="chats"]').click();
        // 群聊采用同样的关闭后删除流程，失败不能损坏内存中的会话清单。
        const groupRow = page.locator('.jg-chat-row[data-chat="group-B.jsonl"]');
        await groupRow.waitFor(); await groupRow.click(); await page.waitForFunction(() => window.jiuguanMobile.view === 'chat'); await idle();
        await page.locator('#jg-header button[aria-label="返回"]').click();
        await groupRow.waitFor(); await groupRow.dispatchEvent('contextmenu');
        await page.getByRole('button', { name: '删除该聊天', exact: true }).click();
        await page.locator('dialog.popup[open] .popup-button-ok').click(); await idle();
        const persistedGroup = (await post('/api/groups/all', {})).find(item => item.id === group.id);
        check('delete_current_group_session_preserves_other_session', !persistedGroup.chats.includes('group-B') && persistedGroup.chats.includes('group-A'));
        const groupA = page.locator('.jg-chat-row[data-chat="group-A.jsonl"]');
        await groupA.waitFor();
        await page.route('**/api/chats/group/delete', route => route.fulfill({ status: 500, json: { error: 'synthetic-group-delete-failure' } }));
        await groupA.dispatchEvent('contextmenu'); await page.getByRole('button', { name: '删除该聊天', exact: true }).click();
        await page.locator('dialog.popup[open] .popup-button-ok').click(); await idle();
        check('failed_group_delete_restores_in_memory_session_list', await page.evaluate(id => window.SillyTavern.getContext().groups.find(group => group.id === id).chats.includes('group-A'), group.id));
        await page.unroute('**/api/chats/group/delete');
        const persistedA = await post('/api/chats/get', { avatar_url: avatars[0], file_name: 'session-A' });
        await page.screenshot({ path: path.join(out, 'after.png') });
        await page.reload();
        await page.waitForFunction(() => window.SillyTavern?.getContext);
        const afterReload = await post('/api/chats/get', { avatar_url: avatars[0], file_name: 'session-A' });
        check('A_survives_page_reload_unchanged', JSON.stringify(afterReload) === JSON.stringify(persistedA));
    }
    if (baseline) await page.screenshot({ path: path.join(out, 'before.png') });
    if (!baseline) for (const result of report.checks) assert.equal(result.passed, true, result.name);
    await verifySource(); report.passed = report.checks.every(x => x.passed);
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
    await browser?.close();
    if (child?.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    log.end();
    await writeFile(path.join(out, baseline ? 'before.json' : 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
