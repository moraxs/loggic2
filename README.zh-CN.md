# logicc2api

[English](README.md) · **简体中文**

为 [Logicc](https://app.logicc.com) 提供 OpenAI 兼容接口的本地代理，内置号池管理和 Web 控制台。将 Logicc 的 AI SDK v6 数据流转换成 OpenAI Chat Completions 响应，集中查看账户状态、流量、模型延迟和请求日志。

使用 Node.js 与原生 HTML/CSS/JavaScript 实现。**零运行时依赖，无需数据库，无需前端构建。** 当前页面为简体中文，同时提供中英文介绍文档。

## 功能

| 模块 | 功能说明 |
| --- | --- |
| OpenAI 兼容接口 | 模型列表、流式及非流式 Chat Completions |
| 号池管理 | 账户增删改、启停、搜索、JSON 批量导入 |
| 凭据刷新 | 按需刷新 Clerk JWT、合并同账户的并发刷新、保存轮换后的 Cookie |
| 账户调度 | 最低并发优先，同等并发轮询，异常账户自动冷却 |
| 运行看板 | 请求趋势、成功率、首字延迟和账户可用性 |
| 模型与日志 | 实时同步模型、统计实际延迟、查看请求详情、筛选和导出 CSV |
| 请求测试 | 发送真实流式请求、选择上游内置工具、停止本地请求 |
| 本地存储 | 重启后保留配置和请求元数据，管理接口不返回原始凭据 |

页面每 5 秒读取本地状态；自动刷新不会调用上游。账号检测和模型同步仅获取模型列表；请求测试会生成内容并消耗上游额度。

## 快速开始

需要 **Node.js 22 或更新版本**，以及可使用的 Logicc 账户与会话。如果不想在宿主机安装 Node.js，可使用下方的 [Docker 部署](#docker-部署)。

```bash
git clone https://github.com/JamesZhaoY/logicc2api.git
cd logicc2api
npm start
```

无需安装依赖，也可以直接执行 `node server.mjs`。

1. 打开 **<http://127.0.0.1:18789/>**，使用 `LOGICC_ADMIN_PASSWORD` 登录；未配置时，首次启动会在终端输出随机管理密码，请保存。
2. 进入 **号池管理 → 添加账户**，填写凭据后点击 **检测**。
3. 在客户端中设置 Base URL 为 **`http://127.0.0.1:18789/v1`**。可在 **API 接入 → 自定义 API Key** 输入或生成 Key，复制保管后保存，立即生效且重启后保留。尚未配置 Key 时，API Key 填任意非空字符串，例如 `local`。

自定义端口：

```bash
node server.mjs 18790
```

直接使用 Node.js 启动时默认监听 `0.0.0.0`，可通过服务器 IP 或域名访问，命令行端口优先于环境变量 `PORT`。

## Docker 部署

需要安装带 Compose 插件的 Docker Engine，或 Docker Desktop。仓库已提供 [Dockerfile](Dockerfile) 和 [compose.yaml](compose.yaml)，镜像从源码在本机构建。

### 使用 Docker Compose 启动

```bash
git clone https://github.com/JamesZhaoY/logicc2api.git
cd logicc2api
docker compose up -d --build --wait
```

如果已经克隆仓库，在项目根目录执行最后一条命令即可。启动后打开 **<http://127.0.0.1:18789/>**，在号池中添加账户，客户端 Base URL 填 **`http://127.0.0.1:18789/v1`**。

镜像基于 Node.js 24 Alpine，使用非 root 的 `node` 用户运行。容器内设置 `LOGICC_HOST=0.0.0.0`，使 Docker 端口转发可以连接服务；Compose 将端口发布到宿主机所有网络接口。镜像通过 `/health` 检查服务是否存活；容器显示 healthy 不代表上游账户已经通过连接检测。

### 修改端口或设置 API Key

在 `compose.yaml` 同级创建本地 `.env` 文件，例如：

```dotenv
LOGICC_PORT=18790
LOGICC_API_KEY=replace-with-your-own-key
LOGICC_ADMIN_PASSWORD=replace-with-your-admin-password
```

```bash
docker compose up -d --wait
```

之后访问 `http://127.0.0.1:18790/`，调用 `/v1/*` 时携带配置的 Bearer Key。这些变量均可省略，默认端口为 `18789`；未配置管理密码时自动生成，未配置 API Key 时不要求 Key。如果本机原有 Node.js 服务已占用 `18789`，请选择其他端口。把配置保存在 `.env` 中，可以保证后续 Compose 命令使用同一组设置。Compose 通过[环境变量插值](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)读取配置；该文件被 Git 忽略，也不会进入镜像构建。

控制台和管理接口需要管理员登录。API Key 保护 `/v1/*`，与管理密码独立；前端保存的 Key 优先于 `LOGICC_API_KEY`。可使用不同的容器内外端口或反向代理域名。

### 数据、日志与更新

Compose 将 `/app/data` 保存到命名卷 `logicc2api_logicc-data`；使用 `-p` 自定义项目名时，卷名为 `<项目名>_logicc-data`。容器重建后，账户、请求记录和轮换后的凭据仍会保留。镜像构建会排除本地 `data/`、`.env`、日志和备份，不会自动导入原有 Node.js 实例的数据；新容器请通过控制台添加账户。

```bash
# 查看状态和日志
docker compose ps
docker compose logs -f --tail=100 logicc2api

# 更新源码并重建，继续使用原有数据卷
git pull --ff-only
docker compose up -d --build --wait

# 停止并移除容器，保留号池数据
docker compose down
```

只有确定要删除号池数据时，才给 `docker compose down` 添加 `--volumes` / `-v`。命名卷行为可参考 [Docker 数据卷文档](https://docs.docker.com/engine/storage/volumes/)。

部署在远程服务器时，可直接通过服务器 IP 访问；也可将 `LOGICC_HOST` 设为 `127.0.0.1`（Compose 需同时限制宿主机端口绑定），并通过 SSH 隧道访问：

```bash
ssh -N -L 18789:127.0.0.1:18789 your-user@your-server
```

然后在电脑上打开 `http://127.0.0.1:18789/`。如果修改了端口，请同步调整两处端口号。控制台允许同源的 IP / 域名访问，管理接口需要登录；通过公网部署时请使用 HTTPS 反向代理保护密码与会话。

## 账户凭据

添加账户时支持以下任一种组合：

| 输入 | 行为 |
| --- | --- |
| `__client` Cookie + Session ID | 按需获取新的 Session JWT |
| `__client` Cookie + Session JWT | 从 JWT 的 `sid` 中读取 Session ID，再按需刷新 |
| 仅 Session JWT | 有效期内可用；到期后手动替换，或通过 `/__set_token` 推送新 JWT |

在已登录 Logicc 的浏览器中，打开开发者工具 → Application → Cookies → `clerk.logicc.com`，复制 `__client` 的 **Value**。Session ID 以 `sess_` 开头。也可在 Logicc 页面的 Console 获取 Session JWT：

```js
await window.Clerk.session.getToken({ skipCache: true })
```

`__session` Cookie 保存的是短期 Session JWT，与 `__client` 不是同一种凭据。会话被注销、撤销等情况仍需更新凭据，自动刷新不代表永久有效。

编辑时留空的凭据字段会保留已有值。更换客户端 Cookie 或 Session ID 会清除旧 JWT 缓存。启停和移除仅作用于本地号池，不会删除上游账户。

### 批量导入

在 **批量导入** 中粘贴 JSON 数组或上传 JSON 文件：

```json
[
  {
    "name": "工作账户",
    "clientCookie": "YOUR_CLIENT_COOKIE",
    "sessionId": "sess_YOUR_SESSION_ID",
    "enabled": true
  }
]
```

也支持 `{ "accounts": [...] }`。仅使用 JWT 时，每项填写 `name` 和 `token`。号池最多 200 个账户，相同 Session ID 不重复导入；整批校验通过后保存，校验失败不会部分写入。

## API 调用

### 获取模型列表

```bash
curl http://127.0.0.1:18789/v1/models \
  -H 'Authorization: Bearer local'
```

模型列表从选中的上游账户获取，不在代码中固定。

### 非流式响应

```bash
curl http://127.0.0.1:18789/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "用一句话打个招呼。"}]
  }'
```

### 流式响应

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer local' \
  -d '{
    "model": "default",
    "stream": true,
    "stream_options": {"include_usage": true},
    "messages": [{"role": "user", "content": "用一句话打个招呼。"}]
  }'
```

`model` 省略或为 `default` 时，选择上游默认模型，没有默认项则使用第一个模型。流式返回 `chat.completion.chunk`，以 `[DONE]` 结束；省略 `stream` 或设为 `false` 则返回完整 JSON。

上游提供 token 用量时会转换返回；未提供时，API 兼容响应的计数填零，控制台明确显示用量不可用，不估算用量。

### 工具映射与兼容范围

- `reasoning_effort` 透传给上游。
- 函数名 `web_search` / `web-search` 映射到上游内置工具 `web-search`；`image_generation` / `image-generation` 映射到 `image-generation`。实际可用性取决于账户和模型。
- 其他函数定义以 JSON Schema 约定加入提示词，**尚未实现标准 OpenAI `tool_calls` 执行协议**。上游工具事件以 `[tool:web-search]` 等文本标记呈现。
- 每次请求新建上游聊天，多轮消息合并为单条提示词，不保留上游原生多轮会话状态。
- 附件未透传；图片工具输出在测试页面中以文本形式展示。
- 实现了 `/v1/models` 和 `/v1/chat/completions`，并非完整 OpenAI API。

## 调度与刷新行为

- 从已启用、符合调度条件的账户中，优先选择正在处理请求数最少的账户；同等并发采用轮询。同一次聊天固定使用一个账户。
- HTTP 429 冷却 60 秒，401 / 403 冷却 5 分钟，上游服务错误冷却 15 秒。后续请求跳过冷却账户。
- 冷却结束后，符合条件的账户可参与下一次请求；也可主动检测或更新账户。失败的单次请求不会跨账户重放。
- JWT 剩余寿命少于 10 秒时按需刷新；上游返回 401 时强制刷新并重试一次。
- 同一账户的并发刷新会合并；Clerk 返回新 `__client` Cookie 时自动保存。
- Clerk 刷新端点为 `POST /v1/client/sessions/{sid}/tokens`。

## 配置与数据

| 环境变量 | 用途 |
| --- | --- |
| `PORT` | 监听端口，默认 `18789` |
| `LOGICC_HOST` | 监听地址；默认 `0.0.0.0`，设置 `127.0.0.1` 可限制为本机访问 |
| `LOGICC_DATA_FILE` | 数据文件路径，默认项目目录下 `data/state.json` |
| `LOGICC_API_KEY` | 初始 Bearer Key；前端保存的自定义 Key 优先，旧 Key 随即失效 |
| `LOGICC_ADMIN_PASSWORD` | 控制台初始管理密码；面板保存的密码优先。未配置时首次启动自动生成并输出 |
| `LOGICC_API_BASE` | 上游基址，默认 `https://app.logicc.com/api` |
| `LOGICC_CLERK_BASE` | Clerk 基址，默认 `https://clerk.logicc.com` |
| `LOGICC_CLIENT_COOKIE` | 号池为空时导入默认账户 |
| `LOGICC_SESSION_ID` | 环境变量导入账户的 Session ID，也可从 JWT 中读取 |
| `LOGICC_TOKEN` | 环境变量导入账户的初始 JWT |
| `LOGICC_TOKEN_FILE` | 环境变量导入账户使用的外部 JWT 文件 |
| `LOGICC_TOKEN_CMD` | 该账户的外部 JWT 刷新命令，仅从进程环境读取，页面不可配置 |

直接使用 Node.js 启动时，程序不自动加载 `.env` 文件。请在 shell 中导出环境变量，或在支持的 Node.js 版本中使用 `node --env-file=.env server.mjs` 启动。Docker Compose 会读取 `.env` 并映射上文的 `LOGICC_PORT`、`LOGICC_API_KEY` 和 `LOGICC_ADMIN_PASSWORD`；`LOGICC_PORT` 仅用于 Compose，不是 Node.js 服务直接读取的变量。如需其他环境变量，应显式添加到 Compose 服务配置中。

已有账户数据优先于初始环境凭据，避免旧环境变量覆盖已轮换的 Cookie。使用外部刷新命令或 JWT 文件的账户，重启时仍需提供相应配置。

`data/state.json` 保存账户凭据、缓存模型目录、冷却时间及最多 2,000 条请求元数据。采用临时文件写入后重命名，文件请求权限为 `0600`；其中凭据为 **明文**，权限保护效果取决于操作系统。运行数据、环境文件、日志、备份和浏览器测试产物均排除在 Git 之外。

看板统计保留记录中最近 24 小时的聊天请求。模型同步与账号检测显示在日志中，不计入聊天指标。日志页展示最近 200 条记录。首字延迟包含凭据刷新、建立聊天和网络传输耗时；请求日志不保存提示词与生成的回答。

控制台面向 **单进程使用**，管理员通过密码登录，使用 HttpOnly、SameSite=Strict 会话 Cookie，有效期 12 小时；退出或服务重启后需重新登录。管理接口还要求同源请求及 `X-Logicc-Admin: 1`，连续登录失败会触发限流。自动生成的管理密码和前端保存的 API Key 仅保存加盐摘要，不通过状态接口返回；点击控制台右上角 **修改密码**，输入当前密码、新密码（8–512 个字符）并确认后保存。新密码以加盐摘要写入数据文件，立即生效，重启后优先于 `LOGICC_ADMIN_PASSWORD`；修改后所有会话失效，需要重新登录。

管理密码遗失时，先停止服务并备份数据文件，删除 `settings.adminPassword` 字段，再设置 `LOGICC_ADMIN_PASSWORD` 并重启；保留账户及其他配置。

兼容入口 `POST /__set_token` 接收原始 JWT，可附加 `?account_id=<id>`，按 JWT 的 Session ID 匹配账户。该入口同样需要管理认证；Logicc 页面推送时携带 `X-Logicc-Password: <管理密码>`，预检允许该请求头。

不要让多个实例同时写入同一数据文件。独立实例请分别配置端口和 `LOGICC_DATA_FILE`。

## 开发与验证

```bash
npm test
```

使用 Node 内置测试框架和本机模拟上游，覆盖账户增删改与整批导入、凭据脱敏和文件权限、轮询与冷却、强制刷新与 Cookie 轮换、并发刷新合并、JSON/SSE 转换、工具透传、用量与错误统计、来源限制和异常输入。测试无需真实凭据，不消耗上游额度。

```text
server.mjs              HTTP 路由、上游调用和协议转换
pool.mjs                账户存储、凭据刷新、调度和统计
public/                 无需构建的 Web 控制台
test/adapter.test.mjs    集成与协议测试
Dockerfile              非 root 容器镜像和健康检查
compose.yaml            本机端口映射与号池数据持久化
```

## 许可证

[MIT](LICENSE) © 2026 JamesZhaoY。
