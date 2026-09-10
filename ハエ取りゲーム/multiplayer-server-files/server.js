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

// モード定義: 'coop'（フィールド協力）/ 'raid'（レイドボス）/ 'chaos'（FLY CHAOS PARTY）
// / 'giant'（巨大ハエ襲来レイド HP1000・5分）/ 'team'（チーム対戦 1v1〜5v5）
// / 'hunt'（人間狩りモード：自分がハエになって人間から逃げ回る非対称対戦）
// / 'fly_night'（FLY NIGHT：DBD風の緊張感＋ハエ叩きの爽快感を組み合わせた3分間スコアアタック）
const VALID_MODES = ['coop', 'raid', 'chaos', 'giant', 'team', 'hunt', 'fly_night'];
const MODE_ROUND_SECONDS = {
  giant: 300, // 5分固定
  hunt: 90, // ハエ側の制限時間逃げ切りサバイバル
  fly_night: 180, // 3分固定
};

// ==================== FLY NIGHT モード ====================
// ハエ種類拡張・コンボ倍率・PERFECT判定・KING FLY段階スコア・
// ハエ・ハンターNPC・ラスト30秒FLY RUSH・簡易エリア分けを持つ独自モード。
const FLY_NIGHT_TYPES = {
  normal: { label: 'ノーマルフライ', points: 10, ttl: 1600, weight: 55 },
  speed: { label: 'スピードフライ', points: 25, ttl: 1100, weight: 20, speed: true },
  zombie: { label: 'ゾンビフライ', points: 50, ttl: 1800, weight: 10, spawnsOnDeath: 5 },
  golden: { label: 'ゴールデンフライ', points: 200, ttl: 1300, weight: 2, announce: true },
  stealth: { label: 'ステルスフライ', points: 100, ttl: 2200, weight: 8, stealth: true },
};
const FLY_NIGHT_TYPE_TABLE = Object.entries(FLY_NIGHT_TYPES).flatMap(([type, def]) =>
  Array(def.weight).fill(type)
);
function pickFlyNightType() {
  return FLY_NIGHT_TYPE_TABLE[Math.floor(Math.random() * FLY_NIGHT_TYPE_TABLE.length)];
}

// 簡易エリア分け：フィールドを4エリアに区切り、エリアごとに出現傾向・危険度を変える
const FLY_NIGHT_AREAS = [
  { key: 'house', label: '🏚 廃屋', xMin: 0, xMax: 0.5, yMin: 0, yMax: 0.5, spawnBoost: 1.0, rareBoost: 1.0 },
  { key: 'garden', label: '🌳 庭', xMin: 0.5, xMax: 1, yMin: 0, yMax: 0.5, spawnBoost: 1.0, rareBoost: 1.0 },
  { key: 'zombie', label: '🧟 ゾンビ区域', xMin: 0, xMax: 0.5, yMin: 0.5, yMax: 1, spawnBoost: 1.6, rareBoost: 1.3 },
  { key: 'contaminated', label: '☠ 汚染区域', xMin: 0.5, xMax: 1, yMin: 0.5, yMax: 1, spawnBoost: 1.3, rareBoost: 2.0 },
];
function pickFlyNightArea() {
  // spawnBoostに応じた重み付き抽選
  const table = FLY_NIGHT_AREAS.flatMap((a) => Array(Math.round(a.spawnBoost * 10)).fill(a));
  return table[Math.floor(Math.random() * table.length)];
}

const KING_FLY_RANK_POINTS = [500, 400, 300, 200, 100]; // 1位〜5位
const FLY_NIGHT_COMBO_TIERS = [
  { count: 50, mult: 5.0 },
  { count: 30, mult: 3.0 },
  { count: 20, mult: 2.0 },
  { count: 10, mult: 1.5 },
  { count: 5, mult: 1.2 },
];
function comboMultiplierFor(streak) {
  for (const tier of FLY_NIGHT_COMBO_TIERS) {
    if (streak >= tier.count) return tier.mult;
  }
  return 1.0;
}
const HUNTER_COUNT = 1; // フィールドを徘徊するハエ・ハンターの数
const HUNTER_STUN_MS = 3000;
const HUNTER_COMBO_PENALTY = 0.3; // 捕まると所持コンボを30%減衰
const HUNTER_CATCH_RADIUS = 0.045;
const HUNTER_TICK_MS = 150;
const HUNTER_SPEED = 0.012; // 1ティックあたりの移動量（正規化座標）
const FLY_RUSH_AT_SECONDS = 30; // 残りこの秒数からFLY RUSH演出
const TEAM_NAMES = ['red', 'blue'];
const TEAM_LABELS = { red: '🔴 レッドチーム', blue: '🔵 ブルーチーム' };

// ハエ役の人数配分：少人数のハエ vs 大多数の人間（20人なら約3人がハエ役）
function flyCountFor(totalPlayers) {
  return Math.max(1, Math.min(4, Math.round(totalPlayers / 7)));
}
const HUNT_CATCH_RADIUS = 0.035; // 正規化座標(0..1)での捕獲判定距離
const HUNT_CATCH_COOLDOWN_MS = 500; // 同じ人間が連続で判定を出さないためのクールダウン

