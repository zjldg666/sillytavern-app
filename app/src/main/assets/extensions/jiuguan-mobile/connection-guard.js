// 原版方案仍负责读写、预设应用和密钥切换；这里只保护其异步操作边界。
export async function installConnectionGuard() {
    const api = await import('/script.js');
    const { extension_settings } = await import('/scripts/extensions.js');
    const { oai_settings } = await import('/scripts/openai.js');
    const secrets = await import('/scripts/secrets.js');
    const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
    const { Fuse } = await import('/lib.js');
    const select = document.getElementById('connection_profiles');
    if (!select) return { allowInteraction: () => true };
    const manager = () => extension_settings.connectionManager;
    const profileById = id => manager().profiles.find(p => p.id === id);
    const currentId = () => manager().selectedProfile || '';
    let namingQueue = Promise.resolve();
    function syncSecretNames() {
        // 始终按稳定 ID 绑定；多个方案共用一个密钥时列出全部方案名，不来回覆盖。
        namingQueue = namingQueue.then(async () => {
            const owners = new Map();
            const allSecrets = Object.values(secrets.secret_state).filter(Array.isArray).flat();
            for (const profile of manager().profiles) {
                if (!profile.name || profile.exclude?.includes('secret-id')) continue;
                let id = profile['secret-id'];
                if (!id) continue;
                if (!allSecrets.some(secret => secret.id === id)) {
                    const candidates = allSecrets.filter(secret => secret.label === id);
                    if (candidates.length !== 1) continue;
                    id = candidates[0].id;
                    profile['secret-id'] = id;
                    api.saveSettingsDebounced();
                }
                const names = owners.get(id) || new Set(); names.add(profile.name); owners.set(id, names);
            }
            for (const [key, entries] of Object.entries(secrets.secret_state)) {
                if (!Array.isArray(entries)) continue;
                for (const secret of entries) {
                    const names = owners.get(secret.id);
                    if (!names) continue;
                    const label = [...names].sort((a, b) => a.localeCompare(b)).join(' / ');
                    if (secret.label === label) continue;
                    await secrets.renameSecret(key, secret.id, label);
                    if (secrets.secret_state[key]?.find(entry => entry.id === secret.id)?.label !== label) {
                        warn('密钥名称同步失败，密钥内容与方案配置保留；下次保存方案时会重试。');
                    }
                }
            }
        }).catch(() => warn('密钥名称暂时无法同步，请稍后重新保存方案。'));
        return namingQueue;
    }
    let operation = null;
    let pendingCommand = false;
    const warn = message => window.toastr.warning(message, '连接方案', { preventDuplicates: true });
    const busyMessage = () => operation?.failed || operation?.timedOut
        ? '方案操作未完成，已暂停修改以防配置串用。请重新载入页面后重试。'
        : '正在加载或保存连接方案，请完成后再操作。';
    const blocked = () => { warn(busyMessage()); return false; };
    const status = document.createElement('div');
    status.id = 'jg-connection-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    select.parentElement.after(status);
    const note = document.createElement('div');
    note.id = 'jg-connection-note';
    note.setAttribute('role', 'status');
    status.after(note);

    // 输入框中的新密钥还未写入原版密钥库。此时保存方案只会读到旧 secret-id。
    // 不复制密钥到方案或扩展设置，也不替用户丢弃尚未保存的输入。
    function pendingSecretProblem() {
        return api.main_api === 'openai' && oai_settings.chat_completion_source === 'custom' &&
            document.getElementById('api_key_custom')?.value.trim()
            ? '密钥尚未保存。请先点击“连接”，等待完成后再保存、新建或切换方案；如不需要此密钥，请先清空输入框。' : '';
    }
    function sharedMessage(profile) {
        const labels = { api: 'API 类型', 'api-url': 'API 地址', model: '模型', 'secret-id': '密钥' };
        const shared = (profile?.exclude || []).filter(field => labels[field]).map(field => labels[field]);
        return shared.length ? `“${profile.name}”已排除${shared.join('、')}，切换时会沿用当前值。若要独立保存，请在方案编辑中勾选这些项目，填入正确内容后保存。` : '';
    }
    function refreshNote() {
        const profile = profileById(currentId());
        const changed = profile && (!matches(profile) || pendingSecretProblem());
        const guidance = changed
            ? `当前修改尚未保存到“${profile.name}”。点击保存会覆盖该方案；要配置另一方案，请点击新建。`
            : '修改地址、模型或密钥后，请保存到当前方案，或新建为另一方案。仅点击“连接”不会更新已保存的方案。';
        note.textContent = sharedMessage(profile) || guidance;
    }

    function problem(profile) {
        if (!profile) return '';
        const excluded = new Set(profile.exclude || []);
        const custom = profile.mode === 'cc' && (profile.api === 'custom' || (!profile.api && oai_settings.chat_completion_source === 'custom'));
        if (!custom) return '';
        const missing = [];
        if (!excluded.has('api-url') && !profile['api-url']) missing.push('API 地址');
        if (!excluded.has('model') && !profile.model) missing.push('模型');
        const keys = secrets.secret_state[secrets.SECRET_KEYS.CUSTOM] || [];
        if (!excluded.has('secret-id')) {
            if (profile['secret-id'] && !keys.some(key => key.id === profile['secret-id'] || key.label === profile['secret-id'])) missing.push('有效的密钥引用');
            else if (!profile['secret-id'] && keys.some(key => key.active)) missing.push('密钥引用');
        }
        return missing.length ? `该方案缺少${missing.join('、')}，已取消切换，避免沿用上一方案。可先选“无方案”手动配置，再新建方案；需要共享的项目请在方案编辑中明确排除。` : '';
    }
    function matches(profile) {
        if (!profile || profile.mode !== 'cc' || profile.api !== 'custom') return true;
        const excluded = new Set(profile.exclude || []);
        if (oai_settings.chat_completion_source !== 'custom') return false;
        if (!excluded.has('api-url') && profile['api-url'] && oai_settings.custom_url !== profile['api-url']) return false;
        if (!excluded.has('model') && profile.model && oai_settings.custom_model !== profile.model) return false;
        if (!excluded.has('secret-id') && profile['secret-id']) {
            const active = secrets.secret_state[secrets.SECRET_KEYS.CUSTOM]?.find(key => key.active);
            if (active?.id !== profile['secret-id'] && active?.label !== profile['secret-id']) return false;
        }
        return true;
    }

    function begin(kind, id, name) {
        const token = { kind, id, name, timedOut: false, timer: null, done: null, resolve: null };
        token.expected = kind === 'load' ? structuredClone(profileById(id)) : null;
        token.done = new Promise(resolve => { token.resolve = resolve; });
        operation = token;
        select.setAttribute('aria-busy', 'true');
        status.hidden = false;
        status.textContent = kind === 'connect' ? '正在连接并保存密钥，请稍候…'
            : kind === 'update' ? '正在保存连接方案…' : '正在加载连接方案，请稍候…';
        token.timer = setTimeout(() => {
            if (operation !== token) return;
            token.timedOut = true;
            token.resolve(false);
            status.textContent = busyMessage();
            warn(busyMessage());
        }, 30000);
        return token;
    }
    function finish(token) {
        if (operation !== token) return;
        clearTimeout(token.timer);
        operation = null;
        token.resolve(true);
        select.removeAttribute('aria-busy');
        status.hidden = true;
        refreshNote();
    }
    const cancel = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const controls = '#rm_api_block, #openai_api, #ai-config-block, #settings_preset_openai';
    function allowInteraction(element) {
        if (operation && element?.closest(controls)) return blocked();
        return true;
    }

    // 捕获阶段早于原版 change 监听；阻止第二次切换进入原版的取消/重入路径。
    select.addEventListener('change', event => {
        if (operation) {
            cancel(event); select.value = currentId(); blocked(); return;
        }
        const profile = profileById(select.value);
        const error = pendingSecretProblem() || problem(profile);
        if (error) {
            cancel(event); select.value = currentId(); warn(error); return;
        }
        if (select.value && !profile) {
            cancel(event); select.value = currentId(); warn('该连接方案已不存在，请重新选择。'); return;
        }
        const sharing = sharedMessage(profile);
        if (sharing) warn(sharing);
        begin('load', select.value, profile?.name || '<None>');
    }, true);

    // 不能只加 disabled 样式：原版按钮为 <i>，脚本也能触发点击。
    document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const connect = target.closest('#api_button_openai');
        const control = target.closest('#update_connection_profile, #reload_connection_profile, #create_connection_profile, #edit_connection_profile, #delete_connection_profile');
        if (operation && (connect || control || target.closest('#send_but') || (event.isTrusted && target.closest(controls)))) {
            cancel(event); blocked(); return;
        }
        if (connect) {
            cancel(event);
            const token = begin('connect', currentId(), profileById(currentId())?.name || '<None>');
            // 原版的 jQuery 连接处理器返回 Promise，覆盖密钥写入和模型列表读取。
            // triggerHandler 不再派发原生点击，因此既能等待完整流程，也不会重复连接。
            Promise.resolve().then(() => window.jQuery(connect).triggerHandler('click')).then(() => {
                finish(token);
                const error = pendingSecretProblem();
                if (error) warn(error);
            }).catch(() => {
                clearTimeout(token.timer);
                token.failed = true;
                token.resolve(false);
                status.textContent = busyMessage();
                warn(busyMessage());
            });
            return;
        }
        if (control) {
            const error = pendingSecretProblem();
            if (error) { cancel(event); warn(error); return; }
        }
        if (!control || !['update_connection_profile', 'reload_connection_profile'].includes(control.id)) return;
        const profile = profileById(currentId());
        if (!profile) return;
        if (control.id === 'reload_connection_profile') {
            const error = problem(profile);
            if (error) { cancel(event); warn(error); return; }
        }
        begin(control.id === 'update_connection_profile' ? 'update' : 'load', profile.id, profile.name);
    }, true);
    document.addEventListener('keydown', event => {
        if (!operation) return;
        if ((event.key === 'Enter' && event.target?.id === 'send_textarea') ||
            (!['Tab', 'Escape'].includes(event.key) && event.target instanceof Element && event.target.closest(controls))) { cancel(event); blocked(); }
    }, true);
    // 用户在加载期间输入的半成品不进入原版保存；原版程序化填值仍可正常执行。
    document.addEventListener('beforeinput', event => {
        if (operation && event.isTrusted && event.target instanceof Element && event.target.closest(controls)) { cancel(event); blocked(); }
    }, true);

    api.eventSource.makeFirst(api.event_types.CONNECTION_PROFILE_LOADED, name => {
        const token = operation;
        if (token?.kind === 'connect') return;
        if (!token || name !== token.name || currentId() !== token.id) return;
        // 下一轮任务复核关键字段；密钥切换失败时原版也可能发出 loaded。
        setTimeout(() => {
            if (operation !== token) return;
            if (!matches(token.expected)) {
                clearTimeout(token.timer);
                token.failed = true;
                token.resolve(false);
                status.textContent = '方案加载结果不一致，已暂停保存和发送。请重新载入页面后检查方案配置。';
                warn(status.textContent);
                return;
            }
            finish(token);
        }, 0);
    });
    // 扩展触发的生成也等方案操作结束，不能在名称与配置暂不一致时组装请求。
    api.eventSource.makeFirst(api.event_types.GENERATION_AFTER_COMMANDS, async (_type, _options, dryRun) => {
        const token = operation;
        if (!token || dryRun) return;
        if (!await token.done) { api.stopGeneration(); warn(busyMessage()); }
    });

    // /profile 与 /profile-update 是扩展常用入口，同样不能越过 UI 的保护。
    for (const name of ['profile', 'profile-update', 'profile-create']) {
        const command = SlashCommandParser.commands[name];
        if (!command) continue;
        const original = command.callback;
        command.callback = async (args, value) => {
            if (name === 'profile' && !value) return original(args, value);
            if (operation || pendingCommand) { blocked(); throw new Error('连接方案正在加载或保存，请稍后重试。'); }
            const pendingError = pendingSecretProblem();
            if (pendingError) { warn(pendingError); throw new Error(pendingError); }
            if (name === 'profile' && value !== '<None>') {
                const profile = manager().profiles.find(p => p.name === value) || new Fuse(manager().profiles, { keys: ['name'] }).search(value)[0]?.item;
                const error = problem(profile);
                if (error) { warn(error); throw new Error(error); }
            }
            pendingCommand = true;
            let token;
            if (name !== 'profile') {
                const profile = profileById(currentId());
                token = begin('update', currentId(), profile?.name || '<None>');
            }
            try { return await original(args, value); }
            finally { pendingCommand = false; if (token) finish(token); }
        };
    }
    document.addEventListener('input', event => {
        if (event.target instanceof Element && event.target.matches('#custom_api_url_text, #custom_model_id, #api_key_custom')) {
            setTimeout(refreshNote, 0);
        }
    });
    for (const event of [api.event_types.CONNECTION_PROFILE_CREATED, api.event_types.CONNECTION_PROFILE_UPDATED,
        api.event_types.CONNECTION_PROFILE_LOADED, api.event_types.SECRET_WRITTEN, api.event_types.SECRET_ROTATED]) {
        if (event) api.eventSource.on(event, () => { setTimeout(refreshNote, 0); });
    }
    for (const event of [api.event_types.CONNECTION_PROFILE_CREATED, api.event_types.CONNECTION_PROFILE_UPDATED,
        api.event_types.CONNECTION_PROFILE_DELETED]) api.eventSource.on(event, syncSecretNames);
    // 连接时尚未命名的新方案暂标为“未绑定方案”；创建/保存/改名后统一跟随方案名。
    api.eventSource.on(api.event_types.SECRET_WRITTEN, async key => {
        const active = secrets.secret_state[key]?.find(entry => entry.active);
        if (!active) return;
        if (!manager().profiles.some(profile => profile['secret-id'] === active.id)) {
            await secrets.renameSecret(key, active.id, '未绑定方案');
        }
        await syncSecretNames();
    });
    void syncSecretNames();
    refreshNote();
    return { allowInteraction, syncSecretNames };
}
