package com.zitnei.haetori

import androidx.compose.ui.graphics.Color

/**
 * ハエの見た目（スキン）。ソロプレイで集めたコインと交換できる。
 * 画像ファイルではなく、ゲーム中のハエと同じ描き方で色や飾りを変えている
 * （画面の大きさに関係なくきれいに出るため）。
 */
data class Skin(
    val id: String,
    val name: String,
    val price: Int,
    val body: Color,
    val wing: Color,
    /** 頭の上の飾り。null なら飾りなし */
    val accessory: Accessory? = null,
    val rainbow: Boolean = false,
    val desc: String,
)

enum class Accessory { EARS, HORN, ANTENNA, CROWN }

object Skins {
    const val DEFAULT_ID = "normal"

    val all = listOf(
        Skin(
            id = DEFAULT_ID, name = "ふつうのハエ", price = 0,
            body = Color(0xFF6B4A35), wing = Color(0xFFBFE8F5),
            desc = "最初から持っている、いつものハエ",
        ),
        Skin(
            id = "mint", name = "ミントバエ", price = 150,
            body = Color(0xFF3FAE8C), wing = Color(0xFFD6FFF2),
            desc = "さわやかな色あい",
        ),
        Skin(
            id = "sakura", name = "さくらバエ", price = 300,
            body = Color(0xFFE88BA8), wing = Color(0xFFFFE3EE), accessory = Accessory.EARS,
            desc = "耳つきのかわいいハエ",
        ),
        Skin(
            id = "gold", name = "こがねバエ", price = 600,
            body = Color(0xFFE2B33C), wing = Color(0xFFFFF0B8), accessory = Accessory.CROWN,
            desc = "王冠つき。お金持ちのハエ",
        ),
        Skin(
            id = "ghost", name = "おばけバエ", price = 900,
            body = Color(0xFFBFC6E0), wing = Color(0xFFF2F4FF), accessory = Accessory.HORN,
            desc = "うすい色でちょっと見にくい",
        ),
        Skin(
            id = "robot", name = "ロボバエ", price = 1400,
            body = Color(0xFF7D8894), wing = Color(0xFFCFE6FF), accessory = Accessory.ANTENNA,
            desc = "アンテナつきのメカっぽいハエ",
        ),
        Skin(
            id = "rainbow", name = "にじいろバエ", price = 2500,
            body = Color(0xFFFF6A6A), wing = Color(0xFFFFFFFF), rainbow = true, accessory = Accessory.CROWN,
            desc = "色がどんどん変わる、最高級スキン",
        ),
    )

    fun byId(id: String?): Skin = all.firstOrNull { it.id == id } ?: all.first()
}
