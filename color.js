'use strict';

/* 颜色解析与深色映射。
 *
 * 思路不是简单反色，而是在 HSL 空间保留色相、压缩明度：
 * 亮背景压到暗区，暗文字提到亮区，饱和度略降免得发荧光。
 * 这样品牌色还认得出来，图片完全不受影响。 */

function lgParseColor(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  // computed style 基本只会返回 rgb()/rgba()，但新语法 rgb(r g b / a) 也兜住
  var m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/);
  if (m) {
    var a = 1;
    if (m[4] !== undefined) {
      a = m[4].slice(-1) === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }

  var h = s.match(/^#([0-9a-f]{3,8})$/);
  if (h) {
    var x = h[1];
    if (x.length === 3 || x.length === 4) {
      x = x.split('').map(function (c) { return c + c; }).join('');
    }
    if (x.length !== 6 && x.length !== 8) return null;
    return {
      r: parseInt(x.slice(0, 2), 16),
      g: parseInt(x.slice(2, 4), 16),
      b: parseInt(x.slice(4, 6), 16),
      a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1
    };
  }
  return null;
}

function lgRgbToHsl(c) {
  var r = c.r / 255, g = c.g / 255, b = c.b / 255;
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  var l = (max + min) / 2;
  var h = 0, s = 0;
  if (max !== min) {
    var d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h, s: s, l: l, a: c.a };
}

function lgHslToRgb(x) {
  var h = x.h, s = x.s, l = x.l;
  if (s === 0) {
    var v = Math.round(l * 255);
    return { r: v, g: v, b: v, a: x.a };
  }
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  var p = 2 * l - q;
  function hue(t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  return {
    r: Math.round(hue(h + 1 / 3) * 255),
    g: Math.round(hue(h) * 255),
    b: Math.round(hue(h - 1 / 3) * 255),
    a: x.a
  };
}

function lgCss(c) {
  if (c.a >= 1) return 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + Math.round(c.a * 1000) / 1000 + ')';
}

/* sRGB 相对亮度，用来判断"这是浅色还是深色" */
function lgLuminance(c) {
  function ch(v) {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function lgClamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* 对比度微调：以 0.5 为中心做幂次拉伸 */
function lgApplyContrast(l, contrast) {
  var k = contrast / 100;
  if (k === 1) return l;
  return lgClamp(0.5 + (l - 0.5) * k, 0, 1);
}

/* 背景色：L>0.35 的才处理，线性映射到 [0.07, 0.30] */
function lgDarkenBg(c, o) {
  var hsl = lgRgbToHsl(c);
  if (hsl.l < 0.35) return null;            // 本来就够暗，不动

  var nl = 0.30 - (hsl.l - 0.35) * (0.30 - 0.07) / 0.65;
  nl = hsl.l + (nl - hsl.l) * (o.darkness / 100);
  nl = lgApplyContrast(nl, 200 - o.contrast);   // 背景的对比度方向与文字相反

  return lgCss(lgHslToRgb({
    h: hsl.h,
    s: hsl.s * 0.78,
    l: lgClamp(nl, 0, 1),
    a: hsl.a
  }));
}

/* 文字色：L<0.55 的才处理，线性映射到 [0.68, 0.92] */
function lgLightenFg(c, o) {
  var hsl = lgRgbToHsl(c);
  if (hsl.l > 0.55) return null;            // 本来就够亮，不动

  var nl = 0.92 - hsl.l * (0.92 - 0.68) / 0.55;
  nl = hsl.l + (nl - hsl.l) * (o.darkness / 100);
  nl = lgApplyContrast(nl, o.contrast);

  return lgCss(lgHslToRgb({
    h: hsl.h,
    s: hsl.s * 0.9,
    l: lgClamp(nl, 0, 1),
    a: hsl.a
  }));
}

/* 边框：比背景稍亮一点，才看得见分隔 */
function lgDarkenBorder(c, o) {
  var hsl = lgRgbToHsl(c);
  if (hsl.l < 0.30) return null;
  var nl = 0.34 - (hsl.l - 0.30) * (0.34 - 0.16) / 0.70;
  nl = hsl.l + (nl - hsl.l) * (o.darkness / 100);
  return lgCss(lgHslToRgb({ h: hsl.h, s: hsl.s * 0.6, l: lgClamp(nl, 0, 1), a: hsl.a }));
}

/* 渐变是否整体偏亮 —— 用来决定要不要把浅色渐变整个抹掉 */
function lgGradientIsLight(str) {
  var cols = String(str).match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g);
  if (!cols || !cols.length) return false;
  var sum = 0, n = 0;
  for (var i = 0; i < cols.length; i++) {
    var c = lgParseColor(cols[i]);
    if (!c || c.a < 0.15) continue;
    sum += lgLuminance(c);
    n++;
  }
  return n > 0 && (sum / n) > 0.45;
}
