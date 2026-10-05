# 客户业务后端部署

接入已托管的 NexaIM 时，客户部署自己的业务后端即可，不需要部署 PostgreSQL、Redis、MinIO 或 NexaIM 平台。也可以把 `server/src/nexaim.ts` 的逻辑整合进已有 Web / App 后端。

本篇部署的是可选 Demo 业务服务。每个实例绑定一套微信应用和 NexaIM 应用凭据；同一个实例不是多个客户的登录入口。生产部署前完成应用凭据与合法域名配置。

## 独立服务器部署

使用 `infra/docker-compose.standalone.yml`，它创建自身 Docker 网络，不使用 `NEXAIM_DOCKER_NETWORK`，不要求和 NexaIM 同机。

在服务器准备工程，单独放置 `.env.production`，以 `.env.example` 为字段参考填写。`WECHAT_APP_ID` 必须对应客户端；API / WS 地址填写客户端也能访问的公开地址。不要把凭据打进镜像或源码包。

```bash
chmod 600 .env.production
docker compose --env-file .env.production -f infra/docker-compose.standalone.yml config --quiet
docker compose --env-file .env.production -f infra/docker-compose.standalone.yml up -d --build --wait
curl --fail http://127.0.0.1:3100/healthz
```

`BUSINESS_HTTP_PORT` 默认 3100，映射到宿主机 `127.0.0.1`；容器内部保持 3100。修改此变量后，相应调整健康检查命令中的宿主机端口。

在客户现有 HTTPS 反向代理中，把自己的业务域名代理到 `http://127.0.0.1:3100`，保留请求路径和 Authorization。域名解析、证书及续期由客户的入口服务管理。此模板不自动配置 DNS 或签发证书。若 Nginx 也在容器内，应为两者安排共享网络，并用服务名连接，容器内的 127.0.0.1 不指向宿主机。

将小程序 `businessBaseUrl` 配成 `https://business.example.com` 这样的客户业务域名，再构建。HTTPS 入口后验证 `/healthz` 和未登录换票拒绝；随后用有效微信 code 验证真实登录。

## 与 NexaIM 同机部署

已有 NexaIM Compose 网络和反向代理时，可以选用 `infra/docker-compose.yml`。它不暴露宿主机端口，而是加入 `NEXAIM_DOCKER_NETWORK` 指定的现有网络。

```bash
docker compose --env-file .env.production -f infra/docker-compose.yml config --quiet
docker compose --env-file .env.production -f infra/docker-compose.yml up -d --build --wait
```

默认网络名 `nexaim_default` 只是示例，必须与实际已有网络一致。入口代理可访问 `http://wechat-demo-api:3100`；同一网络只运行一个这个固定别名的实例。多客户同机部署要为各实例区分 Compose project、网络 / 别名和业务域名，不能仅替换凭据后并排启动相同别名。

## 配置与运维边界

- 两个模板二选一；`.env.production` 都由 `--env-file` 显式选择，不随 `NODE_ENV` 自动加载。
- 容器固定 `HOST=0.0.0.0`、`PORT=3100`、`NODE_ENV=production`。本地 `.env` 的 HOST / PORT 不改变容器内监听。
- 客户服务必须能访问 NexaIM HTTP API 和微信登录接口。NexaIM Gateway / 媒体地址须对客户端可达。
- 镜像只含业务服务端，非 root、只读文件系统，配置健康检查和日志轮转；小程序通过微信开发者工具构建 / 发布。
- 示例业务 session 存在单进程内，暂只部署单实例；重启会使用户重新登录。正式多实例业务接入自身共享会话存储。
- 客户配置和微信私有工程文件不加入 Git。运维查看 Compose 时使用 `config --quiet`，避免打印展开后的密钥。

直接调用接口的顺序与鉴权方式见 [接口接入](direct-api.md)；前端配置见 [快速接入](getting-started.md)。
