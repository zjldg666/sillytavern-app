# 1.2.6 正式构建记录

2026-11-06，按当前工程样式和代码构建，未改动用户 UI。

- APK：`app/build/outputs/apk/release/app-release.apk`，190,001,830 字节。
- 应用名称：酒馆；包名：`io.jiuguan.mobile`；versionCode：126；versionName：1.2.6。
- APK SHA-256：`9fcd99bd6ac307cf8eabfa08bdc5eba1d38684dc25ac7fc5b35a7006a25047ac`。
- 独立正式签名证书 SHA-256：`6ae437db7ef5e232bf2620281af028aece0be6869612345ec8ba051836494fbf`。
- `assembleRelease`、`lintRelease` 通过；Lint 0 错误、4 警告。
- apksigner 签名验证通过，aapt 确认正式包名、版本、arm64 ABI，无 debuggable 标记。
- APK 内 Node、运行库、上游资源、扩展与当前手机 UI 文件散列核对通过，报告 `artifacts/upstream/apk-inspection-release.json`。
- 本轮交付安装包，未安装此正式包或进行正式包真机功能验收；此前开发包测试不能替代本版正式包验收。
- 签名私密文件位于 `.tools/signing/`，已被 Git 忽略。不要提交或公开，后续版本必须沿用。

构建和运行方法见 [ANDROID-BUILD.md](ANDROID-BUILD.md)。
