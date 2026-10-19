package com.zitnei.haetori

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** 画面の種類 */
enum class Screen { LOBBY, WAITING, PLAYING, RESULT }

/** フィールドに出ているハエ。x,y は 0〜1 の割合（Web版と共通なのでクロスプレイできる） */
data class Fly(
    val id: String,
    val type: String,
    val x: Float,
    val y: Float,
    val bornAt: Long = SystemClock.uptimeMillis(),
    /** ソロプレイでハエが動く速さ（マルチではサーバーが位置を決めるので0） */
    val vx: Float = 0f,
    val vy: Float = 0f,
)

/** スコアボードの1行 */
data class PlayerRow(
    val id: String,
    val name: String,
    val score: Int,
    val lives: Int,
    val team: String?,
)

/** タップした場所に出す「名前＋色」の印 */
data class TapMark(
    val key: Long,
    val name: String,
    val x: Float,
    val y: Float,
    val team: String?,
    val playerId: String,
    val mine: Boolean,
    val bornAt: Long = SystemClock.uptimeMillis(),
)

/** ハエの種類ごとの見た目と説明（サーバーの FLY_TYPES と対応） */
object FlyKind {
    fun label(type: String) = when (type) {
        "golden" -> "きんのハエ +5"
        "decoy" -> "ニセモノ −1"
        "ice" -> "こおりのハエ +2"
        "bomb" -> "ばくだんバエ +3"
        else -> "ふつうのハエ +1"
    }
}

class GameViewModel : ViewModel() {

    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private var socket: WebSocket? = null

    // ---- 入力・設定 ----
    var serverUrl by mutableStateOf(DEFAULT_SERVER)
    var playerName by mutableStateOf("")
    var roomCodeInput by mutableStateOf("")

    // ---- 接続と画面 ----
    var screen by mutableStateOf(Screen.LOBBY)
        private set
    var connected by mutableStateOf(false)
        private set
    var connecting by mutableStateOf(false)
        private set
    var errorMessage by mutableStateOf<String?>(null)

    // ---- 部屋 ----
    var myPlayerId by mutableStateOf<String?>(null)
        private set
    var roomCode by mutableStateOf("")
        private set
    var isHost by mutableStateOf(false)
        private set
    var mode by mutableStateOf("coop")
        private set
    var myTeam by mutableStateOf<String?>(null)
        private set

    // ---- 試合 ----
    val flies = mutableStateMapOf<String, Fly>()
    var players by mutableStateOf<List<PlayerRow>>(emptyList())
        private set
    var timeLeft by mutableIntStateCompat(0)
    var finalPlayers by mutableStateOf<List<PlayerRow>>(emptyList())
        private set
    val tapMarks = mutableStateListOf<TapMark>()

    /** 直前に取ったハエの結果（「+5」などの表示用） */
    var lastGain by mutableStateOf<Pair<Int, Long>?>(null)
        private set
    var decoyFlash by mutableStateOf(0L)
        private set

    val me: PlayerRow? get() = players.firstOrNull { it.id == myPlayerId }
    val myScore: Int get() = me?.score ?: 0
    val myLives: Int get() = me?.lives ?: 3

    private var pendingAction: (() -> Unit)? = null
    private var lastTapSentAt = 0L
    private var markKey = 0L

    // ================= 接続 =================

