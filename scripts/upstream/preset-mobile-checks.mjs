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
const preview = process.argv.includes('--preview');
const out = path.join(root, process.env.JIUGUAN_UI_REPORT_DIR || 'artifacts/upstream/preset-mobile');
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
    const shot = async (label, selector) => {
        if (selector) await page.locator(selector).first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${preview ? 'before-' : ''}${label}.png`) });
    };
    const measure = async (label, selector = '#left-nav-panel') => {
        const overflow = await page.locator(selector).evaluate(root => [...root.querySelectorAll('input, textarea, select, .menu_button, .prompt_manager_prompt_controls, .completion_prompt_manager_prompt_name')]
            .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.classList.contains('select2-hidden-accessible'))
            .map(el => ({ name: el.id || el.className, x: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }))
            .filter(el => el.x < -1 || el.right > innerWidth + 1));
        if (!preview) assert.deepEqual(overflow, [], `${label}：控件在屏幕范围内`);
        report.checks.push({ label, overflow });
    };
    await shot('top-390', '#settings_preset_openai');
    await shot('parameters-390', '#temp_openai');
    await shot('prompts-390', '#completion_prompt_manager_list');
    for (const width of [320, 360, 390, 430, 768]) {
        await page.setViewportSize({ width, height: 844 }); await measure(`聊天补全 ${width}px`);
        if (!preview) {
            const layout = await page.evaluate(() => {
                const select = document.getElementById('settings_preset_openai');
                const a = select.getBoundingClientRect(), b = document.getElementById('synthetic_preset_extension').getBoundingClientRect();
                return { fullWidth: a.width >= select.parentElement.clientWidth - 2, separateRow: b.top >= a.bottom, touchSize: b.width >= 44 && b.height >= 44 };
            });
            assert.deepEqual(layout, { fullWidth: true, separateRow: true, touchSize: true });
        }
        await shot(`top-${width}`, '#settings_preset_openai');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#completion_prompt_manager_list .prompt-manager-edit-action').first().click();
    const popup = page.locator('#completion_prompt_manager_popup'); await popup.waitFor({ state: 'visible' });
    await shot('editor-390', '#completion_prompt_manager_popup_entry_form_name');
    for (const width of [320, 390]) { await page.setViewportSize({ width, height: 844 }); await measure(`提示词编辑 ${width}px`, '#completion_prompt_manager_popup'); }
    if (preview) {
        report.diagnostics = await page.evaluate(() => ({
            ranges: [...document.querySelectorAll('#left-nav-panel input[type="range"]')].filter(e => e.getClientRects().length).slice(0, 4).map(e => ({ id: e.id, cls: e.className, parent: e.parentElement.outerHTML })),
            row: document.querySelector('#completion_prompt_manager_list .completion_prompt_manager_prompt')?.outerHTML,
        }));
    } else {
        await page.locator('#completion_prompt_manager_popup_entry_form_injection_position').selectOption('1');
        await page.locator('#completion_prompt_manager_popup_entry_form_injection_depth').waitFor({ state: 'visible' });
        await measure('插入深度与顺序 390px', '#completion_prompt_manager_popup');
        await shot('editor-depth-390', '#completion_prompt_manager_popup_entry_form_injection_depth');
        await page.locator('#completion_prompt_manager_popup_entry_form_injection_position').selectOption('0');
        await page.locator('#completion_prompt_manager_depth_block').waitFor({ state: 'hidden' });
        await page.setViewportSize({ width: 390, height: 844 });
        const name = page.locator('#completion_prompt_manager_popup_entry_form_name');
        const prompt = page.locator('#completion_prompt_manager_popup_entry_form_prompt');
        await name.fill('手机排版验收－完整显示的长提示词名称');
        await prompt.fill('仅用于隔离数据目录的合成提示词。');
        await page.setViewportSize({ width: 390, height: 420 });
        await page.waitForFunction(() => { const r = document.activeElement.getBoundingClientRect(); const footer = document.querySelector('.completion_prompt_manager_popup_entry_form_footer').getBoundingClientRect(); return r.top >= 48 && r.bottom <= Math.min(innerHeight, footer.top); });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#completion_prompt_manager_popup_entry_form_save').click();
        await popup.waitFor({ state: 'hidden' });
        assert.ok(await page.evaluate(async () => (await import('/scripts/openai.js')).oai_settings.prompts.some(p => p.name === '手机排版验收－完整显示的长提示词名称' && p.content === '仅用于隔离数据目录的合成提示词。')));
        report.checks.push('提示词编辑、保存与键盘缩小后的焦点可见');
        await shot('prompts-edited-390', '#completion_prompt_manager_list');
        await page.locator('#completion_prompt_manager_list .prompt-manager-edit-action').first().click();
        await popup.waitFor({ state: 'visible' }); await name.fill('此草稿应被取消');
        await page.locator('#jg-header button[aria-label="返回"]').click();
        await popup.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => window.jiuguanMobile.view), 'panel');
        assert.ok(await page.evaluate(async () => !(await import('/scripts/openai.js')).oai_settings.prompts.some(p => p.name === '此草稿应被取消')));
        report.checks.push('返回关闭提示词编辑窗口，取消草稿且仍停留在参数页');
        await page.locator('#temp_counter_openai').fill('0.75');
        await page.locator('#openai_max_tokens').fill('1024');
        const values = await page.evaluate(async () => { const s = (await import('/scripts/openai.js')).oai_settings; return { temperature: s.temp_openai, tokens: s.openai_max_tokens, slider: document.getElementById('temp_openai').value }; });
        assert.deepEqual(values, { temperature: 0.75, tokens: 1024, slider: '0.75' });
        report.checks.push('原版数值输入与滑块、生成设置同步');
        await page.locator('#new_oai_preset').click();
        await page.locator('dialog.popup[open] .popup-input').fill('手机参数合成验收');
        await page.locator('dialog.popup[open] .popup-button-ok').click();
        await page.waitForFunction(() => document.querySelector('#settings_preset_openai option:checked')?.textContent === '手机参数合成验收');
        await page.locator('#settings_preset_openai').selectOption({ label: 'Default' });
        await page.locator('#settings_preset_openai').selectOption({ label: '手机参数合成验收' });
        assert.equal(await page.locator('#temp_counter_openai').inputValue(), '0.75');
        assert.equal(await page.locator('#openai_max_tokens').inputValue(), '1024');
        report.checks.push('原版另存预设成功，切换后恢复保存的温度和回复长度');
        await page.evaluate(() => window.jQuery('#main_api').val('textgenerationwebui').trigger('change'));
        for (const width of [320, 390, 768]) { await page.setViewportSize({ width, height: 844 }); await measure(`文本补全 ${width}px`); }
        await shot('text-completion-768', '#settings_preset_textgenerationwebui');
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => window.jQuery('#enableZenSliders').prop('checked', true).trigger('input'));
        await page.locator('#temp_textgenerationwebui_zenslider').waitFor({ state: 'visible' });
        await measure('文本补全 Zen 滑块模式 390px');
        await shot('zen-sliders-390', '#temp_textgenerationwebui_zenslider');
        report.passed = true;
    }
} catch (error) { report.error = error.stack; process.exitCode = 1; await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
finally {
    await writeFile(path.join(out, preview ? 'before.json' : 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); await browser?.close(); child?.kill();
}
