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
  hideRules: []         // 删除元素：'host##选择器' 只对该站生效，'##选择器' 全站生效
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
