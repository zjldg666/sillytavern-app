import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { root, sha256 } from './common.mjs';
import path from 'node:path';

// 只检查运行状态与扩展资产，不读取方案内容，不切换方案，不调用模型。
const adbPath = process.env.ADB_PATH;
const device = process.env.ANDROID_DEVICE_ID;
if (!adbPath || !device) throw new Error('需要 ADB_PATH 和 ANDROID_DEVICE_ID');
const adb = (...args) => execFileSync(adbPath, ['-s', device, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const pid = adb('shell', 'pidof', 'io.jiuguan.mobile.debug');
assert.match(pid, /^\d+$/);
const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
let socket;
try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
    const page = pages.find(p => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url));
    assert.ok(page?.webSocketDebuggerUrl, '本机 WebView 页面');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebView connection timeout')), 10000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebView connection failed')); }, { once: true });
    });
    let serial = 0;
    const evaluate = fn => new Promise((resolve, reject) => {
        const id = ++serial;
        const listener = event => {
            const message = JSON.parse(event.data);
            if (message.id !== id) return;
            clearTimeout(timer); socket.removeEventListener('message', listener);
            if (message.error || message.result?.exceptionDetails) reject(new Error('WebView probe evaluation failed'));
            else resolve(message.result.result.value);
        };
        const timer = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('WebView probe timeout')); }, 15000);
        socket.addEventListener('message', listener);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(${fn.toString()})()`, awaitPromise: true, returnByValue: true } }));
    });
    const deadline = Date.now() + 45000;
    while (!await evaluate(() => Boolean(window.jiuguanMobile && window.SillyTavern?.getContext))) {
        if (Date.now() > deadline) throw new Error('Mobile UI initialization timeout');
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    const state = await evaluate(async () => {
        const api = await import('/script.js');
        return { generating: api.isGenerating(), savingChat: Boolean(api.isChatSaving), guardLoaded: !!document.getElementById('jg-connection-status') };
    });
    if (!process.argv.includes('--before')) {
        assert.equal(state.guardLoaded, true, '修复模块随已安装 APK 自动加载');
        const source = await evaluate(async () => {
            const response = await fetch('/scripts/extensions/third-party/jiuguan-mobile/connection-guard.js', { cache: 'no-store' });
            if (!response.ok) throw new Error('Missing guard asset');
            return response.text();
        });
        assert.equal(sha256(Buffer.from(source)), sha256(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/connection-guard.js'))));
    }
    console.log(JSON.stringify({ package: 'io.jiuguan.mobile.debug', ...state, modelRequests: 0, userProfilesChanged: false }));
} finally {
    socket?.close();
    adb('forward', '--remove', `tcp:${port}`);
}
