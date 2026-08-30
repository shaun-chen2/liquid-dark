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

      if (r.name !== undefined) continue;            // @keyframes
      if (!hasKids) continue;                        // @font-face / @import

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
