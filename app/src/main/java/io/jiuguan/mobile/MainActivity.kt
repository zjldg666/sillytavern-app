package io.jiuguan.mobile

import android.app.Activity
import android.app.AlertDialog
import android.content.*
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.*
import android.view.*
import android.webkit.*
import android.widget.*
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var status: LinearLayout
    private lateinit var title: TextView
    private lateinit var statusText: TextView
    private lateinit var progress: ProgressBar
    private lateinit var retry: Button
    private var service: TavernService? = null
    private var bound = false
    private var origin: String? = null
    private var chooser: ValueCallback<Array<Uri>>? = null
    private var pendingDownload: Pair<String, String>? = null
    private val prefs by lazy { getSharedPreferences("jiuguan_ui", MODE_PRIVATE) }
    private var themeMode = "system"
    private var dark = false
    private val observer: (TavernService.State) -> Unit = { render(it) }
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            service = (binder as TavernService.LocalBinder).service
            service?.observe(observer)
        }
        override fun onServiceDisconnected(name: ComponentName) {
            service = null
            showStatus("本机服务连接中断，请重新启动。", true)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 外观由网页设置页决定（跟随系统 / 白天 / 黑夜），启动时沿用上次选择，避免加载前闪出另一种底色。
        themeMode = prefs.getString("theme", "system") ?: "system"
        dark = resolveDark()
        root = FrameLayout(this)
        setContentView(root)
        if (Build.VERSION.SDK_INT >= 28) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            // 由下方 IME insets 统一缩小网页，避免全屏时系统再平移整个窗口。
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
            root.setOnApplyWindowInsetsListener { view, insets ->
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
                insets
            }
            root.requestApplyInsets()
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web = WebView(this)
        web.addJavascriptInterface(NativeBridge(), "JiuguanNative")
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true // 系统文件选择器返回的 content URI，用于角色卡等文件导入。
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportZoom(false)
            mediaPlaybackRequiresUserGesture = true
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                if (isLocal(request.url)) return false
                if (request.url.scheme in listOf("https", "http", "mailto")) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    catch (_: ActivityNotFoundException) { toast("没有可打开此链接的应用") }
                }
                return true
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showStatus("页面加载失败，请重试。", true)
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (isLocal(Uri.parse(url)) && service?.state?.phase == "running") status.visibility = View.GONE
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            // 系统默认对话框标题是网页地址；改为无标题的中文对话框。
            override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity, dialogTheme()).setMessage(message)
                    .setPositiveButton("确定") { _, _ -> result.confirm() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity, dialogTheme()).setMessage(message)
                    .setPositiveButton("确定") { _, _ -> result.confirm() }
                    .setNegativeButton("取消") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooser?.onReceiveValue(null)
                chooser = callback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                try { startActivityForResult(intent, 10) }
                catch (_: ActivityNotFoundException) { chooser?.onReceiveValue(null); chooser = null; toast("未找到系统文件选择器") }
                return true
            }
        }
        web.setDownloadListener { url, _, disposition, mime, _ ->
            if (!isLocal(Uri.parse(url))) {
                toast("当前版本暂不支持此类下载；文件导出将在下一步适配。")
            } else {
                pendingDownload = url to (CookieManager.getInstance().getCookie(url) ?: "")
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mime ?: "application/octet-stream")
                    .putExtra(Intent.EXTRA_TITLE, URLUtil.guessFileName(url, disposition, mime))
                try { startActivityForResult(intent, 11) }
                catch (_: ActivityNotFoundException) { pendingDownload = null; toast("未找到系统文件保存界面") }
            }
        }
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        status = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(32, 32, 32, 32)
        }
        title = TextView(this).apply { text = getString(R.string.app_name); textSize = 28f; gravity = Gravity.CENTER }
        status.addView(title)
        progress = ProgressBar(this)
        status.addView(progress, LinearLayout.LayoutParams(72, 72).apply { gravity = Gravity.CENTER; topMargin = 40; bottomMargin = 28 })
        statusText = TextView(this).apply { textSize = 16f; gravity = Gravity.CENTER }
        status.addView(statusText)
        retry = Button(this).apply { text = "重新启动"; visibility = View.GONE; setOnClickListener { restart() } }
        status.addView(retry)
        root.addView(status, FrameLayout.LayoutParams(-1, -1))
        applyChrome()
        showStatus("正在准备 Sillytavern App…", false)
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 20)
        }
    }

    private fun systemDark() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private fun resolveDark() = when (themeMode) { "dark" -> true; "light" -> false; else -> systemDark() }
    private fun dialogTheme() = if (dark) android.R.style.Theme_Material_Dialog_Alert else android.R.style.Theme_Material_Light_Dialog_Alert
    // Android 11+ 的系统栏透明叠在根布局上；更早版本直接设置系统栏颜色。深色底配浅色图标。
    @Suppress("DEPRECATION")
    private fun applyChrome() {
        val background = getColor(if (dark) R.color.jg_dark_background else R.color.jg_light_background)
        window.setBackgroundDrawable(ColorDrawable(background))
        root.setBackgroundColor(background)
        web.setBackgroundColor(background)
        status.setBackgroundColor(background)
        title.setTextColor(getColor(if (dark) R.color.jg_dark_text else R.color.jg_light_text))
        statusText.setTextColor(getColor(if (dark) R.color.jg_dark_muted else R.color.jg_light_muted))
        progress.indeterminateTintList = ColorStateList.valueOf(getColor(if (dark) R.color.jg_dark_accent else R.color.jg_light_accent))
        if (Build.VERSION.SDK_INT < 35) { window.statusBarColor = background; window.navigationBarColor = background }
        if (Build.VERSION.SDK_INT >= 30) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
        } else {
            val flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            val current = window.decorView.systemUiVisibility
            window.decorView.systemUiVisibility = if (dark) current and flags.inv() else current or flags
        }
    }
    // 设置页的外观选项通过此接口同步系统栏；只接受固定取值，只影响颜色。
    private inner class NativeBridge {
        @JavascriptInterface fun systemDark(): Boolean = this@MainActivity.systemDark()
        @JavascriptInterface fun setTheme(mode: String?, resolvedDark: Boolean) {
            val safe = if (mode == "light" || mode == "dark") mode else "system"
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                themeMode = safe; dark = resolvedDark
                prefs.edit().putString("theme", safe).apply()
                applyChrome()
            }
        }
    }
    // 自行处理系统深浅色切换，不重建页面，避免丢失正在输入的内容。
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (themeMode == "system") { dark = systemDark(); applyChrome() }
        web.evaluateJavascript("window.jiuguanMobile?.systemThemeChanged?.()", null)
    }

    override fun onStart() {
        super.onStart()
        connect()
    }
    private fun connect() {
        if (bound) return
        startForegroundService(Intent(this, TavernService::class.java))
        bound = bindService(Intent(this, TavernService::class.java), connection, Context.BIND_AUTO_CREATE)
    }
    private fun detach() {
        service?.removeObserver(observer)
        service = null
        if (bound) unbindService(connection)
        bound = false
    }
    override fun onStop() { detach(); super.onStop() }
    private fun restart() {
        showStatus("正在重新启动…", false)
        detach()
        stopService(Intent(this, TavernService::class.java))
        origin = null
        Handler(Looper.getMainLooper()).postDelayed({ if (!isDestroyed && !isFinishing) connect() }, 350)
    }
    private fun render(state: TavernService.State) {
        if (state.phase == "running" && state.url != null) {
            if (origin != state.url) {
                origin = state.url
                showStatus("正在打开 Sillytavern App…", false)
                web.loadUrl(state.url)
            } else status.visibility = View.GONE
        } else showStatus(state.message, state.phase == "error" || state.phase == "stopped")
    }
    private fun showStatus(message: String, failed: Boolean) {
        status.visibility = View.VISIBLE
        statusText.text = message
        progress.visibility = if (failed) View.GONE else View.VISIBLE
        retry.visibility = if (failed) View.VISIBLE else View.GONE
    }
    private fun isLocal(uri: Uri): Boolean {
        val base = origin?.let(Uri::parse) ?: return false
        return uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == base.port && uri.userInfo == null
    }
    private fun toast(text: String) { Toast.makeText(this, text, Toast.LENGTH_LONG).show() }
    @Deprecated("Legacy back handling supports API 26+")
    override fun onBackPressed() {
        web.evaluateJavascript("Boolean(window.jiuguanMobile?.back())") { handled ->
            if (handled != "true") { if (web.canGoBack()) web.goBack() else moveTaskToBack(true) }
        }
    }
    @Deprecated("Activity result API without AndroidX dependency")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 10) {
            val results = if (resultCode != RESULT_OK) null else data?.clipData?.let { clip ->
                Array(clip.itemCount) { clip.getItemAt(it).uri }
            } ?: data?.data?.let { arrayOf(it) }
            chooser?.onReceiveValue(results); chooser = null
        }
        if (requestCode == 11) {
            val download = pendingDownload; pendingDownload = null
            val target = data?.data
            if (resultCode == RESULT_OK && download != null && target != null) saveDownload(download, target)
        }
    }
    private fun saveDownload(download: Pair<String, String>, target: Uri) {
        Thread {
            var connection: HttpURLConnection? = null
            try {
                val link = URL(download.first).openConnection() as HttpURLConnection
                connection = link
                link.instanceFollowRedirects = false
                link.connectTimeout = 15000; link.readTimeout = 30000
                link.setRequestProperty("Cookie", download.second)
                if (link.responseCode != 200) error("下载响应 ${link.responseCode}")
                contentResolver.openOutputStream(target)?.use { out -> link.inputStream.use { it.copyTo(out) } }
                    ?: error("无法写入所选文件")
                runOnUiThread { toast("文件已保存") }
            } catch (_: Exception) { runOnUiThread { toast("保存失败，请重试") } }
            finally { connection?.disconnect() }
        }.start()
    }
    override fun onDestroy() {
        chooser?.onReceiveValue(null); chooser = null
        web.destroy()
        super.onDestroy()
    }
}
