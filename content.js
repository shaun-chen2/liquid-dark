'use strict';

/* 编排：决定这个页面走哪条路，然后驱动两个引擎。
 *
 * 三层，从好到糙：
 *   1. 原生      浏览器对所有站点报告 prefers-color-scheme: dark（背景脚本干的），
 *                站点用自己设计的深色，零瑕疵
 *   2. 动态改色  站点没深色时，读计算样式把颜色翻过去
 *   3. 滤镜反色  前两条都不行时的兜底，万能但色相会偏、背景图图标会被反白
 *
 * auto 模式会探测第 1 层生效了没有，没有才上第 2 层。 */

(function () {
  /* 放行渲染（见 preload.css 的拦截）。等下一帧，让刚写进去的改色样式先生效再显示。 */
  function reveal() {
    var go = function () { document.documentElement.setAttribute('data-lgready', ''); };
    try { requestAnimationFrame(go); } catch (e) { go(); }
    setTimeout(go, 50);   // 后台标签页 rAF 不触发，补一刀
  }

  if (!/^https?:$/.test(location.protocol)) { reveal(); return; }

  var IS_TOP = (function () {
    try { return window.top === window; } catch (e) { return false; }
  })();

  var HOST = location.hostname;
  var settings = null;
  var effMode = 'off';       // 实际生效的模式
  var nativeDark = false;
  var started = false;
  var glassOn = false;
  var prefersOn = false;

  function send(msg) {
    try {
      var p = browser.runtime.sendMessage(msg);
      return p && p.catch ? p.catch(function () { return null; }) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  }

  /* preload.css 只是防白闪的引导层，一旦决定好就撤掉，交给运行时样式 */
  function retirePreload() {
    var h = document.documentElement;
    h.setAttribute('data-lgnobg', '');
    h.setAttribute('data-lgnofg', '');
  }

  /* 站点自己是不是已经深色了。
   * preload.css 故意用 background-image 而不是 background-color 画深色，
   * 就是为了让这里读到的是站点的真实值。 */
  function probeNativeDark() {
    var c = null;
    if (document.body) c = lgParseColor(getComputedStyle(document.body).backgroundColor);
    if (!c || c.a < 0.05) {
      c = lgParseColor(getComputedStyle(document.documentElement).backgroundColor);
    }
    if (!c || c.a < 0.05) return { dark: false, lum: 1 };   // 都透明 = 浏览器默认白底
    var lum = lgLuminance(c);
    return { dark: lum < 0.22, lum: lum };
  }

  function whenBody(fn) {
    if (document.body) return fn();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      setTimeout(fn, 0);
    }
  }

  function whenParsed(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  /* ---------------- 应用 ---------------- */

  /* ---------------- 元素级名单 & HTML 删除 ---------------- */

  function compileElemLists() {
    ['glassBlock', 'glassForce', 'darkBlock', 'darkForce'].forEach(function (k) {
      LG_ELEM[k] = lgCompileSelectors(settings[k], HOST);
    });
  }

  var htmlPats = [];
  function compileHtmlPats() {
    htmlPats = (settings.hideHtml || []).map(lgHtmlPattern).filter(Boolean);
  }

  /* 按名单给元素打标记：强制反色（data-lgforce）、HTML 删除（data-lghide） */
  function markElems() {
    var olds = document.querySelectorAll('[data-lgforce],[data-lghide]');
    for (var i = 0; i < olds.length; i++) { olds[i].removeAttribute('data-lgforce'); olds[i].removeAttribute('data-lghide'); }
    if (LG_ELEM.darkForce && effMode !== 'off') {
      try {
        var f = document.querySelectorAll(LG_ELEM.darkForce);
        for (var j = 0; j < f.length; j++) f[j].setAttribute('data-lgforce', '');
      } catch (e) {}
    }
    htmlPats.forEach(function (p) {
      var hits;
      try { hits = document.querySelectorAll(p.sel); } catch (e) { return; }
      for (var k = 0; k < hits.length; k++) {
        if (p.text && (hits[k].textContent || '').trim() !== p.text) continue;
        hits[k].setAttribute('data-lghide', '');
      }
    });
  }

  var markTimer = 0, markMo = null;
  function watchElems() {
    if (markMo) return;
    ensureHideStyle();
    markMo = new MutationObserver(function () {
      if (markTimer) return;
      markTimer = setTimeout(function () { markTimer = 0; markElems(); }, 250);
    });
    try { markMo.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }

  var hideBaseEl = null;
  function ensureHideStyle() {
    if (hideBaseEl && hideBaseEl.isConnected) return;
    hideBaseEl = document.createElement('style');
    hideBaseEl.setAttribute('data-liquid-hidehtml', '');
    hideBaseEl.textContent = 'html [data-lghide]{display:none !important}';
    (document.head || document.documentElement).appendChild(hideBaseEl);
  }

  /* 名单更新时，已经处理过的元素也要按新名单撤回，不用刷新网页 */
  function undoBlocked() {
    var pairs = [['darkBlock', 'data-lgd'], ['glassBlock', 'data-lgg']];
    pairs.forEach(function (pr) {
      if (!LG_ELEM[pr[0]]) return;
      var els;
      try { els = document.querySelectorAll(LG_ELEM[pr[0]]); } catch (e) { return; }
      for (var i = 0; i < els.length; i++) els[i].removeAttribute(pr[1]);
    });
  }

  function refreshElems() {
    compileElemLists();
    undoBlocked();
    compileHtmlPats();
    ensureHideStyle();
    markElems();
    watchElems();
  }

  function startEngines() {
    if (started) return;
    started = true;

    retirePreload();

    if (effMode === 'invert') {
      LGDark.start('invert', settings);
    }

    if (effMode === 'dynamic') {
      LGDark.start('dynamic', settings);
    }
    // effMode === 'native'：什么都不改，靠浏览器的 prefers-color-scheme

    // 磨砂玻璃只在"最终确实是深色"的页面上加 —— 浅色页面上叠深色半透明板很怪。
    // 圆角没这个问题，深浅都能加。
    var go = surfaceOpts();
    if (IS_TOP && (go.glass || go.roundCorners)) {
      glassOn = true;
      LGGlass.start(go);
    }

    markElems();
    reveal();

    window.addEventListener('load', function () {
      markElems();
      /* 异步加载的样式表这时候才到齐，补搬一次。
       * 只在已经判定为 native 时补 —— 要是已经走了动态改色，
       * 这时再灌一套站点深色规则会和我们改的颜色打架。 */
      if (prefersOn && effMode === 'native') LGPrefers.apply();
      LGDark.rescan();
      if (glassOn) LGGlass.rescan();
      report();
    }, { once: true });

    report();
  }

  function decideAndStart() {
    var m = lgModeFor(settings, HOST);

    if (m === 'off') {
      retirePreload();
      reveal();
      effMode = 'off';
      report();
      return;
    }

    if (m === 'dynamic' || m === 'invert') {
      // 明确指定，不用探测，尽早动手
      effMode = m;
      whenBody(startEngines);
      return;
    }

    // auto / native：必须等样式表就位才能判断站点自带深色
    whenParsed(function () {
      /* Chrome 上没有 browserSettings.overrideContentColorScheme，
       * 改用"把站点自己的 @media (prefers-color-scheme: dark) 规则搬出来"来顶替。
       * 这一步必须跑在亮度探测之前 —— 否则会把明明有深色设计的站点
       * 误判成"没有深色"，白白走一遍动态改色。 */
      if (LG_PLATFORM === 'chrome' && settings.nativeOverride) {
        prefersOn = LGPrefers.apply();
      }

      var p = probeNativeDark();
      nativeDark = p.dark;

      if (m === 'native') {
        effMode = 'native';
      } else {
        // auto
        effMode = (nativeDark && settings.respectNativeDark) ? 'native' : 'dynamic';
      }
      startEngines();
    });
  }

  /* 传给玻璃引擎的参数：磨砂要页面是深色才给，圆角不限；
   * 氛围背景只服务于玻璃，只开圆角时不该改页面底色。 */
  /* 圆角和玻璃在所有"开着"的模式下都生效（原生 / 动态 / 反色），开关打开就该有效果。
   * 反色模式：玻璃底色反着给（反完是深色）；氛围背景会被整页反色搞坏，所以只在非反色下给。 */
  function surfaceOpts() {
    var on = effMode !== 'off';
    var inv = effMode === 'invert';
    return Object.assign({}, settings, {
      glass: !!settings.glass && on,
      roundCorners: !!settings.roundCorners && on,
      ambience: !!settings.ambience && on && !inv,
      invert: inv
    });
  }

  function report() {
    if (!IS_TOP) return;
    send({
      type: LG_MSG.REPORT,
      host: HOST,
      mode: effMode,
      nativeDark: nativeDark,
      dark: LGDark.stats(),
      glass: glassOn ? LGGlass.stats() : { surfaces: 0 },
      prefers: prefersOn ? LGPrefers.stats() : { rules: 0 }
    });
  }

  /* ---------------- 设置热更新 ---------------- */

  function onSettings(next) {
    var prevMode = effMode;
    var prevGlass = glassOn;
    settings = next;

    var m = lgModeFor(settings, HOST);
    var want = m;
    if (m === 'auto') want = (nativeDark && settings.respectNativeDark) ? 'native' : 'dynamic';

    // 模式变了：整个推倒重来
    if (want !== prevMode) {
      LGDark.stop();
      if (prevGlass) { LGGlass.stop(); glassOn = false; }
      started = false;
      effMode = want;
      if (want === 'off') { retirePreload(); report(); return; }
      whenBody(startEngines);
      return;
    }

    // 只是调了滑块
    if (effMode === 'dynamic' || effMode === 'invert') LGDark.restyle(effMode, settings);

    var go = surfaceOpts();
    var wantSurfaces = IS_TOP && (go.glass || go.roundCorners);
    if (wantSurfaces && !glassOn) { glassOn = true; LGGlass.start(go); }
    else if (!wantSurfaces && glassOn) { LGGlass.stop(); glassOn = false; }
    else if (glassOn) LGGlass.restyle(go);

    report();
  }

  /* ---------------- 开发者模式：删除元素 ---------------- */

  var hideEl = null;
  function applyHide() {
    var sels = lgHideSelectorsFor(settings, HOST);
    if (!sels.length) { if (hideEl) { hideEl.remove(); hideEl = null; } return; }
    if (!hideEl || !hideEl.isConnected) {
      hideEl = document.createElement('style');
      hideEl.setAttribute('data-liquid-hide', '');
      (document.head || document.documentElement).appendChild(hideEl);
    }
    // 逐条包一层，一条选择器写错不会连累其它规则
    hideEl.textContent = sels.map(function (x) { return x + '{display:none !important}'; }).join('\n');
  }

  /* 为元素生成一个尽量稳的选择器：有 id 用 id，否则 标签.类名 往上最多 4 层 */
  function selectorFor(el) {
    var parts = [];
    for (var n = el, d = 0; n && n.nodeType === 1 && n !== document.body && d < 4; n = n.parentElement, d++) {
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break; }
      var cls = Array.prototype.filter.call(n.classList, function (c) {
        return /^[A-Za-z_-][\w-]*$/.test(c) && c.indexOf('lg') !== 0;
      }).slice(0, 3);
      parts.unshift(n.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : ''));
    }
    return parts.join(' > ');
  }

  var picking = false;
  function startPicker() {
    if (picking || !IS_TOP) return;
    picking = true;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
      'border:2px solid #ff4d6d;background:rgba(255,77,109,.15);border-radius:4px;transition:all .05s';
    var tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:6px 10px;' +
      'font:12px/1.4 system-ui;color:#fff;background:#23232b;border-radius:6px;pointer-events:none';
    tip.textContent = '点选要删除的元素，Esc 取消';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(tip);
    var cur = null;

    function over(e) {
      cur = e.target;
      var r = cur.getBoundingClientRect();
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
      tip.textContent = selectorFor(cur) + '　（点击删除，Esc 取消）';
    }
    function done() {
      picking = false;
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      box.remove(); tip.remove();
    }
    function click(e) {
      e.preventDefault(); e.stopPropagation();
      var sel = cur ? selectorFor(cur) : '';
      var pickedEl = cur;
      done();
      if (!sel || !pickedEl) return;
      // 存成 HTML：只留元素自己的开始标签（没有子元素时带上文字），子内容变了也照样认得出
      var clone = pickedEl.cloneNode(pickedEl.children.length === 0);
      Array.prototype.slice.call(clone.attributes).forEach(function (a) {
        if (a.name.indexOf('data-lg') === 0) clone.removeAttribute(a.name);
      });
      var html = clone.outerHTML;
      lgGetSettings().then(function (s) {
        s.hideHtml = (s.hideHtml || []).concat(html);
        return lgSaveSettings(s);
      });
    }
    function key(e) { if (e.key === 'Escape') { e.preventDefault(); done(); } }
    document.addEventListener('mouseover', over, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  try {
    browser.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.settings) return;
      var next = Object.assign({}, LG_DEFAULTS, changes.settings.newValue || {});
      settings = next;
      refreshElems();         // 名单要在引擎重算之前更新
      onSettings(next);
      applyHide();
    });
  } catch (e) {}

  try {
    browser.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === LG_MSG.PICK && IS_TOP) { startPicker(); return; }
      if (msg && msg.type === LG_MSG.STATE && IS_TOP) {
        return Promise.resolve({
          host: HOST, mode: effMode, nativeDark: nativeDark,
          dark: LGDark.stats(), glass: glassOn ? LGGlass.stats() : { surfaces: 0 }
        });
      }
    });
  } catch (e) {}

  lgGetSettings().then(function (s) {
    settings = s;
    if (!settings.holdRender) reveal();
    applyHide();          // 删除元素不受模式影响，关掉深色也照样删
    compileElemLists();
    compileHtmlPats();
    whenBody(function () { ensureHideStyle(); markElems(); watchElems(); });
    decideAndStart();
  });
})();
