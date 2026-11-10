import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, sha256 } from './common.mjs';
import { checkMobilePerformance } from './mobile-performance-checks.mjs';

if (process.env.JIUGUAN_APP_PROBE !== '1' || !process.env.ANDROID_DEVICE_ID) throw new Error('需要开发包真机测试授权与设备序列号');
const adbPath = process.env.ADB_PATH || 'adb';
const args = ['-s', process.env.ANDROID_DEVICE_ID];
const adb = (...cmd) => execFileSync(adbPath, [...args, ...cmd], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
const pid = adb('shell', 'pidof', 'io.jiuguan.mobile.debug'); assert.match(pid, /^\d+$/);
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
const output = path.join(root, 'artifacts/upstream/extensions-app'); await mkdir(output, { recursive: true });
const report = { package: 'io.jiuguan.mobile.debug', apkSha256: sha256(await readFile(path.join(root, 'app/build/outputs/apk/debug/app-debug.apk'))), checks: [], paidApiCalls: 0, modelRequests: 0, injectedExtensions: false };
let browser, page;
const shot = async (name, blur = true) => { if (blur) await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(300); await writeFile(path.join(output, `${name}.png`), execFileSync(adbPath, [...args, 'exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })); };
try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts().flatMap(c => c.pages()).find(p => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url())); assert.ok(page);
    page.setDefaultTimeout(30000);
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats' && window.TavernHelper?.getVariables && window.EjsTemplate?.evalTemplate);
    report.checks.push('安装版自动加载酒馆助手、提示词模板和手机 UI，未注入扩展文件');
    await page.locator('[data-tab="settings"]').click(); await page.locator('[data-panel="extensions-settings-button"]').click();
    await page.locator('#tavern_helper').waitFor({ state: 'visible' });
    if (!await page.locator('#tavern_helper .inline-drawer-content').first().isVisible()) await page.locator('#tavern_helper .inline-drawer-toggle').first().click();
    await page.locator('#tavern_helper').scrollIntoViewIfNeeded(); await shot('helper-settings');
    if (!await page.locator('#pt_enabled').isVisible()) await page.locator('#prompt_template_settings .inline-drawer-toggle').first().click();
    await page.locator('#pt_enabled').scrollIntoViewIfNeeded(); assert.ok(await page.locator('#pt_enabled').isChecked()); await shot('template-settings');
    report.checks.push('设置 → 正则与扩展中两个扩展面板可见，模板总开关已开启');
    const name = '通用扩展验收：城市向导（安卓）';
    const html = '<body><section style="padding:16px;background:#edf2eb;color:#23312c;font:16px system-ui"><h3>普通交互测试</h3><button id="lab-button" style="padding:12px">点击检查</button><p id="lab-result">等待点击</p></section><script>document.getElementById("lab-button").onclick=function(){document.getElementById("lab-result").textContent="按钮已响应";};</script></body>';
    await page.evaluate(async ({ name, html }) => {
        const ctx = window.SillyTavern.getContext();
        if (!ctx.characters.some(c => c.name === name)) {
            const form = new FormData(); form.set('file_type', 'json');
            form.set('avatar', new Blob([JSON.stringify({ name, description: '普通的城市向导，仅用于扩展验收。', first_mes: '```html\n' + html + '\n```' })], { type: 'application/json' }), 'extensions-app-test.json');
            const headers = ctx.getRequestHeaders(); delete headers['Content-Type'];
            const response = await fetch('/api/characters/import', { method: 'POST', headers, body: form }); if (!response.ok) throw new Error('合成测试卡导入失败');
            await ctx.getCharacters();
        }
    }, { name, html });
    await page.locator('#jg-header button[aria-label="返回"]').click(); await page.locator('[data-tab="roles"]').click();
    await page.getByRole('button', { name: `与 ${name} 聊天`, exact: true }).click(); await page.waitForFunction(() => window.jiuguanMobile.view === 'chat');
    // 可重复验收：合成角色最近会话可能已是性能样例，不依赖第一条开场白仍在 DOM 中。
    await page.evaluate(async ({ name, html }) => {
        const ctx = window.SillyTavern.getContext();
        if (ctx.characters[ctx.characterId]?.name !== name) throw new Error('拒绝操作非合成角色');
        await window.TavernHelper.createChatMessages([{ role: 'assistant', message: '```html\n' + html + '\n```' }]);
    }, { name, html });
    const frame = page.frameLocator('iframe[id^="TH-message"]').last();
    await frame.locator('#lab-button').click(); assert.equal(await frame.locator('#lab-result').innerText(), '按钮已响应'); await shot('interaction');
    report.checks.push('真实 Android WebView 中合成 HTML 消息渲染为 iframe，按钮执行成功');
    const result = await page.evaluate(async () => {
        window.TavernHelper.replaceVariables({ lab_city: '杭州' }, { type: 'chat' });
        const value = await window.EjsTemplate.evalTemplate('城市：<%- getvar("lab_city") %>；计算：<%= 6 * 7 %>');
        await window.SillyTavern.getContext().saveChat(); return value;
    });
    assert.equal(result, '城市：杭州；计算：42'); report.checks.push('真机会话变量写入及 EJS 模板读取、计算通过');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats' && window.TavernHelper?.getVariables && window.EjsTemplate?.evalTemplate);
    await page.locator('[data-tab="roles"]').click();
    await page.getByRole('button', { name: `与 ${name} 聊天`, exact: true }).click(); await page.waitForFunction(() => window.jiuguanMobile.view === 'chat');
    assert.equal(await page.evaluate(() => window.TavernHelper.getVariables({ type: 'chat' }).lab_city), '杭州');
    report.checks.push('刷新后扩展仍加载，合成会话变量保留');
    if (process.env.JIUGUAN_PERFORMANCE_PROBE === '1') {
        report.performance = await checkMobilePerformance(page, { screenshot: shot });
        await page.evaluate(() => { document.activeElement?.blur(); });
        await page.waitForTimeout(500);
        const before = await page.evaluate(() => innerHeight);
        for (let cycle = 1; cycle <= 3; cycle++) {
            await page.locator('#send_textarea').click();
            await page.waitForFunction(height => innerHeight < height - 100, before);
            // 等待系统键盘动画结束，并保存整屏截图检查原生窗口是否平移。
            await page.waitForTimeout(1000);
            assert.ok(await page.evaluate(() => {
                const header = document.getElementById('jg-header').getBoundingClientRect();
                const input = document.getElementById('send_textarea').getBoundingClientRect();
                return header.top >= 0 && header.bottom <= innerHeight && input.top >= header.bottom && input.bottom <= innerHeight + 1;
            }));
            await shot(cycle === 3 ? 'fullscreen-keyboard' : `fullscreen-keyboard-${cycle}`, false);
            adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
            await page.waitForFunction(height => innerHeight >= height - 2, before);
            await page.waitForTimeout(1000);
            assert.ok(await page.evaluate(() => document.getElementById('jg-header').getBoundingClientRect().top >= 0));
        }
        await shot('fullscreen-chat');
        report.checks.push('全屏模式下连续三次弹出/关闭键盘，标题与输入框边界正常、页面高度恢复；保留整屏截图供视觉核验');
    }
    await page.locator('#jg-header button[aria-label="返回"]').click(); await page.locator('[data-tab="settings"]').click(); await page.locator('[data-panel="extensions-settings-button"]').click();
    await page.locator('#tavern_helper').scrollIntoViewIfNeeded();
    report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
    await browser?.close(); adb('forward', '--remove', `tcp:${port}`);
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
