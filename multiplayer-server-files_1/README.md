# スーパー・ハエ取り 20人マルチ対戦サーバー

「スーパー・ハエ取り マルチ対戦」用のWebSocketサーバーです。
最大20人が同じ部屋に入り、同じフィールドに出るハエを早い者勝ちで取り合う
リアルタイム対戦を、このサーバーがサーバー権威方式（不正防止）で判定します。

## 動作要件

- Node.js（v18以上推奨。動作確認はv22で実施）
- 依存パッケージ: `ws`（1つだけ。`npm install` で自動取得）

## 1. VPSに配置する

このフォルダ（`haetori-multiplayer-server`）ごと、VPSの任意の場所にアップロードします。

```bash
# 例
scp -r haetori-multiplayer-server user@your-vps:~/
ssh user@your-vps
cd ~/haetori-multiplayer-server
npm install
```

## 2. 動作確認（フォアグラウンドで試す）

```bash
node server.js
```

`ハエ取り20人対戦サーバー起動: ws://0.0.0.0:8080` と表示されれば成功です。

別のターミナルから疎通確認:
```bash
curl http://localhost:8080/health
# => {"ok":true,"rooms":0}
```

Ctrl+C で停止します。

## 3. 常時起動させる（systemdサービス化・推奨）

```bash
sudo tee /etc/systemd/system/haetori-multiplayer.service > /dev/null <<'EOF'
[Unit]
Description=Haetori Multiplayer WebSocket Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/YOUR_USER/haetori-multiplayer-server
ExecStart=/usr/bin/env node server.js
Restart=always
RestartSec=3
Environment=PORT=8080
# User=YOUR_USER

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable haetori-multiplayer
sudo systemctl start haetori-multiplayer
sudo systemctl status haetori-multiplayer
```

ログの確認:
```bash
journalctl -u haetori-multiplayer -f
```

## 4. ポート開放とHTTPS(WSS)化

- ファイアウォールでポート8080（または変更したポート）を開放してください。
  ```bash
  sudo ufw allow 8080/tcp
  ```
- クラウド側（VPS管理画面）にもセキュリティグループ設定があれば同様に開放してください。

### WSS化（強く推奨）

配布するゲーム画面（クライアントHTML）はNetlify等の `https://` ページとして
公開されることになるため、ブラウザの制約上、**暗号化されていない `ws://` への
接続がブロックされる場合があります**（Mixed Content制限）。

Nginxのリバースプロキシ + Let's Encrypt（certbot）でWSS化する例:

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/haetori-multiplayer > /dev/null <<'EOF'
server {
    listen 80;
    server_name your-domain.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/haetori-multiplayer /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d your-domain.example.com
```

これで `wss://your-domain.example.com` として接続できるようになります。

## 5. クライアント側の設定

`スーパー・ハエ取り_マルチ対戦.html` を開き、ファイル内の以下の行を
実際のサーバーURLに書き換えてください。

```js
const WS_URL = 'wss://YOUR-VPS-DOMAIN-HERE.example.com';
```

書き換えたら、そのHTMLファイルをNetlifyの別ページとしてデプロイすれば、
20人までの部屋を作って対戦できるようになります。

## ゲームの流れ

1. 誰か1人が「部屋を作成」→6桁の部屋コードが発行される
2. 他の参加者はその部屋コードを入力して「参加する」（最大20人）
3. ホスト（部屋を作った人）が「ゲーム開始」を押すと、全員同時に35秒間の対戦がスタート
4. 全員が同じフィールドに出現するハエを早い者勝ちでクリック。サーバーが誰が最初にクリックしたかを判定するため、通信タイミングによる不公平は最小限に抑えられます
5. 35秒経過で自動的に結果発表画面へ。ホストが「もう一度対戦」を押せば同じ部屋で再戦できます
6. ホストが退出した場合、部屋に残っている誰かに自動でホスト権限が引き継がれます

## 技術仕様（概要）

- ハエの出現・消滅・当たり判定はすべてサーバー側で決定し、WebSocketで全クライアントに配信します（クライアントは「クリックした」という意思表示を送るだけ）
- 同じハエに複数人が同時にクリックしても、サーバーに最初に到達した1件だけが有効になります
- 部屋は最後の1人が切断してから5分間、誰も再接続しなければ自動的に破棄されます（メモリ節約のため）
- データの永続化（サーバー再起動をまたいだ部屋の保持）は行っていません。部屋はサーバープロセスが動いている間だけ有効です

## 動作確認済みの項目

このコードは以下をローカル環境で自動テスト済みです。

- 部屋作成・参加（20人まで、21人目は満員エラー）
- ホスト以外が「開始」を送っても無視されること
- 2人が同時に同じハエをクリックしても、得点が入るのは1人だけであること
- ホストが切断した場合、残っているプレイヤーに自動でホスト権限が移ること
- ラウンド終了まで通しでプレイし、結果画面が全員に正しく配信されること
