// スーパー・ハエ取り 20人対戦 WebSocketサーバー（サーバー権威方式）
//
// - 部屋（ルーム）作成・参加をコードで管理
// - ハエの発生・消滅・当たり判定はすべてこのサーバーが決定する
//   （クライアントは「クリックした」という意思表示を送るだけで、
//    実際に得点になるかどうかはサーバーが判定して全員に配信する）
// - 最大20人/部屋、同時2分（120秒）のラウンド制
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
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 120;
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

// ---- 個人ミッション定義（FLY CHAOS PARTY要素） ----
// 「今やることを1つだけ」表示するための短いミッションプール。
// 達成したら即座に次のミッションを配る。
const MISSION_TEMPLATES = [
  { key: 'hit_any_3', label: (n) => `🪰 ハエを${n}匹倒せ！`, count: 3, match: (result) => result === 'hit' },
  { key: 'hit_golden_1', label: () => `✨ 金ハエを1匹つかまえろ！`, count: 1, match: (result, flyType) => result === 'hit' && flyType === 'golden' },
  { key: 'combo_boost', label: () => `🔥 コンボを途切れさせず3匹倒せ！`, count: 3, match: (result) => result === 'hit', comboOnly: true },
  { key: 'hit_any_5', label: (n) => `🪰 ハエを${n}匹倒せ！`, count: 5, match: (result) => result === 'hit' },
  { key: 'avoid_decoy', label: () => `🎯 ニセモノを避けて2匹倒せ！`, count: 2, match: (result) => result === 'hit' },
];

function pickMissionTemplate() {
  return MISSION_TEMPLATES[Math.floor(Math.random() * MISSION_TEMPLATES.length)];
}

function assignMission(room, player) {
  const tpl = pickMissionTemplate();
  player.mission = {
    key: tpl.key,
    label: tpl.label(tpl.count),
    progress: 0,
    target: tpl.count,
    comboOnly: !!tpl.comboOnly,
    match: tpl.match,
  };
  sendTo(player.ws, { type: 'mission_assigned', mission: { label: player.mission.label, progress: 0, target: player.mission.target } });
}

function progressMission(room, player, result, flyType) {
  if (!player.mission) return;
  const m = player.mission;
  if (m.comboOnly && player.combo <= 1 && result !== 'hit') return; // コンボ系は途切れたらノーカン(簡易)
  if (!m.match(result, flyType)) return;
  m.progress += 1;
  sendTo(player.ws, { type: 'mission_progress', progress: m.progress, target: m.target });
  if (m.progress >= m.target) {
    sendTo(player.ws, { type: 'mission_complete', label: m.label });
    player.score += 3; // ミッション達成の小さな報酬
    assignMission(room, player);
  }
}

// ---- TEAM COMBO（全員の行動をまとめたチームコンボ）----
// 誰かがハエを倒す/部位を壊す/必殺技を使うたびにチームカウンターが増える。
// 一定時間ヒットがないと自然減衰し、閾値に達するとCHAOS BONUSが発動する。
const TEAM_COMBO_DECAY_MS = 4000;
const TEAM_COMBO_BONUS_AT = 15;

function bumpTeamCombo(room) {
  room.teamCombo = (room.teamCombo || 0) + 1;
  clearTimeout(room.teamComboDecayTimer);
  broadcast(room, { type: 'team_combo', count: room.teamCombo, needed: Math.max(0, TEAM_COMBO_BONUS_AT - room.teamCombo) });
  if (room.teamCombo >= TEAM_COMBO_BONUS_AT) {
    room.teamCombo = 0;
    broadcast(room, { type: 'chaos_bonus' });
    for (const p of room.players.values()) p.score += 5; // 全員にボーナス
    broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });
  } else {
    room.teamComboDecayTimer = setTimeout(() => {
      room.teamCombo = Math.max(0, (room.teamCombo || 0) - 1);
      broadcast(room, { type: 'team_combo', count: room.teamCombo, needed: Math.max(0, TEAM_COMBO_BONUS_AT - room.teamCombo) });
    }, TEAM_COMBO_DECAY_MS);
  }
}

// ---- CHAOS BOX（フィールドにたまに落ちるランダムボーナス）----
const CHAOS_BOX_EFFECTS = [
  { key: 'score_up', label: '💰 スコア+10！', apply: (room, player) => { player.score += 10; } },
  { key: 'combo_up', label: '🔥 コンボ+3！', apply: (room, player) => { player.combo = Math.min(8, player.combo + 3); } },
  { key: 'team_combo_up', label: '🌍 チームコンボ+5！', apply: (room, player) => { for (let i = 0; i < 5; i++) bumpTeamCombo(room); } },
  { key: 'mission_clear', label: '🎯 ミッション即達成！', apply: (room, player) => { if (player.mission) { player.score += 3; assignMission(room, player); } } },
];

