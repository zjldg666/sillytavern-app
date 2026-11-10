# 酒馆主工程交接

2026-11-05 用户明确同意改用原生 Android + Kotlin + WebView + 内置 Node，替代 HBuilderX / uni-app 约束。当前根目录为唯一 Gradle 工程，不再推进 DCloud 云包或自定义基座。

旧客户端备份：`.tools/legacy-client-20261105-main-migration/`；旧 uni-app 宿主进一步归档到其中 `retired-hbuilder-host/`。不要恢复为主线。

## 当前结构

- `app/src/main/java/io/jiuguan/mobile/MainActivity.kt`：启动状态、原版 WebView、系统文件选择器、HTTP 下载保存、安全区/键盘与返回键。
- `TavernService.kt`：前台服务、运行状态、停止通知、进程健康检查。
- `TavernRuntime.java`：资源散列验证/展开、固定端口、私有数据目录、Node 子进程。
- `app/src/main/assets/extensions/jiuguan-mobile/`：浅色角色 / 聊天 / 设置导航，通过标准前端扩展加载；原版表单与聊天 DOM 保持原位。
- `scripts/upstream/prepare-android.mjs`：校验来源，生成 APK 内置资源与原生库；不依赖 HBuilder。
- `.tools/android-sdk`、`.tools/android-build`、`.tools/gradle-home`：项目内构建工具与缓存。

## 授权与边界

用户已授权迁移、构建、安装和真机验收。使用开发包 `io.jiuguan.mobile.debug`，不卸载或清空旧 App/基座。安装前核对包名和签名。测试使用合成角色和本机模型模拟服务，不调用付费 API。

APK 编译结果与 App 沙箱实测以 `docs/UPSTREAM-STATUS.md` 和 `artifacts/upstream/` 为准。浅色手机 UI 已接入；目标扩展、后台长时稳定性、Blob 导出、旧数据迁移和正式运行时供应链仍需逐项处理。

## 本轮已完成

2026-11-10 1.2.17-dev / 137：简约改版，暖白 / 暖炭黑两套配色加琥珀强调色；设置页“外观”可选跟随系统 / 白天 / 黑夜，原生系统栏与启动页同步。规则见 `DESIGN.md`，验证记录见 `docs/UPSTREAM-STATUS.md`。已覆盖安装到 vivo 并冷启动，真机外观待确认。

2026-11-06 1.2.6-dev / 126（APK 197,673,534 字节，SHA-256 `4ed893c627d0f416170533e095ce523e10887d879b1cbc5bd64bd2c23a9a8adf`）：修复浅色界面下原版用半透明白色（`--white20a/30a/50a/70a`）表示淡化文字和悬停底色导致的“白字白底”——在设置面板、弹窗和提示词管理器弹层内把这些变量改为淡黑色，聊天消息不受影响；面板内 `code` 与下拉选项另设浅色。提示词管理器（预设与生成参数）改为白色列表：停用项灰字、开关绿/灰、编辑与移除图标去掉半透明和黑色阴影、名称过长省略、隐藏分隔线。原版“单击滑块以手动输入值”提示原为绝对定位，会盖住滚动内容，改回文档流。桌面隔离 `.tools/ui-wechat-desktop.mjs pm-after` 截图核对；`check` 7 项、`feat`、生成回归、扩展隔离均通过；Lint 0 错误；覆盖安装到 vivo（versionCode 126，数据保留），用户正在使用其他应用，未启动、未做真机截图。

2026-11-06 1.2.5-dev / 125（APK 197,672,406 字节，SHA-256 `86305ccbb9217db29ced97e7a4babbd9c6a4a6abea6dc71f9f60f77d1d026466`）：恢复系统状态栏和导航栏（不再全屏隐藏，浅色底深色图标）；网页 alert/confirm 改为无网址标题的中文系统对话框。聊天列表长按某段会话弹出菜单：“设置备注名”只存在扩展设置 `extension_settings.jiuguan_mobile.chatNames`（键为 `c:角色头像/文件名` 或 `g:群聊ID/文件名`），不改聊天文件；“删除该聊天”调用原版 `deleteCharacterChatByName` / 群聊删除接口，只删这一段，删除当前打开的会话时与原版一样换到剩余最近会话（没有则新建）。单选下拉框（非 multiple、非 select2）点按时改为底部选择面板（分组、当前项绿勾、超过 12 项带搜索），选中后派发原生 input/change。原版弹窗改为微信式通栏文字按钮。修复：原版在 html 上的按下事件会收起抽屉，手机外壳和底部菜单内的点击现在不再收起正在显示的设置面板（此前点“更多”再取消会留下空白页）。桌面隔离 `.tools/ui-wechat-desktop.mjs feat`（长按、备注、删除非当前/当前会话、选择面板与搜索）、`check`（7 项）、生成回归、扩展隔离均通过；Lint 0 错误。已覆盖安装到 vivo（versionCode 125，数据保留），冷启动时 dumpsys 显示状态栏、导航栏均可见；真机触摸检查脚本 `.tools/ui-wechat-device-feat.mjs`（只读，均以取消关闭）因用户正在使用手机未执行。

