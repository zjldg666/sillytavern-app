import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { root, sha256 } from './common.mjs';

// 正式包只读核验；不读取密钥明文，不写入/删除用户聊天，不发送模型请求。
const before = process.argv.includes('--before');
const adbPath = process.env.ADB_PATH || 'adb';
const serial = process.env.ANDROID_DEVICE_ID;
if (!serial) throw new Error('需要 ANDROID_DEVICE_ID');
const pkg = 'io.jiuguan.mobile';
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const line = adb('shell', 'ps', '-A', '-o', 'PID,ARGS').split('\n').find(row => row.includes(`/data/user/0/${pkg}/files/`) && row.includes('libjiuguan_node.so'));
const port = line?.match(/--port (\d+)/)?.[1];
if (!port) throw new Error('正式包内置服务未启动');
const forwarded = adb('forward', 'tcp:0', `tcp:${port}`);
const base = `http://127.0.0.1:${forwarded}`;
const out = path.join(root, 'artifacts/upstream/session-lifecycle');
await mkdir(out, { recursive: true });
try {
    const csrf = await fetch(`${base}/csrf-token`, { signal: AbortSignal.timeout(15000) });
    const { token } = await csrf.json();
    const cookie = csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const post = async endpoint => {
        const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Cookie: cookie }, body: '{}', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`Read-only probe failed: ${endpoint}`);
        return response.json();
    };
    const settingsResponse = await post('/api/settings/get');
    const settings = JSON.parse(settingsResponse.settings);
    const profiles = settings.extension_settings.connectionManager.profiles;
    const secrets = await post('/api/secrets/read');
    const chats = await post('/api/chats/recent');
    const digest = value => sha256(Buffer.from(JSON.stringify(value)));
    const ids = [];
    for (const [key, values] of Object.entries(secrets)) if (Array.isArray(values)) ids.push(...values.map(secret => [key, secret.id, secret.active]));
    const report = {
        package: pkg, before, paidApiCalls: 0, userChatsChangedByProbe: false,
        profileCount: profiles.length, profileDigest: digest(profiles),
        secretIdentityDigest: digest(ids.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
        chatCount: chats.length, chatIdentityDigest: digest(chats.map(chat => [chat.avatar || '', chat.group || '', chat.file_name]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))),
    };
    if (!before) {
        const previous = JSON.parse(await readFile(path.join(out, 'device-before.json'), 'utf8'));
        assert.equal(report.profileDigest, previous.profileDigest, '方案内容与密钥引用保留');
        assert.equal(report.secretIdentityDigest, previous.secretIdentityDigest, '密钥 ID、数量和激活状态保留');
        assert.equal(report.chatIdentityDigest, previous.chatIdentityDigest, '既有会话清单保留');
        const owners = new Map();
        for (const profile of profiles) {
            if (profile.exclude?.includes('secret-id') || !profile['secret-id']) continue;
            const names = owners.get(profile['secret-id']) || new Set(); names.add(profile.name); owners.set(profile['secret-id'], names);
        }
        let checked = 0;
        for (const entries of Object.values(secrets)) if (Array.isArray(entries)) for (const secret of entries) {
            const names = owners.get(secret.id); if (!names) continue;
            assert.deepEqual([...new Set(secret.label.split(' / '))].sort(), [...names].sort(), '已绑定密钥名称跟随方案');
            checked++;
        }
        assert.ok(checked > 0);
        report.namedSecretsChecked = checked;
        report.assets = {};
        for (const name of ['index.js', 'connection-guard.js', 'manifest.json']) {
            const response = await fetch(`${base}/scripts/extensions/third-party/jiuguan-mobile/${name}`, { signal: AbortSignal.timeout(15000) });
            assert.ok(response.ok);
            assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile', name))));
            report.assets[name] = true;
        }
        report.passed = true;
    }
    await writeFile(path.join(out, before ? 'device-before.json' : 'device-after.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally { adb('forward', '--remove', `tcp:${forwarded}`); }
