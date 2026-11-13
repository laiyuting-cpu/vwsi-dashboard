#!/bin/sh
# Cloudflare Pages 建置：只把網站需要的檔案放進 dist/（資料庫規則、後端函式、工作流程不會上網站）
set -e
rm -rf dist && mkdir dist
cp index.html manifest.webmanifest favicon.svg favicon-32.png apple-touch-icon.png icon-192.png icon-512.png _headers dist/
cp -r js fonts img dist/
echo "built: $(find dist -type f | wc -l) files"
