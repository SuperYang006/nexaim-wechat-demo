# 验收记录

## 本地自动化

- `pnpm build`：SDK 固定版本打包、3 个原生页面及 3 个组件构建。
- `pnpm typecheck`：对随工程提供的 Reference Client 类型快照和微信官方 API 类型包进行检查。
- `pnpm test`：消息去重 / ACK 合并、sync 连续游标、发送幂等、旧会话结果隔离、图片 PUT、业务登录鉴权与 HMAC。
- `pnpm test:miniapp`：在没有 process / Buffer / window / URL / fetch / Response / WebSocket 的 VM 中加载构建结果，验证页面绑定、SDK 导出、纯 JS SHA-256 和模拟媒体响应。不是微信真机验收。

执行结果由 [创建任务](implementation.md) 记录。

## 客户微信环境联调（填写配置后执行）

| 场景 | 状态 |
| --- | --- |
| 微信开发者工具导入、微信登录换票 | 待测 |
| 双微信账号会话列表、分页、发起聊天 | 待测 |
| 双向实时文本、ACK、重复推送去重 | 待测 |
| 离线新会话发现、前后台切换与断线补漏 | 待测 |
| 超时复用 clientMessageId、已读游标与未读数 | 待测 |
| 图片选取、ArrayBuffer PUT、complete 与下载展示 | 待测 |
| 图片签名头在 iOS / Android 的实际行为 | 待测 |
| 账号切换、迟到响应与缓存隔离 | 待测 |

使用自己的应用和两个不同微信账号；记录微信版本、基础库版本、iOS / Android 版本、业务服务 / API / Gateway / 存储域名及错误 requestId，不记录 token、secret 或完整签名 URL。

按本表与 [接口接入](direct-api.md) 逐项联调。客户各自的域名、业务凭据和真机结果须单独登记，维护者的部署或自动化结果不能代替客户环境验收。

## 客户包独立验证

- 使用另一组示例 AppID，验证工程配置与客户端配置一致性。
- 在没有 NexaIM 平台源码的目录安装依赖，运行 pnpm check。
- 检查 SDK 快照完整性、源码包不含环境文件和私有配置。
- Docker Compose 的独立部署模板不要求平台网络。
- 微信编译器不可用时，17 项真实 WXML 渲染测试明确 skipped；仍执行不依赖该编译器的模板绑定检查。
- 自动化测试不调用真实微信登录、生产写接口或修改 DNS。