function createRoom(hostId, hostName, mode, opts) {
  const code = genRoomCode();
  const resolvedMode = VALID_MODES.includes(mode) ? mode : 'coop';
  const room = {
    code,
    hostId,
    mode: resolvedMode,
    players: new Map(),
    state: 'waiting',
    flies: new Map(),
    timeLeft: MODE_ROUND_SECONDS[resolvedMode] || ROUND_SECONDS,
    tickTimer: null,
    spawnTimer: null,
    createdAt: Date.now(),
    boss: null, // レイドボスモード用（raid / giant 共通）
    teamSize: resolvedMode === 'team' ? Math.max(1, Math.min(5, Number(opts && opts.teamSize) || 3)) : null,
    teamScore: resolvedMode === 'team' ? { red: 0, blue: 0 } : null,
    hunters: [], // FLY NIGHT用：ハエ・ハンターNPCの配列
    hunterTimer: null,
    kingFlyRankings: [], // FLY NIGHT用：KING FLYへの命中順（段階スコア計算用）
    flyRushActive: false,
  };
  room.players.set(hostId, makePlayer(hostId, hostName, room));
  rooms.set(code, room);
  return room;
}

function assignTeam(room) {
  // 人数が少ない方のチームに割り振る（バランス自動調整）
  let redCount = 0, blueCount = 0;
  for (const p of room.players.values()) {
    if (p.team === 'red') redCount++;
    else if (p.team === 'blue') blueCount++;
  }
  return redCount <= blueCount ? 'red' : 'blue';
}

function makePlayer(id, name, room) {
  const player = {
    id, name: (name || '名無し').slice(0, 16), score: 0, combo: 1, lives: 3, connected: true, ws: null,
    mission: null, lastCursorSentAt: 0, team: null,
    role: null, // 'fly' | 'human'（huntモード用）
    huntX: 0.5, huntY: 0.5, // ハエ役プレイヤー自身の位置（huntモード用）
    caught: false,
    lastCatchAttemptAt: 0,
    // ---- FLY NIGHT用 ----
    fnKills: 0, fnPerfects: 0, fnMisses: 0, fnMaxCombo: 0, fnGolden: 0,
    fnStunnedUntil: 0, fnX: 0.5, fnY: 0.5,
  };
  if (room && room.mode === 'team') {
    player.team = assignTeam(room);
  }
  return player;
}

// huntモード：ラウンド開始時に少人数をハエ役、残りを人間役に割り振る
function assignHuntRoles(room) {
  const players = Array.from(room.players.values()).filter((p) => p.connected);
  const flyCount = Math.min(flyCountFor(players.length), players.length - 1 || 1);
  // シャッフルしてランダムにハエ役を選出
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  players.forEach((p) => { p.role = 'human'; p.caught = false; });
  for (let i = 0; i < flyCount && i < shuffled.length; i++) {
    shuffled[i].role = 'fly';
    shuffled[i].huntX = 0.15 + Math.random() * 0.7;
    shuffled[i].huntY = 0.15 + Math.random() * 0.5;
  }
}

function publicHuntFlies(room) {
  return Array.from(room.players.values())
    .filter((p) => p.role === 'fly')
    .map((p) => ({ id: p.id, name: p.name, x: p.huntX, y: p.huntY, caught: p.caught }));
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
    .map((p) => ({
      id: p.id, name: p.name, score: p.score, lives: p.lives, connected: p.connected, team: p.team || null, role: p.role || null, caught: !!p.caught,
      combo: p.combo, fnKills: p.fnKills, fnPerfects: p.fnPerfects, fnMisses: p.fnMisses, fnMaxCombo: p.fnMaxCombo, fnGolden: p.fnGolden,
      fnStunned: room.mode === 'fly_night' ? Date.now() < p.fnStunnedUntil : false,
    }));
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
    mode: room.mode,
    state: room.state,
    timeLeft: room.timeLeft,
    players: publicPlayerList(room),
    flies: publicFlyList(room),
    boss: (room.mode === 'raid' || room.mode === 'giant') ? publicBossState(room) : null,
    teamScore: room.mode === 'team' ? room.teamScore : null,
    teamSize: room.mode === 'team' ? room.teamSize : null,
    huntFlies: room.mode === 'hunt' ? publicHuntFlies(room) : null,
    hunters: room.mode === 'fly_night' ? room.hunters.map((h) => ({ id: h.id, x: h.x, y: h.y })) : null,
    flyRushActive: room.mode === 'fly_night' ? room.flyRushActive : null,
  };
}

