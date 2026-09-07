// スーパー・ハエ取り 20人対戦 WebSocketサーバー（サーバー権威方式）
//
// - 部屋（ルーム）作成・参加をコードで管理
// - ハエの発生・消滅・当たり判定はすべてこのサーバーが決定する
//   （クライアントは「クリックした」という意思表示を送るだけで、
//    実際に得点になるかどうかはサーバーが判定して全員に配信する）
// - 最大20人/部屋、同時35秒のラウンド制
//
// 起動:
//   npm install
//   node server.js
//   (環境変数 PORT で待受ポート変更可。既定 8080)

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 20;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 35;
const TICK_MS = 100; // サーバーのゲームループ間隔

// ---- ハエの種類定義（既存のソロ版と揃えたバランス） ----
const FLY_TYPES = {
  normal: { points: 1, ttl: 1700, weight: 55 },
  golden: { points: 5, ttl: 900, weight: 8 },
  decoy: { points: -1, ttl: 1900, weight: 22 },
  ice: { points: 2, ttl: 1900, weight: 7 },
  bomb: { points: 3, ttl: 1600, weight: 8 },
};
const FLY_TYPE_TABLE = Object.entries(FLY_TYPES).flatMap(([type, def]) =>
  Array(def.weight).fill(type)
);

function pickFlyType() {
  return FLY_TYPE_TABLE[Math.floor(Math.random() * FLY_TYPE_TABLE.length)];
}

function genId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function genRoomCode() {
  // 覚えやすい6文字コード（紛らわしい文字は除外）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ---- 部屋の状態 ----
// rooms: Map<roomCode, Room>
// Room = {
//   code, hostId, players: Map<playerId, Player>,
//   state: 'waiting' | 'playing' | 'finished',
//   flies: Map<flyId, Fly>,
//   timeLeft, tickTimer, spawnTimer, createdAt
// }
const rooms = new Map();

function createRoom(hostId, hostName) {
  const code = genRoomCode();
  const room = {
    code,
    hostId,
    players: new Map(),
    state: 'waiting',
    flies: new Map(),
    timeLeft: ROUND_SECONDS,
    tickTimer: null,
    spawnTimer: null,
    createdAt: Date.now(),
  };
  room.players.set(hostId, makePlayer(hostId, hostName));
  rooms.set(code, room);
  return room;
}

function makePlayer(id, name) {
  return { id, name: (name || '名無し').slice(0, 16), score: 0, combo: 1, lives: 3, connected: true, ws: null };
}

function roomIsFull(room) {
  return room.players.size >= MAX_PLAYERS;
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function publicPlayerList(room) {
  return Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .map((p) => ({ id: p.id, name: p.name, score: p.score, lives: p.lives, connected: p.connected }));
}

function publicFlyList(room) {
  return Array.from(room.flies.values()).map((f) => ({
    id: f.id,
    type: f.type,
    x: f.x,
    y: f.y,
  }));
}

function roomSnapshot(room) {
  return {
    type: 'room_state',
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    timeLeft: room.timeLeft,
    players: publicPlayerList(room),
    flies: publicFlyList(room),
  };
}

// ---- ゲームループ ----
function startRound(room) {
  if (room.state === 'playing') return;
  room.state = 'playing';
  room.timeLeft = ROUND_SECONDS;
  room.flies.clear();
  for (const p of room.players.values()) {
    p.score = 0;
    p.combo = 1;
    p.lives = 3;
  }

  broadcast(room, { type: 'round_start', timeLeft: room.timeLeft });
  broadcast(room, roomSnapshot(room));

  spawnLoop(room);
  room.tickTimer = setInterval(() => {
    room.timeLeft -= 1;
    if (room.timeLeft <= 0) {
      endRound(room);
      return;
    }
    broadcast(room, { type: 'tick', timeLeft: room.timeLeft, players: publicPlayerList(room) });
  }, 1000);
}

function spawnFly(room) {
  if (room.state !== 'playing') return;
  if (room.flies.size >= 14) return; // 20人分でも過密にならないよう上限
  const type = pickFlyType();
  const def = FLY_TYPES[type];
  const fly = {
    id: genId('fly'),
    type,
    points: def.points,
    x: Math.random(), // 0..1 正規化座標（クライアント側でフィールドサイズに合わせて拡大）
    y: Math.random() * 0.7,
    bornAt: Date.now(),
    ttl: def.ttl,
    claimed: false,
  };
  room.flies.set(fly.id, fly);
  broadcast(room, { type: 'fly_spawn', fly: { id: fly.id, type: fly.type, x: fly.x, y: fly.y } });

  setTimeout(() => {
    if (room.state !== 'playing') return;
    const stillThere = room.flies.get(fly.id);
    if (stillThere && !stillThere.claimed) {
      room.flies.delete(fly.id);
      broadcast(room, { type: 'fly_expire', id: fly.id });
    }
  }, fly.ttl);
}

function spawnLoop(room) {
  if (room.state !== 'playing') return;
  spawnFly(room);
  const elapsed = ROUND_SECONDS - room.timeLeft;
  const delay = Math.max(180, 620 - elapsed * 6);
  room.spawnTimer = setTimeout(() => spawnLoop(room), delay);
}

function endRound(room) {
  room.state = 'finished';
  clearInterval(room.tickTimer);
  clearTimeout(room.spawnTimer);
  room.flies.clear();
  broadcast(room, { type: 'round_end', players: publicPlayerList(room) });
}

// ---- クリック（ハエを叩く）判定：サーバー権威 ----
function handleHit(room, playerId, flyId) {
  if (room.state !== 'playing') return;
  const player = room.players.get(playerId);
  if (!player) return;
  const fly = room.flies.get(flyId);
  if (!fly || fly.claimed) {
    // すでに他の人が取った後、または存在しないハエ → 何も起きない（早い者勝ちで自然に弾かれる）
    return;
  }
  fly.claimed = true; // 早押しロック：以降の同時リクエストは全て弾かれる
  room.flies.delete(fly.id);

  if (fly.type === 'decoy') {
    player.lives -= 1;
    player.combo = 1;
    broadcast(room, { type: 'fly_result', id: fly.id, by: playerId, result: 'decoy' });
  } else {
    const gained = fly.points * player.combo;
    player.score += gained;
    player.combo = Math.min(8, player.combo + 1);
    broadcast(room, { type: 'fly_result', id: fly.id, by: playerId, result: 'hit', flyType: fly.type, gained, score: player.score });
  }

  broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });

  if (player.lives <= 0) {
    // ライフ切れのプレイヤーは以後スコア加算不可（観戦継続は可）
    player.eliminated = true;
    sendTo(player.ws, { type: 'eliminated' });
  }
}

