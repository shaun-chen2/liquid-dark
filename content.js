'use strict';

/* 编排：决定这个页面走哪条路，然后驱动两个引擎。
 *
 * 三层，从好到糙：
 *   1. 原生      浏览器对所有站点报告 prefers-color-scheme: dark（背景脚本干的），
 *                站点用自己设计的深色，零瑕疵
 *   2. 动态改色  站点没深色时，读计算样式把颜色翻过去
 *   3. 滤镜反色  前两条都不行时的兜底，万能但色相会偏、背景图图标会被反白
 *
 * auto 模式会探测第 1 层生效了没有，没有才上第 2 层。 */

(function () {
  if (!/^https?:$/.test(location.protocol)) return;

  var IS_TOP = (function () {
    try { return window.top === window; } catch (e) { return false; }
  })();

  var HOST = location.hostname;
  var settings = null;
  var effMode = 'off';       // 实际生效的模式
  var nativeDark = false;
  var started = false;
  var glassOn = false;
  var prefersOn = false;

  function send(msg) {
    try {
      var p = browser.runtime.sendMessage(msg);
      return p && p.catch ? p.catch(function () { return null; }) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  }

  /* preload.css 只是防白闪的引导层，一旦决定好就撤掉，交给运行时样式 */
  function retirePreload() {
    var h = document.documentElement;
    h.setAttribute('data-lgnobg', '');
    h.setAttribute('data-lgnofg', '');
  }

  /* 站点自己是不是已经深色了。
   * preload.css 故意用 background-image 而不是 background-color 画深色，
   * 就是为了让这里读到的是站点的真实值。 */
  function probeNativeDark() {
    var c = null;
    if (document.body) c = lgParseColor(getComputedStyle(document.body).backgroundColor);
    if (!c || c.a < 0.05) {
      c = lgParseColor(getComputedStyle(document.documentElement).backgroundColor);
    }
    if (!c || c.a < 0.05) return { dark: false, lum: 1 };   // 都透明 = 浏览器默认白底
    var lum = lgLuminance(c);
    return { dark: lum < 0.22, lum: lum };
  }

  function whenBody(fn) {
    if (document.body) return fn();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      setTimeout(fn, 0);
    }
  }

  function whenParsed(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  /* ---------------- 应用 ---------------- */

  function startEngines() {
    if (started) return;
    started = true;

    retirePreload();

    if (effMode === 'invert') {
      LGDark.start('invert', settings);
      // 反色模式下再叠玻璃会被一起反掉，没意义
      return;
    }

    if (effMode === 'dynamic') {
      LGDark.start('dynamic', settings);
    }
    // effMode === 'native'：什么都不改，靠浏览器的 prefers-color-scheme

    // 磨砂玻璃只在"最终确实是深色"的页面上加 —— 浅色页面上叠深色半透明板很怪。
    // 圆角没这个问题，深浅都能加。
    var go = surfaceOpts();
    if (IS_TOP && (go.glass || go.roundCorners)) {
      glassOn = true;
      LGGlass.start(go);
    }

    window.addEventListener('load', function () {
      /* 异步加载的样式表这时候才到齐，补搬一次。
       * 只在已经判定为 native 时补 —— 要是已经走了动态改色，
       * 这时再灌一套站点深色规则会和我们改的颜色打架。 */
      if (prefersOn && effMode === 'native') LGPrefers.apply();
      LGDark.rescan();
      if (glassOn) LGGlass.rescan();
      report();
    }, { once: true });

    report();
  }

  function decideAndStart() {
    var m = lgModeFor(settings, HOST);

    if (m === 'off') {
      retirePreload();
      effMode = 'off';
      report();
      return;
    }

    if (m === 'dynamic' || m === 'invert') {
      // 明确指定，不用探测，尽早动手
      effMode = m;
      whenBody(startEngines);
      return;
    }

    // auto / native：必须等样式表就位才能判断站点自带深色
    whenParsed(function () {
      /* Chrome 上没有 browserSettings.overrideContentColorScheme，
       * 改用"把站点自己的 @media (prefers-color-scheme: dark) 规则搬出来"来顶替。
       * 这一步必须跑在亮度探测之前 —— 否则会把明明有深色设计的站点
       * 误判成"没有深色"，白白走一遍动态改色。 */
      if (LG_PLATFORM === 'chrome' && settings.nativeOverride) {
        prefersOn = LGPrefers.apply();
      }

      var p = probeNativeDark();
      nativeDark = p.dark;

      if (m === 'native') {
        effMode = 'native';
      } else {
        // auto
        effMode = (nativeDark && settings.respectNativeDark) ? 'native' : 'dynamic';
      }
      startEngines();
    });
  }

  /* 传给玻璃引擎的参数：磨砂要页面是深色才给，圆角不限；
   * 氛围背景只服务于玻璃，只开圆角时不该改页面底色。 */
  function surfaceOpts() {
    var pageIsDark = (effMode === 'dynamic') || nativeDark;
    var glassOK = !!settings.glass && pageIsDark;
    return Object.assign({}, settings, {
      glass: glassOK,
      ambience: !!settings.ambience && glassOK
    });
  }

  function report() {
    if (!IS_TOP) return;
    send({
      type: LG_MSG.REPORT,
      host: HOST,
      mode: effMode,
      nativeDark: nativeDark,
      dark: LGDark.stats(),
      glass: glassOn ? LGGlass.stats() : { surfaces: 0 },
      prefers: prefersOn ? LGPrefers.stats() : { rules: 0 }
    });
  }

  /* ---------------- 设置热更新 ---------------- */

  function onSettings(next) {
    var prevMode = effMode;
    var prevGlass = glassOn;
    settings = next;

    var m = lgModeFor(settings, HOST);
    var want = m;
    if (m === 'auto') want = (nativeDark && settings.respectNativeDark) ? 'native' : 'dynamic';

    // 模式变了：整个推倒重来
    if (want !== prevMode) {
      LGDark.stop();
      if (prevGlass) { LGGlass.stop(); glassOn = false; }
      started = false;
      effMode = want;
      if (want === 'off') { retirePreload(); report(); return; }
      whenBody(startEngines);
      return;
    }

    // 只是调了滑块
    if (effMode === 'dynamic' || effMode === 'invert') LGDark.restyle(effMode, settings);

    var go = surfaceOpts();
    var wantSurfaces = IS_TOP && (go.glass || go.roundCorners);
    if (wantSurfaces && !glassOn) { glassOn = true; LGGlass.start(go); }
    else if (!wantSurfaces && glassOn) { LGGlass.stop(); glassOn = false; }
    else if (glassOn) LGGlass.restyle(go);

    report();
  }

  try {
    browser.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.settings) return;
      onSettings(Object.assign({}, LG_DEFAULTS, changes.settings.newValue || {}));
    });
  } catch (e) {}

  try {
    browser.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === LG_MSG.STATE && IS_TOP) {
        return Promise.resolve({
          host: HOST, mode: effMode, nativeDark: nativeDark,
          dark: LGDark.stats(), glass: glassOn ? LGGlass.stats() : { surfaces: 0 }
        });
      }
    });
  } catch (e) {}

  lgGetSettings().then(function (s) {
    settings = s;
    decideAndStart();
  });
})();