// ---- ゲームループ ----
function startRound(room) {
  if (room.state === 'playing') return;
  room.state = 'playing';
  room.timeLeft = MODE_ROUND_SECONDS[room.mode] || ROUND_SECONDS;
  room.flies.clear();
  room.teamCombo = 0;
  room.chaosBox = null;
  if (room.mode === 'team') room.teamScore = { red: 0, blue: 0 };
  for (const p of room.players.values()) {
    p.score = 0;
    p.combo = 1;
    p.lives = 3;
    p.mission = null;
    p.role = null;
    p.caught = false;
  }

  if (room.mode === 'hunt') assignHuntRoles(room);
  if (room.mode === 'fly_night') {
    room.kingFlyRankings = [];
    room.flyRushActive = false;
    for (const p of room.players.values()) {
      p.fnKills = 0; p.fnPerfects = 0; p.fnMisses = 0; p.fnMaxCombo = 0; p.fnGolden = 0;
      p.fnStunnedUntil = 0;
    }
  }

  broadcast(room, { type: 'round_start', timeLeft: room.timeLeft, mode: room.mode, teamSize: room.teamSize || null });
  broadcast(room, roomSnapshot(room));

  if (room.mode === 'chaos') {
    // FLY CHAOS PARTY: 個人ミッション・CHAOS BOXが主役
    for (const p of room.players.values()) assignMission(room, p);
    scheduleChaosBoxLoop(room);
  }

  if (room.mode === 'raid') {
    startRaidBoss(room, 'raid');
  } else if (room.mode === 'giant') {
    startRaidBoss(room, 'giant');
  } else if (room.mode === 'hunt') {
    // huntモードは通常のハエ湧き無し。プレイヤー自身がハエ／人間として動く
  } else if (room.mode === 'fly_night') {
    spawnHunters(room);
    scheduleHunterLoop(room);
    flyNightSpawnLoop(room);
  } else {
    spawnLoop(room);
  }

  room.tickTimer = setInterval(() => {
    room.timeLeft -= 1;
    if (room.mode === 'hunt') {
      // 生存しているハエが全員捕まったら即終了（人間側の勝利）
      const flies = Array.from(room.players.values()).filter((p) => p.role === 'fly');
      const allCaught = flies.length > 0 && flies.every((p) => p.caught);
      if (allCaught) {
        endRound(room);
        return;
      }
    }
    if (room.mode === 'fly_night' && !room.flyRushActive && room.timeLeft <= FLY_RUSH_AT_SECONDS) {
      room.flyRushActive = true;
      broadcast(room, { type: 'fly_rush_start' });
    }
    if (room.timeLeft <= 0) {
      endRound(room);
      return;
    }
    broadcast(room, { type: 'tick', timeLeft: room.timeLeft, players: publicPlayerList(room) });
  }, 1000);
}

// ==================== レイドボスモード：キングゾンビフライ / 巨大ハエ ====================
// HP300（raid）または HP1000・5分限定（giant）。
// 部位（左翼・右翼・頭・尻尾）を個別に破壊していく。
// さらに「4部位同時叩き」ギミック：各部位に必要人数分の同時ヒットが集まると
// その部位が一気に大破し、4部位すべてが同時期間内に破壊されるとボスがダウンして
// 「全員で叩け！！」の全員総攻撃フェーズに入る。
const BOSS_PRESETS = {
  raid: {
    totalHp: 10000,
    parts: {
      wingL: { label: '左翼', hp: 1000, maxHp: 1000 },
      wingR: { label: '右翼', hp: 1000, maxHp: 1000 },
      head: { label: '頭', hp: 1700, maxHp: 1700 },
      tail: { label: '尻尾', hp: 1300, maxHp: 1300 },
    },
    simulHitsNeeded: 3, // 各部位を同時攻撃するのに必要な人数（20人未満でも遊べるよう控えめ）
    simulWindowMs: 2500, // この時間内に集まった同時攻撃をカウント
    allOutDurationMs: 8000,
    moveIntervalMs: [900, 1600], // 激しく動き回る：この範囲でランダムに移動間隔を決める
    moveRadius: 0.32, // 1回の移動でどれだけ大きく飛び回るか（正規化座標）
    chargeChance: 0.35, // まれに素早い突進（チャージ）move演出になる確率
    damageMult: 12, // HP10000に合わせて1発あたりのダメージを引き上げる倍率
  },
  giant: {
    totalHp: 1000,
    parts: {
      wingL: { label: '左翼', hp: 120, maxHp: 120 },
      wingR: { label: '右翼', hp: 120, maxHp: 120 },
      head: { label: '頭', hp: 180, maxHp: 180 },
      tail: { label: '尻尾', hp: 150, maxHp: 150 },
    },
    simulHitsNeeded: 5, // 「20人で同時に叩く」を再現しつつ20人未満でも成立する人数
    simulWindowMs: 3000,
    allOutDurationMs: 10000,
    moveIntervalMs: [1800, 3200],
    moveRadius: 0.18,
    chargeChance: 0.15,
  },
};

function bossPreset(room) {
  return BOSS_PRESETS[room.mode] || BOSS_PRESETS.raid;
}

function makeBossState(room) {
  const preset = bossPreset(room);
  const parts = {};
  for (const [key, def] of Object.entries(preset.parts)) {
    parts[key] = {
      hp: def.hp,
      maxHp: def.maxHp,
      broken: false,
      simulHits: new Set(), // 現在の同時攻撃ウィンドウ内で叩いたplayerId
      simulWindowTimer: null,
    };
  }
  return {
    hp: preset.totalHp,
    maxHp: preset.totalHp,
    parts,
    grounded: false, // 羽が両方壊れて落下＝弱点露出状態か
    weakSpotUntil: 0,
    down: false, // 4部位同時破壊によるダウン状態
    allOutUntil: 0,
    x: 0.5,
    y: 0.35,
  };
}

