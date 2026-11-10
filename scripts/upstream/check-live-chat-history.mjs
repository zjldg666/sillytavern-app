import assert from 'node:assert/strict';
import { connectAndroidPage } from './android-cdp.mjs';
const page=await connectAndroidPage();
try {
    const report=await page.evaluate(async()=>{
        const api=await import('/script.js');
        if(api.isGenerating()||api.isChatSaving)throw new Error('Chat busy');
        const chat=document.getElementById('chat'),originalTop=chat.scrollTop;
        const hash=async()=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(api.chat))))].join(',');
        const before=await hash(),original=[...chat.querySelectorAll(':scope > .mes')],originalSet=new Set(original);
        const more=chat.querySelector('#show_more_messages');
        const count=()=>chat.querySelectorAll(':scope > .mes').length;
        try {
            await api.showMoreMessages(20);
            chat.scrollTop=0;
            await new Promise(r=>setTimeout(r,800));
            const readingCount=count();
            await new Promise(r=>setTimeout(r,500));
            const readingStable=count()===readingCount;
            chat.scrollTop=chat.scrollHeight;
            await new Promise(r=>setTimeout(r,1500));
            return {totalMessages:api.chat.length,beforeDisplayed:original.length,readingDisplayed:readingCount,readingStable,afterReturnDisplayed:count(),originalNodesRetained:original.every(el=>el.isConnected),chatDataUnchanged:before===await hash(),modelCalls:0};
        } finally {
            // 即使断言失败，也只清理本次额外加载的显示节点并恢复原阅读位置。
            window.jQuery([...chat.querySelectorAll(':scope > .mes')].filter(el=>!originalSet.has(el))).remove();
            if(more&&!more.isConnected)chat.prepend(more);
            chat.scrollTop=originalTop;
        }
    });
    console.log(JSON.stringify(report));
    assert.equal(report.readingStable,true);
    assert.equal(report.readingDisplayed,report.beforeDisplayed+20);
    assert.equal(report.afterReturnDisplayed,report.beforeDisplayed);
    assert.equal(report.originalNodesRetained,true);
    assert.equal(report.chatDataUnchanged,true);
}finally{page.close();}
