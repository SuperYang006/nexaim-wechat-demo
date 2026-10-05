# NexaIM 微信小程序接入示例

本工程展示业务登录、IM 换票、会话列表、实时文本 / 图片聊天、断线补漏和已读操作。可以只参考接口，也可以运行完整 Demo。接入 NexaIM 不要求采用本工程的页面、业务后端框架或 SDK。

先按需要选择入口：

- **直接调用接口**：[HTTP / WebSocket 接入](docs/direct-api.md)。适用于已有小程序、Web / App 和业务后端。
- **先跑通示例**：[客户快速接入](docs/getting-started.md)。包含配置、构建、登录与双账号验收。
- **部署示例业务后端**：[客户部署说明](docs/customer-deployment.md)。支持独立服务器和同机部署。

## 启动 Demo

需要 Node.js 22+、pnpm 10。工程已附带指定版本的 SDK 源码快照，不需要 NexaIM 平台仓库，也不需要私有 npm 源。

```bash
pnpm install --frozen-lockfile
# 换成自己的微信 AppID 和业务后端 HTTPS 地址
pnpm configure --appid wx0123456789abcdef --business-url https://business.example.com
cp .env.example .env
# 编辑 .env：填写对应的微信 AppID / AppSecret 和 NexaIM 应用凭据
pnpm check
pnpm dev:server
```

本地业务服务默认监听 `127.0.0.1:3100`。开发者工具在同一台电脑调试时可把业务地址设成 `http://127.0.0.1:3100`；手机使用可达的 HTTPS 地址。`wx0123456789abcdef` 是格式示例，须替换成已注册的小程序 AppID。

微信开发者工具导入**工程根目录**。`project.config.json` 指向 `dist/miniprogram/`；每次修改客户端后执行 `pnpm build`，再在开发者工具点击编译。不要单独导入源码目录 `miniprogram/`。

## 可复用部分

| 目录 | 用途 |
| --- | --- |
| `miniprogram/services/im/` | SDK 生命周期、会话、发送、sync、图片上传 |
| `miniprogram/store/` | 消息去重、发送状态、连续 sync 游标 |
| `miniprogram/services/business-api.ts` | 对接业务登录和换票；已有后端时替换这里 |
| `server/src/nexaim.ts` | Server API 的 HMAC 签名、用户 / 设备注册及换票 |
| `server/src/app.ts` | 微信登录的可运行示例；可以整合进现有后端 |
| `sdk/` | 固定提交的 Reference Client / protocol 源码及完整性清单 |

`appSecret`、微信 AppSecret 只在业务后端使用。小程序拿 IM Token 访问 NexaIM，不能把换票密钥放进客户端。客户可以使用任何支持 HTTPS / WebSocket 的技术栈。

## 验证与交付

```bash
pnpm check            # 构建、类型、单元 / 协议示例 / 模板检查
pnpm package:demo     # 维护者：导出可交付客户的源码 tar.gz 和 SHA-256
```

客户包在 `dist/releases/`，包含构建所需 SDK 源码，使用示例 AppID 和空业务地址。导出不改变维护者本机配置，且不包含 `.env`、微信私有配置、部署日志、历史部署记录、node_modules 或构建产物。客户必须填写自己的配置。

微信编译器回归默认使用本机开发者工具中的 `wcc`，其他安装位置可设置 `WXML_COMPILER`。未安装时会明确 skipped；通用 WXML 条件绑定检查仍执行。Docker Compose 配置测试需要 Docker CLI 与 Compose 插件；本地服务测试只监听回环地址，不调用真实微信或 NexaIM。

SDK 来源与维护方式见 [SDK 说明](sdk/README.md)，验证范围见 [验收清单](docs/acceptance.md)。本示例使用 direct 单聊；登录 session、消息缓存和草稿是内存实现，正式业务应对接自身账号、持久化与运维方案。