function publicBossState(room) {
  if (!room.boss) return null;
  const b = room.boss;
  const preset = bossPreset(room);
  return {
    hp: b.hp,
    maxHp: b.maxHp,
    parts: Object.fromEntries(Object.entries(b.parts).map(([k, v]) => [k, {
      hp: v.hp,
      maxHp: v.maxHp,
      broken: v.broken,
      simulCount: v.simulHits.size,
      simulNeeded: preset.simulHitsNeeded,
    }])),
    grounded: b.grounded,
    weakSpotActive: b.grounded && Date.now() < b.weakSpotUntil,
    down: b.down,
    allOutActive: b.down && Date.now() < b.allOutUntil,
    x: b.x,
    y: b.y,
  };
}

function startRaidBoss(room) {
  room.boss = makeBossState(room);
  broadcast(room, { type: 'boss_spawn', boss: publicBossState(room) });
  scheduleBossAttack(room);
  scheduleBossMovement(room);
}

// ボスがフィールド内を激しく動き回る演出：一定間隔でランダムな位置へジャンプ／突進する。
// ダウン中（全員総攻撃フェーズ）は動きを止めて、狙いやすくする。
function scheduleBossMovement(room) {
  if (room.state !== 'playing' || (room.mode !== 'raid' && room.mode !== 'giant') || !room.boss) return;
  const preset = bossPreset(room);
  const [minMs, maxMs] = preset.moveIntervalMs || [1500, 2500];
  room.bossMoveTimer = setTimeout(() => {
    if (room.state !== 'playing' || !room.boss || room.boss.hp <= 0) return;
    if (!room.boss.down) {
      const boss = room.boss;
      const isCharge = Math.random() < (preset.chargeChance || 0.2);
      const radius = preset.moveRadius || 0.25;
      const nx = Math.max(0.08, Math.min(0.92, boss.x + (Math.random() - 0.5) * radius * 2));
      const ny = Math.max(0.08, Math.min(0.62, boss.y + (Math.random() - 0.5) * radius * 2));
      boss.x = nx;
      boss.y = ny;
      broadcast(room, { type: 'boss_move', x: nx, y: ny, charge: isCharge });
    }
    scheduleBossMovement(room);
  }, minMs + Math.random() * (maxMs - minMs));
}

function scheduleBossAttack(room) {
  if (room.state !== 'playing' || (room.mode !== 'raid' && room.mode !== 'giant')) return;
  room.bossAttackTimer = setTimeout(() => {
    if (room.state !== 'playing' || !room.boss || room.boss.hp <= 0) return;
    if (!room.boss.down) broadcast(room, { type: 'boss_attack_warning' });
    scheduleBossAttack(room);
  }, 6000 + Math.random() * 4000);
}

// 4部位すべてが「同時破壊状態」になったかチェックし、なったらダウン→全員総攻撃を発動
function checkAllPartsDownTogether(room) {
  const boss = room.boss;
  if (!boss || boss.down) return;
  const allBroken = Object.values(boss.parts).every((p) => p.broken);
  if (allBroken) {
    boss.down = true;
    const preset = bossPreset(room);
    boss.allOutUntil = Date.now() + preset.allOutDurationMs;
    broadcast(room, { type: 'boss_down', allOutMs: preset.allOutDurationMs, boss: publicBossState(room) });
    broadcast(room, { type: 'boss_all_out_attack', message: '全員で叩け！！', durationMs: preset.allOutDurationMs });
    clearTimeout(room.bossDownRecoverTimer);
    room.bossDownRecoverTimer = setTimeout(() => {
      if (!room.boss || room.boss.hp <= 0) return;
      room.boss.down = false;
      // ダウン明けは部位を半分再生させて再度狙えるようにする（連戦できるように）
      for (const p of Object.values(room.boss.parts)) {
        if (p.broken) {
          p.broken = false;
          p.hp = Math.ceil(p.maxHp * 0.5);
        }
      }
      broadcast(room, { type: 'boss_recovered', boss: publicBossState(room) });
    }, preset.allOutDurationMs);
  }
}

