import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root } from './common.mjs';
import { checkMobileUI } from './mobile-ui-checks.mjs';

// 开发用：把仓库中的手机界面样式直接注入正在运行的开发包，并截图；不重新打包，不改 App 数据。
// 用法：node scripts/upstream/app-ui-preview.mjs <截图名> [页面内执行的 JS]
if (process.env.JIUGUAN_APP_PROBE !== '1' || !process.env.ANDROID_DEVICE_ID) throw new Error('需要显式授权开发包真机测试与设备序列号');
const [name = 'preview', action = ''] = process.argv.slice(2);
const adbPath = process.env.ADB_PATH || 'adb';
const args = ['-s', process.env.ANDROID_DEVICE_ID];
const adb = (...cmd) => execFileSync(adbPath, [...args, ...cmd], { encoding: 'utf8', windowsHide: true }).trim();
const pid = adb('shell', 'pidof', 'io.jiuguan.mobile.debug');
assert.match(pid, /^\d+$/);
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
const source = path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile');
const output = path.join(root, 'artifacts/upstream/mobile-ui');
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts().flatMap(context => context.pages()).find(page => /^http:\/\/127\.0\.0\.1:\d+\//.test(page.url()));
  assert.ok(page, '真实应用中的本机 WebView');
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => console.error('WebView:', error.message));
  for (const name of ['connection-guard.js', 'chat-display.js']) {
    const body = await readFile(path.join(source, name), 'utf8');
    await page.route(`**/scripts/extensions/third-party/jiuguan-mobile/${name}`, route => route.fulfill({ contentType: 'text/javascript', body }));
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#send_textarea').waitFor({ state: 'attached' });
  const css = await readFile(path.join(source, 'style.css'), 'utf8');
  const js = await readFile(path.join(source, 'index.js'), 'utf8');
  await page.evaluate(({ css, js }) => {
    // 原版扩展加载器可能在注入之后才插入已安装版本的样式；只停用不移除，以免加载器等待 load 事件卡住。
    const dropInstalled = () => document.querySelectorAll('link[href*="jiuguan-mobile"]').forEach(link => { link.media = 'not all'; });
    dropInstalled();
    new MutationObserver(dropInstalled).observe(document.head, { childList: true });
    let style = document.getElementById('jg-preview-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'jg-preview-style';
      document.head.append(style);
    }
    style.textContent = css;
    if (!window.jiuguanMobile) new Function(js)();
  }, { css, js });
  await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
  let result;
  if (name === 'check') result = await checkMobileUI(page, { screenshot: async label => {
    await page.waitForTimeout(250);
    await writeFile(path.join(output, `preview-${label}.png`), execFileSync(adbPath, [...args, 'exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
  } });
  else if (action) result = await page.evaluate(action);
  await page.waitForTimeout(700);
  const file = path.join(output, `${name}.png`);
  await writeFile(file, execFileSync(adbPath, [...args, 'exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
  console.log(JSON.stringify({ screenshot: path.relative(root, file), result }));
  if (name === 'check') await writeFile(path.join(output, 'preview-checks.json'), JSON.stringify({ checks: result, passed: true }, null, 2));
} finally {
  await browser?.close();
  adb('forward', '--remove', `tcp:${port}`);
}
