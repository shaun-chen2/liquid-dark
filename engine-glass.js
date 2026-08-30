'use strict';

/* 液态玻璃。
 *
 * 挑出页面里"像一块面板"的元素（吸顶栏、导航、侧栏、弹窗、卡片），
 * 给它们加 backdrop-filter 模糊 + 半透明底 + 顶边高光 + 环形描边。
 *
 * 两个细节决定了像不像：
 *   1. 描边用 outline + 负 offset，不用 border —— border 会撑大盒子改变布局
 *   2. 顶部那道高光用 background-image 的线性渐变做，不用伪元素 ——
 *      站点自己的 ::before/::after 经常有用途，覆盖掉会出事
 *
 * 另外 backdrop-filter 模糊的是"背后的东西"，如果页面底是一块纯色，
 * 玻璃是看不出来的。所以配了一层氛围背景，让玻璃有东西可折射。 */

var LGGlass = (function () {

  var SKIP = {
    HTML: 1, BODY: 1, IMG: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, IFRAME: 1,
    SVG: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, SCRIPT: 1,
    STYLE: 1, LINK: 1, HEAD: 1, META: 1, BR: 1, HR: 1, TABLE: 1, TR: 1, TD: 1, TH: 1,
    PRE: 1, CODE: 1, KBD: 1, SAMP: 1
  };

  var ROLES = {
    dialog: 1, alertdialog: 1, navigation: 1, banner: 1,
    menu: 1, menubar: 1, toolbar: 1, complementary: 1
  };

  var TAGS = { HEADER: 1, NAV: 1, ASIDE: 1, DIALOG: 1 };

  var POP_ROLES = { menu: 1, menubar: 1, listbox: 1, tooltip: 1, combobox: 1 };
  var POP_CLASS = /(^|[\s_-])(dropdown|drop-down|popover|popup|tooltip|menu|flyout|autocomplete|suggest)([\s_-]|$)/i;

  /* 页面加载时就把"可能是浮窗"的元素一次性圈出来。
   * 用一条 querySelectorAll 而不是逐个 getComputedStyle —— 选择器匹配是浏览器原生的，
   * 快得多，几千个元素的页面上也就几毫秒。 */
  var POP_SEL = [
    '[role=menu]', '[role=menubar]', '[role=listbox]', '[role=tooltip]', '[role=combobox]',
    '[class*=dropdown]', '[class*=Dropdown]', '[class*=popover]', '[class*=Popover]',
    '[class*=popup]', '[class*=Popup]', '[class*=tooltip]', '[class*=Tooltip]',
    '[class*=menu]', '[class*=Menu]', '[class*=flyout]', '[class*=Flyout]',
    '[class*=autocomplete]', '[class*=suggest]'
  ].join(',');
  var POP_MAX = 600;

  var opts = null;
  var styleEl = null;
  var applied = 0;
  var mo = null;
  var timer = 0;
  var running = false;
  var evaluated = new WeakSet();
  var queue = [];
  var popCand = [];
  var popScheduled = false;
  var popCollectAt = 0;
  var hoverTimer = 0;
  var popHooks = null;

  /* 圆角和玻璃是两套独立的规则，各自开关。 */
  function css() {
    var parts = [];

    if (opts.roundCorners) {
      parts.push('html [data-lgg]{border-radius:' + opts.radius + 'px !important}');
      // 通栏的吸顶 / 悬浮条加圆角很怪，保持直角
      parts.push('html [data-lgg="edge"]{border-radius:0 !important}');
    }

    if (opts.glass) {
      var a = (opts.glassOpacity / 100).toFixed(3);
      var b = opts.glassBlur;
      parts.push([
        'html [data-lgg]{',
        'background-color:rgba(32,32,40,', a, ') !important;',
        // 顶边那道高光，液态玻璃的关键笔触
        'background-image:linear-gradient(to bottom,rgba(255,255,255,.070),rgba(255,255,255,.012) 38%,rgba(255,255,255,0) 72%) !important;',
        '-webkit-backdrop-filter:blur(', b, 'px) saturate(180%) !important;',
        'backdrop-filter:blur(', b, 'px) saturate(180%) !important;',
        // outline 不参与布局，border 会撑大盒子
        'outline:1px solid rgba(255,255,255,.11) !important;outline-offset:-1px !important;',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.14),',
        'inset 0 -1px 0 rgba(0,0,0,.30),',
        '0 10px 34px rgba(0,0,0,.34) !important}'
      ].join(''));
      parts.push('html [data-lgg="edge"]{outline:none !important;' +
        'box-shadow:inset 0 -1px 0 rgba(255,255,255,.10),0 8px 28px rgba(0,0,0,.30) !important}');
    }

    // 预标记：加载时就给隐藏的浮窗候选铺上不透明底色，
    // 这样它一出现就是深色的，不会先闪一下白再变黑。
    // 选择器重复一次是为了提权到 (0,2,1)，压过 `html [data-lgg]` 的半透明玻璃，
    // 这样即使别处把它判成了普通玻璃面，浮窗也不会变成半透明
    parts.push('html [data-lgpop][data-lgpop]{background-color:#23232b !important;' +
      'background-image:none !important;' +
      '-webkit-backdrop-filter:none !important;backdrop-filter:none !important}');

    // 浮层（下拉、菜单、气泡）一律不透明，不做磨砂。
    // 半透明 + 模糊压在正文上会把菜单文字糊掉，可读性优先于观感。
    parts.push([
      'html [data-lgg="pop"]{',
      'background-color:#23232b !important;background-image:none !important;',
      '-webkit-backdrop-filter:none !important;backdrop-filter:none !important;',
      'outline:1px solid rgba(255,255,255,.12) !important;outline-offset:-1px !important;',
      'box-shadow:0 14px 40px rgba(0,0,0,.55) !important}'
    ].join(''));

    return parts.join('');
  }

  function ambienceCss() {
    return [
      'html[data-lgamb]{',
      'background-color:#0d0d11 !important;',
      'background-image:',
      'radial-gradient(1100px 780px at 8% -12%,rgba(116,92,255,.20),transparent 62%),',
      'radial-gradient(880px 700px at 92% 4%,rgba(0,168,255,.15),transparent 64%),',
      'radial-gradient(1000px 860px at 52% 112%,rgba(255,82,150,.12),transparent 60%) !important;',
      'background-attachment:fixed !important;background-repeat:no-repeat !important}',
      'html[data-lgamb] body{background-color:transparent !important}',
      'html[data-lgamb] [data-lgbd]{background-color:transparent !important;background-image:none !important}'
    ].join('');
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-liquid-glass', '');
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function sync() {
    ensureStyle();
    var t = css() + (opts.ambience ? ambienceCss() : '');
    if (styleEl.textContent !== t) styleEl.textContent = t;
  }

  /* 这个元素像不像一块"面"？返回 false / 'pop' / 'edge' / true
   *
   * 关键判据是**宽度**不是面积。早期版本用 "面积 > 82% 视口就否决"，
   * 结果一根 870×5494 的内容主列（很常见的布局）直接被误杀成"页面底板"。
   * 长不等于大：真正该排除的是铺满整个视口宽度的包装层。 */
  function isSurface(el) {
    var tag = el.tagName;
    if (typeof tag !== 'string') return false;
    tag = tag.toUpperCase();
    if (SKIP[tag]) return false;
    if (el.hasAttribute('data-lgg')) return false;

    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
    if (rect.width < 90 || rect.height < 26) return false;

    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;

    var bg = lgParseColor(cs.backgroundColor);
    var hasBg = bg && bg.a > 0.05;
    var hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    if (!hasBg && !hasShadow) return false;

    var pos = cs.position;
    var role = (el.getAttribute('role') || '').toLowerCase();
    var vw = window.innerWidth || 1200;
    var vh = window.innerHeight || 800;

    /* 浮层最先判，而且要在"祖先已是玻璃就跳过"那条保护之前 ——
     * 下拉菜单往往正好挂在已经被玻璃化的 nav 里面，
     * 走那条保护会被直接跳过，而它恰恰是最需要单独处理的一类。 */
    var floating = (pos === 'absolute' || pos === 'fixed') &&
                   rect.width < vw * 0.9 &&
                   rect.width * rect.height < vw * vh * 0.45;
    var looksPop = POP_ROLES[role] || POP_CLASS.test(String(el.className || ''));
    var smallEnough = rect.width < vw * 0.9 && rect.width * rect.height < vw * vh * 0.45;

    /* 浮层可以待在玻璃面里（下拉常常正好挂在已被玻璃化的 nav 里），
     * 但不能套在另一个浮层里 —— 否则菜单里每个 li 都会各自变成一块面板。
     * 所以这里只挡"祖先是浮层"，不挡"祖先是玻璃"。 */
    var inPop = el.closest && el.closest('[data-lgg="pop"]');
    if (!inPop) {
      if (floating && (looksPop || parseInt(cs.zIndex, 10) > 0)) return 'pop';

      /* 看着像菜单但没有 absolute/fixed 的（Hydro 的下拉实测就是 static）：
       * 也归到不透明浮层，绝不能让它落进半透明玻璃那一支 ——
       * rgba(...,.55) + saturate(180%) 压在氛围渐变上会明显发浅，
       * 而圆角和玻璃来自同一个 data-lgg，用户看到的就是"圆角一出现就变浅"。 */
      if (looksPop && smallEnough) return 'pop';
    }

    if (el.closest && el.closest('[data-lgg]')) return false;   // 别在玻璃上再叠玻璃

    // 吸顶 / 悬浮条天生就是通栏的，不受下面的宽度判据约束
    if (pos === 'fixed' || pos === 'sticky') return 'edge';

    if (rect.width >= vw * 0.95) return false;      // 整页包装层，不是面板

    if (TAGS[tag]) return true;
    if (ROLES[role]) return true;

    // 卡片 / 弹窗：有底色 + 有投影就够了。
    // 不再要求自带圆角 —— 很多站点用直角卡片，而圆角本来就是我们自己加的。
    if (hasShadow && hasBg && rect.width * rect.height >= 9000) return true;

    return false;
  }

  /* 氛围背景的死敌：整页包装层。
   *
   * 很多站点在 body 底下套一层铺满全宽的不透明容器（Hydro 的 #panel 就是，
   * 实测 99% 宽、不透明浅灰）。我们把它染成深色之后，它会把 html 上的氛围渐变
   * 整个盖死 —— 玻璃背后是一块纯色，磨砂就完全看不出来了。
   * 所以顺着 body 往下找这条"全宽不透明"的链，把它们打透。 */
  function markBackdrops() {
    if (!opts.ambience) return;
    var vw = window.innerWidth || 1200;
    var vh = window.innerHeight || 800;
    var node = document.body;
    var depth = 0;

    while (node && depth < 8) {
      var next = null;
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i], r, cs;
        try { r = el.getBoundingClientRect(); cs = getComputedStyle(el); } catch (e) { continue; }
        // 底板必须既宽**又高**。只看宽度会把一条全宽的普通内容 div 也误判成底板打透。
        if (r.width < vw * 0.9 || r.left > vw * 0.05) continue;
        if (r.height < vh * 0.6) continue;
        if (cs.position === 'fixed' || cs.position === 'sticky') continue;   // 那是吸顶条
        var c = lgParseColor(cs.backgroundColor);
        if (c && c.a > 0.5) el.setAttribute('data-lgbd', '');
        if (!next) next = el;
      }
      node = next;
      depth++;
    }
  }

  /* 判过的元素记下来，别每次 DOM 一动就把整个文档重量一遍 ——
   * getBoundingClientRect + getComputedStyle + closest 三件套在大页面上很贵。 */
  function scanIn(root) {
    if (!running || applied >= opts.glassMax) return;
    var els;
    try { els = root.querySelectorAll('*'); } catch (e) { return; }
    for (var i = 0; i < els.length && applied < opts.glassMax; i++) {
      var el = els[i];
      if (evaluated.has(el)) continue;
      evaluated.add(el);
      var kind = isSurface(el);
      if (!kind) continue;
      el.setAttribute('data-lgg', kind === true ? '' : kind);
      applied++;
    }
  }

  function scan() { scanIn(document); }

  /* ---------------- 浮窗预处理 ---------------- */

  /* 这条选择器有十几个属性匹配，SPA 上每次 DOM 变动都重跑会很贵，节流到 1 秒一次。
   * 漏掉的新浮窗会被事件钩子那一路兜住。 */
  function collectPopCandidates(force) {
    var now = (performance && performance.now) ? performance.now() : 0;
    if (!force && now - popCollectAt < 1000) return;
    popCollectAt = now;
    var list;
    try { list = document.querySelectorAll(POP_SEL); } catch (e) { return; }
    popCand = [];
    for (var i = 0; i < list.length && popCand.length < POP_MAX; i++) {
      var el = list[i];
      if (el.hasAttribute('data-lgg')) continue;
      popCand.push(el);
      // 当前没有布局盒（藏着）的，先把底色铺上 —— 这就是"预加载"
      try {
        if (el.getClientRects().length === 0) el.setAttribute('data-lgpop', '');
      } catch (e) {}
    }
  }

  /* 候选里已经显示出来的，升级成完整浮层样式；
   * 显示出来但其实不是浮层的，把预标记撤掉。 */
  function checkPopCandidates() {
    if (!running || !opts) return;
    var keep = [];
    for (var i = 0; i < popCand.length; i++) {
      var el = popCand[i];
      if (!el.isConnected) continue;
      if (el.hasAttribute('data-lgg')) continue;

      var visible = false;
      try { visible = el.getClientRects().length > 0; } catch (e) {}
      if (!visible) { keep.push(el); continue; }      // 还藏着，留着下次看

      var kind = isSurface(el);
      if (kind && applied < opts.glassMax) {
        // 候选是按浮窗选择器圈出来的，一旦够格成"面"，就一律按浮层处理，
        // 不允许落进半透明玻璃 —— 菜单半透明就读不清了
        el.setAttribute('data-lgg', 'pop');
        el.setAttribute('data-lgpop', '');
        applied++;
        continue;
      }
      /* 判不出来时**保留**深色预标记，不要撤。
       * 撤掉等于把站点原来的浅色底重新露出来，正是"显示一会儿后变浅"的成因。
       * 只有明显是大块页面区域（不可能是浮窗）才撤。 */
      var rc = el.getBoundingClientRect();
      var vpArea = (window.innerWidth || 1200) * (window.innerHeight || 800);
      if (rc.width * rc.height > vpArea * 0.55) el.removeAttribute('data-lgpop');
    }
    popCand = keep;
  }

  /* 关键：在触发事件之后的同一帧里复查。
   * 站点的展开逻辑跑在事件冒泡阶段，rAF 回调排在它之后、绘制之前，
   * 所以菜单还没被画出来就已经带上样式了 —— 不会先闪一下浅色。 */
  function schedulePopCheck() {
    if (popScheduled) return;
    popScheduled = true;
    try {
      requestAnimationFrame(function () { popScheduled = false; checkPopCandidates(); });
    } catch (e) { popScheduled = false; }
    // 有些站点是延时展开的，补两次
    setTimeout(checkPopCandidates, 90);
    setTimeout(checkPopCandidates, 280);
  }

  function onHover() {
    if (hoverTimer || popCand.length > 200) return;   // 纯 CSS 悬停菜单，节流着看
    hoverTimer = setTimeout(function () { hoverTimer = 0; checkPopCandidates(); }, 130);
  }

  function bindPopHooks() {
    if (popHooks) return;
    popHooks = [];
    var evts = ['pointerdown', 'mousedown', 'click', 'keydown', 'focusin'];
    for (var i = 0; i < evts.length; i++) {
      try { document.addEventListener(evts[i], schedulePopCheck, true); popHooks.push(evts[i]); } catch (e) {}
    }
    try { document.addEventListener('mouseover', onHover, true); } catch (e) {}
  }

  function unbindPopHooks() {
    if (!popHooks) return;
    for (var i = 0; i < popHooks.length; i++) {
      try { document.removeEventListener(popHooks[i], schedulePopCheck, true); } catch (e) {}
    }
    try { document.removeEventListener('mouseover', onHover, true); } catch (e) {}
    popHooks = null;
  }

  function flushQueue() {
    timer = 0;
    var q = queue;
    queue = [];
    for (var i = 0; i < q.length && applied < opts.glassMax; i++) {
      var n = q[i];
      if (!n || n.nodeType !== 1 || !n.isConnected) continue;
      if (!evaluated.has(n)) {
        evaluated.add(n);
        var kind = isSurface(n);
        if (kind) { n.setAttribute('data-lgg', kind === true ? '' : kind); applied++; }
      }
      scanIn(n);
    }
    collectPopCandidates();
    checkPopCandidates();
  }

  function scanSoon() {
    if (timer) return;
    timer = setTimeout(flushQueue, 400);
  }

  return {
    start: function (o) {
      opts = o;
      running = true;
      sync();
      if (opts.ambience) document.documentElement.setAttribute('data-lgamb', '');
      scan();
      markBackdrops();
      if (mo) return;
      mo = new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) {
          var a = list[i].addedNodes;
          for (var j = 0; j < a.length; j++) if (a[j].nodeType === 1) queue.push(a[j]);
        }
        if (queue.length) scanSoon();
      });
      try {
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}

      collectPopCandidates(true);
      checkPopCandidates();
      bindPopHooks();
    },

    restyle: function (o) {
      opts = o;
      if (!running) return;
      if (opts.ambience) {
        document.documentElement.setAttribute('data-lgamb', '');
        markBackdrops();
      } else {
        document.documentElement.removeAttribute('data-lgamb');
      }
      sync();
    },

    /* load 之后布局才最终定下来，之前判成"太小"的元素可能其实是块面板。
     * 这里清一次判定缓存做整页重扫 —— 只在 load 时发生一次，不是常态开销。 */
    rescan: function () {
      if (!running) return;
      evaluated = new WeakSet();
      scan();
      markBackdrops();
      collectPopCandidates(true);
      checkPopCandidates();
    },

    stop: function () {
      running = false;
      if (mo) { mo.disconnect(); mo = null; }
      unbindPopHooks();
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
      popCand = [];
      popCollectAt = 0;
      if (timer) { clearTimeout(timer); timer = 0; }
      if (styleEl) { try { styleEl.remove(); } catch (e) {} styleEl = null; }
      document.documentElement.removeAttribute('data-lgamb');
      var els = document.querySelectorAll('[data-lgg]');
      for (var i = 0; i < els.length; i++) els[i].removeAttribute('data-lgg');
      var bds = document.querySelectorAll('[data-lgbd]');
      for (var k = 0; k < bds.length; k++) bds[k].removeAttribute('data-lgbd');
      var pps = document.querySelectorAll('[data-lgpop]');
      for (var q = 0; q < pps.length; q++) pps[q].removeAttribute('data-lgpop');
      applied = 0;
      evaluated = new WeakSet();
      queue = [];
    },

    stats: function () { return { surfaces: applied }; }
  };
})();