// プレイヤーがボスの特定部位、または本体を攻撃する
function handleBossHit(room, playerId, targetPart) {
  if (room.state !== 'playing' || (room.mode !== 'raid' && room.mode !== 'giant') || !room.boss) return;
  const player = room.players.get(playerId);
  if (!player) return;
  const boss = room.boss;
  if (boss.hp <= 0) return;
  const preset = bossPreset(room);

  const weakSpotActive = boss.grounded && Date.now() < boss.weakSpotUntil;
  const allOutActive = boss.down && Date.now() < boss.allOutUntil;
  let damage = (3 + Math.floor(Math.random() * 4)) * (preset.damageMult || 1); // 基礎ダメージ（モードごとに倍率調整）
  let brokeNow = null;
  let simulTriggered = false;

  if (allOutActive) {
    // ダウン中は全員で本体に大ダメージ（部位指定不要）
    damage *= 4;
  } else if (targetPart && boss.parts[targetPart] && !boss.parts[targetPart].broken) {
    const part = boss.parts[targetPart];

    // ---- 4部位同時叩きギミック：同じ部位を短時間内に必要人数が叩くと大破 ----
    part.simulHits.add(playerId);
    broadcast(room, {
      type: 'boss_simul_progress',
      targetPart,
      count: part.simulHits.size,
      needed: preset.simulHitsNeeded,
    });
    if (!part.simulWindowTimer) {
      part.simulWindowTimer = setTimeout(() => {
        part.simulHits.clear();
        part.simulWindowTimer = null;
        broadcast(room, { type: 'boss_simul_progress', targetPart, count: 0, needed: preset.simulHitsNeeded });
      }, preset.simulWindowMs);
    }

    part.hp -= damage;
    if (part.simulHits.size >= preset.simulHitsNeeded && !part.broken) {
      // 必要人数が同時に叩き込んだ→即大破
      part.hp = 0;
      simulTriggered = true;
    }

    if (part.hp <= 0) {
      part.hp = 0;
      part.broken = true;
      brokeNow = targetPart;
      damage += (simulTriggered ? 25 : 10) * (preset.damageMult || 1); // 同時叩き達成は大ボーナス
      clearTimeout(part.simulWindowTimer);
      part.simulWindowTimer = null;
      part.simulHits.clear();
      // 羽が両方壊れたら落下→弱点露出
      if (boss.parts.wingL.broken && boss.parts.wingR.broken && !boss.grounded) {
        boss.grounded = true;
        boss.weakSpotUntil = Date.now() + 8000;
        broadcast(room, { type: 'boss_grounded' });
      }
      checkAllPartsDownTogether(room);
    }
  } else if (weakSpotActive) {
    damage *= 3; // 弱点露出中は3倍ダメージ
  }

  boss.hp = Math.max(0, boss.hp - damage);
  player.score += damage;

  broadcast(room, {
    type: 'boss_damage',
    by: playerId,
    byName: player.name,
    damage,
    targetPart: targetPart || null,
    brokePartNow: brokeNow,
    simulTriggered,
    weakSpotHit: weakSpotActive,
    allOutHit: allOutActive,
    boss: publicBossState(room),
  });
  broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });

  if (boss.hp <= 0) {
    clearTimeout(room.bossAttackTimer);
    clearTimeout(room.bossDownRecoverTimer);
    clearTimeout(room.bossMoveTimer);
    broadcast(room, { type: 'boss_defeated', players: publicPlayerList(room) });
    setTimeout(() => endRound(room), 1500);
  }
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

// ==================== FLY NIGHT: ハエ出現・KING FLY・ハンターNPC ====================
function spawnFlyNightFly(room, forceType) {
  if (room.state !== 'playing') return;
  const capacity = room.flyRushActive ? 40 : 16; // ラスト30秒は出現数を約3倍に
  if (room.flies.size >= capacity) return;
  const type = forceType || pickFlyNightType();
  const def = FLY_NIGHT_TYPES[type];
  const area = pickFlyNightArea();
  const rareRollBoost = room.flyRushActive ? 2 : 1;
  const fly = {
    id: genId('fly'),
    type,
    points: def.points,
    x: area.xMin + Math.random() * (area.xMax - area.xMin),
    y: area.yMin + Math.random() * (area.yMax - area.yMin) * 0.9,
    areaKey: area.key,
    bornAt: Date.now(),
    ttl: def.ttl,
    claimed: false,
    stealth: !!def.stealth,
    speed: !!def.speed,
  };
  room.flies.set(fly.id, fly);
  broadcast(room, { type: 'fly_spawn', fly: { id: fly.id, type: fly.type, x: fly.x, y: fly.y, areaKey: fly.areaKey, stealth: fly.stealth, speed: fly.speed } });
  if (def.announce) {
    broadcast(room, { type: 'golden_fly_announce', flyId: fly.id, x: fly.x, y: fly.y });
  }

  setTimeout(() => {
    if (room.state !== 'playing') return;
    const stillThere = room.flies.get(fly.id);
    if (stillThere && !stillThere.claimed) {
      room.flies.delete(fly.id);
      broadcast(room, { type: 'fly_expire', id: fly.id });
    }
  }, fly.ttl);
}

// KING FLY：終盤に低確率で出現し、複数人が段階スコアを取り合う目玉演出
function maybeSpawnKingFly(room) {
  if (room.state !== 'playing') return;
  const elapsed = MODE_ROUND_SECONDS.fly_night - room.timeLeft;
  if (elapsed < 90) return; // 試合終盤（開始90秒以降）のみ抽選
  if (room.kingFlySpawned) return;
  const chance = room.flyRushActive ? 0.06 : 0.015; // ラスト30秒は出現率UP
  if (Math.random() > chance) return;
  room.kingFlySpawned = true;
  room.kingFlyRankings = [];
  const fly = {
    id: genId('fly'),
    type: 'king',
    points: 0, // 段階スコアはhandleHit側でランキング計算
    x: 0.15 + Math.random() * 0.7,
    y: 0.15 + Math.random() * 0.5,
    bornAt: Date.now(),
    ttl: 12000,
    claimed: false,
    hp: 5, // 5回叩かれると撃破（複数人が同時に狙える演出用）
  };
  room.flies.set(fly.id, fly);
  broadcast(room, { type: 'king_fly_spawn', fly: { id: fly.id, x: fly.x, y: fly.y } });
  setTimeout(() => {
    if (room.state !== 'playing') return;
    const still = room.flies.get(fly.id);
    if (still && !still.claimed) {
      room.flies.delete(fly.id);
      broadcast(room, { type: 'fly_expire', id: fly.id });
    }
  }, fly.ttl);
}

