#!/usr/bin/env bash
# VPSで一度だけ実行する初期設定
#  1. deploy.sh を配置
#  2. cron で1分ごとに GitHub の更新を確認 → 自動反映
#  3. （root以外で systemd を使う場合）サービス再起動だけをパスワードなしで許可
set -euo pipefail

SERVICE="haetori-multiplayer"
REPO_RAW="https://raw.githubusercontent.com/zitnei/haetorige-mu/main"

curl -fsSL "$REPO_RAW/deploy.sh" -o "$HOME/deploy.sh"
chmod +x "$HOME/deploy.sh"
echo "✔ ~/deploy.sh を配置しました"

CRON_LINE="* * * * * /bin/bash $HOME/deploy.sh >> $HOME/deploy.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'deploy.sh' ; echo "$CRON_LINE" ) | crontab -
echo "✔ cron に登録しました（1分ごとに更新チェック）"

if [ "$(id -u)" -ne 0 ] && systemctl list-unit-files 2>/dev/null | grep -q "^$SERVICE.service"; then
  SYSTEMCTL="$(command -v systemctl)"
  echo "$(whoami) ALL=(root) NOPASSWD: $SYSTEMCTL restart $SERVICE" | sudo tee /etc/sudoers.d/haetori-deploy > /dev/null
  sudo chmod 440 /etc/sudoers.d/haetori-deploy
  sudo visudo -cf /etc/sudoers.d/haetori-deploy > /dev/null
  echo "✔ $SERVICE の再起動のみパスワードなしで許可しました"
fi

bash "$HOME/deploy.sh" && echo "✔ 初回の同期が完了しました（ログ: ~/deploy.log）"
