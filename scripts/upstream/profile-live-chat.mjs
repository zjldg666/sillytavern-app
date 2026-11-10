import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './common.mjs';
import { connectAndroidPage } from './android-cdp.mjs';

// 用户授权的现有会话只做滚动/布局测量，不读取消息文本、不发送/保存消息。
const page = await connectAndroidPage();
const label = process.argv[2] || 'baseline';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid label');
const report = { label, userChatModified: false, phases: [] };
try {
    await page.call('Performance.enable');
    await page.call('Profiler.enable');
    await page.call('Profiler.setSamplingInterval', { interval: 2000 });
    report.layout = await page.evaluate(() => {
        const ctx = window.SillyTavern.getContext();
        const chat = document.getElementById('chat');
        const frames = [...chat.querySelectorAll('iframe')];
        const sizes = el => {const r=el.getBoundingClientRect(),s=el.ownerDocument.defaultView.getComputedStyle(el); return {tag:el.tagName,id:el.id,classes:String(el.className).slice(0,100),width:Math.round(r.width),height:Math.round(r.height),padding:s.padding,margin:s.margin,gap:s.gap,fontSize:s.fontSize};};
        return { totalMessages:ctx.chat.length,displayed:chat.querySelectorAll(':scope > .mes').length,nodes:chat.querySelectorAll('*').length,frames:frames.length,allFrames:document.querySelectorAll('iframe').length,
            lastMessage:[...chat.querySelectorAll(':scope > .mes')].slice(-1).map(el=>({box:sizes(el),text:sizes(el.querySelector('.mes_text'))})),
            panels:frames.flatMap(f=>{try{const d=f.contentDocument,r=d?.querySelector('#options-root');return r?[{frame:sizes(f),elements:[d.body,r,...r.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().width>0).slice(0,23).map(sizes)}]:[];}catch{return[];}})
        };
    });
    for (const scrolling of [false, true]) {
        const before = await page.call('Performance.getMetrics');
        await page.call('Profiler.start');
        const frames = await page.evaluate(async scrolling => {
            const chat = document.getElementById('chat'), original = chat.scrollTop;
            const frameTimes = [], tasks = []; let previous;
            const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e=>Math.round(e.duration))));
            observer.observe({type:'longtask',buffered:false});
            const start = performance.now();
            try {await new Promise(resolve=>{
                function tick(now){
                    if(previous!==undefined)frameTimes.push(now-previous); previous=now;
                    if(scrolling)chat.scrollTop=Math.max(0,original-1800*(1-Math.cos((now-start)/600))/2);
                    if(now-start<3000)requestAnimationFrame(tick);else resolve();
                }requestAnimationFrame(tick);
            });}finally{chat.scrollTop=original;observer.disconnect();}
            frameTimes.sort((a,b)=>a-b);
            return {frames:frameTimes.length,p50:Math.round(frameTimes[Math.floor(frameTimes.length*.5)]||0),p95:Math.round(frameTimes[Math.floor(frameTimes.length*.95)]||0),over50:frameTimes.filter(n=>n>50).length,longTasks:tasks};
        }, scrolling);
        const { profile } = await page.call('Profiler.stop');
        const after = await page.call('Performance.getMetrics');
        const map = new Map(profile.nodes.map(n=>[n.id,n]));
        const counts = new Map();
        for (const id of profile.samples || []) {
            const n=map.get(id),url=n?.callFrame.url||'';
            const group = url ? (url.includes('JS-Slash-Runner')?'tavern-helper':url.includes('ST-Prompt-Template')?'prompt-template':url.split('/').at(-1).split('?')[0].slice(0,80)||'inline') : n?.callFrame.functionName?.startsWith('(')?n.callFrame.functionName:'inline-script';
            counts.set(group,(counts.get(group)||0)+1);
        }
        const a=Object.fromEntries(after.metrics.map(m=>[m.name,m.value])),b=Object.fromEntries(before.metrics.map(m=>[m.name,m.value]));
        report.phases.push({scrolling,frameTimes:frames,metrics:Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].map(k=>[k,Math.round((a[k]-b[k])*1000)/1000])),heapUsedMB:Math.round(a.JSHeapUsedSize/1048576),cpuSamples:[...counts].sort((x,y)=>y[1]-x[1]).slice(0,10)});
    }
    await mkdir(path.join(root,'artifacts/upstream/chat-performance'),{recursive:true});
    await writeFile(path.join(root,`artifacts/upstream/chat-performance/${label}.json`),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
} finally { page.close(); }
