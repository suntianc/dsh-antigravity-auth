# Specification: Antigravity OAuth Capability Bundle

> **当前兼容性决策（Issue #42）：** 已发布插件的 DSH peer 使用 `*`，不按 DSH 版本限制安装；开发和验证依赖图固定为 DSH `0.2.1-rc.5`、Cordis `4.0.5` 与 Schemastery `3.18.5`。版本声明不代表其他 DSH 版本经过验证。本说明覆盖下文历史版本基线与范围的描述。

## Problem Statement

用户希望在 DeepSeek Harness（DSH）中使用自己的 Google Antigravity 账号权益，并获得与现有 Codex capability bundle 对齐的登录、LLM、Web Search、图片生成与编辑、图片列表、用量状态和设置体验，同时增加视频理解能力。本地可缓存多个账号并手动切换当前活动账号；同一时刻只有一个账号对 LLM、Search、Image、Video 与 Quota 生效。

现有可选路径不能满足这一目标：AI Studio API key 与 Vertex ADC 不消费 Antigravity 权益；官方 `agy` 子进程桥不是用户希望的集成形态；社区实现虽然公开了 Antigravity OAuth、私有 Cloud Code transport、模型、Search、Image 和 quota contract，但这些 contract 属于逆向、非官方且可能随时变化。

实现还面临一个 DSH interface 冲突：Antigravity private transport 需要固定模拟已审计版本的 `agy` User-Agent/framing，而当前 `LlmAdapter` interface 要求每个 provider request 使用 DSH `attributionHeaders()`，其默认 carrier 也是 `User-Agent`。本项目不修改或替换 DSH core；插件自有 Wire Identity module 保留 exact `agy` User-Agent，并调用公开 `attributionHeaders()` 取得真实 DSH identity value，将其放入固定的 `X-DeepSeek-Harness-Attribution` secondary carrier。该 carrier adaptation 被明确标记为 private experimental compatibility policy，而不是 DSH 全局 interface 变更。

用户已经确认以下产品方向：

- 主路径是 Antigravity OAuth + private Cloud Code 模拟，不是 `agy` subprocess bridge；当前活动账号只有一个，本地可缓存多个账号并手动切换；
- private request 固定模拟 `agy` wire identity，不先尝试 DSH 默认 User-Agent；
- 允许 Host-only 本地多账号缓存与手动切换；不做自动账号轮换、quota pool、identity fallback 或 fingerprint regeneration；
- 保留现有 DSH LLM runtime，不修改 DSH core；在插件内部集中实现 provider-required User-Agent 与 DSH secondary attribution carrier；
- Google 已明确禁止第三方软件使用 Antigravity 登录，因此该能力只能作为 private、unofficial、reverse-engineered、experimental self-use；公开发布为 NO-GO；
- 任何真实 OAuth 或 private endpoint 调用都必须在实现之外再次得到用户明确授权。

## Solution

构建一个 private DSH capability bundle `dsh-antigravity-auth`，通过 Host-only OAuth module 管理本地账号缓存与当前活动凭据，通过自有 `AntigravityAdapter` 接入 DSH `LlmAdapter` seam，并通过 DSH 的 Web、Tool、Attachment、Filesystem、Settings 与 typed loopback RPC interfaces 提供 Search、Image、Video POC、Usage 和客户端状态体验。

插件直接实现一个 Host-only Wire Identity module：它为 private Cloud Code 固定 exact provider User-Agent/framing，调用公开 `attributionHeaders()` 得到真实 DSH application identity value，并通过固定的 `X-DeepSeek-Harness-Attribution` header 携带该值。插件不替换整个 `ctx.llm` module、不修改 DSH core、不 patch installed packages，也不通过 Tool 绕过 LLM adapter seam。

插件将固定依赖已审计版本的 community Antigravity core，只复用 endpoint/OAuth metadata、raw transport、request metadata、model registry、transform 与 quota pure/public surfaces。它不会启用 community AccountManager、community rotation、quota-style fallback、automatic onboarding、hard-coded project fallback、fingerprint regeneration 或 signature bypass sentinel。插件自有的 `accounts.json` 只保存本地 refresh token 缓存并支持显式切换，不是额度池或自动 failover。

所有 secret-bearing private requests 由一个 Host-only Wire Identity module 统一构造 headers/framing。OAuth code/verifier/token、private response bodies 和媒体 base64 永不进入客户端、RPC、settings、日志或 fixture。默认 CI 只运行 mock/fixture；live gates 独立 opt-in，并按 OAuth、attribution/text、LLM、Search、Image、Video 顺序最小化执行。

开发与验证基线升级为 DSH `0.1.2-alpha.5`。直接 DSH peer range 从 `^0.1.2-alpha.5` 开始，开发依赖与 lockfile 使用 coherent exact alpha.5 graph，并同步 Cordis `4.0.2` 与 Schemastery `3.18.2`；干净安装必须通过 `pnpm peers check`。插件使用 alpha.5 的 `ToolCallId`、`ctx.settings.installSection()`、Session snapshot accessor 和新的 Connection/client package topology。由于 alpha.5 移除了逐 RPC method 与 Host 侧 carrier authority，只有明确的 `127.0.0.1` Web bind 启用真实 account dispatcher；缺失、all-interface 或未知 Web bind 只注册 value-free `loopback-required` stub，客户端同时按公开 `ConnectionHandle.isLoopback` 隐藏非 loopback account UI。客户端 hint 不是授权事实，owner-contained 自定义 carrier 在上游提供对应 Host seam 前仍 fail closed。

## User Stories