    private fun ensureSocket(then: () -> Unit) {
        if (connected) { then(); return }
        pendingAction = then
        if (connecting) return
        connecting = true
        errorMessage = null
        val url = serverUrl.trim().ifEmpty { DEFAULT_SERVER }
        val request = Request.Builder().url(url).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    connected = true
                    connecting = false
                    pendingAction?.invoke()
                    pendingAction = null
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                main.post { runCatching { handle(JSONObject(text)) } }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post {
                    connected = false
                    connecting = false
                    pendingAction = null
                    errorMessage = "サーバーにつながりません（${t.message ?: "通信エラー"}）"
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                main.post {
                    connected = false
                    connecting = false
                    if (screen != Screen.LOBBY) errorMessage = "サーバーとの接続が切れました"
                }
            }
        })
    }

    private fun send(obj: JSONObject) {
        socket?.send(obj.toString())
    }

    // ================= 操作 =================

    fun createRoom(selectedMode: String, teamSize: Int = 3) = ensureSocket {
        send(JSONObject().apply {
            put("type", "create_room")
            put("name", nameOrDefault())
            put("mode", selectedMode)
            put("teamSize", teamSize)
        })
    }

    fun joinRoom() = ensureSocket {
        send(JSONObject().apply {
            put("type", "join_room")
            put("roomCode", roomCodeInput.trim().uppercase())
            put("name", nameOrDefault())
        })
    }

    fun quickJoin() = ensureSocket {
        send(JSONObject().apply {
            put("type", "quick_join")
            put("name", nameOrDefault())
        })
    }

    fun startRound() = send(JSONObject().put("type", "start_round"))

    /** ハエをタップした（当たり判定はサーバーが決める） */
    fun hitFly(flyId: String) = send(JSONObject().apply {
        put("type", "hit_fly")
        put("flyId", flyId)
    })

    /** 何もないところをタップした（コンボが切れる） */
    fun missClick() = send(JSONObject().put("type", "miss_click"))

    /** タップした場所を全員に知らせる（Web版の画面にも名前と色が出る） */
    fun sendTap(x: Float, y: Float) {
        val name = me?.name ?: nameOrDefault()
        tapMarks += TapMark(markKey++, name, x, y, myTeam, myPlayerId ?: "", mine = true)
        val now = SystemClock.uptimeMillis()
        if (now - lastTapSentAt < 80) return
        lastTapSentAt = now
        send(JSONObject().apply {
            put("type", "tap")
            put("x", x.toDouble())
            put("y", y.toDouble())
        })
    }

    fun leaveRoom() {
        socket?.close(1000, "leave")
        socket = null
        connected = false
        connecting = false
        screen = Screen.LOBBY
        flies.clear()
        tapMarks.clear()
        players = emptyList()
        finalPlayers = emptyList()
        roomCode = ""
        isHost = false
        myPlayerId = null
    }

    /** 古くなったタップ表示を消す（画面の描画ループから呼ぶ） */
    fun pruneTapMarks(now: Long) {
        if (tapMarks.isEmpty()) return
        tapMarks.removeAll { now - it.bornAt > TAP_MARK_MS }
    }

    private fun nameOrDefault() = playerName.trim().take(16).ifEmpty { "ななし" }

    // ================= 受信 =================

    private fun handle(msg: JSONObject) {
        when (msg.optString("type")) {
            "joined" -> {
                myPlayerId = msg.optString("playerId")
                roomCode = msg.optString("roomCode")
                isHost = msg.optBoolean("isHost")
                mode = msg.optString("mode", "coop")
                myTeam = msg.optStringOrNull("team")
                errorMessage = null
                screen = Screen.WAITING
            }
            "host_transferred" -> isHost = true
            "error" -> errorMessage = msg.optString("message", "エラーが起きました")
            "room_state" -> {
                mode = msg.optString("mode", mode)
                players = msg.optJSONArray("players").toPlayerRows()
                timeLeft = msg.optInt("timeLeft", timeLeft)
                replaceFlies(msg.optJSONArray("flies"))
                if (msg.optString("state") == "playing" && screen == Screen.WAITING) screen = Screen.PLAYING
            }
            "round_start" -> {
                timeLeft = msg.optInt("timeLeft", 0)
                mode = msg.optString("mode", mode)
                flies.clear()
                tapMarks.clear()
                screen = Screen.PLAYING
            }
            "tick" -> {
                timeLeft = msg.optInt("timeLeft", timeLeft)
                players = msg.optJSONArray("players").toPlayerRows()
            }
            "fly_spawn" -> msg.optJSONObject("fly")?.let { f ->
                val id = f.optString("id")
                flies[id] = Fly(id, f.optString("type", "normal"), f.optDouble("x").toFloat(), f.optDouble("y").toFloat())
            }
            "fly_expire" -> flies.remove(msg.optString("id"))
            "fly_result" -> {
                flies.remove(msg.optString("id"))
                if (msg.optString("by") == myPlayerId) {
                    if (msg.optString("result") == "decoy") decoyFlash = SystemClock.uptimeMillis()
                    else lastGain = msg.optInt("gained") to SystemClock.uptimeMillis()
                }
            }
            "scoreboard" -> players = msg.optJSONArray("players").toPlayerRows()
            "tap_update" -> {
                val pid = msg.optString("playerId")
                if (pid != myPlayerId) {
                    tapMarks += TapMark(
                        markKey++, msg.optString("name", "?"),
                        msg.optDouble("x").toFloat(), msg.optDouble("y").toFloat(),
                        players.firstOrNull { it.id == pid }?.team, pid, mine = false,
                    )
                }
            }
            "cursor_update" -> {
                // PCのマウス位置。スマホでは1秒ほどの印として出す（誰がどこを狙っているか分かるように）
                val pid = msg.optString("playerId")
                if (pid != myPlayerId) {
                    tapMarks.removeAll { it.playerId == pid && !it.mine }
                    tapMarks += TapMark(
                        markKey++, msg.optString("name", "?"),
                        msg.optDouble("x").toFloat(), msg.optDouble("y").toFloat(),
                        players.firstOrNull { it.id == pid }?.team, pid, mine = false,
                    )
                }
            }
            "round_end" -> {
                finalPlayers = msg.optJSONArray("players").toPlayerRows()
                flies.clear()
                tapMarks.clear()
                screen = Screen.RESULT
            }
        }
    }

    private fun replaceFlies(arr: org.json.JSONArray?) {
        flies.clear()
        if (arr == null) return
        for (i in 0 until arr.length()) {
            val f = arr.optJSONObject(i) ?: continue
            val id = f.optString("id")
            flies[id] = Fly(id, f.optString("type", "normal"), f.optDouble("x").toFloat(), f.optDouble("y").toFloat())
        }
    }

    private fun org.json.JSONArray?.toPlayerRows(): List<PlayerRow> {
        if (this == null) return players
        val out = ArrayList<PlayerRow>(length())
        for (i in 0 until length()) {
            val p = optJSONObject(i) ?: continue
            out += PlayerRow(
                id = p.optString("id"),
                name = p.optString("name", "?"),
                score = p.optInt("score"),
                lives = p.optInt("lives", 3),
                team = p.optStringOrNull("team"),
            )
        }
        return out
    }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (isNull(key)) null else optString(key).ifEmpty { null }

    override fun onCleared() {
        socket?.close(1000, "closed")
        super.onCleared()
    }

    companion object {
        const val DEFAULT_SERVER = "wss://zintei.duckdns.org"
        const val TAP_MARK_MS = 1300L
    }
}

/** Compose の Int 用 state（compileSdk に依らず使えるよう簡単に包む） */
private fun mutableIntStateCompat(value: Int) = mutableStateOf(value)
