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