1. As a DSH 用户, I want 使用自己的 Antigravity 账号登录, so that 我可以在 DSH 中使用该账号的 Antigravity 权益。
2. As a DSH 用户, I want 在登录前看到醒目的 unofficial 与账号封禁风险提示, so that 我能在知情的情况下决定是否继续。
3. As a DSH 用户, I want 明确确认风险后才生成授权链接, so that 插件不会在未经确认时接触我的 Google 账号。
4. As a DSH 用户, I want 通过标准浏览器完成 Google authorization-code flow, so that 我不需要向 DSH 输入账号密码或 cookie。
5. As a DSH 用户, I want OAuth 使用 PKCE S256, so that 截获 authorization code 的本地进程不能在没有 verifier 时交换 token。
6. As a DSH 用户, I want OAuth state 是高熵、短时、一次性的随机句柄, so that verifier 和 project metadata 不会出现在浏览器 URL 中。
7. As a DSH 用户, I want callback listener 只绑定 loopback, so that OAuth callback 不会暴露给局域网或公网。
8. As a DSH 用户, I want callback 严格验证 method、path、Host、state 和参数唯一性, so that 非预期本地请求不能完成登录。
9. As a DSH 用户, I want 固定 callback 端口被占用时看到明确失败, so that 插件不会偷偷改用一个 OAuth application 未注册的端口。
10. As a 远程 DSH 用户, I want 能把完整 callback URL 一次性提交给 Host, so that 我无需把 listener 绑定到 `0.0.0.0`。
11. As a DSH 用户, I want 能取消或超时一个 pending login, so that verifier 和 listener 会被及时释放。
12. As a DSH 用户, I want access token 只驻留 Host memory, so that 重启后的长期凭据暴露面保持最小。
13. As a DSH 用户, I want refresh token 存在 owner-only 的 plugin-owned auth store, so that 其它本地用户不能读取它。
14. As a DSH 用户, I want 活动凭据 store 使用结构化、版本化的单记录 schema, so that 升级和损坏检测不依赖易错的分隔字符串。
15. As a DSH 用户, I want 新登录只在 exchange 和 project validation 成功后替换旧凭据, so that 一次失败登录不会让我失去现有可用状态。
16. As a DSH 用户, I want refresh 请求进程内合并且跨进程按 revision 协调, so that 并发请求不会覆盖 rotated refresh token。
17. As a DSH 用户, I want `invalid_grant` 明确要求重新登录而不是删除所有诊断状态, so that 我知道恢复动作是什么。
18. As a DSH 用户, I want local logout 只清理本地凭据, so that 我可以不撤销整个 Google grant 地停止使用插件。
19. As a DSH 用户, I want revoke 是独立的显式动作, so that 我不会误撤销同一 OAuth grant 的其它会话。
20. As a DSH 用户, I want 状态页只显示掩码邮箱、登录状态、过期时间和 project availability, so that token 与完整 project identity 不会进入浏览器。
21. As a DSH 用户, I want 能列出并手动切换本地缓存的账号, so that 我可以在多个 Google 账号之间改当前活动凭据，而不会把它们合成额度池或自动轮换。
22. As a DSH 用户, I want 登录后只执行 read-only project discovery, so that 插件不会在我不知情时创建或 provision Google Cloud resources。
23. As a DSH 用户, I want project discovery 无结果时得到 `project-unavailable`, so that 插件不会使用 community hard-coded fallback project。
24. As a DSH 用户, I want automatic onboarding 永远不由 login 或第一条 prompt 触发, so that 有副作用的项目创建保持独立决策。
25. As a 插件维护者, I want 保留现有 `ctx.llm` runtime, so that registry、stream、retry 与 model discovery 不需要被插件重新实现。
26. As a 插件维护者, I want 一个 plugin-owned Wire Identity module, so that provider-required User-Agent 与真实 DSH identity 可以同时出现在 private request wire 上。
27. As a 插件维护者, I want Wire Identity module 调用公开 `attributionHeaders()` 获取 DSH identity value, so that 插件不复制或伪造 DSH application identity formatter。
28. As a 插件维护者, I want secondary attribution carrier 的 header 名和值格式固定, so that observability、tests 和下游审计有稳定 interface。
29. As a 安全审阅者, I want provider User-Agent 与 secondary identity value 都经过 header-safe validation, so that CRLF、控制字符和 per-request identity 注入被拒绝。
30. As a 安全审阅者, I want private callers 无法省略或覆盖 DSH secondary attribution, so that plugin-owned policy 不会成为通用隐身开关。
31. As a 插件维护者, I want 所有 private operations 使用同一个 Wire Identity module, so that Search、Image、Video、Quota 与 LLM 不会产生身份漂移。
32. As a 插件维护者, I want 插件以 DSH `0.1.2-alpha.5` 为最低和测试基线并保持 coherent peer graph, so that 不兼容或混合 prerelease family 会在安装检查时 fail-loud。
33. As a 插件维护者, I want 所有 private requests 通过一个 Wire Identity module, so that exact `agy` identity 与 DSH attribution 不会散落在多个 callers 中。
34. As a 插件维护者, I want 固定 community core 版本和 lockfile integrity, so that OAuth metadata 与 wire identity 不会被无审计升级改变。
35. As a 安全审阅者, I want private endpoint 是不可配置 allowlist, so that用户不能把 Bearer token 发送到任意 host。
36. As a 安全审阅者, I want exact `agy` identity 不做版本轮换或 fingerprint regeneration, so that插件行为稳定且不实现反检测策略池。
37. As a 安全审阅者, I want endpoint 拒绝 secondary attribution header 时立即停止, so that插件不会自动降级成无 DSH attribution 的请求。
38. As a DSH 用户, I want private transport 支持 AbortSignal、header timeout、idle timeout 和 total timeout, so that挂起请求能被可靠取消。
39. As a DSH 用户, I want response、SSE frame、JSON depth、base64 与媒体字节都有上限, so that恶意或漂移 response 不会耗尽 Host 资源。
40. As a DSH 用户, I want protocol drift 返回稳定错误码, so that我不会看到内部 stack、raw provider body 或 token。
41. As a DSH 用户, I want 在模型选择器中看到账号实际可用的 Antigravity 模型, so that我不会选择已知不可用 route。
42. As a DSH 用户, I want catalog snapshot 与 live availability 被明确区分, so that community registry 不会被误当成账号实时能力。
43. As a DSH 用户, I want 普通文本 prompt 通过 `google-antigravity` provider 流式返回, so that体验与其它 DSH LLM providers 一致。
44. As a DSH 用户, I want reasoning delta 映射为 DSH reasoning blocks, so that我可以看到支持模型的思考输出。
45. As a DSH 用户, I want function declarations 与 tool calls 在 DSH tool loop 中工作, so that Antigravity 模型可以调用已注册工具。
46. As a DSH 用户, I want tool-call arguments 保持 raw JSON 并经过完整 assembly, so that分片 SSE 不会产生损坏参数。
47. As a DSH 用户, I want usage 在 terminal finish 前发布, so that DSH stream consumers 得到完整 token accounting。
48. As a DSH 用户, I want provider finish reason 映射到标准 DSH finish reason, so that agent loop 能正确决定是否继续。
49. As a DSH 用户, I want 同模型续聊保留 thinking/tool signatures, so that private endpoint 能验证历史上下文。
50. As a DSH 用户, I want fork、compaction 或跨模型历史安全降级, so that过期 signature 不会被错误重放。
51. As a 安全审阅者, I want 插件拒绝 signature-validation bypass sentinel, so that缺失 metadata 不会通过伪造值绕过验证。
52. As a DSH 用户, I want message 中的 durable images 被读取并发送为 bounded inlineData, so that支持多模态的 Antigravity 模型可以理解图片。
53. As a DSH 用户, I want 一次 401 在没有输出 delta 时协调 refresh 后最多重放一次, so that凭据过期可恢复且不会重复生成。
54. As a DSH 用户, I want 429 不切账号、quota style、endpoint identity 或 model pool, so that插件不会规避额度限制。
55. As a DSH 用户, I want dispatch 是否已被接受不明确时不自动重试, so that我不会被重复计量或得到重复 tool call。
56. As a DSH 用户, I want Gemini、Claude 与 GPT-OSS model families 分别通过 fixture gate, so that一个 family 的成功不会被误当成全部模型兼容。
57. As a DSH 用户, I want Web Search 使用独立 grounded private request, so that native search 不会与普通 function declarations 冲突。
58. As a DSH 用户, I want Search 只从真实 grounding metadata 产生 sources, so that插件不会生成虚构链接。
59. As a DSH 用户, I want Search sources 做 HTTP(S) validation、去重和 maxResults 截断, so that返回结果安全且符合 DSH interface。
60. As a DSH 用户, I want 没有 source metadata 的 Search 明确失败, so that文本摘要不会冒充有引用的结果。
61. As a DSH 用户, I want Search cancellation 能终止 active body 与 retry delay, so that取消操作立即生效。
62. As a DSH 用户, I want 插件不把 private `urlContext` 伪装成通用 WebFetchProvider, so that调用者不会误以为能得到真实 HTTP status/body contract。
63. As a DSH 用户, I want 使用 prompt 生成图片, so that我可以在 DSH 会话中直接获得 Antigravity image artifact。
64. As a DSH 用户, I want 使用 session-authorized image handle 编辑图片, so that插件不会读取未授权 attachment。
65. As a DSH 用户, I want 使用 workspace image 前经过 filesystem containment 与 byte limit, so that图片编辑不会绕过 DSH filesystem policy。
66. As a DSH 用户, I want generated inlineData 经过 base64、MIME、magic、decode 与 pixel admission, so that损坏或伪造图片不会进入 durable store。
67. As a DSH 用户, I want generated images 只通过 AttachmentStore 保存, so that会话、fork、resume 和 gallery 使用统一 durable reference。
68. As a DSH 用户, I want `list_images` 只返回当前 session 授权的 image handles, so that其它会话的图片不会泄露。
69. As a DSH 用户, I want 未被 private contract 证明的 image option 明确报 unsupported, so that size、quality 或 transparency 不会被静默忽略。
70. As a DSH 用户, I want 多图请求的部分成功带 warning 且不自动重试, so that我能理解实际生成数量与可能计量。
71. As a DSH 用户, I want 在 Video gate 通过后分析短 workspace MP4, so that我可以获得额外的视频理解能力。
72. As a DSH 用户, I want Video tool 只接受 containment 内 regular file 与允许的 magic MIME, so that任意路径、symlink 或伪造扩展名不会被上传。
73. As a DSH 用户, I want Video POC 询问只存在于 MP4 帧像素、不能从文件名、大小或容器 metadata 推导的事实, so that通过 gate 能证明 model 实际读取了媒体。
74. As a DSH 用户, I want Video 结果只返回文本和 usage, so that原始视频 bytes、路径和 base64 不进入 session log。
75. As a DSH 用户, I want private endpoint 拒绝 video modality 时看到 `unsupported-video`, so that插件不会把 public Gemini API 能力冒充为 Antigravity 权益。
76. As a DSH 用户, I want 抽帧降级被明确命名为 frame sampling, so that它不会被宣传为完整视频、音频或时间轴理解。
77. As a DSH 用户, I want 在 DSH 尚无 video attachment interface 时只使用 workspace tool, so that插件不会自行发明不兼容的 session block。
78. As a DSH 用户, I want 查看单账号的 5h/weekly quota windows、remaining 与 reset time, so that我可以了解当前 Antigravity 使用状态。
79. As a DSH 用户, I want quota 数据被规范化并删除 raw project/provider payload, so that状态 UI 不泄露内部 identifiers。
80. As a DSH 用户, I want quota refresh 有最小间隔且 429 不重试风暴, so that状态卡不会额外消耗或触发风控。
81. As a DSH 用户, I want Auth、Search、Image、Video 与 Usage 设置分别显示 Available、Disabled、POC pending 或 Protocol drift, so that未通过能力不会被伪装成已支持。
82. As a DSH 用户, I want 客户端没有任何 token、client secret 或 editable endpoint 字段, so that浏览器 compromise 不会直接获得长期凭据。
83. As a DSH 用户, I want typed loopback RPC 对 request 与 response 都做 schema validation, so that畸形 client payload 不会穿过 Host interface。
84. As a DSH 用户, I want client unmount 或取消操作释放 listener 与 pending request, so that插件不会遗留后台资源。
85. As a 插件维护者, I want Auth/LLM、Search、Image、Video 作为独立 Cordis rows, so that未通过 gate 的 capability 可以不注册而不影响状态卡。
86. As a 插件维护者, I want package exports、Host/client builds、bundle metadata 和 smoke tests 对齐 DSH 插件约定, so that安装后的 artifact 能被 DSH 正确加载。
87. As a 插件维护者, I want README 中英文版本都披露 unofficial、Terms 风险、本地多账号缓存与手动切换（非额度池）以及 gate 状态, so that用户不会误解支持等级。
88. As a 插件维护者, I want 默认 CI 完全无网络且不读取真实 auth files, so that贡献者运行测试不会触发账号操作。
89. As a 插件维护者, I want live tests 只能通过显式环境开关逐 gate 运行, so that一次测试命令不会批量调用 private endpoints。
90. As a 项目所有者, I want package 与 repository 保持 private 且不执行 npm publish, so that实验性实现不会被误当成公开支持产品。

