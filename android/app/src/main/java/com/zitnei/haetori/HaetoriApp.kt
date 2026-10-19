package com.zitnei.haetori

import android.os.SystemClock
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 最初のメニューで選ぶ遊び方 */
enum class AppRoute { HOME, SOLO, MULTI, SETTINGS }

/** スマホ専用の画面。指で押しやすいように、ボタンも文字も大きめにしている */
@Composable
fun HaetoriApp(vm: GameViewModel, vibrate: (Long) -> Unit) {
    var route by remember { mutableStateOf(AppRoute.HOME) }
    val context = LocalContext.current
    val prefs = remember { AppPrefs(context) }

    // 設定した接続先をマルチプレイでも使う
    LaunchedEffect(prefs.serverUrl) { vm.serverUrl = prefs.serverUrl }

    Box(
        Modifier
            .fillMaxSize()
            .background(Sky)
            .safeDrawingPadding(),
    ) {
        when (route) {
            AppRoute.HOME -> HomeScreen(
                prefs = prefs,
                onSolo = { route = AppRoute.SOLO },
                onMulti = { route = AppRoute.MULTI },
                onSettings = { route = AppRoute.SETTINGS },
            )
            AppRoute.SETTINGS -> SettingsScreen(prefs, onBack = { route = AppRoute.HOME })
            AppRoute.SOLO -> SoloScreen(prefs, onBack = { route = AppRoute.HOME }, vibrate = vibrate)
            AppRoute.MULTI -> when (vm.screen) {
                Screen.LOBBY -> LobbyScreen(vm, onBack = { route = AppRoute.HOME })
                Screen.WAITING -> WaitingScreen(vm)
                Screen.PLAYING -> PlayScreen(vm, vibrate, prefs.skin)
                Screen.RESULT -> ResultScreen(vm)
            }
        }
    }
}

/** 設定画面：難易度とサーバーの接続先 */
@Composable
private fun SettingsScreen(prefs: AppPrefs, onBack: () -> Unit) {
    var url by remember { mutableStateOf(prefs.serverUrl) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TextButton(onClick = onBack) { Text("← メニュー", color = Ink.copy(alpha = 0.75f), fontSize = 15.sp) }
        Text("⚙ 設定", fontSize = 26.sp, fontWeight = FontWeight.Black, color = Ink)

        Panel {
            Text("難易度", fontSize = 16.sp, fontWeight = FontWeight.Black, color = Ink)
            Text(
                "ソロプレイのハエの速さと出てくる間隔が変わります。難しいほどもらえるコインが増えます。",
                fontSize = 11.sp, color = Ink.copy(alpha = 0.65f),
            )
            Spacer(Modifier.height(8.dp))
            Difficulty.entries.forEach { d ->
                val selected = d == prefs.difficulty
                Button(
                    onClick = { prefs.chooseDifficulty(d) },
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (selected) Accent else Sky,
                        contentColor = Ink,
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 3.dp)
                        .heightIn(min = 58.dp),
                ) {
                    Column(Modifier.fillMaxWidth()) {
                        Text(
                            (if (selected) "✓ " else "") + d.label + "（×${d.speed}）",
                            fontSize = 15.sp, fontWeight = FontWeight.Black,
                        )
                        Text(d.desc, fontSize = 10.sp, color = Ink.copy(alpha = 0.65f))
                    }
                }
            }
        }

        Panel {
            Text("コイン", fontSize = 16.sp, fontWeight = FontWeight.Black, color = Ink)
            Text("🪙 ${prefs.coins}", fontSize = 24.sp, fontWeight = FontWeight.Black, color = Ink)
            Text(
                "スキンはソロプレイの「ショップ」で交換できます（今：${prefs.skin.name}）",
                fontSize = 11.sp, color = Ink.copy(alpha = 0.65f),
            )
        }

        Panel {
            Text("マルチプレイの接続先", fontSize = 16.sp, fontWeight = FontWeight.Black, color = Ink)
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("サーバー") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            BigButton("保存", color = SkyDeep) { prefs.saveServerUrl(url.trim()) }
            Spacer(Modifier.height(6.dp))
            Text(
                "ふだんは変更不要です。手元のPCでサーバーを試すときは ws://（PCのIPアドレス）:8080 を入れてください。",
                fontSize = 11.sp, color = Ink.copy(alpha = 0.6f),
            )
        }
    }
}

