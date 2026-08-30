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

  darkness: 100,        // 改色强度 0-100
  contrast: 100,        // 对比度微调 50-150

  // 圆角和玻璃是两件独立的事：只想要圆角不想要磨砂时，把 glass 关掉即可
  roundCorners: true,   // 给识别出的面板加圆角
  radius: 14,           // 圆角半径 px

  glass: true,          // 液态玻璃（磨砂 + 半透明 + 高光 + 描边）
  glassBlur: 26,        // 背景模糊半径 px
  glassOpacity: 55,     // 玻璃不透明度 0-100
  glassMax: 30,         // 单页最多几块面板
  ambience: true,       // 背景氛围层（玻璃需要背后有东西才看得出来）

  siteModes: {},        // host -> 'auto'|'dynamic'|'invert'|'native'|'off'
  blocklist: []         // 完全不干预，每行一个，支持 *.example.com
};

var LG_MSG = {
  STATE: 'lg:state',
  SETTINGS: 'lg:settings',
  APPLY: 'lg:apply',
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

/* host 是否命中黑名单。支持 example.com（含子域）与 *.example.com。 */
function lgBlocked(settings, host) {
  if (!host || !settings || !Array.isArray(settings.blocklist)) return false;
  host = host.toLowerCase();
  for (var i = 0; i < settings.blocklist.length; i++) {
    var rule = String(settings.blocklist[i] || '').trim().toLowerCase();
    if (!rule) continue;
    if (rule.slice(0, 2) === '*.') {
      var base = rule.slice(2);
      if (host === base || host.endsWith('.' + base)) return true;
    } else if (host === rule || host.endsWith('.' + rule)) {
      return true;
    }
  }
  return false;
}

/* 该站点最终生效的模式 */
function lgModeFor(settings, host) {
  if (!settings.enabled) return 'off';
  if (lgBlocked(settings, host)) return 'off';
  var m = settings.siteModes && settings.siteModes[host];
  return m || settings.mode || 'auto';
}