## Implementation Decisions

### Workstreams and dependency order

- 所有实现都位于 `dsh-antigravity-auth` capability bundle；DSH core repository、runtime packages 与用户 profile 保持不变。
- 不创建替代整个 `ctx.llm` 的 Cordis plugin，不使用 package-manager override，不 patch installed packages，也不复制 DSH core implementation。
- 插件通过现有 `LlmAdapter` seam 注册自有 provider，并把 exact provider identity 与 DSH secondary attribution 的 carrier adaptation 限制在插件内部。
- DSH compatibility baseline 是 `0.1.2-alpha.5`：所有直接 DSH peers 使用 `^0.1.2-alpha.5`，开发依赖固定 exact alpha.5、Cordis `4.0.2`、Schemastery `3.18.2`，lockfile 不允许混入其它 DSH prerelease family；每个后续 issue 都在该基线上开发。
- 该升级是独立 compatibility prefactor：在已完成的 credential lifecycle 后执行；它迁移公开 API owner 与包 topology，但不重新打开已实现的 capability shell/bootstrap scope。
- alpha.5 的 `ToolCallId`、Settings service method、Session snapshot accessors、Connection result types 与 client Context/UI owner packages 是当前接口；本插件仍保留自有 private transport 与 `AttachmentStore.readImage()`，不为未使用的 DeepSeek Files 或 PiAiAdapter seam 增加 speculative adapters。
- `dsh-antigravity-auth` 保持 private。发布 npm、安装到 live profile、真实 OAuth 与 private endpoint probe 都不是完成本 spec 的默认动作。

