import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, sha256 } from './common.mjs';
import { measureInteraction } from './settings-interaction-metrics.mjs';

const mode = process.argv[2];
assert.ok(['before', 'after'].includes(mode));
assert.equal(process.env.JIUGUAN_APP_PROBE, '1');
assert.ok(process.env.ANDROID_DEVICE_ID);
const out = path.join(root, 'artifacts/upstream/settings-interactions');
await mkdir(out, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s', process.env.ANDROID_DEVICE_ID, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const pid = adb('shell', 'pidof', 'io.jiuguan.mobile.debug');
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
const report = { mode, measurements: {}, paidApiCalls: 0 };
let browser, page;
async function snapshot() {
    return sha256(JSON.stringify(await page.evaluate(async () => {
        const api = await import('/script.js');
        if (api.isGenerating() || api.isChatSaving) throw new Error('正在生成或保存');
        const { oai_settings: s } = await import('/scripts/openai.js');
        return Object.fromEntries(['preset_settings_openai', 'temp_openai', 'top_p_openai', 'freq_pen_openai', 'pres_pen_openai', 'openai_max_tokens', 'openai_max_context', 'prompts', 'prompt_order'].map(k => [k, s[k]]));
    })));
}
try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts().flatMap(c => c.pages()).find(p => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()));
    assert.ok(page); page.setDefaultTimeout(20000);
    await page.waitForFunction(() => window.jiuguanMobile?.view);
    assert.equal(await page.locator('dialog[open], #completion_prompt_manager_popup:visible, #chat .edit_textarea').count(), 0, '已有编辑或弹窗时停止，不取消用户草稿');
    report.dataHash = await snapshot();
    if (mode === 'after') {
        const previous = JSON.parse(await readFile(path.join(out, 'device-before.json')));
        report.comparableToBefore = previous.dataHash === report.dataHash;
        if (process.argv.includes('--current-baseline')) report.baselineNote = '用户确认期间切换或修改过预设；以当前数据验收，保留原始基准，不作同预设性能倍数比较';
        else assert.equal(report.dataHash, previous.dataHash);
    }
    await page.evaluate(() => { if (['panel','chat'].includes(window.jiuguanMobile.view)) window.jiuguanMobile.back(); });
    await page.locator('[data-tab="settings"]').click();
    await page.locator('[data-panel="ai-config-button"]').click();
    await page.locator('#completion_prompt_manager_list .prompt-manager-edit-action').first().waitFor();
    report.promptRows = await page.locator('#completion_prompt_manager_list .completion_prompt_manager_prompt').count();
    report.measurements.promptOpen = [];
    report.measurements.promptClose = [];
    for (let i = 0; i < 5; i++) {
        await page.locator('#completion_prompt_manager_list .prompt-manager-edit-action').first().scrollIntoViewIfNeeded();
        report.measurements.promptOpen.push(await measureInteraction(page, '#completion_prompt_manager_list .prompt-manager-edit-action', '#completion_prompt_manager_popup'));
        report.measurements.promptClose.push(await measureInteraction(page, '#completion_prompt_manager_popup_entry_form_close', '#completion_prompt_manager_popup'));
    }
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.locator('[data-panel="extensions-settings-button"]').click();
    const fold = '#extensions_settings .inline-drawer-toggle.inline-drawer-header';
    const content = '#extensions_settings .inline-drawer > .inline-drawer-content';
    report.measurements.extensionFold = [];
    for (let i = 0; i < 4; i++) report.measurements.extensionFold.push(await measureInteraction(page, fold, content));
    await page.locator('#jg-header button[aria-label="返回"]').click();
    assert.equal(await snapshot(), report.dataHash, '只打开和取消，参数/提示词不变');
    report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
    await writeFile(path.join(out, `device-${mode}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser?.close(); adb('forward', '--remove', `tcp:${port}`);
}
