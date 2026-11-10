import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, source, writeConfig, waitForServer, verifySource } from './common.mjs';

// Only synthetic cards in an isolated upstream data directory; no phone or model API access.
const out = path.join(root, process.env.JIUGUAN_UI_REPORT_DIR || 'artifacts/upstream/world-info-scope');
await mkdir(out, { recursive: true });
await mkdir(path.join(root, '.tools/mobile-ui-regression'), { recursive: true });
const sandbox = await mkdtemp(path.join(root, '.tools/mobile-ui-regression/scope-'));
const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
const report = { source: await verifySource(), checks: [], paidApiCalls: 0 };
let child, browser, page;
const log = createWriteStream(path.join(sandbox, 'server.log'));
try {
    const config = await writeConfig(sandbox, { port });
    child = spawn(process.execPath, ['server.js', '--configPath', config], { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    await waitForServer(`http://127.0.0.1:${port}`, child);
    browser = await chromium.launch({ headless: true, executablePath: process.env.JIUGUAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', locale: 'zh-CN' });
    page.setDefaultTimeout(20000);
    await page.addInitScript(() => localStorage.setItem('language', 'zh-cn'));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => window.SillyTavern?.getContext);
    await page.evaluate(async () => {
        const api = await import('/script.js');
        api.eventSource.on(api.event_types.APP_READY, () => { window.__scopeReady = true; });
    });
    const deadline = Date.now() + 30000;
    while (!await page.evaluate(() => window.__scopeReady)) {
        const onboarding = page.locator('dialog.popup[open]:has(.onboarding)');
        if (await onboarding.isVisible()) { await onboarding.locator('.popup-input').fill('作用域验收'); await onboarding.locator('.popup-button-ok').click(); }
        if (Date.now() > deadline) throw new Error('原版初始化超时');
        await page.waitForTimeout(200);
    }
    for (const file of ['connection-guard.js', 'chat-display.js']) {
        const body = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile', file), 'utf8');
        await page.route(`**/scripts/extensions/third-party/jiuguan-mobile/${file}`, route => route.fulfill({ contentType: 'text/javascript', body }));
    }
    await page.addStyleTag({ content: await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/style.css'), 'utf8') });
    await page.evaluate(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/index.js'), 'utf8'));
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
    assert.deepEqual(await page.locator('#jg-nav .jg-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.tab)), ['chats', 'roles', 'worlds', 'settings']);
    await page.evaluate(() => { window.__originalWorldEditor = document.getElementById('world_popup'); });
    for (const target of ['roles', 'chats', 'settings']) {
        await page.locator('[data-tab="worlds"]').click();
        await page.waitForFunction(() => window.jiuguanMobile.view === 'worlds' && document.getElementById('WorldInfo').classList.contains('openDrawer'));
        assert.equal(await page.locator('#jg-header h1').innerText(), '世界书');
        assert.equal(await page.locator('[data-tab="worlds"]').getAttribute('aria-current'), 'page');
        await page.locator('[data-tab="worlds"]').click();
        await page.locator('[data-tab="' + target + '"]').click();
        await page.waitForFunction(target => window.jiuguanMobile.view === target && !document.getElementById('WorldInfo').classList.contains('openDrawer'), target);
    }
    assert.equal(await page.locator('[data-panel="WI-SP-button"]').count(), 0, '设置不重复显示世界书入口');
    await page.evaluate(() => {
        document.querySelector('[data-tab="worlds"]').click();
        document.querySelector('[data-tab="roles"]').click();
        document.querySelector('[data-tab="worlds"]').click();
    });
    await page.waitForFunction(() => window.jiuguanMobile.view === 'worlds' && document.getElementById('WorldInfo').classList.contains('openDrawer'));
    await page.evaluate(() => window.jiuguanMobile.back());
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chats' && !document.getElementById('WorldInfo').classList.contains('openDrawer'));
    assert.equal(await page.evaluate(() => window.__originalWorldEditor === document.getElementById('world_popup')), true);
    report.checks.push('底部导航顺序为聊天/角色/世界书/设置；世界书为一级页，重复点击/快速切换/返回正确，复用原版编辑器');
    await page.evaluate(async () => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.world_import_dialog = false;
    });
    const snapshot = () => page.evaluate(async () => {
        const wi = await import('/scripts/world-info.js');
        const api = await import('/script.js');
        const entries = await wi.getSortedEntries();
        return { available: [...wi.world_names], global: [...wi.selected_world_info],
            selected: [...document.querySelector('#world_info').selectedOptions].map(o => o.textContent),
            options: [...document.querySelector('#world_info').options].filter(o => o.value !== '').map(o => ({ name: o.textContent, selected: o.selected })),
            linked: api.characters[window.SillyTavern.getContext().characterId]?.data?.extensions?.world,
            loaded: [...new Set(entries.map(e => e.world))].sort() };
    });
    const baseline = await snapshot();
    assert.deepEqual(baseline.global, []);
    const home = async () => {
        for (let i = 0; i < 5 && !await page.locator('[data-tab="roles"]').isVisible(); i++) {
            await page.evaluate(() => window.jiuguanMobile.back());
            await page.waitForTimeout(150);
        }
    };
    for (const label of ['甲', '乙']) {
        const name = `作用域测试角色${label}`, book = `作用域测试世界书${label}`;
        await page.locator('[data-tab="roles"]').click();
        const chooserEvent = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: '导入角色卡', exact: true }).click();
        const chooser = await chooserEvent;
        await chooser.setFiles({ name: `scope-${label}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
            spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '隔离测试', first_mes: '你好。',
                personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
                alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
                character_book: { name: book, entries: [{ id: 0, keys: [], content: `仅属于角色${label}的合成内容`, enabled: true,
                    insertion_order: 100, constant: true, position: 'before_char', extensions: {} }] } } })) });
        await page.locator('.jg-role-open').filter({ hasText: name }).click();
        await page.waitForFunction(name => window.SillyTavern.getContext().characters[window.SillyTavern.getContext().characterId]?.name === name, name);
        await page.waitForFunction(() => window.jQuery('#import_character_info').data('chid') === window.SillyTavern.getContext().characterId);
        await page.evaluate(async () => {
            const wi = await import('/scripts/world-info.js'); const api = await import('/script.js');
            // Same import + save sequence as upstream's "Import Card Lore" menu.
            await wi.importEmbeddedWorldInfo(true); api.saveCharacterDebounced();
        });
        await page.waitForFunction(book => window.SillyTavern.getContext().characters[window.SillyTavern.getContext().characterId]?.data?.extensions?.world === book, book);
        const state = await snapshot();
        assert.deepEqual(state.global, [], '导入内嵌世界书不应启用全局');
        assert.equal(state.linked, book);
        assert.deepEqual(state.loaded, [book], '只加载当前角色世界书');
        assert.ok(state.options.some(o => o.name === book && !o.selected));
        report.checks.push({ imported: label, ...state });
        await page.waitForTimeout(1200);
        await home();
    }
    await page.locator('[data-tab="worlds"]').click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'worlds');
    report.mobileSelector = await page.locator('#world_info').evaluate(el => ({ multiple: el.multiple,
        select2: el.classList.contains('select2-hidden-accessible'), options: el.options.length,
        selectedCount: [...el.selectedOptions].filter(o => o.value !== '').length }));
    assert.equal(report.mobileSelector.select2, false, '实际手机 UA 使用原生多选列表');
    assert.equal(await page.locator('#world_info').isVisible(), false);
    assert.equal(await page.locator('#jg-world-count').innerText(), '全局已启用 0 本');
    assert.equal(await page.locator('#jg-world-active').isVisible(), false);
    const summaryButton = await page.locator('.jg-world-summary button').boundingBox();
    assert.ok(summaryButton.width > 150 && summaryButton.height <= 60, '全局选择按钮横排且不过高');
    const worldBounds = await page.locator('#WorldInfo').boundingBox(), navBounds = await page.locator('#jg-nav').boundingBox();
    assert.ok(worldBounds.y + worldBounds.height <= navBounds.y + 1, '编辑器底部不被导航遮挡');
    await page.evaluate(() => window.toastr.remove());
    assert.equal(await page.locator('#world_popup').isVisible(), false);
    assert.equal(await page.locator('#jg-world-list [data-world]').count(), (await snapshot()).available.length);
    await page.getByPlaceholder('搜索世界书', { exact: true }).fill('世界书甲');
    assert.equal(await page.locator('#jg-world-list [data-world]').count(), 1);
    await page.locator('#jg-world-list [data-world]').click();
    await page.locator('#world_popup_entries_list .world_entry').first().waitFor();
    assert.equal(await page.locator('#wiTopBlock').isVisible(), false);
    assert.equal(await page.locator('#jg-header h1').innerText(), '作用域测试世界书甲');
    assert.deepEqual((await snapshot()).global, []);
    await page.getByRole('button', { name: '返回世界书列表', exact: true }).click();
    assert.equal(await page.locator('#jg-world-library').isVisible(), true);
    await page.getByPlaceholder('搜索世界书', { exact: true }).fill('');
    await page.locator('#jg-world-list [data-world]').first().click();
    await page.evaluate(() => window.jiuguanMobile.back());
    assert.equal(await page.locator('#jg-world-library').isVisible(), true);
    report.checks.push('所有书列于全局区下方；搜索、点击编辑、标题返回、系统返回均保留全局选择');
    const activation = page.locator('.jg-world-activation .inline-drawer-toggle');
    assert.equal(await activation.getAttribute('aria-expanded'), 'false');
    await activation.click();
    assert.equal(await activation.getAttribute('aria-expanded'), 'true');
    for (const width of [320, 360, 390, 430, 768]) {
        await page.setViewportSize({ width, height: 844 });
        const layout = await page.locator('#wiActivationSettings').evaluate(el => {
            const bounds = el.getBoundingClientRect();
            return { width: bounds.width, parent: document.querySelector('#wiTopBlock').getBoundingClientRect().width,
                overflow: [...el.querySelectorAll('input, select, label')].filter(e => e.getClientRects().length)
                    .some(e => e.getBoundingClientRect().left < 0 || e.getBoundingClientRect().right > innerWidth + 1) };
        });
        assert.ok(layout.width >= layout.parent - 24 && !layout.overflow, `${width}px 激活设置占满宽度且不溢出: ${JSON.stringify(layout)}`);
        await page.screenshot({ path: path.join(out, `activation-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#world_info_depth_counter').fill('5');
    await page.locator('#world_info_depth_counter').press('Tab');
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#world_info_depth').inputValue(), '5');
    const savedDepth = await page.evaluate(async () => {
        const response = await fetch('/api/settings/get', { method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders(), body: '{}' });
        return JSON.parse((await response.json()).settings).world_info_settings.world_info_depth;
    });
    assert.equal(savedDepth, 5);
    await activation.click();
    assert.equal(await activation.getAttribute('aria-expanded'), 'false');
    report.checks.push('激活设置单击展开/收起，320/360/390/430/768px 全宽无溢出；修改数值同步滑块并保存');
    // 新建、重命名、删除仍交由原版；观察列表自动同步。
    await page.getByRole('button', { name: '新建世界书', exact: true }).click();
    await page.locator('dialog.popup[open] .popup-input').fill('列表增删验收');
    await page.locator('dialog.popup[open] .popup-button-ok').click();
    await page.waitForFunction(() => document.querySelector('#jg-header h1').textContent === '列表增删验收');
    await page.locator('#world_popup_name_button').click();
    await page.locator('dialog.popup[open] .popup-input').fill('列表改名验收');
    await page.locator('dialog.popup[open] .popup-button-ok').click();
    await page.waitForFunction(() => document.querySelector('#jg-header h1').textContent === '列表改名验收');
    await page.getByRole('button', { name: '返回世界书列表', exact: true }).click();
    assert.equal(await page.locator('#jg-world-list [data-world="列表增删验收"]').count(), 0);
    await page.locator('#jg-world-list [data-world="列表改名验收"]').click();
    await page.locator('#world_popup_delete').click();
    await page.locator('dialog.popup[open] .popup-button-ok').click();
    await page.waitForFunction(() => document.body.dataset.jgWorldMode === 'list');
    assert.equal(await page.locator('#jg-world-list [data-world="列表改名验收"]').count(), 0);
    assert.deepEqual((await snapshot()).global, []);
    report.checks.push('新建后自动进入编辑，重命名同步标题和列表，删除后返回书库');
    await page.screenshot({ path: path.join(out, 'mobile-global-list.png') });
    await page.getByRole('button', { name: '选择全局世界书', exact: true }).click();
    const choice = name => page.locator('.jg-world-choice').filter({ hasText: name }).locator('input');
    assert.equal(await choice('作用域测试世界书乙').isChecked(), false);
    for (const width of [320, 360, 390, 430, 768]) {
        await page.setViewportSize({ width, height: 844 });
        const overflow = await page.locator('.jg-world-picker').evaluate(el => [...el.querySelectorAll('input, label, button')]
            .filter(e => e.getClientRects().length).some(e => e.getBoundingClientRect().left < 0 || e.getBoundingClientRect().right > innerWidth + 1));
        assert.equal(overflow, false, `${width}px 全局世界书面板不溢出`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await choice('作用域测试世界书乙').check();
    assert.deepEqual((await snapshot()).global, ['作用域测试世界书乙']);
    assert.equal(await page.locator('#jg-world-count').innerText(), '全局已启用 1 本');
    assert.equal(await page.locator('#jg-world-active').innerText(), '作用域测试世界书乙');
    await page.screenshot({ path: path.join(out, 'mobile-global-picker.png') });
    await page.getByPlaceholder('搜索可选世界书').fill('世界书甲');
    assert.equal(await page.locator('.jg-world-choice:visible').count(), 1);
    await choice('作用域测试世界书甲').check();
    await page.getByPlaceholder('搜索可选世界书').fill('');
    assert.equal(await choice('作用域测试世界书乙').isChecked(), true);
    await choice('作用域测试世界书乙').uncheck();
    await choice('作用域测试世界书甲').uncheck();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    assert.deepEqual((await snapshot()).global, []);
    report.checks.push('主面板只显示全局实际启用数量/名称；候选面板勾选、取消、搜索、多选及 320–768px 布局通过');
    await home();
    await page.locator('[data-tab="roles"]').click();
    await page.locator('.jg-role-open').filter({ hasText: '作用域测试角色甲' }).click();
    const switched = await snapshot();
    assert.deepEqual(switched.global, []);
    assert.deepEqual(switched.loaded, ['作用域测试世界书甲']);
    report.checks.push({ switchBack: switched });
    // A deliberate global selection should be additive and reversible, through upstream's handler.
    await page.evaluate(async () => {
        const wi = await import('/scripts/world-info.js');
        window.jQuery('#world_info').val([String(wi.world_names.indexOf('作用域测试世界书乙'))]).trigger('change');
    });
    const enabled = await snapshot();
    assert.deepEqual(enabled.global, ['作用域测试世界书乙']);
    assert.deepEqual(enabled.loaded, ['作用域测试世界书乙', '作用域测试世界书甲'].sort());
    await page.evaluate(() => window.jQuery('#world_info').val([]).trigger('change'));
    assert.deepEqual((await snapshot()).loaded, ['作用域测试世界书甲']);
    report.checks.push('只有显式全局选中后才跨角色加载；取消后恢复角色范围');
    await verifySource(); report.passed = true;
} catch (error) {
    report.passed = false; report.error = error.stack; process.exitCode = 1;
    if (page) report.diagnostic = await page.evaluate(() => {
        const ctx = window.SillyTavern?.getContext();
        return { current: ctx?.characterId, card: ctx?.characters[ctx.characterId]?.data,
            importChid: window.jQuery('#import_character_info').data('chid'), world: window.jQuery('#character_world').val() };
    });
} finally {
    await browser?.close();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    log.end();
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
