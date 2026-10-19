package com.zitnei.haetori

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** 難易度。Web版（index.html）の DIFFICULTIES と同じ速さ */
enum class Difficulty(val key: String, val label: String, val speed: Float, val desc: String) {
    EASY("easy", "イージー", 0.65f, "だれでも遊びやすいゆっくりした速度。"),
    NORMAL("normal", "ノーマル", 1.00f, "標準より少し早い速度。"),
    HARD("hard", "ハード", 1.35f, "少し早く、反応力が必要な速度。"),
    GOD("god", "神", 1.80f, "かなり早い。高い反応速度が必要。"),
    LEGENDARY("legendary", "レジェンダリー", 2.50f, "ものすごく早い。上級者向け。"),
    STRONGEST("strongest", "最強", 3.30f, "人類がギリギリクリアできることを狙った最高難度。");

    companion object {
        fun from(key: String?) = entries.firstOrNull { it.key == key } ?: NORMAL
    }
}

/**
 * アプリの設定・コイン・持っているスキンの保存先。
 * 端末の中（SharedPreferences）に保存するので、アプリを閉じても残る。
 */
class AppPrefs(context: Context) {

    private val sp = context.applicationContext.getSharedPreferences("haetori", Context.MODE_PRIVATE)

    var coins by mutableStateOf(sp.getInt(KEY_COINS, 0))
        private set
    var ownedSkins by mutableStateOf(sp.getStringSet(KEY_OWNED, setOf(Skins.DEFAULT_ID))!!.toSet())
        private set
    var selectedSkin by mutableStateOf(sp.getString(KEY_SELECTED, Skins.DEFAULT_ID) ?: Skins.DEFAULT_ID)
        private set
    var difficulty by mutableStateOf(Difficulty.from(sp.getString(KEY_DIFFICULTY, null)))
        private set
    var serverUrl by mutableStateOf(sp.getString(KEY_SERVER, GameViewModel.DEFAULT_SERVER) ?: GameViewModel.DEFAULT_SERVER)
        private set
    var bestScore by mutableStateOf(sp.getInt(KEY_BEST, 0))
        private set

    fun addCoins(amount: Int) {
        if (amount <= 0) return
        coins += amount
        sp.edit().putInt(KEY_COINS, coins).apply()
    }

    /** 買えたら true。コインが足りなければ false */
    fun buySkin(skin: Skin): Boolean {
        if (skin.id in ownedSkins) return true
        if (coins < skin.price) return false
        coins -= skin.price
        ownedSkins = ownedSkins + skin.id
        sp.edit()
            .putInt(KEY_COINS, coins)
            .putStringSet(KEY_OWNED, ownedSkins)
            .apply()
        return true
    }

    fun selectSkin(id: String) {
        if (id !in ownedSkins) return
        selectedSkin = id
        sp.edit().putString(KEY_SELECTED, id).apply()
    }

    fun chooseDifficulty(d: Difficulty) {
        difficulty = d
        sp.edit().putString(KEY_DIFFICULTY, d.key).apply()
    }

    fun saveServerUrl(url: String) {
        serverUrl = url
        sp.edit().putString(KEY_SERVER, url).apply()
    }

    fun updateBest(score: Int) {
        if (score <= bestScore) return
        bestScore = score
        sp.edit().putInt(KEY_BEST, score).apply()
    }

    val skin: Skin get() = Skins.byId(selectedSkin)

    private companion object {
        const val KEY_COINS = "coins"
        const val KEY_OWNED = "owned_skins"
        const val KEY_SELECTED = "selected_skin"
        const val KEY_DIFFICULTY = "difficulty"
        const val KEY_SERVER = "server_url"
        const val KEY_BEST = "best_score"
    }
}
