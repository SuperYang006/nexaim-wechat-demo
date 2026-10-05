# 固定版本 SDK 源码

本目录是 NexaIM Reference Client 和 protocol 的源码快照，供 Demo 独立构建。不是已发布的 npm 包，也不需要客户取得整个平台仓库。

- 原始提交由根目录 `sdk-source.json` 固定。
- `manifest.json` 记录相同提交及每个源码文件的 SHA-256。
- `reference-client/src/` 和 `protocol/src/` 保留原始源码，不包含服务端、数据库、测试、凭据和构建产物。
- `pnpm build:sdk` 校验全部摘要，以本地 protocol alias 编译；类型声明指向本工程 sdk 目录，不含维护者机器路径。
- `zod`、`js-sha256` 由根目录 lockfile 固定安装，最终打进小程序使用的 CommonJS 文件。

客户通常无需修改此目录。只想直接使用接口时，请阅读 [HTTP / WebSocket 接入](../docs/direct-api.md)，SDK 并非必要条件。

## 维护者更新

确认协议和客户端兼容后，在有 NexaIM 源仓库的维护环境执行：

```bash
pnpm sdk:update --source /path/to/NexaIM --commit <完整的40位提交哈希>
pnpm check
pnpm package:demo
```

脚本从指定 Git 提交读取两个 package 的源码，不读取工作树修改或环境文件，同时更新版本和摘要。旧清单中已移除的源码文件会被清理。不要手工改快照后仅改摘要绕过校验；修改应先在 SDK 源仓库实现并验证，再导入相应提交。

快照是源码交付物；`miniprogram/vendor/` 和 `dist/` 是可重建产物，仍不提交。没有执行公开 npm 发布。
