# 客户快速接入

已有业务系统可直接按 [HTTP / WebSocket 接入](direct-api.md) 实现，无须运行 Demo 服务。本篇用于从示例快速跑通一组账号。

## 1. 准备应用和身份

向 NexaIM 服务提供方取得一个已启用应用的 `appId`（UUID）、`appKey`、`appSecret`、HTTP API base、WebSocket `/ws` 地址和媒体域名。不同客户使用独立应用 / 租户；同一业务需要跨 Web、App、小程序互通时，使用同一应用并统一业务 `userId` 映射。

微信小程序 AppID 与 NexaIM appId 是两套标识，不能互换。登录 Demo 需要自己的微信 AppID / AppSecret。不要复用其他小程序的业务登录服务：微信登录 code 绑定具体 AppID。

本工程附带固定版本 SDK 源码，解压客户包或获取完整 Demo 源码即可；不用克隆平台源码仓库。SDK 是可选参考实现，没有公开 npm 包安装的前置要求。

## 2. 配置客户端

```bash
pnpm install --frozen-lockfile
pnpm configure --appid wx0123456789abcdef --business-url https://business.example.com
```

`configure` 同时更新 `project.config.json` 的 `appid` 和 `miniprogram/config/env.ts` 的 `wechatAppId` / `businessBaseUrl`，保留开发者工具其他工程设置。命令不读取或修改服务端 `.env`。

`businessBaseUrl` 指向客户自己的登录 / 换票服务。它不是 NexaIM API 地址；也不应指向示例维护者的 Demo 后端。客户端通过登录响应取得 NexaIM 应用 UUID、公开 API / WS 地址和自身 userId。

工程导出默认使用 `wx0000000000000000` 和空业务地址，仅用于占位、构建与浏览页面。真实登录前必须替换。手工修改配置也可以，但两处微信 AppID 必须一致；构建检查会拒绝不一致的产物。

## 3. 配置示例业务后端

```bash
cp .env.example .env
```

只在 `.env` 填写凭据，勿放入 `miniprogram/`。

| 配置 | 来源 / 含义 |
| --- | --- |
| `WECHAT_APP_ID` | 与客户端一致的微信 AppID |
| `WECHAT_APP_SECRET` | 该小程序的微信 AppSecret |
| `NEXAIM_APP_ID` | NexaIM 应用 UUID |
| `NEXAIM_APP_KEY`、`NEXAIM_APP_SECRET` | 此 NexaIM 应用的 Server API 凭据 |
| `NEXAIM_API_BASE_URL` | 例如 `https://api.nexaims.com`；后端和客户端均可达 |
| `NEXAIM_WS_BASE_URL` | 例如 `wss://ws.nexaims.com/ws`；须含 `/ws` |
| `HOST`、`PORT` | 本地服务默认 `127.0.0.1:3100` |

```bash
pnpm check
pnpm dev:server
```

本地检查不要求真实凭据，也不会登录微信；启动业务服务时才校验 `.env`。`GET /healthz` 返回 `{"status":"ok"}` 只能证明服务在运行，不能替代真实换票与双账号聊天验收。

本机开发者工具可使用回环业务地址；真机访问 HTTPS。部署见 [客户部署说明](customer-deployment.md)。示例后端登录时会用微信验证后的 openid 生成稳定业务 userId，并依次完成 NexaIM 用户、设备注册；不接收客户端指定的自己的 userId。

## 4. 配置微信合法域名

| 微信配置 | 域名 |
| --- | --- |
| request | 客户业务后端、NexaIM API、媒体存储三个 HTTPS 域名 |
| socket | Gateway 的 WSS 域名，例如 `wss://ws.nexaims.com`；后台配置不带 `/ws` |
| uploadFile | 本 Demo 用 `wx.request` PUT 图片，不使用此接口 |
| downloadFile | 本 Demo 未调用 `wx.downloadFile`；客户自行使用时另配媒体域名 |

域名必须与实际连接和签名 URL 的域名一致。不要在客户端改写媒体签名 URL 的主机名或查询参数。

## 5. 导入与联调

1. 微信工具导入工程根目录，确认读取 `dist/miniprogram/`，再编译。
2. 两个不同微信账号分别登录；两人均登录后才能互发消息，因为收件人须已注册。
3. 复制对方业务 userId，发起聊天，验证文字、图片、会话列表和已读。
4. 验证前后台切换、断线恢复、图片失败重试、账号切换隔离。
5. 修改客户端后运行 `pnpm build` 并重新编译。按 [验收清单](acceptance.md) 记录实际结果。

## 6. 整合到已有业务系统

前端可复用 `services/im/`、`store/` 和组件；改造 `services/business-api.ts` 接入自身登录态。后端参考 `server/src/nexaim.ts` 的注册、签名与换票逻辑，不要求使用 Fastify 或 Node.js。

如保留 Demo 的前端业务接口，约定如下。业务 Token 与 IM Token 不同。

| 示例后端接口 | 请求 | 成功结果 |
| --- | --- | --- |
| `POST /api/auth/wechat` | `{ code, deviceId }` | `{ requestId, data: { businessToken, expiresAt, userId, im: { appId, apiBaseUrl, wsBaseUrl } } }` |
| `POST /api/im/token` | Bearer 业务 Token，body `{}` | `{ requestId, data: { token, expiresIn } }` |
| `POST /api/auth/logout` | Bearer 业务 Token | HTTP 204 |

已有登录态的业务无需实现微信登录示例，只需认证后提供同等 IM 身份和换票能力。服务端从自己的会话识别 userId，验证设备归属；客户端不能通过请求参数冒充另一个用户。

当前示例业务 session 存内存，TTL 为一小时，最多 1000 个活跃 session；重启后重新登录。正式业务使用已有 session 存储。消息、草稿及 sync 游标也未做跨进程持久化，不能把本 Demo 当作完整原生 SDK。
