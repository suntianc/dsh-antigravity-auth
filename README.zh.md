# dsh-antigravity-auth

> **DSH 兼容性：** `0.1.4-rc.5` 以 DSH `0.2.0-rc.1` 为最低且已测试的开发基线；旧版 DSH 请使用兼容的插件版本。见[验证说明](docs/dsh-source-verification.md)。

[![npm rc version](https://img.shields.io/npm/v/dsh-antigravity-auth/rc.svg?label=npm%20rc)](https://www.npmjs.com/package/dsh-antigravity-auth)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

发布版本：**v0.1.4-rc.5**（npm 标签：`rc`）。

这是一个自包含的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**Antigravity 能力包**。它集成了 Antigravity 的私有 OAuth 登录态与 Wire Identity 线路身份，提供：

- `google-antigravity` LLM 路由（Gemini 3.8/3.7/3.6 Flash、Gemini 3.1 Pro、Claude Opus、Claude Sonnet、GPT-OSS）；
- 接入 DSH 内置 `web_search` 工具的全局 Antigravity 搜索提供方；
- 通过 `generate_image` 实现持久图片生成与编辑，并提供供模型使用的 `list_images` 目录；
- 支持本地工作区 MP4 文件的多模态 `analyze_video` 视频理解；
- 具备优雅动效的 5 小时与每周用量/配额可视化仪表盘；
- 一个原生 **Antigravity Auth** 设置分区，内含「登录」「网页搜索」「图片创作」「视频理解」四张卡片。

设置分区跟随 DSH 界面语言切换中英文，覆盖功能描述、状态标签、功能开关名称和配额刷新提示。

> **⚠️ 非官方通道——仅限个人开发。** 私有、受账户权限控制的 Antigravity
> 后端服务未获官方支持、可随时撤销，也可能在没有通知的情况下被限流或变更。请勿依赖它承载生产任务。

## 0.1.4-rc.5：适配 DSH 0.2.0-rc.1

此版本更新 DSH 依赖图，使用 Config Forms 与 volatile 配置注册功能控制项，向 Connection RPC 传入新版 operator，并将 V4 `tool` 角色消息映射到提供商历史。账号路由保留 Host 侧回环限制。完整包检查与固定源码检查已通过；真实账号和私有传输尚未验证。

## 0.1.4-rc.4：并发搜索取消修复

修复 #35：并发 `web_search` 中一条查询失败后，取消其余等待中的请求不会再触发无人处理的 TLS socket 错误，导致 DSH Host 退出。

## 0.1.4-rc.3：Gemini 工具调用 ID 复用修复

修复 #33：Gemini 在后续调用中复用已完成调用的 ID 时，会话可以继续。前一次调用尚未返回结果时的 ID 复用、无法配对的结果仍明确报错；Claude 与 GPT-OSS 保留现有校验。

## 0.1.4-rc.2：账号切换与 Gemini 历史重放修复

- 通过 `/antigravity-auth` 或 `/anti` 缓存并手动切换本地账号，同一时刻只有一个活动账号。
- 刷新、登出和撤销的迟到结果绑定原凭据，保留其他账号及其能力状态。
- 修复 Gemini thinking/tool signature 历史重放和尾部空文本帧；容量重试仅用于 HTTP 503。
- LLM 错误显示安全的失败分类和 HTTP 状态。DSH 兼容基线继续为 `0.1.5-rc.1`。

## 0.1.4-rc.1：DSH 0.1.5-rc.1 适配

开发依赖、peer 范围、打包检查与对应源码验证目标统一升级至 DSH `0.1.5-rc.1`；离线测试继续覆盖认证、模型、搜索和媒体契约。

开发基线升级到 DSH `0.1.5-rc.1`。Gemini 与 Claude 将 V3 system message 文本保留到 `systemInstruction`；单次调用的 `options.system` 作为前置指令，后接按原顺序排列的系统消息。账号操作迁移到经过认证的 `/api/antigravity-auth/*`，保留原有静态 loopback 限制。终端命令名称不变。

## v0.1.4-alpha.5 重点更新

- 将开发依赖图与 peer 基线迁移到 DSH `0.1.2-alpha.5`，采用当前 Settings、Session、Connection、client injection 与 `ToolCallId` API；本仓库 lockfile 不含旧 DSH 包族。
- 新增经过登录态目录确认的 Gemini 3.8 Flash，默认 Medium，并使用抓取的 Low/Medium/High route、model enum 与 numeric thinking budget。
- 所有私有 Cloud Code `v1internal:` 操作重新对齐已审计的 AGY CLI 1.1.24 wire identity，同时保留强制、真实的 DSH 二级归因。
- 排空成功的 provider terminal SSE framing 与 body，并改用 cancellation-safe async-iterable Web Stream bridge，避免 Node `ERR_INVALID_STATE` 崩溃。
- 在 alpha.5 上保持账号 RPC fail-closed：只有明确绑定 `127.0.0.1` 的 Web Host 才能触达认证服务。

## 功能特性

### 共享 Antigravity 登录态

- LLM、搜索、图片、视频与配额操作共用一个仅运行于 Host 的认证协调器。
- 直连 OAuth 2.0 PKCE S256 流程：Host 内存生成 verifier 与 state 句柄，浏览器仅接收授权链接，密钥绝不跨越 Host 边界。
- 回调监听器仅绑定 `127.0.0.1:51121`，只接受一次性的已注册 code/state 凭据对。
- 通过属主权限文件存储（POSIX `0600`；Windows 用户数据目录 ACL）、短时内存缓存解析凭证，并在到期前主动刷新。
- 进程内合并并发刷新请求；仅在账号与 lineage 未变化时原子提交新 token。
- 仪表盘实时显示连接状态以及 Gemini 与 Claude/GPT 模型家族的 5 小时和每周额度进度条。
- `/antigravity-auth` 绝不向前端泄露 token。DSH alpha.5 下，真实账号 dispatcher 只在明确的 `127.0.0.1` Web bind 上启用；缺失、all-interface 或未知 bind 只能得到不含状态的安全拒绝。

### LLM 路由与模型发现

- 通过 DSH 公开的 `LlmAdapter` 接口注册 `google-antigravity` 提供方。
- 将已审计的 `@cortexkit/antigravity-auth-core@2.2.0` 固定社区模型快照与真实登录账号的可用模型取交集，并规范化服务端返回的 `gemini-3.8-flash-tiered` 目录别名；Gemini 3.8 Flash 使用 AGY 1.1.24 抓取的 Low/Medium/High wire route、numeric thinking budget、model enum、`userAgent` envelope 字段与 Medium 默认档位。
- 当真实模型发现暂时不可用或发生协议漂移时，DSH 内置模型选择器会回退到固定文本模型快照，设置页仍诚实显示 live catalog 状态；该 advisory 降级可能暂时保留 Gemini 3.5 Flash 等旧路由，而成功的 live intersection 会过滤账号目录中不存在的路由。成功但零交集的结果仍保持为空，未登录、授权拒绝、取消与明确的 attribution 拒绝仍保持 fail-closed。
- 流式传输支持首个数据块前的一次认证重放，并支持跨分片提供方函数名的 call-id 稳定关联；成功的 terminal event 会先排空剩余 SSE framing 再向 DSH 完成流，必要的取消路径则使用 Node 的 async-iterable Web Stream bridge，避开存在竞态的 `Readable.toWeb()` 适配器。

### 网页搜索

`antigravity-search` Host 行通过 `@deepseek-ai/dsh-web` 注册 ID 为 `antigravity` 的全局搜索提供方。基于审计过的 Wire Identity 线路分发请求，返回真实 grounding 来源与去重检验过的 HTTP(S) 链接。

### 图片创作与编辑

`generate_image` 为模型提供统一操作接口，分发至 Antigravity 图片端点：

- 支持提示词、最多 5 个显式参考图（会话句柄 `image:<id>` 或工作区路径）及尺寸/比例选项。
- 返回的图片字节经过格式校验、解码、Magic bytes 签名验证并通过 `AttachmentStore` 持久保存。
- `list_images` 提供会话持久图片分页目录，供多模态模型查看。

### 视频理解

多模态 `analyze_video` 工具支持本地工作区 MP4 视频的帧采样与内容文本理解。

### 用量与配额可视化仪表盘

- 直观展示 5 小时窗口与每周窗口的剩余配额比例与刷新倒计时。
- 剩余时间达到 24 小时后按天、小时、分钟显示，例如 `94h 43m` 显示为 `3天 22h 43m`（英文为 `3d 22h 43m`）；不足一天继续使用原有小时/分钟格式。
- 状态三档配色：充足（>60%，翡翠绿）、预警（30%–60%，警示橙）、紧急（<30%，警示红）。
- 配备 Shimmer 微光流动轨道、微型 Spinner 与平滑展开动画。

## 环境要求

- DeepSeek Harness `0.2.0-rc.1`（统一依赖图；npm 与对应源码制品分别验证）。
- Node.js `^22.19.0` 或 `>=24.0.0`。
- `PATH` 中可用 `pnpm`（本项目测试版本为 `11.7.0`）。
- 具有 Antigravity 权限的 Google 账号。

## 安装

先停止 `dsh web`，确认目标 Host 使用统一的 DSH `0.2.0-rc.1` 依赖图，再将此准确预发布版本安装到目标 profile：

```sh
dsh --version
dsh plugin --profile web add --save-exact dsh-antigravity-auth@0.1.4-rc.5
dsh plugin --profile web list
```

核对条目后重启 `dsh web` 并刷新浏览器。此版本通过 npm 的 `rc` 标签发布；不指定版本或标签会使用 `latest`，它不包含本次 DSH 0.2 适配。旧 DSH Host 应保留兼容的旧插件版本。

## 终端登录命令

在提供 DSH `commands` 缝的交互界面上，本 bundle 会注册 `antigravity-auth` slash 命令，作为 Web 设置卡片的替代入口：

```text
/antigravity-auth              # 查看当前登录状态（默认）
/antigravity-auth accounts     # 列出本地缓存的账号
/antigravity-auth switch <id>  # 按序号、id 或邮箱激活缓存账号
/antigravity-auth login        # 启动 Google OAuth 授权流程
/antigravity-auth cancel       # 取消进行中的授权
/antigravity-auth logout       # 登出当前账号并删除其缓存凭据
/antigravity-auth remove <id>  # 删除一个缓存账号（若为当前账号则同时登出）
```

`/anti` 是同一条命令。成功的 `login` 会把新凭据写入本地账号缓存（`accounts.json`），并把它设为 `auth.json` 中的活动账号。同一时刻只有一个账号处于活动状态；其余 refresh token 会留在磁盘上，直到对该账号执行 `logout` 或 `remove`。`logout` 与 Web 上的显式撤销会清空 Host 内存和 `auth.json`，然后只删除**启动该操作的那个账号**。若 coordinator 将撤销标记为 `superseded`（例如在 Google 撤销请求进行期间切换了账号），则不会删除新的活动账号。刷新令牌轮换与可选的 userinfo 邮箱回填绑定到操作开始时捕获的账号身份，而不是显示用邮箱，也不是结果返回时恰好处于活动状态的账号。

账户操作面向本地终端登录入口：在无 DSH WebServer、或显式绑定 `127.0.0.1` 的本地 Host 上执行；仅当 WebServer 在其它网卡上暴露共享的 `commands` 缝时，命令才会在不触碰认证服务的前提下被拒绝。账户 RPC 仍保留其更严格的 ADR-0008 守卫（真实 dispatcher 仅挂在显式 `127.0.0.1` bind 上）。

`login` 会确认非官方通道的风险提示，并启动 loopback OAuth 流程——其临时回调监听器绑定在 `127.0.0.1:51121`，与任何 DSH WebServer 相互独立。随后命令会用尽力而为的平台浏览器开启器打开 Google 登录页；授权链接**不会**被回显到命令结果中，因为 `CommandResult.text` 会被原样写入会话的 `command/done` 事件，而该链接携带 OAuth state 句柄与 PKCE challenge。在 Windows 上开启器为 `cmd /c start "" "<url>"`：URL 带引号且禁用 Node 的参数改写，因此以 `&` 分隔的每个 OAuth 参数都会完整到达浏览器。若开启器无法启动，命令会如实报告该失败且不复现 URL。请在浏览器中完成登录，然后运行 `/antigravity-auth status`。Token、verifier、授权码与回调 URL 绝不会出现在命令输出或会话日志中。DSH 未提供供插件使用的公开瞬时展示/浏览器唤起 API，因此在没有桌面浏览器的 Host 上，无法从终端完成交互式登录。

## Host 配置

能力包 patch 按依赖顺序启用独立的 Host 行：

| 行 | Export | 作用 |
|---|---|---|
| `antigravity-auth` | `dsh-antigravity-auth` | 共享认证协调器与 LLM 路由 |
| `antigravity-search` | `dsh-antigravity-auth/search` | 全局搜索提供方 |
| `antigravity-image` | `dsh-antigravity-auth/image` | 图片生成与编辑工具 |
| `antigravity-video` | `dsh-antigravity-auth/video` | 视频理解工具 |

## Wire Identity（线路身份）

Wire Identity 模块保留已审计的 AGY CLI 1.1.24 content-request User-Agent，并调用 DSH 公开的 `attributionHeaders()` formatter，把真实 DSH 身份放入强制二级 carrier：

```text
X-DeepSeek-Harness-Attribution: deepseek-harness/<version> (+repository-url)
```

请求端点由代码固定：仅接受受信任的 HTTPS Antigravity origin 与枚举的 `v1internal:` 操作路径。

## 安全与限制

- token 值绝不进入前端、设置、日志、会话事件或工具 metadata，仅在 Host 侧发起私有请求时附带认证 header。
- auth、gate evidence 与受控 live image 文件在 POSIX 上严格校验属主 mode；Windows 由 ACL 管理访问权限，因此不把合成的 POSIX group/other bits 作为访问判据，但仍执行 symlink、文件类型、大小、schema 与内容校验。
- 本地多账号缓存与手动切换：`accounts.json` 可保存多个 refresh token，`auth.json` 只保存当前活动记录。不提供额度池、自动账号轮换、身份回退或 fingerprint regeneration。
- 本地登出会清空 Host 内存和 `auth.json`，并删除该账号的缓存凭据，因此无法再用 `switch` 恢复。其余缓存账号保留。撤销是独立的显式动作，清理范围同样只覆盖启动该操作的账号；`superseded` 不能授权删除另一个活动账号。
- 旧账号的刷新、登出或撤销仍在等待时切换账号，会保留新账号的凭据与能力状态。迟到的清理只针对原凭据，不会删除该账号后来重新登录的凭据。
- DSH alpha.5 不再提供逐 method 或 Host 侧 carrier authority。插件只在公开 WebServer bind 恰为 `127.0.0.1` 时启用真实 account RPC；缺失、all-interface 与未知 bind 只返回 `loopback-required`。浏览器在 `ConnectionHandle.isLoopback` 为 false 时也不会注册该设置分区，但该客户端提示仅用于 UX：在 DSH 提供对应 Host 侧事实前，owner-contained 自定义 carrier 仍不能获得授权。
- 原始多媒体 base64 绝不注入会话正文或前端 RPC。

## 本地开发

维护者发布时请遵循[发布规范](docs/release-policy.md)和 [Release 正文模板](docs/release-notes.template.md)，统一标题、中英文说明、发布通道与完成核验。

```sh
pnpm install
pnpm peers check
pnpm test
pnpm run check
```

`pnpm run build` 生成：

- `lib/index.js`：认证 / LLM Host 插件；
- `lib/search.js`：搜索 Host 插件；
- `lib/image.js`：图片 Host 插件；
- `lib/video.js`：视频 Host 插件；
- `lib/quota.js`：配额 Host 插件；
- `lib/wire-identity.js`：Wire Identity 线路身份模块；
- `lib/client.cjs`：浏览器设置端插件；
- `lib/types/**`：TypeScript 类型声明。

## 友情链接

- [LINUX DO (L 站)](https://linux.do/)
