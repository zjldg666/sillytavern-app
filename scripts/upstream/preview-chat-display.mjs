import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './common.mjs';
import { connectAndroidPage } from './android-cdp.mjs';
const page = await connectAndroidPage();
try {
    const css = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/style.css'), 'utf8');
    const js = await readFile(path.join(root, 'app/src/main/assets/extensions/jiuguan-mobile/chat-display.js'), 'utf8');
    console.log(JSON.stringify(await page.evaluate(async ({css,js}) => {
        const api = await import('/script.js');
        if (api.isGenerating() || api.isChatSaving) throw new Error('Chat busy');
        const hash = async () => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(api.chat))))].map(n=>n.toString(16).padStart(2,'0')).join('');
        const before=await hash(),chat=document.getElementById('chat');
        const anchor=[...chat.querySelectorAll('.mes_text > *')].find(el=>{const r=el.getBoundingClientRect();return r.top>=48&&r.top<innerHeight-100;});
        const oldY=anchor?.getBoundingClientRect().top;
        let style=document.getElementById('jg-chat-display-preview');
        if(!style){style=document.createElement('style');style.id='jg-chat-display-preview';document.head.append(style);}
        style.textContent=css;
        await new Function(js.replace('export async function','async function')+'; return installChatDisplay();')();
        await new Promise(resolve=>setTimeout(resolve,1200));
        if(anchor)chat.scrollTop+=anchor.getBoundingClientRect().top-oldY;
        return { previewApplied:true,messages:api.chat.length,chatDataUnchanged:before===await hash() };
    }, {css,js})));
} finally { page.close(); }