/** 最初の画面：ソロプレイかマルチプレイかを選ぶ */
@Composable
private fun HomeScreen(prefs: AppPrefs, onSolo: () -> Unit, onMulti: () -> Unit, onSettings: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(20.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("🪰", fontSize = 64.sp)
        Text("スーパー・ハエ取り", fontSize = 28.sp, fontWeight = FontWeight.Black, color = Ink)
        Spacer(Modifier.height(6.dp))
        Text(
            "遊び方をえらんでください",
            fontSize = 14.sp, color = Ink.copy(alpha = 0.7f),
        )
        Spacer(Modifier.height(28.dp))

        MenuCard(
            emoji = "🎯",
            title = "ソロプレイ",
            desc = "ひとりで35秒のスコアアタック。通信なしで遊べます",
            color = Accent,
            onClick = onSolo,
        )
        Spacer(Modifier.height(14.dp))
        MenuCard(
            emoji = "🎮",
            title = "マルチプレイ",
            desc = "PCの友達と同じ部屋で早取り対戦（最大20人）",
            color = SkyDeep,
            onClick = onMulti,
        )
        Spacer(Modifier.height(14.dp))
        MenuCard(
            emoji = "⚙",
            title = "設定",
            desc = "難易度：${prefs.difficulty.label}　🪙 ${prefs.coins}　スキン：${prefs.skin.name}",
            color = Color.White,
            onClick = onSettings,
        )
    }
}

@Composable
private fun MenuCard(emoji: String, title: String, desc: String, color: Color, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        shape = RoundedCornerShape(22.dp),
        colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = Ink),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 112.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text(emoji, fontSize = 38.sp)
            Spacer(Modifier.width(14.dp))
            Column {
                Text(title, fontSize = 22.sp, fontWeight = FontWeight.Black)
                Text(desc, fontSize = 12.sp, color = Ink.copy(alpha = 0.72f))
            }
        }
    }
}

// ==================== 共通パーツ ====================

@Composable
private fun BigButton(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = Accent,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(18.dp),
        colors = ButtonDefaults.buttonColors(containerColor = color, contentColor = Ink),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp),
    ) {
        Text(text, fontSize = 18.sp, fontWeight = FontWeight.Black, textAlign = TextAlign.Center)
    }
}

@Composable
private fun Panel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Card(
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = Card),
        modifier = modifier
            .fillMaxWidth()
            .border(2.dp, Line, RoundedCornerShape(20.dp)),
    ) {
        Column(Modifier.padding(16.dp)) { content() }
    }
}

@Composable
private fun NameField(vm: GameViewModel) {
    OutlinedTextField(
        value = vm.playerName,
        onValueChange = { vm.playerName = it.take(16) },
        label = { Text("あなたの名前") },
        singleLine = true,
        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 18.sp, fontWeight = FontWeight.Bold),
        modifier = Modifier.fillMaxWidth(),
    )
}

// ==================== ロビー ====================

