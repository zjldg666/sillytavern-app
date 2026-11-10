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
    const deadline = Date.now() + 30000;
    while (!await page.evaluate(() => window.__ready)) {
        const popup = page.locator('dialog.popup[open]:has(.onboarding)');
        if (await popup.isVisible()) {
            await popup.locator('.popup-input').fill('连接方案隔离测试');
            await popup.locator('.popup-button-ok').evaluate(el => el.click()).catch(() => {});
        }
        if (Date.now() > deadline) throw new Error('APP_READY timeout');
        await page.waitForTimeout(100);
    }
    if (guarded) await page.evaluate(async () => { await (await import('/profile-guard-test.js')).installConnectionGuard(); });
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
    assert.equal(report.checks[0].passed, true);
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
