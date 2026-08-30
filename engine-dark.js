'use strict';

/* 深色引擎。
 *
 * 动态模式：遍历元素读 computed style，把浅背景/深文字按 HSL 映射到深色，
 * 按"原始颜色"分桶生成 CSS 规则，元素上只挂一个 data-lgd 令牌属性。
 * 一个页面通常只有几十种颜色，所以规则数很小。
 *
 * 用 data-lgd 属性而不是 class，是因为站点 JS 经常整体赋值 el.className，
 * 那样会把我们加的 class 冲掉；data-* 属性不会被这样误伤。
 *
 * 图片、视频、canvas、SVG 一律不碰 —— 这是相对滤镜反色最大的优势。 */

var LGDark = (function () {

  var SKIP = {
    SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, HEAD: 1, TITLE: 1, NOSCRIPT: 1,
    TEMPLATE: 1, BR: 1, IMG: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, IFRAME: 1,
    EMBED: 1, OBJECT: 1, PICTURE: 1, SOURCE: 1, TRACK: 1, MAP: 1, AREA: 1
  };

  var MAX_ELEMENTS = 9000;

  var opts = null;
  var mode = 'off';
  var seq = 0;
  var bucket = new Map();      // '类型|原始颜色' -> 令牌（null 表示这个颜色不用改）
  var entries = [];            // [{kind, key, token}] 记着每个令牌是从哪个原色算来的
  var rules = [];
  var roots = [];              // { root, style }
  var seen = new WeakSet();
  var mo = null;
  var queue = [];
  var flushTimer = 0;
  var syncTimer = 0;
  var count = 0;
  var truncated = false;

  /* :hover 这类状态样式是计算样式里看不到的 —— 扫描时鼠标不在元素上，
   * 那条 background 压根不在 computed value 里。所以必须去解析样式表本身。 */
  var STATE_RE = /:(hover|focus|focus-visible|focus-within|active|checked|target)\b/i;
  var MAX_STATE_RULES = 1500;
  var stateRules = [];
  var stateDone = false;
  var stateCount = 0;

  /* ---------------- 样式表管理 ---------------- */

  function baseCss() {
    return [
      ':root{color-scheme:dark !important}',
      'html canvas[data-lgcv]{filter:invert(1) hue-rotate(180deg) !important}',
      'html{background-color:#141418 !important}',
      '::selection{background:rgba(122,150,255,.34) !important}'
    ].join('');
  }

  function invertCss() {
    var k = opts.darkness / 100;
    return [
      'html{',
      'filter:invert(1) hue-rotate(180deg) contrast(', (1 - 0.10 * k).toFixed(3), ') brightness(', (1 + 0.06 * k).toFixed(3), ') !important;',
      'background:#fff !important;color-scheme:light !important}',
      // 反色一次再反回来 = 原样
      'img,video,canvas,picture,svg,iframe,embed,object,',
      '[style*="background-image"],[data-lgnoinv]',
      '{filter:invert(1) hue-rotate(180deg) !important}'
    ].join('');
  }

  function cssText() {
    if (mode === 'invert') return invertCss();
    return baseCss() + rules.join('') + stateRules.join('');
  }

  function makeStyle(root) {
    var el = document.createElement('style');
    el.setAttribute('data-liquid-dark', '');
    el.textContent = cssText();
    var host = (root === document)
      ? (document.head || document.documentElement)
      : root;
    if (!host) return null;
    host.appendChild(el);
    return el;
  }

  function addRoot(root) {
    for (var i = 0; i < roots.length; i++) if (roots[i].root === root) return;
    var st = makeStyle(root);
    if (st) roots.push({ root: root, style: st });
  }

  function syncSoon() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = 0;
      var css = cssText();
      for (var i = 0; i < roots.length; i++) {
        // 样式节点可能被站点 JS 清掉，掉了就补回去
        if (!roots[i].style.isConnected) {
          var st = makeStyle(roots[i].root);
          if (st) roots[i].style = st; else continue;
        }
        if (roots[i].style.textContent !== css) roots[i].style.textContent = css;
      }
    }, 40);
  }

  /* ---------------- 颜色分桶 ---------------- */

  /* 从"原始颜色"算出该写什么声明。
   * 抽成纯函数是为了让调滑块时能只重算样式表文本、完全不碰 DOM —— 
   * 之前的做法是把所有元素的 data-lgd 摘掉重来，那一瞬间页面会闪回原色。 */
  function declFor(kind, key) {
    if (kind === 'bi') {
      return lgGradientIsLight(key) ? 'background-image:none !important' : null;
    }
    var c = lgParseColor(key);
    if (!c) return null;
    var v;
    if (kind === 'bg') {
      if (c.a <= 0.02) return null;
      v = lgDarkenBg(c, opts);
      return v ? 'background-color:' + v + ' !important' : null;
    }
    if (kind === 'fg') {
      if (c.a <= 0.02) return null;
      v = lgLightenFg(c, opts);
      return v ? 'color:' + v + ' !important' : null;
    }
    if (kind === 'bd') {
      if (c.a < 0.05) return null;
      v = lgDarkenBorder(c, opts);
      return v ? 'border-color:' + v + ' !important' : null;
    }
    return null;
  }

  /* 注意：declFor 返回 null 的判定（颜色本来就够暗 / 够亮 / 渐变本来就深）
   * 只跟原色有关，跟设置无关，所以缓存的 null 在改设置后依然成立。 */
  function buildRules() {
    rules = [];
    for (var i = 0; i < entries.length; i++) {
      var d = declFor(entries[i].kind, entries[i].key);
      if (d) rules.push('[data-lgd~="' + entries[i].token + '"]{' + d + '}');
    }
  }

  function token(kind, key) {
    var k = kind + '|' + key;
    if (bucket.has(k)) return bucket.get(k);
    var decl = declFor(kind, key);
    var tok = null;
    if (decl) {
      tok = 'd' + (seq++);
      entries.push({ kind: kind, key: key, token: tok });
      rules.push('[data-lgd~="' + tok + '"]{' + decl + '}');
      syncSoon();
    }
    bucket.set(k, tok);
    return tok;
  }

  /* ---------------- 单个元素 ---------------- */

  function processEl(el) {
    if (!el || el.nodeType !== 1 || seen.has(el)) return;
    var tag = el.tagName;
    if (typeof tag !== 'string') return;
    if (SKIP[tag.toUpperCase()]) return;
    if (el.namespaceURI && el.namespaceURI.indexOf('/svg') !== -1) return;

    seen.add(el);
    if (++count > MAX_ELEMENTS) { truncated = true; return; }

    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return; }
    if (!cs) return;

    var toks = [];
    var t;

    var bgs = cs.backgroundColor;
    if (bgs) { t = token('bg', bgs); if (t) toks.push(t); }

    // 浅色渐变会盖过我们改的背景色，整块抹掉；深色渐变留着
    var bi = cs.backgroundImage;
    if (bi && bi !== 'none' && bi.indexOf('gradient') !== -1) {
      t = token('bi', bi);
      if (t) toks.push(t);
    }

    var fgs = cs.color;
    if (fgs) { t = token('fg', fgs); if (t) toks.push(t); }

    // 边框：只处理有宽度的，且四边同色时才合并成一条规则
    var sides = ['Top', 'Right', 'Bottom', 'Left'];
    var cols = [];
    for (var i = 0; i < 4; i++) {
      if (parseFloat(cs['border' + sides[i] + 'Width']) > 0) {
        cols.push(cs['border' + sides[i] + 'Color']);
      }
    }
    if (cols.length) {
      var uniq = cols.filter(function (v, j, a) { return a.indexOf(v) === j; });
      if (uniq.length === 1) {
        t = token('bd', uniq[0]);
        if (t) toks.push(t);
      }
    }

    if (toks.length) {
      var cur = el.getAttribute('data-lgd');
      el.setAttribute('data-lgd', cur ? cur + ' ' + toks.join(' ') : toks.join(' '));
    }
  }

  function reprocess(el) {
    seen.delete(el);
    if (el.hasAttribute && el.hasAttribute('data-lgd')) el.removeAttribute('data-lgd');
    processEl(el);
  }

  /* ---------------- canvas ---------------- */

  /* canvas 上的像素是画出来的，CSS 改不了颜色 —— 代码编辑器的小地图就是典型：
   * 正文是 DOM 渲染的会被改深，小地图是 canvas，纹丝不动，于是右边杵着一大块白。
   *
   * 办法是采样：把整块缩到 8×8 画进一张临时 canvas，一次 getImageData 读回来，
   * 算平均亮度和标准差。又亮又平（UI 类）才反色；照片色彩起伏大、深色图表本来就暗，都不动。 */
  function sampleCanvas(c) {
    var tmp, tctx, data;
    try {
      tmp = document.createElement('canvas');
      tmp.width = 8; tmp.height = 8;
      tctx = tmp.getContext('2d');
      if (!tctx) return null;
      tctx.drawImage(c, 0, 0, 8, 8);
      data = tctx.getImageData(0, 0, 8, 8).data;
    } catch (e) {
      return null;                     // 被跨源内容污染，或 WebGL 没保留绘图缓冲
    }

    var vals = [];
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 40) continue;  // 透明的地方不算
      vals.push(lgLuminance({ r: data[i], g: data[i + 1], b: data[i + 2] }));
    }
    if (vals.length < 8) return null;

    var mean = 0, k;
    for (k = 0; k < vals.length; k++) mean += vals[k];
    mean /= vals.length;
    var sd = 0;
    for (k = 0; k < vals.length; k++) sd += (vals[k] - mean) * (vals[k] - mean);
    sd = Math.sqrt(sd / vals.length);
    return { mean: mean, sd: sd };
  }

  function scanCanvases() {
    if (!opts || !opts.darkenCanvas || mode !== 'dynamic') return;
    var list;
    try { list = document.querySelectorAll('canvas:not([data-lgcv])'); } catch (e) { return; }
    for (var i = 0; i < list.length && i < 40; i++) {
      var c = list[i], r;
      try { r = c.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width * r.height < 4000) continue;          // 太小的图标不折腾
      var v = sampleCanvas(c);
      if (!v) continue;
      if (v.mean > 0.62 && v.sd < 0.26) c.setAttribute('data-lgcv', '');
    }
  }

  /* ---------------- 状态样式（:hover / :focus …） ---------------- */

  /* 悬停底色按常规映射之后再提亮一点点。
   * 浅色页上悬停是"比表面略暗"，深色页上方向要反过来才看得出来。 */
  function hoverBgDecl(key) {
    var c = lgParseColor(key);
    if (!c || c.a <= 0.02) return null;
    var hsl = lgRgbToHsl(c);
    if (hsl.l < 0.35) return null;                 // 本来就暗，不动
    var nl = 0.30 - (hsl.l - 0.35) * (0.30 - 0.07) / 0.65;
    nl = hsl.l + (nl - hsl.l) * (opts.darkness / 100);
    nl = lgClampLocal(nl + 0.055, 0, 1);           // 提亮，保证悬停可见
    return 'background-color:' + lgCss(lgHslToRgb({
      h: hsl.h, s: hsl.s * 0.78, l: nl, a: hsl.a
    })) + ' !important';
  }

  function lgClampLocal(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function stateDecl(st) {
    var out = [];
    var v;

    v = st.getPropertyValue('background-color');
    if (v) { var d = hoverBgDecl(v); if (d) out.push(d); }

    v = st.getPropertyValue('background-image');
    if (v && v.indexOf('gradient') !== -1 && lgGradientIsLight(v)) {
      out.push('background-image:none !important');
    }

    v = st.getPropertyValue('color');
    if (v) { var d2 = declFor('fg', v); if (d2) out.push(d2); }

    v = st.getPropertyValue('border-color');
    if (v) { var d3 = declFor('bd', v); if (d3) out.push(d3); }

    return out.join(';');
  }

  function walkCssRules(list, media, acc) {
    for (var i = 0; i < list.length && acc.n < MAX_STATE_RULES; i++) {
      var r = list[i];

      /* 注意别用 `if (r.cssRules)` 来判断"这是不是分组规则"。
       * Firefox 支持 CSS 嵌套之后，CSSStyleRule 继承自 CSSGroupingRule，
       * 每条普通样式规则都带一个空的 cssRules —— 空列表是 truthy，
       * 那样写会把所有规则都当成 @media 跳过，一条都收不到。 */
      var isStyle = typeof r.selectorText === 'string';
      var kids = r.cssRules;
      var hasKids = !!(kids && kids.length);

      if (!isStyle) {
        if (r.name !== undefined) continue;              // @keyframes，跳过
        if (hasKids) {
          var cond = (r.media && r.media.mediaText) || media;
          walkCssRules(kids, cond, acc);
        }
        continue;                                        // @font-face / @import 等
      }

      if (hasKids) walkCssRules(kids, media, acc);       // CSS 嵌套：里面还有规则

      var sel = r.selectorText;
      if (!STATE_RE.test(sel)) continue;
      var decl;
      try { decl = stateDecl(r.style); } catch (e) { continue; }
      if (!decl) continue;
      var text = sel + '{' + decl + '}';
      if (media && media !== 'all') text = '@media ' + media + '{' + text + '}';
      acc.out.push(text);
      acc.n++;
    }
  }

  function isOurSheet(sh) {
    var n = sh.ownerNode;
    return !!(n && n.hasAttribute &&
      (n.hasAttribute('data-liquid-dark') || n.hasAttribute('data-liquid-glass')));
  }

  function harvestStates() {
    if (stateDone || mode !== 'dynamic') return;
    stateDone = true;

    var acc = { out: [], n: 0 };
    var pending = [];
    var sheets = document.styleSheets;

    for (var i = 0; i < sheets.length; i++) {
      var sh = sheets[i];
      if (isOurSheet(sh)) continue;
      var list = null;
      try { list = sh.cssRules; } catch (e) { list = null; }   // 跨源，读不到规则
      if (list) walkCssRules(list, '', acc);
      else if (sh.href) pending.push(sh.href);
    }

    commitStates(acc);

    // 跨源样式表读不到 cssRules，但内容脚本有 <all_urls> 权限，可以自己抓下来解析
    var todo = pending.slice(0, 8);
    for (var j = 0; j < todo.length; j++) fetchSheet(todo[j], acc);
  }

  function fetchSheet(href, acc) {
    try {
      fetch(href, { credentials: 'omit' }).then(function (r) {
        return r.ok ? r.text() : null;
      }).then(function (txt) {
        if (!txt || acc.n >= MAX_STATE_RULES) return;
        var sheet;
        try {
          sheet = new CSSStyleSheet();      // 只解析，不挂到文档上，没有副作用
          sheet.replaceSync(txt);
        } catch (e) { return; }
        walkCssRules(sheet.cssRules, '', acc);
        commitStates(acc);
      }).catch(function () {});
    } catch (e) {}
  }

  function commitStates(acc) {
    if (acc.out.length === stateCount) return;
    stateCount = acc.out.length;
    stateRules = acc.out.slice();
    syncSoon();
  }

  /* ---------------- 遍历 ---------------- */

  function walk(root) {
    var els;
    try { els = root.querySelectorAll('*'); } catch (e) { return; }
    for (var i = 0; i < els.length; i++) {
      processEl(els[i]);
      if (els[i].shadowRoot) {
        addRoot(els[i].shadowRoot);
        walk(els[i].shadowRoot);
      }
    }
  }

  function flush() {
    flushTimer = 0;
    var q = queue;
    queue = [];
    for (var i = 0; i < q.length; i++) {
      var n = q[i];
      if (!n || !n.isConnected) continue;
      if (n.nodeType !== 1) continue;
      processEl(n);
      var kids;
      try { kids = n.querySelectorAll('*'); } catch (e) { continue; }
      for (var j = 0; j < kids.length; j++) {
        processEl(kids[j]);
        if (kids[j].shadowRoot) { addRoot(kids[j].shadowRoot); walk(kids[j].shadowRoot); }
      }
    }
  }

  function flushSoon() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 60);
  }

  function observe() {
    if (mo) return;
    mo = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'childList') {
          for (var j = 0; j < m.addedNodes.length; j++) {
            if (m.addedNodes[j].nodeType === 1) queue.push(m.addedNodes[j]);
          }
        } else if (m.type === 'attributes' && m.target.nodeType === 1) {
          // 站点改了 class/style，颜色可能变了，重算这一个
          reprocess(m.target);
        }
      }
      if (queue.length) flushSoon();
    });
    try {
      mo.observe(document.documentElement, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['class', 'style']
      });
    } catch (e) {}
  }

  /* ---------------- 对外接口 ---------------- */

  return {
    start: function (m, o) {
      mode = m;
      opts = o;
      addRoot(document);
      if (mode === 'invert') { syncSoon(); return; }
      if (document.body) walk(document);
      observe();
      harvestStates();
      scanCanvases();
      syncSoon();
    },

    /* 设置变了：只按新参数重算样式表文本。
     * 元素上的 data-lgd 令牌一个都不动 —— 令牌是按"原始颜色"分的桶，
     * 参数变化只影响每个桶算出来的目标色，桶的归属不变。
     * 这样调滑块时页面不会闪回原色。 */
    restyle: function (m, o) {
      mode = m;
      opts = o;
      if (mode !== 'invert') {
        buildRules();
        stateDone = false;
        stateRules = [];
        stateCount = 0;
        harvestStates();
      }
      syncSoon();
    },

    rescan: function () {
      if (mode === 'invert' || !opts) return;
      walk(document);
      harvestStates();
      scanCanvases();
      // canvas 内容是后画上去的，加载完再复采一次
      setTimeout(scanCanvases, 1200);
      setTimeout(scanCanvases, 3500);
      syncSoon();
    },

    stop: function () {
      if (mo) { mo.disconnect(); mo = null; }
      for (var i = 0; i < roots.length; i++) {
        try { roots[i].style.remove(); } catch (e) {}
      }
      roots = [];
      var olds = document.querySelectorAll('[data-lgd]');
      for (var j = 0; j < olds.length; j++) olds[j].removeAttribute('data-lgd');
      var cvs = document.querySelectorAll('[data-lgcv]');
      for (var q = 0; q < cvs.length; q++) cvs[q].removeAttribute('data-lgcv');
      bucket = new Map();
      entries = [];
      rules = [];
      seen = new WeakSet();
      seq = 0;
      count = 0;
      truncated = false;
      stateRules = [];
      stateDone = false;
      stateCount = 0;
      mode = 'off';
      opts = null;
    },

    stats: function () {
      return { elements: count, colors: seq, states: stateRules.length, truncated: truncated, mode: mode };
    }
  };
})();
