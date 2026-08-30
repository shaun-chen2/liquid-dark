'use strict';

/* 平台常量。Chrome 版由 build-chrome.sh 换成另一份，其余源码完全共用。
 *
 * Firefox 上 browser.* 原生存在，且有 browserSettings.overrideContentColorScheme
 * 可以让浏览器直接对所有站点报告 prefers-color-scheme: dark —— 这是质量最高的一层。 */

var LG_PLATFORM = 'firefox';
