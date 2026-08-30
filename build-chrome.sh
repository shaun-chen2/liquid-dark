#!/bin/bash
# 从 Firefox 版生成 Chrome 版（MV3）。
#
# 引擎、面板、设置页全部共用同一份源码，只有三样东西是平台特有的：
#   platform.js   —— 平台常量 + browser/chrome 垫片
#   manifest.json —— MV2 vs MV3
#   background.js —— 事件页 vs Service Worker，且 Chrome 没有 browserSettings
#
# 所以修引擎的 bug 只需要改 Firefox 版这一处，跑一遍本脚本即可同步。
set -e
cd "$(dirname "$0")"
SRC="$(pwd)"
DST="$SRC-chrome"

SHARED="common.js color.js engine-dark.js engine-glass.js engine-prefers.js content.js
        preload.css popup.html popup.css popup.js options.html options.js"

for f in $SHARED; do
  [ -f "$f" ] || { echo "缺少源文件：$f"; exit 1; }
done

rm -rf "$DST"
mkdir -p "$DST/icons"
for f in $SHARED; do cp "$f" "$DST/$f"; done
# 只带打包用的尺寸，不要 icon-source.png 那张原图
for n in 16 32 48 96 128; do cp "icons/icon-$n.png" "$DST/icons/"; done

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")

# ---------------- 平台垫片 ----------------
cat > "$DST/platform.js" <<'EOF'
'use strict';

/* 平台常量 + API 垫片。由 build-chrome.sh 生成，不要手改 —— 改 Firefox 版的源码再重新生成。
 *
 * Chrome 没有 browserSettings.overrideContentColorScheme（Firefox 独有），
 * 所以"让浏览器对所有站点报告 prefers-color-scheme: dark"这一层做不到。
 * 替代方案见 engine-prefers.js：把站点自己 @media (prefers-color-scheme: dark)
 * 里的规则搬出来重新发一遍。 */

var LG_PLATFORM = 'chrome';

var browser = (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime)
  ? globalThis.browser
  : chrome;
EOF

# ---------------- Service Worker 入口 ----------------
cat > "$DST/sw.js" <<'EOF'
'use strict';
/* MV3 的后台是 Service Worker，只能指定单个文件，用 importScripts 把其余部分带进来。
   注意不能声明 "type": "module"，否则 importScripts 不可用。 */
importScripts('platform.js', 'common.js', 'background.js');
EOF

# ---------------- 背景脚本（Chrome 版） ----------------
cat > "$DST/background.js" <<'EOF'
'use strict';

/* Chrome 版背景脚本（Service Worker 里跑）。
 *
 * 相比 Firefox 版少了 browserSettings 那一整块 —— Chrome 没有这个 API。
 * 另外 MV3 的 Service Worker 会被随时回收，reports 这份内存缓存会丢，
 * 所以面板取状态时如果缓存是空的，直接回头去问内容脚本。 */

var settings = Object.assign({}, LG_DEFAULTS);
var reports = new Map();   // tabId -> 内容脚本上报的状态

lgGetSettings().then(function (s) { settings = s; });

browser.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.settings) return;
  settings = Object.assign({}, LG_DEFAULTS, changes.settings.newValue || {});
});

/* ---------------- 角标 ---------------- */

function badge(tabId, mode) {
  try {
    if (mode === 'off') {
      browser.action.setBadgeText({ tabId: tabId, text: '✕' });
      browser.action.setBadgeBackgroundColor({ tabId: tabId, color: '#6b6b76' });
    } else {
      browser.action.setBadgeText({ tabId: tabId, text: '' });
    }
  } catch (e) { /* 标签页可能已关闭 */ }
}

/* ---------------- 消息 ---------------- */

/* Chrome 的 onMessage 不认返回 Promise，必须 sendResponse + return true。 */
browser.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === LG_MSG.REPORT) {
    if (sender.tab) {
      reports.set(sender.tab.id, {
        host: msg.host, mode: msg.mode, nativeDark: msg.nativeDark,
        dark: msg.dark, glass: msg.glass, prefers: msg.prefers, at: Date.now()
      });
      badge(sender.tab.id, msg.mode);
    }
    return;
  }

  if (msg.type === LG_MSG.SETTINGS) {
    var reply = function (rep) {
      sendResponse({
        settings: settings,
        nativeAvailable: false,   // Chrome 没有 browserSettings
        nativeOn: false,
        report: rep || null
      });
    };
    var cached = reports.get(msg.tabId);
    if (cached) { reply(cached); return true; }

    // Service Worker 被回收过，缓存没了，直接问内容脚本
    try {
      browser.tabs.sendMessage(msg.tabId, { type: LG_MSG.STATE })
        .then(function (r) { reply(r); })
        .catch(function () { reply(null); });
    } catch (e) { reply(null); }
    return true;
  }
});

browser.tabs.onRemoved.addListener(function (id) { reports.delete(id); });
EOF

# ---------------- MV3 manifest ----------------
node -e '
const fs = require("fs");
const v = process.argv[1];
const icons = { 16:"icons/icon-16.png", 32:"icons/icon-32.png", 48:"icons/icon-48.png",
                96:"icons/icon-96.png", 128:"icons/icon-128.png" };
fs.writeFileSync(process.argv[2] + "/manifest.json", JSON.stringify({
  manifest_version: 3,
  name: "液态玻璃深色",
  version: v,
  description: "把所有网站变成深色 + 苹果液态玻璃质感。优先用站点自带深色，没有才动态改色，顽固站点可切滤镜反色。",
  permissions: ["storage"],
  host_permissions: ["<all_urls>"],
  background: { service_worker: "sw.js" },
  content_scripts: [{
    matches: ["http://*/*", "https://*/*"],
    all_frames: true,
    match_about_blank: true,
    run_at: "document_start",
    css: ["preload.css"],
    js: ["platform.js", "common.js", "color.js", "engine-dark.js",
         "engine-glass.js", "engine-prefers.js", "content.js"]
  }],
  action: { default_popup: "popup.html", default_title: "液态玻璃深色", default_icon: icons },
  options_ui: { page: "options.html", open_in_tab: true },
  icons: icons
}, null, 2) + "\n");
' "$VERSION" "$DST"

# 语法自检
for f in "$DST"/*.js; do node --check "$f" >/dev/null || { echo "语法错误：$f"; exit 1; }; done
node -e "JSON.parse(require('fs').readFileSync('$DST/manifest.json','utf8'))"

# 打包（Chrome 应用商店要 zip）
cd "$DST"
rm -f ../liquid-dark-chrome.zip
zip -r -FS ../liquid-dark-chrome.zip . -x '*.DS_Store' > /dev/null

echo "已生成 $DST  (v$VERSION)"
echo "已打包 $(cd .. && pwd)/liquid-dark-chrome.zip"