### Plugin-owned wire identity interface

- Wire Identity module 一次性构造 provider-required User-Agent 与 DSH secondary attribution carrier，是所有 private operations 的唯一 identity seam。
- provider User-Agent 是固定 community snapshot 中已审计的 AGY CLI 1.1.24 静态 identity，并经过 HTTP header safety validation；content request 不携带 obsolete desktop `X-Goog-Api-Client` / `Client-Metadata` headers，空值、控制字符、CR/LF 与 per-request user input 被拒绝。
- module 调用公开 `attributionHeaders()`，读取其格式化后的真实 DSH identity value，并将该值放入固定的 `X-DeepSeek-Harness-Attribution` carrier；不复制 formatter、不伪造 AppIdentity。
- module 总是返回 provider `User-Agent` 与 secondary attribution 两个 headers，调用方不能要求省略、重命名或覆盖 secondary carrier。
- 现有 DSH `attributionHeaders()`、`LlmAdapter`、PiAiAdapter 与所有 core packages 均不修改。
- interface 不提供 arbitrary header names、identity suppression、动态 per-request product、silent fallback 或全局 mode switch。
- 该 carrier adaptation 作为 private experimental plugin policy 被明确记录；如果目标 DSH 版本或 endpoint 不接受它，Gate 0 失败而不是修改 core 或静默删除 attribution。

### Plugin module design

- **OAuth Flow module** 是深 module：对 callers 只暴露 start、complete-manual-callback、cancel 和 status；内部隐藏 PKCE、state registry、listener、exchange、timeout 与 callback validation。
- **Auth Store module** 对 callers 只暴露 read、commit、clear 与 revision-aware compare-and-commit；内部隐藏 permissions、atomic write、directory durability、locking 和 schema migration。
- **Credential Coordinator module** 对 callers 只暴露 current credential；内部隐藏 access-token memory cache、refresh single-flight、cross-process lineage、refresh-token rotation 与 `invalid_grant` state。
- **Project Context module** 只执行 read-only `loadCodeAssist` discovery。第一版没有 onboarding interface，也没有 fallback project input。
- **Wire Identity module** 是所有 secret-bearing private requests 的唯一 header/framing owner。它固定 community snapshot 中的 `agy` identity，调用公开 `attributionHeaders()` 获取 DSH identity value，映射到 plugin-owned secondary carrier，并将两种 identity 交给 raw transport。
- **Private Client module** 对上层暴露按语义命名的 generate、grounded-search、quota、available-models 和 project-discovery operations；内部隐藏 endpoint allowlist、Bearer injection、HTTP/1.1 framing、gzip/chunked handling、timeouts、SSE parsing、limits 与 error redaction。
- **LLM Adapter** 直接满足 DSH `LlmAdapter` interface；不继承 PiAiAdapter，因为 community Pi package 没有可供 DSH 使用的 Provider factory，而标准 pi-ai Google provider 使用不同 endpoint 与 credential contract。
- **Replay module** 独占 private thinking/tool signature serialization。ReplayEnvelope 的 response 保存版本、wire model、request id 与 native finish reason；blocks 按 DSH first-seen block 顺序保存对应 signature metadata。
- **Search Adapter** 满足 DSH `WebSearchProvider` interface，并发送与普通 tool declarations 分离的 grounded request。它不注册 WebFetchProvider。
- **Image Tools module** 通过 DSH Tool interface 提供 `generate_image` 和 `list_images`，并依赖 AttachmentStore 与 Filesystem interfaces，而不是私有 disk directory。
- **Video Tool module** 只在 Gate V 通过后注册 workspace-path 视频理解。它不新增 session video block，也不实现视频生成。
- **Usage module** 返回 normalized、value-free quota snapshot，不暴露 raw response、token 或 exact project id。
- **RPC module** 使用 typed account contract，客户端只得到授权 URL、一次性 flow metadata、value-free status/usage 和结构化错误。alpha.5 下由 plugin-owned Host activation guard 保持 loopback policy：只有明确的 `127.0.0.1` Web bind 使用真实 dispatcher；缺失或其它 bind 永远只到达 inert `loopback-required` stub。
- **Client module** 提供 Auth、Search、Image、Video、Usage settings views；未通过 gate 的 capability 必须显示原因而不是假装可用，且 `ConnectionHandle.isLoopback` 为 false 时不注册 account settings section。该 UI gate 只用于收敛可见面，Host guard 才是执行边界。

