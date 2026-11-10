import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, source, writeConfig, waitForServer, session, verifySource } from './common.mjs';

// 隔离数据 + 合成世界书；通过原版表单和保存接口验证，不读取手机中的世界书或模型配置。
const out = path.join(root, process.env.JIUGUAN_UI_REPORT_DIR || 'artifacts/upstream/world-info-mobile');
await mkdir(out, { recursive: true });
await mkdir(path.join(root, '.tools/mobile-ui-regression'), { recursive: true });
const sandbox = await mkdtemp(path.join(root, '.tools/mobile-ui-regression/world-'));
const reserved = createServer(); reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
const base = `http://127.0.0.1:${port}`;
const report = { source: await verifySource(), checks: [], paidApiCalls: 0 };
const name = '手机排版验收（合成）';
let child, browser, page;
try {
    const config = await writeConfig(sandbox, { port });
    const log = createWriteStream(path.join(sandbox, 'server.log'));
    child = spawn(process.execPath, ['server.js', '--configPath', config], { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log); child.stderr.pipe(log);
    await waitForServer(base, child);
    const post = await session(base);
    browser = await chromium.launch({ headless: true, executablePath: process.env.JIUGUAN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN' });
    await page.addInitScript(() => localStorage.setItem('language', 'zh-cn'));
    page.setDefaultTimeout(20000);
    await page.goto(base);
    await page.waitForFunction(() => window.SillyTavern?.getContext);
    await page.evaluate(async () => {
        const api = await import('/script.js'); window.__worldReady = false;
        api.eventSource.on(api.event_types.APP_READY, () => { window.__worldReady = true; });
    });
    const deadline = Date.now() + 30000;
    while (!await page.evaluate(() => window.__worldReady)) {
        const onboarding = page.locator('dialog.popup[open]:has(.onboarding)');
        if (await onboarding.isVisible()) { await onboarding.locator('.popup-input').fill('合成验收'); await onboarding.locator('.popup-button-ok').click(); }
        if (Date.now() > deadline) throw new Error('原版初始化超时');
        await page.waitForTimeout(200);
    }
    await page.evaluate(async name => {
        const wi = await import('/scripts/world-info.js');
        const data = { entries: {} };
        for (let uid = 0; uid < 30; uid++) {
            data.entries[uid] = { ...structuredClone(wi.newWorldInfoEntryTemplate), uid, displayIndex: uid,
                comment: uid === 0 ? '可选模块开始' : uid === 1 ? '选开－校园与论坛：一条很长的世界书标题用于检查自动换行' : `测试条目 ${uid}`,
                key: [`测试关键词${uid}`], content: '这是一段合成世界书内容，只用于检查手机编辑与保存。',
                position: 4, depth: 1, order: 168 - uid, probability: 100, constant: true, disable: uid === 1 };
        }
        await wi.saveWorldInfo(name, data, true); await wi.updateWorldInfoList();
    }, name);
    for (const file of ['connection-guard.js', 'chat-display.js']) {
        const body = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile', file), 'utf8');
        await page.route(`**/scripts/extensions/third-party/jiuguan-mobile/${file}`, route => route.fulfill({ contentType: 'text/javascript', body }));
    }
    await page.addStyleTag({ content: await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/style.css'), 'utf8') });
    await page.evaluate(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/index.js'), 'utf8'));
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
    await page.locator('[data-tab="worlds"]').click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'worlds');
    await page.evaluate(async name => { const wi = await import('/scripts/world-info.js'); window.jQuery('#world_info_sort_order').val('13').trigger('change'); window.jQuery('#world_editor_select').val(wi.world_names.indexOf(name)).trigger('change'); }, name);
    const entry = page.locator('#world_popup_entries_list .world_entry[uid="0"]');
    await entry.waitFor();
    await page.evaluate(() => window.toastr.remove());
    const header = entry.locator('.world_entry_form > .inline-drawer > .inline-drawer-header');
    async function bounds(label) {
        const result = await page.locator('#world_popup').evaluate(root => {
            const viewport = window.innerWidth;
            const overflow = [...root.querySelectorAll('input, select, textarea, .menu_button, .paginationjs-pages a, .killSwitch, .inline-drawer-toggle')]
                .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && !el.classList.contains('select2-hidden-accessible'))
                .map(el => ({ name: el.id || el.name || el.className, x: el.getBoundingClientRect().x, right: el.getBoundingClientRect().right }))
                .filter(el => el.x < -1 || el.right > viewport + 1);
            return { viewport, overflow };
        });
        assert.deepEqual(result.overflow, [], `${label}: 所有可见编辑控件均在屏幕宽度内`);
        report.checks.push({ label, ...result });
    }
    for (const width of [320, 360, 390, 430, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await entry.scrollIntoViewIfNeeded();
        await bounds(`折叠条目 ${width}px`);
        const pager = await page.locator('#world_info_pagination').evaluate(root => ['.paginationjs-pages', '.paginationjs-size-changer'].map(selector => root.querySelector(selector).getBoundingClientRect().top));
        assert.ok(Math.abs(pager[0] - pager[1]) < 2, '翻页与每页数量保持同一行');
        const fields = await header.locator('input[type="number"]').evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
        assert.ok(Math.max(...fields) - Math.min(...fields) < 2, '深度、顺序、概率在同一行');
        await page.screenshot({ path: path.join(out, `collapsed-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await entry.evaluate(el => { const panel = document.getElementById('WorldInfo'); panel.scrollTop += el.getBoundingClientRect().top - 64; });
    await page.screenshot({ path: path.join(out, 'entries-390.png') });
    await page.locator('#world_info_search').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'toolbar-390.png') });
    await header.locator('.inline-drawer-toggle').click();
    await entry.locator('textarea[name="content"]').waitFor({ state: 'visible' });
    for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 }); await bounds(`展开编辑 ${width}px`);
    }
    await entry.locator('textarea[name="content"]').fill('合成验收：修改后刷新仍然保留。');
    await page.setViewportSize({ width: 390, height: 420 });
    await page.waitForFunction(() => {
        const r = document.activeElement.getBoundingClientRect(); return r.top >= 48 && r.bottom <= innerHeight;
    });
    report.checks.push('模拟键盘缩小可视区时，世界书焦点输入框自动滚动至可见区域');
    await page.setViewportSize({ width: 390, height: 844 });
    await header.locator('input[name="depth"]').fill('3');
    await header.locator('input[name="order"]').fill('170');
    await header.locator('input[name="probability"]').fill('85');
    await header.locator('.killSwitch').click();
    await page.waitForTimeout(1500);
    const saved = (await post('/api/worldinfo/get', { name })).entries[0];
    assert.equal(saved.content, '合成验收：修改后刷新仍然保留。');
    assert.equal(saved.depth, 3); assert.equal(saved.order, 170); assert.equal(saved.probability, 85); assert.equal(saved.disable, true);
    report.checks.push('内容、深度、顺序、概率和启停通过原版接口保存');
    await entry.locator('textarea[name="content"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'expanded-390.png') });
    await header.locator('.inline-drawer-toggle').click();
    await page.locator('#world_info_search').fill('测试条目 29');
    await page.waitForFunction(() => document.querySelectorAll('#world_popup_entries_list .world_entry').length === 1);
    await page.locator('#world_popup_entries_list .world_entry[uid="29"]').waitFor();
    await bounds('搜索结果'); report.checks.push('搜索命中指定合成条目');
    await page.locator('#world_info_search').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#world_popup_entries_list .world_entry').length === 25);
    await page.locator('#world_info_pagination .paginationjs-next a').click();
    await page.waitForFunction(() => document.querySelectorAll('#world_popup_entries_list .world_entry').length === 5);
    report.checks.push('原版分页切换至第二页 5 条');
    await page.locator('#world_info_pagination .paginationjs-prev a').click();
    await entry.waitFor();
    await page.locator('#world_refresh').click();
    await entry.waitFor();
    assert.equal(await entry.locator('input[name="depth"]').inputValue(), '3');
    report.checks.push('刷新世界书后字段保留');
    report.passed = true;
} catch (error) {
    report.error = error.stack;
    await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    process.exitCode = 1;
} finally {
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await browser?.close(); child?.kill();
}
