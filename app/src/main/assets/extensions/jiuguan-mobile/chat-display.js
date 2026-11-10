// 显示层优化：不改变聊天数组、提示词、脚本逻辑或持久化数据。
export async function installChatDisplay() {
    const api = await import('/script.js');
    const { power_user } = await import('/scripts/power-user.js');
    const chat = document.getElementById('chat');
    if (!chat || chat.dataset.jgDisplayInstalled) return;
    chat.dataset.jgDisplayInstalled = 'true';
    const mobile = () => document.documentElement.classList.contains('jg-app');
    const styleId = 'jg-compact-options-style';
    const optionsCss = `
        @media (max-width: 600px) {
            html.jg-compact-options body { padding: 0 !important; }
            html.jg-compact-options #options-root { width: 100%; max-width: 100%; margin-inline: 0; }
            html.jg-compact-options #options-root .options-header { padding: 8px !important; }
            html.jg-compact-options #options-root .options-body { padding: 6px !important; }
            html.jg-compact-options #options-root .options-grid { gap: 6px !important; }
            html.jg-compact-options #options-root .option-card { padding: 8px !important; gap: 6px !important; min-height: 44px; }
            html.jg-compact-options #options-root .option-text { min-width: 0; }
        }
    `;
    function compactFrame(frame) {
        if (!frame.matches('iframe[id^="TH-message"]')) return;
        try {
            const doc = frame.contentDocument;
            // 只适配已确认结构的行动选项面板，不覆盖任意角色卡的 body 或按钮。
            if (!doc?.querySelector('#options-root #optionsGrid .option-card')) return;
            if (!doc.getElementById(styleId)) {
                const style = doc.createElement('style');
                style.id = styleId; style.textContent = optionsCss;
                doc.head.append(style);
            }
            doc.documentElement.classList.toggle('jg-compact-options', mobile());
        } catch { /* 不访问跨域的消息页面。 */ }
    }
    const compactFrames = () => chat.querySelectorAll('iframe[id^="TH-message"]').forEach(compactFrame);
    chat.addEventListener('load', event => {
        if (event.target instanceof HTMLIFrameElement) compactFrame(event.target);
    }, true);
    new MutationObserver(compactFrames).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    let timer;
    let followingTail = true;
    const atBottom = () => chat.scrollHeight - chat.clientHeight - chat.scrollTop < 100;
    function trimTail() {
        timer = undefined;
        if (!mobile() || !followingTail) return;
        const limit = Number(power_user.chat_truncation);
        if (!Number.isInteger(limit) || limit <= 0) return;
        if (api.isGenerating() || api.isChatSaving) { scheduleTrim(); return; }
        // 编辑/批量删除期间保持原版节点及其选择状态。
        if (chat.querySelector('.edit_textarea, .mes.selected, .del_checkbox:checked')) return;
        const messages = [...chat.querySelectorAll(':scope > .mes')];
        if (messages.length <= limit) return;
        const keep = messages.slice(-limit);
        // 只回收完整尾部窗口之前的节点；不操作扩展插入的未知/非连续编号。
        const firstId = Number(keep[0].getAttribute('mesid'));
        if (firstId !== api.chat.length - limit || keep.some((el, index) => Number(el.getAttribute('mesid')) !== firstId + index)) return;
        const removed = messages.slice(0, -limit);
        const anchor = keep[0], oldY = anchor.getBoundingClientRect().top;
        let more = chat.querySelector('#show_more_messages');
        if (firstId > 0 && !more) {
            more = document.createElement('div'); more.id = 'show_more_messages'; more.textContent = '加载较早消息';
            chat.prepend(more);
        }
        // jQuery remove 清理原版事件数据；iframe 离开 DOM 后由浏览器释放。
        window.jQuery(removed).remove();
        const shift = anchor.getBoundingClientRect().top - oldY;
        chat.scrollTop += shift;
    }
    function scheduleTrim() {
        clearTimeout(timer);
        timer = setTimeout(trimTail, 180);
    }
    chat.addEventListener('scroll', () => {
        followingTail = atBottom();
        if (followingTail && !timer) scheduleTrim();
    }, { passive: true });
    // 展开历史时暂停回收；回到最新消息后再回收，避免阅读位置突然跳动。
    api.eventSource.on(api.event_types.MORE_MESSAGES_LOADED, () => { followingTail = false; compactFrames(); });
    api.eventSource.on(api.event_types.CHAT_CHANGED, () => { clearTimeout(timer); timer = undefined; followingTail = true; compactFrames(); scheduleTrim(); });
    for (const event of [api.event_types.USER_MESSAGE_RENDERED, api.event_types.CHARACTER_MESSAGE_RENDERED, api.event_types.GENERATION_ENDED]) {
        api.eventSource.on(event, () => { compactFrames(); scheduleTrim(); });
    }
    compactFrames();
    followingTail = atBottom();
    scheduleTrim();
}