function spawnChaosBox(room) {
  if (room.state !== 'playing') return;
  const box = {
    id: genId('box'),
    x: Math.random(),
    y: Math.random() * 0.7,
  };
  room.chaosBox = box;
  broadcast(room, { type: 'chaos_box_spawn', box });
  room.chaosBoxTimer = setTimeout(() => {
    if (room.chaosBox && room.chaosBox.id === box.id) {
      room.chaosBox = null;
      broadcast(room, { type: 'chaos_box_expire', id: box.id });
    }
  }, 6000);
}

function scheduleChaosBoxLoop(room) {
  if (room.state !== 'playing') return;
  room.chaosBoxSpawnTimer = setTimeout(() => {
    spawnChaosBox(room);
    scheduleChaosBoxLoop(room);
  }, 8000 + Math.random() * 6000); // 8〜14秒ごと
}

function handleChaosBoxClick(room, playerId, boxId) {
  if (!room.chaosBox || room.chaosBox.id !== boxId) return;
  const player = room.players.get(playerId);
  if (!player) return;
  room.chaosBox = null;
  clearTimeout(room.chaosBoxTimer);
  const effect = CHAOS_BOX_EFFECTS[Math.floor(Math.random() * CHAOS_BOX_EFFECTS.length)];
  effect.apply(room, player);
  broadcast(room, { type: 'chaos_box_opened', id: boxId, by: playerId, byName: player.name, label: effect.label });
  broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });
}

// ---- ソロプレイ・ライブ中継の状態 ----
// broadcasters: Map<broadcastId, Broadcaster>
// Broadcaster = {
//   id, name, ws, score, combo, viewers: Map<viewerId, ws>,
//   cheerPoints, createdAt
// }
const broadcasters = new Map();
const CHEER_THRESHOLD = 5; // 応援ポイントがこの数に達するとブースト発動

function publicBroadcastList() {
  return Array.from(broadcasters.values()).map((b) => ({
    id: b.id,
    name: b.name,
    score: b.score,
    combo: b.combo,
    viewerCount: b.viewers.size,
  }));
}

function broadcastToViewers(b, msg) {
  const data = JSON.stringify(msg);
  for (const vws of b.viewers.values()) {
    if (vws.readyState === 1) vws.send(data);
  }
}

function broadcastLobbyUpdate() {
  const data = JSON.stringify({ type: 'live_list', broadcasts: publicBroadcastList() });
  // 全接続中クライアント（部屋のプレイヤー＋観戦者＋まだ入室前のロビー中のソケット）に配る
  for (const ws of allSockets) {
    if (ws.readyState === 1) ws.send(data);
  }
}

