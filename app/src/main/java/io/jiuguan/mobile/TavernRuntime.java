package io.jiuguan.mobile;

import android.content.Context;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** 原版 Node 服务。数据目录与资源目录分离，资源更新不删除用户数据。 */
public final class TavernRuntime {
    private final Context context;
    private volatile Process process;
    private volatile boolean cancelled;
    private int port;

    public TavernRuntime(Context context) { this.context = context.getApplicationContext(); }
    public boolean isAlive() { Process p = process; return p != null && p.isAlive(); }
    public String getUrl() { return "http://127.0.0.1:" + port + "/"; }

    public void start(Consumer<String> progress) throws Exception {
        if (isAlive()) return;
        checkCancelled();
        File root = new File(context.getFilesDir(), "tavern");
        File data = new File(root, "data");
        File libraries = new File(context.getApplicationInfo().nativeLibraryDir);
        ensureDirectory(data);
        File node = new File(context.getApplicationInfo().nativeLibraryDir, "libjiuguan_node.so");
        if (!node.isFile() || !node.canExecute()) throw new IOException("APK 未正确安装 Node 运行库，请重新安装完整安装包。");
        String expected = readAsset("upstream/payload.sha256").trim();
        if (!expected.matches("[a-f0-9]{64}")) throw new IOException("资源校验信息无效");
        File server = new File(root, "server-" + expected);
        File complete = new File(server, ".payload-complete");
        if (!complete.isFile()) {
            progress.accept("首次启动：正在校验并展开酒馆资源，请稍候…");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream in = context.getAssets().open("upstream/server.zip")) {
                byte[] bytes = new byte[65536]; int count;
                while ((count = in.read(bytes)) != -1) { checkCancelled(); digest.update(bytes, 0, count); }
            }
            StringBuilder actual = new StringBuilder();
            for (byte b : digest.digest()) actual.append(String.format("%02x", b & 255));
            if (!expected.equals(actual.toString())) throw new IOException("安装包中的酒馆资源校验失败");
            ensureDirectory(server);
            unzip(server);
            for (String file : new String[]{"server.js", "public/index.html", "node_modules/webpack/lib/cache/getLazyHashedEtag.js"}) {
                if (!new File(server, file).isFile()) throw new IOException("酒馆资源不完整");
            }
            checkCancelled();
            try (FileOutputStream out = new FileOutputStream(complete)) { out.write(expected.getBytes(StandardCharsets.UTF_8)); }
        }
        checkCancelled();
        // 通过原版第三方前端扩展入口加载手机 UI，不替换上游脚本或聊天引擎。
        File mobileUi = new File(server, "public/scripts/extensions/third-party/jiuguan-mobile");
        ensureDirectory(mobileUi);
        for (String name : new String[]{"manifest.json", "index.js", "style.css", "connection-guard.js", "chat-display.js"}) {
            copyAsset("extensions/jiuguan-mobile/" + name, new File(mobileUi, name));
        }
        for (String name : new String[]{"JS-Slash-Runner", "ST-Prompt-Template"}) {
            File directory = new File(server, "public/scripts/extensions/third-party/" + name);
            File marker = new File(directory, ".jiuguan-bundled");
            File managed = new File(directory, ".jiuguan-managed");
            // 尊重用户自行安装的同名全局扩展；本地用户扩展也仍由原版优先加载。
            if (new File(directory, "manifest.json").isFile() && !managed.isFile() && !marker.isFile()) continue;
            String asset = "bundled-extensions/" + name;
            String revision = readAsset(asset + "/bundled-revision.json");
            if (marker.isFile() && revision.equals(new String(java.nio.file.Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8))) continue;
            progress.accept("正在准备内置扩展…");
            ensureDirectory(directory);
            if (!managed.isFile() && !managed.createNewFile()) throw new IOException("无法准备扩展安装标记");
            copyAssetDirectory(asset, directory);
            // 完成标记最后写入，中断时下次启动会重新复制。
            copyAsset(asset + "/bundled-revision.json", marker);
        }
        File config = new File(root, "config.yaml");
        if (!config.exists()) copyAsset("upstream/config.yaml", config);
        port = context.getSharedPreferences("runtime", Context.MODE_PRIVATE).getInt("port", 0);
        if (port == 0) {
            try (ServerSocket socket = new ServerSocket(0, 0, InetAddress.getByName("127.0.0.1"))) { port = socket.getLocalPort(); }
            // 保持 WebView origin 稳定，重启不丢失 localStorage/cookies。
            if (!context.getSharedPreferences("runtime", Context.MODE_PRIVATE).edit().putInt("port", port).commit()) {
                throw new IOException("无法保存本机服务端口");
            }
        }
        progress.accept("正在启动原版酒馆…");
        ProcessBuilder builder = new ProcessBuilder(node.getAbsolutePath(), new File(server, "server.js").getAbsolutePath(),
            "--configPath", config.getAbsolutePath(), "--dataRoot", data.getAbsolutePath(), "--port", Integer.toString(port),
            "--listen", "false", "--browserLaunchEnabled", "false");
        builder.directory(server);
        builder.environment().put("LD_LIBRARY_PATH", libraries.getAbsolutePath());
        builder.environment().put("NODE_ENV", "production");
        builder.environment().put("HOME", root.getAbsolutePath());
        builder.environment().put("TMPDIR", context.getCacheDir().getAbsolutePath());
        builder.redirectErrorStream(true);
        checkCancelled();
        Process started = builder.start();
        process = started;
        Thread reader = new Thread(() -> {
            try (InputStream in = started.getInputStream(); FileOutputStream out = new FileOutputStream(new File(root, "startup.log"))) {
                byte[] bytes = new byte[8192]; int count; long total = 0;
                while ((count = in.read(bytes)) != -1) {
                    if (total < 1024 * 1024) out.write(bytes, 0, (int)Math.min(count, 1024 * 1024 - total));
                    total += count;
                }
            } catch (IOException ignored) { /* 进程存活和 HTTP 就绪决定启动状态。 */ }
        }, "tavern-log");
        reader.setDaemon(true); reader.start();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
        while (System.nanoTime() < deadline) {
            checkCancelled();
            if (!started.isAlive()) throw new IOException("酒馆服务退出（" + started.exitValue() + "），请检查应用私有目录 tavern/startup.log。");
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection)new URL(getUrl() + "csrf-token").openConnection();
                connection.setConnectTimeout(500); connection.setReadTimeout(500);
                if (connection.getResponseCode() == 200 && started.isAlive()) return;
            } catch (IOException ignored) { /* 等待原版启动完成。 */ }
            finally { if (connection != null) connection.disconnect(); }
            Thread.sleep(300);
        }
        throw new IOException("酒馆启动超时，请重试");
    }

    public void stop() {
        cancelled = true;
        Process p = process;
        if (p != null) {
            p.destroy();
            try { if (!p.waitFor(3, TimeUnit.SECONDS)) p.destroyForcibly(); }
            catch (InterruptedException e) { p.destroyForcibly(); Thread.currentThread().interrupt(); }
        }
    }

    private void checkCancelled() throws InterruptedException {
        if (cancelled || Thread.currentThread().isInterrupted()) throw new InterruptedException("启动已取消");
    }
    private static void ensureDirectory(File path) throws IOException {
        if (!path.isDirectory() && !path.mkdirs()) throw new IOException("无法创建酒馆数据目录，请检查剩余存储空间");
    }
    private String readAsset(String asset) throws IOException {
        try (InputStream in = context.getAssets().open(asset); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] bytes = new byte[256]; int n;
            while ((n = in.read(bytes)) != -1) out.write(bytes, 0, n);
            return out.toString("UTF-8");
        }
    }
    private void copyAsset(String asset, File file) throws IOException {
        try (InputStream in = context.getAssets().open(asset); FileOutputStream out = new FileOutputStream(file)) {
            byte[] bytes = new byte[65536]; int n;
            while ((n = in.read(bytes)) != -1) out.write(bytes, 0, n);
        }
    }
    private void copyAssetDirectory(String asset, File target) throws Exception {
        ensureDirectory(target);
        String[] entries = context.getAssets().list(asset);
        if (entries == null) throw new IOException("扩展资源缺失");
        for (String name : entries) {
            checkCancelled();
            if (name.equals("bundled-revision.json")) continue;
            String child = asset + "/" + name;
            String[] children = context.getAssets().list(child);
            File output = new File(target, name);
            if (children != null && children.length > 0) copyAssetDirectory(child, output);
            else copyAsset(child, output);
        }
    }
    private void unzip(File target) throws Exception {
        String prefix = target.getCanonicalPath() + File.separator;
        long total = 0; int entries = 0;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(context.getAssets().open("upstream/server.zip")))) {
            ZipEntry entry; byte[] bytes = new byte[65536];
            while ((entry = zip.getNextEntry()) != null) {
                checkCancelled();
                if (++entries > 100000) throw new IOException("资源条目超出限制");
                File file = new File(target, entry.getName());
                if (!file.getCanonicalPath().startsWith(prefix)) throw new IOException("资源路径越界");
                if (entry.isDirectory()) { ensureDirectory(file); continue; }
                ensureDirectory(file.getParentFile());
                try (FileOutputStream out = new FileOutputStream(file)) {
                    int n;
                    while ((n = zip.read(bytes)) != -1) {
                        checkCancelled(); total += n;
                        if (total > 1024L * 1024 * 1024) throw new IOException("资源展开超过 1 GiB");
                        out.write(bytes, 0, n);
                    }
                }
            }
        }
    }
}
