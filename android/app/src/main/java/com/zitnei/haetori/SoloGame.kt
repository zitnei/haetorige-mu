package com.zitnei.haetori

import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlin.math.max
import kotlin.random.Random

/**
 * ひとりで遊ぶモード。サーバーにつながずスマホの中だけで動く。
 * ルールはWeb版のソロプレイ（index.html）と同じ：35秒・ライフ3・コンボ最大8倍。
 * 難易度を上げるとハエが速く動き、出てくる間隔も短くなる。
 */
class SoloGame {

    var running by mutableStateOf(false)
        private set
    var finished by mutableStateOf(false)
        private set
    var score by mutableStateOf(0)
        private set
    var combo by mutableStateOf(1)
        private set
    var lives by mutableStateOf(START_LIVES)
        private set
    var timeLeft by mutableStateOf(ROUND_SECONDS)
        private set
    /** 最後の1回で手に入れたコイン */
    var lastCoins by mutableStateOf(0)
        private set
    var toast by mutableStateOf<Pair<String, Long>?>(null)
        private set

    val flies = mutableStateListOf<Fly>()

    private var difficulty = Difficulty.NORMAL
    private var startedAt = 0L
    private var nextSpawnAt = 0L
    private var lastMoveAt = 0L
    private var nextId = 0

    fun start(difficulty: Difficulty) {
        this.difficulty = difficulty
        running = true
        finished = false
        score = 0
        combo = 1
        lives = START_LIVES
        timeLeft = ROUND_SECONDS
        lastCoins = 0
        flies.clear()
        startedAt = SystemClock.uptimeMillis()
        lastMoveAt = startedAt
        nextSpawnAt = startedAt + 300
        toast = null
    }

    fun quit() {
        running = false
        finished = false
        flies.clear()
    }

    /** 毎フレーム呼ぶ。ハエの移動・出現・時間切れをここで進める */
    fun tick(now: Long, prefs: AppPrefs) {
        if (!running) return
        val elapsed = ((now - startedAt) / 1000L).toInt()
        timeLeft = max(0, ROUND_SECONDS - elapsed)

        flies.removeAll { now - it.bornAt > ttlOf(it.type) }
        moveFlies(now)

        if (timeLeft <= 0 || lives <= 0) {
            finish(prefs)
            return
        }
        if (now >= nextSpawnAt) {
            spawn(now)
            // 難易度が高いほど早く次が出る（Web版と同じ考え方）
            val base = max(140.0, 760.0 / difficulty.speed - elapsed * 7.0 / difficulty.speed)
            nextSpawnAt = now + base.toLong()
        }
        toast?.let { if (now - it.second > 900) toast = null }
    }

    /** ハエをタップした。当たったら true */
    fun tapAt(hit: Fly?): Boolean {
        if (!running) return false
        if (hit == null) {
            combo = 1
            toast = "空振り！ コンボ切れ" to SystemClock.uptimeMillis()
            return false
        }
        flies.remove(hit)
        if (hit.type == "decoy") {
            lives -= 1
            combo = 1
            toast = "ニセモノ！ −❤" to SystemClock.uptimeMillis()
            return true
        }
        score += pointsOf(hit.type) * combo
        combo = minOf(MAX_COMBO, combo + 1)
        if (combo == 5 || combo == 8) {
            toast = (if (combo == 8) "🔥 コンボ絶好調！！" else "⚡ コンボ好調！") to SystemClock.uptimeMillis()
        }
        return true
    }

    private fun moveFlies(now: Long) {
        val dt = ((now - lastMoveAt).coerceIn(0, 50)) / 1000f
        lastMoveAt = now
        if (dt <= 0f) return
        for (i in flies.indices) {
            val f = flies[i]
            var x = f.x + f.vx * dt * difficulty.speed
            var y = f.y + f.vy * dt * difficulty.speed
            var vx = f.vx
            var vy = f.vy
            if (x < 0f) { x = 0f; vx = -vx }
            if (x > 1f) { x = 1f; vx = -vx }
            if (y < 0f) { y = 0f; vy = -vy }
            if (y > 0.92f) { y = 0.92f; vy = -vy }
            flies[i] = f.copy(x = x, y = y, vx = vx, vy = vy)
        }
    }

    private fun finish(prefs: AppPrefs) {
        if (!running) return
        running = false
        finished = true
        flies.clear()
        prefs.updateBest(score)
        // 最後まで遊びきった分だけコインがもらえる。難しい設定ほど多くもらえる
        lastCoins = (score * difficulty.speed / COIN_DIVISOR).toInt().coerceAtLeast(0)
        prefs.addCoins(lastCoins)
    }

    private fun spawn(now: Long) {
        val type = TYPE_TABLE.random(Random)
        flies += Fly(
            id = "solo_${nextId++}",
            type = type,
            x = Random.nextFloat(),
            y = Random.nextFloat() * 0.7f,
            bornAt = now,
            vx = (Random.nextFloat() - 0.5f) * 0.35f,
            vy = (Random.nextFloat() - 0.5f) * 0.28f,
        )
    }

    companion object {
        const val ROUND_SECONDS = 35
        const val START_LIVES = 3
        const val MAX_COMBO = 8
        private const val COIN_DIVISOR = 1f

        // Web版と同じ出現割合
        private val TYPE_TABLE: List<String> =
            List(55) { "normal" } + List(8) { "golden" } + List(22) { "decoy" } +
                List(7) { "ice" } + List(8) { "bomb" }

        fun pointsOf(type: String) = when (type) {
            "golden" -> 5
            "ice" -> 2
            "bomb" -> 3
            "decoy" -> -1
            else -> 1
        }

        fun ttlOf(type: String) = when (type) {
            "golden" -> 900L
            "decoy" -> 1900L
            "ice" -> 1900L
            "bomb" -> 1600L
            else -> 1700L
        }
    }
}
