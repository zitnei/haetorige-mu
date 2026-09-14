#!/usr/bin/env bash
# VPS用: GitHubの server.js が更新されていれば取得してサーバーを再起動する
# cron から1分ごとに呼ばれる想定（手動実行も可: bash deploy.sh）
set -euo pipefail

DEST_DIR="${DEST_DIR:-$HOME/haetori-multiplayer/multiplayer-server-files_1}"
SERVICE="${SERVICE:-haetori-multiplayer}"
# 「ハエ取りゲーム」はURLエンコード済み
BASE_URL="https://raw.githubusercontent.com/zitnei/haetorige-mu/main/%E3%83%8F%E3%82%A8%E5%8F%96%E3%82%8A%E3%82%B2%E3%83%BC%E3%83%A0/multiplayer-server-files"

log() { echo "[$(date '+%F %T')] $*"; }

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# raw.githubusercontent.com のキャッシュ回避
curl -fsSL -H 'Cache-Control: no-cache' "$BASE_URL/server.js?t=$(date +%s)" -o "$TMP"

if [ -f "$DEST_DIR/server.js" ] && cmp -s "$TMP" "$DEST_DIR/server.js"; then
  exit 0  # 変更なし
fi

# 壊れたファイルで上書きしないよう構文チェック
if ! node --check "$TMP"; then
  log "構文エラーのため更新を中止しました"
  exit 1
fi

mkdir -p "$DEST_DIR"
[ -f "$DEST_DIR/server.js" ] && cp "$DEST_DIR/server.js" "$DEST_DIR/server.js.bak"
cp "$TMP" "$DEST_DIR/server.js"
log "server.js を更新しました"

if systemctl list-unit-files 2>/dev/null | grep -q "^$SERVICE.service"; then
  if [ "$(id -u)" -eq 0 ]; then
    systemctl restart "$SERVICE"
  else
    sudo -n systemctl restart "$SERVICE"
  fi
  log "$SERVICE を再起動しました"
elif command -v pm2 >/dev/null 2>&1; then
  pm2 restart all
  log "pm2 で再起動しました"
else
  log "再起動方法が見つかりません。サーバーを手動で再起動してください"
fi