### OAuth and credential decisions

- OAuth application metadata、scopes、fixed redirect 与 token endpoints 来自固定 community core snapshot；spec、issue、logs 和 UI 不重复 client id/client secret 具体字符串。
- Authorization request 按 OAuth 2.0 authorization-code-with-PKCE profile 包含 client identifier、redirect URI、requested scopes、PKCE challenge 与 random state；token-exchange metadata 只在 Host 使用。
- state 是 256-bit random handle，不携带 verifier、project 或 account data。Pending flow 只存在 Host memory，默认五分钟，一次消费；进程重启使其失效。
- listener 只在 pending login 期间绑定 loopback；固定 callback 端口冲突直接失败，不改绑 `0.0.0.0` 或随机端口。
- callback 在 state 被原子消费后才执行 token exchange；只有 exchange、project validation 和 auth-store commit 全部成功，浏览器才显示 success。
- auth store（`auth.json`）是单个 versioned record，保存当前活动账号的 refresh token、可选 project metadata、可选 masked-display email、revision 与 update time。Access token 不持久化。Gate evidence 绑定该 record 的 login lineage；替换 commit 是线性化点，旧 lineage 的证据即使因 crash/清理失败仍留在文件中也不能授权新账号。
- 账号缓存（`accounts.json`）可保存多个 refresh token，每条记录有稳定、不因删除而复用的账号 id。同一时刻只有 `auth.json` 中的那一条对 LLM/Search/Image/Video/Quota 生效。切换把选中缓存记录写回 `auth.json` 并重置 coordinator 的旧账号状态。
- 刷新令牌轮换必须按刷新开始时绑定的稳定账号 id（及可选 lineage）写回缓存，不得用显示邮箱或完成时的 `activeId` 代替。userinfo 邮箱回填同样绑定发起查询的账号；账号已切换则丢弃结果。
- 每次刷新回调携带该次请求的原凭据快照，不使用 service 共享的可变目标字段；缓存同步还须核对原 refresh token。登出与撤销的 coordinator 在操作前核对同一份 revision/lineage/令牌快照，清理回调仅在该快照确实被清除后执行。缓存删除核对原凭据，gate 清理核对原 subject；单个 Host 的账号缓存读取与修改按队列串行，避免读改写互相覆盖。
- parent directory 在 POSIX 上为 `0700`，auth file 为 `0600`；Windows 使用用户数据目录 ACL，不把合成的 POSIX group/other mode bits 作为访问判据。所有平台仍执行 symlink、文件类型、大小与 schema 校验，且不创建明文 backup copy。
- refresh 使用锁内读取、锁外 network、锁内 lineage compare-and-commit；旧结果不得覆盖较新的 Login、Logout 或 refresh。
- userinfo 是可选、非关键 operation；插件不解码未验证 access token 来推断账号、plan 或权限。
- Logout 与 Revoke 是两个不同 actions。Revoke 使用 Google revoke endpoint 的 form body，不把 token 放入 URL。两者的本地清理都绑定启动操作时的账号：成功后删除该账号的缓存凭据，使其无法再通过 switch 恢复。`superseded`（例如撤销进行期间切换了账号）不得删除新的活动账号，也不得把迟到的轮换或邮箱结果写到新账号上。

### Private transport and identity decisions

- 固定 community core exact version并锁定 integrity；升级必须经过 source diff、fixture refresh 与显式版本决策。
- 只复用 public/core surfaces：constants、raw transport、request metadata、transforms、model registry、quota/model probe pure helpers。
- 不实例化 AccountManager，不导入 rotation/account selection，不启用 quota-style fallback，不使用 hard-coded project，不自动 onboarding，不使用 signature bypass sentinel。
- endpoint host/path 是 code-owned allowlist，不能由 settings、prompt 或 RPC 修改。
- exact `agy` User-Agent/framing 是固定 transport compatibility 约束，不被描述为 OAuth credential security，也不做 identity cycling。
- private request 同时携带 DSH secondary attribution。若 endpoint 拒绝该 header，Gate 0 失败；实现没有“只发 agy identity”的 fallback。
- Authorization、OAuth token、userinfo 等 Google public OAuth requests 使用其各自标准 headers；`agy` wire identity 只用于已明确列出的 Antigravity private Cloud Code operations。
- generation dispatch 后不做 endpoint failover。401 仅在零输出时 coordinated refresh 后重放一次；429 不自动重试；network/5xx 只有在证明 request 未被接受时才可有界重试。
- adapter 的 provider retry policy 与内部 retry decision 必须一致，避免 DSH runtime 外层二次重放。

### LLM decisions

