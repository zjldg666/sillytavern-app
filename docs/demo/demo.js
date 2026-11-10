const stories = [
  { title:'林间来信', initial:'林', caption:'雨天、旧书与一封信', chapter:'第一章 · 雨停之前', first:['雨落在屋檐上，像一封还没写完的信。','街角的旧书店还亮着灯。你停下脚步，看见玻璃窗上贴着一张手写的纸条：'], quote:'“如果你也在等雨停，进来坐坐。”', user:'我收起伞，推开了那扇门。', reply:['门上的铜铃轻轻响了一声。','“来得正好。”柜台后的人抬起头，把一杯热茶推到你面前。“我刚找到一本没有结尾的书。要一起读吗？”'], next:'你在窗边坐下，翻开书的第一页。纸张间夹着一片干燥的银杏叶，上面只有一句话：“故事从你来到这里开始。”' },
  { title:'星际漫游', initial:'星', caption:'去看一场遥远的日出', chapter:'航行日志 · 第七站', first:['舷窗外，蓝色行星正在缓缓转身。','飞船上的时钟指向清晨，远处第一束光掠过星环。导航员为你留了一张靠窗的座位。'], quote:'“这一站，我们不赶时间。”', user:'把航线调慢一点，我想多看一会儿。', reply:['引擎声渐渐低了下去。','你端起温热的咖啡，看见星环像一条细细的金线，从夜色里慢慢浮出来。'], next:'导航员点亮了观察窗旁的小灯。“我把这一刻记进航行日志了。下一站，听你的。”' },
  { title:'夜航笔记', initial:'夜', caption:'把今天留在一页纸上', chapter:'今日随记 · 慢一点', first:['桌上的台灯亮着，窗外的城市逐渐安静。','你翻开一本新的笔记本。第一页不用写得多漂亮，记下一件让你微笑的小事就好。'], quote:'“普通的一天，也值得被记住。”', user:'今天回家的路上，闻到了桂花香。', reply:['那就从这阵香气开始吧。','写下那条路、傍晚的风，还有你停下来抬头的那一刻。我们不用急着给今天下结论。'], next:'纸页上慢慢多了几行字。你合上笔，给今晚留下一句：“明天也走这条路吧。”' },
];
const transcript=document.querySelector('#transcript');
const input=document.querySelector('#message');
const send=document.querySelector('.send-button');
const portraits=['lin-portrait.webp','star-portrait.webp','night-portrait.webp'];
function portrait(index,className=''){
  const img=document.createElement('img');img.src=`../images/${portraits[index]}`;img.alt='';img.className=className;img.width=48;img.height=48;return img;
}
let current=0;
function icon(name){return `<svg aria-hidden="true"><use href="#${name}"/></svg>`;}
function message(kind,text,time='20:16'){
  const item=document.createElement('article');item.className=`message ${kind}`;
  const label=document.createElement('div');label.className='message-label';
  const name=document.createElement('span');name.textContent=kind==='user'?'我':stories[current].title;
  const clock=document.createElement('time');clock.textContent=time;if(kind==='assistant')label.append(portrait(current,'message-avatar'));label.append(name,clock);item.append(label);
  for(const [i,line] of text.entries()){const p=document.createElement('p');p.textContent=line;if(kind==='assistant'&&i===0)p.className='narration';item.append(p);}
  return item;
}
function openStory(index){
  current=index;const story=stories[index];input.value='';send.disabled=true;
  document.querySelector('#chat-title').textContent=story.title;document.querySelector('.chat-avatar').replaceChildren(portrait(index));
  transcript.replaceChildren();
  const date=document.createElement('div');date.className='date-divider';date.textContent='一段故事，从这里开始';transcript.append(date);
  const chapter=document.createElement('div');chapter.className='story-heading';chapter.innerHTML=icon('leaf');chapter.append(story.chapter);transcript.append(chapter);
  const first=message('assistant',story.first,'20:14');const quote=document.createElement('blockquote');quote.textContent=story.quote;first.append(quote);transcript.append(first,message('user',[story.user],'20:15'),message('assistant',story.reply));
  document.querySelectorAll('.conversation').forEach(b=>b.setAttribute('aria-current',String(Number(b.dataset.story)===index)));
  document.querySelector('.suggestions').hidden=index!==0;
  transcript.scrollTop=0;
}
for(const nav of document.querySelectorAll('.conversations')){
  for(const [i,story] of stories.entries()){
    const b=document.createElement('button');b.className='conversation';b.dataset.story=i;
    b.innerHTML=`<span class="initial"></span><span><strong>${story.title}</strong><small>${story.caption}</small></span>`;
    b.querySelector('.initial').append(portrait(i));
    b.addEventListener('click',()=>{openStory(i);document.querySelector('#chat-dialog').close();});nav.append(b);
  }
}
function theme(mode){document.documentElement.dataset.theme=mode;const dark=mode==='dark';const b=document.querySelector('#theme-toggle');b.innerHTML=icon(dark?'sun':'moon');b.setAttribute('aria-label',dark?'切换到白天模式':'切换到黑夜模式');}
theme(new URLSearchParams(location.search).get('theme')==='dark'?'dark':'light');
document.querySelector('#theme-toggle').addEventListener('click',()=>theme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
for(const id of ['about','demo-info'])document.getElementById(id).addEventListener('click',()=>document.querySelector('#info-dialog').showModal());
document.querySelector('#choose-chat').addEventListener('click',()=>document.querySelector('#chat-dialog').showModal());
document.querySelectorAll('.dialog-close').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
input.addEventListener('input',()=>{send.disabled=!input.value.trim();input.style.height='auto';input.style.height=Math.min(input.scrollHeight,130)+'px';});
document.querySelectorAll('[data-prompt]').forEach(b=>b.addEventListener('click',()=>{input.value=b.dataset.prompt;input.dispatchEvent(new Event('input'));input.focus();}));
document.querySelector('#composer').addEventListener('submit',e=>{e.preventDefault();const text=input.value.trim();if(!text)return;const user=message('user',[text],'演示');user.classList.add('new');const reply=message('assistant',[stories[current].next],'预置回复');reply.classList.add('new');transcript.append(user,reply);input.value='';input.dispatchEvent(new Event('input'));transcript.scrollTo({top:transcript.scrollHeight,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});});
input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();document.querySelector('#composer').requestSubmit();}});
openStory(0);