function flyNightSpawnLoop(room) {
  if (room.state !== 'playing') return;
  spawnFlyNightFly(room);
  maybeSpawnKingFly(room);
  const elapsed = MODE_ROUND_SECONDS.fly_night - room.timeLeft;
  const rushMult = room.flyRushActive ? 0.35 : 1; // ラスト30秒は湧き間隔を短縮＝出現数3倍相当
  const delay = Math.max(150, (600 - elapsed * 2)) * rushMult;
  room.spawnTimer = setTimeout(() => flyNightSpawnLoop(room), delay);
}

// ---- ハエ・ハンターNPC：フィールドを徘徊しプレイヤーに接触するとスタン+コンボ減衰 ----
function spawnHunters(room) {
  room.hunters = [];
  const count = room.flyRushActive ? HUNTER_COUNT + 1 : HUNTER_COUNT;
  for (let i = 0; i < count; i++) {
    room.hunters.push({
      id: genId('hunter'),
      x: 0.1 + Math.random() * 0.8,
      y: 0.1 + Math.random() * 0.6,
      dx: (Math.random() - 0.5),
      dy: (Math.random() - 0.5),
    });
  }
  broadcast(room, { type: 'hunters_spawn', hunters: room.hunters.map((h) => ({ id: h.id, x: h.x, y: h.y })) });
}

function scheduleHunterLoop(room) {
  if (room.state !== 'playing' || room.mode !== 'fly_night') return;
  room.hunterTimer = setTimeout(() => {
    tickHunters(room);
    scheduleHunterLoop(room);
  }, HUNTER_TICK_MS);
}

function tickHunters(room) {
  if (room.state !== 'playing') return;
  const speed = HUNTER_SPEED * (room.flyRushActive ? 1.8 : 1); // ラスト30秒は高速化
  const players = Array.from(room.players.values()).filter((p) => p.connected);

  for (const hunter of room.hunters) {
    // 一番近いプレイヤーを追跡（簡易AI）
    let target = null, bestDist = Infinity;
    for (const p of players) {
      const dx = p.fnX - hunter.x, dy = p.fnY - hunter.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) { bestDist = dist; target = p; }
    }
    if (target) {
      const dx = target.fnX - hunter.x, dy = target.fnY - hunter.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      hunter.x = Math.max(0, Math.min(1, hunter.x + (dx / len) * speed));
      hunter.y = Math.max(0, Math.min(1, hunter.y + (dy / len) * speed));
    }

    // 接触判定
    for (const p of players) {
      if (Date.now() < p.fnStunnedUntil) continue;
      const dx = p.fnX - hunter.x, dy = p.fnY - hunter.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= HUNTER_CATCH_RADIUS) {
        p.fnStunnedUntil = Date.now() + HUNTER_STUN_MS;
        p.combo = Math.max(1, Math.floor(p.combo * (1 - HUNTER_COMBO_PENALTY)));
        // 少し離れた場所へ復帰
        p.fnX = Math.max(0.05, Math.min(0.95, p.fnX + (Math.random() - 0.5) * 0.3));
        p.fnY = Math.max(0.05, Math.min(0.95, p.fnY + (Math.random() - 0.5) * 0.3));
        sendTo(p.ws, { type: 'hunter_caught_you', stunMs: HUNTER_STUN_MS, x: p.fnX, y: p.fnY });
        broadcast(room, { type: 'hunter_catch', hunterId: hunter.id, playerId: p.id, playerName: p.name });
      }
    }
  }
  broadcast(room, { type: 'hunters_update', hunters: room.hunters.map((h) => ({ id: h.id, x: h.x, y: h.y })) });
}

function endRound(room) {
  room.state = 'finished';
  clearInterval(room.tickTimer);
  clearTimeout(room.spawnTimer);
  clearTimeout(room.chaosBoxSpawnTimer);
  clearTimeout(room.chaosBoxTimer);
  clearTimeout(room.teamComboDecayTimer);
  clearTimeout(room.bossAttackTimer);
  clearTimeout(room.bossDownRecoverTimer);
  clearTimeout(room.bossMoveTimer);
  clearTimeout(room.hunterTimer);
  if (room.boss) {
    for (const p of Object.values(room.boss.parts)) clearTimeout(p.simulWindowTimer);
  }
  room.flies.clear();
  room.chaosBox = null;
  room.hunters = [];
  room.kingFlySpawned = false;

  let huntWinner; // 'fly' | 'human' | undefined
  if (room.mode === 'hunt') {
    const flies = Array.from(room.players.values()).filter((p) => p.role === 'fly');
    const allCaught = flies.length > 0 && flies.every((p) => p.caught);
    huntWinner = allCaught ? 'human' : 'fly';
    // 生存ボーナス・討伐ボーナスをスコアに反映
    for (const p of room.players.values()) {
      if (p.role === 'fly' && !p.caught) p.score += 20; // 逃げ切りボーナス
    }
  }

  broadcast(room, {
    type: 'round_end',
    players: publicPlayerList(room),
    bossDefeated: (room.mode === 'raid' || room.mode === 'giant') ? !!(room.boss && room.boss.hp <= 0) : undefined,
    teamScore: room.mode === 'team' ? room.teamScore : undefined,
    teamWinner: room.mode === 'team' ? (room.teamScore.red === room.teamScore.blue ? null : (room.teamScore.red > room.teamScore.blue ? 'red' : 'blue')) : undefined,
    huntWinner,
  });
}