- provider route 固定为 `google-antigravity`。
- model catalog 初始来自固定 audited community snapshot（当前为 `@cortexkit/antigravity-auth-core@2.2.0`），并与登录后的 available-models probe 取 advisory intersection；live `gemini-3.8-flash-tiered` 目录别名必须规范化为该模型的 tier family。Gemini 3.8 Flash 使用 captured `gemini-3.8-flash-medium` 基础 route 与原生 Medium 默认 reasoning effort，显式 Low/High effort 映射到对应 captured tier route；Low/Medium/High 分别发送 AGY 1.1.24 capture 的 numeric thinking budget、model enum、max-output default，并包含 `userAgent: "antigravity"` outer-envelope field。成功的 live intersection 会过滤账号目录中不存在的旧路由；暂时失败或协议漂移仍回退 snapshot，因此可能短暂保留 Gemini 3.5 Flash 等 core 兼容路由。设置 UI 区分 snapshot、live-available、unavailable、refresh-failed 与 protocol-drift。catalog absence 不得变成 exact pinned-model request rejection。
- system、messages、image blocks、tool schemas、reasoning effort 和 supported generation options 被转换为 private request envelope；没有证据的 option fail-loud。
- DSH session id 不直接发送；Private Client 生成 adapter-owned request/session metadata。
- stream parser 映射 text、reasoning、function call、usage、finish 与 embedded errors；unknown provider parts 触发 bounded protocol-drift error。
- Gemini 历史中的 tool-call ID 仅在插件内部配对，不发送到 wire；对应 tool-result 消费绑定后，后续调用可以复用该 ID。尚未收到结果时的 ID 复用、孤立或重复 tool-result 必须明确报错，不能靠覆盖名称猜测配对。普通与带图片消息使用相同规则；Claude 与 GPT-OSS 保留现有全历史名称校验，Claude 的 wire call/response ID 保持原样。
- usage chunk 必须在 terminal finish 之前发出；tool arguments 保持 raw JSON string。成功的 provider terminal event 不得提前取消响应 reader；必须排空剩余 SSE framing/EOF 后再完成 DSH stream，避免 Node raw-to-Web bridge 的重复关闭竞态。
- replay metadata 只在同 adapter、兼容 model family 和 schema version 下恢复；block mismatch、cross-model、fork 或 malformed metadata 触发安全降级。
- model family 以 Gemini、Claude、GPT-OSS 独立 gate，不从单个 family 的成功推断其它 family。

### Search decisions

- Search 使用 private `generateContent` 的 dedicated grounded request，只携带 search grounding，不携带普通 function declarations。
- sources 只来自 grounding metadata 的真实 web chunks；URL 只允许 HTTP(S)，执行去重、长度限制、排序保持和 maxResults 截断。
- 没有真实 source metadata 时返回明确 provider error；模型生成的文本不能补造 source。
- Search 不注册 WebFetchProvider，也不把 private `urlContext` 表现成任意 URL fetch。

### Image decisions

- image output model 与 inlineData response 必须先通过 Gate I fixture。
- user/session image input 通过 AttachmentStore 读取；workspace input 通过 Filesystem containment、regular-file 和 max-byte checks 读取。
- output inlineData 先做 encoded-length bound，再做 base64 decode、media declaration、magic/decode/pixel admission，最后只通过 AttachmentStore 持久化。
- `list_images` 使用 DSH session authorization、origin filter 与 cursor pagination。
- 第一版只发送 community contract 已证明的 image options；未知 size、quality、background、transparency 或 resolution 返回 unsupported error。
- `n > 1` 是多个明确 requests；不自动重试，部分成功带 structured warning。

### Video decisions

- community model registry没有 video modality，因此 Video 在 Gate V 通过前不注册。
- Gate V 只使用无隐私的短 MP4 workspace fixture，经过 containment、regular-file、max-byte 与 magic MIME validation 后发送 bounded inlineData。
- POC 问题必须验证视频画面事实；仅获得一般性回答不算通过。
- 成功结果只返回 text/usage；session、RPC、UI 和 logs 不保存原始 path、bytes 或 base64。
- public Gemini Files API 不能作为 Antigravity entitlement 的 fallback。
- 如果只能抽帧，必须作为独立的 frame-sampling capability 命名；不能宣称完整 video/audio/temporal understanding。
- 原生 composer/session video 依赖未来 DSH video attachment interface，不在插件内部模拟。

### Usage, UI and packaging decisions

- quota summary 只查询当前单账号/project，映射 5h/weekly window、remaining fraction、reset time 和 checked time。
- Usage 默认手动刷新并设最小间隔；错误分类为 unauthenticated、forbidden、rate-limited、offline 和 protocol-drift。
- UI 永远没有账号数组、切换、轮换、fallback、editable client id/secret 或 custom endpoint controls。
- capability rows 独立启用；Gate 未通过时不注册对应 provider/tool，但 Auth status view 继续说明原因。
- Host/client entries、package exports、bundle patch、peer dependencies、build、package smoke 与 publint 对齐现有 DSH capability bundle conventions。
- README 英文/中文均包含 unofficial、Google Terms 风险、single-account、private self-use、gate 状态和 unsupported claims。
- package 不公开发布；任何未来 publication 都需要新的明确请求和重新评估 Google Terms。

## Testing Decisions

### Testing philosophy and seams

- 测试只观察 module interfaces 的外部行为，不断言 private helper 调用顺序、内部字段布局或实现细节。
- 选择现有最高 seam：OAuth/RPC 通过 typed Host interface；LLM 通过 `ctx.llm.stream`；Search 通过 `ctx.web.search`；Image/Video 通过 `ctx.tools.execute`；durable images 通过 AttachmentStore；客户端通过 settings slot 与 RPC client。
- 唯一新增测试 seam 是 plugin-owned Wire Identity module；DSH core 使用已发布的 public interfaces，不产生 core diff。
- 所有 network、clock、filesystem、attachment 与 random dependencies 由 modules 接收，测试使用 deterministic adapters/fakes；默认 CI 不访问真实 Google/Antigravity。
- prior art 使用 `dsh-codex-auth` 的 Host auth/atomic persistence、typed RPC、WebRuntime Search、ToolRuntime Image、AttachmentStore、Usage timeout、client settings 和 package smoke suites。

### Plugin wire identity tests

