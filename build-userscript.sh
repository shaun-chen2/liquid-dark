#!/bin/bash
# 生成油猴 / 暴力猴 / Violentmonkey 版：把所有源码拼成一个 .user.js，再垫一层 GM_* API。
# 引擎与 Firefox / Chrome 版共用同一份源码，修 bug 只改一处，跑一遍本脚本即可同步。
set -e
cd "$(dirname "$0")"
OUT="dist/liquid-dark.user.js"
mkdir -p dist
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
RAW="https://raw.githubusercontent.com/shaun-chen2/liquid-dark/main/$OUT"

{
cat <<META
// ==UserScript==
// @name         液态玻璃深色
// @name:en      Liquid Glass Dark
// @namespace    https://github.com/shaun-chen2/liquid-dark
// @version      $VERSION
// @description  把所有网站变成深色 + 苹果液态玻璃质感。优先用站点自带深色，没有才动态改色。
// @description:en  Turns every website dark with an Apple-style liquid-glass finish.
// @author       陈帅帅
// @homepageURL  https://github.com/shaun-chen2/liquid-dark
// @supportURL   https://github.com/shaun-chen2/liquid-dark/issues
// @updateURL    $RAW
// @downloadURL  $RAW
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
  st.textContent = $(node -e "process.stdout.write(JSON.stringify(require('fs').readFileSync('preload.css','utf8')))");
  (document.head || document.documentElement).appendChild(st);
})();

META

for f in common.js color.js engine-dark.js engine-glass.js engine-prefers.js content.js; do
  echo
  echo "/* ================= $f ================= */"
  cat "$f"
done

cat <<'MENU'

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
      ids.push(GM_registerMenuCommand('🎯 点选删除元素', function () {
        __lgMsgListeners.forEach(function (fn) { try { fn({ type: LG_MSG.PICK }); } catch (e) {} });
      }));
      ids.push(GM_registerMenuCommand('⚙ 编辑全部设置（JSON）', function () {
        var txt = prompt('全部设置（JSON）。黑白名单、元素名单、删除元素的 HTML 都在这里改：',
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
MENU
} > "$OUT"

node --check "$OUT"
echo "已生成 $(pwd)/$OUT  (v$VERSION, $(du -h "$OUT" | cut -f1))"
