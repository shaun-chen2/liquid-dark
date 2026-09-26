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
  var appliedIn = 0;
  var IN_MAX = 80;       // 全面玻璃模式下见 inMax()   // 内层不做 backdrop-filter，便宜得多，额度单独算

  // 全面玻璃模式下内层要能覆盖整页，额度放大；内层只是属性 + 纯 CSS，没有模糊开销
  function inMax() { return opts && opts.glassAll ? 5000 : IN_MAX; }

  function mark(el, kind) {
    var v = kind === true ? '' : kind;
    // 全面玻璃：真模糊的额度用满后，其余外层降级成不模糊的玻璃，而不是整块跳过 ——
    // 否则页面前半截有玻璃、后半截没有
    if (v === '' && opts.glassAll && applied >= opts.glassMax) v = 'in';
    if (v === 'in') { if (appliedIn >= inMax()) return false; appliedIn++; }
    else { if (applied >= opts.glassMax) return false; applied++; }
    keepSiteBackdrop(el);
    // 只开圆角不开玻璃时根本没有模糊，不用查
    if (opts.glass && (v === '' || v === 'edge') && movesDescendants(el, el)) el.setAttribute('data-lgnobf', '');
    el.setAttribute('data-lgg', v);
    return true;
  }

  /* ---------------- backdrop-filter 会挪动子元素 ----------------
   *
   * 按规范，backdrop-filter 不为 none 的元素会成为它里面 absolute / fixed 后代的包含块。
   * 于是本来相对外层容器或视口定位的角标、下拉、悬浮按钮，一加真玻璃就改成相对这块玻璃定位，
   * 整个跳走（假玻璃里的也一样 —— 它们的参照同样被外层真玻璃抢了）。
   * 所以真玻璃加模糊之前先查：里面有会被"抢走参照"的定位元素，就不加模糊（data-lgnobf），
   * 圆角、底色、描边、高光照旧。 */
  var SCAN_CAP = 800;     // 后代太多查不过来，保守起见当作会挪

  function gcs(el) { try { return getComputedStyle(el); } catch (e) { return null; } }

  /* 这个祖先是不是已经是包含块了（fixed 只认 transform/filter 这类，absolute 还认定位）。
   * ignoreBf：判断宿主时，它身上的模糊可能是我们自己加的，不能算"本来就是" */
  function isContainingBlock(cs, forFixed, ignoreBf) {
    if (!cs) return false;
    if (!forFixed && cs.position !== 'static') return true;
    return cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none' ||
      (!ignoreBf && cs.backdropFilter && cs.backdropFilter !== 'none') ||
      /paint|layout|strict|content/.test(cs.contain || '') ||
      /transform|filter|perspective/.test(cs.willChange || '');
  }

  /* d 的包含块会不会因为 host 加了 backdrop-filter 而变成 host */
  function anchorMoves(d, host) {
    var cs = gcs(d);
    if (!cs || (cs.position !== 'absolute' && cs.position !== 'fixed')) return false;
    var fixed = cs.position === 'fixed';
    for (var a = d.parentElement; a && a !== host; a = a.parentElement) {
      if (isContainingBlock(gcs(a), fixed)) return false;      // 中途已有参照，不受影响
    }
    // host 本来就是参照也不受影响；它身上的模糊除非是站点自己的（keepbf），否则不算
    return !!a && !isContainingBlock(gcs(host), fixed, !host.hasAttribute('data-lgkeepbf'));
  }

  /* root 自己及其后代里，有没有会被 host 抢走参照的 */
  function movesDescendants(root, host) {
    if (root !== host && anchorMoves(root, host)) return true;
    var list = root.getElementsByTagName('*');
    if (list.length > SCAN_CAP) return true;
    for (var i = 0; i < list.length; i++) if (anchorMoves(list[i], host)) return true;
    return false;
  }

  /* 站点自己给元素设了 backdrop-filter：内层 / 浮层也别给它改成 none */
  function keepSiteBackdrop(el) {
    if (el.hasAttribute('data-lgg') || el.hasAttribute('data-lgpop')) return;   // 已被我们改过，读到的不是站点原值
    var cs = gcs(el);
    if (cs && cs.backdropFilter && cs.backdropFilter !== 'none') el.setAttribute('data-lgkeepbf', '');
  }

  /* 新插进来的节点落在真玻璃里、且会被它抢走参照：撤掉那块玻璃的模糊。
   * 在 MutationObserver 回调里同步做 —— 回调跑在绘制之前，子元素不会先跳一下。 */
  var REAL_SEL = '[data-lgg=""]:not([data-lgnobf]),[data-lgg="edge"]:not([data-lgnobf])';
  function guardAdded(node) {
    if (!opts || !opts.glass) return;
    var host = node.parentElement && node.parentElement.closest ? node.parentElement.closest(REAL_SEL) : null;
    if (host && movesDescendants(node, host)) host.setAttribute('data-lgnobf', '');
  }
  function full() { return applied >= opts.glassMax && appliedIn >= inMax(); }

  /* 额度按页面上实际还在的玻璃重新数一遍。
   * 只加不减的话，SPA 换页后旧面板已经从 DOM 里没了，额度却还占着，新页面就一块玻璃都没有。
   * 属性选择器是浏览器原生匹配，很便宜。 */
  function recount() {
    try {
      appliedIn = document.querySelectorAll('[data-lgg="in"]').length;
      applied = document.querySelectorAll('[data-lgg]').length - appliedIn;
    } catch (e) {}
  }
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
      // 内层圆角比外层小一点，同心圆角才好看
      parts.push('html [data-lgg="in"]{border-radius:' + Math.max(6, opts.radius - 4) + 'px !important}');
    }

    if (opts.glass) {
      var a = (opts.glassOpacity / 100).toFixed(3);
      var b = opts.glassBlur;
      // 反色模式下整页会被 invert，玻璃的底色要先反着给，反完才是深色
      var tint = opts.invert ? '223,223,215' : '32,32,40';
      parts.push([
        'html [data-lgg]{',
        'background-color:rgba(', tint, ',', a, ') !important;',
        // 顶边那道高光，液态玻璃的关键笔触
        'background-image:linear-gradient(to bottom,rgba(255,255,255,.070),rgba(255,255,255,.012) 38%,rgba(255,255,255,0) 72%) !important;',
        // outline 不参与布局，border 会撑大盒子
        'outline:1px solid rgba(255,255,255,.11) !important;outline-offset:-1px !important;',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.14),',
        'inset 0 -1px 0 rgba(0,0,0,.30),',
        '0 10px 34px rgba(0,0,0,.34) !important}'
      ].join(''));
      parts.push('html [data-lgg=""],html [data-lgg="edge"]{' +
        '-webkit-backdrop-filter:blur(' + b + 'px) saturate(180%) !important;' +
        'backdrop-filter:blur(' + b + 'px) saturate(180%) !important}');
      parts.push('html [data-lgg="edge"]{outline:none !important;' +
        'box-shadow:inset 0 -1px 0 rgba(255,255,255,.10),0 8px 28px rgba(0,0,0,.30) !important}');

      // 内层玻璃：不再模糊，薄白提亮（反色模式下给薄黑，反完就是提亮）
      var ai = (0.04 + (opts.glassOpacity / 100) * 0.06).toFixed(3);
      var lift = opts.invert ? '0,0,0' : '255,255,255';
      parts.push([
        'html [data-lgg="in"]{',
        'background-color:rgba(', lift, ',', ai, ') !important;',
        'background-image:linear-gradient(to bottom,rgba(', lift, ',.06),rgba(', lift, ',0) 60%) !important;',
        'outline:1px solid rgba(', lift, ',.10) !important;outline-offset:-1px !important;',
        'box-shadow:inset 0 1px 0 rgba(', lift, ',.10),0 4px 16px rgba(0,0,0,.26) !important}'
      ].join(''));
      /* 叠层不累加：每层内层玻璃都铺一层薄白 + 顶光，一层层叠上去会越来越白（四层就发灰发白）。
       * 第二层底色减半、去掉顶光；第三层起不再铺底，只靠描边分层 —— 亮度有上限，再深也不会更白。 */
      parts.push('html [data-lgg="in"] [data-lgg="in"]{' +
        'background-color:rgba(' + lift + ',' + (ai / 2).toFixed(3) + ') !important;background-image:none !important}');
      parts.push('html [data-lgg="in"] [data-lgg="in"] [data-lgg="in"]{' +
        'background-color:transparent !important;box-shadow:none !important}');
      // 内层玻璃的细边会盖掉输入框、按钮的焦点提示，聚焦时换成明显的蓝边
      parts.push('html [data-lgg="in"]:focus,html [data-lgg="in"]:focus-visible{' +
        'outline:2px solid rgba(122,150,255,.75) !important;outline-offset:1px !important}');
      // 按钮、输入框做成玻璃后投影太重，收一点
      parts.push('html button[data-lgg="in"],html input[data-lgg="in"],html select[data-lgg="in"],html textarea[data-lgg="in"]{' +
        'box-shadow:inset 0 1px 0 rgba(' + lift + ',.10) !important}');
    }

    // 预标记：加载时就给隐藏的浮窗候选铺上不透明底色，
    // 这样它一出现就是深色的，不会先闪一下白再变黑。
    // 选择器重复一次是为了提权到 (0,2,1)，压过 `html [data-lgg]` 的半透明玻璃，
    // 这样即使别处把它判成了普通玻璃面，浮窗也不会变成半透明
    parts.push('html [data-lgpop][data-lgpop]{background-color:#23232b !important;' +
      'background-image:none !important}');

    // 浮层（下拉、菜单、气泡）一律不透明，不做磨砂。
    // 半透明 + 模糊压在正文上会把菜单文字糊掉，可读性优先于观感。
    parts.push([
      'html [data-lgg="pop"]{',
      'background-color:#23232b !important;background-image:none !important;',
      'outline:1px solid rgba(255,255,255,.12) !important;outline-offset:-1px !important;',
      'box-shadow:0 14px 40px rgba(0,0,0,.55) !important}'
    ].join(''));

    /* 不做模糊的几类：内层、浮层、预标记的浮窗、以及会挪动子元素而撤掉模糊的真玻璃（nobf）。
     * 站点自己本来就有 backdrop-filter 的（keepbf）不去掉 —— 它可能正是里面 fixed 子元素的定位参照，
     * 改成 none 会让那些子元素跑位。选择器带 :not()，权重压得过上面真玻璃那条。 */
    parts.push('html [data-lgg="in"]:not([data-lgkeepbf]),html [data-lgg="pop"]:not([data-lgkeepbf]),' +
      'html [data-lgpop][data-lgpop]:not([data-lgkeepbf]),html [data-lgg][data-lgnobf]:not([data-lgkeepbf]){' +
      '-webkit-backdrop-filter:none !important;backdrop-filter:none !important}');
    if (opts.glass) {
      // 没有模糊的真玻璃：半透明会直接透出背后的字，底色加厚
      parts.push('html [data-lgg][data-lgnobf]:not([data-lgg="in"]):not([data-lgg="pop"]){background-color:rgba(' +
        (opts.invert ? '223,223,215' : '32,32,40') + ',' + Math.max(opts.glassOpacity / 100, 0.9).toFixed(3) + ') !important}');
    }

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
  /* 全面玻璃：凡是"看得出是一块东西"的元素都做圆角 + 玻璃。
   * 判据：有底色 / 边框 / 投影任一项，尺寸 ≥ 40×20。
   * 真模糊只给最外层（受 glassMax 限制），里面一律是不模糊的内层玻璃，开销很小，
   * 所以可以放得很宽。 */
  var ALL_SKIP = {
    HTML: 1, BODY: 1, IMG: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, IFRAME: 1, SVG: 1,
    SCRIPT: 1, STYLE: 1, LINK: 1, HEAD: 1, META: 1, BR: 1, HR: 1, OPTION: 1,
    TR: 1, TD: 1, TH: 1, TBODY: 1, THEAD: 1, TFOOT: 1, PRE: 1, CODE: 1, KBD: 1, SAMP: 1,
    PICTURE: 1, SOURCE: 1, OBJECT: 1, EMBED: 1
  };
  var FORM = { INPUT: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1 };
  var NO_BOX_INPUT = { checkbox: 1, radio: 1, range: 1, color: 1, file: 1, hidden: 1, image: 1 };

  function isSurfaceAll(el, tag) {
    if (ALL_SKIP[tag]) return false;
    if (tag === 'INPUT' && NO_BOX_INPUT[(el.type || '').toLowerCase()]) return false;

    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
    // 按钮、输入框天生就小，门槛单独放低
    if (FORM[tag] ? (rect.width < 16 || rect.height < 14) : (rect.width < 40 || rect.height < 20)) return false;

    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.display === 'inline' || cs.display === 'contents') return false;

    var bg = lgParseColor(cs.backgroundColor);
    var hasBg = bg && bg.a > 0.05;
    var hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    var bw = parseFloat(cs.borderTopWidth) || 0;
    var bc = lgParseColor(cs.borderTopColor);
    var hasBorder = bw > 0 && bc && bc.a > 0.05 && cs.borderTopStyle !== 'none';
    if (!hasBg && !hasShadow && !hasBorder && !FORM[tag]) return false;

    var vw = window.innerWidth || 1200;
    var pos = cs.position;
    var host = el.parentElement && el.parentElement.closest ? el.parentElement.closest('[data-lgg]') : null;

    if (host) {
      if (host.getAttribute('data-lgg') === 'pop') return false;
      var depth = 0, p = host;
      while (p && depth < 8) {
        depth++;
        p = p.parentElement && p.parentElement.closest ? p.parentElement.closest('[data-lgg]') : null;
      }
      if (depth >= Math.max(opts.glassDepth || 1, 4)) return false;
      // 和父级几乎一样大的纯包装层不单独成块，否则同一块地方叠好几层
      var hr = host.getBoundingClientRect();
      var ha = hr.width * hr.height;
      if (!FORM[tag] && ha > 0 && rect.width * rect.height > ha * 0.85) return false;
      return 'in';
    }

    if (FORM[tag]) return 'in';                       // 顶层的按钮、输入框也不做模糊，便宜
    if (pos === 'fixed' || pos === 'sticky') return 'edge';
    if (rect.width >= vw * 0.95) return false;          // 整页包装层
    if (isPageColumn(rect)) return false;               // 整页高的主栏
    return true;
  }

  function isSurface(el) {
    var tag = el.tagName;
    if (typeof tag !== 'string') return false;
    tag = tag.toUpperCase();

    if (opts && opts.glassAll && !el.hasAttribute('data-lgg') && !lgElemIs(el, 'glassBlock')) {
      // 浮层仍走原来的判定（必须不透明）。只有类名 / role 像浮窗的才走 ——
      // 否则每个元素都要多读一遍样式和尺寸，几千个元素的页面上整页重扫从几十毫秒涨到三百多毫秒
      if (lgElemIs(el, 'glassForce')) return isSurfaceStrict(el, tag) || true;
      var role = el.getAttribute('role');
      if ((role && POP_ROLES[role.toLowerCase()]) || POP_CLASS.test(String(el.className || ''))) {
        var popKind = isSurfaceStrict(el, tag);
        if (popKind === 'pop') return 'pop';
      }
      return isSurfaceAll(el, tag);
    }
    return isSurfaceStrict(el, tag);
  }

  function isSurfaceStrict(el, tag) {
    if (SKIP[tag]) return false;
    if (el.hasAttribute('data-lgg')) return false;
    if (lgElemIs(el, 'glassBlock')) return false;      // 元素黑名单：不变玻璃

    var rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!lgElemIs(el, 'glassForce') && (rect.width < 90 || rect.height < 26)) return false;

    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;

    // 元素白名单：强制变玻璃，跳过所有判据（套在别的玻璃里就做内层）
    if (lgElemIs(el, 'glassForce')) {
      var fh = el.parentElement && el.parentElement.closest ? el.parentElement.closest('[data-lgg]') : null;
      return fh && fh.getAttribute('data-lgg') !== 'pop' ? 'in' : true;
    }

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

    /* 嵌套：允许"大玻璃里套小玻璃"。
     * 内层（'in'）不再做 backdrop-filter —— 父级已经把背景糊过了，再糊一次只会叠加发闷，
     * 还多一个 GPU 图层。内层只铺一层薄白提亮 + 细边 + 顶光，读出来就是"浮起来的一块"。
     * 限制：不超过 glassDepth 层；和父级差不多大（>85% 面积）的纯包装层不算；浮层里面不再分层。 */
    var host = el.parentElement && el.parentElement.closest ? el.parentElement.closest('[data-lgg]') : null;
    var nested = false;
    if (host) {
      if (host.getAttribute('data-lgg') === 'pop') return false;
      var depth = 0, p = host;
      while (p && depth < 8) {
        depth++;
        p = p.parentElement && p.parentElement.closest ? p.parentElement.closest('[data-lgg]') : null;
      }
      if (depth >= (opts.glassDepth || 1)) return false;
      var hr = host.getBoundingClientRect();
      var ha = hr.width * hr.height;
      if (ha > 0 && rect.width * rect.height > ha * 0.85) return false;
      nested = true;
    }

    var area = rect.width * rect.height;

    if (nested) {
      if (rect.width >= vw * 0.95) return false;
      if (TAGS[tag] || ROLES[role]) return 'in';
      // 内层卡片常常没有投影（投影在外层容器上），有底色 + 圆角/边框/投影任一即可
      var radius = parseFloat(cs.borderTopLeftRadius) || 0;
      var bw = parseFloat(cs.borderTopWidth) || 0;
      if (hasBg && area >= 6000 && (hasShadow || radius >= 4 || bw > 0)) return 'in';
      if (hasBg && area >= 20000 && bgDiffersFromParent(el, cs.backgroundColor)) return 'in';
      return false;
    }

    // 吸顶 / 悬浮条天生就是通栏的，不受下面的宽度判据约束
    if (pos === 'fixed' || pos === 'sticky') return 'edge';

    if (rect.width >= vw * 0.95) return false;      // 整页包装层，不是面板

    if (TAGS[tag]) return true;
    if (ROLES[role]) return true;

    // 卡片 / 弹窗：有底色 + 有投影就够了。
    if (hasShadow && hasBg && area >= 9000) return true;

    /* 没投影、没圆角、没边框的卡片（洛谷首页的 .lg-article 就是）：
     * 只要底色和所在容器不一样，本身就是一块独立面板。
     * 不认这种的话，外层大卡片落选、里面的小卡片反被当成顶层玻璃 —— 里外颠倒。 */
    if (hasBg && area >= 20000 && !isPageColumn(rect) && bgDiffersFromParent(el, cs.backgroundColor)) return true;

    return false;
  }

  /* 页面主栏：几乎和整页一样高的是底板，不是卡片（洛谷的 .main-container 就是灰底主栏） */
  function isPageColumn(rect) {
    var docH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    return docH > 0 && rect.height >= docH * 0.7;
  }

  /* 往上找第一个有不透明底色的祖先，比较底色是否不同 */
  function bgDiffersFromParent(el, bg) {
    var p = el.parentElement;
    while (p && p !== document.documentElement) {
      var c;
      try { c = getComputedStyle(p).backgroundColor; } catch (e) { return false; }
      var pc = lgParseColor(c);
      if (pc && pc.a > 0.05) return c !== bg;
      p = p.parentElement;
    }
    return true;
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
    if (!running || full()) return;
    var els;
    try { els = root.querySelectorAll('*'); } catch (e) { return; }
    for (var i = 0; i < els.length && !full(); i++) {
      var el = els[i];
      if (evaluated.has(el)) continue;
      evaluated.add(el);
      var kind = isSurface(el);
      if (kind) mark(el, kind);
    }
  }

  /* 外层可能比内层晚成为玻璃（SPA 后渲染、样式晚到）。
   * 这时里面早先被标成顶层（带真模糊）的卡片要降级成内层，否则玻璃套玻璃、里外颠倒。 */
  function demoteNested() {
    var tops = document.querySelectorAll('[data-lgg=""]');
    for (var i = 0; i < tops.length; i++) {
      var el = tops[i];
      var host = el.parentElement && el.parentElement.closest ? el.parentElement.closest('[data-lgg]') : null;
      if (!host || host.getAttribute('data-lgg') === 'pop') continue;
      if (appliedIn >= inMax()) break;
      el.setAttribute('data-lgg', 'in');
      applied--; appliedIn++;
    }
  }

  function scan() { scanIn(document); demoteNested(); }

  /* 分片扫描：每跑 8 毫秒就让出主线程，几千个元素的整页重扫不会卡页面。
   * 只用于后续重扫；第一轮仍然同步，保证放行渲染时玻璃已经就位。 */
  var sliceGen = 0;
  function scanSliced(after) {
    var gen = ++sliceGen;                 // 新一轮开始时，旧的那轮自动作废
    recount();
    var els;
    try { els = document.querySelectorAll('*'); } catch (e) { return; }
    var i = 0;
    (function step() {
      if (!running || gen !== sliceGen) return;
      var t = performance.now();
      while (i < els.length && !full()) {
        var el = els[i++];
        if (!evaluated.has(el)) {
          evaluated.add(el);
          if (el.isConnected) { var k = isSurface(el); if (k) mark(el, k); }
        }
        if ((i & 31) === 0 && performance.now() - t > 8) { setTimeout(step, 0); return; }
      }
      demoteNested();
      if (after) after();
    })();
  }

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
        if (el.getClientRects().length === 0) { keepSiteBackdrop(el); el.setAttribute('data-lgpop', ''); }
      } catch (e) {}
    }
  }

  /* 候选里已经显示出来的，升级成完整浮层样式；
   * 显示出来但其实不是浮层的，把预标记撤掉。 */
  function checkPopCandidates() {
    if (!running || !opts) return;
    if (popCand.length) recount();
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
        keepSiteBackdrop(el);
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
    recount();
    var q = queue;
    queue = [];
    for (var i = 0; i < q.length && !full(); i++) {
      var n = q[i];
      if (!n || n.nodeType !== 1 || !n.isConnected) continue;
      if (!evaluated.has(n)) {
        evaluated.add(n);
        var kind = isSurface(n);
        if (kind) mark(n, kind);
      }
      scanIn(n);
    }
    demoteNested();
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
          for (var j = 0; j < a.length; j++) {
            if (a[j].nodeType !== 1) continue;
            queue.push(a[j]);
            guardAdded(a[j]);
          }
        }
        if (queue.length) scanSoon();
      });
      try {
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}

      collectPopCandidates(true);
      checkPopCandidates();
      bindPopHooks();

      /* SPA 页面（洛谷首页就是）内容是后渲染的，第一遍扫描时外层卡片的样式/布局还没到位，
       * 被判"不是面板"后记进 evaluated 就再也不看了。补扫几次，每次清空判定缓存。 */
      [900, 2500, 5000].forEach(function (ms) {
        setTimeout(function () {
          if (!running) return;
          evaluated = new WeakSet();
          scanSliced(markBackdrops);
        }, ms);
      });
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
      scanSliced(markBackdrops);
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
      var nbs = document.querySelectorAll('[data-lgnobf],[data-lgkeepbf]');
      for (var z = 0; z < nbs.length; z++) { nbs[z].removeAttribute('data-lgnobf'); nbs[z].removeAttribute('data-lgkeepbf'); }
      var pps = document.querySelectorAll('[data-lgpop]');
      for (var q = 0; q < pps.length; q++) pps[q].removeAttribute('data-lgpop');
      applied = 0;
      appliedIn = 0;
      evaluated = new WeakSet();
      queue = [];
    },

    stats: function () { if (running) recount(); return { surfaces: applied, nested: appliedIn }; }
  };
})();
