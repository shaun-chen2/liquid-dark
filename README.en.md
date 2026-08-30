[简体中文](README.md) | **English**

# Liquid Glass Dark

Turns every website dark, then layers on an Apple-style liquid-glass finish. **Works on both Firefox and Chrome.**

The engines, popup and options page share one source tree across both browsers — only three files are platform-specific (see [Chrome build](#chrome-build)), so a bug fix only has to be written once.

**[▶ Install from Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/%E6%B6%B2%E6%80%81%E7%8E%BB%E7%92%83%E6%B7%B1%E8%89%B2/)** · for Chrome, see [below](#chrome-build)

---

## Three-layer architecture

There are three ways to force a site dark, and they differ a lot in quality. This extension stacks all three and automatically picks the best one available.

| Layer | How | Quality | Coverage |
|---|---|---|---|
| **1. Native** | `browserSettings.overrideContentColorScheme` makes the browser report `prefers-color-scheme: dark` to every site | Perfect — the site uses the dark theme its own designers built. Zero hacks | Only sites that ship a dark design |
| **2. Dynamic recolor** | Walk the DOM, read computed styles, compress lightness in HSL while preserving hue | Good. Images, icons and SVG are never touched | Every site |
| **3. Filter inversion** | `filter: invert(1) hue-rotate(180deg)` | Crude — hues shift | Every site, last resort |

**Auto mode** enables layer 1, then probes the page's background luminance: if the page already came out dark it stops there; only if it is still light does layer 2 kick in. Layer 3 is used only when you select it explicitly.

One design detail makes that probe possible: the anti-flash bootstrap in `preload.css` paints its dark background with `background-image: linear-gradient(...)` rather than `background-color`. That way, when the content script reads the computed `backgroundColor`, it gets the site's real value instead of our own anti-flash layer.

---

## Rounded corners and liquid glass (two independent switches)

**Rounded corners** and **frosted glass** are separate features with separate toggles. Want rounding without translucency? Turn glass off. The reverse works too. Full-width sticky bars never get rounded — it looks wrong.

The extension picks out elements that "look like a panel" — sticky/floating bars, `<header>` `<nav>` `<aside>` `<dialog>`, `role=dialog/navigation/toolbar`, and cards that have both a background and a shadow — and gives them:

- `backdrop-filter: blur() saturate()` for the frosted backdrop
- A translucent dark fill
- A linear-gradient specular highlight along the top edge (the signature liquid-glass stroke)
- A hairline rim outline plus inner and outer shadows

Two implementation details decide whether it actually looks right:

- **The rim uses `outline` with a negative `outline-offset`, not `border`.** A border grows the box and changes layout; an outline does not participate in layout at all.
- **The top highlight is a `background-image` gradient, not a pseudo-element.** Sites use their own `::before`/`::after` for real purposes; overriding them breaks things.

### Light content painted on `<canvas>`

Canvas pixels are drawn, not styled — CSS cannot recolor them. A code editor's **minimap** is the classic trap: the editor body is DOM-rendered so it goes dark, the minimap is a canvas and stays exactly as it was, leaving a big white slab down the right side of an otherwise dark page.

The fix is sampling. The canvas is drawn down into a temporary 8×8 canvas and read back with a single `getImageData`, then mean luminance and standard deviation are computed. Only content that is **both bright and flat** (`mean > 0.62` and `sd < 0.26`, typical of UI painting) gets inverted; photos have high variance and dark charts are already dark, so both are left alone. If the canvas is cross-origin-tainted or a WebGL surface whose pixels cannot be read, it is skipped. There is a toggle for this in the options page.

### State styles (`:hover`, `:focus`, …)

These are **invisible** to computed style — the mouse is not over the element when the engine scans, so that `background:#f5f5f5` simply is not in the computed value. The engine therefore parses the stylesheets themselves, extracts rules carrying state pseudo-classes, rewrites their colors through the same mapping, and re-emits them. Cross-origin stylesheets do not expose `cssRules`, so the content script uses its `<all_urls>` permission to fetch the CSS text and parses it with `new CSSStyleSheet().replaceSync()` (parsed only — never adopted into the document). `@media` conditions are preserved verbatim. Hover backgrounds get an extra lift in lightness: on a light page hover means "slightly darker than the surface", and on a dark page that direction has to flip to stay visible.

### Popovers never get frosted

Dropdowns, menus and tooltips — small panels floating above body content — always get an **opaque** fill and no `backdrop-filter`. Translucency plus blur over running text makes menu labels mushy; readability wins over looks.

**Menus are always opaque and must never fall into the translucent-glass branch.** The check deliberately does *not* require `position: absolute/fixed` — Hydro's dropdown, measured on a live site, is `static`. Keying on position alone would drop it into the ordinary card branch, where it would pick up `rgba(...,.55)` + `saturate(180%)` and visibly wash out against the ambience gradient. Since rounding and glass both come from the same `data-lgg` attribute, the user-visible symptom was "it goes pale the moment the corners round". Popovers **may** live inside a glass surface (a dropdown is often anchored inside an already-frosted `nav`); they just may not nest inside another popover, or every `<li>` in the menu would become its own panel.

### Popovers are prepared at page load, not patched afterwards

Two steps:

1. **At load**, a single `querySelectorAll` collects every element that could be a popover (ARIA roles plus `dropdown`/`menu`/`popover`/`tooltip`-style class names). Any of them that currently has **no layout box** (i.e. is hidden) gets the opaque fill applied right away. So it is already dark the instant it appears — there is no white flash to catch.
2. **Within the frame it opens**, it is upgraded to the full popover style. Hooks are registered on `pointerdown`/`mousedown`/`click`/`keydown`/`focusin` in the **capture phase**, and the callback runs in `requestAnimationFrame`: the site's own open logic runs during bubbling, and the rAF callback is queued after that but **before paint**, so the menu carries its styling before it is ever drawn. Pure-CSS hover menus are covered by a throttled `mouseover` fallback.

When classification is inconclusive the dark pre-mark is **kept**, never revoked — revoking it re-exposes the site's original light background, which is exactly what caused the "goes pale a moment after it appears" bug. It is only revoked for something that is obviously a large page region (over 55% of the viewport, so it cannot be a popover).

### Ambience backdrop

`backdrop-filter` blurs whatever is behind the element. If the page sits on a flat color there is nothing to see and the glass reads as a plain translucent slab. So a soft multi-point radial gradient is laid down underneath, giving the glass something to refract. It can be turned off.

Painting that gradient on `html` alone is not enough: many sites wrap everything below `body` in a **full-width opaque container** that covers it completely. So when ambience is on, the extension walks down from `body` following that chain of full-width opaque wrappers and punches them transparent.

---

## Chrome build

`liquid-dark-chrome/` is a **generated** directory, produced from the Firefox sources by this repo's `build-chrome.sh`:

```bash
bash build-chrome.sh
```

It writes a sibling `liquid-dark-chrome/` (an MV3 extension directory) and `liquid-dark-chrome.zip`.

**Install:** open `chrome://extensions`, turn on **Developer mode**, then drag the zip straight onto the page. It survives restarts.

> Dragging a `.crx` in will install it but leave it **force-disabled** — Chrome records `disable_reasons=[256]` in its `Secure Preferences`, the toggle is greyed out and there is no way to enable it from the UI. That is simply how Chrome treats CRX files from outside the Web Store; don't waste time on it.

### What differs between the two platforms

Exactly three files:

| File | Difference |
|---|---|
| `platform.js` | The `LG_PLATFORM` constant plus a `var browser = globalThis.browser \|\| chrome` shim |
| `manifest.json` | MV2 vs MV3 (`browser_action`→`action`, background page→service worker, host permissions split out into `host_permissions`) |
| `background.js` | Event page vs service worker; Chrome has no `browserSettings` |

**The one substantive functional difference:** Firefox has `browserSettings.overrideContentColorScheme`, a single call that makes the browser report `prefers-color-scheme: dark` to every site, so a site's own dark design takes over flawlessly. Chrome has no equivalent API — `chrome.debugger`'s `Emulation.setEmulatedMedia` can do it, but it pins a permanent "is debugging this browser" banner to the top of the window, which is unusable day to day.

The substitute is `engine-prefers.js`: it parses stylesheets, lifts the rules the site wrote inside `@media (prefers-color-scheme: dark)`, strips the media condition and re-emits them — so you still get the dark palette the site's designers made. Note also that if the operating system itself is set to dark, Chrome already reports `prefers-color-scheme: dark` to sites, and this layer is mostly redundant.

---

## Install

### Firefox — from the add-ons store (recommended)

**[👉 addons.mozilla.org · Liquid Glass Dark](https://addons.mozilla.org/en-US/firefox/addon/%E6%B6%B2%E6%80%81%E7%8E%BB%E7%92%83%E6%B7%B1%E8%89%B2/)**

Click "Add to Firefox" and you're done; future versions update automatically. Requires Firefox 142+.

### Chrome

See [Chrome build](#chrome-build) above — run `bash build-chrome.sh`, then drag the resulting zip
onto `chrome://extensions` (turn on Developer mode first).

<details>
<summary><b>Building from source (for development)</b></summary>

Package as an xpi:

```bash
bash build.sh
```

**Temporary load** (gone after restart; this is what you want while editing code):
`about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest.json`

**Note:** release and beta Firefox mandate extension signatures, and the
`xpinstall.signatures.required` pref has **no effect** on those builds (it only works on
Developer Edition, Nightly, ESR and unbranded builds). So an unsigned xpi you built yourself
can only be loaded temporarily. For a permanent install, use the store version above, or upload
the xpi to [AMO](https://addons.mozilla.org/developers/addon/submit/distribution) for
self-distribution signing (answer **No** to the source-code question — `build.sh` only zips,
with no compilation, minification or bundling of any kind).

</details>

---

## Usage

Click the toolbar icon:

- **Per-site mode**: follow global / native / dynamic / invert / off, overriding the global setting
- **Darkness and contrast**: applied live as you drag, no reload needed
- **Rounded corners**: own toggle plus radius
- **Liquid glass**: own toggle plus blur radius, opacity, ambience backdrop
- The footer shows how many elements, distinct colors and glass panels this page produced

Excluded sites get a ✕ badge on the icon.

Global defaults and the domain blocklist live in the options page.

---

## Verified

Run against representative local test pages in headless Firefox:

| Test page | Expectation | Result |
|---|---|---|
| Light site (white background, sticky header, cards, light gradient, image) | Takes the dynamic path | ✅ `lgd=8` elements recolored, link `#0645ad` → `rgb(146,183,245)`, light gradient removed, `imgFilter=none` so the image is untouched, 3 glass panels |
| Site ships its own dark theme (explicit `color-scheme: dark`) | Detected as dark, left alone | ✅ `lgd=0`, glass only |
| Site uses `@media (prefers-color-scheme: dark)` | Layer 1 flips it, then it probes as dark | ✅ `prefersDark=true`, `lgd=0` |
| Heavy page, 4510 elements | Initial walk must not be slow | ✅ **125 ms** |
| `position: fixed` element (dynamic mode, scrolled 600px) | Must not drift | ✅ `top` is 0 before and after |
| `position: fixed` element (**invert** mode, scrolled 600px) | — | ✅ also no drift, see below |
| popup / options pages | No JS errors, render correctly | ✅ |
| Six consecutive glass-parameter changes plus radius and darkness (simulated slider drag) | Page must never flash back to light | ✅ 103 samples, token count held steady at 5 (never dropped to 0), brightest element background only reached rgb(89,89,89) |
| Glass off, rounding on | Corners stay, frosting goes | ✅ `borderRadius=30px`, `backdropFilter=none` |
| Replica of Hydro's structure (full-width opaque `#panel` + 68%-wide long content column + fixed nav) | Backdrop punched through, content column frosted, nav becomes an edge panel | ✅ `panelBg=rgba(0,0,0,0)`, `secBackdrop=blur(26px)`, `navGlass=edge`, and the wrapper itself is not frosted |
| Dropdown opened inside a frosted nav | Menu must be opaque and readable | ✅ `data-lgg=pop`, opaque `rgb(35,35,43)` fill, `backdropFilter=none`, text `rgb(215,220,225)`; nav and ordinary cards keep their glass |
| `:focus` state (same-origin + cross-origin sheets + inside `@media`) | State background must darken and stay visible | ✅ button `rgb(18,18,18)` → focused `rgb(38,38,38)`; harvested 3 `:hover` and 2 `:focus` rules, `@media` conditions preserved |
| Three canvases: bright and flat (minimap-like) / dark / high-variance color (photo-like) | Only the first should be inverted | ✅ bright-and-flat → `invert(1) hue-rotate(180deg)`; dark and photo-like both `filter: none`; `<img>` still untouched |
| Popover prep: menu still `display:none` after load | Already dark | ✅ carries `data-lgpop`, background `rgb(35,35,43)` |
| The instant it opens (synchronously) / first frame | No light frame at any point | ✅ reads `rgb(35,35,43)` synchronously, upgraded to `data-lgg=pop` on frame 1 |
| `position: static` dropdown (Hydro's real-world shape), sampled continuously for 2.5s after opening | Must never go pale or translucent | ✅ 73 samples peaked at 38 (≈`rgb(35,35,43)`), `everTranslucent=false`, 14px corners, no frosting; ordinary cards on the same page still frosted |

### Real defects that were found and fixed

**Page flashed light while dragging sliders.** `LGDark.restyle()` used to strip every element's `data-lgd` token and re-walk the whole document, and for that instant the page reverted to its original colors. Worse, it fired on **every** slider movement, even when the setting being changed was a glass parameter with nothing to do with recoloring.

The original-color→target-color conversion is now a pure function, `declFor()`. Changing a setting only regenerates the stylesheet text; not a single token on the DOM is touched. Tokens are bucketed by **original color**, so a parameter change only affects the target color computed for each bucket — bucket membership never changes. Slider writes to storage are also debounced by 140ms so they don't hit storage every frame and broadcast to every tab.

**Glass engine rescanned the whole document.** Every DOM mutation used to re-measure the entire document (`getBoundingClientRect` + `getComputedStyle` + `closest` for each element), which is expensive on large pages. It now remembers evaluated elements in a WeakSet and only processes newly added nodes.

**Panel detection used an area threshold.** An early version rejected anything larger than 82% of the viewport, which killed an 870×5494 main content column — an extremely common layout — as if it were the page backdrop, leaving only a few small cards frosted. **Long is not the same as large.** What actually needs excluding is a wrapper spanning the full viewport **width**. The check is now width-based (rejected at ≥95% of viewport width), with sticky and floating bars exempt since being full-width is their normal state. The card rule also no longer requires the element to have its own border radius — plenty of sites use square-cornered cards, and the rounding is something this extension adds anyway.

**`:hover` states stayed blinding white.** The engine reads `getComputedStyle`, and computed style only reflects the **current** state — the mouse is not over the element during the scan, so `:hover`'s `background:#f5f5f5` never appears in the computed value and was left untouched, producing a white slab on a dark page every time the cursor moved over something. It now parses stylesheets separately and rewrites state rules.

Writing that turned up a well-hidden trap: you **cannot** use `if (r.cssRules)` to test whether a rule is a grouping rule like `@media`. Since Firefox shipped CSS nesting, `CSSStyleRule` inherits from `CSSGroupingRule`, so **every ordinary style rule carries an empty `cssRules`** — and an empty list is truthy. Written that way, every rule is treated as an `@media` and skipped, harvesting nothing at all. Use `typeof r.selectorText === 'string'` to tell them apart.

**Dropdown menus were frosted into translucency.** After v1.2 relaxed the card rule (dropping the "must have its own radius" requirement), an opened dropdown — a floating panel with a white fill and a shadow — was classified as a card and frosted, leaving its text greyed out over the blur layer.

Popovers are now their own class (`data-lgg="pop"`): opaque fill, no frosting, corners and shadow retained. The check runs **before** the "skip if an ancestor is already glass" guard — a dropdown is often anchored inside an already-frosted `nav`, so that guard would skip the one element that most needs special handling.

### A claim I got wrong, disproved by testing

I initially believed that applying `filter` to `html` turns `position: fixed` elements into scrolling ones — the widely repeated drawback of filter-based inversion. Measured: `fixedTopBefore=0, fixedTopAfter=0`. **No drift.**

Reading the spec explained why: CSS Filter Effects explicitly exempts the root element — a filter only establishes a containing block for absolutely and fixed-positioned descendants on **non-root** elements. All the documentation was corrected.

Inversion's real drawbacks are different:

- Hues are only approximately restored by `hue-rotate(180deg)`, so brand colors shift
- Dark icons and logos inside CSS background images get inverted to light (only those set via inline `style="background-image"` are inverted back)
- Elements where the site already uses `filter` or `mix-blend-mode` compound incorrectly
- Glass cannot be layered on top — it would be inverted along with everything else, so glass is disabled automatically in invert mode

---

## Known limitations

- **Dark icons inside `<img>` / `<svg>`.** Dynamic mode never touches images, so a dark line icon on a dark background becomes hard to see. Canvas has the sampling fallback; images do not — that is the unavoidable price of not doing per-image analysis (Dark Reader solves it by sampling each image, an order of magnitude more expensive). Switch that site to invert mode.
- **CSS gradients.** Only gradients that are bright overall are removed and replaced with a flat dark fill; mid-tone gradients are left as-is and can occasionally read too light.
- **9000-element cap.** Beyond that the walk stops, and the popup reports that the cap was reached.
- **30-panel cap** (configurable). `backdrop-filter` is GPU-hungry; this is the performance gate. Lower it if a page stutters.
- **Ambience makes `body` and full-width backdrops transparent**, so the site's own base color is no longer visible. A backdrop must be both **wide enough (≥90% of viewport width) and tall enough (≥60% of viewport height)** to qualify, which keeps an ordinary full-width content strip from being punched through by mistake. Turn ambience off if you don't want this.
- **1500-rule cap on state rules**, and at most 8 cross-origin stylesheets are fetched.
- **Code blocks** (`<pre>`, `<code>`) get neither glass nor rounding — frosting hurts the readability of monospaced text.
- **Cross-origin iframes** are handled independently; glass and ambience apply only to the top-level document.

If a site breaks: set it to "off" for that site from the popup, or add it to the blocklist in the options page.

---

## Files

```
manifest.json     MV2 manifest (Firefox)
platform.js       Platform constant; build-chrome.sh swaps in a different one for Chrome
engine-prefers.js Lifts the site's own @media (prefers-color-scheme: dark) rules (Chrome)
common.js         Defaults and per-site mode resolution
color.js          Color parsing + HSL lightness mapping
preload.css       Anti-flash bootstrap (deliberately background-image, see above)
background.js     Global browserSettings dark override, state collection, badge
engine-dark.js    Dynamic recolor engine (color bucketing + data-lgd tokens + MutationObserver)
engine-glass.js   Liquid glass (panel detection + incremental scanning)
content.js        Orchestration: probe, route, drive both engines, live settings updates
icons/            Icons. icon-source.png is the master; other sizes derive from it and it is not shipped
popup.*           Toolbar panel (itself built with the liquid-glass look, doubling as a preview)
options.*         Options page
build.sh          Package as xpi (Firefox)
build-chrome.sh   Generate the Chrome MV3 build from this directory and zip it
```