function flyNightPersonalStats(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return null;
  return { kills: p.fnKills, perfects: p.fnPerfects, maxCombo: p.fnMaxCombo, golden: p.fnGolden, misses: p.fnMisses };
}

// ==================== 人間狩りモード（hunt）====================
// 少人数がハエ役になり、マウスでハエキャラを操作してフィールド上を逃げ回る。
// 残りの人間役プレイヤーは通常のカーソル操作で近づき「捕獲」を狙う。
// 制限時間内にハエが1匹でも生き残っていればハエ側の勝ち、
// 全員捕まれば人間側の勝ち（サーバー権威で捕獲判定を行う）。

// ハエ役自身が自分のハエキャラを動かす
function handleHuntMove(room, playerId, x, y) {
  if (room.state !== 'playing' || room.mode !== 'hunt') return;
  const player = room.players.get(playerId);
  if (!player || player.role !== 'fly' || player.caught) return;
  const nx = Math.max(0, Math.min(1, Number(x)));
  const ny = Math.max(0, Math.min(1, Number(y)));
  if (Number.isNaN(nx) || Number.isNaN(ny)) return;
  player.huntX = nx;
  player.huntY = ny;
  broadcast(room, { type: 'hunt_fly_move', flyId: player.id, x: nx, y: ny });
}

// 人間役が自分のカーソル位置で「捕獲」を試みる（一定距離内のハエを判定）
function handleHuntCatchAttempt(room, playerId, x, y) {
  if (room.state !== 'playing' || room.mode !== 'hunt') return;
  const hunter = room.players.get(playerId);
  if (!hunter || hunter.role !== 'human') return;
  const now = Date.now();
  if (now - hunter.lastCatchAttemptAt < HUNT_CATCH_COOLDOWN_MS) return;
  hunter.lastCatchAttemptAt = now;

  const hx = Number(x), hy = Number(y);
  if (Number.isNaN(hx) || Number.isNaN(hy)) return;

  for (const fly of room.players.values()) {
    if (fly.role !== 'fly' || fly.caught) continue;
    const dx = fly.huntX - hx, dy = fly.huntY - hy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= HUNT_CATCH_RADIUS) {
      fly.caught = true;
      hunter.score += 15;
      broadcast(room, { type: 'hunt_caught', flyId: fly.id, flyName: fly.name, byId: hunter.id, byName: hunter.name });
      broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });
      return; // 1回の捕獲判定で捕まえられるのは1匹まで
    }
  }
}

// ---- クリック（ハエを叩く）判定：サーバー権威 ----
// ---- FLY NIGHT専用の当たり判定：PERFECT判定・コンボ倍率・KING FLY段階スコア ----
function handleFlyNightHit(room, playerId, flyId, perfect) {
  if (room.state !== 'playing') return;
  const player = room.players.get(playerId);
  if (!player) return;
  const fly = room.flies.get(flyId);
  if (!fly) return; // 既に取られた／消滅済み → 空振り扱いにはしない（連打対策）

  if (fly.type === 'king') {
    // KING FLYはHPがあり、複数人が同時に叩ける。命中順を記録して段階スコアへ
    fly.hp -= 1;
    room.kingFlyRankings.push(playerId);
    broadcast(room, { type: 'king_fly_hit', flyId: fly.id, hp: Math.max(0, fly.hp), by: playerId, byName: player.name });
    if (fly.hp <= 0) {
      fly.claimed = true;
      room.flies.delete(fly.id);
      const uniqueOrder = [...new Set(room.kingFlyRankings)];
      uniqueOrder.slice(0, KING_FLY_RANK_POINTS.length).forEach((pid, i) => {
        const p = room.players.get(pid);
        if (p) {
          p.score += KING_FLY_RANK_POINTS[i];
          p.fnKills += 1;
        }
      });
      broadcast(room, {
        type: 'king_fly_defeated',
        ranking: uniqueOrder.slice(0, KING_FLY_RANK_POINTS.length).map((pid, i) => ({
          playerId: pid,
          name: room.players.get(pid) ? room.players.get(pid).name : '?',
          points: KING_FLY_RANK_POINTS[i],
          rank: i + 1,
        })),
      });
      broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });
    }
    return;
  }

  if (fly.claimed) return;
  fly.claimed = true;
  room.flies.delete(fly.id);

  const def = FLY_NIGHT_TYPES[fly.type];
  const combo = player.combo || 1;
  const mult = comboMultiplierFor(combo);
  const perfectBonus = perfect ? 1.5 : 1;
  const gained = Math.round(fly.points * mult * perfectBonus);
  player.score += gained;
  player.combo = combo + 1;
  player.fnKills += 1;
  player.fnMaxCombo = Math.max(player.fnMaxCombo, player.combo);
  if (perfect) player.fnPerfects += 1;
  if (fly.type === 'golden') player.fnGolden += 1;

  broadcast(room, {
    type: 'fly_result', id: fly.id, by: playerId, result: 'hit', flyType: fly.type, gained, score: player.score,
    perfect: !!perfect, combo: player.combo, comboMult: mult,
  });
  broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });

  // ゾンビフライを倒すと周囲に小型ハエ(normal)を複数放出
  if (def && def.spawnsOnDeath) {
    for (let i = 0; i < def.spawnsOnDeath; i++) {
      setTimeout(() => {
        if (room.state !== 'playing') return;
        const spread = {
          id: genId('fly'), type: 'normal', points: FLY_NIGHT_TYPES.normal.points,
          x: Math.max(0, Math.min(1, fly.x + (Math.random() - 0.5) * 0.15)),
          y: Math.max(0, Math.min(1, fly.y + (Math.random() - 0.5) * 0.15)),
          bornAt: Date.now(), ttl: 1600, claimed: false,
        };
        room.flies.set(spread.id, spread);
        broadcast(room, { type: 'fly_spawn', fly: { id: spread.id, type: spread.type, x: spread.x, y: spread.y } });
        setTimeout(() => {
          if (room.state !== 'playing') return;
          const st = room.flies.get(spread.id);
          if (st && !st.claimed) { room.flies.delete(spread.id); broadcast(room, { type: 'fly_expire', id: spread.id }); }
        }, spread.ttl);
      }, i * 90);
    }
  }
}