const allSockets = new Set();

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
  return { id, name: (name || '名無し').slice(0, 16), score: 0, combo: 1, lives: 3, connected: true, ws: null, mission: null, lastCursorSentAt: 0 };
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
  room.teamCombo = 0;
  room.chaosBox = null;
  for (const p of room.players.values()) {
    p.score = 0;
    p.combo = 1;
    p.lives = 3;
  }

  broadcast(room, { type: 'round_start', timeLeft: room.timeLeft });
  broadcast(room, roomSnapshot(room));

  for (const p of room.players.values()) assignMission(room, p);

  spawnLoop(room);
  scheduleChaosBoxLoop(room);
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
  clearTimeout(room.chaosBoxSpawnTimer);
  clearTimeout(room.chaosBoxTimer);
  clearTimeout(room.teamComboDecayTimer);
  room.flies.clear();
  room.chaosBox = null;
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
    progressMission(room, player, 'decoy', fly.type);
  } else {
    const gained = fly.points * player.combo;
    player.score += gained;
    player.combo = Math.min(8, player.combo + 1);
    broadcast(room, { type: 'fly_result', id: fly.id, by: playerId, result: 'hit', flyType: fly.type, gained, score: player.score });
    progressMission(room, player, 'hit', fly.type);
    bumpTeamCombo(room);
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
  let broadcastId = null; // このソケットが「配信者」として登録したID
  let watchingId = null; // このソケットが「視聴中」の配信ID

  allSockets.add(ws);

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

    // ---- ソロプレイのライブ中継 ----
    if (msg.type === 'start_live') {
      if (broadcastId) return; // 二重開始防止
      broadcastId = genId('live');
      broadcasters.set(broadcastId, {
        id: broadcastId,
        name: (msg.name || '名無し').slice(0, 16),
        ws,
        score: 0,
        combo: 1,
        viewers: new Map(),
      });
      sendTo(ws, { type: 'live_started', broadcastId });
      broadcastLobbyUpdate();
      return;
    }

    if (msg.type === 'live_update') {
      // 配信中のソロプレイヤーからのスコア更新
      if (!broadcastId) return;
      const b = broadcasters.get(broadcastId);
      if (!b) return;
      b.score = msg.score || 0;
      b.combo = msg.combo || 1;
      broadcastToViewers(b, {
        type: 'live_state',
        score: b.score,
        combo: b.combo,
        event: msg.event || null, // 例: {kind:'hit', flyType:'golden', gained:5} や {kind:'decoy'}
      });
      broadcastLobbyUpdate();
      return;
    }

    if (msg.type === 'stop_live') {
      if (!broadcastId) return;
      const b = broadcasters.get(broadcastId);
      if (b) {
        broadcastToViewers(b, { type: 'live_ended' });
        broadcasters.delete(broadcastId);
      }
      broadcastId = null;
      broadcastLobbyUpdate();
      return;
    }

    if (msg.type === 'list_live') {
      sendTo(ws, { type: 'live_list', broadcasts: publicBroadcastList() });
      return;
    }

    if (msg.type === 'watch_live') {
      const b = broadcasters.get(msg.broadcastId);
      if (!b) {
        sendTo(ws, { type: 'error', message: 'その中継は終了しました' });
        return;
      }
      // 既に別の中継を見ていたら外れる
      if (watchingId && broadcasters.has(watchingId)) {
        broadcasters.get(watchingId).viewers.delete(ws.__viewerId);
      }
      const viewerId = genId('v');
      ws.__viewerId = viewerId;
      b.viewers.set(viewerId, ws);
      watchingId = msg.broadcastId;
      sendTo(ws, {
        type: 'watch_started',
        broadcastId: b.id,
        name: b.name,
        score: b.score,
        combo: b.combo,
      });
      broadcastLobbyUpdate();
      return;
    }

    if (msg.type === 'cheer') {
      // 視聴者から配信者への応援。一定数たまるとブースト通知を配信者に送る
      const b = broadcasters.get(msg.broadcastId);
      if (!b) return;
      b.cheerPoints = (b.cheerPoints || 0) + 1;
      broadcastToViewers(b, { type: 'cheer_received', total: b.cheerPoints });
      if (b.cheerPoints >= CHEER_THRESHOLD) {
        b.cheerPoints = 0;
        sendTo(b.ws, { type: 'cheer_boost' }); // 配信者側で次の1匹だけ得点2倍などに使う
      }
      return;
    }

    if (msg.type === 'stop_watch') {
      if (watchingId && broadcasters.has(watchingId)) {
        broadcasters.get(watchingId).viewers.delete(ws.__viewerId);
      }
      watchingId = null;
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

    if (msg.type === 'hit_chaos_box') {
      handleChaosBoxClick(room, playerId, msg.boxId);
      return;
    }

    if (msg.type === 'cursor_move') {
      const player = room.players.get(playerId);
      if (!player || room.state !== 'playing') return;
      const x = Math.max(0, Math.min(1, Number(msg.x)));
      const y = Math.max(0, Math.min(1, Number(msg.y)));
      if (Number.isNaN(x) || Number.isNaN(y)) return;
      // 送信頻度をサーバー側でも軽く制限（1人あたり最短40ms間隔）
      const now = Date.now();
      if (player.lastCursorSentAt && now - player.lastCursorSentAt < 40) return;
      player.lastCursorSentAt = now;
      broadcast(room, { type: 'cursor_update', playerId, name: player.name, x, y });
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
    allSockets.delete(ws);

    // 配信中だった場合は中継終了を視聴者に通知して片付ける
    if (broadcastId && broadcasters.has(broadcastId)) {
      const b = broadcasters.get(broadcastId);
      broadcastToViewers(b, { type: 'live_ended' });
      broadcasters.delete(broadcastId);
      broadcastLobbyUpdate();
    }
    // 視聴中だった場合はその配信の視聴者リストから外す
    if (watchingId && broadcasters.has(watchingId)) {
      broadcasters.get(watchingId).viewers.delete(ws.__viewerId);
    }

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
