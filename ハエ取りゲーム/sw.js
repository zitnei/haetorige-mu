// ホーム画面に追加したときに使うサービスワーカー。
// 「まずネットから取る → つながらなければ保存してある分を出す」方式なので、
// GitHubに新しい版をpushすれば次に開いたときに最新になる（古い画面が残らない）。
const CACHE = 'haetori-v1';
const SHELL = [
  './',
  './index.html',
  './multiplayer.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;             // 送信系はそのまま
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 他サイト（サーバー通信など）には触らない

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
