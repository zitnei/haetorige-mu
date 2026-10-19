package com.zitnei.haetori

import androidx.compose.ui.graphics.Color

// Web版と同じ配色（同じゲームだと一目で分かるように）
val Sky = Color(0xFFDFF7FF)
val SkyDeep = Color(0xFFC9EEFF)
val Grass = Color(0xFFC9EFA3)
val Card = Color(0xFFFFFFFF)
val Line = Color(0xFFB9E6F5)
val Ink = Color(0xFF18344F)
val Accent = Color(0xFFFFD45A)
val Danger = Color(0xFFFF6A6A)
val TeamRed = Color(0xFFD9534F)
val TeamBlue = Color(0xFF3A6AD9)

/** プレイヤーごとの色。Web版の CURSOR_COLORS と同じ並びなので、PCとスマホで同じ色になる */
val PlayerColors = listOf(
    Color(0xFFFF6A6A), Color(0xFFFFB347), Color(0xFF6AC0FF), Color(0xFF8EE06A),
    Color(0xFFC98EFF), Color(0xFFFF8EC9), Color(0xFF5AD1C9), Color(0xFFFFD45A),
)

fun colorForPlayer(id: String, team: String?): Color = when (team) {
    "red" -> TeamRed
    "blue" -> TeamBlue
    else -> {
        // Web版の colorForId と同じ計算（32bitで切り捨て）なので同じ色になる
        var h = 0u
        for (c in id) h = h * 31u + c.code.toUInt()
        PlayerColors[(h % PlayerColors.size.toUInt()).toInt()]
    }
}
