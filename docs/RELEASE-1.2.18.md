# Sillytavern App 1.2.18

发布日期：2026-11-10。正式签名的 Release APK，应用名称更新为 **Sillytavern App**。

## 本版变化

- 桌面应用名称、启动页、前台服务通知与手机扩展中的项目名称统一更新。
- 沿用原正式包名和签名，版本号升至 1.2.18，允许覆盖安装旧正式版。
- 项目仓库更名为 `zjldg666/sillytavern-app`；README 新增原创生成插画与独立演示页截图，这些展示素材不打入 APK。
- 继续使用 SillyTavern 1.19.0、酒馆助手 4.12.0 和提示词模板 1.17.9，未修改上游核心源码。

## 安装包

- 文件：`sillytavern-app-1.2.18-arm64-v8a.apk`
- 应用名称：`Sillytavern App`
- 包名：`io.jiuguan.mobile`
- versionName / versionCode：`1.2.18` / `138`
- Android：8.0+，arm64-v8a
- 文件大小：190,019,786 字节（约 181.2 MiB）
- SHA-256：`7e72adb3eee543ed80f3dc9f1130932a434735abe6c81086fe3cdf4c83006c01`
- 签名证书 SHA-256：`6ae437db7ef5e232bf2620281af028aece0be6869612345ec8ba051836494fbf`

已核对包名、签名与 1.2.17 正式包一致。更新时直接覆盖安装，不要先卸载或清空数据。开发包 `io.jiuguan.mobile.debug` 与正式包互相独立，不自动迁移数据。

## 本次实际验证

- `:app:assembleRelease` 与 `:app:lintRelease` 成功；Lint 0 错误、4 项原有警告。
- `apksigner verify --print-certs` 验证正式签名成功。
- `aapt dump badging` 核对名称、包名、版本、最低系统和 arm64 ABI；安装包不可调试。
- `inspect-apk.mjs` 核对 APK 内 Node、原版资源、手机界面扩展与固定第三方扩展散列，确认许可文件存在。
- 发布附件中的上游源码压缩包与上一版已核验文件的 SHA-256 一致。

本次没有安装 1.2.18 正式 APK，也未重新进行真机聊天、键盘、导入导出或覆盖更新验证。构建与包内容检查不等同于真机运行通过；既有实测范围见仓库 `docs/UPSTREAM-STATUS.md`。

## 源码与范围

宿主源码对应 `v1.2.18` 标签。发布附件同时提供固定版本 SillyTavern、酒馆助手和提示词模板源码 ZIP、第三方许可声明及 `SHA256SUMS.txt`。

这是独立维护的 Android 宿主，非 SillyTavern 官方 Android 发行版。第三方扩展兼容、完整备份迁移、系统后台保活及多设备覆盖仍以 README 和实测记录为准；发布正式签名 APK 不代表这些范围均已完成验证。
