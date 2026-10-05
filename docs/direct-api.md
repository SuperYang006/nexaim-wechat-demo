# HTTP / WebSocket 直接接入

NexaIM 可以按标准接口接入。业务后端调用 Server API，客户端使用 IM Token 调用 Client API 并建立 WebSocket；不需要采用本 Demo 的工程结构、Fastify 或 SDK。Demo 是参考实现。

本文对齐 `sdk-source.json` 固定版本，先覆盖 direct 文字和图片聊天。当前会话列表 v1 仅返回 direct；当前端到端消息通过 WebSocket `message.send` 发送，没有一个等价的 HTTP 单聊发送接口。若希望免去请求匹配、重连、ACK 和去重细节，可选用附带的 Reference Client。

## 1. 调用方与凭据

| 调用方 | 能力 | 鉴权 |
| --- | --- | --- |
| 业务后端 | 注册用户 / 设备、签发 IM Token | appKey + appSecret，HMAC-SHA256 |
| 小程序 / Web / App | 会话列表、媒体凭据 | `Authorization: Bearer <IM_TOKEN>` |
| 小程序 / Web / App | 实时收发、补漏、送达 / 已读 ACK | WSS 连接参数中的 IM Token |

从服务提供方获取已启用的 NexaIM 应用 UUID、appKey、appSecret、API / WS / 媒体地址。示例公开地址为 `https://api.nexaims.com`、`wss://ws.nexaims.com/ws`、`https://media.nexaims.com`；私有部署使用实际地址。

业务方负责用户登录。服务端从已认证会话确定稳定的 `userId`，并验证设备归属；前端不能任意指定自己的 userId。微信 AppID 不等于 NexaIM appId；`appSecret`、微信 AppSecret 只留在业务服务端。Web / App / 小程序互通时统一 appId 和业务 userId 映射。

## 2. 后端：注册并换票

按以下顺序调用；用户与设备 upsert 可以重复执行。`platform` 当前枚举为 `ios/android/harmonyos/web/desktop`，小程序 Demo 使用 `web`，不是 `wechat`。

| 方法与路径 | JSON body |
| --- | --- |
| `POST /api/server/apps/:appId/im-users:upsert` | `{ "userId": "alice" }`，可选 displayName、avatarUrl |
| `POST /api/server/apps/:appId/devices:upsert` | `{ "userId": "alice", "deviceId": "device-a", "platform": "web" }` |
| `POST /api/server/apps/:appId/im-token` | `{ "userId": "alice", "deviceId": "device-a", "platform": "web", "protocolVersion": "1.0" }` |

成功统一返回 `{ requestId, data }`。换票的 `data` 包含 `token`、`expiresIn`（秒）、`user`、`device`。业务后端将 IM Token 和公开连接信息交给已经认证的客户端；不要把 appSecret 下发。接收方也必须先注册。

HMAC 原文是下面 5 段用换行符连接，无末尾换行。body 使用实际发送的原始 JSON 字符串；序列化一次，签名与请求复用同一字符串。

```text
HTTP_METHOD_UPPERCASE
完整请求路径，例如 /api/server/apps/<appId>/im-token
Unix 毫秒时间戳字符串
每次请求新生成的 nonce
SHA256(body) 的小写 hex
```

Node.js 22 后端示例（普通 HTTP 调用，不依赖客户端 SDK）：

```javascript
import { createHash, createHmac, randomUUID } from 'node:crypto';

// 配置来自服务端环境，不接受前端传入 appSecret 或 appId。
const { NEXAIM_API_BASE_URL: apiBase, NEXAIM_APP_ID: appId,
  NEXAIM_APP_KEY: appKey, NEXAIM_APP_SECRET: appSecret } = process.env;

async function serverPost(action, payload) {
  const path = `/api/server/apps/${appId}/${action}`;
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', appSecret)
    .update(['POST', path, timestamp, nonce, digest].join('\n')).digest('hex');
  const response = await fetch(apiBase.replace(/\/+$/, '') + path, {
    method: 'POST', body, signal: AbortSignal.timeout(15000),
    headers: {
      'Content-Type': 'application/json',
      'X-Nexa-App-Key': appKey,
      'X-Nexa-Timestamp': timestamp,
      'X-Nexa-Nonce': nonce,
      'X-Nexa-Request-Id': randomUUID(),
      'X-Nexa-Signature': signature
    }
  });
  const envelope = await response.json();
  if (!response.ok) throw new Error(envelope.error?.code ?? 'NEXAIM_REQUEST_FAILED');
  return envelope.data;
}

// 在已认证的业务请求中取值；这里是演示数据，不是前端可任意指定的身份。
const userId = 'alice', deviceId = 'device-a';
await serverPost('im-users:upsert', { userId });
await serverPost('devices:upsert', { userId, deviceId, platform: 'web' });
const ticket = await serverPost('im-token', {
  userId, deviceId, platform: 'web', protocolVersion: '1.0'
});
// 将 ticket.token / ticket.expiresIn 返回给当前已认证客户端，不打印 token。
```