@Composable
private fun LobbyScreen(vm: GameViewModel, onBack: () -> Unit) {
    var showCreate by remember { mutableStateOf(false) }
    var showJoin by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        TextButton(onClick = onBack, modifier = Modifier.padding(0.dp)) {
            Text("← メニュー", color = Ink.copy(alpha = 0.75f), fontSize = 15.sp)
        }
        Text("🎮 マルチプレイ", fontSize = 26.sp, fontWeight = FontWeight.Black, color = Ink)
        Text(
            "PCの友達と同じ部屋で遊べます（最大20人）",
            fontSize = 13.sp, color = Ink.copy(alpha = 0.7f),
        )

        Panel {
            NameField(vm)
            Spacer(Modifier.height(14.dp))
            BigButton(
                if (vm.connecting) "接続中…" else "⚡ 今すぐ参加する",
                enabled = !vm.connecting,
            ) { vm.quickJoin() }
            Spacer(Modifier.height(8.dp))
            Text(
                "空いている部屋に自動で入ります",
                fontSize = 12.sp, color = Ink.copy(alpha = 0.6f),
                modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center,
            )
        }

        Panel {
            BigButton("🔑 部屋コードで参加", color = SkyDeep) { showJoin = !showJoin }
            AnimatedVisibility(showJoin) {
                Column {
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = vm.roomCodeInput,
                        onValueChange = { vm.roomCodeInput = it.uppercase().take(6) },
                        label = { Text("部屋コード（例: AB12CD）") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                        textStyle = androidx.compose.ui.text.TextStyle(
                            fontSize = 24.sp, fontWeight = FontWeight.Black, letterSpacing = 4.sp,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(10.dp))
                    BigButton("参加する", enabled = vm.roomCodeInput.length >= 4) { vm.joinRoom() }
                }
            }
        }

        Panel {
            BigButton("🏠 部屋を作る", color = SkyDeep) { showCreate = !showCreate }
            AnimatedVisibility(showCreate) {
                Column {
                    Spacer(Modifier.height(10.dp))
                    ModeButton("🪰 フィールド協力", "みんなでハエを取ってスコアを稼ぐ") { vm.createRoom("coop") }
                    ModeButton("⚔️ チーム対戦", "赤チーム対青チームでスコアを競う") { vm.createRoom("team", teamSize = 3) }
                    ModeButton("🧠 FLY CHAOS PARTY", "ミッションとボーナスで盛り上がるモード") { vm.createRoom("chaos") }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "レイドボス・人間狩り・FLY NIGHT は演出が多いのでPC版（ブラウザ）で遊んでください。" +
                            "部屋に入ること自体はこのアプリでもできます。",
                        fontSize = 11.sp, color = Ink.copy(alpha = 0.6f),
                    )
                }
            }
        }

        Text(
            "接続先：${vm.serverUrl}（変えるときはメニューの「設定」から）",
            fontSize = 11.sp, color = Ink.copy(alpha = 0.55f),
        )

        vm.errorMessage?.let {
            Text(
                it, color = TeamRed, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun ModeButton(title: String, desc: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Sky, contentColor = Ink),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .heightIn(min = 64.dp),
    ) {
        Column(Modifier.fillMaxWidth()) {
            Text(title, fontSize = 16.sp, fontWeight = FontWeight.Black)
            Text(desc, fontSize = 11.sp, color = Ink.copy(alpha = 0.65f))
        }
    }
}

// ==================== 待機画面 ====================

@Composable
private fun WaitingScreen(vm: GameViewModel) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("部屋コード", fontSize = 13.sp, color = Ink.copy(alpha = 0.7f))
        Text(
            vm.roomCode,
            fontSize = 44.sp, fontWeight = FontWeight.Black, color = Ink, letterSpacing = 6.sp,
        )
        Text("この6文字を友達に教えてください", fontSize = 12.sp, color = Ink.copy(alpha = 0.6f))

        Panel {
            Text("参加中（${vm.players.size}人）", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Ink)
            Spacer(Modifier.height(8.dp))
            vm.players.forEach { p ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 4.dp)) {
                    Box(
                        Modifier
                            .size(14.dp)
                            .background(colorForPlayer(p.id, p.team), RoundedCornerShape(7.dp)),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        p.name + if (p.id == vm.myPlayerId) "（あなた）" else "",
                        fontSize = 16.sp, fontWeight = FontWeight.Bold, color = Ink,
                    )
                }
            }
        }

        if (vm.isHost) {
            BigButton("ゲーム開始") { vm.startRound() }
        } else {
            Text("ホストが始めるのを待っています…", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Ink)
        }
        TextButton(onClick = { vm.leaveRoom() }) { Text("退出する", color = Ink.copy(alpha = 0.7f)) }

        vm.errorMessage?.let { Text(it, color = TeamRed, fontSize = 13.sp) }
    }
}

