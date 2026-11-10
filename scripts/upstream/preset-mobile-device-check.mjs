import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, sha256 } from './common.mjs';

if (process.env.JIUGUAN_APP_PROBE !== '1' || !process.env.ANDROID_DEVICE_ID) throw new Error('需要显式指定开发包真机测试和设备序列号');
const mode = process.argv[2];
assert.ok(['before', 'after'].includes(mode));
const out = path.join(root, process.env.JIUGUAN_DEVICE_REPORT_DIR || 'artifacts/upstream/preset-mobile'); await mkdir(out, { recursive: true });
const adbPath = process.env.ADB_PATH || 'adb';
const args = ['-s', process.env.ANDROID_DEVICE_ID];
const adb = (...cmd) => execFileSync(adbPath, [...args, ...cmd], { encoding: 'utf8', windowsHide: true }).trim();
const pid = adb('shell', 'pidof', 'io.jiuguan.mobile.debug'); assert.match(pid, /^\d+$/);
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
const report = { package: 'io.jiuguan.mobile.debug', version: JSON.parse(await readFile(path.join(root, 'app/build/outputs/apk/debug/output-metadata.json'), 'utf8')).elements[0].versionName, checks: [], injectedUI: false, paidApiCalls: 0 };
let browser, page;
async function snapshot() {
    const data = await page.evaluate(async () => {
        const api = await import('/script.js');
        if (api.isGenerating() || api.isChatSaving) throw new Error('手机正在生成或保存，不能重启');
        const { oai_settings: s } = await import('/scripts/openai.js');
        const wi = await import('/scripts/world-info.js');
        return {
            parameters: Object.fromEntries(['preset_settings_openai', 'temp_openai', 'top_p_openai', 'freq_pen_openai', 'pres_pen_openai', 'openai_max_tokens', 'openai_max_context', 'prompts', 'prompt_order'].map(key => [key, s[key]])),
            characters: window.SillyTavern.getContext().characters.map(c => c.avatar).sort(), worlds: [...wi.world_names].sort(),
        };
    });
    // 只保存散列，不把用户的预设、提示词或角色名称写入验收报告。
    return { hash: sha256(JSON.stringify(data)), characters: data.characters.length, worlds: data.worlds.length };
}
async function shot(name) {
    await page.evaluate(() => window.toastr.remove()); await page.waitForTimeout(250);
    await writeFile(path.join(out, `${name}.png`), execFileSync(adbPath, [...args, 'exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
}
try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts().flatMap(c => c.pages()).find(p => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()));
    assert.ok(page); page.setDefaultTimeout(20000);
    await page.waitForFunction(() => window.jiuguanMobile?.view);
    if (mode === 'before') {
        await writeFile(path.join(out, 'device-before.json'), JSON.stringify(await snapshot()));
        console.log('已记录参数、提示词和角色/世界书列表散列；没有进行中的生成或保存。');
    } else {
        const currentBaseline = process.argv.includes('--current-baseline');
        const expected = currentBaseline ? await snapshot() : JSON.parse(await readFile(path.join(out, 'device-before.json'), 'utf8'));
        if (currentBaseline) {
            await writeFile(path.join(out, 'device-current-baseline.json'), JSON.stringify(expected));
            report.checks.push('以当前手机数据为本次交互验收基准；不覆盖安装前基准，不回滚期间内容变动');
        } else {
            assert.deepEqual(await snapshot(), expected); report.checks.push('覆盖安装和冷启动后，参数/提示词/角色/世界书列表散列未变');
        }
        await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
        for (const file of ['style.css', 'index.js']) {
            const content = await page.evaluate(async file => (await fetch(document.querySelector('link[href*="jiuguan-mobile/style.css"]').href.replace('style.css', file))).text(), file);
            assert.equal(sha256(content), sha256(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile', file))));
        }
        report.checks.push('通过已安装扩展加载本版 CSS/JS，散列一致，未注入界面代码');
        await page.locator('[data-tab="settings"]').click(); await page.locator('[data-panel="ai-config-button"]').click();
        await page.locator('#settings_preset_openai').waitFor({ state: 'visible' });
        const overflow = await page.locator('#left-nav-panel').evaluate(root => [...root.querySelectorAll('input, select, .menu_button, .prompt_manager_prompt_controls')]
            .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.classList.contains('select2-hidden-accessible'))
            .filter(el => el.getBoundingClientRect().left < -1 || el.getBoundingClientRect().right > innerWidth + 1).length);
        assert.equal(overflow, 0); report.checks.push('真机预设、参数和提示词操作区没有横向溢出');
        await shot('device-parameters');
        await page.locator('#completion_prompt_manager_list .completion_prompt_manager_prompt').first().scrollIntoViewIfNeeded();
        await shot('device-prompts');
        const fullHeight = await page.evaluate(() => innerHeight);
        await page.locator('#completion_prompt_manager .completion_prompt_manager_footer > .menu_button').last().click();
        const popup = page.locator('#completion_prompt_manager_popup'); await popup.waitFor({ state: 'visible' });
        await page.locator('#completion_prompt_manager_popup_entry_form_name').fill('手机排版临时验收（不保存）');
        await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(400);
        if (await page.evaluate(() => innerHeight) < fullHeight - 100) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await page.waitForFunction(h => innerHeight >= h - 2, fullHeight);
        await shot('device-editor');
        const prompt = page.locator('#completion_prompt_manager_popup_entry_form_prompt');
        await prompt.click(); await page.waitForFunction(h => innerHeight < h - 100, fullHeight);
        await prompt.fill('仅用于键盘和返回操作验证，不保存到你的预设。');
        await page.waitForFunction(() => {
            const r = document.activeElement.getBoundingClientRect(); const footer = document.querySelector('.completion_prompt_manager_popup_entry_form_footer').getBoundingClientRect();
            return r.top >= 48 && r.bottom <= Math.min(innerHeight, footer.top);
        });
        await shot('device-keyboard'); report.checks.push('真实键盘弹出后提示词输入框可见，未被底部保存栏遮住');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await page.waitForFunction(h => innerHeight >= h - 2, fullHeight);
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); await popup.waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => window.jiuguanMobile.view), 'panel');
        assert.deepEqual(await snapshot(), expected);
        report.checks.push('系统返回依次收起键盘、取消编辑；原有预设和参数未改变');
        if (process.argv.includes('--compact-panels')) {
            const row = await page.locator('#temp_openai').evaluate(input => {
                const root = input.closest('.range-block');
                const label = root.querySelector('.range-block-title').getBoundingClientRect();
                const number = root.querySelector('input[type="number"]').getBoundingClientRect();
                return { height: Math.round(root.getBoundingClientRect().height), sameRow: Math.abs(label.top + label.height / 2 - number.top - number.height / 2) < 2 };
            });
            assert.ok(row.sameRow && row.height <= 60); report.compactParameterRow = row;
            for (const [panel, name] of [['WI-SP-button', 'world'], ['user-settings-button', 'settings'], ['extensions-settings-button', 'extensions']]) {
                await page.evaluate(() => window.jiuguanMobile.back());
                await page.locator('[data-tab="settings"]').click();
                await page.locator(panel === 'WI-SP-button' ? '[data-tab="worlds"]' : `[data-panel="${panel}"]`).click();
                await shot(`device-${name}`);
            }
            assert.deepEqual(await snapshot(), expected);
            report.checks.push('真机参数同行且行高不超过 60px；世界书、显示设置、扩展页已截图，浏览后基准未变');
        }
        report.passed = true;
    }
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
    if (page) {
        await page.evaluate(() => {
            document.activeElement?.blur();
            if (document.querySelector('#completion_prompt_manager_popup')?.getClientRects().length) document.getElementById('completion_prompt_manager_popup_entry_form_close')?.click();
        }).catch(() => {});
    }
    if (mode === 'after') { await writeFile(path.join(out, 'device-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
    await browser?.close(); adb('forward', '--remove', `tcp:${port}`);
}