2026-11-06 微信风格改版（1.2.4-dev / 124，APK SHA-256 `d3fb6203f80d05b6c3f8511b84da2aa7003336e45b04274750ec6b7eeaa61544`）：底部改为 聊天 / 角色 / 设置，默认打开聊天页；微信绿 `#07c160` + 浅灰底 `#ededed`；标题居中；聊天列表通栏白底；设置页为“我”式分组单元格并带人设卡；底部菜单为 ActionSheet。聊天消息按用户选择保持整行排版，仅改为圆角卡片和配色。原版设置面板只改 CSS：白色输入框/下拉、开关式复选框、白卡片折叠块、灰色分组标题、微信式弹窗（取消在左）。桌面隔离环境 UI 检查 7 项、生成请求回归、扩展隔离测试均通过；Gradle 构建与 Lint（0 错误）通过、APK 散列核对通过、签名证书与此前一致。原生窗口底色同步改为顶部 `#ededed`、底部 `#f7f7f7`，状态栏不再露出米色条。已在 vivo V2520A（`10CG1E0NY40024X`，Android 16）覆盖安装（安装前核对已装包签名一致，数据保留），冷启动后默认进入聊天页，聊天列表、角色、设置首页/底部、模型 API、正则与扩展面板真机截图正常（`artifacts/upstream/mobile-ui/wechat/device*-*.png`）；该机没有合成验收角色，未打开聊天页、未做键盘与发送验证，华为平板未验证。构建需 Node ≥ 20，可设置 `JIUGUAN_NODE`。开发截图脚本 `.tools/ui-wechat-desktop.mjs`（桌面隔离）与 `.tools/ui-wechat-capture.mjs`（真机，只截图）。

此前 1.2.3-dev / 123，APK SHA-256 为 `98469d0d5364517900957973ceeb9cbbfacba254bf2ffadb0c4d9a4dfffd7005`。Gradle 与 Lint 通过；扩展和性能实测在 `extensions-lab/report.json`、`extensions-app/report.json`。旧 `app-webview-smoke.json` 是 1.2.1 的历史检查，不混称当前包的结果。上游源码仍无修改，付费调用 0。

两项扩展固定来源在 `extensions.lock.json`，缓存 `.tools/upstream-extensions/`，准备脚本 `prepare-extensions-sources.mjs` / `prepare-extensions.mjs`；原版核心不改。TavernRuntime 首次启动复制内置扩展，通过 managed/revision 标记保护用户手动安装副本和中断重试。注意助手的 NonCommercial 许可证。

最新 UI：首次默认最近 20 条显示，设置可更改，不改消息数组或上下文。持续限制依赖助手默认消息加载优化；工具栏使用原版 qr--bar/qr--buttons 单行横向滚动；标题 48px。Android 全屏隐藏系统栏，30+ 用 ADJUST_NOTHING 配合 IME insets，必须用真实键盘截图验证标题和输入框均可见。

2026-11-06 收尾：当前包冷启动后连续三次键盘开关及整屏截图已核验，标题/输入框可见、页面高度恢复。顶部拼图 `artifacts/upstream/extensions-app/header-check.png` 进一步确认三次标题均完整；以实际图片像素为准，长图工具预览可能局部显示。测试报告已更新，APK 未改变。

继续在本工程优化手机 UI，并逐项验证实际目标卡与扩展，不重建宿主、不重写兼容引擎。原版 WebSpeech TTS 在 Android WebView 缺少 SpeechSynthesisUtterance；本轮未解决，也不能代表其他 TTS 提供商不可用。旧版无角色会话在新列表仅提示切换原版管理。

已安装应用名“酒馆（开发版）”，旧 App 未覆盖。合成验收卡仍保留；不要误认成用户原有聊天。用户可能正在手机上导入和操作自己的卡，不应删除测试目录之外的内容。若外观恢复原版，先检查“酒馆手机界面”扩展是否被关闭，不要清数据或重复迁移。