重试 HTTP 请求时生成新的 nonce、时间戳与签名；不要重用已消费的 nonce。现有业务后端可以整合这段逻辑，完全不部署 Demo 的 `server/`。其他语言按相同 HMAC 规则实现。

## 3. 客户端：会话列表

```http
GET /api/client/apps/<appId>/conversations?limit=20
Authorization: Bearer <IM_TOKEN>
```

成功响应示例（其中 UUID 均为示例）：

```json
{
  "requestId": "list-1",
  "data": [{
    "conversationId": "11111111-1111-4111-8111-111111111111",
    "conversationType": "direct",
    "peerUserId": "bob",
    "lastMessageAt": null,
    "lastMessageSeq": 0,
    "lastReadSeq": 0,
    "unreadCount": 0,
    "lastMessage": null
  }],
  "page": { "limit": 20, "nextCursor": null, "hasMore": false }
}
```

`limit` 默认 20，范围 1～100。后续页把 `nextCursor` URL 编码后原样传到 `cursor`；不解码或自行构造。无后续页时 `nextCursor=null`、`hasMore=false`。只允许 limit / cursor，不接受 userId 等身份 query。

按 conversationId 合并列表。它按最后消息时间排序，不提供跨请求快照；重连 / 回前台重新拉第一页以发现新会话。`lastMessage=null` 显示占位；`unreadCount` 使用服务端事实，不通过最大 seq 减读游标计算，不把自己的消息记未读。

## 4. 客户端：建立连接并发送文字

使用系统 WebSocket 或小程序 `wx.connectSocket` 连接。所有参数值需 URL 编码：

```text
wss://ws.nexaims.com/ws?appId=<APP_UUID>&userId=alice&deviceId=device-a&token=<IM_TOKEN>&protocolVersion=1.0
```

`appId/userId/deviceId` 必须与 IM Token 一致。可附加 `clientType=wechat-miniprogram` 与 clientVersion。不要完整打印含 token 的 URL。

收到服务端 `connection.ready` 后才发送业务消息；仅触发 socket open 不等于完成就绪。下面各个 JSON 是 WebSocket 文本帧，小程序用 `socketTask.send({ data: JSON.stringify(frame) })` 发出。

```json
{
  "requestId": "send-1",
  "type": "message.send",
  "payload": {
    "conversationType": "direct",
    "recipientUserId": "bob",
    "clientMessageId": "alice-device-a-message-1",
    "messageType": "text",
    "content": { "text": "你好" }
  }
}
```

成功后发送方收到 `message.send_ack`，requestId 与请求相同；payload 含 conversationId、serverMessageId、clientMessageId、conversationSeq、`status:"sent"`、createdAt。它表示已落库，不表示对方已读。接收方收到 `message.received`，其 payload 含会话 / 消息 ID、senderUserId、conversationSeq、messageType、content、createdAt。

`requestId` 用来匹配本次请求，1～128 字符；`clientMessageId` 是消息幂等键。超时或断线后，结果属于未确认，重试复用原 clientMessageId 和相同 payload，另用新的 requestId。不同内容复用同一消息 ID 会被拒绝。发送者由连接鉴权确定，payload 不能加 senderUserId。

## 5. 送达、已读和断线补漏

接收端接受消息后发送送达 ACK；重复推送按 serverMessageId 去重，仍可重复 ACK：

```json
{
  "requestId": "delivery-1",
  "type": "message.delivery_ack",
  "payload": { "serverMessageId": "22222222-2222-4222-8222-222222222222" }
}
```

用户实际阅读曝光后，上报该会话已读到的序号；不要在列表页自动清空未读：

```json
{
  "requestId": "read-1",
  "type": "message.read_ack",
  "payload": { "conversationId": "11111111-1111-4111-8111-111111111111", "readSeq": 3 }
}
```

服务端分别回 `ack`，其中 payload.ackType 对应请求类型。已读游标只前进；读取后的列表刷新用于校准权威未读数。

首次或断线后按会话补漏：

```json
{
  "requestId": "sync-1",
  "type": "message.sync",
  "payload": { "conversationId": "11111111-1111-4111-8111-111111111111", "afterSeq": 0, "limit": 50 }
}
```