// ---- HTTP + WebSocket ----
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'create_room') {
      playerId = genId('p');
      const room = createRoom(playerId, msg.name);
      roomCode = room.code;
      room.players.get(playerId).ws = ws;
      sendTo(ws, { type: 'joined', playerId, roomCode: room.code, isHost: true });
      broadcast(room, roomSnapshot(room));
      return;
    }

    if (msg.type === 'join_room') {
      const room = rooms.get((msg.roomCode || '').toUpperCase());
      if (!room) {
        sendTo(ws, { type: 'error', message: 'ルームが見つかりません' });
        return;
      }
      if (roomIsFull(room)) {
        sendTo(ws, { type: 'error', message: 'ルームが満員です（最大20人）' });
        return;
      }
      playerId = genId('p');
      roomCode = room.code;
      const player = makePlayer(playerId, msg.name);
      player.ws = ws;
      room.players.set(playerId, player);
      sendTo(ws, { type: 'joined', playerId, roomCode: room.code, isHost: false });
      broadcast(room, roomSnapshot(room));
      return;
    }

    // 以降は入室済み前提
    const room = rooms.get(roomCode);
    if (!room || !playerId) return;

    if (msg.type === 'start_round') {
      if (playerId !== room.hostId) return; // ホストのみ開始可能
      if (room.state === 'playing') return;
      startRound(room);
      return;
    }

    if (msg.type === 'hit_fly') {
      handleHit(room, playerId, msg.flyId);
      return;
    }

    if (msg.type === 'miss_click') {
      const player = room.players.get(playerId);
      if (player && room.state === 'playing') {
        player.combo = 1;
        broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = room.players.get(playerId);
    if (player) {
      player.connected = false;
      player.ws = null;
    }

    // ホストが抜けた場合、まだ接続中の誰かに自動でホスト権限を移譲する
    if (room.hostId === playerId) {
      const nextHost = Array.from(room.players.values()).find((p) => p.connected);
      if (nextHost) {
        room.hostId = nextHost.id;
        sendTo(nextHost.ws, { type: 'host_transferred' });
      }
    }

    broadcast(room, roomSnapshot(room));

    // 部屋に誰も接続していなければ一定時間後に破棄
    const anyConnected = Array.from(room.players.values()).some((p) => p.connected);
    if (!anyConnected) {
      setTimeout(() => {
        const still = rooms.get(roomCode);
        if (still && !Array.from(still.players.values()).some((p) => p.connected)) {
          clearInterval(still.tickTimer);
          clearTimeout(still.spawnTimer);
          rooms.delete(roomCode);
        }
      }, 5 * 60 * 1000);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`ハエ取り20人対戦サーバー起動: ws://0.0.0.0:${PORT}`);
});
