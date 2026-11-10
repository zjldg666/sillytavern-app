import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { connectAndroidPage } from './android-cdp.mjs';
import { root, sha256 } from './common.mjs';

const mode = process.argv[2];
const passive = process.argv.includes('--read-only');
assert.ok(['before', 'check', 'after'].includes(mode));
const out = path.join(root, process.env.JIUGUAN_DEVICE_REPORT_DIR || 'artifacts/upstream/world-info-scope');
await mkdir(out, { recursive: true });
const connection = await connectAndroidPage();
const { evaluate, adb } = connection;
const report = { checks: [], paidApiCalls: 0, injectedUI: false };
async function snapshot() {
    return evaluate(async allowBusy => {
        const api = await import('/script.js'), wi = await import('/scripts/world-info.js');
        if (!allowBusy && (api.isGenerating() || api.isChatSaving)) throw new Error('正在生成或保存');
        const { oai_settings: settings } = await import('/scripts/openai.js');
        const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(n => n.toString(16).padStart(2, '0')).join('');
        return { characters: await hash(api.characters.map(c => [c.avatar, c.data?.extensions?.world]).sort()),
            worlds: await hash([...wi.world_names].sort()), global: await hash([...wi.selected_world_info].sort()),
            prompts: await hash({ prompts: settings.prompts, order: settings.prompt_order }),
            globalCount: wi.selected_world_info.length };
    }, passive);
}
async function shot(name) {
    const bytes = execFileSync(process.env.ADB_PATH || 'D:/Download/AndroidSDK/android-sdk-windows/platform-tools/adb.exe',
        ['-s', process.env.ANDROID_DEVICE_ID || '10CG1E0NY40024X', 'exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(path.join(out, `${name}.png`), bytes);
}
try {
    if (!passive) await evaluate(() => {
        if (document.querySelector('dialog[open]') || document.querySelector('#completion_prompt_manager_popup')?.getClientRects().length || document.querySelector('#send_textarea')?.value) throw new Error('有未关闭编辑或输入草稿');
    });
    if (mode === 'before') {
        await writeFile(path.join(out, 'device-before.json'), JSON.stringify(await snapshot(), null, 2));
        console.log('更新前状态已记录为散列，无生成、保存或未关闭草稿。');
    } else if (mode === 'check') {
        assert.deepEqual(await snapshot(), JSON.parse(await readFile(path.join(out, 'device-before.json'), 'utf8')));
        console.log('安装前再次确认：记录状态未变，当前没有生成、保存或草稿。');
    } else {
        let baseline = JSON.parse(await readFile(path.join(out, 'device-before.json'), 'utf8'));
        if (process.argv.includes('--user-cleared-globals')) {
            const current = await snapshot();
            assert.equal(current.globalCount, 0);
            assert.deepEqual({ ...current, global: baseline.global, globalCount: baseline.globalCount }, baseline);
            baseline = current;
            await writeFile(path.join(out, 'device-user-baseline.json'), JSON.stringify(current, null, 2));
            report.checks.push('用户确认更新后自行取消 3 本全局世界书；按当前 0 本验收，保留更新前记录，不恢复用户取消的选项');
        }
        assert.deepEqual(await snapshot(), baseline);
        for (const file of ['index.js', 'style.css']) {
            const body = await evaluate(async file => (await fetch(`/scripts/extensions/third-party/jiuguan-mobile/${file}`)).text(), file);
            assert.equal(sha256(body), sha256(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile', file))));
        }
        report.checks.push('覆盖安装冷启动后，角色绑定、书库和提示词散列保持一致；安装资源与源码一致');
        assert.deepEqual(await evaluate(() => [...document.querySelectorAll('#jg-nav .jg-tab')].map(tab => tab.dataset.tab)), ['chats', 'roles', 'worlds', 'settings']);
        report.checks.push('已安装底部导航顺序：聊天/角色/世界书/设置');
        if (passive) {
            const state = await evaluate(async () => {
                const wi = await import('/scripts/world-info.js');
                const response = await fetch('/api/settings/get', { method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders(), body: '{}' });
                if (!response.ok) throw new Error('无法读取保存状态');
                const saved = JSON.parse((await response.json()).settings);
                const setting = (saved.world_info_settings ?? saved).world_info;
                const globals = Array.isArray(setting) ? setting : typeof setting === 'string' ? [setting] : setting?.globalSelect ?? [];
                return { text: document.querySelector('#jg-world-count')?.textContent,
                    savedMatches: [...globals].sort().join('\n') === [...wi.selected_world_info].sort().join('\n'),
                    names: [...document.querySelector('#jg-world-active').children].map(e => e.textContent).sort().join('\n') === [...wi.selected_world_info].sort().join('\n'),
                    originalHidden: getComputedStyle(document.querySelector('#world_info')).display === 'none',
                    libraryPresent: !!document.querySelector('#jg-world-library') };
            });
            assert.equal(state.text, `全局已启用 ${baseline.globalCount} 本`);
            assert.ok(state.names && state.originalHidden && state.savedMatches);
            assert.equal(state.libraryPresent, true);
            report.checks.push('只读核验：已安装界面计数/书名、原版运行状态与已保存全局选择一致；书库列表存在');
            report.limitation = '用户正在使用手机；本次只读检查，没有操作真机勾选、搜索或系统返回。相关操作已在隔离浏览器测试。';
            report.passed = true;
        } else {
        await evaluate(() => document.querySelector('[data-tab="worlds"]').click());
        await new Promise(resolve => setTimeout(resolve, 400));
        const summary = await evaluate(() => ({
            count: document.querySelector('#jg-world-count').textContent,
            names: document.querySelector('#jg-world-active').children.length,
            originalHidden: !document.querySelector('#world_info').getClientRects().length,
            overflow: document.querySelector('.jg-world-summary').getBoundingClientRect().right > innerWidth + 1,
            rootView: window.jiuguanMobile.view === 'worlds',
            navVisible: !!document.querySelector('#jg-nav').getClientRects().length,
            editorAboveNav: document.querySelector('#WorldInfo').getBoundingClientRect().bottom <= document.querySelector('#jg-nav').getBoundingClientRect().top + 1,
        }));
        assert.equal(summary.count, `全局已启用 ${baseline.globalCount} 本`);
        assert.equal(summary.names, baseline.globalCount); assert.ok(summary.originalHidden && !summary.overflow);
        assert.ok(summary.rootView && summary.navVisible && summary.editorAboveNav);
        await shot('device-global-summary');
        const library = await evaluate(async () => {
            const wi = await import('/scripts/world-info.js');
            const rows = [...document.querySelectorAll('#jg-world-list [data-world]')];
            return { matches: JSON.stringify(rows.map(e => e.dataset.world)) === JSON.stringify(wi.world_names),
                mode: document.body.dataset.jgWorldMode, editorHidden: !document.querySelector('#world_popup').getClientRects().length,
                below: document.querySelector('#jg-world-library').getBoundingClientRect().top >= document.querySelector('#wiTopBlock').getBoundingClientRect().bottom };
        });
        assert.ok(library.matches && library.editorHidden && library.below, JSON.stringify(library)); assert.equal(library.mode, 'list');
        await evaluate(() => document.querySelector('.jg-world-activation .inline-drawer-toggle').click());
        await new Promise(resolve => setTimeout(resolve, 300));
        const activation = await evaluate(() => {
            const root = document.querySelector('#wiActivationSettings');
            return { expanded: document.querySelector('.jg-world-activation .inline-drawer-toggle').getAttribute('aria-expanded'),
                width: root.getBoundingClientRect().width, available: document.querySelector('#wiTopBlock').getBoundingClientRect().width,
                overflow: [...root.querySelectorAll('input, select, label')].filter(e => e.getClientRects().length)
                    .some(e => e.getBoundingClientRect().left < 0 || e.getBoundingClientRect().right > innerWidth + 1) };
        });
        assert.equal(activation.expanded, 'true'); assert.ok(activation.width >= activation.available - 24 && !activation.overflow);
        await shot('device-activation-expanded');
        await evaluate(() => document.querySelector('.jg-world-activation .inline-drawer-toggle').click());
        const opened = await evaluate(() => {
            const row = document.querySelector('#jg-world-list [data-world]');
            if (!row) return false;
            row.click(); return true;
        });
        if (opened) {
            await new Promise(resolve => setTimeout(resolve, 500));
            assert.equal(await evaluate(() => document.body.dataset.jgWorldMode), 'edit');
            assert.equal(await evaluate(() => document.querySelector('#jg-world-library').getClientRects().length), 0);
            await shot('device-book-editor');
            await evaluate(() => document.activeElement?.blur());
            adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
            await new Promise(resolve => setTimeout(resolve, 800));
            assert.equal(await evaluate(() => document.body.dataset.jgWorldMode), 'list');
            assert.equal(await evaluate(() => window.jiuguanMobile.view), 'worlds');
        }
        report.checks.push('真机全局区下方完整书库，点书进入原版编辑器，系统返回书库；激活设置单击展开/收起，内容全宽且无溢出');
        report.library = library; report.activation = activation;
        await evaluate(() => document.querySelector('.jg-world-summary button').click());
        const choices = await evaluate(async () => {
            const wi = await import('/scripts/world-info.js');
            const rows = [...document.querySelectorAll('.jg-world-choice input')];
            return { count: rows.length, expected: wi.world_names.length,
                correct: rows.every(input => input.checked === wi.selected_world_info.includes(input.dataset.world)) };
        });
        assert.equal(choices.count, choices.expected); assert.equal(choices.correct, true);
        await shot('device-global-picker');
        // 将焦点从搜索输入移到面板，单独验证导航返回，不与输入法返回竞争。
        await evaluate(() => document.querySelector('#jg-menu').focus());
        await new Promise(resolve => setTimeout(resolve, 500));
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await new Promise(resolve => setTimeout(resolve, 800));
        assert.equal(await evaluate(() => document.querySelector('#jg-menu').open), false);
        assert.equal(await evaluate(() => window.jiuguanMobile.view), 'worlds');
        adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
        await new Promise(resolve => setTimeout(resolve, 800));
        assert.equal(await evaluate(() => window.jiuguanMobile.view), 'chats');
        report.checks.push('真机世界书为一级页面，底部导航常驻且不遮挡编辑器；系统返回先关闭选书面板，再回聊天列表');
        assert.deepEqual(await snapshot(), baseline);
        report.checks.push('真机只显示实际全局启用项；候选复选框与保存状态一致；系统返回关闭列表，用户设置未变');
        report.summary = summary; report.choices = choices; report.passed = true;
        await evaluate(() => document.querySelector('[data-tab="worlds"]').click());
        }
        await writeFile(path.join(out, 'device-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    }
} finally { connection.close(); }