- 调用公开 `attributionHeaders()` 得到当前 DSH identity value，不复制 formatter 或硬编码 DSH version/repository。
- Wire Identity module 保留 exact provider User-Agent，并添加且仅添加固定 `X-DeepSeek-Harness-Attribution` carrier。
- empty/CRLF/control-character provider User-Agent 与 identity value 被拒绝。
- caller 不能 suppress、rename 或 overwrite secondary attribution。
- LLM、Search、Image、Video、Quota 与 project-discovery wire fixtures 都使用同一个 module。
- OAuth authorization/token/userinfo requests 不使用 `agy` identity，保持其标准 OAuth headers。
- public LLM runtime fixture 证明两个 identity headers 实际到达 private request。
- tests 与 package diff 证明没有修改、shadow、patch 或复制 DSH core packages。

### OAuth and auth-store tests

- PKCE S256 challenge/verifier fixture。
- state entropy、TTL、one-shot、concurrent replay 与 process-restart invalidation。
- callback wrong method/path/Host、duplicate/missing state/code、OAuth error、timeout、cancel 与 port collision。
- loopback only binding；SSH/WSL 环境也不得切换为 `0.0.0.0`。
- callback completion 只经 Host loopback listener；browser typed RPC 不提供 callback URL/code/state submission endpoint。
- token exchange 与 refresh request/response schema、redaction 和 AbortSignal。
- auth-store absent、round-trip、POSIX owner-only permissions、Windows ACL-mode compatibility、atomic failure、corruption 与 unsupported version；capability evidence 与 controlled live-image store 使用同一平台判定，并在所有平台保留结构与大小校验。
- Login replacement、Logout、Revoke、refresh single-flight、cross-process revision race 和 rotated refresh token。
- 刷新 A 完成轮换后、缓存同步结束前切换到 B：A 的新 token 只更新 A，B 的 token 与 projectId 不变。
- 撤销 A 等待期间切换到 B：coordinator 返回 `superseded` 时 B 的缓存与当前 `auth.json` 均保留。
- 对尚无邮箱的 A 发起 userinfo 后切换到 B：A 的邮箱不得写入 B 或当前 `auth.json`。
- 账号身份读取迟到时交叠 A/B 刷新，或在撤销/登出身份读取期间切换账号：轮换、远端撤销与本地删除始终属于同一凭据。认证记录清除后、缓存清理前切换账号：清理 A 的剩余副本，同时保留 B 的认证与 gate evidence；内存与文件缓存均拒绝迟到的旧令牌更新和删除。
- `invalid_grant`、401、429、5xx 与 timeout 的状态转换。
- read-only project discovery；任何 fixture 中出现 onboarding 或 hard-coded fallback 都使测试失败。

### Private transport and security tests

- 每种 private operation 都使用 Wire Identity module 并携带 exact `agy` identity + DSH secondary attribution。
- 从每个 public operation 观察到的 wire request 都只能命中 allowlisted endpoint，并携带 credential module 提供的 Bearer、固定 `agy` User-Agent 与固定 secondary attribution；测试 interface 不接受 caller-supplied alternatives。
- 4xx/429 不触发 identity、account、quota-style 或 endpoint fallback。
- raw HTTP/1.1 content-length/chunked framing、gzip、header timeout、idle timeout、total timeout 和 cancellation。
- malformed status line、headers、chunk、gzip、SSE、JSON、oversized frame/body 与 protocol drift。
- logs、RPC、errors、fixtures 与 snapshots 的 token/code/verifier/callback URL/base64 leak scan。
- lifecycle disposal 中止 active request并释放 listener、socket、timer 和 locks。

### LLM tests

- 通过 LlmRuntime 注册 `google-antigravity` adapter并执行 text stream，而不是直接调用内部 mapper。
- system/messages/image/tool schema/request metadata 的 observable wire fixture。
- text/reasoning/tool-call interleaving、fragmented raw JSON arguments、usage-before-finish 与 finish mapping。
- embedded provider errors、prompt feedback、empty response 与 unknown part。
- ReplayEnvelope block alignment、schema version、signature round-trip、cross-model/fork/compaction degradation。
- DSH attachment image input的 byte/MIME mapping与 cancellation。
- zero-delta 401 refresh once、post-delta 401 no replay、429 no retry、ambiguous dispatch no retry、runtime/adapter retry不叠加。
- Gemini、Claude、GPT-OSS 各有独立 request/response fixtures与 model capabilities。
- model catalog snapshot、live intersection、refresh failure与 protocol drift。

### Search tests

- 通过 WebRuntime 注册 provider并调用 public search interface。
- dedicated request 有 search grounding但没有 function declarations。
- grounding text/query/source extraction、HTTP(S) filtering、dedupe、stable order、maxResults与 truncated。
- missing sources、malformed metadata、403、429、5xx、timeout与 cancellation。
- enabled/disabled state live change不造成 registration gap。
- WebFetchProvider 未被注册。

### Image tests

- 通过 ToolRuntime执行 `generate_image` 和 `list_images`。
- text-to-image、session-authorized edit与 workspace reference edit。
- unauthorized handle、workspace escape、symlink/TOCTOU、non-regular file与 max bytes。
- inlineData encoded bound、base64、declared MIME、magic/decode/pixel admission与 durable save。
- provider output不写 filesystem、不返回 data URL/file URI、不泄漏 base64。
- supported/unsupported options、multiple requests、partial success、no automatic retry。
- list pagination、origin filter、session authorization、fork/resume visibility。

### Video tests

- Gate disabled时 ToolRuntime中没有 video tool。
- workspace containment、regular file、symlink/TOCTOU、max bytes与 MP4 magic MIME。
- observable wire request包含 bounded video inlineData与用户问题。
- visual-fact fixture、usage/text result、unsupported modality、timeout与 cancellation。
- session、RPC、UI、logs与fixtures不含 path、bytes或base64。
- frame-sampling fallback不得以 video-understanding capability name注册。

### Usage, RPC, client and package tests

