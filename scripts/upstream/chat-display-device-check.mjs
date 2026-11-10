import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, sha256 } from './common.mjs';
import { connectAndroidPage } from './android-cdp.mjs';
const mode=process.argv[2]||'after';
const output=path.join(root,'artifacts/upstream/chat-performance');
await mkdir(output,{recursive:true});
const page=await connectAndroidPage();
try{
    if(mode==='after'){
        // 用户已确认唯一会话；仅在恰好一条时点击，不猜选其他会话。
        await page.evaluate(async()=>{
            if(window.jiuguanMobile?.view==='chats'){
                const rows=document.querySelectorAll('.jg-chat-row');
                if(rows.length!==1)throw new Error('Expected one conversation');
                rows[0].click();
            }
        });
    }
    let state;
    const deadline=Date.now()+20000;
    do{
        state=await page.evaluate(async()=>{
            const api=await import('/script.js');
            const projection=api.chat.map(m=>({mes:m.mes,is_user:m.is_user,swipes:m.swipes}));
            const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(projection))))].map(n=>n.toString(16).padStart(2,'0')).join('');
            const chat=document.getElementById('chat');
            return {view:window.jiuguanMobile?.view,generating:api.isGenerating(),saving:api.isChatSaving,draftLength:document.getElementById('send_textarea').value.length,messages:api.chat.length,contentDigest:digest,moduleInstalled:chat.dataset.jgDisplayInstalled==='true',displayed:chat.querySelectorAll(':scope > .mes').length};
        });
        if(state.view==='chat'&&state.messages>0)break;
        await new Promise(r=>setTimeout(r,300));
    }while(Date.now()<deadline);
    assert.equal(state.view,'chat');assert.equal(state.generating,false);assert.equal(state.saving,false);
    if(mode==='before'){
        assert.equal(state.draftLength,0,'更新前确保没有未发送草稿');
        await writeFile(path.join(output,'device-before.json'),JSON.stringify(state,null,2));
    }else{
        const before=JSON.parse(await readFile(path.join(output,'device-before.json'),'utf8'));
        assert.equal(state.messages,before.messages);assert.equal(state.contentDigest,before.contentDigest,'聊天正文与候选回复保持一致');assert.equal(state.moduleInstalled,true);
        for(const name of ['style.css','chat-display.js']){
            const content=await page.evaluate(async name=>{
                const r=await fetch('/scripts/extensions/third-party/jiuguan-mobile/'+name,{cache:'no-store'});return r.text();
            },name);
            assert.equal(sha256(Buffer.from(content)),sha256(await readFile(path.join(root,'app/src/main/assets/extensions/jiuguan-mobile',name))));
        }
        await writeFile(path.join(output,'device-after.json'),JSON.stringify({...state,contentUnchanged:true,assetHashesMatch:true},null,2));
    }
    const {contentDigest,...safe}=state;console.log(JSON.stringify({mode,...safe,contentUnchanged:mode==='after'?true:undefined}));
}finally{page.close();}
