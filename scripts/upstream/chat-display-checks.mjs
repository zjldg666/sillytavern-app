import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './common.mjs';

export async function checkChatDisplay(page) {
    const output=path.join(root,'artifacts/upstream/chat-performance');
    await mkdir(output,{recursive:true});
    await page.setViewportSize({width:360,height:800});
    if (await page.evaluate(()=>window.jiuguanMobile.view!=='chat')) {
        await page.locator('.jg-role-open').filter({hasText:'APK 合成验收角色'}).click();
        await page.waitForFunction(()=>window.jiuguanMobile.view==='chat');
    }
    const checks=await page.evaluate(async()=>{
        const api=await import('/script.js');
        const {power_user}=await import('/scripts/power-user.js');
        const ctx=window.SillyTavern.getContext();
        if(!ctx.characters[ctx.characterId]?.name.startsWith('APK 合成验收角色'))throw new Error('Only synthetic character allowed');
        if(window.TavernHelper)throw new Error('This fallback test must run without TavernHelper');
        const chat=document.getElementById('chat'),checks=[];
        const wait=ms=>new Promise(r=>setTimeout(r,ms));
        const count=()=>chat.querySelectorAll(':scope > .mes').length;
        const message=i=>({name:'城市向导',is_user:false,mes:`第 ${i} 条测试消息：今天沿湖散步，稍后去图书馆。`.repeat(12),send_date:'2026-11-09T10:00:00.000Z',extra:{}});
        power_user.chat_truncation=20;
        await api.clearChat();
        api.chat.splice(0,api.chat.length,...Array.from({length:1000},(_,i)=>message(i)));
        const start=performance.now();
        await api.printMessages();
        await wait(250);
        checks.push({name:'1000_messages_render_20',passed:api.chat.length===1000&&count()===20,openMs:Math.round(performance.now()-start)});
        // 无助手时，连续新增仍应回收旧节点，不必重新打开会话。
        for(let i=0;i<60;i++){
            const m=message(api.chat.length);api.chat.push(m);api.addOneMessage(m);
            await api.eventSource.emit(api.event_types.CHARACTER_MESSAGE_RENDERED,api.chat.length-1);
        }
        chat.scrollTop=chat.scrollHeight;chat.dispatchEvent(new Event('scroll'));
        await wait(600);
        checks.push({name:'continuous_60_without_helper_bounded',passed:count()===20&&api.chat.length===1060});
        await api.showMoreMessages(20);chat.scrollTop=0;chat.dispatchEvent(new Event('scroll'));
        await wait(250);
        const readingCount=count(),oldFirst=chat.querySelector('.mes');
        const m=message(api.chat.length);api.chat.push(m);api.addOneMessage(m,{scroll:false});
        await api.eventSource.emit(api.event_types.CHARACTER_MESSAGE_RENDERED,api.chat.length-1);
        await wait(250);
        checks.push({name:'reading_history_not_pruned',passed:count()===readingCount+1&&oldFirst.isConnected});
        chat.scrollTop=chat.scrollHeight;chat.dispatchEvent(new Event('scroll'));await wait(350);
        checks.push({name:'return_to_tail_reclaims_history',passed:count()===20&&api.chat.length===1061});
        await api.showMoreMessages(20);
        chat.scrollTop=chat.scrollHeight-chat.clientHeight-40;chat.dispatchEvent(new Event('scroll'));
        await wait(350);
        checks.push({name:'near_tail_reading_anchor_preserved',passed:count()===20&&Math.abs(chat.scrollHeight-chat.clientHeight-chat.scrollTop-40)<3});
        // 编辑器存在时不删除节点；退出编辑后再恢复回收。
        const editing=document.createElement('textarea');editing.className='edit_textarea';chat.querySelector('.mes').append(editing);
        const extra=message(api.chat.length);api.chat.push(extra);api.addOneMessage(extra);
        await api.eventSource.emit(api.event_types.CHARACTER_MESSAGE_RENDERED,api.chat.length-1);
        chat.scrollTop=chat.scrollHeight;chat.dispatchEvent(new Event('scroll'));await wait(350);
        checks.push({name:'editing_protected',passed:editing.isConnected&&count()===21});
        editing.remove();chat.dispatchEvent(new Event('scroll'));await wait(350);
        checks.push({name:'editing_finished_trims_again',passed:count()===20});
        power_user.chat_truncation=0;
        const last=message(api.chat.length);api.chat.push(last);api.addOneMessage(last);
        await api.eventSource.emit(api.event_types.CHARACTER_MESSAGE_RENDERED,api.chat.length-1);
        chat.scrollTop=chat.scrollHeight;chat.dispatchEvent(new Event('scroll'));await wait(350);
        checks.push({name:'explicit_unlimited_setting_respected',passed:count()===21});
        power_user.chat_truncation=20;
        chat.dispatchEvent(new Event('scroll'));await wait(350);
        // 下面仅为中性视觉样例，真实原版节点 + 独立消息 iframe；不复制用户卡片。
        const mes=chat.querySelector('.mes.last_mes'),text=mes.querySelector('.mes_text');
        text.replaceChildren();
        const p=document.createElement('p');p.textContent='午后的街道很安静。接下来可以去图书馆看看，再沿湖边慢慢散步。';text.append(p);
        const iframe=document.createElement('iframe');iframe.id='TH-message--synthetic--0';iframe.style='width:100%;border:0;height:450px';
        const choices=['在站台回头看一眼朋友还站在原地','上车之后给朋友发一条短信','把外套脱下来搭在手臂上往站台走','告诉朋友晚上一起吃饭','换好衣服后到楼下集合'];
        iframe.srcdoc=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
        *{box-sizing:border-box}body{margin:0;padding:6px;color:#242424;background:white;font:14px system-ui} .options-shell{border:1px solid #deddd7;border-radius:16px;overflow:hidden;background:white}.options-header{padding:12px 16px;background:#f5f4ef;display:flex;align-items:center;justify-content:space-between}.options-title{font-weight:700;font-size:13px}.header-controls{display:flex;gap:6px}.ctrl-btn{width:30px;height:30px;border:1px solid #ddd;border-radius:10px;background:white;padding:0;font:11px system-ui;white-space:nowrap}.options-body{padding:12px}.options-grid{display:grid;gap:8px}.option-card{display:flex;gap:10px;align-items:center;padding:10px 14px;border:1px solid #deddd7;border-radius:12px;background:#eeede7;cursor:pointer}.option-num{width:24px;height:24px;flex-shrink:0;border-radius:7px;background:#bb6657;color:white;display:grid;place-items:center;font-size:11px}.option-text{flex:1;font-size:13px;line-height:1.5}.option-arrow{font-size:11px;color:#bbb}
        </style></head><body><div id="options-root"><div class="options-shell"><div class="options-header"><span class="options-title">行动选项</span><span class="header-controls"><button class="ctrl-btn" id="modeBtn">追加</button><button class="ctrl-btn" id="themeBtn">☾</button><button class="ctrl-btn" id="collapseBtn">▲</button></span></div><div id="optionsBody" class="options-body"><div id="optionsGrid" class="options-grid">${choices.map((c,i)=>`<div class="option-card"><div class="option-num">${i+1}</div><div class="option-text">${c}</div><div class="option-arrow">▸</div></div>`).join('')}</div></div></div></div><script>document.querySelectorAll('.option-card').forEach((el,i)=>el.onclick=()=>parent.__syntheticOption=i);document.getElementById('collapseBtn').onclick=()=>{const b=document.getElementById('optionsBody');b.hidden=!b.hidden};new ResizeObserver(()=>{frameElement.style.height=document.body.scrollHeight+'px'}).observe(document.body);<\/script></body></html>`;
        text.append(iframe); await new Promise(resolve=>iframe.addEventListener('load',resolve,{once:true}));await wait(350);
        const d=iframe.contentDocument;
        checks.push({name:'new_iframe_receives_targeted_styles',passed:d.documentElement.classList.contains('jg-compact-options')&&!!d.getElementById('jg-compact-options-style')});
        d.querySelectorAll('.option-card')[1].click();checks.push({name:'option_click_handler_preserved',passed:window.__syntheticOption===1});
        d.getElementById('collapseBtn').click();checks.push({name:'collapse_handler_preserved',passed:d.getElementById('optionsBody').hidden});d.getElementById('collapseBtn').click();
        const other=document.createElement('iframe');other.id='TH-message--synthetic--1';other.srcdoc='<body style="padding:24px"><button>其他面板</button></body>';other.style='height:70px;width:100%';text.append(other);
        await new Promise(resolve=>other.addEventListener('load',resolve,{once:true}));await wait(100);
        checks.push({name:'unrecognized_panels_not_restyled',passed:!other.contentDocument.getElementById('jg-compact-options-style')});other.remove();
        document.documentElement.classList.remove('jg-app');await wait(100);
        checks.push({name:'original_UI_restores_panel_style',passed:!d.documentElement.classList.contains('jg-compact-options')});
        document.documentElement.classList.add('jg-app');await wait(100);
        chat.scrollTop=mes.offsetTop; // 在截图中展示完整的正文和选项。
        return checks;
    });
    for(const check of checks)assert.equal(check.passed,true,check.name);
    const screenshot=path.join(output,'compact-layout-360.png');
    await page.screenshot({path:screenshot});
    const layout=await page.evaluate(()=>{
        const chat=document.getElementById('chat'),text=chat.querySelector('.last_mes .mes_text'),iframe=text.querySelector('iframe'),d=iframe.contentDocument;
        return {viewport:innerWidth,textWidth:text.clientWidth,optionTextWidth:d.querySelector('.option-text').clientWidth,fontSize:d.defaultView.getComputedStyle(d.querySelector('.option-text')).fontSize,horizontalOverflow:document.documentElement.scrollWidth>innerWidth||d.documentElement.scrollWidth>iframe.clientWidth};
    });
    assert.equal(layout.horizontalOverflow,false);
    const responsive=[];
    for(const width of [320,412]){
        await page.setViewportSize({width,height:800});await page.waitForTimeout(200);
        const overflow=await page.evaluate(()=>{
            const f=document.querySelector('iframe[id="TH-message--synthetic--0"]'),d=f.contentDocument;
            return document.documentElement.scrollWidth>innerWidth||d.documentElement.scrollWidth>f.clientWidth;
        });
        assert.equal(overflow,false,`${width}px viewport`);
        await page.screenshot({path:path.join(output,`compact-layout-${width}.png`)});
        responsive.push({width,horizontalOverflow:overflow});
    }
    await writeFile(path.join(output,'display-checks.json'),JSON.stringify({checks,layout,responsive,screenshot},null,2));
    return {checks,layout,responsive,screenshot};
}
