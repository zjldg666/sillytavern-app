import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { measureInteraction } from './settings-interaction-metrics.mjs';
import { root, source, writeConfig, waitForServer, verifySource } from './common.mjs';

// 独立数据目录验证原版预设表单；不读取手机设置、不调用模型。

const out = path.join(root, 'artifacts/upstream/settings-interactions/desktop');
await mkdir(out, { recursive: true });
await mkdir(path.join(root, '.tools/mobile-ui-regression'), { recursive: true });
const sandbox = await mkdtemp(path.join(root, '.tools/mobile-ui-regression/preset-'));
const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
const report = { source: await verifySource(), checks: [], paidApiCalls: 0 };
let child, browser, page;
try {
    const config = await writeConfig(sandbox, { port });
    const log = createWriteStream(path.join(sandbox, 'server.log'));
    child = spawn(process.execPath, ['server.js', '--configPath', config], { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log); child.stderr.pipe(log);
    await waitForServer(`http://127.0.0.1:${port}`, child);
    browser = await chromium.launch({ headless: true, executablePath: process.env.JIUGUAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    page.setDefaultTimeout(20000);
    await page.addInitScript(() => localStorage.setItem('language', 'zh-cn'));
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => window.SillyTavern?.getContext);
    await page.evaluate(async () => { const api = await import('/script.js'); window.__presetReady = false; api.eventSource.on(api.event_types.APP_READY, () => { window.__presetReady = true; }); });
    const deadline = Date.now() + 30000;
    while (!await page.evaluate(() => window.__presetReady)) {
        const onboarding = page.locator('dialog.popup[open]:has(.onboarding)');
        if (await onboarding.isVisible()) { await onboarding.locator('.popup-input').fill('合成验收'); await onboarding.locator('.popup-button-ok').click(); }
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
    await page.locator('[data-tab="settings"]').click();
    const tools = await page.evaluate(() => ({
        drawers: [...document.querySelectorAll('#top-settings-holder > .drawer')].map(e => e.id).filter(id => id !== 'WI-SP-button').sort(),
        links: [...document.querySelectorAll('.jg-setting-row[data-panel]')].map(e => e.dataset.panel).sort(),
        obsolete: document.getElementById('jg-content').textContent.includes('切换到原版界面') || [...document.querySelectorAll('#jg-content button')].some(e => e.textContent === '全部工具'),
    }));
    assert.deepEqual(tools.links, tools.drawers);
    assert.equal(tools.obsolete, false);
    report.checks.push('世界书独立于底部导航，其余顶部工具直接出现在设置页，入口无重复');
    await page.evaluate(() => {
        const drawer = document.createElement('div'); drawer.id = 'synthetic-added-tool'; drawer.className = 'drawer';
        drawer.innerHTML = '<div class="drawer-toggle"><i class="drawer-icon closedIcon" title="新增测试工具"></i></div><div class="drawer-content closedDrawer">仅用于隔离验收</div>';
        document.getElementById('top-settings-holder').append(drawer);
    });
    await page.locator('[data-panel="synthetic-added-tool"]').click();
    await page.locator('#synthetic-added-tool > .openDrawer').waitFor();
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.evaluate(() => document.getElementById('synthetic-added-tool').remove());
    await page.locator('[data-panel="synthetic-added-tool"]').waitFor({ state: 'detached' });
    report.checks.push('扩展动态增加/移除工具时，设置页直接同步入口并能打开');
    await page.evaluate(() => window.toastr.remove());
    await page.screenshot({ path: path.join(out, 'settings.png') });

    await page.locator('[data-panel="sys-settings-button"]').click();
    await page.locator('#connection_profiles').waitFor();
    await page.evaluate(() => {
        const select = document.getElementById('connection_profiles');
        select.append(new Option('测试连接方案 · 完整名称', '__layout_only__', true, true));
    });
    for (const width of [320, 360, 390, 430, 768]) {
        await page.setViewportSize({ width, height: 844 });
        const layout = await page.locator('#connection_profiles').evaluate(select => {
            const r = select.getBoundingClientRect();
            const buttons = [...select.parentElement.querySelectorAll('.menu_button')].map(b => b.getBoundingClientRect());
            return { fullWidth: r.width >= select.parentElement.clientWidth - 2, below: buttons.every(b => b.top >= r.bottom), overflow: buttons.some(b => b.right > innerWidth || b.left < 0) };
        });
        assert.deepEqual(layout, { fullWidth: true, below: true, overflow: false });
        report.checks.push(`连接方案名称整行、6 个操作可达且无溢出：${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'connection-profile.png') });
    await page.locator('#jg-header button[aria-label="返回"]').click();

    report.panels = [];
    for (const id of tools.drawers) {
        await page.locator(`[data-panel="${id}"]`).click();
        await page.locator(`#${id} > .openDrawer`).waitFor();
        const fold = page.locator(`#${id} > .openDrawer .inline-drawer-toggle`).filter({ visible: true }).first();
        if (await fold.count()) {
            await fold.evaluate(el => el.dataset.jgTestFold = 'true');
            const body = await fold.evaluate(el => {
                const content = el.closest('.inline-drawer')?.querySelector(':scope > .inline-drawer-content');
                if (content) content.dataset.jgTestFoldBody = 'true';
                return !!content;
            });
            if (body) {
                const open = await measureInteraction(page, '[data-jg-test-fold]', '[data-jg-test-fold-body]');
                const close = await measureInteraction(page, '[data-jg-test-fold]', '[data-jg-test-fold-body]');
                report.panels.push({ id, open, close });
                await page.evaluate(() => document.querySelectorAll('[data-jg-test-fold], [data-jg-test-fold-body]').forEach(e => { delete e.dataset.jgTestFold; delete e.dataset.jgTestFoldBody; }));
            }
        }
        await page.locator('#jg-header button[aria-label="返回"]').click();
    }
    report.checks.push('8 个原版设置面板均可打开/返回，并测量其中可见的折叠控件');

    await page.evaluate(() => window.jQuery('#main_api').val('openai').trigger('change'));
    await page.locator('[data-panel="ai-config-button"]').click();
    await page.locator('#completion_prompt_manager_list .prompt-manager-edit-action').first().waitFor();
    report.promptOpen = await measureInteraction(page, '#completion_prompt_manager_list .prompt-manager-edit-action', '#completion_prompt_manager_popup');
    await page.locator('#completion_prompt_manager_popup').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(out, 'prompt-editor.png') });
    report.promptClose = await measureInteraction(page, '#completion_prompt_manager_popup_entry_form_close', '#completion_prompt_manager_popup');
    await page.locator('#completion_prompt_manager_popup').waitFor({ state: 'hidden' });
    assert.ok(report.promptOpen.settledMs < 200 && report.promptClose.settledMs < 200, '消除编辑窗口的连续 200ms + 250ms 动画');

    // 原版动画扩展点不能破坏回调、队列或最终显示状态，也不能影响聊天内容动画。
    const behavior = await page.evaluate(async () => {
        const sample = document.createElement('div'); sample.style.cssText = 'display:none;height:24px';
        document.querySelector('#left-nav-panel').append(sample);
        let callbacks = 0;
        window.jQuery(sample).slideDown(400, () => callbacks++).slideUp(400, () => callbacks++).slideDown(400, () => callbacks++);
        await window.jQuery(sample).promise();
        const result = { callbacks, visible: getComputedStyle(sample).display !== 'none', emptyQueue: window.jQuery(sample).queue().length === 0 };
        sample.remove();
        const durations = [];
        window.jQuery.Animation.prefilter(function(element) { if (element.dataset.jgMotionProbe) durations.push(this.duration); });
        const protectedNode = document.createElement('div'); protectedNode.dataset.jgMotionProbe = '1'; protectedNode.style.display = 'none'; document.querySelector('#chat').append(protectedNode);
        window.jQuery(protectedNode).slideDown(180); await window.jQuery(protectedNode).promise(); protectedNode.remove();
        result.chatDuration = durations[0];
        return result;
    });
    assert.deepEqual(behavior, { callbacks: 3, visible: true, emptyQueue: true, chatDuration: 180 });
    report.checks.push('快速连续展开/收起最终状态、动画队列及每次完成回调正确；聊天正文动画时长保持原值');
    await page.evaluate(() => { void window.SillyTavern.getContext().Popup.show.confirm('交互验收', '确认与取消只用于隔离测试。'); });
    await page.locator('dialog.popup[open]').waitFor();
    await page.locator('dialog.popup[open] .popup-button-cancel').click();
    await page.locator('dialog.popup[open]').waitFor({ state: 'hidden' });
    report.checks.push('原版确认弹窗的打开、取消与关闭正常');
    report.passed = true;
} catch (error) {
    report.error = error.stack; process.exitCode = 1;
    await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser?.close(); child?.kill();
}
