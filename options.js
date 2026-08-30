'use strict';

var $ = function (id) { return document.getElementById(id); };

var BOOLS = ['enabled', 'nativeOverride', 'respectNativeDark', 'darkenCanvas', 'roundCorners', 'glass', 'ambience'];
var NUMS = ['darkness', 'contrast', 'radius', 'glassBlur', 'glassOpacity', 'glassMax'];
var UNITS = { darkness: '%', contrast: '%', radius: ' px', glassBlur: ' px', glassOpacity: '%', glassMax: ' 块' };

var settings = null;

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function fill(s) {
  settings = s;
  BOOLS.forEach(function (k) { $(k).checked = !!s[k]; });
  NUMS.forEach(function (k) {
    $(k).value = s[k];
    $('v_' + k).textContent = s[k] + (UNITS[k] || '');
  });
  var r = document.querySelector('input[name=mode][value="' + (s.mode || 'auto') + '"]');
  if (r) r.checked = true;
  $('blocklist').value = (s.blocklist || []).join('\n');
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
  s.blocklist = $('blocklist').value.split('\n')
    .map(function (x) { return x.trim(); }).filter(Boolean);
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

$('save').addEventListener('click', function () {
  settings = read();
  lgSaveSettings(settings).then(flash);
});

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
