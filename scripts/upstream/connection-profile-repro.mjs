import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { root, source, writeConfig, waitForServer, verifySource } from './common.mjs';

// 仅使用隔离数据和假密钥；验证锁定上游的方案行为，不读取手机或生产配置。
const guarded = process.argv.includes('--guard');
const report = { upstream: await verifySource(), guarded, checks: [], paidApiCalls: 0 };
await mkdir(path.join(root, '.tools/profile-repro'), { recursive: true });
const sandbox = await mkdtemp(path.join(root, '.tools/profile-repro/run-'));
const reserved = createServer();
reserved.listen(0, '127.0.0.1'); await once(reserved, 'listening');
const port = reserved.address().port;
await new Promise(resolve => reserved.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child, browser;
const log = createWriteStream(path.join(sandbox, 'server.log'));
try {
    const config = await writeConfig(sandbox, { port });
    child = spawn(process.execPath, ['server.js', '--configPath', config], { cwd: source, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    await waitForServer(base, child);
    browser = await chromium.launch({ headless: true, ...(process.env.JIUGUAN_CHROME ? { executablePath: process.env.JIUGUAN_CHROME } : {}) });
    const page = await browser.newPage();
    if (guarded) {
        const guard = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/connection-guard.js'), 'utf8');
        await page.route('**/profile-guard-test.js', route => route.fulfill({ contentType: 'text/javascript', body: guard }));
    }
    // Status queries are mocked; no request reaches an external API.
    await page.route('**/api/backends/chat-completions/status', route => route.fulfill({ json: { data: [] } }));
    await page.goto(base);
    await page.waitForFunction(() => window.SillyTavern?.getContext);
    await page.evaluate(async () => {
        const api = await import('/script.js');
        api.eventSource.on(api.event_types.APP_READY, () => { window.__ready = true; });
    });
    const deadline = Date.now() + 60000;
    while (!await page.evaluate(() => window.__ready)) {
        const popup = page.locator('dialog.popup[open]:has(.onboarding)');
        if (await popup.isVisible()) {
            await popup.locator('.popup-input').fill('连接方案隔离测试');
            await popup.locator('.popup-button-ok').evaluate(el => el.click()).catch(() => {});
        }
        if (Date.now() > deadline) throw new Error('APP_READY timeout');
        await page.waitForTimeout(100);
    }
    if (guarded) await page.evaluate(async () => { window.__connectionGuard = await (await import('/profile-guard-test.js')).installConnectionGuard(); });
    report.checks = await Promise.race([page.evaluate(async guarded => {
        const api = await import('/script.js');
        const { oai_settings: settings } = await import('/scripts/openai.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const secrets = await import('/scripts/secrets.js');
        const manager = extension_settings.connectionManager;
        const select = document.getElementById('connection_profiles');
        const checks = [];
        api.changeMainAPI('openai');
        window.jQuery('#chat_completion_source').val('custom').trigger('change');
        settings.bind_preset_to_connection = false;
        const keyA = await secrets.writeSecret(secrets.SECRET_KEYS.CUSTOM, 'fake-only-A', 'Synthetic A');
        const keyB = await secrets.writeSecret(secrets.SECRET_KEYS.CUSTOM, 'fake-only-B', 'Synthetic B');
        if (!keyA || !keyB) throw new Error('Synthetic secrets failed');
        const a = { id: 'repro-a', name: 'Synthetic A', mode: 'cc', api: 'custom', 'api-url': 'https://a.invalid/v1', model: 'model-a', 'secret-id': keyA };
        const b = { id: 'repro-b', name: 'Synthetic B', mode: 'cc', api: 'custom', 'api-url': 'https://b.invalid/v1', model: 'model-b', 'secret-id': keyB };
        manager.profiles = [a, b];
        if (guarded) {
            const activeBefore = secrets.secret_state[secrets.SECRET_KEYS.CUSTOM].find(key => key.active)?.id;
            await secrets.renameSecret(secrets.SECRET_KEYS.CUSTOM, keyA, '2026/11/12 08:00');
            await window.__connectionGuard.syncSecretNames();
            const label = id => secrets.secret_state[secrets.SECRET_KEYS.CUSTOM].find(key => key.id === id)?.label;
            checks.push({ name: 'existing_timestamp_key_named_after_profile', passed: label(keyA) === a.name && label(keyB) === b.name });
            const old = structuredClone(a); a.name = 'Renamed A';
            await api.eventSource.emit(api.event_types.CONNECTION_PROFILE_UPDATED, old, a);
            checks.push({ name: 'secret_label_follows_profile_rename', passed: label(keyA) === a.name });
            manager.profiles.push({ ...a, id: 'shared-a', name: 'Shared A' });
            await api.eventSource.emit(api.event_types.CONNECTION_PROFILE_CREATED, manager.profiles.at(-1));
            checks.push({ name: 'shared_secret_lists_both_profile_names', passed: label(keyA).includes(a.name) && label(keyA).includes('Shared A') && secrets.secret_state[secrets.SECRET_KEYS.CUSTOM].find(key => key.active)?.id === activeBefore });
            const removed = manager.profiles.pop();
            await api.eventSource.emit(api.event_types.CONNECTION_PROFILE_DELETED, removed);
            checks.push({ name: 'shared_secret_name_updated_after_profile_deleted', passed: label(keyA) === a.name });
            a.name = old.name; await window.__connectionGuard.syncSecretNames();
        }
        select.replaceChildren(...[a, b].map(p => new Option(p.name, p.id)));
        const selectProfile = id => new Promise(resolve => {
            api.eventSource.once(api.event_types.CONNECTION_PROFILE_LOADED, () => setTimeout(resolve, 10));
            select.value = id;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const activeKey = () => secrets.secret_state[secrets.SECRET_KEYS.CUSTOM]?.find(s => s.active)?.id;
        await selectProfile(a.id); await selectProfile(b.id); await selectProfile(a.id);
        checks.push({ name: 'complete_profiles_sequential_switch', passed: settings.custom_url === a['api-url'] && settings.custom_model === a.model && activeKey() === keyA });

        // 未记录的字段在方案加载中被跳过，不会清空上一方案的值。
        delete b['api-url']; delete b['secret-id'];
        settings.custom_include_headers = 'X-Synthetic: A';
        settings.custom_include_body = 'synthetic: A';
        if (guarded) {
            select.value = b.id; select.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 10));
            checks.push({ name: 'missing_fields_blocked_without_mutation', passed: manager.selectedProfile === a.id && select.value === a.id && settings.custom_model === a.model && !b['api-url'] && !b['secret-id'] });
            const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
            let rejected = false;
            try { await SlashCommandParser.commands.profile.callback({}, b.name); } catch { rejected = true; }
            checks.push({ name: 'incomplete_profile_command_rejected', passed: rejected && manager.selectedProfile === a.id });
            b.exclude = ['api-url', 'secret-id'];
            await selectProfile(b.id);
            checks.push({ name: 'explicitly_shared_fields_remain_compatible', passed: manager.selectedProfile === b.id && settings.custom_model === b.model && settings.custom_url === a['api-url'] && activeKey() === keyA });
            checks.push({ name: 'excluded_address_and_key_are_clearly_disclosed', passed: document.getElementById('jg-connection-note').textContent.includes('已排除API 地址、密钥') && document.querySelector('#toast-container').textContent.includes('切换时会沿用当前值') });
            delete b.exclude;
        } else {
            await selectProfile(b.id);
            checks.push({ name: 'missing_fields_inherit_previous_profile', reproduced: manager.selectedProfile === b.id && settings.custom_url === a['api-url'] && settings.custom_model === b.model && activeKey() === keyA, extraHeadersRetained: settings.custom_include_headers === 'X-Synthetic: A', extraBodyRetained: settings.custom_include_body === 'synthetic: A' });
        }
        b['api-url'] = 'https://b.invalid/v1'; b['secret-id'] = keyB;

        // 使用真实扩展事件延迟预设加载，确定性模拟慢扩展；不替换原版命令。
        await selectProfile(a.id);
        const { getPresetManager } = await import('/scripts/preset-manager.js');
        await getPresetManager('openai').savePreset('Synthetic preset A', structuredClone(settings));
        await getPresetManager('openai').savePreset('Synthetic preset B', structuredClone(settings));
        b.preset = 'Synthetic preset A';
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        const delayPreset = async () => { entered(); await gate; };
        api.eventSource.on(api.event_types.OAI_PRESET_CHANGED_BEFORE, delayPreset);
        try {
            const loading = selectProfile(b.id);
            await started;
            const before = structuredClone(b);
            const update = document.getElementById('update_connection_profile');
            const updateAllowed = !update.classList.contains('disabled') && !update.disabled;
            if (guarded) {
                update.click();
                const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
                let rejected = false;
                try { await SlashCommandParser.commands['profile-update'].callback({}); } catch { rejected = true; }
                checks.push({ name: 'UI_and_command_update_blocked_during_switch', passed: rejected && JSON.stringify(b) === JSON.stringify(before) });
                select.value = a.id; select.dispatchEvent(new Event('change', { bubbles: true }));
                checks.push({ name: 'rapid_second_switch_blocked', passed: select.value === b.id && manager.selectedProfile === b.id });
                let generationReady = false;
                const generating = api.eventSource.emit(api.event_types.GENERATION_AFTER_COMMANDS, 'quiet', {}, false).then(() => { generationReady = true; });
                await new Promise(resolve => setTimeout(resolve, 20));
                checks.push({ name: 'generation_waits_for_complete_profile', passed: !generationReady });
                release(); await loading; await generating;
                checks.push({ name: 'B_configuration_intact_after_switch', passed: settings.custom_url === before['api-url'] && settings.custom_model === before.model && activeKey() === keyB });
            } else {
                const updated = new Promise(resolve => api.eventSource.once(api.event_types.CONNECTION_PROFILE_UPDATED, resolve));
                update.click(); await updated;
                checks.push({ name: 'update_during_switch_overwrites_B_with_A', reproduced: updateAllowed && b['api-url'] === a['api-url'] && b.model === a.model && b['secret-id'] === keyA, selectedBWhileStillUsingA: manager.selectedProfile === b.id, BChanged: before['api-url'] !== b['api-url'] });
            }
            release(); await loading;
        } finally { release(); api.eventSource.removeListener(api.event_types.OAI_PRESET_CHANGED_BEFORE, delayPreset); }
        if (guarded) {
            window.jQuery('#custom_model_id').val('model-b-edited').trigger('input');
            const updated = new Promise(resolve => api.eventSource.once(api.event_types.CONNECTION_PROFILE_UPDATED, () => setTimeout(resolve, 10)));
            document.getElementById('update_connection_profile').click(); await updated;
            checks.push({ name: 'ordinary_save_still_works', passed: b.model === 'model-b-edited' && a.model === 'model-a' });
            await selectProfile(a.id); await selectProfile(b.id);
            checks.push({ name: 'edited_B_round_trip', passed: settings.custom_model === 'model-b-edited' && settings.custom_url === b['api-url'] && activeKey() === keyB });

            // 密钥输入框是尚未提交的草稿，不是已激活的 secret-id。
            const keyInput = document.getElementById('api_key_custom');
            keyInput.value = 'fake-only-unsaved-B';
            keyInput.dispatchEvent(new Event('input', { bubbles: true }));
            settings.custom_model = 'pending-model-B';
            const beforePendingSave = JSON.stringify(b);
            document.getElementById('update_connection_profile').click();
            await new Promise(resolve => setTimeout(resolve, 100));
            checks.push({ name: 'unsaved_key_cannot_save_old_secret_reference', passed: JSON.stringify(b) === beforePendingSave && !select.hasAttribute('aria-busy') && !!document.querySelector('#toast-container')?.textContent.includes('密钥尚未保存') });
            select.value = a.id; select.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 100));
            checks.push({ name: 'unsaved_B_key_cannot_follow_switch_to_A', passed: manager.selectedProfile === b.id && select.value === b.id && settings.custom_url === b['api-url'] });
            const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
            let rejectedCommands = 0;
            for (const [name, value] of [['profile', a.name], ['profile-update', ''], ['profile-create', 'Pending key profile']]) {
                try { await SlashCommandParser.commands[name].callback({}, value); } catch { rejectedCommands++; }
            }
            checks.push({ name: 'unsaved_key_commands_rejected', passed: rejectedCommands === 3 && manager.profiles.length === 2 });
            document.getElementById('create_connection_profile').click();
            await new Promise(resolve => setTimeout(resolve, 50));
            checks.push({ name: 'unsaved_key_UI_creation_rejected', passed: !document.querySelector('dialog.popup[open]') && manager.profiles.length === 2 });
            keyInput.value = '';

            // 确定性延迟真实本机密钥保存，模拟点“连接”后立刻切换/保存方案。
            await selectProfile(b.id);
            const nativeFetch = window.fetch;
            let releaseWrite, writeStarted;
            const writeGate = new Promise(resolve => { releaseWrite = resolve; });
            const writeEntered = new Promise(resolve => { writeStarted = resolve; });
            window.fetch = async (input, options) => {
                if (String(input).endsWith('/api/secrets/write')) { writeStarted(); await writeGate; }
                return nativeFetch(input, options);
            };
            try {
                keyInput.value = 'fake-only-new-B';
                document.getElementById('api_button_openai').click();
                await writeEntered;
                select.value = a.id; select.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(resolve => setTimeout(resolve, 50));
                checks.push({ name: 'connecting_B_blocks_switch_to_A', passed: manager.selectedProfile === b.id && select.value === b.id });
                const beforeConnectSave = JSON.stringify(b);
                document.getElementById('update_connection_profile').click();
                await new Promise(resolve => setTimeout(resolve, 30));
                checks.push({ name: 'connecting_B_blocks_premature_profile_save', passed: JSON.stringify(b) === beforeConnectSave });
                releaseWrite();
                const deadline = Date.now() + 5000;
                while (activeKey() === keyB || select.hasAttribute('aria-busy')) {
                    if (Date.now() > deadline) throw new Error('Connection save did not finish');
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
                const newBKey = activeKey();
                const updated = new Promise(resolve => api.eventSource.once(api.event_types.CONNECTION_PROFILE_UPDATED, () => setTimeout(resolve, 10)));
                document.getElementById('update_connection_profile').click(); await updated;
                checks.push({ name: 'connected_key_saved_to_B_only', passed: b['secret-id'] === newBKey && a['secret-id'] === keyA });
                await selectProfile(a.id); await selectProfile(b.id);
                checks.push({ name: 'connected_B_round_trip_restores_own_fields', passed: settings.custom_url === b['api-url'] && settings.custom_model === b.model && activeKey() === newBKey });
                // 后续原有失败路径继续使用原来的合成密钥。
                b['secret-id'] = keyB; await selectProfile(b.id);
            } finally { releaseWrite(); window.fetch = nativeFetch; }

            // 已保存密钥后，模型列表请求仍属于同一次连接，不能提早解锁。
            let releaseStatus, statusStarted;
            const statusGate = new Promise(resolve => { releaseStatus = resolve; });
            const statusEntered = new Promise(resolve => { statusStarted = resolve; });
            window.fetch = async (input, options) => {
                if (String(input).endsWith('/api/backends/chat-completions/status')) { statusStarted(); await statusGate; }
                return nativeFetch(input, options);
            };
            try {
                document.getElementById('api_button_openai').click(); await statusEntered;
                select.value = a.id; select.dispatchEvent(new Event('change', { bubbles: true }));
                checks.push({ name: 'model_list_loading_blocks_profile_switch', passed: manager.selectedProfile === b.id && select.value === b.id && select.hasAttribute('aria-busy') });
                releaseStatus();
                const deadline = Date.now() + 5000;
                while (select.hasAttribute('aria-busy')) {
                    if (Date.now() > deadline) throw new Error('Status did not finish');
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
            } finally { releaseStatus(); window.fetch = nativeFetch; }
            window.fetch = (input, options) => String(input).endsWith('/api/secrets/write')
                ? Promise.resolve(new Response('{}', { status: 500 })) : nativeFetch(input, options);
            try {
                keyInput.value = 'fake-only-rejected-write';
                document.getElementById('api_button_openai').click();
                await new Promise(resolve => setTimeout(resolve, 150));
                const before = JSON.stringify(b);
                document.getElementById('update_connection_profile').click();
                await new Promise(resolve => setTimeout(resolve, 50));
                checks.push({ name: 'failed_key_write_keeps_draft_and_blocks_profile_save', passed: !!keyInput.value && JSON.stringify(b) === before && activeKey() === keyB && !select.hasAttribute('aria-busy') });
            } finally { keyInput.value = ''; window.fetch = nativeFetch; }
            const beforeInvalidKey = b['secret-id'];
            b['secret-id'] = 'deleted-synthetic-key';
            select.value = b.id; select.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 10));
            checks.push({ name: 'deleted_secret_reference_rejected', passed: !select.hasAttribute('aria-busy') && activeKey() === keyB && !!document.querySelector('#toast-container')?.textContent.includes('有效的密钥引用') });
            b['secret-id'] = beforeInvalidKey;

            // 模拟服务器拒绝密钥轮换；原版仍发 loaded，保护层必须识别实际密钥不符。
            const originalFetch = window.fetch;
            window.fetch = (input, options) => String(input).endsWith('/api/secrets/rotate')
                ? Promise.resolve(new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } }))
                : originalFetch(input, options);
            try {
                await selectProfile(a.id);
                checks.push({ name: 'failed_secret_rotation_keeps_guard_locked', passed: select.hasAttribute('aria-busy') && activeKey() === keyB && !document.getElementById('jg-connection-status').hidden });
                const beforeFailedSave = JSON.stringify(a);
                document.getElementById('update_connection_profile').click();
                checks.push({ name: 'failed_load_cannot_overwrite_saved_profile', passed: JSON.stringify(a) === beforeFailedSave });
            } finally { window.fetch = originalFetch; }
        }
        return checks;
    }, guarded), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Profile test timed out')), 45000); timer.unref(); })]);
    assert.equal(report.checks.find(check => check.name === 'complete_profiles_sequential_switch').passed, true);
    if (guarded) for (const check of report.checks) assert.equal(check.passed, true, check.name);
    else {
        assert.equal(report.checks[1].reproduced, true);
        assert.equal(report.checks[2].reproduced, true);
    }
    await verifySource();
    report.reproductionPassed = true;
} catch (error) {
    report.error = error.message; process.exitCode = 1;
} finally {
    await browser?.close();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    log.end();
    await mkdir(path.join(root, 'artifacts/upstream/profile-repro'), { recursive: true });
    await writeFile(path.join(root, `artifacts/upstream/profile-repro/${guarded ? 'guarded' : 'result'}.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
}
