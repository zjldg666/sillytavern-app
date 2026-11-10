package io.jiuguan.mobile

import android.app.*
import android.content.Intent
import android.os.*
import java.util.concurrent.Executors

class TavernService : Service() {
    data class State(val phase: String, val message: String, val url: String? = null)
    inner class LocalBinder : Binder() { val service get() = this@TavernService }
    private val binder = LocalBinder()
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var runtime: TavernRuntime
    private val listeners = mutableSetOf<(State) -> Unit>()
    var state = State("starting", "正在准备酒馆…")
        private set
    private var launched = false
    private var destroyed = false

    override fun onCreate() {
        super.onCreate()
        runtime = TavernRuntime(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("tavern", "酒馆本机服务", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onBind(intent: Intent) = binder
    fun observe(listener: (State) -> Unit) { listeners.add(listener); listener(state) }
    fun removeObserver(listener: (State) -> Unit) { listeners.remove(listener) }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "STOP") {
            publish(State("stopped", "酒馆已停止，数据保留。重新打开应用即可继续。"))
            worker.shutdownNow()
            Thread { runtime.stop() }.start()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(1, notification(state.message))
        if (!launched) {
            launched = true
            worker.execute {
                try {
                    runtime.start { message -> main.post { publish(State("starting", message)) } }
                    main.post {
                        if (!destroyed && state.phase != "stopped") {
                            publish(State("running", "酒馆正在本机运行", runtime.url))
                            main.postDelayed(health, 3000)
                        }
                    }
                } catch (e: Exception) {
                    runtime.stop()
                    main.post {
                        if (!destroyed && state.phase != "stopped") {
                            publish(State("error", "启动失败：${e.message ?: "未知错误"}"))
                            stopForeground(STOP_FOREGROUND_REMOVE)
                            stopSelf()
                        }
                    }
                }
            }
        }
        return START_NOT_STICKY
    }
    private val health = object : Runnable {
        override fun run() {
            if (destroyed || state.phase != "running") return
            if (!runtime.isAlive) {
                publish(State("error", "酒馆服务已退出，请重新启动应用。"))
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            } else main.postDelayed(this, 3000)
        }
    }
    private fun publish(value: State) {
        if (destroyed || (state.phase == "stopped" && value.phase != "stopped")) return
        state = value
        if (value.phase == "starting" || value.phase == "running") {
            getSystemService(NotificationManager::class.java).notify(1, notification(value.message))
        }
        listeners.toList().forEach { it(value) }
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, TavernService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, "tavern").setSmallIcon(R.drawable.ic_tavern)
            .setContentTitle("酒馆").setContentText(text).setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停止酒馆", stop).build()).build()
    }
    override fun onDestroy() {
        destroyed = true
        main.removeCallbacksAndMessages(null)
        listeners.clear()
        worker.shutdownNow()
        Thread { runtime.stop() }.start()
        super.onDestroy()
    }
}
