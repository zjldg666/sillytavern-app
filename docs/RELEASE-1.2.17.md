# 酒馆 1.2.17

发布准备日期：2026-11-10。正式签名的 Release 构建，作为预览版本提供；不表示已完成全设备、完整插件或应用商店验收。

## 本版内容

- 暖白 / 暖炭黑配色、琥珀色强调，以及白天 / 黑夜 / 跟随系统设置。
- 聊天、角色、世界书、设置四项底部导航。
- 世界书书库、搜索、导入入口，全局启用与编辑状态分开。
- 直接工具入口与紧凑表单，保留 SillyTavern 1.19.0 原版前后端与固定版本扩展。
- README 新增独立交互演示页，使用原创合成对话；演示不打入 APK。

## 安装包

- 文件：`jiuguan-1.2.17-arm64-v8a.apk`
- 包名：`io.jiuguan.mobile`
- versionName / versionCode：`1.2.17` / `137`
- Android：8.0+，arm64-v8a
- 文件大小：190,019,670 字节（约 181.2 MiB）
- SHA-256：`42d302dcd0e530e06b8f920ab3a6832656dec48b81cc77c9c798af70dd39d349`
- 签名证书 SHA-256：`6ae437db7ef5e232bf2620281af028aece0be6869612345ec8ba051836494fbf`

更新已有正式版需使用相同签名。开发版 `io.jiuguan.mobile.debug` 与正式版数据独立，不自动迁移；不要卸载旧版或清空数据来处理签名冲突。

## 本次实际检查

- Gradle `:app:assembleRelease` 成功。
- `:app:lintRelease` 成功：0 错误，4 项现有警告。
- `apksigner verify --print-certs` 成功，核对正式签名。
- `aapt dump badging` 核对包名、版本、最低系统和 arm64 ABI。
- `inspect-apk.mjs` 核对包内 Node、原版资源、手机扩展和固定第三方扩展的散列，并确认许可文件存在。
- `mobile-generation-regression.mjs` 通过：UI 前后完整模型请求一致、SSE、导入和聊天显示回归；3 次本地模拟请求，付费调用 0。
- README 独立前端在 320 / 390 / 768 / 1280px 完成布局及交互检查；不算作 APK 测试。

本次没有安装这个 Release APK，也没有对它重新进行真机聊天、键盘或文件导入导出验证。1.2.17-dev 的既有覆盖安装和冷启动记录见 `UPSTREAM-STATUS.md`，不能替代正式包实测。

## 源码与已知范围

Release 同时提供 SillyTavern、酒馆助手和提示词模板的固定提交源码 ZIP、第三方声明和 SHA-256 清单；宿主源码对应 `v1.2.17` 标签。

原生 Node 运行时继续采用锁定来源的二进制，独立可复现构建和完整构建链核验尚未完成。第三方扩展、复杂卡、后台长时运行、迁移和导出仍有未测范围。许可证与来源见根目录 `THIRD_PARTY_NOTICES.md`，功能边界以 README 和实测记录为准。
