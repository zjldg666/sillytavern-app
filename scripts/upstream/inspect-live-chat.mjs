import { connectAndroidPage } from './android-cdp.mjs';
const page = await connectAndroidPage();
try {
    console.log(JSON.stringify(await page.evaluate(async () => {
        const ctx = window.SillyTavern.getContext();
        const { power_user } = await import('/scripts/power-user.js');
        const { extension_settings } = await import('/scripts/extensions.js');
        const box = element => {
            if (!element) return null;
            const r = element.getBoundingClientRect(), s = getComputedStyle(element);
            return { tag: element.tagName, id: element.id, className: String(element.className).slice(0,150), x: r.x, width: r.width, height: r.height, padding: s.padding, margin: s.margin, display: s.display };
        };
        const chat = document.getElementById('chat');
        const visibleMessage = [...chat.querySelectorAll(':scope > .mes')].find(el => { const r=el.getBoundingClientRect(); return r.bottom>100 && r.top<innerHeight-150; });
        const frames = [...chat.querySelectorAll('iframe')];
        return {
            view: window.jiuguanMobile?.view, messages: ctx.chat.length, textCharacters: ctx.chat.reduce((sum,m)=>sum+(m.mes?.length||0),0),
            displayed: chat.querySelectorAll(':scope > .mes').length, nodes: chat.querySelectorAll('*').length,
            messageFrames: frames.length, allFrames: document.querySelectorAll('iframe').length,
            displayLimit: power_user.chat_truncation, helperOptimization: extension_settings.tavern_helper?.optimize,
            viewport: { width:innerWidth,height:innerHeight,dpr:devicePixelRatio },
            memory: performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize} : null,
            boxes: ['#sheld','#chat'].map(s=>box(document.querySelector(s))).concat([box(visibleMessage),box(visibleMessage?.querySelector('.mes_block')),box(visibleMessage?.querySelector('.mes_text'))]),
            frameBoxes: frames.filter(f=>{const r=f.getBoundingClientRect();return r.bottom>100&&r.top<innerHeight;}).slice(0,3).map(f=>{
                let inner=[];try { const d=f.contentDocument; inner=[d.documentElement,d.body,...d.body.children].slice(0,8).map(box); } catch{}
                return {outer:box(f),inner};
            })
        };
    }), null, 2));
} finally { page.close(); }