- quota payload按 window duration/type映射，不依赖数组位置；remaining clamp、reset validation与unknown-field drop。
- Usage Host timeout、transport ignores abort时的 lifecycle detach、minimum refresh interval与429 no storm。
- RPC request/reply schema、unknown endpoint、structured error、caller cancellation和 value-free leak scan；只有明确 loopback bind 走真实 dispatcher，缺失/all-interface/unknown bind 对所有 endpoint 只返回同一个 value-free denial 且不触碰 service。
- risk acknowledgement、pending login、logged-in、project-unavailable、Gate pending、disabled、protocol-drift和 logout/revoke UI states；非 loopback client 不注册 account settings section。
- 客户端没有 token/client metadata/custom endpoint/account switch controls。
- Cordis rows独立 mount/unmount，未通过 gate 的 capability 不注册。
- 干净安装解析 exact DSH `0.1.2-alpha.5` development graph，`pnpm peers check` 无 warning，lockfile 不包含其他 DSH prerelease package entries。
- 完整 `check` gate涵盖 lint、typecheck、unit/integration tests、Host/client build、package smoke与publint。
- packed file list只包含声明的 runtime、types、client、显式 `scripts/live-gates.mjs` CLI、patch、README、CHANGELOG和license artifacts；package smoke 必须验证 script 与其 bundled runner 同时存在。

### Live gates

- Live tests 永远不属于默认 `check`。
- Gate A：一次 Login、一次 refresh、可选 userinfo、一次 read-only project discovery；不调用 model/quota/search/image/video，不 onboarding。
- Gate 0/L：不带 `--family` 时仅发一条最小 text request，exact `agy` identity + secondary DSH attribution，无 catalog/tools/media；只有明确的 secondary attribution rejection 记为 `attribution-rejected`，普通 403 仍安全失败但不冒充 attribution 证据。
- LLM family gates：Gate 0 通过后，`--family gemini|claude|gpt-oss` 每次只运行一个 family 的独立单请求 fixture；证据分别以单次原子写持久化；Auth/LLM 状态直接从三个 family outcome 派生，只有三者全部通过才开放，不保存可能与 family evidence 分叉的 aggregate pass，也不从任一 family 推断其它 family。
- Gate S：一条 grounded search并验证真实 source metadata。
- Gate I：最小 generation 与 edit，输出进入 auth store 旁 owner-only、content-addressed 的持久 AttachmentStore seam；PNG 必须通过 CRC/chunk、IDAT/IEND、有界 zlib decode、row-filter 与 pixel-dimension admission。
- Gate V：受控短 MP4 在画面中央显示与产品上下文无关的 `KUMQUAT`，filename/container metadata 不含该词；固定 pixel-only 问题不泄露答案，只有精确验证预期单词才通过。
- 任何账号 warning、rate-limit anomaly、credential leak、unexpected onboarding、protocol drift或用户撤回授权都终止后续 live gates。

## Out of Scope

- 自动账号轮换、health score、killswitch 或 quota pool。本地多账号缓存与手动切换在范围内；跨账号自动 failover 不在范围内。
- quota-style fallback、Gemini CLI quota fallback、跨账号或跨 identity retry。
- fingerprint randomization、version cycling、header-style rotation或其它反检测策略。
- 官方 `agy` CLI subprocess bridge作为主 transport。
- AI Studio API key、Gemini public API 或 Vertex ADC作为 Antigravity entitlement fallback。
- 修改 DSH core、替换整个 `ctx.llm` module、创建 shadow `@deepseek-ai/dsh-llm` package、package-manager override或 profile mutation。
- patch installed DSH、`node_modules`、generated bundles或 runtime prototypes。
- automatic `onboardUser`、managed project provisioning和 hard-coded fallback project。
- WebFetchProvider、任意 URL fetch或 user-configurable private endpoint。
- public Gemini Files API video upload、视频生成或把 frame sampling称为完整视频理解。
- DSH 原生 video attachment、browser composer video part、ACP/MCP video projection、video player、retention与compaction；这些需要独立 DSH upstream spec。
- 公开 npm 发布、公开 binary distribution、production support、SLA或官方 Google compatibility声明。
- 默认 CI、安装、启动或 package check 中的真实 OAuth/private endpoint调用。
- 在本 spec 执行过程中读取现有用户 token、cookie、keychain、`agy` profile或真实 auth files。
- 在没有新的明确授权时运行 live gates、安装到当前 DSH profile、commit、push、release或publish。

## Further Notes

- Google Antigravity FAQ 与 Additional Terms 明确表示第三方软件、工具或服务使用 Antigravity login 违反条款，并可能导致账号暂停或终止。该风险不能通过单账号、PKCE、exact `agy` User-Agent 或 private repository 消除。
- exact `agy` identity 是用户确认的 transport compatibility 约束，不应在 UI、README 或安全文档中描述为 OAuth/credential protection。
- community source只证明逆向 contract 在固定 snapshot 中存在，不证明 Google 官方支持、稳定性或目标账号当前可用性。
- OAuth client id/client metadata 的具体值不进入本 spec 或 issue body；实现通过固定依赖获得，并限制在 Host flow中使用。
- 插件 private transport 的 identity policy 完全由 plugin-owned Wire Identity module 提供；任何需要修改 DSH core 才能继续的情况都使 Gate 0 失败，而不是扩展本项目 scope。
- 项目已经完成 plugin-owned Wire Identity、capability shell、单账号 PKCE login 与 credential lifecycle；后续 issue 必须从 DSH `0.1.2-alpha.5` coherent dependency baseline 继续，不回退到更早的 prerelease research baseline。
- 参考实现与测试 prior art 是 `dsh-codex-auth@0.2.2` 的 Auth、typed RPC、WebRuntime Search、ToolRuntime Image、AttachmentStore、Usage、client settings与package smoke modules；复制其interface模式，不复制其 provider-specific wire assumptions。
- 完成定义是：clean install、`pnpm peers check`、所有非 live tests 和 package gates通过，DSH core 保持无 diff，插件所有 capability gate状态可被诚实呈现。真实账号可用性不是离线实现完成的证明；live gates需要单独授权与单独结果记录。
