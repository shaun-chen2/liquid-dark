// ==UserScript==
// @name         液态玻璃深色
// @name:en      Liquid Glass Dark
// @namespace    https://github.com/shaun-chen2/liquid-dark
// @version      1.9.11
// @description  把所有网站变成深色 + 苹果液态玻璃质感。优先用站点自带深色，没有才动态改色。
// @description:en  Turns every website dark with an Apple-style liquid-glass finish.
// @author       陈帅帅
// @homepageURL  https://github.com/shaun-chen2/liquid-dark
// @supportURL   https://github.com/shaun-chen2/liquid-dark/issues
// @updateURL    https://raw.githubusercontent.com/shaun-chen2/liquid-dark/main/dist/liquid-dark.user.js
// @downloadURL  https://raw.githubusercontent.com/shaun-chen2/liquid-dark/main/dist/liquid-dark.user.js
// @license      MIT
// @match        *://*/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

/* 本文件由 build-userscript.sh 生成，不要手改 —— 改仓库里的源码再重新生成。 */

(function () {
'use strict';

/* ================= 平台垫片：把扩展 API 换成 GM_* ================= */

var LG_PLATFORM = 'userscript';

var __lgStoreListeners = [];
var __lgMsgListeners = [];

function __lgGet(k) { try { return GM_getValue(k); } catch (e) { return undefined; } }

function __lgFire(changes) {
  __lgStoreListeners.forEach(function (fn) { try { fn(changes, 'local'); } catch (e) {} });
}

var browser = {
  storage: {
    local: {
      get: function (key) {
        var o = {}, v = __lgGet(key);
        if (v !== undefined) o[key] = v;
        return Promise.resolve(o);
      },
      set: function (obj) {
        Object.keys(obj).forEach(function (k) {
          var old = __lgGet(k);
          GM_setValue(k, obj[k]);
          var c = {}; c[k] = { oldValue: old, newValue: obj[k] };
          __lgFire(c);                      // 本标签页立即生效
        });
        return Promise.resolve();
      }
    },
    onChanged: { addListener: function (fn) { __lgStoreListeners.push(fn); } }
  },
  runtime: {
    sendMessage: function () { return Promise.resolve(null); },   // 没有背景页，状态上报直接丢掉
    onMessage: { addListener: function (fn) { __lgMsgListeners.push(fn); } }
  }
};

// 其它标签页改了设置，这边同步生效
try {
  GM_addValueChangeListener('settings', function (name, oldV, newV, remote) {
    if (remote) __lgFire({ settings: { oldValue: oldV, newValue: newV } });
  });
} catch (e) {}

/* 油猴里普通 fetch 受页面 CORS 限制，读不到跨源样式表；换成 GM_xmlhttpRequest。
 * 这里声明的 fetch 会遮住全局那个，下面拼进来的引擎代码拿到的就是这个。 */
function fetch(url) {
  return new Promise(function (resolve, reject) {
    GM_xmlhttpRequest({
      method: 'GET', url: url, anonymous: true,
      onload: function (r) {
        resolve({ ok: r.status >= 200 && r.status < 300, text: function () { return Promise.resolve(r.responseText); } });
      },
      onerror: reject, ontimeout: reject
    });
  });
}

/* ================= 防白闪（扩展版里的 preload.css） ================= */
(function () {
  var st = document.createElement('style');
  st.setAttribute('data-liquid-preload', '');
  st.textContent = "/* 防白闪。\n *\n * 关键点：这里用 background-image 画深色，而不是 background-color。\n * 因为内容脚本稍后要读 html/body 的 computed background-color 来判断\n * \"这个站点是不是本来就有深色模式\"，用 background-color 会把探测结果污染掉。\n *\n * html[data-lgnobg] / html[data-lgnofg] 由内容脚本在决定不干预时打上，用来撤掉这里的规则。 */\n\nhtml:not([data-lgnobg]) {\n  background-image: linear-gradient(#141418, #141418) !important;\n  background-attachment: fixed !important;\n}\n\nhtml:not([data-lgnofg]) body {\n  color: #e7e7ec !important;\n}\n\n/* 拦截渲染：引擎第一轮改色完成前先不画正文，避免先闪一下原来的浅色页面。\n * 内容脚本处理完会给 html 打上 data-lgready 放行。\n * 兜底：纯 CSS 动画 1.5 秒后强制显示 —— 就算脚本报错或根本没跑（某些框架），也绝不会一直空白。\n * 动画能覆盖普通声明，所以这里 visibility 不能加 !important。\n * data-lgscan：玻璃引擎首轮扫描时临时撤掉隐藏 —— 否则它读到的全是 visibility:hidden，\n * 一块玻璃都不认，要等放行后的补扫才出现，用户会看到\"过一会儿突然变玻璃\"。\n * 撤掉和恢复在同一段同步代码里，中间不会绘制，不会闪。 */\nhtml:not([data-lgready]):not([data-lgscan]) body {\n  visibility: hidden;\n  animation: lg-reveal 0s linear 1.5s forwards;\n}\n@keyframes lg-reveal { to { visibility: visible; } }\n";
  (document.head || document.documentElement).appendChild(st);
})();


/* ================= common.js ================= */
'use strict';

/* 背景脚本、内容脚本、面板共用的默认配置与站点规则解析。 */

var LG_DEFAULTS = {
  enabled: true,

  // 让浏览器对所有站点报告 prefers-color-scheme: dark。
  // 这是质量最高的一层：站点用自己设计的深色，没有任何 hack。
  nativeOverride: true,

  // 站点本来就是深色时不再二次处理
  respectNativeDark: true,

  // auto   自动：站点没深色才动态改色
  // dynamic 动态改色：读计算样式翻转（图片不受影响）
  // invert  滤镜反色：万能，但颜色失真、背景图里的深色图标会被反白
  // native  只用原生深色，不做任何改色
  mode: 'auto',

  // canvas 没法用 CSS 改色（编辑器小地图、图表都画在上面）。
  // 采样判断它整体是不是又亮又平，是的话才反色，照片和深色图表不动。
  darkenCanvas: true,

  // 引擎处理完之前先不显示正文，避免闪白（最多拦 1.5 秒）
  holdRender: true,

  darkness: 100,        // 改色强度 0-100
  contrast: 100,        // 对比度微调 50-150

  // 圆角和玻璃是两件独立的事：只想要圆角不想要磨砂时，把 glass 关掉即可
  roundCorners: true,   // 给识别出的面板加圆角
  radius: 14,           // 圆角半径 px

  glass: true,          // 液态玻璃（磨砂 + 半透明 + 高光 + 描边）
  glassAll: true,       // 全面玻璃：凡是有底色/边框/投影的块都做圆角 + 玻璃（关掉则只挑卡片、导航这类面板）
  glassBlur: 26,        // 背景模糊半径 px
  glassOpacity: 55,     // 玻璃不透明度 0-100
  glassMax: 30,         // 单页最多几块模糊面板（内层另算）
  glassDepth: 2,        // 玻璃最多嵌套几层（1 = 不嵌套）
  ambience: true,       // 背景氛围层（玻璃需要背后有东西才看得出来）

  siteModes: {},        // host -> 'auto'|'dynamic'|'invert'|'native'|'off'
  blocklist: [],        // 黑名单：完全不干预，每行一个，支持 *.example.com

  // ---- 开发者模式（设置页右下角的小开关打开后才显示这些） ----
  devMode: false,
  allowOnly: false,     // 白名单模式：只在 allowlist 里的站点生效
  allowlist: [],
  hideRules: [],        // 删除元素（选择器写法）：'host##选择器'，域名留空为全站
  hideHtml: [],         // 删除元素（HTML 写法）：粘贴元素的 HTML，页面上找到长得一样的就不显示

  // 元素级名单，每行一个选择器，可写 'host##选择器' 限定站点
  glassBlock: [],       // 这些元素不变玻璃
  glassForce: [],       // 这些元素强制变玻璃
  darkBlock: [],        // 这些元素不改色（保留原色）
  darkForce: []         // 这些元素强制反色（常用于深色线条图标、图片）
};

var LG_MSG = {
  STATE: 'lg:state',
  SETTINGS: 'lg:settings',
  APPLY: 'lg:apply',
  PICK: 'lg:pick',
  REPORT: 'lg:report'
};

function lgGetSettings() {
  return browser.storage.local.get('settings').then(function (res) {
    return Object.assign({}, LG_DEFAULTS, res.settings || {});
  }).catch(function () {
    return Object.assign({}, LG_DEFAULTS);
  });
}

function lgSaveSettings(s) {
  return browser.storage.local.set({ settings: s });
}

/* host 是否命中名单。支持 example.com（含子域）与 *.example.com。 */
function lgHostIn(list, host) {
  if (!host || !Array.isArray(list)) return false;
  host = host.toLowerCase();
  for (var i = 0; i < list.length; i++) {
    var rule = String(list[i] || '').trim().toLowerCase();
    if (!rule) continue;
    if (rule.slice(0, 2) === '*.') rule = rule.slice(2);
    if (host === rule || host.endsWith('.' + rule)) return true;
  }
  return false;
}

function lgBlocked(settings, host) {
  if (!settings) return false;
  if (lgHostIn(settings.blocklist, host)) return true;
  // 白名单模式：名单外的站点一律当作被排除
  if (settings.allowOnly && !lgHostIn(settings.allowlist, host)) return true;
  return false;
}

/* 该站点要隐藏的元素选择器 */
function lgHideSelectorsFor(settings, host) {
  var out = [];
  var rules = (settings && settings.hideRules) || [];
  for (var i = 0; i < rules.length; i++) {
    var r = String(rules[i] || '').trim();
    var k = r.indexOf('##');
    if (k < 0) continue;
    var h = r.slice(0, k).trim(), sel = r.slice(k + 2).trim();
    if (!sel) continue;
    if (!h || lgHostIn([h], host)) out.push(sel);
  }
  return out;
}

/* 该站点最终生效的模式 */
function lgModeFor(settings, host) {
  if (!settings.enabled) return 'off';
  if (lgBlocked(settings, host)) return 'off';
  var m = settings.siteModes && settings.siteModes[host];
  return m || settings.mode || 'auto';
}

/* 把 'host##选择器' / '选择器' 列表编译成当前站点可用的一个选择器串。
 * 每条单独校验，一条写错不会连累整串失效。 */
function lgCompileSelectors(list, host) {
  var ok = [];
  (list || []).forEach(function (line) {
    var r = String(line || '').trim();
    if (!r) return;
    var k = r.indexOf('##'), sel = r;
    if (k >= 0) {
      var h = r.slice(0, k).trim();
      sel = r.slice(k + 2).trim();
      if (h && !lgHostIn([h], host)) return;
    }
    if (!sel) return;
    try { document.querySelector(sel); ok.push(sel); } catch (e) { /* 非法选择器，跳过 */ }
  });
  return ok.join(',');
}

/* 当前页面生效的元素名单，由 content.js 在启动引擎前填好，两个引擎直接读 */
var LG_ELEM = { glassBlock: '', glassForce: '', darkBlock: '', darkForce: '' };

function lgElemIs(el, key) {
  var sel = LG_ELEM[key];
  if (!sel || !el || !el.matches) return false;
  try { return el.matches(sel); } catch (e) { return false; }
}

/* 把一段 HTML 转成"匹配规则"：取第一个元素的标签、id、class、其它属性，
 * 以及（没有子元素时）它的文字。页面上标签相同、这些属性都一样、文字也一样的元素就算命中。
 * 这样站点给元素多加个 class、换个 style 之类不会漏；子元素内容变了也不影响。 */
function lgHtmlPattern(html) {
  // DOMParser 解析出的文档是惰性的：不执行脚本、不加载图片，比 innerHTML 安全
  var doc = new DOMParser().parseFromString(String(html || '').trim(), 'text/html');
  var e = doc.body.firstElementChild || doc.head.firstElementChild;
  if (!e) return null;
  var sel = e.tagName.toLowerCase();
  var esc = (window.CSS && CSS.escape) ? CSS.escape : function (x) { return String(x).replace(/["\\]/g, '\\$&'); };
  // 引号里的属性值：引号、反斜杠要转义，换行在 CSS 字符串里不合法，要写成 \a 这种形式
  var quote = function (x) {
    return String(x).replace(/["\\]/g, '\\$&').replace(/[\n\r\f]/g, function (c) {
      return '\\' + c.charCodeAt(0).toString(16) + ' ';
    });
  };
  for (var i = 0; i < e.attributes.length; i++) {
    var a = e.attributes[i];
    if (a.name === 'style' || a.name.indexOf('data-lg') === 0) continue;
    if (a.name === 'class') {
      a.value.split(/\s+/).forEach(function (c) { if (c && c.indexOf('lg') !== 0) sel += '.' + esc(c); });
    } else if (a.name === 'id') {
      sel += '#' + esc(a.value);
    } else {
      // 属性名也要转义：Alpine / Vue 的 @click、x-on:click 直接拼进选择器是非法的
      sel += '[' + esc(a.name) + '="' + quote(a.value) + '"]';
    }
  }
  try { document.querySelector(sel); } catch (x) { return null; }
  var text = e.children.length === 0 ? (e.textContent || '').trim() : '';
  return { sel: sel, text: text };
}

/* ================= color.js ================= */
'use strict';

/* 颜色解析与深色映射。
 *
 * 思路不是简单反色，而是在 HSL 空间保留色相、压缩明度：
 * 亮背景压到暗区，暗文字提到亮区，饱和度略降免得发荧光。
 * 这样品牌色还认得出来，图片完全不受影响。 */

function lgParseColor(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  // computed style 基本只会返回 rgb()/rgba()，但新语法 rgb(r g b / a) 也兜住
  var m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    var a = 1;
    if (m[4] !== undefined) {
      a = m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }

  var h = s.match(/^#([0-9a-f]{3,8})$/);
  if (h) {
    var x = h[1];
    if (x.length === 3 || x.length === 4) {
      x = x.split('').map(function (c) { return c + c; }).join('');
    }
    if (x.length !== 6 && x.length !== 8) return null;
    return {
      r: parseInt(x.slice(0, 2), 16),
      g: parseInt(x.slice(2, 4), 16),
      b: parseInt(x.slice(4, 6), 16),
      a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1
    };
  }
  return null;
}

function lgRgbToHsl(c) {
  var r = c.r / 255, g = c.g / 255, b = c.b / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var l = (max + min) / 2;
  var h = 0, s = 0;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h, s: s, l: l, a: c.a };
}

function lgHslToRgb(x) {
  var h = x.h, s = x.s, l = x.l;
  if (s === 0) {
    var v = Math.round(l * 255);
    return { r: v, g: v, b: v, a: x.a };
  }
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  var p = 2 * l - q;
  function hue(t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  return {
    r: Math.round(hue(h + 1 / 3) * 255),
    g: Math.round(hue(h) * 255),
    b: Math.round(hue(h - 1 / 3) * 255),
    a: x.a
  };
}

function lgCss(c) {
  if (c.a >= 1) return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + Math.round(c.a * 1000) / 1000 + ')';
}

/* sRGB 相对亮度，用来判断"这是浅色还是深色" */
function lgLuminance(c) {
  function ch(v) {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function lgClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* 对比度微调：以 0.5 为中心做幂次拉伸 */
function lgApplyContrast(l, contrast) {
  var k = contrast / 100;
  if (k === 1) return l;
  return lgClamp(0.5 + (l - 0.5) * k, 0, 1);
}

/* 背景色：L>0.35 的才处理，线性映射到 [0.07, 0.30] */
function lgDarkenBg(c, o) {
  var hsl = lgRgbToHsl(c);
  if (hsl.l < 0.35) return null;            // 本来就够暗，不动

  var nl = 0.30 - (hsl.l - 0.35) * (0.30 - 0.07) / 0.65;
  nl = hsl.l + (nl - hsl.l) * (o.darkness / 100);
  nl = lgApplyContrast(nl, 200 - o.contrast);   // 背景的对比度方向与文字相反

  return lgCss(lgHslToRgb({
    h: hsl.h,
    s: hsl.s * 0.78,
    l: lgClamp(nl, 0, 1),
    a: hsl.a
  }));
}

/* 文字色：L<0.55 的才处理，线性映射到 [0.68, 0.92] */
function lgLightenFg(c, o) {
  var hsl = lgRgbToHsl(c);
  if (hsl.l > 0.55) return null;            // 本来就够亮，不动

  var nl = 0.92 - hsl.l * (0.92 - 0.68) / 0.55;
  nl = hsl.l + (nl - hsl.l) * (o.darkness / 100);
  nl = lgApplyContrast(nl, o.contrast);

  return lgCss(lgHslToRgb({
    h: hsl.h,
    s: hsl.s * 0.9,
    l: lgClamp(nl, 0, 1),
    a: hsl.a
  }));
}

/* 边框：比背景稍亮一点，才看得见分隔 */
function lgDarkenBorder(c, o) {
  var hsl = lgRgbToHsl(c);
  if (hsl.l < 0.30) return null;
  var nl = 0.34 - (hsl.l - 0.30) * (0.34 - 0.16) / 0.70;
  nl = hsl.l + (nl - hsl.l) * (o.darkness / 100);
  return lgCss(lgHslToRgb({ h: hsl.h, s: hsl.s * 0.6, l: lgClamp(nl, 0, 1), a: hsl.a }));
}

/* 渐变是否整体偏亮 —— 用来决定要不要把浅色渐变整个抹掉 */
function lgGradientIsLight(str) {
  var cols = String(str).match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g);
  if (!cols || !cols.length) return false;
  var sum = 0, n = 0;
  for (var i = 0; i < cols.length; i++) {
    var c = lgParseColor(cols[i]);
    if (!c || c.a < 0.15) continue;
    sum += lgLuminance(c);
    n++;
  }
  return n > 0 && (sum / n) > 0.45;
}

/* ================= engine-dark.js ================= */
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
      'html canvas[data-lgcv],html [data-lgforce]{filter:invert(1) hue-rotate(180deg) !important}',
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

  function syncNow() {
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = 0; }
    var css = cssText();
    for (var i = 0; i < roots.length; i++) {
      // 样式节点可能被站点 JS 清掉，掉了就补回去
      if (!roots[i].style.isConnected) {
        var st = makeStyle(roots[i].root);
        if (st) roots[i].style = st; else continue;
      }
      if (roots[i].style.textContent !== css) roots[i].style.textContent = css;
    }
  }

  function syncSoon() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () { syncTimer = 0; syncNow(); }, 40);
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

  /* again = 重算已处理过的元素：不再占额度。
   * 否则站点每改一次 class/style 就多吃一个额度，长时间开着的 SPA 迟早用完，
   * 之后 reprocess 摘掉令牌却加不回来，元素直接闪回原来的浅色。 */
  function processEl(el, again) {
    if (!el || el.nodeType !== 1 || seen.has(el)) return;
    var tag = el.tagName;
    if (typeof tag !== 'string') return;
    if (SKIP[tag.toUpperCase()]) return;
    if (el.namespaceURI && el.namespaceURI.indexOf('/svg') !== -1) return;

    if (!again) {
      if (count >= MAX_ELEMENTS) { truncated = true; return; }
      count++;
    }
    seen.add(el);
    if (lgElemIs(el, 'darkBlock')) return;               // 元素黑名单：保留原色

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
    if (!seen.has(el)) { processEl(el); return; }     // 没处理过（含超额没处理的），走正常流程
    seen.delete(el);
    if (el.hasAttribute && el.hasAttribute('data-lgd')) el.removeAttribute('data-lgd');
    processEl(el, true);
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
        /* @keyframes 要跳过，但不能靠 `r.name` 认 —— @layer 块也有 name，
         * 那样会把 @layer 里的规则整块漏掉（Tailwind v4 全在 @layer 里）。
         * 关键帧规则的子项带 keyText，别的分组规则没有。 */
        if (hasKids && kids[0].keyText !== undefined) continue;
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
      if (mode === 'invert') { syncNow(); return; }
      if (document.body) walk(document);
      observe();
      harvestStates();
      scanCanvases();
      // 同步写入：调用方紧接着就要放行渲染（见 preload.css），样式必须先到位
      syncNow();
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

/* ================= engine-glass.js ================= */
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

/* ================= engine-prefers.js ================= */
'use strict';

/* 站点自带深色规则的搬运工。只在 Chrome 上用。
 *
 * Firefox 有 browserSettings.overrideContentColorScheme，一句话就能让浏览器
 * 对所有站点报告 prefers-color-scheme: dark，站点自己的深色设计直接生效，零瑕疵。
 * Chrome 没有任何等价 API —— chrome.debugger 的 Emulation.setEmulatedMedia 能做到，
 * 但那会在浏览器顶部常驻一条"正在调试"的横幅，日常用不了。
 *
 * 替代办法：把站点写在 @media (prefers-color-scheme: dark) 里的规则挖出来，
 * 去掉那条媒体条件、原样重新发一遍。用的还是站点自己设计的深色，
 * 效果和 Firefox 那一层基本等价。
 *
 * 注入的样式表追加在 <head> 末尾，同选择器同权重时后来居上，能盖过浅色规则。 */

var LGPrefers = (function () {

  var MAX_RULES = 4000;
  var PCS_DARK = /prefers-color-scheme\s*:\s*dark/i;

  var styleEl = null;
  var out = [];
  var n = 0;
  var seenSheets = null;

  /* 去掉 prefers-color-scheme: dark 那一段，保留其余媒体条件。
   * 'screen and (prefers-color-scheme: dark) and (min-width:600px)'
   *   -> 'screen and (min-width:600px)' */
  function stripPcs(cond) {
    var MARK = '\u0001';                              // 占位符，避免误删普通空格
    var s = String(cond || '');
    s = s.replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/ig, MARK);
    // 去掉占位符两侧多余的 and 连接词，再把占位符本身抹掉
    s = s.replace(new RegExp('\\band\\s*' + MARK, 'ig'), '')
         .replace(new RegExp(MARK + '\\s*and\\b', 'ig'), '')
         .split(MARK).join('');
    s = s.replace(/\s+/g, ' ').replace(/^and\s+/i, '').replace(/\s+and$/i, '').trim();
    if (s === 'screen' || s === 'all' || s === 'only screen') s = '';
    return s;
  }

  function joinCond(a, b) {
    if (!a) return b || '';
    if (!b) return a;
    return a + ' and ' + b;
  }

  /* 注意：判断"是不是分组规则"不能用 `if (r.cssRules)` ——
   * 支持 CSS 嵌套之后每条普通样式规则都带一个空的 cssRules，空列表是 truthy。 */
  function walk(list, cond, inDark) {
    for (var i = 0; i < list.length && n < MAX_RULES; i++) {
      var r = list[i];
      var isStyle = typeof r.selectorText === 'string';
      var kids = r.cssRules;
      var hasKids = !!(kids && kids.length);

      if (isStyle) {
        if (inDark) {
          var body = r.style && r.style.cssText;
          if (body) {
            var text = r.selectorText + '{' + body + '}';
            if (cond) text = '@media ' + cond + '{' + text + '}';
            out.push(text);
            n++;
          }
        }
        if (hasKids) walk(kids, cond, inDark);      // CSS 嵌套
        continue;
      }

      if (!hasKids) continue;                        // @font-face / @import
      // @keyframes：子项带 keyText。别用 r.name 认，@layer 块也有 name
      if (kids[0].keyText !== undefined) continue;

      // @media 才保留条件；@supports 之类只往下走，条件丢掉
      var isMedia = !!r.media;
      var c = isMedia ? (r.media.mediaText || '') : '';

      if (isMedia && PCS_DARK.test(c)) {
        walk(kids, joinCond(cond, stripPcs(c)), true);
      } else {
        walk(kids, joinCond(cond, c), inDark);
      }
    }
  }

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-liquid-prefers', '');
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function flush() {
    if (!out.length) return false;
    ensureStyle();
    // color-scheme 让表单控件、滚动条也跟着深色，站点没写的话我们补上
    var css = ':root{color-scheme:dark}' + out.join('');
    if (styleEl.textContent !== css) styleEl.textContent = css;
    // 追加到 head 末尾才能压过站点的浅色规则；站点后续又插了样式表就再挪一次
    var host = document.head || document.documentElement;
    if (host && styleEl.parentNode === host && host.lastChild !== styleEl) host.appendChild(styleEl);
    return true;
  }

  function isOurSheet(sh) {
    var e = sh.ownerNode;
    return !!(e && e.hasAttribute &&
      (e.hasAttribute('data-liquid-prefers') || e.hasAttribute('data-liquid-dark') ||
       e.hasAttribute('data-liquid-glass')));
  }

  return {
    /* 同步扫一遍能读到的样式表并注入。返回是否搬到了东西。
     * 跨源样式表读不到 cssRules，交给 fetchRemote 异步补。 */
    apply: function () {
      if (!seenSheets) seenSheets = new Set();
      var sheets = document.styleSheets;
      var pending = [];

      for (var i = 0; i < sheets.length; i++) {
        var sh = sheets[i];
        if (isOurSheet(sh)) continue;
        if (sh.ownerNode && seenSheets.has(sh.ownerNode)) continue;
        if (sh.ownerNode) seenSheets.add(sh.ownerNode);

        var list = null;
        try { list = sh.cssRules; } catch (e) { list = null; }
        if (list) walk(list, '', false);
        else if (sh.href) pending.push(sh.href);
      }

      var got = flush();
      for (var j = 0; j < pending.length && j < 8; j++) fetchRemote(pending[j]);
      return got;
    },

    stats: function () { return { rules: n }; },

    stop: function () {
      if (styleEl) { try { styleEl.remove(); } catch (e) {} styleEl = null; }
      out = [];
      n = 0;
      seenSheets = null;
    }
  };

  /* 跨源样式表读不到 cssRules，用内容脚本的 <all_urls> 权限抓下来自己解析。
   * 只解析、不挂到文档上，没有副作用。 */
  function fetchRemote(href) {
    try {
      fetch(href, { credentials: 'omit' }).then(function (r) {
        return r.ok ? r.text() : null;
      }).then(function (txt) {
        if (!txt || n >= MAX_RULES) return;
        var sheet;
        try {
          sheet = new CSSStyleSheet();
          sheet.replaceSync(txt);
        } catch (e) { return; }
        walk(sheet.cssRules, '', false);
        flush();
      }).catch(function () {});
    } catch (e) {}
  }
})();

/* ================= content.js ================= */
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
  var decideKey = '';        // 决定走哪条路的那几项设置，变了就整个重新判定

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
      var h = document.documentElement;
      h.setAttribute('data-lgscan', '');     // 首轮扫描要看到真实的可见性，见 preload.css
      try { LGGlass.start(go); } finally { h.removeAttribute('data-lgscan'); }
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

  function modeKey() {
    return [lgModeFor(settings, HOST), !!settings.respectNativeDark, !!settings.nativeOverride].join('|');
  }

  function decideAndStart() {
    var m = lgModeFor(settings, HOST);
    decideKey = modeKey();

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
      if (LG_PLATFORM !== 'firefox' && settings.nativeOverride) {
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
    settings = next;

    /* 模式相关的设置变了：全部撤掉，再走一遍和页面加载时一样的判定。
     *  - 站点深色规则（LGPrefers）也要撤，否则关掉之后页面还是深的，切到动态改色还会两套打架
     *  - auto 要重新探测：页面一开始是"关闭"的话根本没探测过，nativeDark 是个没意义的初值 */
    if (modeKey() !== decideKey) {
      LGDark.stop();
      if (glassOn) { LGGlass.stop(); glassOn = false; }
      if (prefersOn) { LGPrefers.stop(); prefersOn = false; }
      started = false;
      decideAndStart();
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

/* ================= 油猴菜单（代替工具栏面板和设置页） ================= */
(function () {
  if (window.top !== window) return;            // 只在顶层页面注册，别让每个 iframe 都塞一份菜单
  if (typeof GM_registerMenuCommand !== 'function') return;

  var MODES = ['auto', 'native', 'dynamic', 'invert', 'off'];
  var MODE_NAME = { auto: '自动', native: '原生', dynamic: '动态改色', invert: '反色', off: '关闭' };
  var TOGGLES = [
    ['enabled', '总开关'], ['roundCorners', '圆角'], ['glass', '液态玻璃'],
    ['glassAll', '全面玻璃'], ['ambience', '氛围背景'], ['holdRender', '防闪白']
  ];
  var ids = [];

  function save(fn) {
    lgGetSettings().then(function (s) { fn(s); return lgSaveSettings(s); }).then(render);
  }

  function render() {
    lgGetSettings().then(function (s) {
      if (typeof GM_unregisterMenuCommand === 'function') ids.forEach(function (i) { try { GM_unregisterMenuCommand(i); } catch (e) {} });
      ids = [];
      var host = location.hostname;
      var cur = (s.siteModes && s.siteModes[host]) || 'auto';
      ids.push(GM_registerMenuCommand('本站模式：' + MODE_NAME[cur] + '（点击切换）', function () {
        save(function (x) {
          x.siteModes = x.siteModes || {};
          var next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
          if (next === 'auto') delete x.siteModes[host]; else x.siteModes[host] = next;
        });
      }));
      TOGGLES.forEach(function (t) {
        ids.push(GM_registerMenuCommand((s[t[0]] ? '✅ ' : '⬜ ') + t[1], function () {
          save(function (x) { x[t[0]] = !x[t[0]]; });
        }));
      });
      ids.push(GM_registerMenuCommand((s.devMode ? '✅ ' : '⬜ ') + '开发者模式', function () {
        save(function (x) { x.devMode = !x.devMode; });
      }));
      if (!s.devMode) return;             // 以下是开发者功能，和扩展版一样，开了开发者模式才出现

      ids.push(GM_registerMenuCommand('🎯 点选删除元素', function () {
        __lgMsgListeners.forEach(function (fn) { try { fn({ type: LG_MSG.PICK }); } catch (e) {} });
      }));
      ids.push(GM_registerMenuCommand('⚙ 编辑全部设置（JSON）', function () {
        var txt = prompt('全部设置（JSON）。站点黑白名单 blocklist/allowlist/allowOnly、元素名单 glassBlock/glassForce/darkBlock/darkForce、删除元素 hideHtml/hideRules 都在这里改：',
          JSON.stringify(s));
        if (txt == null) return;
        try {
          var obj = JSON.parse(txt);
          save(function (x) { Object.keys(obj).forEach(function (k) { x[k] = obj[k]; }); });
        } catch (e) { alert('JSON 格式不对：' + e.message); }
      }));
      ids.push(GM_registerMenuCommand('↺ 恢复默认设置', function () {
        if (confirm('所有设置恢复默认？')) lgSaveSettings(Object.assign({}, LG_DEFAULTS)).then(render);
      }));
    });
  }
  render();
})();

})();
