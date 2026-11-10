import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { root, sha256 } from './common.mjs';
import { checkMobileUI } from './mobile-ui-checks.mjs';
import path from 'node:path';

if (process.env.JIUGUAN_APP_PROBE !== '1' || !process.env.ANDROID_DEVICE_ID) throw new Error('需要显式授权开发包真机测试与设备序列号');
const adbPath = process.env.ADB_PATH || 'adb';
const args = ['-s', process.env.ANDROID_DEVICE_ID];
const adb = (...cmd) => execFileSync(adbPath, [...args, ...cmd], { encoding: 'utf8', windowsHide: true }).trim();
const pid = adb('shell', 'pidof', 'io.jiuguan.mobile.debug');
assert.match(pid, /^\d+$/);
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
let browser;
const report = { package: 'io.jiuguan.mobile.debug', apkSha256: sha256(await readFile(path.join(root, 'app/build/outputs/apk/debug/app-debug.apk'))), checks: [], sends: 0, injectedUI: false };
await mkdir(path.join(root, 'artifacts/upstream/mobile-ui'), { recursive: true });
const shot = async name => {
  const file = path.join(root, 'artifacts/upstream', name);
  await writeFile(file, execFileSync(adbPath, [...args, 'exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
  return path.relative(root, file);
};
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url()));
  assert.ok(page, '真实应用中的本机 WebView');
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
  assert.ok(await page.locator('link[href*="third-party/jiuguan-mobile/style.css"]').count());
  report.checks.push('冷启动已安装 APK，原版扩展机制自动加载手机界面并默认打开聊天页；测试未注入 UI');
  const hideKeyboard = async () => {
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(400);
  };
  report.checks.push(...await checkMobileUI(page, {
    screenshot: async label => { await hideKeyboard(); await shot(`mobile-ui/installed-${label}.png`); },
    nativeBack: async () => { await hideKeyboard(); adb('shell', 'input', 'keyevent', 'KEYCODE_BACK'); },
  }));
  await hideKeyboard();
  const before = await page.evaluate(() => ({ height: innerHeight, width: innerWidth }));
  await page.locator('#send_textarea').click();
  await page.waitForFunction(height => innerHeight < height - 100, before.height, { timeout: 10000 });
  const keyboard = await page.evaluate(() => {
    const box = document.querySelector('#send_textarea').getBoundingClientRect();
    return { height: innerHeight, bottom: box.bottom, top: box.top };
  });
  assert.ok(keyboard.bottom <= keyboard.height + 1 && keyboard.top >= 0, '键盘弹出后输入框保持在可见区域');
  report.checks.push('点击输入框唤起键盘，WebView 缩小且输入框仍在可见区域');
  report.keyboardScreenshot = await shot('mobile-ui/installed-keyboard.png');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await page.waitForFunction(height => innerHeight >= height - 2, before.height, { timeout: 10000 });
  report.checks.push('返回键关闭键盘并恢复页面高度');
  assert.equal(await page.evaluate(() => window.jiuguanMobile.view), 'chat');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await page.waitForFunction(() => window.jiuguanMobile.view === 'chats');
  report.checks.push('系统返回从聊天回聊天列表，没有退出或新建会话');
  const historyBefore = await page.evaluate(async () => {
    const response = await fetch('/api/chats/recent', { method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders(), body: '{}' });
    return (await response.json()).map(({avatar, group, file_name}) => JSON.stringify([avatar, group, file_name])).sort();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
  const historyAfter = await page.evaluate(async () => {
    const response = await fetch('/api/chats/recent', { method: 'POST', headers: window.SillyTavern.getContext().getRequestHeaders(), body: '{}' });
    return (await response.json()).map(({avatar, group, file_name}) => JSON.stringify([avatar, group, file_name])).sort();
  });
  assert.deepEqual(historyAfter, historyBefore);
  report.checks.push('重新加载仍默认聊天页，历史会话标识保持一致');
  await shot('mobile-ui/installed-home.png');
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
finally {
  await browser?.close();
  adb('forward', '--remove', `tcp:${port}`);
  await writeFile(path.join(root, 'artifacts/upstream/app-webview-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
