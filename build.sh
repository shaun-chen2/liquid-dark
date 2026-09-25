#!/bin/bash
# 打包成 .xpi（本质就是 zip，注意要打包目录内容而不是目录本身）
set -e
cd "$(dirname "$0")"

OUT="liquid-dark.xpi"
rm -f "$OUT"

zip -r -FS "$OUT" \
  manifest.json platform.js common.js color.js background.js \
  engine-dark.js engine-glass.js engine-prefers.js content.js preload.css \
  popup.html popup.css popup.js \
  options.html options.js \
  icons \
  -x '*.DS_Store' 'icons/icon-source.png' > /dev/null

echo "已生成 $(pwd)/$OUT  ($(du -h "$OUT" | cut -f1))"

# 自检：manifest 里引用的每个 js/css 都必须在包里，漏一个 AMO 就拒
node -e '
const m=require("./manifest.json"),{execSync}=require("child_process");
const inZip=new Set(execSync("unzip -Z1 '"$OUT"'").toString().split("\n"));
const need=[...m.background.scripts,...m.content_scripts.flatMap(c=>[...(c.js||[]),...(c.css||[])])];
const miss=need.filter(f=>!inZip.has(f));
if(miss.length){console.error("包里缺文件: "+miss.join(", "));process.exit(1)}
console.log("自检通过：manifest 引用的 "+need.length+" 个文件都在包里");
'
