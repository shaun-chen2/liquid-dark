#!/bin/bash
# 打包成 .xpi（本质就是 zip，注意要打包目录内容而不是目录本身）
set -e
cd "$(dirname "$0")"

OUT="liquid-dark.xpi"
rm -f "$OUT"

zip -r -FS "$OUT" \
  manifest.json common.js color.js background.js \
  engine-dark.js engine-glass.js content.js preload.css \
  popup.html popup.css popup.js \
  options.html options.js \
  icons \
  -x '*.DS_Store' 'icons/icon-source.png' > /dev/null

echo "已生成 $(pwd)/$OUT  ($(du -h "$OUT" | cut -f1))"