function handleFlyNightMiss(room, playerId) {
  if (room.state !== 'playing' || room.mode !== 'fly_night') return;
  const player = room.players.get(playerId);
  if (!player) return;
  player.combo = 1;
  player.fnMisses += 1;
  broadcast(room, { type: 'scoreboard', players: publicPlayerList(room) });
}

function handleFlyNightMove(room, playerId, x, y) {
  if (room.state !== 'playing' || room.mode !== 'fly_night') return;
  const player = room.players.get(playerId);
  if (!player) return;
  const nx = Math.max(0, Math.min(1, Number(x)));
  const ny = Math.max(0, Math.min(1, Number(y)));
  if (Number.isNaN(nx) || Number.isNaN(ny)) return;
  player.fnX = nx;
  player.fnY = ny;
}

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
    if (room.mode === 'chaos') progressMission(room, player, 'decoy', fly.type);
  } else {
    const gained = fly.points * player.combo;
    player.score += gained;
    player.combo = Math.min(8, player.combo + 1);
    broadcast(room, { type: 'fly_result', id: fly.id, by: playerId, result: 'hit', flyType: fly.type, gained, score: player.score });
    if (room.mode === 'chaos') {
      progressMission(room, player, 'hit', fly.type);
      bumpTeamCombo(room);
    }
    if (room.mode === 'team' && player.team && gained > 0) {
      room.teamScore[player.team] += gained;
      broadcast(room, { type: 'team_score', teamScore: room.teamScore });
    }
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
      const room = createRoom(playerId, msg.name, msg.mode, { teamSize: msg.teamSize });
      roomCode = room.code;
      room.players.get(playerId).ws = ws;
      sendTo(ws, { type: 'joined', playerId, roomCode: room.code, isHost: true, mode: room.mode, teamSize: room.teamSize, team: room.players.get(playerId).team });
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
      const capacity = room.mode === 'team' ? room.teamSize * 2 : MAX_PLAYERS;
      if (room.players.size >= capacity) {
        sendTo(ws, { type: 'error', message: room.mode === 'team' ? 'チームが満員です' : 'ルームが満員です（最大20人）' });
        return;
      }
      playerId = genId('p');
      roomCode = room.code;
      const player = makePlayer(playerId, msg.name, room);
      player.ws = ws;
      room.players.set(playerId, player);
      sendTo(ws, { type: 'joined', playerId, roomCode: room.code, isHost: false, mode: room.mode, teamSize: room.teamSize, team: player.team });
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
      if (room.mode === 'fly_night') {
        handleFlyNightHit(room, playerId, msg.flyId, !!msg.perfect);
      } else {
        handleHit(room, playerId, msg.flyId);
      }
      return;
    }

    if (msg.type === 'fn_move') {
      handleFlyNightMove(room, playerId, msg.x, msg.y);
      // 人間狩りモードと同様に他プレイヤーへ自分の位置を共有（ハンターの脅威を感じられるように）
      const player = room.players.get(playerId);
      if (player && room.mode === 'fly_night' && room.state === 'playing') {
        broadcast(room, { type: 'fn_player_move', playerId, x: player.fnX, y: player.fnY });
      }
      return;
    }

    if (msg.type === 'hit_boss') {
      handleBossHit(room, playerId, msg.targetPart);
      return;
    }

    if (msg.type === 'hit_chaos_box') {
      handleChaosBoxClick(room, playerId, msg.boxId);
      return;
    }

    if (msg.type === 'hunt_move') {
      handleHuntMove(room, playerId, msg.x, msg.y);
      return;
    }

    if (msg.type === 'hunt_catch_attempt') {
      handleHuntCatchAttempt(room, playerId, msg.x, msg.y);
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
      if (room.mode === 'fly_night') {
        handleFlyNightMiss(room, playerId);
        return;
      }
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
