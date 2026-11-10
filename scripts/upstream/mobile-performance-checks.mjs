import assert from 'node:assert/strict';

// 调用前必须打开合成验收角色，不操作用户会话。只使用本机数据接口。
export async function checkMobilePerformance(page, { screenshot = async () => {} } = {}) {
    const checks = [];
    const identity = await page.evaluate(() => {
        const ctx = window.SillyTavern.getContext();
        const character = ctx.characters[ctx.characterId];
        if (!character?.name.startsWith('通用扩展验收：')) throw new Error('性能验收只允许合成角色');
        return { avatar_url: character.avatar, file_name: 'mobile-performance-test' };
    });
    const metrics = await page.evaluate(async identity => {
        const api = await import('/script.js');
        const { power_user } = await import('/scripts/power-user.js');
        const ctx = window.SillyTavern.getContext();
        const originalLimit = power_user.chat_truncation;
        const history = [{ user_name: '普通性能测试', character_name: '通用扩展验收', chat_metadata: {} }];
        for (let i = 0; i < 240; i++) {
            const html = '```html\n<body><p>普通天气面板 ' + i + '：晴天 22°C</p></body>\n```';
            history.push({ name: i % 2 ? '通用扩展验收' : '普通性能测试', is_user: i % 2 === 0, mes: i % 10 === 1 ? html : `第 ${i} 条普通消息：今天去公园散步。`.repeat(8), send_date: '2026-11-06T08:00:00.000Z' });
        }
        const save = await fetch('/api/chats/save', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ ...identity, chat: history, force: true }) });
        if (!save.ok) throw new Error('合成长聊天保存失败');
        async function measure(limit) {
            power_user.chat_truncation = limit;
            const start = performance.now();
            if (ctx.chatId !== identity.file_name) await ctx.openCharacterChat(identity.file_name);
            else await ctx.reloadCurrentChat();
            await new Promise(resolve => setTimeout(resolve, 500));
            return { limit, displayed: document.querySelectorAll('#chat > .mes').length, messageFrames: document.querySelectorAll('#chat iframe[id^="TH-message"]').length, totalMessages: ctx.chat.length, openMs: Math.round(performance.now() - start) };
        }
        try {
            const before = await measure(100);
            const after = await measure(20);
            return { before, after, originalLimit };
        } finally { power_user.chat_truncation = originalLimit; }
    }, identity);
    assert.equal(metrics.before.displayed, 100); assert.equal(metrics.after.displayed, 20);
    assert.equal(metrics.after.totalMessages, 240);
    assert.ok(metrics.after.messageFrames < metrics.before.messageFrames);
    checks.push('240 条合成历史：显示节点从 100 降至 20，历史数组仍为 240 条，脚本页面数量下降');
    await page.evaluate(() => { document.getElementById('chat').scrollTop = 0; });
    await page.locator('#show_more_messages').click();
    await page.waitForFunction(() => document.querySelectorAll('#chat > .mes').length >= 40);
    assert.equal(await page.evaluate(() => window.SillyTavern.getContext().chat.length), 240);
    checks.push('向上加载较早消息成功，未截断保存历史');
    await page.evaluate(async () => {
        await window.TavernHelper.createChatMessages([{ role: 'assistant', message: '新增的普通测试消息。' }]);
        await window.SillyTavern.getContext().saveChat();
    });
    await page.waitForFunction(() => document.querySelectorAll('#chat > .mes').length <= 20);
    assert.equal(await page.evaluate(() => window.SillyTavern.getContext().chat.length), 241);
    checks.push('新增消息后显示数量保持 20，完整历史继续增长至 241 条');
    try {
        await page.evaluate(() => {
            const existing = window.TavernHelper.getScriptTrees({ type: 'global' }).filter(s => !s.id.startsWith('jg-performance-'));
            const scripts = Array.from({ length: 4 }, (_, group) => ({ type: 'script', id: `jg-performance-${group}`, name: '普通工具栏测试', enabled: true, content: '', button: { enabled: true, buttons: Array.from({ length: 4 }, (_, i) => ({ name: `普通工具 ${group * 4 + i + 1}`, visible: true })) } }));
            window.TavernHelper.replaceScriptTrees([...existing, ...scripts], { type: 'global' });
        });
        await page.locator('[id="qr--bar"] .qr--button').filter({ hasText: /^普通工具 16$/ }).waitFor({ state: 'attached' });
        const layout = await page.evaluate(async () => {
            const api = await import('/script.js');
            const map = window.TavernHelper.getAllEnabledScriptButtons();
            const last = map['jg-performance-3'].at(-1);
            api.eventSource.once(last.button_id, () => { window.__jgClicked = true; });
            const bar = document.querySelector('#send_form [id="qr--bar"]');
            const buttons = [...bar.querySelectorAll('[id^="script_container_jg-performance-"] .qr--button')];
            const ys = buttons.map(b => Math.round(b.getBoundingClientRect().top));
            return { rows: new Set(ys).size, height: bar.getBoundingClientRect().height, width: bar.clientWidth, scrollWidth: bar.scrollWidth, headerHeight: document.getElementById('jg-header').getBoundingClientRect().height };
        });
        assert.equal(layout.rows, 1); assert.ok(layout.scrollWidth > layout.width); assert.ok(layout.height <= 55); assert.equal(layout.headerHeight, 48);
        await page.locator('[id="qr--bar"] .qr--button').filter({ hasText: /^普通工具 16$/ }).click();
        await page.waitForFunction(() => window.__jgClicked === true);
        assert.ok(await page.evaluate(() => document.querySelector('#send_form [id="qr--bar"]').scrollLeft > 0));
        metrics.toolbar = layout;
        checks.push('酒馆助手实际生成的 4 组 16 个工具只占一排；横向滚动后末尾按钮事件可触发，顶部栏 48px');
        await screenshot('performance-toolbar');
    } finally {
        await page.evaluate(() => { window.TavernHelper.replaceScriptTrees(window.TavernHelper.getScriptTrees({ type: 'global' }).filter(s => !s.id.startsWith('jg-performance-')), { type: 'global' }); });
    }
    return { checks, metrics };
}
