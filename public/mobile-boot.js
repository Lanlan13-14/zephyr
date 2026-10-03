/* mobile-boot.js: island/page-head转接层（<200行，0业务fetch）。
 * 只做一件事：把移动chrome转接到 app.js 已有的 switchView/主题/登出逻辑。
 * 业务DOM与app.html同ID，app.js直接绑定，无需二次接线。 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const TITLES = { dashboard: 'Zephyr', terminal: '终端', activity: '活动记录', remote: '远程执行', notes: '笔记', ai: 'AI 助理', settings: '设置' };

function islandSync(name) {
    const key = name === 'ai' ? 'ai' : name;
    $$('#island .island-btn').forEach((b) => b.classList.toggle('active', b.dataset.mview === key));
    const pill = $('#island-pill');
    const active = $('#island .island-btn.active');
    if (pill && active) {
        const bar = $('#island').getBoundingClientRect();
        const r = active.getBoundingClientRect();
        pill.style.transform = `translateX(${Math.round(r.left - bar.left)}px)`;
        pill.style.width = `${Math.round(r.width)}px`;
    }
    const t = $('#mPageTitle');
    if (t) t.textContent = TITLES[name] || TITLES[key] || 'Zephyr';
}

function go(name) {
    closeMore();
    if (window.switchView) window.switchView(name);
    else document.querySelector(`.nav-tab[data-view="${name}"]`)?.click();
    islandSync(name);
}

function openMore() { $('#mMoreSheet')?.classList.remove('force-hidden'); $('#mMoreScrim')?.classList.remove('force-hidden'); }
function closeMore() { $('#mMoreSheet')?.classList.add('force-hidden'); $('#mMoreScrim')?.classList.add('force-hidden'); }

function bindChrome() {
    $$('#island .island-btn, #mMoreSheet .m-sheet-item').forEach((b) => {
        if (b.dataset.mbound) return; b.dataset.mbound = '1';
        b.addEventListener('click', () => {
            const v = b.dataset.mview;
            if (v === '__more') { openMore(); return; }
            go(v);
        });
    });
    $('#mMoreClose')?.addEventListener('click', closeMore);
    $('#mMoreScrim')?.addEventListener('click', closeMore);
    // 头部动作转接原逻辑：新建连接走原modal，AI走原浮窗，主题/登出触发原按钮
    $('#mHeadAddBtn')?.addEventListener('click', () => go('dashboard') ?? document.querySelector('#addConnectionBtn')?.click());
    $('#mHeadAiBtn')?.addEventListener('click', () => document.querySelector('#aiFloatingBtn')?.click() || go('ai'));
    $('#mHeadThemeBtn')?.addEventListener('click', () => document.querySelector('#appThemeToggle')?.click());
    $('#mHeadLogoutBtn')?.addEventListener('click', () => document.querySelector('#logoutBtn')?.click());
    // AI可用时显示头部AI入口
    const syncAi = () => { $('#mHeadAiBtn')?.classList.toggle('force-hidden', !!document.querySelector('#aiFloatingBtn')?.classList.contains('force-hidden')); };
    new MutationObserver(syncAi).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
    syncAi();
    // 键盘弹起island退场让位
    if (window.visualViewport) {
        const base = window.innerHeight;
        window.visualViewport.addEventListener('resize', () => {
            const open = window.innerHeight - window.visualViewport.height > 120 || base - window.visualViewport.height > 120;
            document.body.classList.toggle('m-kb-open', open);
        });
    }
    // 跟随视图切换同步island（app.js内部switchView也会触发，兜底用MutationObserver）
    const cur = () => document.querySelector('.nav-tab.active')?.dataset.view || (document.querySelector('#view-settings.active') ? 'settings' : 'dashboard');
    new MutationObserver(() => islandSync(cur())).observe($('#island')?.parentElement || document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
    islandSync(cur());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindChrome, { once: true });
else bindChrome();