// ==================== 結果 ====================

@Composable
private fun ResultScreen(vm: GameViewModel) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("🏁 結果発表", fontSize = 26.sp, fontWeight = FontWeight.Black, color = Ink)
        Panel {
            vm.finalPlayers.sortedByDescending { it.score }.forEachIndexed { i, p ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("${i + 1}.", fontSize = 18.sp, fontWeight = FontWeight.Black, color = Ink.copy(alpha = 0.5f))
                    Spacer(Modifier.width(8.dp))
                    Box(
                        Modifier
                            .size(14.dp)
                            .background(colorForPlayer(p.id, p.team), RoundedCornerShape(7.dp)),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        p.name + if (p.id == vm.myPlayerId) "（あなた）" else "",
                        fontSize = 17.sp,
                        fontWeight = if (p.id == vm.myPlayerId) FontWeight.Black else FontWeight.Bold,
                        color = Ink,
                        modifier = Modifier.weight(1f),
                    )
                    Text("${p.score}", fontSize = 20.sp, fontWeight = FontWeight.Black, color = Ink)
                }
            }
        }
        if (vm.isHost) BigButton("もう一度対戦") { vm.startRound() }
        else Text("ホストが再戦を押すのを待っています…", fontSize = 14.sp, color = Ink)
        TextButton(onClick = { vm.leaveRoom() }) { Text("部屋を出る", color = Ink.copy(alpha = 0.7f)) }
    }
}

// ==================== プレイ画面 ====================

@Composable
private fun PlayScreen(vm: GameViewModel, vibrate: (Long) -> Unit, skin: Skin) {
    Column(Modifier.fillMaxSize()) {
        HudRow(vm)
        FlyField(
            vm = vm,
            vibrate = vibrate,
            skin = skin,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 8.dp),
        )
        MiniScoreboard(vm)
    }
}

@Composable
private fun HudRow(vm: GameViewModel) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        HudCell("のこり", "${vm.timeLeft}秒", Modifier.weight(1f))
        HudCell("スコア", "${vm.myScore}", Modifier.weight(1f))
        HudCell("ライフ", "❤".repeat(vm.myLives.coerceAtLeast(0)).ifEmpty { "—" }, Modifier.weight(1f))
    }
}

@Composable
private fun HudCell(label: String, value: String, modifier: Modifier = Modifier) {
    Card(
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = Card),
        modifier = modifier.border(2.dp, Line, RoundedCornerShape(14.dp)),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(label, fontSize = 11.sp, color = Ink.copy(alpha = 0.6f))
            Text(value, fontSize = 20.sp, fontWeight = FontWeight.Black, color = Ink, maxLines = 1)
        }
    }
}

@Composable
private fun MiniScoreboard(vm: GameViewModel) {
    val top = vm.players.sortedByDescending { it.score }.take(3)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        top.forEachIndexed { i, p ->
            Card(
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = Card),
                modifier = Modifier
                    .weight(1f)
                    .border(2.dp, if (p.id == vm.myPlayerId) Accent else Line, RoundedCornerShape(12.dp)),
            ) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        "${i + 1}. ${p.name}",
                        fontSize = 11.sp, color = Ink, maxLines = 1, fontWeight = FontWeight.Bold,
                    )
                    Text("${p.score}", fontSize = 16.sp, fontWeight = FontWeight.Black, color = Ink)
                }
            }
        }
    }
}

/** 「+3」などの得点表示を出す時間 */
const val GAIN_POPUP_MS = 700L

/** 今の時刻（アニメーション用） */
fun nowMs(): Long = SystemClock.uptimeMillis()
