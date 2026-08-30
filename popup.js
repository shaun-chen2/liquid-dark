'use strict';

var $ = function (id) { return document.getElementById(id); };

var SLIDERS = ['darkness', 'contrast', 'radius', 'glassBlur', 'glassOpacity'];
var TOGGLES = ['roundCorners', 'glass', 'ambience'];
var UNITS = { darkness: '%', contrast: '%', radius: ' px', glassBlur: ' px', glassOpacity: '%' };

var tab = null;
var settings = null;
var host = null;

var MODE_TEXT = {
  native: ['原生深色', '站点自己就有深色模式，直接用它的，零瑕疵。'],
  dynamic: ['动态改色', '站点没有深色模式，正在按计算样式翻转颜色。图片不受影响。'],
  invert: ['滤镜反色', '整页反色。万能，代价是颜色失真、背景图里的深色图标会被反白。'],
  off: ['已关闭', '这个站点不做任何处理。']
};

var MODE_HINT = {
  '': '按全局设置走。',
  native: '只用站点自带的深色，不做任何改色。站点没深色就还是浅色。',
  dynamic: '强制动态改色，即使站点自带深色也重新算一遍。',
  invert: '兜底方案。前两种都搞不定时用。品牌色会偏，CSS 背景图里的深色图标会被反成浅色。',
  off: '这个站点完全不干预。'
};

function save() {
  return browser.storage.local.set({ settings: settings });
}

function currentSiteMode() {
  return (settings.siteModes && settings.siteModes[host]) || '';
}

function render(report) {
  $('host').textContent = host || '（非网页标签）';
  $('enabled').checked = !!settings.enabled;

  // 状态卡
  var mode = report ? report.mode : (settings.enabled ? '…' : 'off');
  var t = MODE_TEXT[mode];
  if (!settings.enabled) t = ['扩展已关闭', '打开右上角开关启用。'];
  else if (!t) t = ['正在处理…', '刷新页面后可以看到状态。'];
  $('stateMain').textContent = t[0];
  $('stateSub').textContent = t[1];

  // 分段控件
  var cur = currentSiteMode();
  var btns = $('seg').querySelectorAll('button');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('on', btns[i].dataset.m === cur);
  }
  $('modeHint').textContent = MODE_HINT[cur] || '';

  // 滑块
  SLIDERS.forEach(function (k) {
    $(k).value = settings[k];
    $('v_' + k).textContent = settings[k] + (UNITS[k] || '');
  });

  TOGGLES.forEach(function (k) { $(k).checked = !!settings[k]; });
  $('roundOpts').classList.toggle('dim', !settings.roundCorners);
  $('glassOpts').classList.toggle('dim', !settings.glass);

  // 统计
  if (report && report.dark) {
    var d = report.dark, g = report.glass || {};
    var parts = [];
    if (d.elements) parts.push(d.elements + ' 个元素');
    if (d.colors) parts.push(d.colors + ' 种颜色');
    if (g.surfaces) parts.push(g.surfaces + ' 块玻璃');
    if (d.truncated) parts.push('已达上限');
    $('stats').textContent = parts.length ? parts.join(' · ') : '本页无需改色';
  } else {
    $('stats').textContent = '—';
  }
}

function refresh() {
  browser.runtime.sendMessage({ type: LG_MSG.SETTINGS, tabId: tab.id })
    .then(function (res) {
      if (!res) return;
      settings = res.settings;
      render(res.report);
    }).catch(function () {});
}

browser.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
  tab = tabs[0];
  try {
    if (/^https?:/.test(tab.url || '')) host = new URL(tab.url).hostname;
  } catch (e) {}
  return lgGetSettings();
}).then(function (s) {
  settings = s;
  render(null);
  refresh();
});

/* ---------------- 交互 ---------------- */

$('enabled').addEventListener('change', function () {
  settings.enabled = this.checked;
  save().then(refresh);
});

$('seg').addEventListener('click', function (e) {
  var b = e.target.closest('button');
  if (!b || !host) return;
  var m = b.dataset.m;
  settings.siteModes = settings.siteModes || {};
  if (m === '') delete settings.siteModes[host];
  else settings.siteModes[host] = m;
  save().then(function () { setTimeout(refresh, 120); });
});

/* 拖滑块时别每一帧都写一次 storage —— 每次写都会广播到所有标签页触发重算 */
var saveTimer = 0;
function saveSoon() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function () { saveTimer = 0; save(); }, 140);
}

SLIDERS.forEach(function (k) {
  $(k).addEventListener('input', function () {
    settings[k] = parseInt(this.value, 10);
    $('v_' + k).textContent = settings[k] + (UNITS[k] || '');
    saveSoon();
  });
});

TOGGLES.forEach(function (k) {
  $(k).addEventListener('change', function () {
    settings[k] = this.checked;
    $('roundOpts').classList.toggle('dim', !settings.roundCorners);
    $('glassOpts').classList.toggle('dim', !settings.glass);
    save().then(function () { setTimeout(refresh, 150); });
  });
});

$('openOptions').addEventListener('click', function (e) {
  e.preventDefault();
  browser.runtime.openOptionsPage();
  window.close();
});
