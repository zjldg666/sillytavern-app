import { execFileSync } from 'node:child_process';

export async function connectAndroidPage() {
    const executable = process.env.ADB_PATH || 'D:/Download/AndroidSDK/android-sdk-windows/platform-tools/adb.exe';
    const device = process.env.ANDROID_DEVICE_ID || '10CG1E0NY40024X';
    const adb = (...args) => execFileSync(executable, ['-s', device, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    const pid = adb('shell', 'pidof', 'io.jiuguan.mobile.debug');
    if (!/^\d+$/.test(pid)) throw new Error('开发版未运行');
    const port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
    let socket;
    const pending = new Map();
    const close = () => {
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Connection closed')); }
        pending.clear(); socket?.close(); adb('forward', '--remove', `tcp:${port}`);
    };
    try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
        const page = targets.find(p => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url));
        if (!page?.webSocketDebuggerUrl) throw new Error('没有可调试的本机酒馆页面');
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('WebView connection timeout')), 10000);
            socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
            socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebView connection failed')); }, { once: true });
        });
        let serial = 0;
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data), item = pending.get(message.id);
            if (!item) return;
            clearTimeout(item.timer); pending.delete(message.id);
            if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
        });
        const call = (method, params = {}, timeout = 30000) => new Promise((resolve, reject) => {
            const id = ++serial;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, timeout);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method, params }));
        });
        const evaluate = async (fn, arg) => {
            const result = await call('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`, awaitPromise: true, returnByValue: true }, 60000);
            if (result.exceptionDetails) throw new Error('页面测量失败（不输出用户数据）');
            return result.result.value;
        };
        return { call, evaluate, close, adb };
    } catch (error) { close(); throw error; }
}
