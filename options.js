'use strict';

var $ = function (id) { return document.getElementById(id); };

var BOOLS = ['enabled', 'nativeOverride', 'respectNativeDark', 'holdRender', 'allowOnly', 'darkenCanvas', 'roundCorners', 'glass', 'glassAll', 'ambience'];
var NUMS = ['darkness', 'contrast', 'radius', 'glassBlur', 'glassOpacity', 'glassMax'];
var UNITS = { darkness: '%', contrast: '%', radius: ' px', glassBlur: ' px', glassOpacity: '%', glassMax: ' 块' };

var settings = null;
var loaded = null;   // 页面打开（或上次保存）时的设置快照，保存时用来和存储里的最新值做三方合并

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function fill(s) {
  settings = s;
  loaded = clone(s);
  BOOLS.forEach(function (k) { $(k).checked = !!s[k]; });
  NUMS.forEach(function (k) {
    $(k).value = s[k];
    $('v_' + k).textContent = s[k] + (UNITS[k] || '');
  });
  var r = document.querySelector('input[name=mode][value="' + (s.mode || 'auto') + '"]');
  if (r) r.checked = true;
  $('blocklist').value = (s.blocklist || []).join('\n');
  $('allowlist').value = (s.allowlist || []).join('\n');
  $('hideRules').value = (s.hideRules || []).join('\n');
  ['glassBlock', 'glassForce', 'darkBlock', 'darkForce'].forEach(function (k) {
    $(k).value = (s[k] || []).join('\n');
  });
  $('hideHtml').value = (s.hideHtml || []).join('\n\n');
  $('devMode').checked = !!s.devMode;
  $('devArea').style.display = s.devMode ? '' : 'none';
  renderSites(s);
}

function read() {
  var s = Object.assign({}, LG_DEFAULTS, settings || {});
  BOOLS.forEach(function (k) { s[k] = $(k).checked; });
  NUMS.forEach(function (k) {
    var v = parseInt($(k).value, 10);
    s[k] = isNaN(v) ? LG_DEFAULTS[k] : v;
  });
  var r = document.querySelector('input[name=mode]:checked');
  s.mode = r ? r.value : 'auto';
  var lines = function (id) {
    return $(id).value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
  };
  s.blocklist = lines('blocklist');
  s.allowlist = lines('allowlist');
  s.hideRules = lines('hideRules');
  ['glassBlock', 'glassForce', 'darkBlock', 'darkForce'].forEach(function (k) { s[k] = lines(k); });
  // HTML 以空行分隔，一段可以跨多行
  s.hideHtml = $('hideHtml').value.split(/\n\s*\n/).map(function (x) { return x.trim(); }).filter(Boolean);
  s.devMode = $('devMode').checked;
  return s;
}

function renderSites(s) {
  var tb = $('siteTable').querySelector('tbody');
  clear(tb);
  var hosts = Object.keys(s.siteModes || {});
  $('noSites').style.display = hosts.length ? 'none' : '';
  hosts.sort().forEach(function (h) {
    var tr = document.createElement('tr');
    var td1 = document.createElement('td'); td1.textContent = h;
    var td2 = document.createElement('td');
    var label = document.createElement('span');
    label.textContent = ({ native: '原生', dynamic: '动态', invert: '反色', off: '关闭' })[s.siteModes[h]] || s.siteModes[h];
    var btn = document.createElement('button');
    btn.textContent = '移除';
    btn.style.cssText = 'margin-left:10px;padding:2px 10px;font-size:11.5px';
    btn.addEventListener('click', function () {
      delete settings.siteModes[h];
      renderSites(settings);
    });
    td2.appendChild(label); td2.appendChild(btn);
    tr.appendChild(td1); tr.appendChild(td2);
    tb.appendChild(tr);
  });
}

/* 保存前先读存储里的最新值再合并。
 * 设置页常常开着很久，这期间在面板里改的站点模式、点选删除新加的元素都已经存进去了，
 * 直接拿本页的旧副本整个写回去会把它们冲掉。
 * 规则：本页没动过的项以存储为准；站点模式按站点逐个合并；删除元素的 HTML 把别处新加的补上。 */
function mergeLatest(mine) {
  return lgGetSettings().then(function (latest) {
    var out = Object.assign({}, latest);
    Object.keys(mine).forEach(function (k) {
      if (k === 'siteModes' || k === 'hideHtml') return;
      if (!same(mine[k], loaded[k])) out[k] = mine[k];
    });

    var sm = Object.assign({}, latest.siteModes || {});
    var was = loaded.siteModes || {}, now = mine.siteModes || {};
    Object.keys(was).forEach(function (h) { if (!(h in now)) delete sm[h]; });   // 本页点了"移除"的
    out.siteModes = sm;

    var base = loaded.hideHtml || [];
    var html = (mine.hideHtml || []).slice();
    (latest.hideHtml || []).forEach(function (x) {
      if (base.indexOf(x) < 0 && html.indexOf(x) < 0) html.push(x);            // 本页打开后别处新加的
    });
    out.hideHtml = html;
    return out;
  });
}

function saveMerged() {
  return mergeLatest(read()).then(function (s) {
    return lgSaveSettings(s).then(function () { fill(s); flash(); });
  });
}

function flash() {
  var el = $('saved');
  el.classList.add('on');
  setTimeout(function () { el.classList.remove('on'); }, 1400);
}

NUMS.forEach(function (k) {
  $(k).addEventListener('input', function () {
    $('v_' + k).textContent = this.value + (UNITS[k] || '');
  });
});

$('save').addEventListener('click', function () { saveMerged(); });

$('reset').addEventListener('click', function () {
  var d = Object.assign({}, LG_DEFAULTS);
  d.siteModes = {};
  d.blocklist = [];
  fill(d);
  lgSaveSettings(d).then(flash);
});

lgGetSettings().then(function (s) {
  fill(s);
  return browser.runtime.sendMessage({ type: LG_MSG.SETTINGS, tabId: -1 });
}).then(function (res) {
  if (!res) return;
  var el = $('nativeState');
  if (!res.nativeAvailable) {
    el.className = 'warn';
    el.textContent = ' 当前 Firefox 不支持这个 API，这一层不可用。';
  } else {
    el.textContent = res.nativeOn ? ' 当前：已生效。' : ' 当前：未生效。';
  }
}).catch(function () {});

/* 右下角的开发者开关：切换立即生效并保存，不用再点"保存" */
$('devMode').addEventListener('change', function () {
  $('devArea').style.display = this.checked ? '' : 'none';
  saveMerged();
});
