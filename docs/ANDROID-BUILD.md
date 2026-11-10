# 构建与安装

本项目使用原生 Android / Kotlin / Gradle。以下以 Windows PowerShell 为例，从仓库根目录执行。无需 HBuilderX、DCloud AppID 或云打包。

## 开发工具

安装 Git、Node.js ≥ 20、JDK 21，以及 Android SDK Platform 35、Build Tools 35.0.0、Platform Tools。Android Studio 可用于编辑、同步和运行，命令行使用仓库内的 Gradle Wrapper。

新建本机 `local.properties`（已被 Git 排除），使用实际路径与正斜杠：

```properties
sdk.dir=C:/Android/Sdk
node.executable=C:/Program Files/nodejs/node.exe
```

`scripts/android-build.ps1` 保留维护者环境的自动探测；在其他电脑上显式设置 `JAVA_HOME` 和 `JIUGUAN_NODE`。

## 准备资源

```powershell
npm ci
npm run upstream:prepare
npm run extensions:prepare

$runtime = Get-Content platform/upstream/runtime.lock.json -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force .tools/upstream-runtime | Out-Null
Invoke-WebRequest -Uri $runtime.assetUrl -OutFile .tools/upstream-runtime/ST-android-0.5.1.apk
node scripts/upstream/extract-runtime.mjs
```

脚本校验来源锁对应的版本、提交和散列；下载内容保存在 `.tools/`。提取脚本先校验整个下载包，再提取 arm64 运行时及许可文件，不会在手机安装第三方 APK。

若使用非标准 Node 安装，可用 `JIUGUAN_NPM_CLI` 指定对应的 `npm-cli.js`。若本机 Git 配置了已失效代理，可在单次准备期间设置 `JIUGUAN_GIT_NO_PROXY=1`。

## 开发包

```powershell
$env:JAVA_HOME = 'C:/Java/jdk-21'
$env:JIUGUAN_NODE = 'C:/Program Files/nodejs/node.exe'
.\gradlew.bat :app:assembleDebug :app:lintDebug "-PnodeExecutable=$env:JIUGUAN_NODE"
```

输出：`app/build/outputs/apk/debug/app-debug.apk`。包名：`io.jiuguan.mobile.debug`；名称：酒馆（开发版）。

首次构建自动生成 `.tools/android-debug.keystore`。不同机器的密钥可能不同，更新已有安装前先核对签名。Android Studio 中打开仓库根目录、选择 JDK 21、同步 Gradle，选择 app 的 debug 变体即可运行。

## 正式包

维护者原有签名保存在 `.tools/signing/`，不在仓库中。维护现有正式包时必须恢复原签名，不能生成新密钥替代。

独立发行者需要使用自己的密钥，并在本机创建 `.tools/signing/release.properties`：

```properties
storeFile=.tools/signing/your-release.jks
storePassword=YOUR_LOCAL_STORE_PASSWORD
keyAlias=YOUR_KEY_ALIAS
keyPassword=YOUR_LOCAL_KEY_PASSWORD
```

以上是字段示例，不是可用凭据。私有配置与证书不要上传。

```powershell
.\gradlew.bat :app:assembleRelease :app:lintRelease "-PnodeExecutable=$env:JIUGUAN_NODE"
$env:JIUGUAN_APK_VARIANT = 'release'
node scripts/upstream/inspect-apk.mjs
```

输出：`app/build/outputs/apk/release/app-release.apk`；包名：`io.jiuguan.mobile`。维护者也可双击根目录 `build-release.cmd`。正式包关闭 WebView 调试。

## 校验与安装

使用 SDK Build Tools 中的 `apksigner verify --print-certs` 检查签名，`aapt dump badging` 检查包名、版本、系统和 ABI，再与已有安装核对。对兼容签名的已有应用使用 `adb install -r` 覆盖安装，不卸载、不清空数据。

当前支持 Android 8.0+ / arm64-v8a。正式版和开发版数据独立，不自动迁移。编译通过不等于手机运行验证，安装、冷启动和数据保留需单独检查。

## 回归测试

隔离浏览器测试使用合成数据和本机模拟模型：

```powershell
$env:JIUGUAN_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run test:mobile-ui
npm run test:world-info-mobile
npm run test:preset-mobile
npm run test:compact-ui
npm run test:extensions-lab
```

真机测试前阅读对应脚本；它们仅针对开发包，可能创建合成验收数据、强制停止并重启应用。不要在生成或保存聊天时运行。

```powershell
$env:JIUGUAN_APP_PROBE = '1'
$env:ANDROID_DEVICE_ID = 'YOUR_ADB_DEVICE_ID'
$env:ADB_PATH = 'C:/Android/Sdk/platform-tools/adb.exe'
npm run android:smoke
npm run android:ui
```

`android:ui` 要求手机界面已启用，并存在“APK 合成验收角色”。完整本地报告保存在 `artifacts/upstream/`，默认不提交。前置条件与历史结果见 [实测记录](UPSTREAM-STATUS.md)。
