package com.zitnei.haetori

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** ソロプレイ。最初に「スタート」と「ショップ」を選べる */
@Composable
fun SoloScreen(prefs: AppPrefs, onBack: () -> Unit, vibrate: (Long) -> Unit) {
    val game = remember { SoloGame() }
    val density = LocalDensity.current
    val flySizePx = with(density) { 64.dp.toPx() }
    var showShop by remember { mutableStateOf(false) }

    var frame by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        while (true) {
            withFrameMillis { frame = nowMs() }
            game.tick(nowMs(), prefs)
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SoloCell("のこり", "${game.timeLeft}秒", Modifier.weight(1f))
            SoloCell("スコア", "${game.score}", Modifier.weight(1f))
            SoloCell("コンボ", "×${game.combo}", Modifier.weight(1f))
            SoloCell("ライフ", "❤".repeat(game.lives.coerceAtLeast(0)).ifEmpty { "—" }, Modifier.weight(1f))
        }

        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 8.dp)
                .border(3.dp, Line, RoundedCornerShape(20.dp))
                .pointerInput(Unit) {
                    detectTapGestures { pos ->
                        if (!game.running) return@detectTapGestures
                        val w = size.width.toFloat()
                        val h = size.height.toFloat()
                        if (w <= 0f || h <= 0f) return@detectTapGestures
                        val hit = nearestFly(game.flies, pos, w, h, flySizePx)
                        val wasDecoy = hit?.type == "decoy"
                        game.tapAt(hit)
                        if (hit != null) vibrate(if (wasDecoy) 60L else 18L)
                    }
                },
        ) {
            Canvas(Modifier.fillMaxSize()) {
                drawFieldBackground()
                game.flies.toList().forEach { fly ->
                    drawFly(fly, flyCenter(fly, size.width, size.height, flySizePx), flySizePx, frame, prefs.skin)
                }
            }

            game.toast?.let { (text, _) ->
                Text(
                    text,
                    fontSize = 22.sp, fontWeight = FontWeight.Black, color = Ink,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 24.dp),
                )
            }

            if (!game.running) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Color.White.copy(alpha = 0.9f)),
                    contentAlignment = Alignment.Center,
                ) {
                    if (showShop) {
                        SkinShop(prefs, frame) { showShop = false }
                    } else {
                        SoloStartPanel(
                            game = game,
                            prefs = prefs,
                            onStart = { game.start(prefs.difficulty) },
                            onShop = { showShop = true },
                        )
                    }
                }
            }
        }

        TextButton(
            onClick = { game.quit(); onBack() },
            modifier = Modifier
                .align(Alignment.CenterHorizontally)
                .padding(bottom = 6.dp),
        ) {
            Text("← メニューに戻る", color = Ink.copy(alpha = 0.75f), fontSize = 15.sp)
        }
    }
}

/** タップした場所に一番近いハエを返す（指の太さを考えて少し広めに判定） */
internal fun nearestFly(flies: List<Fly>, pos: Offset, w: Float, h: Float, flySizePx: Float): Fly? {
    val radius = flySizePx * 0.62f
    var hit: Fly? = null
    var best = Float.MAX_VALUE
    for (f in flies) {
        val d = (flyCenter(f, w, h, flySizePx) - pos).getDistance()
        if (d < radius && d < best) {
            best = d
            hit = f
        }
    }
    return hit
}

