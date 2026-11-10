import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, source, writeConfig, waitForServer, verifySource } from './common.mjs';

// 独立数据目录验证原版预设表单；不读取手机设置、不调用模型。
const baselinePath = process.argv[2];
const out = path.join(root, process.env.JIUGUAN_UI_REPORT_DIR || 'artifacts/upstream/compact-ui');
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
    const styleTag = await page.addStyleTag({ content: await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/style.css'), 'utf8') });
    await page.evaluate(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/index.js'), 'utf8'));
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
    await page.evaluate(() => window.jQuery('#main_api').val('openai').trigger('change'));
    await page.locator('[data-tab="settings"]').click(); await page.locator('[data-panel="ai-config-button"]').click();
    await page.locator('#completion_prompt_manager_list .completion_prompt_manager_prompt').first().waitFor();
    await page.evaluate(() => window.toastr.remove());
    // 模拟截图中的扩展入口，验证额外按钮不会再次挤窄预设选择器。
    await page.evaluate(() => {
        const select = document.getElementById('settings_preset_openai');
        const button = document.createElement('button');
        button.id = 'synthetic_preset_extension'; button.className = 'menu_button menu_button_icon'; button.textContent = 'S';
        select.nextElementSibling.prepend(button);
    });

    const currentCSS = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/style.css'), 'utf8');
    async function density(css) {
        await styleTag.evaluate((el, text) => { el.textContent = text; }, css);
        await page.waitForTimeout(100);
        return page.evaluate(() => {
            const bounds = selector => document.querySelector(selector).getBoundingClientRect();
            const row = document.querySelector('#temp_openai').closest('.range-block');
            const label = row.querySelector('.range-block-title').getBoundingClientRect();
            const number = bounds('#temp_counter_openai');
            return { parameterGroupHeight: Math.round(bounds('#range_block_openai').height), temperatureRowHeight: Math.round(row.getBoundingClientRect().height), promptListHeight: Math.round(bounds('#completion_prompt_manager_list').height), sameRow: Math.abs((label.top + label.height / 2) - (number.top + number.height / 2)) < 2 };
        });
    }
    if (baselinePath) report.before = await density(await readFile(baselinePath, 'utf8'));
    report.after = await density(currentCSS);
    assert.ok(report.after.sameRow, '参数名称、滑块和数值同行');
    assert.ok(report.after.temperatureRowHeight <= 60, '标准参数行紧凑且可点按');
    if (report.before) {
        assert.ok(report.after.parameterGroupHeight < report.before.parameterGroupHeight * .8, '参数组至少减少 20% 高度');
        assert.ok(report.after.promptListHeight < report.before.promptListHeight * .8, '同一提示词列表至少减少 20% 高度');
    }
    async function measure(selector, label) {
        const overflow = await page.locator(selector).evaluate(root => [...root.querySelectorAll('input:not([type="hidden"]), select, textarea, .menu_button')]
            .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.classList.contains('select2-hidden-accessible'))
            .filter(el => el.getBoundingClientRect().left < -1 || el.getBoundingClientRect().right > innerWidth + 1).map(el => el.id || el.className));
        assert.deepEqual(overflow, [], label);
        report.checks.push({ label, overflow });
    }
    await page.locator('#settings_preset_openai').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'parameters-390.png') });
    await page.locator('#completion_prompt_manager_list li').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'prompts-390.png') });
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.locator('[data-panel="user-settings-button"]').click();
    for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await measure('#user-settings-block', '普通显示设置 ' + width + 'px');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'settings-390.png') });
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.locator('[data-panel="extensions-settings-button"]').click();
    // 与页面 ID 无关的扩展夹具：只采用上游公共类，验证样式可全局复用。
    await page.evaluate(() => {
        const sample = document.createElement('section'); sample.id = 'compact_extension_fixture';
        sample.innerHTML = '<div class="inline-drawer"><div class="inline-drawer-header">扩展通用表单</div><div class="range-block"><div class="range-block-title">采样强度</div><div class="range-block-range-and-counter"><div class="range-block-range"><input type="range" value="50"></div><div class="range-block-counter"><input type="number" value="50"></div></div></div><label class="checkbox_label"><input type="checkbox"><span>启用功能</span></label></div>';
        document.getElementById('extensions_settings').prepend(sample);
        const protectedMessage = document.createElement('div'); protectedMessage.id = 'compact_message_fixture'; protectedMessage.className = 'range-block'; protectedMessage.style.cssText = 'display:flex;height:31px;padding:0';
        protectedMessage.innerHTML = '<div class="range-block-title">角色内容</div><div class="wide100p"><input type="number" style="height:23px;min-height:0"></div>';
        document.getElementById('chat').append(protectedMessage);
    });
    for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await measure('#compact_extension_fixture', '扩展公共组件 ' + width + 'px');
        const layout = await page.locator('#compact_extension_fixture').evaluate(root => {
            const label = root.querySelector('.range-block-title').getBoundingClientRect();
            const input = root.querySelector('input[type="number"]').getBoundingClientRect();
            return { sameRow: Math.abs((label.top + label.height / 2) - (input.top + input.height / 2)) < 2, touchHeight: input.height >= 44 };
        });
        assert.deepEqual(layout, { sameRow: true, touchHeight: true });
    }
    assert.equal(await page.locator('#compact_message_fixture').evaluate(el => getComputedStyle(el).display), 'flex', '全局表单规则不影响角色消息');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#compact_extension_fixture').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'extensions-390.png') });
    report.checks.push('公共组件在扩展页同样紧凑，角色消息不受全局布局影响');
    report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
finally {
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); await browser?.close(); child?.kill();
}
