export function colorCss(index, rgb, fallback) {
  if (Number.isFinite(rgb)) return `rgb(${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255})`;
  if (index === 256 || index == null) return fallback;
  if (index < 16) return `var(--term-color-${index})`;
  if (index < 232) { const n=index-16,r=Math.floor(n/36)*51,g=(Math.floor(n/6)%6)*51,b=(n%6)*51; return `rgb(${r},${g},${b})`; }
  const v=(index-232)*10+8; return `rgb(${v},${v},${v})`;
}
export function runStyle(run) {
  let fg=colorCss(run.fg,run.fgRgb,'var(--term-fg)'), bg=colorCss(run.bg,run.bgRgb,'transparent');
  const flags=Number(run.flags)||0;
  if(flags&0x20)[fg,bg]=[bg==='transparent'?'var(--term-bg)':bg,fg];
  const styles=[];
  if(fg)styles.push(`color:${fg}`); if(bg)styles.push(`background:${bg}`);
  if(flags&1)styles.push('font-weight:bold'); if(flags&2)styles.push('opacity:.65');
  if(flags&4)styles.push('font-style:italic');
  const decorations=[]; if(flags&8)decorations.push('underline'); if(flags&128)decorations.push('line-through');
  if(decorations.length)styles.push(`text-decoration:${decorations.join(' ')}`);
  if(flags&64)styles.push('visibility:hidden');
  return styles.join(';');
}
function safeHistoryLink(uri){
  if(!uri)return null;
  try{const url=new URL(uri,window.location.href);return ['http:','https:','mailto:'].includes(url.protocol)?url.href:null;}catch{return null;}
}
function makeRow(line) {
  const row=document.createElement('div'); row.className='term-row term-remote-history-row'; row.dataset.historySeq=String(line.seq);
  for(const run of line.runs||[]){
    const span=document.createElement('span'); span.textContent=run.text||''; const style=runStyle(run); if(style)span.style.cssText=style;
    const href=safeHistoryLink(run.link); if(href){const anchor=document.createElement('a');anchor.className='term-hyperlink';anchor.href=href;anchor.target='_blank';anchor.rel='noopener noreferrer';anchor.appendChild(span);row.appendChild(anchor);}else row.appendChild(span);
  }
  return row;
}

export function createTerminalRemoteHistory({wrapper,getSessionId,maxCachedRows=2000,pageSize=200}={}) {
  const state={beforeSeq:null,hasMore:true,loading:false,loaded:new Set(),container:null,destroyed:false};
  const ensureContainer=()=>{
    if(state.container?.isConnected)return state.container;
    const grid=wrapper.querySelector('.term-grid'); if(!grid)return null;
    const el=document.createElement('div'); el.className='term-remote-history';
    for(const type of ['mousedown','mouseup','mousemove','wheel']) el.addEventListener(type,(event)=>event.stopPropagation());
    wrapper.insertBefore(el,grid); state.container=el; return el;
  };
  const trimCache=(fromStart=false)=>{
    const el=state.container; if(!el)return;
    const before=wrapper.scrollHeight;
    while(el.children.length>maxCachedRows){ const row=fromStart?el.firstElementChild:el.lastElementChild; if(!row)break; state.loaded.delete(row.dataset.historySeq); row.remove(); }
    if(fromStart){wrapper.scrollTop=Math.max(0,wrapper.scrollTop-(before-wrapper.scrollHeight));const first=el.firstElementChild?.dataset.historySeq;if(first!=null)state.beforeSeq=Number(first);}
  };
  const prepend=(lines)=>{
    const el=ensureContainer(); if(!el||!lines.length)return 0;
    const before=wrapper.scrollHeight, fragment=document.createDocumentFragment(); let added=0;
    for(const line of lines){ const key=String(line.seq); if(state.loaded.has(key))continue; state.loaded.add(key); fragment.appendChild(makeRow(line)); added++; }
    el.prepend(fragment); trimCache(); wrapper.scrollTop += wrapper.scrollHeight-before; return added;
  };
  const loadOlder=async()=>{
    const sessionId=String(getSessionId?.()||''); if(!sessionId||state.loading||!state.hasMore||state.destroyed)return 0;
    state.loading=true;
    try{
      const query=new URLSearchParams({limit:String(pageSize)}); if(state.beforeSeq!=null)query.set('beforeSeq',String(state.beforeSeq));
      const response=await fetch(`/api/terminal-history/${encodeURIComponent(sessionId)}/lines?${query}`,{credentials:'same-origin'});
      if(!response.ok)throw new Error(`history ${response.status}`);
      const page=await response.json(); const lines=Array.isArray(page.lines)?page.lines:[];
      const added=prepend(lines); state.beforeSeq=page.beforeSeq??state.beforeSeq; state.hasMore=!!page.hasMore;
      return added;
    }finally{state.loading=false;}
  };
  const append=(lines)=>{
    const el=ensureContainer(); if(!el||!lines.length)return 0;
    const fragment=document.createDocumentFragment(); let added=0;
    for(const line of lines){const key=String(line.seq);if(state.loaded.has(key))continue;state.loaded.add(key);fragment.appendChild(makeRow(line));added++;}
    el.append(fragment); trimCache(true); return added;
  };
  const loadNewer=async()=>{
    const sessionId=String(getSessionId?.()||''), last=state.container?.lastElementChild?.dataset.historySeq;
    if(!sessionId||last==null||state.loading||state.destroyed)return 0;
    state.loading=true;
    try{const query=new URLSearchParams({limit:String(pageSize),afterSeq:String(last)});const response=await fetch(`/api/terminal-history/${encodeURIComponent(sessionId)}/lines?${query}`,{credentials:'same-origin'});if(!response.ok)return 0;const page=await response.json();return append(Array.isArray(page.lines)?page.lines:[]);}finally{state.loading=false;}
  };
  let lastTop=wrapper.scrollTop;
  const onScroll=()=>{ const top=wrapper.scrollTop,up=top<lastTop; lastTop=top; if(up&&top<=Math.max(2,wrapper.clientHeight*.05))void loadOlder(); };
  wrapper.addEventListener('scroll',onScroll,{passive:true});
  const syncTimer=setInterval(()=>{if(state.container?.children.length)void loadNewer();},5000); syncTimer.unref?.();
  return {
    loadOlder,loadNewer,
    setSession(){state.beforeSeq=null;state.hasMore=true;state.loaded.clear();if(state.container)state.container.replaceChildren();},
    destroy(){state.destroyed=true;clearInterval(syncTimer);wrapper.removeEventListener('scroll',onScroll);state.container?.remove();state.container=null;},
    state,
  };
}
