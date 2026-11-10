import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { connectAndroidPage } from './android-cdp.mjs';

assert.equal(process.env.JIUGUAN_APP_PROBE, '1');
assert.ok(process.env.ANDROID_DEVICE_ID);
const connection = await connectAndroidPage();
const out = 'artifacts/upstream/settings-interactions';
async function shot(name) {
    await new Promise(resolve => setTimeout(resolve, 250));
    await writeFile(`${out}/${name}.png`, execFileSync('adb', ['-s', process.env.ANDROID_DEVICE_ID, 'exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
}
try {
    await connection.evaluate(() => {
        if (document.querySelector('dialog[open]') || document.querySelector('#completion_prompt_manager_popup')?.getClientRects().length) throw new Error('已有弹窗，不取消用户草稿');
        if (['panel','chat'].includes(window.jiuguanMobile.view)) window.jiuguanMobile.back();
        document.querySelector('[data-tab="settings"]').click(); window.toastr.remove();
    });
    const settings = await connection.evaluate(() => ({
        actual: [...document.querySelectorAll('.jg-setting-row[data-panel]')].map(e => e.dataset.panel).sort(),
        expected: [...document.querySelectorAll('#top-settings-holder > .drawer')].map(e => e.id).filter(id => id !== 'WI-SP-button').sort(),
        removed: !document.getElementById('jg-return') && !document.getElementById('jg-content').textContent.includes('切换到原版界面') && ![...document.querySelectorAll('#jg-content button')].some(e => e.textContent === '全部工具'),
    }));
    assert.deepEqual(settings.actual, settings.expected); assert.equal(settings.removed, true);
    await shot('device-all-tools');
    await connection.evaluate(() => document.querySelector('[data-panel="sys-settings-button"]').click());
    await new Promise(resolve => setTimeout(resolve, 150));
    const profile = await connection.evaluate(() => {
        const select = document.getElementById('connection_profiles'), r = select.getBoundingClientRect();
        return { viewport: innerWidth, width: r.width, fullWidth: r.width >= select.parentElement.clientWidth - 2, controlsBelow: [...select.parentElement.querySelectorAll('.menu_button')].every(b => b.getBoundingClientRect().top >= r.bottom) };
    });
    assert.ok(profile.fullWidth && profile.controlsBelow);
    await shot('device-connection-profile');
    const report = { passed: true, tools: settings.actual.length, removedLegacyEntry: settings.removed, profile, injectedUI: false };
    await writeFile(`${out}/device-layout.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally { connection.close(); }
