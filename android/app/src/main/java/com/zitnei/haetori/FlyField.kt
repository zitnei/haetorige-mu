package com.zitnei.haetori

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlin.math.sin

/**
 * ハエが飛ぶフィールド。
 * 位置は 0〜1 の割合でサーバーから届くので、画面の大きさが違うPCとスマホでも同じ場所に出る。
 */
@Composable
fun FlyField(vm: GameViewModel, vibrate: (Long) -> Unit, skin: Skin = Skins.byId(null), modifier: Modifier = Modifier) {
    val textMeasurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val flySizePx = with(density) { 64.dp.toPx() }

    // 毎フレーム進む時計。羽ばたきやタップ表示のアニメーションに使う
    var frame by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        while (true) {
            withFrameMillis { frame = nowMs() }
            vm.pruneTapMarks(nowMs())
        }
    }

    // タップ判定で使う最新の状態
    val fliesState = rememberUpdatedState(vm.flies.values.toList())
    var lastDecoyHandled by remember { mutableStateOf(0L) }

    // ニセモノを取ったら短く振動させる
    LaunchedEffect(vm.decoyFlash) {
        if (vm.decoyFlash != 0L && vm.decoyFlash != lastDecoyHandled) {
            lastDecoyHandled = vm.decoyFlash
            vibrate(60L)
        }
    }

    Box(
        modifier
            .border(3.dp, Line, RoundedCornerShape(20.dp))
            .pointerInput(Unit) {
                detectTapGestures { pos ->
                    val w = size.width.toFloat()
                    val h = size.height.toFloat()
                    if (w <= 0f || h <= 0f) return@detectTapGestures
                    val xPct = (pos.x / w).coerceIn(0f, 1f)
                    val yPct = (pos.y / h).coerceIn(0f, 1f)

                    // タップした場所に自分の名前と色を出し、全員にも知らせる
                    vm.sendTap(xPct, yPct)

                    // 一番近いハエを探す（指の太さを考えて少し広めに判定）
                    val radius = flySizePx * 0.62f
                    var hit: Fly? = null
                    var best = Float.MAX_VALUE
                    for (f in fliesState.value) {
                        val c = flyCenter(f, w, h, flySizePx)
                        val d = (c - pos).getDistance()
                        if (d < radius && d < best) {
                            best = d
                            hit = f
                        }
                    }
                    if (hit != null) {
                        vm.hitFly(hit.id)
                        vibrate(18L)
                    } else {
                        vm.missClick()
                    }
                }
            },
    ) {
        Canvas(Modifier.fillMaxSize()) {
            drawFieldBackground()
            fliesState.value.forEach { fly ->
                drawFly(fly, flyCenter(fly, size.width, size.height, flySizePx), flySizePx, frame, skin)
            }
            vm.tapMarks.toList().forEach { mark ->
                drawTapMark(mark, textMeasurer, frame, density.density)
            }
        }
    }
}

/** Web版はハエの左上を x,y に置くので、同じ見え方になるよう半分ずらして中心を求める */
internal fun flyCenter(fly: Fly, w: Float, h: Float, flySize: Float): Offset {
    val half = flySize / 2f
    return Offset(
        (fly.x * w + half).coerceIn(half, (w - half).coerceAtLeast(half)),
        (fly.y * h + half).coerceIn(half, (h - half).coerceAtLeast(half)),
    )
}

/** 空と草のフィールド（Web版と同じ配色） */
internal fun DrawScope.drawFieldBackground() {
    drawRect(
        brush = Brush.verticalGradient(
            0f to Sky,
            0.64f to Color(0xFFDFF7FF),
            0.6401f to Grass,
            1f to Grass,
        ),
        size = size,
    )
    // 雲
    drawCircle(Color.White.copy(alpha = 0.9f), size.minDimension * 0.07f, Offset(size.width * 0.14f, size.height * 0.12f))
    drawCircle(Color.White.copy(alpha = 0.8f), size.minDimension * 0.05f, Offset(size.width * 0.72f, size.height * 0.2f))
}

/**
 * ハエ1匹。Web版のSVGと同じ形（胴・目・羽）を描く。
 * スキンはふつうのハエにだけ反映する（きんのハエやニセモノは見分けがつかなくなるため）。
 */
