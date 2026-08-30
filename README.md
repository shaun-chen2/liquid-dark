**简体中文** | [English](README.en.md)

# 液态玻璃深色

把所有网站变成深色，再叠一层苹果液态玻璃质感。**Firefox 和 Chrome 都支持。**

引擎、面板、设置页两个浏览器共用同一份源码，只有三个文件是平台特有的
（见下方「Chrome 版」一节），所以修 bug 只需要改一处。

**[▶ 从 Firefox 附加组件商店安装](https://addons.mozilla.org/zh-CN/firefox/addon/%E6%B6%B2%E6%80%81%E7%8E%BB%E7%92%83%E6%B7%B1%E8%89%B2/)** · Chrome 见[下方说明](#chrome-版)

---

## 三层架构

"全站深色"有三种做法，质量差很多。这个扩展三层叠加、自动挑最好的那层。

| 层 | 做法 | 质量 | 覆盖面 |
|---|---|---|---|
| **1. 原生** | `browserSettings.overrideContentColorScheme` 让浏览器对所有站点报告 `prefers-color-scheme: dark` | 完美，站点用自己设计的深色，零 hack | 只对有深色设计的站点有效 |
| **2. 动态改色** | 遍历元素读 computed style，在 HSL 空间压明度、保色相 | 好。图片、图标、SVG 完全不碰 | 全部站点 |
| **3. 滤镜反色** | `filter: invert(1) hue-rotate(180deg)` | 糙。色相会偏 | 全部站点，兜底 |

**自动模式**先让第 1 层生效，然后探测页面背景亮度：已经够暗就收手，还是亮的才上第 2 层。第 3 层只在你手动指定时用。

探测能成立有个关键设计：`preload.css` 防白闪时用的是 `background-image: linear-gradient(...)` 而不是 `background-color`，这样内容脚本读 `computed backgroundColor` 时拿到的是站点的真实值，不会被自己的防闪层污染。

---

## 圆角与液态玻璃（两个独立开关）

**圆角**和**磨砂玻璃**是分开的两件事，各有各的开关：只想要圆角、不想要半透明磨砂，把玻璃关掉就行；反过来也可以。通栏的吸顶条不加圆角（加了很怪）。

自动挑出页面里"像一块面板"的元素——吸顶/悬浮栏、`<header>` `<nav>` `<aside>` `<dialog>`、`role=dialog/navigation/toolbar`、以及有底色 + 有投影的卡片——给它们加：

- `backdrop-filter: blur() saturate()` 背景模糊
- 半透明深色底
- 顶边一道线性渐变高光（液态玻璃的关键笔触）
- 环形细描边 + 内外双层阴影

两个实现细节决定了像不像：

- **描边用 `outline` + 负 `outline-offset`，不用 `border`。** border 会撑大盒子改变布局，outline 不参与布局。
- **顶边高光用 `background-image` 的线性渐变做，不用伪元素。** 站点自己的 `::before`/`::after` 经常有用途，覆盖掉会出事。

**canvas 上的浅色内容**：canvas 的像素是画出来的，CSS 改不了颜色。代码编辑器的**小地图**是最典型的坑——正文是 DOM 渲染的会被改深，小地图画在 canvas 上纹丝不动，深色页面右边就杵着一大块白。

办法是采样判断：把整块缩到 8×8 画进一张临时 canvas，一次 `getImageData` 读回来，算平均亮度和标准差。**又亮又平**（`mean > 0.62 且 sd < 0.26`，典型的 UI 绘制）才反色；照片色彩起伏大、深色图表本来就暗，都不动。跨源污染或 WebGL 读不到像素时直接跳过。可以在设置页关掉。

**状态样式（`:hover` / `:focus` …）**：这些是计算样式里**看不到**的——扫描时鼠标不在元素上，那条 `background:#f5f5f5` 压根不在 computed value 里。所以引擎会另外去解析样式表本身，把带状态伪类的规则挑出来、按同一套映射重写颜色再发出去。跨源样式表读不到 `cssRules`，就用内容脚本的 `<all_urls>` 权限把 CSS 抓下来，扔进 `new CSSStyleSheet().replaceSync()` 解析（只解析，不挂到文档上）。`@media` 条件会原样保留。悬停底色额外提亮一点点——浅色页上悬停是"比表面略暗"，深色页上方向要反过来才看得出来。

**浮层不做磨砂**：下拉、菜单、气泡这类飘在正文之上的小面板一律给**不透明**底，不加 `backdrop-filter`。半透明 + 模糊压在正文上会把菜单文字糊掉，可读性优先于观感。

**菜单一律不透明，绝不落进半透明玻璃**。判定不再要求 `position: absolute/fixed` —— Hydro 的下拉实测就是 `static`，只看定位会让它掉进普通卡片那一支，被套上 `rgba(...,.55)` + `saturate(180%)`，压在氛围渐变上明显发浅。而圆角和玻璃来自同一个 `data-lgg`，所以看起来就是"圆角一出现就变浅"。另外浮层**可以**待在玻璃面里（下拉常常正好挂在已被玻璃化的 `nav` 里），只是不能套在另一个浮层里，否则菜单里每个 `li` 都会各自变成一块面板。

**浮层在页面加载时就预处理好**，不是等它出现了再补救。两步：

1. **加载时**用一条 `querySelectorAll` 把所有"可能是浮窗"的元素圈出来（ARIA role + `dropdown`/`menu`/`popover`/`tooltip` 这类类名），其中当前**没有布局盒**（藏着）的，先把不透明底色铺上。这样它一出现就已经是深色，不存在"先闪一下白"。
2. **展开的那一帧内**升级成完整浮层样式。钩子挂在 `pointerdown`/`mousedown`/`click`/`keydown`/`focusin` 的**捕获阶段**，回调用 `requestAnimationFrame`——站点的展开逻辑跑在冒泡阶段，rAF 排在它之后、**绘制之前**，所以菜单还没被画出来就已经带上样式了。纯 CSS 悬停菜单靠节流的 `mouseover` 兜底。

判不出来时**保留**深色预标记，不主动撤——撤掉等于把站点原来的浅色底重新露出来，那正是"显示一会儿后变浅"的成因。只有明显是大块页面区域（面积超过 55% 视口，不可能是浮窗）才撤。

**氛围背景**：`backdrop-filter` 模糊的是背后的东西。如果页面底是一块纯色，玻璃根本看不出来。所以配了一层柔和的多点径向渐变铺在最底，玻璃才有东西可折射。可以关掉。

光在 `html` 上铺渐变还不够：很多站点在 `body` 底下套一层**铺满全宽的不透明容器**，会把渐变整个盖死。所以开氛围时会顺着 `body` 往下找这条"全宽不透明"的链，把它们打透。

---

## Chrome 版

`~/liquid-dark-chrome/` 是**生成物**，由本仓库的 `build-chrome.sh` 从 Firefox 版源码生成：

```bash
bash build-chrome.sh
```

会在同级目录产出 `liquid-dark-chrome/`（MV3 扩展目录）和 `liquid-dark-chrome.zip`。

**安装**：`chrome://extensions` → 打开「开发者模式」→ 把 zip 直接拖进页面。重启不失效。

> `.crx` 拖进去会被装上但**强制停用**（Chrome 的 `Secure Preferences` 里记 `disable_reasons=[256]`，
> 开关是灰的、UI 上无解）。非应用商店来源的 crx 在 Chrome 上就是这个待遇，别浪费时间。

### 两个平台的差异

只有三个文件不同：

| 文件 | 差异 |
|---|---|
| `platform.js` | `LG_PLATFORM` 常量 + `var browser = globalThis.browser \|\| chrome` 垫片 |
| `manifest.json` | MV2 / MV3（`browser_action`→`action`、背景页→Service Worker、主机权限拆到 `host_permissions`） |
| `background.js` | 事件页 / Service Worker；Chrome 没有 `browserSettings` |

**功能上唯一的实质差异**：Firefox 有 `browserSettings.overrideContentColorScheme`，一句话就能让浏览器
对所有站点报告 `prefers-color-scheme: dark`，站点自己的深色设计直接生效、零瑕疵。Chrome 没有等价 API
（`chrome.debugger` 的 `Emulation.setEmulatedMedia` 能做到，但会常驻一条"正在调试"横幅，日常用不了）。

替代方案是 `engine-prefers.js`：解析样式表，把站点写在 `@media (prefers-color-scheme: dark)` 里的规则
搬出来、去掉媒体条件重新发一遍——用的还是站点自己设计的深色。另外，如果操作系统本身就是深色外观，
Chrome 本来就会对站点报告 `prefers-color-scheme: dark`，这一层基本用不上。

---

## 安装

### Firefox —— 从附加组件商店（推荐）

**[👉 addons.mozilla.org · 液态玻璃深色](https://addons.mozilla.org/zh-CN/firefox/addon/%E6%B6%B2%E6%80%81%E7%8E%BB%E7%92%83%E6%B7%B1%E8%89%B2/)**

点「添加到 Firefox」即可，之后新版本会自动更新。需要 Firefox 142+。

### Chrome

见上方「[Chrome 版](#chrome-版)」——跑 `bash build-chrome.sh`，然后把生成的 zip 拖进
`chrome://extensions`（需先打开「开发者模式」）。

<details>
<summary><b>从源码自行构建（开发 / 尝鲜用）</b></summary>

打包成 xpi：

```bash
bash build.sh
```

**临时载入**（重启后失效，改代码调试用这个）：`about:debugging#/runtime/this-firefox`
→ 临时载入附加组件 → 选 `manifest.json`

**注意**：正式版和 Beta 版 Firefox 强制要求扩展签名，`xpinstall.signatures.required`
这个开关在它们上面**无效**（只在 Developer Edition / Nightly / ESR / unbranded 上生效）。
所以自己打的未签名 xpi 只能临时载入；想永久安装就用上面的商店版本，或者把 xpi 传到
[AMO](https://addons.mozilla.org/developers/addon/submit/distribution) 走「自行发布」签名
（源代码那题选「否」——`build.sh` 只做 zip，不做任何编译、压缩或打包转换）。

</details>

---

## 使用

点工具栏图标：

- **本站模式**：跟随全局 / 原生 / 动态 / 反色 / 关闭，覆盖全局设置
- **深色强度、对比度**：拖动即时生效，不用刷新
- **圆角**：独立开关 + 半径
- **液态玻璃**：独立开关 + 模糊半径、通透度、氛围背景
- 底部显示这一页处理了多少元素、多少种颜色、贴了几块玻璃

站点被排除时图标上会有个 ✕ 角标。

全局默认值和域名黑名单在设置页。

---

## 已验证

用三种有代表性的本地测试页 + 无头 Firefox 实跑：

| 测试页 | 期望 | 实测 |
|---|---|---|
| 浅色站点（白底、吸顶栏、卡片、浅色渐变、图片） | 走动态改色 | ✅ `lgd=8` 个元素改色，链接 `#0645ad` → `rgb(146,183,245)`，浅色渐变被抹掉，`imgFilter=none` 图片没被碰，3 块玻璃 |
| 站点自带深色（显式 `color-scheme: dark`） | 探测到深色，不二次处理 | ✅ `lgd=0`，只叠玻璃 |
| 站点用 `@media (prefers-color-scheme: dark)` | 第 1 层让它自动切过去，然后探测到深色 | ✅ `prefersDark=true`、`lgd=0` |
| 4510 个元素的重页面 | 初次遍历不能太慢 | ✅ **125 ms** |
| `position: fixed` 元素（动态模式，滚动 600px） | 不错位 | ✅ 滚动前后 `top` 都是 0 |
| `position: fixed` 元素（**反色**模式，滚动 600px） | —— | ✅ 也不错位，见下 |
| popup / options 页面 | 无 JS 报错、正常渲染 | ✅ |
| 连续改 6 次玻璃参数 + 圆角 + 强度（模拟拖滑块） | 页面不能闪回浅色 | ✅ 采样 103 次，令牌数全程稳定在 5（不掉 0），元素背景最亮只到 rgb(89,89,89) |
| 关掉玻璃只留圆角 | 圆角还在、磨砂消失 | ✅ `borderRadius=30px`、`backdropFilter=none` |
| 复刻 Hydro 结构（全宽不透明 `#panel` + 68% 宽长内容列 + fixed 导航） | 底板打透、内容列变玻璃、导航变通栏玻璃 | ✅ `panelBg=rgba(0,0,0,0)`、`secBackdrop=blur(26px)`、`navGlass=edge`，包装层本身不被玻璃化 |
| 点击展开挂在玻璃 nav 里的下拉菜单 | 菜单要不透明、可读 | ✅ `data-lgg=pop`、底色 `rgb(35,35,43)` 不透明、`backdropFilter=none`、文字 `rgb(215,220,225)`；导航和普通卡片的玻璃不受影响 |
| `:focus` 状态（同源 + 跨源样式表 + `@media` 内） | 状态底色要跟着变深且可见 | ✅ 按钮 `rgb(18,18,18)` → 聚焦 `rgb(38,38,38)`；收割到 3 条 `:hover` / 2 条 `:focus`，`@media` 条件保留 |
| 三种 canvas：浅色平坦（小地图状）／深色／高方差彩色（照片状） | 只有第一种该被反色 | ✅ 浅色平坦 → `invert(1) hue-rotate(180deg)`；深色和照片状都 `filter: none`；`<img>` 依旧不动 |
| 浮窗预处理：加载后菜单仍 `display:none` 时 | 已经是深色 | ✅ 已带 `data-lgpop`、背景 `rgb(35,35,43)` |
| 点击展开的瞬间（同步）／第 1 帧 | 全程不能出现浅色帧 | ✅ 同步读到 `rgb(35,35,43)`，第 1 帧即升级为 `data-lgg=pop` |
| `position: static` 的下拉（复刻 Hydro 实测形态），展开后持续采样 2.5 秒 | 任何时刻都不能变浅或变半透明 | ✅ 73 次采样最亮只到 38（≈`rgb(35,35,43)`），`everTranslucent=false`，圆角 14px、无磨砂；同页普通卡片仍是玻璃 |

### 修过的两个真实缺陷

**调滑块时页面黑白闪**：`LGDark.restyle()` 原本会把所有元素的 `data-lgd` 令牌摘掉再整页重走一遍，那一瞬间页面回到原色。而且**每次滑块动一下都会触发**，哪怕调的是玻璃参数、跟改色毫无关系。

现在把"原色 → 目标色"的换算抽成了纯函数 `declFor()`，改设置时只重新生成样式表文本，元素上的令牌一个都不动——令牌是按**原始颜色**分的桶，参数变化只影响每个桶算出来的目标色，桶的归属根本不会变。顺带给面板的滑块加了 140ms 写入防抖，别每一帧都往 storage 里写一次并广播到所有标签页。

**玻璃引擎重扫全文档**：原本每次 DOM 变动都把整个文档重量一遍（`getBoundingClientRect` + `getComputedStyle` + `closest` 三件套），大页面上很贵。改成 WeakSet 记住判过的元素 + 只处理新增节点。

**面板识别用面积判据**：早期版本"面积超过 82% 视口就否决"，结果一根 870×5494 的内容主列（极常见的布局）被误杀成"页面底板"，整页只剩几个小卡片有玻璃。**长不等于大**——真正该排除的是铺满整个视口**宽度**的包装层。现在改成宽度判据（≥95% 视口宽才否决），并且吸顶/悬浮条豁免（通栏本来就是它的常态）。同时卡片规则不再强制自带圆角——很多站点用直角卡片，而圆角本来就是我们自己加的。

**`:hover` 状态一片惨白**：引擎读的是 `getComputedStyle`，而计算样式只反映**当前状态**——扫描时鼠标不在元素上，`:hover` 那条 `background:#f5f5f5` 根本不出现在计算值里，于是原样保留，深色页面上一划过去就是一块白。现在改成额外解析样式表、重写状态规则。

写这段时踩到一个很隐蔽的坑：判断"这是不是 @media 这类分组规则"**不能用 `if (r.cssRules)`**。Firefox 支持 CSS 嵌套之后 `CSSStyleRule` 继承自 `CSSGroupingRule`，**每条普通样式规则都带一个空的 `cssRules`**，而空列表是 truthy —— 那样写会把所有规则都当成 @media 跳过，一条都收不到。得靠 `typeof r.selectorText === 'string'` 来区分。

**下拉菜单被糊成半透明**：v1.2 放宽卡片规则（去掉"必须自带圆角"）之后，展开的下拉菜单——白底 + 投影的浮动面板——也被判成卡片糊了磨砂，文字压在模糊层上发灰。

现在浮层单独归一类（`data-lgg="pop"`）：不透明底、不做磨砂、保留圆角和投影。识别放在"祖先已是玻璃就跳过"那条保护**之前**——下拉往往正好挂在已被玻璃化的 `nav` 里面，走那条保护会被直接跳过，而它恰恰最需要单独处理。

### 一个我原本写错、被测试推翻的说法

我最初以为"给 `html` 加 `filter` 会让 `position: fixed` 变成跟着滚动"，这是滤镜反色方案广为流传的缺点。实测 `fixedTopBefore=0, fixedTopAfter=0`，**没有错位**。

查了规范才明白：CSS Filter Effects 明确豁免了根元素——filter 只在**非根元素**上才为 absolute/fixed 后代创建包含块。所以文案已全部改掉。

反色模式真正的缺点是别的：

- 色相靠 `hue-rotate(180deg)` 近似还原，品牌色会偏
- CSS 背景图里的深色图标/logo 会被反成浅色（只有内联 `style="background-image"` 的会被再反回来）
- 站点自己用了 `filter` 或 `mix-blend-mode` 的元素会叠加出错
- 玻璃效果没法叠——会被一起反掉，所以反色模式下自动禁用玻璃

---

## 已知限制

- **`<img>` / `<svg>` 里的深色图标**：动态模式不碰图片，所以深色线条图标画在深色底上会看不清。canvas 有采样兜底，图片没有——这是不做逐图分析的必然代价（Dark Reader 靠逐图采样解决，成本高一个数量级）。遇到就切反色模式。
- **CSS 渐变**：只有整体偏亮的渐变会被整块抹掉换成纯深色，中间调渐变保持原样，偶尔会偏亮。
- **元素上限 9000**：超过就停，面板上会显示"已达上限"。
- **面板块数上限 30**（可调）：`backdrop-filter` 很吃 GPU，这是性能闸门。页面卡就调小。
- **氛围背景会把 `body` 和全宽底板设成透明**，站点原本的底色看不到了。底板判定要求同时**够宽（≥90% 视口宽）且够高（≥60% 视口高）**，避免把一条全宽的普通内容区误打透。不想要就关掉氛围背景。
- **状态规则上限 1500 条**，跨源样式表最多抓 8 张。
- **代码块**（`<pre>` `<code>`）不做玻璃/圆角，磨砂会影响等宽文字的可读性。
- **跨源 iframe** 各自独立处理，玻璃和氛围只在顶层文档生效。

遇到搞坏的站点：面板里给它单独选「关闭」，或者在设置页加进黑名单。

---

## 文件

```
manifest.json     MV2 清单（Firefox）
platform.js       平台常量；Chrome 版由 build-chrome.sh 换成另一份
engine-prefers.js 搬运站点自带的 @media (prefers-color-scheme: dark) 规则（Chrome 用）
common.js         默认配置、站点模式解析
color.js          颜色解析 + HSL 明度映射
preload.css       防白闪引导层（故意用 background-image，见上文）
background.js     browserSettings 全局深色覆盖、状态收集、角标
engine-dark.js    动态改色引擎（颜色分桶 + data-lgd 令牌 + MutationObserver）
engine-glass.js   液态玻璃（面板识别 + 增量扫描）
content.js        编排：探测、选路、驱动两个引擎、设置热更新
icons/            图标。icon-source.png 是原图，其余尺寸由它生成，源图不打进包
popup.*           工具栏面板（本身就用了一遍液态玻璃，顺便当效果预览）
options.*         设置页
build.sh          打包成 xpi（Firefox）
build-chrome.sh   从本目录生成 Chrome MV3 版并打 zip
```
