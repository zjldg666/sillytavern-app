import assert from 'node:assert/strict';

// 对真实原版 DOM 运行，不以仿造的聊天/设置页面替代验收。
export async function checkMobileUI(page, { screenshot = async () => {}, nativeBack } = {}) {
    const checks = [];
    await page.waitForFunction(() => window.jiuguanMobile?.view === 'chats');
    assert.deepEqual(await page.locator('#jg-nav .jg-tab').evaluateAll(tabs => tabs.map(tab => tab.dataset.tab)), ['chats', 'roles', 'worlds', 'settings']);
    await page.locator('[data-tab="roles"]').click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'roles');
    const original = await page.evaluate(() => {
        window.__jgOriginalInput = document.getElementById('send_textarea');
        window.__jgOriginalForm = document.getElementById('send_form');
        window.__jgOriginalApi = document.getElementById('main_api');
        return window.SillyTavern.getContext().characters.length;
    });
    assert.equal(await page.locator('.jg-role-card').count(), original);
    const input = page.getByRole('searchbox', { name: '搜索角色', exact: true });
    await input.fill('不存在的角色-UI-验收');
    await page.getByText('没有找到角色', { exact: true }).waitFor();
    await input.fill('');
    assert.equal(await page.locator('.jg-role-card').count(), original);
    const bounds = await page.evaluate(() => ({
        nav: document.getElementById('jg-nav').getBoundingClientRect().bottom,
        main: document.getElementById('jg-content').getBoundingClientRect().height,
        height: innerHeight,
        color: getComputedStyle(document.body).backgroundColor,
        theme: document.documentElement.dataset.jgTheme,
    }));
    assert.ok(bounds.main > 200 && Math.abs(bounds.nav - bounds.height) < 2);
    assert.equal(bounds.color, { light: 'rgb(246, 244, 240)', dark: 'rgb(20, 19, 18)' }[bounds.theme]);
    const toolbar = await page.evaluate(() => {
        const row = document.querySelector('#jg-content .jg-search-row');
        const items = row ? [...row.children].map(el => el.getBoundingClientRect()) : [];
        const portrait = document.querySelector('.jg-portrait')?.getBoundingClientRect();
        return {
            labels: row ? [...row.querySelectorAll('button')].map(el => el.getAttribute('aria-label')) : [],
            sameRow: items.length === 3 && items.every(rect => Math.abs(rect.top + rect.height / 2 - (items[0].top + items[0].height / 2)) < 2),
            square: !portrait || Math.abs(portrait.width - portrait.height) < 2,
            hint: document.querySelector('#jg-content').textContent.includes('点击开始聊天'),
        };
    });
    assert.deepEqual(toolbar.labels, ['导入角色卡', '添加角色']);
    assert.ok(toolbar.sameRow && toolbar.square && !toolbar.hint);
    checks.push('默认打开聊天页，底部为聊天 / 角色 / 世界书 / 设置；角色数量对应原版数据，搜索、导入、添加同一行，角色卡为正方形');
    await screenshot('roles');
    await page.locator('[data-tab="settings"]').click();
    await screenshot('settings');
    // 外观选项：白天 / 黑夜立即切换配色并保存到扩展设置，最后恢复原选择。
    const theme = await page.evaluate(() => {
        const select = document.querySelector('#jg-content select[aria-label="外观"]');
        const settings = window.SillyTavern.getContext().extensionSettings.jiuguan_mobile;
        const original = select.value, seen = {};
        for (const value of ['dark', 'light', original]) {
            select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
            seen[value] = [document.documentElement.dataset.jgTheme, getComputedStyle(document.body).backgroundColor, settings.theme];
        }
        return { options: [...select.options].map(option => option.textContent), seen };
    });
    assert.deepEqual(theme.options, ['跟随系统', '白天', '黑夜']);
    assert.deepEqual(theme.seen.dark, ['dark', 'rgb(20, 19, 18)', 'dark']);
    assert.deepEqual(theme.seen.light, ['light', 'rgb(246, 244, 240)', 'light']);
    checks.push('设置页外观可选跟随系统 / 白天 / 黑夜，切换即时生效并写入扩展设置');
    const panels = ['sys-settings-button', 'ai-config-button', 'advanced-formatting-button', 'extensions-settings-button', 'persona-management-button', 'user-settings-button', 'backgrounds-button'];
    for (const target of panels) {
        await page.locator(`.jg-setting-row[data-panel="${target}"]`).click();
        await page.locator(`#${target} > .drawer-content.openDrawer`).waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => window.jiuguanMobile.view), 'panel');
        if (target === 'sys-settings-button') {
            assert.ok(await page.evaluate(() => window.__jgOriginalApi === document.getElementById('main_api')));
            await screenshot('api');
        }
        if (nativeBack) await nativeBack();
        else await page.locator('#jg-header button[aria-label="返回"]').click();
        await page.waitForFunction(() => window.jiuguanMobile.view === 'settings');
    }
    checks.push('7 个设置入口打开原版面板，表单节点未替换，返回导航正常；世界书独立为底部导航入口');
    await page.locator('[data-tab="roles"]').click();
    const selected = await page.evaluate(() => {
        const char = window.SillyTavern.getContext().characters.find(char => char.name.startsWith('APK 合成验收角色'));
        return char ? { avatar: char.avatar, name: char.name } : null;
    });
    assert.ok(selected, '只使用合成验收角色，不操作用户卡片');
    const card = page.locator('.jg-role-card').filter({ has: page.locator(`.jg-role-open[aria-label="与 ${selected.name} 聊天"]`) }).first();
    await card.locator('.jg-role-more').click();
    await page.locator('#jg-menu .jg-menu-row.jg-danger', { hasText: '删除角色卡' }).click();
    await page.locator('dialog.popup[open] #jg-delete-chats').waitFor();
    await screenshot('delete-confirm');
    await page.evaluate(() => window.jiuguanMobile.back());
    await page.locator('dialog.popup[open]').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.SillyTavern.getContext().characters.length), original);
    checks.push('角色卡菜单提供删除入口，弹出原版确认框；取消后角色未删除');
    await card.locator('.jg-role-open').click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chat');
    await page.locator('#send_textarea').waitFor({ state: 'visible' });
    assert.ok(await page.evaluate(avatar => {
        const context = window.SillyTavern.getContext();
        return context.characters[context.characterId]?.avatar === avatar
            && window.__jgOriginalInput === document.getElementById('send_textarea')
            && window.__jgOriginalForm === document.getElementById('send_form');
    }, selected.avatar));
    const chatId = await page.evaluate(() => window.SillyTavern.getContext().chatId);
    const layout = await page.evaluate(() => {
        const mes = document.querySelector('#chat > .mes:not(.smallSysMes)');
        if (!mes) return null;
        const style = getComputedStyle(mes);
        const inner = mes.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const avatar = mes.querySelector('.mesAvatarWrapper .avatar').getBoundingClientRect();
        const text = mes.querySelector('.mes_text').getBoundingClientRect();
        return { full: Math.abs(mes.querySelector('.mes_block').getBoundingClientRect().width - inner) < 2, above: avatar.bottom <= text.top + 1 };
    });
    assert.ok(layout && layout.full && layout.above, '消息头像位于正文上方，正文占满整行');
    await screenshot('chat');
    checks.push('点角色卡打开原版会话；聊天输入框、发送表单与角色身份保留');
    await page.locator('#jg-header button[aria-label="聊天菜单"]').click();
    await page.getByRole('button', { name: '正则与扩展', exact: true }).click();
    await page.locator('#extensions-settings-button > .openDrawer').waitFor({ state: 'visible' });
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chat');
    assert.equal(await page.evaluate(() => window.SillyTavern.getContext().chatId), chatId);
    checks.push('聊天内打开扩展面板再返回，会话身份不改变');
    await page.locator('#jg-header button[aria-label="返回"]').click();
    await page.locator('[data-tab="chats"]').click();
    await page.locator('.jg-chat-row').first().waitFor({ state: 'visible' });
    await screenshot('chats');
    const history = page.locator(`.jg-chat-row[data-chat=${JSON.stringify(chatId + '.jsonl')}]`).filter({ hasText: selected.name }).first();
    await history.click();
    await page.waitForFunction(() => window.jiuguanMobile.view === 'chat');
    assert.equal(await page.evaluate(() => window.SillyTavern.getContext().chatId), chatId);
    checks.push('聊天列表打开指定历史会话，未新建或串到其他会话');
    await page.locator('#jg-header button[aria-label="聊天菜单"]').click();
    await page.getByRole('button', { name: '新开对话', exact: true }).click();
    await page.locator('dialog.popup[open]').waitFor();
    await page.evaluate(() => window.jiuguanMobile.back());
    await page.locator('dialog.popup[open]').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.SillyTavern.getContext().chatId), chatId);
    checks.push('新开对话沿用原版确认弹窗；取消后不改写会话');
    return checks;
}
