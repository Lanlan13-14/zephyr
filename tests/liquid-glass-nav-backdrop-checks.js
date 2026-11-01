/* Real Canvas2D uploads + WebGL readPixels, not source/regex assertions. */
(async function () {
  const results = [], diagnostics = [];
  function check(ok, name, detail) { results.push({ ok: Boolean(ok), name, detail }); }
  const pause = () => new Promise(r => setTimeout(r, 90));
  const root = document.documentElement;
  for (let i=0; i<100 && !window.ZephyrLiquidGlassBars; i++) await pause();
  const bars = window.ZephyrLiquidGlassBars;
  if (!bars?.topNav || !bars?.settingsSidebar) throw new Error('Both real WebGL controllers required');
  const controllers = [bars.topNav, bars.settingsSidebar];
  function uploadPixel(ctrl, fx=.5, fy=.5) {
    const c = navBackdropUploads.get(ctrl.canvas.id);
    return Array.from(c.getContext('2d').getImageData(Math.floor(c.width*fx), Math.floor(c.height*fy),1,1).data);
  }
  function frame(ctrl) {
    const r=ctrl.renderer, gl=r.gl;
    r.markAllDirty(); r.needsRedraw=true; r.render(); gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.finish();
    const pixels=new Uint8Array(ctrl.canvas.width*ctrl.canvas.height*4);
    gl.readPixels(0,0,ctrl.canvas.width,ctrl.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    if(gl.getError()!==gl.NO_ERROR) throw new Error('WebGL readPixels error');
    return { pixels, w:ctrl.canvas.width,h:ctrl.canvas.height,dpr:r.dpr };
  }
  function at(f,x,y) { const i=(Math.floor(f.h-1-y*f.dpr)*f.w+Math.floor(x*f.dpr))*4;return Array.from(f.pixels.slice(i,i+4)); }
  const close=(a,b,t=2)=>a.length===b.length && a.every((v,i)=>Math.abs(v-b[i])<=t);
  async function refresh(force=true) { bars.refreshAll(force);await pause(); }
  const group = new URLSearchParams(location.search).get('group') || 'light';
  if (!['light','dark'].includes(group)) throw new Error('Choose one small group: light or dark');
  for (const theme of [group]) {
    root.setAttribute('data-theme',theme);
    const bg=theme==='light'?[245,245,247]:[16,17,20];
    root.style.setProperty('--bg',`rgb(${bg})`);root.style.setProperty('--surface',theme==='light'?'#fff':'#1b1c20');
    root.removeAttribute('data-global-wallpaper');
    let first=null;
    for (const [scheme,accent] of [['frost','#1a73e8'],['lava','#b85c22']]) {
      root.setAttribute('data-color-scheme',scheme);root.style.setProperty('--accent',accent);await refresh();
      const row={theme,scheme,uploads:[],interiors:[],outside:[]};
      for(const ctrl of controllers) {
        const id=ctrl.canvas.id, r=ctrl.renderer;
        const samples=[uploadPixel(ctrl,.1,.1),uploadPixel(ctrl),uploadPixel(ctrl,.85,.8)];
        check(samples.every(p=>close(p,[...bg,255],0)),`${theme}/${scheme}/${id}: no invented accent gradient`,samples);
        const f=frame(ctrl), c=r.buttonConfigs.find(e=>e.isBottomTabContainer).rect;
        // Right-hand blank margin, away from selected capsule, icons and labels.
        const inner=at(f,c.x+c.w-25,c.y+c.h*.78), outside=at(f,2,2);
        check(outside[3]===0,`${theme}/${scheme}/${id}: transparent outside glass`,outside);
        check(r.backgroundColor===null && r.wallpaperClipCss.w===.01,`${theme}/${scheme}/${id}: clipped backdrop, no solid clear`);
        check(inner[3]>0,`${theme}/${scheme}/${id}: glass substrate retained`,inner);
        row.uploads.push(samples);row.interiors.push(inner);row.outside.push(outside);
      }
      if(first) check(row.interiors.every((p,i)=>close(p,first.interiors[i],1)),`${theme}/${scheme}: changing only accent does not tint glass bodies`,row.interiors);
      else first=row;
      diagnostics.push(row);
    }
    // Runtime base change without a forced rebuild must invalidate both caches.
    root.style.setProperty('--bg','rgb(77,83,91)');await refresh(false);
    check(controllers.every(c=>close(uploadPixel(c),[77,83,91,255],0)),`${theme}: background-only cache invalidation`,controllers.map(c=>uploadPixel(c)));
    root.style.setProperty('--bg',`rgb(${bg})`);
    const wall=document.createElement('canvas');wall.width=1200;wall.height=800;
    const wc=wall.getContext('2d');wc.fillStyle='rgb(220,40,60)';wc.fillRect(0,0,1200,400);wc.fillStyle='rgb(20,180,210)';wc.fillRect(0,400,1200,400);
    const src=wall.toDataURL();document.getElementById('zephyrGlobalWallpaper').dataset.currentUrl=src;
    root.setAttribute('data-global-wallpaper','1');
    for(const fit of ['cover']) {
      root.style.setProperty('--z-global-bg-size',fit);await refresh();await pause();await refresh();
      for(const ctrl of controllers) {
        // Independent reference drawing of the exact viewport slice.
        const rect=ctrl.canvas.getBoundingClientRect(), uploaded=navBackdropUploads.get(ctrl.canvas.id);
        const ref=document.createElement('canvas');ref.width=uploaded.width;ref.height=uploaded.height;const cx=ref.getContext('2d');
        cx.fillStyle=`rgb(${bg})`;cx.fillRect(0,0,ref.width,ref.height);
        const sw=innerWidth+56,sh=innerHeight+56,s=fit==='auto'?1:(fit==='contain'?Math.min(sw/1200,sh/800):Math.max(sw/1200,sh/800));
        cx.save();cx.scale(.5,.5);cx.translate(-rect.left,-rect.top);cx.globalAlpha=.65;cx.drawImage(wall,-28+(sw-1200*s)/2,-28+(sh-800*s)/2,1200*s,800*s);cx.restore();
        cx.fillStyle=theme==='light'?'rgba(255,255,255,.08)':'rgba(14,18,26,.14)';cx.fillRect(0,0,ref.width,ref.height);
        const expected=Array.from(cx.getImageData(Math.floor(ref.width*.5),Math.floor(ref.height*.5),1,1).data), actual=uploadPixel(ctrl);
        check(close(actual,expected,1),`${theme}/${fit}/${ctrl.canvas.id}: exact wallpaper viewport slice`,{actual,expected});
        const f=frame(ctrl);check(at(f,2,2)[3]===0,`${theme}/${fit}/${ctrl.canvas.id}: wallpaper never fills canvas margins`);
      }
      diagnostics.push({theme,fit,wallpaper:controllers.map(c=>uploadPixel(c))});
    }
    // Enabled but not yet loaded must use only the base, never accent ambient.
    document.getElementById('zephyrGlobalWallpaper').dataset.currentUrl='/pending-wallpaper.png';await refresh();
    check(controllers.every(c=>close(uploadPixel(c),[...bg,255],0)),`${theme}: pending wallpaper has neutral fallback`,controllers.map(c=>uploadPixel(c)));
    root.removeAttribute('data-global-wallpaper');await refresh();
    check(controllers.every(c=>close(uploadPixel(c),[...bg,255],0)),`${theme}: removing wallpaper removes sampled colors`);
  }
  window.navBackdropResult={ok:results.every(r=>r.ok),total:results.length,failed:results.filter(r=>!r.ok),diagnostics};
})().catch(e=>{window.navBackdropResult={ok:false,error:e.stack};});
