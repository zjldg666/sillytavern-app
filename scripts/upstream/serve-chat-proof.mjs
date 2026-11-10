import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './common.mjs';
// 仅提供隔离测试生成的中性截图，视觉服务不接触手机和用户聊天。
const file=path.join(root,'artifacts/upstream/chat-performance/compact-layout-360.png');
const server=createServer(async(req,res)=>{
    if(req.url==='/proof.png'){res.setHeader('Content-Type','image/png');res.end(await readFile(file));return;}
    if(req.url!=='/'){res.writeHead(404).end();return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>中性聊天布局截图验收</title><style>html,body{margin:0;background:#eee}img{display:block;width:360px;max-width:100%;height:auto}</style><img src="/proof.png" alt="隔离测试中的聊天页面截图">');
});
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}/`));
