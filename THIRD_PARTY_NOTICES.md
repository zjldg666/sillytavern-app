# 第三方来源与许可

以下来源来自本项目的固定版本锁。各组件保留原作者版权及独立许可。仓库公开本身不授予第三方内容额外权利，也不为原创部分另行声明统一许可。

## SillyTavern

- 来源：https://github.com/SillyTavern/SillyTavern
- 版本：1.19.0
- 提交：`7e8663cd9c184a550b37238218bdd32c6efc68e9`
- 许可：AGPL-3.0；上游 LICENSE 随 APK 保留。
- 锁文件：`platform/upstream/upstream.lock.json`；上游核心未作补丁修改。

## 酒馆助手

- 来源：https://github.com/N0VI028/JS-Slash-Runner
- 版本：4.12.0
- 提交：`40e4b72d0e6abbe158fec85080cb93a5de9431ae`
- 许可：PolyForm Noncommercial 1.0.0，包含非商业使用限制。

## 提示词模板

- 来源：https://github.com/zonde306/ST-Prompt-Template
- 版本：1.17.9
- 提交：`d6f520d149aba146305b0b781ddd691d449c28d2`
- 许可：AGPL-3.0。

两项扩展通过 `platform/upstream/extensions.lock.json` 固定提交与入口散列，打包时保留各自 LICENSE。

## Android Node 运行时

- 二进制来源：https://github.com/Sanitised/ST-android/releases/tag/v0.5.1
- 下载与散列：`platform/upstream/runtime.lock.json`。
- 产物报告 Node `v24.22.1` / 提交 `ce7aaf1cee78`；这是二进制来源元数据，不表示已独立复现其构建。
- APK 保留来源包中的 `node_MIT.txt`、`apache-2.0.txt` 等声明。
- 独立可复现运行时及完整构建链核验尚未完成，不宣称发布包已通过完整供应链审计。

## 源码与依赖

Release 随附固定提交的 SillyTavern、酒馆助手和提示词模板源码归档；宿主和手机界面源码可通过对应 Git 标签下载。归档保留上游许可证与锁文件。原生运行时出处、散列及随附声明单独保留，不能将这三项源码归档视为已复现原生运行时。

npm、Gradle、Android 和运行时依赖仍适用各自声明。不要将整包标注成单一 MIT 或可无限制商用的许可。

## 截图与用户内容

README 截图来自独立演示前端，采用为本项目编写的原创合成对话，不含第三方角色卡、卡面或用户私人聊天。演示截图不作为 Android 实机运行证据。用户自行导入的角色卡、卡面、预设及其他内容仍归原作者所有。
