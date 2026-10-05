# NexaIM WeChat Demo

本仓库是独立的微信接入 Demo。默认使用中文沟通，遵循维护者当前明确的任务范围。

- 原生微信小程序 + TypeScript；业务服务端使用 Fastify。客户端与服务端文件边界见 README。
- NexaIM 服务端在独立仓库；本仓库通过 sdk/ 消费固定提交的 Reference Client 与协议源码快照，客户构建不依赖平台仓库。不得手工修改快照；维护者确认升级版本后使用 pnpm sdk:update。
- 不在小程序放置 appSecret、微信 AppSecret、HMAC 签名密钥；登录身份必须由业务服务端决定。
- 不把微信 AppID 当作 NexaIM 应用 UUID。`nexaims.com` 的域名规划不等于已有部署。
- 修改行为前先补能暴露缺口的测试，确认失败后实现，运行受影响验证；纯文档例外要说明。
- 完成任务前运行 `pnpm check`，更新 docs/implementation.md 或对应任务记录。
- 保留用户已有改动；禁止未经授权部署、修改 DNS、调用真实外部服务测试或提交 / 推送代码。
- 不自动开启子代理；只有用户明确授权才允许。
- 不提交 .env、密钥、node_modules、dist、SDK 打包产物或微信私有工程配置。
- UI 事件只负责展示与调用，SDK 生命周期、去重、幂等、sync 游标与账号隔离放在 services / store。
- 未确认结果必须保留原消息 ID；实时最大 seq 不能用作连续 sync 游标。
