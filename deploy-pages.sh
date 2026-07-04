#!/bin/sh
# public/ を GitHub Pages（gh-pages ブランチ）へ配信・更新する。
# 使い方: public/index.html を編集して main にコミット後、このスクリプトを実行。
#   sh deploy-pages.sh
# 反映先: https://shintaro1955-bot.github.io/gabasho-os/  （反映まで1〜2分）
set -e
cd "$(dirname "$0")"

# 未コミットの public 変更があれば警告（subtree は「コミット済み」の内容を配信する）
if ! git diff --quiet -- public || ! git diff --cached --quiet -- public; then
  echo "⚠ public/ に未コミットの変更があります。先に main へコミットしてください。"
  echo "  例: git add public && git commit -m 'update' && git push origin main"
  exit 1
fi

git branch -D gh-pages 2>/dev/null || true
git subtree split --prefix public -b gh-pages
git push origin gh-pages --force
echo "✅ Deployed → https://shintaro1955-bot.github.io/gabasho-os/  （反映まで1〜2分）"