internal fun DrawScope.drawFly(
    fly: Fly,
    center: Offset,
    flySize: Float,
    frame: Long,
    skin: Skin = Skins.byId(null),
) {
    val skinned = fly.type == "normal" || fly.type == "speed"
    val s = flySize / 100f * when (fly.type) {
        "golden" -> 0.92f
        "decoy" -> 0.86f
        "speed" -> 0.8f
        "zombie" -> 1.1f
        else -> 1f
    }
    val body = when {
        skinned && skin.rainbow -> rainbowColor(frame)
        skinned -> skin.body
        fly.type == "golden" -> Color(0xFFE2B33C)
        fly.type == "decoy" -> Color(0xFF9AA0A4)
        fly.type == "ice" -> Color(0xFF5FA8C9)
        fly.type == "bomb" -> Color(0xFF9C4A3C)
        else -> Color(0xFF6B4A35)
    }
    val wing = when {
        skinned -> skin.wing
        fly.type == "golden" -> Color(0xFFFFF0B8)
        fly.type == "ice" -> Color(0xFFD6F4FF)
        else -> Color(0xFFBFE8F5)
    }
    // 羽ばたき（上下に少し伸び縮みさせる）
    val flap = 0.75f + 0.25f * abs(sin((frame + fly.id.hashCode() % 500) / 90f))

    fun p(x: Float, y: Float) = Offset(center.x + (x - 50f) * s, center.y + (y - 50f) * s)

    // 光るタイプは後光を付ける
    when (fly.type) {
        "golden" -> drawCircle(Color(0x66FFD700), 34f * s, center)
        "ice" -> drawCircle(Color(0x556FD8FF), 32f * s, center)
        "bomb" -> drawCircle(Color(0x55FF5A5A), 32f * s, center)
    }

    // 羽（左右）
    rotate(-20f, p(25f, 45f)) {
        drawOval(wing.copy(alpha = 0.85f), topLeft = p(7f, 45f - 10f * flap), size = Size(36f * s, 20f * s * flap))
    }
    rotate(20f, p(75f, 45f)) {
        drawOval(wing.copy(alpha = 0.85f), topLeft = p(57f, 45f - 10f * flap), size = Size(36f * s, 20f * s * flap))
    }
    // 胴体
    drawOval(body, topLeft = p(28f, 27f), size = Size(44f * s, 56f * s))
    // 目
    drawCircle(body, 12f * s, p(38f, 30f))
    drawCircle(body, 12f * s, p(62f, 30f))
    drawCircle(Color.White, 4f * s, p(33f, 27f))
    drawCircle(Color.White, 4f * s, p(67f, 27f))
    drawCircle(Color(0xFF111111), 2f * s, p(33f, 27f))
    drawCircle(Color(0xFF111111), 2f * s, p(67f, 27f))

    // ニセモノは×印を薄く出して見分けられるように
    if (fly.type == "decoy") {
        drawCircle(Color(0x33000000), 30f * s, center)
    }

    if (skinned) drawAccessory(skin, body, s) { x, y -> p(x, y) }
}

/** スキンの飾り（耳・角・アンテナ・王冠）を頭の上に描く */
private fun DrawScope.drawAccessory(skin: Skin, body: Color, s: Float, p: (Float, Float) -> Offset) {
    when (skin.accessory) {
        Accessory.EARS -> {
            drawCircle(body, 7f * s, p(28f, 14f))
            drawCircle(body, 7f * s, p(72f, 14f))
            drawCircle(Color(0xFFFFD6E4), 4f * s, p(28f, 15f))
            drawCircle(Color(0xFFFFD6E4), 4f * s, p(72f, 15f))
        }
        Accessory.HORN -> {
            drawCircle(Color.White.copy(alpha = 0.9f), 6f * s, p(50f, 10f))
        }
        Accessory.ANTENNA -> {
            drawLine(body, p(50f, 18f), p(50f, 2f), strokeWidth = 3f * s)
            drawCircle(Color(0xFFFF6A6A), 5f * s, p(50f, 2f))
        }
        Accessory.CROWN -> {
            val gold = Color(0xFFFFC93C)
            drawRect(gold, topLeft = p(36f, 8f), size = Size(28f * s, 7f * s))
            drawCircle(gold, 4f * s, p(38f, 4f))
            drawCircle(gold, 4f * s, p(50f, 1f))
            drawCircle(gold, 4f * s, p(62f, 4f))
        }
        null -> Unit
    }
}

/** にじいろスキン用。時間で色が変わる */
internal fun rainbowColor(frame: Long): Color {
    val t = (frame % 3000L) / 3000f
    val hue = t * 360f
    return Color.hsv(hue, 0.65f, 0.95f)
}

/** タップした場所に出す「輪＋名前」 */
internal fun DrawScope.drawTapMark(mark: TapMark, textMeasurer: TextMeasurer, frame: Long, density: Float) {
    val age = (frame - mark.bornAt).coerceAtLeast(0L).toFloat()
    val life = (age / GameViewModel.TAP_MARK_MS).coerceIn(0f, 1f)
    val alpha = if (life < 0.65f) 1f else 1f - (life - 0.65f) / 0.35f
    val color = colorForPlayer(mark.playerId, mark.team)
    val center = Offset(mark.x * size.width, mark.y * size.height)

    // 広がる輪
    val ringLife = (age / 500f).coerceIn(0f, 1f)
    if (ringLife < 1f) {
        drawCircle(
            color.copy(alpha = (1f - ringLife) * alpha),
            radius = (14f + 24f * ringLife) * density,
            center = center,
            style = androidx.compose.ui.graphics.drawscope.Stroke(width = 4f * density),
        )
    }

    // 名前の札
    val label = (if (mark.team == "red") "🔴 " else if (mark.team == "blue") "🔵 " else "") +
        mark.name + if (mark.mine) "（自分）" else ""
    val measured = textMeasurer.measure(
        label,
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black, color = Color.White),
    )
    val padX = 8f * density
    val padY = 4f * density
    val boxW = measured.size.width + padX * 2
    val boxH = measured.size.height + padY * 2
    val boxLeft = (center.x - boxW / 2).coerceIn(0f, (size.width - boxW).coerceAtLeast(0f))
    val boxTop = (center.y + 18f * density).coerceAtMost((size.height - boxH).coerceAtLeast(0f))

    drawRoundRect(
        color = color.copy(alpha = alpha),
        topLeft = Offset(boxLeft, boxTop),
        size = Size(boxW, boxH),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(9f * density),
    )
    drawRoundRect(
        color = Color.White.copy(alpha = alpha),
        topLeft = Offset(boxLeft, boxTop),
        size = Size(boxW, boxH),
        cornerRadius = androidx.compose.ui.geometry.CornerRadius(9f * density),
        style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2f * density),
    )
    drawText(
        textMeasurer,
        label,
        topLeft = Offset(boxLeft + padX, boxTop + padY),
        style = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Black, color = Color.White.copy(alpha = alpha)),
    )
}
