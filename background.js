'use strict';

/* 背景脚本
 *  - 管 browserSettings.overrideContentColorScheme：让浏览器对所有站点报告
 *    prefers-color-scheme: dark。这是质量最高的一层，站点用自己设计的深色。
 *  - 收内容脚本的状态上报，供面板显示
 *  - 站点被排除时在图标上打个角标 */

var settings = Object.assign({}, LG_DEFAULTS);
var reports = new Map();   // tabId -> 内容脚本上报的状态

function nativePref() {
  return (browser.browserSettings && browser.browserSettings.overrideContentColorScheme) || null;
}

function applyNative() {
  var p = nativePref();
  if (!p) return Promise.resolve(false);
  var on = settings.enabled && settings.nativeOverride;
  var op = on ? p.set({ value: 'dark' }) : p.clear({});
  return op.then(function () { return on; }).catch(function () { return false; });
}

lgGetSettings().then(function (s) {
  settings = s;
  applyNative();
});

browser.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local' || !changes.settings) return;
  settings = Object.assign({}, LG_DEFAULTS, changes.settings.newValue || {});
  applyNative();
});

browser.runtime.onInstalled.addListener(function () {
  lgGetSettings().then(function (s) { settings = s; applyNative(); });
});

/* ---------------- 角标 ---------------- */

function badge(tabId, mode) {
  try {
    if (mode === 'off') {
      browser.browserAction.setBadgeText({ tabId: tabId, text: '✕' });
      browser.browserAction.setBadgeBackgroundColor({ tabId: tabId, color: '#6b6b76' });
    } else {
      browser.browserAction.setBadgeText({ tabId: tabId, text: '' });
    }
  } catch (e) { /* 标签页可能已关闭 */ }
}

/* ---------------- 消息 ---------------- */

browser.runtime.onMessage.addListener(function (msg, sender) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === LG_MSG.REPORT) {
    if (sender.tab) {
      reports.set(sender.tab.id, {
        host: msg.host, mode: msg.mode, nativeDark: msg.nativeDark,
        dark: msg.dark, glass: msg.glass, at: Date.now()
      });
      badge(sender.tab.id, msg.mode);
    }
    return;
  }

  if (msg.type === LG_MSG.SETTINGS) {
    return applyNative().then(function (nativeOn) {
      return {
        settings: settings,
        nativeAvailable: !!nativePref(),
        nativeOn: nativeOn,
        report: reports.get(msg.tabId) || null
      };
    });
  }
});

browser.tabs.onRemoved.addListener(function (id) { reports.delete(id); });
