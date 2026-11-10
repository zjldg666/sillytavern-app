// 手机导航扩展：所有聊天、角色编辑和设置操作都交给原版 SillyTavern。
(async () => {
    const api = await import('/script.js');
    const groupApi = await import('/scripts/group-chats.js');
    await new Promise(resolve => api.eventSource.on(api.event_types.APP_READY, resolve));
    if (document.getElementById('jg-app')) return;
    const { power_user } = await import('/scripts/power-user.js');
    const { extension_settings } = await import('/scripts/extensions.js');
    const { installConnectionGuard } = await import('/scripts/extensions/third-party/jiuguan-mobile/connection-guard.js');
    const connectionGuard = await installConnectionGuard();
    const { installChatDisplay } = await import('/scripts/extensions/third-party/jiuguan-mobile/chat-display.js');
    await installChatDisplay();
    // 设置区展开/收起直接到最终布局；保留原版队列与完成回调。
    // 使用 jQuery 动画扩展点，不影响聊天正文或 iframe 内的动画。
    window.jQuery.Animation.prefilter(function (element, properties, options) {
        if (!document.documentElement.classList.contains('jg-app') || !(element instanceof Element)) return;
        if (element.closest('#chat') || !element.closest('.drawer-content, dialog.popup, #options, #extensionsMenu')) return;
        if (!Object.values(properties).some(value => ['show', 'hide', 'toggle'].includes(value))) return;
        const layoutChange = Object.keys(properties).some(key => /^(height|width|margin|padding)/i.test(key));
        this.duration = options.duration = layoutChange ? 0 : Math.min(options.duration, 90);
    }, true);
    const personas = await import('/scripts/personas.js');
    // 只调整原版显示分页，不修改聊天数组、保存文件或模型上下文预算。
    const mobileSettings = extension_settings.jiuguan_mobile ??= {};
    if (!mobileSettings.displayLimitInitialized) {
        if (!power_user.chat_truncation || power_user.chat_truncation > 20) {
            window.jQuery('#chat_truncation').val(20).trigger('input');
        }
        mobileSettings.displayLimitInitialized = true;
        api.saveSettingsDebounced();
    }
    // 会话备注名只用于列表显示，不改聊天文件名或内容。键为“角色/群聊 + 文件名”。
    const chatNames = mobileSettings.chatNames ??= {};
    const chatKey = (item, file) => item.avatar ? `c:${item.avatar}/${file}` : `g:${item.group}/${file}`;
    // 外观：跟随系统 / 白天 / 黑夜。安卓宿主提供系统深浅色并同步系统栏、启动页颜色；桌面浏览器退回媒体查询。
    const nativeBridge = window.JiuguanNative;
    const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const themeModes = [['system', '跟随系统'], ['light', '白天'], ['dark', '黑夜']];
    const systemDark = () => {
        try { if (typeof nativeBridge?.systemDark === 'function') return Boolean(nativeBridge.systemDark()); } catch { /* 退回媒体查询 */ }
        return darkQuery.matches;
    };
    function applyTheme() {
        const mode = themeModes.some(([id]) => id === mobileSettings.theme) ? mobileSettings.theme : 'system';
        const dark = mode === 'dark' || (mode === 'system' && systemDark());
        document.documentElement.dataset.jgTheme = dark ? 'dark' : 'light';
        try { nativeBridge?.setTheme?.(mode, dark); } catch (error) { console.warn('[酒馆手机 UI] 系统栏颜色同步失败', error); }
    }
    darkQuery.addEventListener('change', applyTheme);
    applyTheme();    // OpenCode 快捷入口沿用原版自定义来源，不增加上游不认识的持久化来源值。
    const sourceSelect = document.querySelector('#chat_completion_source');
    if (sourceSelect && !sourceSelect.querySelector('[value="jiuguan_opencode_go"]')) {
        const option = document.createElement('option');
        option.value = 'jiuguan_opencode_go';
        option.textContent = 'OpenCode Go（自定义接口快捷配置）';
        sourceSelect.options.add(option);
        sourceSelect.addEventListener('change', event => {
            if (sourceSelect.value !== option.value) return;
            event.stopImmediatePropagation();
            window.jQuery(sourceSelect).val('custom').trigger('change');
            window.jQuery('#custom_api_url_text').val('https://opencode.ai/inference/go/openai/v1').trigger('input');
            window.toastr.info('已切换至自定义接口并填写 OpenCode Go 地址。请填写 API Key 和模型 ID。Go 面向编码代理，普通聊天可能受到服务限制。');
        }, true);
    }
    // 原版在发送前提供请求事件；只为 OpenCode Go 请求添加当前聊天的稳定标识。
    api.eventSource.on(api.event_types.CHAT_COMPLETION_SETTINGS_READY, async data => {
        if (data.chat_completion_source !== 'custom') return;
        let url;
        try { url = new URL(data.custom_url); } catch { return; }
        if (url.protocol !== 'https:' || url.hostname !== 'opencode.ai' ||
            !/^\/(?:inference|zen)\/go\//.test(url.pathname)) return;
        const headers = String(data.custom_include_headers || '').trim();
        if (/^\s*["']?x-opencode-session["']?\s*:/im.test(headers)) return;
        let session = api.chat_metadata?.integrity;
        if (!session) {
            session = crypto.randomUUID();
            api.chat_metadata.integrity = session;
            await api.saveMetadata();
        }
        if (headers.startsWith('{')) {
            try {
                const parsed = JSON.parse(headers);
                if (Object.keys(parsed).some(key => key.toLowerCase() === 'x-opencode-session')) return;
                parsed['x-opencode-session'] = session;
                data.custom_include_headers = JSON.stringify(parsed);
                return;
            } catch { /* 原版会报告无效的请求头格式。 */ }
        }
        data.custom_include_headers = `${headers}${headers ? '\n' : ''}x-opencode-session: "${session}"`;
    });
    const ctx = () => window.SillyTavern.getContext();
    const $ = selector => document.querySelector(selector);
    const icons = {
        people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
        chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8z"/>',
        settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
        import: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>',
        back: '<path d="m14 5-7 7 7 7"/>',
        more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
        chevron: '<path d="m9 5 7 7-7 7"/>',
        plug: '<path d="M9 3v5m6-5v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4"/>',
        book: '<path d="M4 3h13a3 3 0 0 1 3 3v15H7a3 3 0 0 1-3-3V3zm0 14h16M8 7h7M8 11h5"/>',
        box: '<path d="m12 3 9 5-9 5-9-5 9-5zm-9 5v9l9 5 9-5V8M12 13v9"/>',
        grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
        trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
        sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
        code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
        image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
        list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
        swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
        check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
        theme: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/>',
    };
    const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${icons[name] || icons.settings}</svg>`;
    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    const button = (label, symbol, action, className = 'jg-icon-button') => {
        const el = node('button', className);
        el.type = 'button'; el.title = label; el.setAttribute('aria-label', label);
        if (symbol) el.innerHTML = icon(symbol);
        if (className !== 'jg-icon-button') el.append(node('span', '', label));
        el.addEventListener('click', action);
        return el;
    };
    // 长按 500ms 触发；手指移动或页面滚动即取消。返回的点击包装会忽略长按松手后的那次点击。
    function longPress(el, action) {
        let timer, startX = 0, startY = 0, fired = false;
        const cancel = () => clearTimeout(timer);
        const fire = () => { cancel(); if (fired) return; fired = true; action(); };
        el.addEventListener('pointerdown', event => {
            if (event.button) return;
            fired = false; startX = event.clientX; startY = event.clientY;
            cancel(); timer = setTimeout(fire, 500);
        });
        el.addEventListener('pointermove', event => { if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel(); });
        for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, cancel);
        // 安卓 WebView 的长按也会派发 contextmenu；屏蔽系统菜单并直接触发。
        el.addEventListener('contextmenu', event => { event.preventDefault(); fire(); });
        return tap => () => { if (fired) { fired = false; return; } tap(); };
    }
    const plain = value => new DOMParser().parseFromString(String(value ?? ''), 'text/html').body.textContent.trim();
    const notify = message => window.toastr.info(message);
    let view = 'chats', homeTab = 'chats', panelReturn = 'settings', chatReturn = 'chats';
    let busy = false, navigating = false, currentPanel, recent = [], query = '', requestId = 0;
    let homeNavigation = Promise.resolve();
    let worldEditorName = '', worldListScroll = 0;
    document.body.dataset.jgWorldMode = 'list';
    function showWorldLibrary() {
        worldEditorName = '';
        document.body.dataset.jgWorldMode = 'list';
        if (view === 'worlds') header();
        if ($('#WorldInfo')) $('#WorldInfo').scrollTop = worldListScroll;
    }

    const shell = node('div', 'jg-ui'); shell.id = 'jg-app';
    shell.innerHTML = `<header id="jg-header"></header><main id="jg-content"></main><nav id="jg-nav" aria-label="主导航"></nav>`;
    const menu = document.createElement('dialog'); menu.id = 'jg-menu'; menu.className = 'jg-ui';
    // 让弹出菜单自身获得焦点，避免第一行被自动聚焦并显示焦点框。
    menu.tabIndex = -1; menu.autofocus = true;
    menu.addEventListener('click', event => { if (event.target === menu) menu.close(); });
    // 原版在 html 上监听按下事件，点到抽屉外就收起抽屉；手机外壳与底部菜单里的点击不应收起正在显示的设置面板。
    for (const element of [shell, menu]) for (const type of ['touchstart', 'mousedown']) element.addEventListener(type, event => event.stopPropagation());
    document.body.append(shell, menu);
    document.documentElement.classList.add('jg-app');

    // 标题居中：左右各留一个按钮位，没有按钮时用占位保持对称。
    function header() {
        const el = $('#jg-header'); el.replaceChildren();
        const slot = () => node('span', 'jg-header-slot');
        const block = node('div', 'jg-heading');
        if (view === 'worlds' && worldEditorName) {
            block.append(node('h1', '', worldEditorName));
            el.append(button('返回世界书列表', 'back', showWorldLibrary), block, slot());
        } else if (view === 'chat' || view === 'panel') {
            const title = view === 'panel' ? currentPanel?.label : (ctx().groupId ? ctx().groups.find(g => g.id === ctx().groupId)?.name : ctx().characters[ctx().characterId]?.name);
            block.append(node('h1', '', title || '聊天'));
            el.append(button('返回', 'back', back), block,
                view === 'chat' ? button('聊天菜单', 'more', chatMenu) : button('工具与设置', 'grid', openSettings));
        } else {
            block.append(node('h1', '', { roles: '角色', chats: '聊天', worlds: '世界书', settings: '设置' }[view]));
            el.append(slot(), block, view === 'chats' ? button('选择角色开始聊天', 'plus', () => show('roles')) : slot());
        }
    }

    function nav() {
        const el = $('#jg-nav'); el.replaceChildren();
        for (const [id, label, symbol] of [['chats', '聊天', 'chat'], ['roles', '角色', 'people'], ['worlds', '世界书', 'book'], ['settings', '设置', 'user']]) {
            const tab = button(label, symbol, () => { if (id === 'worlds') showWorldLibrary(); void navigateHome(id); }, 'jg-tab'); tab.dataset.tab = id;
            tab.setAttribute('aria-current', view === id ? 'page' : 'false'); el.append(tab);
        }
    }

    async function closeDrawers() {
        for (const panel of document.querySelectorAll('#top-settings-holder > .drawer > .drawer-content.openDrawer')) {
            const toggle = panel.parentElement.querySelector(':scope > .drawer-toggle');
            if (toggle) await api.doNavbarIconClick.call(toggle);
        }
    }

    // 世界书是一级页面，沿用原版编辑器；切换底部导航时收起旧抽屉。
    // 顺序处理快速点击，避免两次切换同时翻转同一个原版抽屉。
    function navigateHome(next) {
        homeNavigation = homeNavigation.then(async () => {
            if (view === next && (next !== 'worlds' || $('#WorldInfo')?.classList.contains('openDrawer'))) return;
            navigating = true;
            try {
                await closeDrawers();
                show(next);
                if (next === 'worlds') await api.doNavbarIconClick.call($('#WI-SP-button > .drawer-toggle'));
            } finally { navigating = false; }
        }).catch(error => { console.error('[酒馆手机 UI] 导航失败', error); notify('页面打开失败，请重新点击底部导航。'); });
        return homeNavigation;
    }

    function show(next) {
        view = next; document.body.dataset.jgView = next;
        if (['roles', 'chats', 'worlds', 'settings'].includes(next)) homeTab = next;
        shell.setAttribute('aria-busy', String(busy));
        header(); nav();
        if (next === 'roles') renderRoles();
        if (next === 'chats') renderChats();
        if (next === 'settings') renderSettings();
        if (next === 'chat' || next === 'worlds') { $('#jg-content').replaceChildren(); }
    }

    function searchBox(placeholder, onInput) {
        const label = node('label', 'jg-search'); label.innerHTML = icon('search');
        const input = node('input'); input.type = 'search'; input.placeholder = placeholder; input.setAttribute('aria-label', placeholder);
        input.addEventListener('input', () => onInput(input.value.trim().toLocaleLowerCase()));
        label.append(input); return label;
    }

    function empty(container, title, detail, action) {
        const el = node('div', 'jg-empty'); el.innerHTML = icon('people');
        el.append(node('h2', '', title), node('p', '', detail));
        if (action) el.append(action);
        container.append(el);
    }

    function renderRoles() {
        query = '';
        const content = $('#jg-content'); content.replaceChildren();
        const tools = node('div', 'jg-search-row');
        tools.append(
            searchBox('搜索角色', value => { query = value; roleGrid(); }),
            button('导入角色卡', 'import', importCard),
            button('添加角色', 'plus', addMenu),
        );
        content.append(tools);
        const section = node('div', 'jg-section-label');
        section.append(node('span', '', '我的角色'), node('span', 'jg-count', String(ctx().characters.length)));
        content.append(section);
        const grid = node('div', 'jg-role-grid'); grid.id = 'jg-role-grid'; content.append(grid);
        roleGrid();
    }

    function roleGrid() {
        const grid = $('#jg-role-grid'); if (!grid) return; grid.replaceChildren();
        const count = $('#jg-content .jg-count');
        if (count) count.textContent = String(ctx().characters.length);
        const items = ctx().characters.filter(char => char.name?.toLocaleLowerCase().includes(query));
        for (const char of items) {
            const card = node('article', 'jg-role-card'); card.dataset.avatar = char.avatar;
            const open = button(`与 ${char.name} 聊天`, null, () => openRole(char.avatar), 'jg-role-open');
            open.replaceChildren();
            const portrait = node('div', 'jg-portrait');
            const img = node('img'); img.src = `/characters/${encodeURIComponent(char.avatar)}`; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
            img.addEventListener('error', () => { img.hidden = true; }, { once: true });
            portrait.append(img);
            const copy = node('div', 'jg-role-copy'); copy.append(node('h2', '', char.name));
            if (char.data?.creator) copy.append(node('span', '', `由 ${char.data.creator} 创建`));
            open.append(portrait, copy);
            const more = button(`${char.name} 的选项`, 'more', () => roleMenu(char.avatar)); more.classList.add('jg-role-more');
            card.append(open, more); grid.append(card);
        }
        if (!items.length) empty(grid, query ? '没有找到角色' : '添加你的第一位角色', query ? '试试其他名字。' : '导入角色卡，或从头创建一个角色。', query ? undefined : button('导入角色卡', 'import', importCard, 'jg-primary'));
        if (ctx().groups.length && !query) grid.append(button(`群聊 · ${ctx().groups.length}`, 'people', () => openPanel('rightNavHolder', '角色与群聊', () => $('#rm_button_characters')?.click()), 'jg-group-entry'));
    }

    function shortTime(moment) {
        const now = window.moment();
        if (moment.isSame(now, 'day')) return moment.format('HH:mm');
        if (moment.isSame(now.clone().subtract(1, 'day'), 'day')) return '昨天';
        if (moment.isSame(now, 'year')) return moment.format('M月D日');
        return moment.format('YYYY/M/D');
    }

    async function loadRecent() {
        const response = await fetch('/api/chats/recent', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({}), cache: 'no-store' });
        if (!response.ok) throw new Error('聊天列表暂时无法读取，请重试。');
        const value = await response.json();
        if (!Array.isArray(value)) throw new Error('聊天列表格式异常。');
        return value;
    }

    async function renderChats() {
        const serial = ++requestId;
        const content = $('#jg-content'); content.replaceChildren();
        let filter = '';
        content.append(searchBox('搜索角色或会话', value => { filter = value; fill(); }));
        const list = node('div', 'jg-chat-list'); list.setAttribute('aria-live', 'polite'); content.append(list);
        list.append(node('p', 'jg-muted', '正在读取聊天…'));
        function fill() {
            list.replaceChildren();
            // 同一角色有多段会话时才显示会话名，避免列表混淆又保持简洁。
            const owners = recent.map(item => item.avatar || item.group || '');
            const repeated = new Set(owners.filter((owner, index) => owners.indexOf(owner) !== index));
            for (const item of recent) {
                const character = ctx().characters.find(char => char.avatar === item.avatar);
                const group = ctx().groups.find(group => group.id === item.group);
                const name = character?.name || group?.name || '助手对话';
                const file = item.file_name.replace(/\.jsonl$/, '');
                const key = chatKey(item, file), alias = chatNames[key];
                if (filter && !`${name} ${file} ${alias || ''}`.toLocaleLowerCase().includes(filter)) continue;
                const row = button(`打开 ${name} 的 ${alias || file}`, null, () => tap(), 'jg-chat-row'); row.replaceChildren();
                row.dataset.chat = item.file_name;
                const tap = longPress(row, () => chatItemMenu(item, name, file))(() => openRecent(item));
                const avatar = node('div', 'jg-chat-avatar');
                if (character) { const img = node('img'); img.src = ctx().getThumbnailUrl('avatar', character.avatar); img.alt = ''; img.loading = 'lazy'; avatar.append(img); }
                else avatar.innerHTML = icon(group ? 'people' : 'chat');
                const text = node('div', 'jg-chat-copy');
                const line = node('div', 'jg-chat-title');
                const timestamp = ctx().timestampToMoment(item.last_mes);
                line.append(node('strong', '', alias || name), node('time', '', timestamp.isValid() ? shortTime(timestamp) : ''));
                text.append(line, node('p', '', plain(item.mes).slice(0, 180) || '暂无消息'));
                if (alias) text.append(node('small', '', name));
                else if (repeated.has(item.avatar || item.group || '')) text.append(node('small', '', file));
                row.append(avatar, text); list.append(row);
            }
            if (!list.children.length) empty(list, filter ? '没有找到会话' : '还没有聊天', filter ? '试试角色名或会话名。' : '选一位角色，开启第一段对话。', button('去看角色', 'people', () => show('roles'), 'jg-primary'));
        }
        try {
            const data = await loadRecent();
            if (view !== 'chats' || serial !== requestId) return;
            recent = data; fill();
        } catch (error) {
            if (view !== 'chats' || serial !== requestId) return;
            list.replaceChildren(node('p', 'jg-muted', error.message), button('重新加载', 'chat', renderChats, 'jg-primary'));
        }
    }

    // 每项：标题、说明、图标、原版抽屉 ID。
    const settings = [
        ['模型与生成', [
            ['模型 API', '连接服务与模型', 'plug', 'sys-settings-button'],
            ['预设与生成参数', '提示词预设、采样与上下文', 'sliders', 'ai-config-button'],
            ['提示词格式', '格式模板与高级选项', 'code', 'advanced-formatting-button'],
        ]],
        ['角色与内容', [
            ['角色与群聊', '角色资料、群聊与会话管理', 'people', 'rightNavHolder'],
            ['正则与扩展', '正则脚本、快捷回复与扩展管理', 'box', 'extensions-settings-button'],
            ['用户人设', '你的名字、头像与人设', 'user', 'persona-management-button'],
        ]],
        ['应用', [
            ['显示、账户与数据', '显示偏好、账户及数据管理', 'settings', 'user-settings-button'],
            ['背景', '管理聊天背景', 'image', 'backgrounds-button'],
        ]],
    ];

    function cell(title, subtitle, symbol, action, extra) {
        const row = button(title, symbol, action, 'jg-setting-row'); row.replaceChildren();
        const glyph = node('span', 'jg-setting-icon'); glyph.innerHTML = icon(symbol);
        const copy = node('span', 'jg-setting-copy'); copy.append(node('strong', '', title));
        if (subtitle) copy.append(node('small', '', subtitle));
        row.append(glyph, copy);
        if (extra) row.append(extra);
        const arrow = node('span', 'jg-chevron'); arrow.innerHTML = icon('chevron'); row.append(arrow);
        return row;
    }

    function profileCard() {
        const card = button('用户人设', null, () => openPanel('persona-management-button', '用户人设'), 'jg-profile'); card.replaceChildren();
        const avatar = node('span', 'jg-profile-avatar');
        if (personas.user_avatar) {
            const img = node('img'); img.src = ctx().getThumbnailUrl('persona', personas.user_avatar); img.alt = '';
            img.addEventListener('error', () => { avatar.innerHTML = icon('user'); }, { once: true });
            avatar.append(img);
        } else avatar.innerHTML = icon('user');
        const copy = node('span', 'jg-profile-copy');
        copy.append(node('strong', '', ctx().name1 || '我'), node('small', '', plain(power_user.persona_description).slice(0, 60) || '点击编辑名字、头像与人设'));
        const arrow = node('span', 'jg-chevron'); arrow.innerHTML = icon('chevron');
        card.append(avatar, copy, arrow);
        return card;
    }

    function renderSettings() {
        const content = $('#jg-content'); content.replaceChildren();
        content.append(profileCard());
        for (const [label, entries] of settings) {
            const section = node('section', 'jg-setting-section'); section.append(node('h2', 'jg-section-label', label));
            const group = node('div', 'jg-cell-group');
            for (const [title, subtitle, symbol, target] of entries) {
                const row = cell(title, subtitle, symbol, () => openPanel(target, title));
                row.dataset.panel = target; group.append(row);
            }
            section.append(group); content.append(section);
        }
        const more = node('section', 'jg-setting-section'); more.append(node('h2', 'jg-section-label', '更多'));
        const group = node('div', 'jg-cell-group');
        const selectRow = (symbol, title, subtitle, options, value, onChange) => {
            const select = node('select'); select.setAttribute('aria-label', title);
            for (const [id, label] of options) { const option = node('option', '', label); option.value = id; select.append(option); }
            select.value = value;
            select.addEventListener('change', () => onChange(select.value));
            const row = node('label', 'jg-setting-row jg-select-setting');
            const glyph = node('span', 'jg-setting-icon'); glyph.innerHTML = icon(symbol);
            const copy = node('span', 'jg-setting-copy'); copy.append(node('strong', '', title));
            if (subtitle) copy.append(node('small', '', subtitle));
            row.append(glyph, copy, select);
            return row;
        };
        group.append(selectRow('theme', '外观', '白天或黑夜，默认跟随系统', themeModes, mobileSettings.theme || 'system', value => {
            mobileSettings.theme = value; api.saveSettingsDebounced(); applyTheme();
        }));
        const counts = [...new Set([20, 40, 100, Number(power_user.chat_truncation)])].sort((a, b) => a - b)
            .map(count => [String(count), count ? `最近 ${count} 条` : '全部']);
        group.append(selectRow('list', '聊天显示条数', '较早记录可向上加载，不改变模型上下文；重新进入聊天后生效', counts, String(power_user.chat_truncation), value => {
            window.jQuery('#chat_truncation').val(Number(value)).trigger('input');
        }));        // 扩展新增的顶部工具直接显示在设置页，已有入口不重复。
        const known = new Set(settings.flatMap(([, rows]) => rows.map(row => row[3])));
        known.add('WI-SP-button');
        for (const drawer of document.querySelectorAll('#top-settings-holder > .drawer')) {
            if (known.has(drawer.id) || !drawer.querySelector(':scope > .drawer-toggle')) continue;
            const name = drawer.querySelector('[title]')?.title || '扩展工具';
            const row = cell(name, '', 'box', () => openPanel(drawer.id, name));
            row.dataset.panel = drawer.id; group.append(row);
        }
        more.append(group); content.append(more);
        content.append(node('p', 'jg-version', '酒馆 · SillyTavern 1.19.0'));
    }

    async function guarded(action) {
        if (busy) return;
        if (api.isGenerating() || api.isChatSaving) { notify('请等待当前生成或保存完成后再切换会话。'); return; }
        busy = true; navigating = true; shell.setAttribute('aria-busy', 'true');
        try { await action(); }
        catch (error) { window.toastr.error(error.message || '操作失败，请重试。'); console.error('[酒馆 UI]', error); }
        finally { busy = false; navigating = false; shell.setAttribute('aria-busy', 'false'); }
    }

    async function selectRole(avatar) {
        const index = ctx().characters.findIndex(char => char.avatar === avatar);
        if (index < 0) throw new Error('这个角色已不存在，请刷新角色列表。');
        await ctx().selectCharacterById(index, { switchMenu: false });
        if (String(ctx().characterId) !== String(index) || ctx().groupId) throw new Error('当前会话暂时不能切换，请稍后重试。');
        api.setActiveCharacter(avatar); ctx().saveSettingsDebounced();
    }
    async function refreshDisplayLimit() {
        const limit = Number(power_user.chat_truncation);
        if (limit > 0 && document.querySelectorAll('#chat > .mes').length > limit) await ctx().reloadCurrentChat();
    }

    function openRole(avatar) {
        return guarded(async () => {
            const latest = (await loadRecent()).find(item => item.avatar === avatar);
            chatReturn = homeTab;
            await selectRole(avatar);
            if (latest) {
                const file = latest.file_name.replace(/\.jsonl$/, '');
                if (ctx().chatId !== file) await ctx().openCharacterChat(file);
            }
            await refreshDisplayLimit(); await closeDrawers(); show('chat'); ctx().scrollChatToBottom();
        });
    }

    function openRecent(item) {
        return guarded(async () => {
            const file = item.file_name.replace(/\.jsonl$/, ''); chatReturn = 'chats';
            if (item.avatar) {
                await selectRole(item.avatar);
                if (ctx().chatId !== file) await ctx().openCharacterChat(file);
            } else if (item.group) {
                await groupApi.openGroupById(item.group);
                if (ctx().groupId !== item.group) throw new Error('群聊暂时无法切换。');
                api.setActiveGroup(item.group); ctx().saveSettingsDebounced();
                if (ctx().chatId !== file) await ctx().openGroupChat(item.group, file);
            } else {
                throw new Error('这是一条未关联角色的旧会话，暂时无法打开；不会新建或覆盖聊天。');
            }
            await refreshDisplayLimit(); await closeDrawers(); show('chat'); ctx().scrollChatToBottom();
        });
    }

    async function openPanel(id, label, after) {
        if (id === 'WI-SP-button') { await navigateHome('worlds'); if (after) await after(); return; }
        const drawer = document.getElementById(id);
        const toggle = drawer?.querySelector(':scope > .drawer-toggle');
        if (!toggle) { notify('这个入口暂时不可用，请返回设置页重试。'); return; }
        const previous = view;
        navigating = true;
        try {
            await closeDrawers();
            panelReturn = previous === 'panel' ? panelReturn : previous;
            currentPanel = { id, label };
            show('panel');
            await api.doNavbarIconClick.call(toggle);
            if (after) await after();
        } finally { navigating = false; }
    }

    function sheet(title, actions) {
        menu.replaceChildren();
        const box = node('div', 'jg-sheet'); box.append(node('h2', '', title));
        const list = node('div', 'jg-sheet-list');
        for (const [label, , action, extra = ''] of actions) list.append(button(label, null, () => { menu.close(); action(); }, `jg-menu-row ${extra}`.trim()));
        box.append(list, button('取消', null, () => menu.close(), 'jg-sheet-cancel'));
        menu.append(box); menu.showModal();
    }
    // 原版下拉框的系统弹出列表无法定制样式；改为底部选择面板，选中后照常派发 input/change 事件。
    function selectLabel(select) {
        const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
        const direct = clean(select.getAttribute('aria-label')) || (select.id && clean(document.querySelector(`label[for="${CSS.escape(select.id)}"]`)?.textContent));
        if (direct) return direct;
        for (let el = select, depth = 0; el && depth < 3; el = el.parentElement, depth++) {
            const sibling = el.previousElementSibling;
            if (!sibling) continue;
            if (sibling.matches('select, input, textarea, button') || sibling.querySelector('select, input, textarea')) break;
            const text = clean(sibling.textContent);
            if (text) return text.length <= 40 ? text : '请选择';
        }
        return clean(select.title) || '请选择';
    }
    function picker(select) {
        if (!connectionGuard.allowInteraction(select)) return;
        menu.replaceChildren();
        const box = node('div', 'jg-sheet jg-picker'); box.append(node('h2', '', selectLabel(select)));
        const list = node('div', 'jg-sheet-list jg-pick-list');
        const rows = [];
        const visible = option => !option.hidden && getComputedStyle(option).display !== 'none';
        const add = option => {
            const row = button(option.textContent.replace(/\s+/g, ' ').trim() || option.value || '（空）', null, () => {
                menu.close();
                if (!connectionGuard.allowInteraction(select)) return;
                if (option.selected) return;
                option.selected = true;
                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }, 'jg-pick-row');
            row.disabled = option.disabled;
            if (option.selected) { row.setAttribute('aria-selected', 'true'); row.insertAdjacentHTML('beforeend', icon('check')); }
            rows.push(row); list.append(row);
        };
        for (const child of select.children) {
            if (child.tagName === 'OPTION') { if (visible(child)) add(child); continue; }
            if (child.tagName !== 'OPTGROUP') continue;
            const options = [...child.children].filter(option => option.tagName === 'OPTION' && visible(option));
            if (options.length && child.label.trim()) list.append(node('div', 'jg-pick-group', child.label.trim()));
            options.forEach(add);
        }
        box.append(list);
        if (rows.length > 12) {
            list.before(searchBox('搜索选项', value => {
                for (const row of rows) row.hidden = !row.textContent.toLocaleLowerCase().includes(value);
                for (const label of list.querySelectorAll('.jg-pick-group')) label.hidden = !!value;
            }));
        }
        box.append(button('取消', null, () => menu.close(), 'jg-sheet-cancel'));
        menu.append(box); menu.showModal();
        list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
    }
    const pickable = target => {
        const select = target instanceof Element ? target.closest('select') : null;
        if (!select || select.multiple || select.size > 1 || select.disabled || menu.contains(select)) return null;
        return document.documentElement.classList.contains('jg-app') ? select : null;
    };
    document.addEventListener('mousedown', event => { if (pickable(event.target)) event.preventDefault(); }, true);
    document.addEventListener('click', event => {
        const select = pickable(event.target);
        if (!select) return;
        // 延后一拍打开，让按需填充选项的原版/扩展点击处理先执行。
        event.preventDefault(); setTimeout(() => picker(select));
    }, true);
    // 原生多选框会把未选中的书也显示在“已启用”标题下。首页只显示实际启用项，
    // 候选书放入带复选框的独立面板；保存仍交给原版 world_info change 事件。
    const worldInfo = await import('/scripts/world-info.js');
    const globalWorldSelect = $('#world_info');
    if (globalWorldSelect) {
        globalWorldSelect.classList.add('jg-world-native');
        const title = $('#WIMultiSelector .range-block-title small');
        if (title) { title.removeAttribute('data-i18n'); title.textContent = '全局世界书'; }
        const summary = node('div', 'jg-world-summary');
        const count = node('strong'); count.id = 'jg-world-count'; count.setAttribute('aria-live', 'polite');
        const active = node('div', 'jg-world-active'); active.id = 'jg-world-active';
        const hint = node('div', 'jg-world-hint', '此处启用的书对所有聊天生效。角色自带的世界书仍按角色绑定。');
        summary.append(count, active, button('选择全局世界书', null, openGlobalWorldPicker, 'menu_button'), hint);
        globalWorldSelect.after(summary);
        let pickerList, pickerQuery = '';
        const availableWorlds = () => [...globalWorldSelect.options].filter(option => option.value !== '');
        function syncWorldScope() {
            const selected = new Set(worldInfo.selected_world_info);
            count.textContent = `全局已启用 ${selected.size} 本`;
            active.replaceChildren(...[...selected].map(name => node('div', '', name)));
            active.hidden = selected.size === 0;
            if (menu.open && menu.querySelector('.jg-world-picker')) {
                for (const input of pickerList.querySelectorAll('input')) {
                    input.checked = selected.has(input.dataset.world);
                    input.closest('label').querySelector('.jg-world-state').textContent = input.checked ? '已全局启用' : '未全局启用';
                }
            }
        }
        function renderWorldChoices() {
            if (!menu.open || !menu.querySelector('.jg-world-picker')) return;
            pickerList.replaceChildren();
            for (const option of availableWorlds()) {
                const name = option.textContent;
                const row = node('label', 'jg-world-choice');
                const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.world = name;
                input.disabled = option.disabled;
                const detail = node('span', 'jg-world-choice-detail');
                detail.append(node('span', '', name), node('small', 'jg-world-state'));
                row.append(input, detail); row.hidden = !name.toLocaleLowerCase().includes(pickerQuery);
                input.addEventListener('change', () => {
                    // 每次按书名解析最新选项，列表插入/排序后也不会误选相同索引的另一书。
                    const selected = new Set(worldInfo.selected_world_info);
                    if (input.checked) selected.add(name); else selected.delete(name);
                    for (const current of globalWorldSelect.options) current.selected = current.value !== '' && selected.has(current.textContent);
                    window.jQuery(globalWorldSelect).trigger('change');
                    syncWorldScope();
                });
                pickerList.append(row);
            }
            if (!pickerList.childElementCount) pickerList.append(node('p', 'jg-world-hint', '书库为空，请先导入世界书。'));
            syncWorldScope();
        }
        function openGlobalWorldPicker() {
            menu.replaceChildren(); pickerQuery = '';
            const box = node('div', 'jg-sheet jg-picker jg-world-picker');
            pickerList = node('div', 'jg-sheet-list jg-pick-list');
            box.append(node('h2', '', '选择全局世界书'),
                node('p', 'jg-world-hint', '勾选立即对所有聊天生效，取消勾选立即停用。'),
                searchBox('搜索可选世界书', value => {
                    pickerQuery = value;
                    for (const row of pickerList.querySelectorAll('label')) row.hidden = !row.querySelector('input').dataset.world.toLocaleLowerCase().includes(value);
                }), pickerList,
                button('完成', null, () => menu.close(), 'jg-sheet-cancel'));
            menu.append(box); menu.showModal(); renderWorldChoices();
        }
        window.jQuery(globalWorldSelect).on('change.jiuguanScope', syncWorldScope);
        api.eventSource.on(api.event_types.WORLDINFO_SETTINGS_UPDATED, syncWorldScope);
        // 导入、重命名、删除会重建原版候选列表；不因候选增加而自动勾选。
        new MutationObserver(() => { syncWorldScope(); renderWorldChoices(); }).observe(globalWorldSelect, { childList: true, subtree: true, characterData: true });
        syncWorldScope();
    }
    // 书库与编辑器分层，保留原版选择、导入、保存及管理事件。
    const worldEditorSelect = $('#world_editor_select');
    const worldLibrary = node('section', 'jg-ui jg-world-library'); worldLibrary.id = 'jg-world-library';
    const libraryHeading = node('div', 'jg-section-label');
    const libraryCount = node('span', 'jg-count');
    libraryHeading.append(node('strong', '', '全部世界书'), libraryCount);
    const libraryTools = node('div', 'jg-search-row');
    const libraryRows = node('div', 'jg-cell-group'); libraryRows.id = 'jg-world-list';
    let libraryQuery = '', librarySignature = '';
    libraryTools.append(searchBox('搜索世界书', value => { libraryQuery = value; renderWorldLibrary(); }),
        button('新建世界书', 'plus', () => $('#world_create_button').click()),
        button('导入世界书', 'import', () => $('#world_import_button').click()));
    worldLibrary.append(libraryHeading, libraryTools, libraryRows);
    $('#world_popup').before(worldLibrary);
    function renderWorldLibrary() {
        const signature = JSON.stringify([worldInfo.world_names, worldInfo.selected_world_info, libraryQuery]);
        if (signature === librarySignature) return;
        librarySignature = signature;
        libraryCount.textContent = `${worldInfo.world_names.length} 本`;
        libraryRows.replaceChildren();
        for (const name of worldInfo.world_names) {
            if (!name.toLocaleLowerCase().includes(libraryQuery)) continue;
            const row = cell(name, worldInfo.selected_world_info.includes(name) ? '已全局启用' : '', 'book', () => {
                const index = worldInfo.world_names.indexOf(name);
                if (index >= 0) window.jQuery(worldEditorSelect).val(String(index)).trigger('change');
            });
            row.dataset.world = name;
            libraryRows.append(row);
        }
        if (!libraryRows.childElementCount) libraryRows.append(node('p', 'jg-world-hint', libraryQuery ? '没有找到世界书' : '暂无世界书，点击上方按钮新建或导入。'));
    }
    window.jQuery(worldEditorSelect).on('change.jiuguanLibrary', () => {
        const name = worldEditorSelect.value === '' ? '' : worldInfo.world_names[Number(worldEditorSelect.value)];
        if (!name) { showWorldLibrary(); return; }
        if (!worldEditorName) worldListScroll = $('#WorldInfo').scrollTop;
        worldEditorName = name;
        document.body.dataset.jgWorldMode = 'edit';
        if (view === 'worlds') header();
        $('#WorldInfo').scrollTop = 0;
    });
    new MutationObserver(renderWorldLibrary).observe(worldEditorSelect, { childList: true, subtree: true, characterData: true });
    window.jQuery(globalWorldSelect).on('change.jiuguanLibrary', renderWorldLibrary);
    api.eventSource.on(api.event_types.WORLDINFO_SETTINGS_UPDATED, renderWorldLibrary);
    renderWorldLibrary();

    const activation = $('#wiActivationSettings').closest('.range-block');
    activation.classList.add('jg-world-activation');
    const activationToggle = activation.querySelector('.inline-drawer-toggle');
    const activationTitle = activationToggle.querySelector('b');
    activationTitle.textContent = '全局世界书激活设置';
    activationTitle.removeAttribute('data-i18n');
    activationToggle.setAttribute('role', 'button'); activationToggle.tabIndex = 0;
    const activationContent = activation.querySelector('.inline-drawer-content');
    activationContent.id = 'jg-world-activation-content';
    activationToggle.setAttribute('aria-controls', activationContent.id);
    const syncActivation = () => activationToggle.setAttribute('aria-expanded', String(getComputedStyle(activationContent).display !== 'none'));
    new MutationObserver(syncActivation).observe(activationContent, { attributes: true, attributeFilter: ['style', 'class'] });
    activationToggle.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activationToggle.click(); }
    });
    syncActivation();
    function importCard() { $('#character_import_button')?.click(); }
    function addMenu() {
        sheet('添加角色', [
            ['导入角色卡', 'import', importCard],
            ['新建角色', 'plus', () => openPanel('rightNavHolder', '新建角色', () => $('#rm_button_create')?.click())],
            ['创建群聊', 'people', () => openPanel('rightNavHolder', '创建群聊', () => $('#rm_button_group_chats')?.click())],
            ['角色管理', 'people', () => openPanel('rightNavHolder', '角色管理', () => $('#rm_button_characters')?.click())],
        ]);
    }
    function roleMenu(avatar) {
        const char = ctx().characters.find(char => char.avatar === avatar); if (!char) return;
        sheet(char.name, [
            ['继续聊天', 'chat', () => openRole(avatar)],
            ['新开对话', 'plus', () => guarded(async () => {
                chatReturn = 'roles'; await selectRole(avatar); await closeDrawers(); show('chat'); $('#option_start_new_chat')?.click();
            })],
            ['编辑角色', 'settings', () => guarded(async () => {
                await selectRole(avatar); await openPanel('rightNavHolder', '编辑角色', () => ctx().selectCharacterById(ctx().characterId));
            })],
            ['删除角色卡', 'trash', () => deleteRole(avatar), 'jg-danger'],
        ]);
    }
    function deleteRole(avatar) {
        return guarded(async () => {
            const char = ctx().characters.find(item => item.avatar === avatar);
            if (!char) throw new Error('这个角色已不存在，请刷新角色列表。');
            const name = node('span', '', char.name).outerHTML;
            const body = `<p>将删除“${name}”的角色卡，此操作无法撤销。</p>
                <label class="checkbox_label jg-confirm-option"><input type="checkbox" id="jg-delete-chats"><span>同时删除这个角色的全部聊天记录</span></label>`;
            let deleteChats = false;
            const confirmed = await ctx().Popup.show.confirm('删除角色卡？', body, {
                okButton: '删除', cancelButton: '取消',
                onOpen: popup => popup.dlg.classList.add('jg-danger-popup'),
                onClose: () => { deleteChats = !!document.getElementById('jg-delete-chats')?.checked; },
            });
            if (!confirmed) return;
            if (!await api.deleteCharacter(avatar, { deleteChats })) return;
            show('roles');
            window.toastr.success(`已删除“${char.name}”`);
        });
    }
    function chatItemMenu(item, name, file) {
        const key = chatKey(item, file);
        sheet(chatNames[key] || file, [
            [chatNames[key] ? '修改备注名' : '设置备注名', 'settings', () => renameChatAlias(key, file)],
            ['删除该聊天', 'trash', () => deleteChat(item, name, file), 'jg-danger'],
        ]);
    }
    async function renameChatAlias(key, file) {
        const value = await ctx().Popup.show.input('设置备注名', '只用于在聊天列表中区分同一角色的多段聊天，不修改聊天记录。留空则恢复默认。', chatNames[key] || '');
        if (value === null) return;
        const alias = value.replace(/\s+/g, ' ').trim().slice(0, 40);
        if (alias) chatNames[key] = alias; else delete chatNames[key];
        api.saveSettingsDebounced();
        if (view === 'chats') renderChats();
        window.toastr.success(alias ? `已将“${file}”备注为“${alias}”` : '已恢复默认名称');
    }
    async function deleteChat(item, name, file) {
        const key = chatKey(item, file);
        await guarded(async () => {
            const label = node('span', '', chatNames[key] || file).outerHTML, owner = node('span', '', name).outerHTML;
            const confirmed = await ctx().Popup.show.confirm('删除这段聊天？', `<p>将删除“${label}”的全部消息，此操作无法撤销。${owner}的其他聊天不受影响。</p>`, {
                okButton: '删除', cancelButton: '取消',
                onOpen: popup => popup.dlg.classList.add('jg-danger-popup'),
            });
            if (!confirmed) return;
            if (item.avatar) {
                const index = ctx().characters.findIndex(char => char.avatar === item.avatar);
                if (index < 0) throw new Error('这个角色已不存在，请刷新列表。');
                const current = !ctx().groupId && String(ctx().characterId) === String(index) && ctx().chatId === file;
                await api.deleteCharacterChatByName(String(index), file);
                // 与原版删除当前聊天一致：换到剩余的最近聊天，避免内存中的旧聊天被再次保存。
                if (current) await api.replaceCurrentChat();
            } else if (item.group) {
                if (ctx().groupId === item.group && ctx().chatId === file) await groupApi.deleteGroupChat(item.group, file);
                else await groupApi.deleteGroupChatByName(item.group, file);
            } else {
                throw new Error('这是一条未关联角色的旧会话，暂时无法删除。');
            }
            if ((await loadRecent()).some(entry => entry.file_name === item.file_name && entry.avatar === item.avatar && entry.group === item.group)) {
                throw new Error('删除没有成功，请检查后重试。');
            }
            delete chatNames[key]; api.saveSettingsDebounced();
            window.toastr.success('已删除这段聊天');
        });
        if (view === 'chats') renderChats();
    }
    function chatMenu() {
        sheet('聊天', [
            ['新开对话', 'plus', () => $('#option_start_new_chat')?.click()],
            ['管理当前角色的会话', 'chat', () => $('#option_select_chat')?.click()],
            ['角色与群聊设置', 'people', () => openPanel('rightNavHolder', '角色与群聊设置')],
            ['模型 API', 'plug', () => openPanel('sys-settings-button', '模型 API')],
            ['正则与扩展', 'box', () => openPanel('extensions-settings-button', '正则与扩展')],
            ['世界书', 'book', () => navigateHome('worlds')],
            ...settings.flatMap(([, rows]) => rows)
                .filter(([, , , id]) => !['rightNavHolder', 'sys-settings-button', 'extensions-settings-button'].includes(id))
                .map(([name, , symbol, id]) => [name, symbol, () => openPanel(id, name)]),
        ]);
    }
    async function openSettings() {
        await navigateHome('settings');
    }

    function back() {
        if (!document.documentElement.classList.contains('jg-app')) return false;
        if (menu.open) { menu.close(); return true; }
        const popup = ctx().Popup.util.popups.filter(popup => popup.dlg.hasAttribute('open')).at(-1);
        if (popup) { void popup.completeCancelled(); return true; }
        for (const [panel, close] of [['#completion_prompt_manager_popup', '#completion_prompt_manager_popup_entry_form_close'], ['#select_chat_popup', '#select_chat_cross'], ['#character_popup', '#character_cross']]) {
            if ($(panel)?.getClientRects().length) { $(close)?.click(); return true; }
        }
        if (view === 'worlds' && worldEditorName) { showWorldLibrary(); return true; }
        if (view === 'panel') { void navigateHome(panelReturn); return true; }
        if (view === 'chat') { void navigateHome(chatReturn); return true; }
        if (view !== 'chats') { void navigateHome('chats'); return true; }
        return false;
    }
    window.jiuguanMobile = { back, systemThemeChanged: applyTheme, get view() { return view; } };

    // Android 由 IME insets 缩小 WebView；手机编辑面板需自行跟随焦点滚动。
    // 只在聚焦和可视区变化时调整，不监听滚动，避免与用户手动翻阅争抢位置。
    let panelFocusFrame;
    const keepPanelInputVisible = () => {
        cancelAnimationFrame(panelFocusFrame);
        panelFocusFrame = requestAnimationFrame(() => {
            if (!['panel', 'worlds'].includes(view) || innerWidth > 768 || !document.documentElement.classList.contains('jg-app')) return;
            const input = document.activeElement;
            if (!input?.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]), textarea')) return;
            const panel = input.closest('#completion_prompt_manager_popup, #left-nav-panel.openDrawer, #WorldInfo.openDrawer');
            if (!panel || !input.getClientRects().length) return;
            const viewport = window.visualViewport;
            const panelBounds = panel.getBoundingClientRect();
            const top = Math.max(panelBounds.top, viewport?.offsetTop || 0) + 12;
            let bottom = Math.min(panelBounds.bottom, viewport ? viewport.offsetTop + viewport.height : innerHeight) - 12;
            const footer = panel.querySelector('.completion_prompt_manager_popup_entry_form_footer')?.getBoundingClientRect();
            if (footer && footer.top > top && footer.top < bottom) bottom = footer.top - 12;
            const bounds = input.getBoundingClientRect();
            if (bottom <= top) return;
            if (bounds.top < top || bounds.height > bottom - top) panel.scrollTop += bounds.top - top;
            else if (bounds.bottom > bottom) panel.scrollTop += bounds.bottom - bottom;
        });
    };
    document.addEventListener('focusin', keepPanelInputVisible);
    window.addEventListener('resize', keepPanelInputVisible);
    window.visualViewport?.addEventListener('resize', keepPanelInputVisible);

    let refreshTimer;
    const refresh = () => {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            if (busy) return;
            if (view === 'roles') roleGrid();
            else if (view === 'chats') renderChats();
            else if (view === 'chat') header();
        }, 200);
    };
    api.eventSource.on(api.event_types.PERSONA_CHANGED, () => { if (view === 'settings' && !busy) renderSettings(); });
    for (const event of ['CHARACTER_PAGE_LOADED', 'CHARACTER_EDITED', 'CHARACTER_DELETED', 'CHARACTER_DUPLICATED', 'CHAT_CREATED', 'CHAT_DELETED', 'CHAT_RENAMED', 'GROUP_UPDATED']) api.eventSource.on(api.event_types[event], refresh);
    api.eventSource.on(api.event_types.CHAT_CHANGED, () => {
        if (navigating || busy) return;
        if (ctx().characterId !== undefined || ctx().groupId) { chatReturn = homeTab; void closeDrawers(); show('chat'); }
        else refresh();
    });
    // 原版/扩展打开抽屉时仍能显示原面板，不复制表单或重新绑定它们的内部事件。
    const observer = new MutationObserver(() => {
        if (navigating || busy || !document.documentElement.classList.contains('jg-app')) return;
        const panel = document.querySelector('#top-settings-holder > .drawer > .drawer-content.openDrawer');
        if (panel?.id === 'WorldInfo') { if (view !== 'worlds') show('worlds'); return; }
        if (!panel && view === 'worlds') { void navigateHome('worlds'); return; }
        if (panel && view !== 'panel') {
            panelReturn = view;
            const parent = panel.parentElement;
            currentPanel = { id: parent.id, label: parent.querySelector('[title]')?.title || '设置' };
            show('panel');
        }
    });
    document.querySelectorAll('#top-settings-holder > .drawer > .drawer-content').forEach(panel => observer.observe(panel, { attributes: true, attributeFilter: ['class'] }));
    new MutationObserver(records => {
        for (const record of records) for (const added of record.addedNodes) {
            if (!(added instanceof Element) || !added.matches('.drawer')) continue;
            const panel = added.querySelector(':scope > .drawer-content');
            if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
        }
        if (view === 'settings') renderSettings();
    }).observe(document.getElementById('top-settings-holder'), { childList: true });
    navigating = true; await closeDrawers(); show('chats'); navigating = false;
})().catch(error => { console.error('[酒馆手机 UI] 加载失败，保留原版界面', error); document.documentElement.classList.remove('jg-app'); });