响应 `message.sync_result` 的 payload 为 `{ conversationId, items, nextSeq, hasMore }`。首次从 afterSeq=0 开始；合并完整页后保存 nextSeq，hasMore=true 时继续。实时最大 seq、列表 lastMessageSeq 不能直接推进连续 sync 游标。sync 会包含自己发出的消息；和实时消息按 serverMessageId 合并，按 conversationSeq 排序。

Gateway 使用 WebSocket 协议 ping/pong，不定义 JSON heartbeat 帧。浏览器 / 微信运行时负责控制帧；自定义底层客户端须处理 pong。断线后重新获取有效 Token、等待 connection.ready、刷新列表并补漏；后台挂起与账号切换也要清理旧连接和迟到回调。

## 6. 图片消息

顺序是：申请上传 → 原始二进制 PUT → 确认上传 → 发送图片消息。图片上限 10 MiB，允许 PNG / JPEG / WebP / GIF。摘要是原始文件 SHA-256 的 64 位小写 hex，不能用文件名、MD5 或 Base64 文本的哈希代替。

```http
POST /api/client/apps/<appId>/media/uploads
Authorization: Bearer <IM_TOKEN>
Content-Type: application/json
```

下面 sha256 / sizeBytes 是结构示例，真实请求必须由实际文件计算：

```json
{
  "kind": "image", "fileName": "photo.png", "mimeType": "image/png",
  "sizeBytes": 1024,
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "width": 100, "height": 100
}
```

响应 `data` 含 `mediaAsset.id` 和 `upload:{url,method:"PUT",headers,expiresAt}`。用原始 ArrayBuffer PUT 到返回 URL，使用约定的 Content-Type / Content-Length；按 URL 的 `X-Amz-SignedHeaders` 筛选请求头，允许 Content-Type，host 交网络层处理。不要额外转发未签名的 x-amz-meta-sha256，也不要附加 IM Token。不要改写签名 URL。小程序使用 `wx.request` 的原始二进制 data；`wx.uploadFile` 是 multipart，不适用于这里。

PUT 成功后调用 `POST /api/client/apps/:appId/media/:mediaAssetId/complete`，带 Bearer IM Token，body `{ "sha256": "<实际摘要>" }`。确认成功后发送：

```json
{
  "requestId": "send-image-1",
  "type": "message.send",
  "payload": {
    "conversationType": "direct", "recipientUserId": "bob",
    "clientMessageId": "alice-device-a-image-1", "messageType": "image",
    "content": { "mediaAssetId": "33333333-3333-4333-8333-333333333333" }
  }
}
```

收到图片后，使用 `GET /api/client/apps/:appId/media/:mediaAssetId/download-url`，带 Bearer IM Token；响应 `data.download` 为 `{ url, expiresAt }`。用此 URL 显示 / 预览图片，过期时重新申请，勿长期保存签名 URL。收到的 content 带文件名、大小、MIME、摘要与可选尺寸，消息本身不携带下载凭据。

示例实现见 `miniprogram/services/im/media.ts`；其中使用 `sha256(new Uint8Array(bytes))` 兼容微信文件回调的 ArrayBuffer。该 helper 可作为写法参考，直接接口接入不要求使用它。

## 7. 错误和最小验收

HTTP 失败格式为 `{ requestId, error: { code, message } }`。WebSocket 业务失败为 `{ type:"error", requestId?, payload:{code,message} }`；带 requestId 时关联待处理请求，主动推送错误可能不带。日志记录错误码 / requestId，隐藏 Token、secret 和签名 URL。

| 情况 | 处理 |
| --- | --- |
| Server API 签名 / 时间戳 / nonce 错误 | 检查 body 字节、完整路径、时钟、新 nonce 和对应应用凭据 |
| Client API 401 / Token 过期 | 经业务登录态重新换取 IM Token，必要时重连 |
| appId 不匹配，`APP_NOT_FOUND` | 检查路径 / Token / 应用配置一致性 |
| `USER_NOT_FOUND` | 接收方未注册或不可用；不是给发送者换 Token 能解决的问题 |
| 参数错误，`VALIDATION_FAILED` | 按字段类型、必填项和大小限制修正 |
| 发送超时 / 连接中断 | 保留未确认状态；重试复用消息 ID，不当作明确业务拒绝 |

最小验收：两个用户注册 → 换票 → 两端 ready → 双向文字与 ACK → 会话列表 → 断线补漏与去重 → 已读 → 图片上传 / 下载 → 切账号隔离。详细记录见 [验收清单](acceptance.md)。当前部署验证以单 Gateway 为范围，不能从这些示例推断跨 Gateway 路由已就绪。