@Composable
private fun SoloStartPanel(game: SoloGame, prefs: AppPrefs, onStart: () -> Unit, onShop: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        if (game.finished) {
            Text("おしまい！", fontSize = 30.sp, fontWeight = FontWeight.Black, color = Ink)
            Spacer(Modifier.height(4.dp))
            Text("スコア ${game.score}", fontSize = 26.sp, fontWeight = FontWeight.Black, color = Ink)
            Text("🪙 コイン +${game.lastCoins}", fontSize = 18.sp, fontWeight = FontWeight.Black, color = Color(0xFFCF9A12))
            Text("自己ベスト ${prefs.bestScore}", fontSize = 14.sp, color = Ink.copy(alpha = 0.7f))
        } else {
            Text("🎯 ソロプレイ", fontSize = 26.sp, fontWeight = FontWeight.Black, color = Ink)
            Spacer(Modifier.height(4.dp))
            Text(
                "35秒間でハエをタップ！\nニセモノ（灰色のハエ）を取るとライフが減ります",
                fontSize = 13.sp, color = Ink.copy(alpha = 0.75f), textAlign = TextAlign.Center,
            )
            if (prefs.bestScore > 0) {
                Text("自己ベスト ${prefs.bestScore}", fontSize = 14.sp, color = Ink.copy(alpha = 0.7f))
            }
        }

        Spacer(Modifier.height(10.dp))
        Text(
            "難易度：${prefs.difficulty.label}（×${prefs.difficulty.speed}）　🪙 ${prefs.coins}　スキン：${prefs.skin.name}",
            fontSize = 12.sp, color = Ink.copy(alpha = 0.7f), textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(16.dp))

        Button(
            onClick = onStart,
            shape = RoundedCornerShape(18.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Ink),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 64.dp),
        ) {
            Text(
                if (game.finished) "もう一度" else "▶ スタート",
                fontSize = 20.sp, fontWeight = FontWeight.Black,
            )
        }
        Spacer(Modifier.height(10.dp))
        Button(
            onClick = onShop,
            shape = RoundedCornerShape(18.dp),
            colors = ButtonDefaults.buttonColors(containerColor = SkyDeep, contentColor = Ink),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 60.dp),
        ) {
            Text("🛍 ショップ（スキン交換）", fontSize = 17.sp, fontWeight = FontWeight.Black)
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "コインはソロプレイを最後まで遊ぶともらえます（難しい設定ほど多い）",
            fontSize = 11.sp, color = Ink.copy(alpha = 0.6f), textAlign = TextAlign.Center,
        )
    }
}

/** スキンのお店。コインと交換して、持っているスキンから選べる */
@Composable
private fun SkinShop(prefs: AppPrefs, frame: Long, onClose: () -> Unit) {
    var message by remember { mutableStateOf<String?>(null) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("🛍 スキンショップ", fontSize = 22.sp, fontWeight = FontWeight.Black, color = Ink)
        Text("🪙 持っているコイン：${prefs.coins}", fontSize = 15.sp, fontWeight = FontWeight.Black, color = Color(0xFFCF9A12))
        message?.let {
            Text(it, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = TeamRed)
        }
        Spacer(Modifier.height(10.dp))

        Skins.all.forEach { skin ->
            val owned = skin.id in prefs.ownedSkins
            val selected = skin.id == prefs.selectedSkin
            Card(
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Card),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 5.dp)
                    .border(if (selected) 3.dp else 2.dp, if (selected) Accent else Line, RoundedCornerShape(16.dp)),
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SkinPreview(skin, frame)
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(skin.name, fontSize = 16.sp, fontWeight = FontWeight.Black, color = Ink)
                        Text(skin.desc, fontSize = 11.sp, color = Ink.copy(alpha = 0.65f))
                        Text(
                            if (skin.price == 0) "さいしょから持っている" else "🪙 ${skin.price}",
                            fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Ink.copy(alpha = 0.8f),
                        )
                    }
                    Button(
                        onClick = {
                            if (owned) {
                                prefs.selectSkin(skin.id)
                                message = "${skin.name} に変えました"
                            } else if (prefs.buySkin(skin)) {
                                prefs.selectSkin(skin.id)
                                message = "${skin.name} を買いました！"
                            } else {
                                message = "コインが ${skin.price - prefs.coins} 足りません"
                            }
                        },
                        enabled = !selected,
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (owned) SkyDeep else Accent,
                            contentColor = Ink,
                        ),
                    ) {
                        Text(
                            when {
                                selected -> "使用中"
                                owned -> "つかう"
                                else -> "交換"
                            },
                            fontSize = 14.sp, fontWeight = FontWeight.Black,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        Button(
            onClick = onClose,
            shape = RoundedCornerShape(18.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Accent, contentColor = Ink),
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp),
        ) {
            Text("閉じる", fontSize = 17.sp, fontWeight = FontWeight.Black)
        }
    }
}

/** ショップに並べるスキンの見本 */
@Composable
private fun SkinPreview(skin: Skin, frame: Long) {
    val density = LocalDensity.current
    Box(Modifier.size(54.dp)) {
        Canvas(Modifier.fillMaxSize()) {
            val px = with(density) { 46.dp.toPx() }
            drawFly(
                Fly("preview_${skin.id}", "normal", 0f, 0f),
                Offset(size.width / 2, size.height / 2),
                px,
                frame,
                skin,
            )
        }
    }
}

@Composable
private fun SoloCell(label: String, value: String, modifier: Modifier = Modifier) {
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
            Text(label, fontSize = 10.sp, color = Ink.copy(alpha = 0.6f))
            Text(value, fontSize = 17.sp, fontWeight = FontWeight.Black, color = Ink, maxLines = 1)
        }
    }
}
