# dsh-antigravity-auth

[![npm version](https://img.shields.io/npm/v/dsh-antigravity-auth.svg)](https://www.npmjs.com/package/dsh-antigravity-auth)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[English](README.md) | 中文

在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 中使用 Antigravity 账号，接入语言模型、网页搜索、图片创作和实验性视频理解，共享登录态与用量面板。支持本地缓存多个账号并手动切换，**同一时刻只有一个活动账号**。

> **非官方、实验性，仅供个人使用。** Google 不支持第三方 Antigravity 登录工具，账号可能被暂停或终止。登录前请阅读 [Google FAQ](https://antigravity.google/docs/faq/) 和 [Additional Terms](https://antigravity.google/terms)。私有接口可能随时变更或失效，请勿用于生产工作负载。

**当前版本：**`0.1.5`（`latest`）。历史变更请查看 [Releases](https://github.com/suntianc/dsh-antigravity-auth/releases) 和 [CHANGELOG](CHANGELOG.md)。

[快速开始](#快速开始) · [使用各项能力](#使用各项能力) · [账号命令](#账号命令) · [常见问题](#常见问题) · [开发](#开发)

## 功能概览

| 能力 | DSH 入口 |
| --- | --- |
| 语言模型 | 模型选择器中的 `google-antigravity`，包含 Gemini、Claude、GPT-OSS 路由，实际可用性取决于账号 |
| 网页搜索 | 内置 `web_search` 工具的 `antigravity` 搜索提供方 |
| 图片生成与编辑 | `generate_image`，以及查看会话已保存图片的 `list_images` |
| 实验性视频理解 | `analyze_video`，读取当前工作区内的 MP4 文件 |
| 账号与额度 | **设置 → Antigravity**，显示 5 小时及每周额度，界面随 DSH 切换中英文 |

## 快速开始

### 1. 确认环境

- 已安装并能运行 DSH。当前测试开发基线为 **DSH `0.2.1-rc.5`**。
- Node.js `^22.19.0` 或 `>=24.0.0`，`PATH` 中可用 `pnpm`（本项目测试版本为 `11.7.0`）。
- 具有 Antigravity 权限的 Google 账号。
- 可在本地 Host 上打开浏览器完成 OAuth。Web 账号操作要求 Host 的 WebServer 明确绑定 **`127.0.0.1`**；临时 OAuth 回调使用 **`127.0.0.1:51121`**。

本包不限制 DSH peer 版本范围，其他版本可以尝试安装，但这**不代表已经验证兼容**。详见[验证范围](docs/dsh-source-verification.md)。

### 2. 安装或升级

先停止使用目标 profile 的 Host，再执行：

```sh
dsh --version
dsh plugin --profile web add --save-exact dsh-antigravity-auth@0.1.5
dsh plugin --profile web list
```

将 `web` 替换为实际使用的 profile，例如 `desktop`。核对列表中的版本，重启对应 Host（Web profile 使用 `dsh web`），然后刷新客户端。

### 3. 登录

1. 打开 **设置 → Antigravity**，点击**开始 Antigravity 登录**。启动登录会记录对上述非官方通道风险的确认。
2. 在 Host 所在机器的浏览器中完成 Google 授权。若新标签页被拦截，点击设置卡片中的**打开 Google 授权页面**。
3. 回到 DSH 检查登录结果，用 `/anti status` 查看详细能力状态。若授权过期，取消后重试或重新发起登录。
4. 选择可用的 `google-antigravity` 模型，并在 Antigravity 设置卡片中启用需要的搜索、图片或视频能力。

这些能力需要已登录账号和可用项目。正常运行的 Host 会自动激活账号的能力门禁，但这**不等于逐项完成模型或工具的在线验证**。实际可用性仍取决于账号和私有后端；灰色的开关还需要可写的 Host 设置范围。

终端登录方式见[账号命令](#账号命令)。

## 使用各项能力

- **模型：**在 DSH 模型选择器中选择 `google-antigravity`。当 `google` 尚未被其他提供方占用时，插件也会注册该别名。实时发现会筛选固定模型目录；临时发现失败时，选择器可能显示仅供参考的快照，并非已确认的账号可用列表。
- **搜索：**安装了多个搜索提供方时，在 Host 的**网页搜索**配置中选择 `antigravity`。仅打开 Antigravity 卡片开关不会替换 DSH 已选提供方。之后可通过内置 `web_search` 获取带来源链接的搜索结果。
- **图片：**让 DSH 生成图片，或编辑明确指定的会话图片（`image:<id>`）/工作区图片。`generate_image` 接收提示词、最多 **5 张参考图**、可选模型，每次可请求 **1–4 张图片**（`n`）；部分成功时可能少于请求数量，并返回警告。图片作为会话附件保存，可用 `list_images` 查找。目前没有独立的尺寸、宽高比、画质或透明背景参数。
- **视频：**为 `analyze_video` 提供当前工作区内的 MP4 路径和问题。文件默认及最大上限为 **32 MiB**，不接受远程 URL、工作区外路径或符号链接。工具会直接将 MP4 提交给私有接口，不在本地抽帧。这是实验性 POC，不保证完整的视频、音频或时间轴理解。
- **额度：**在 Antigravity 设置面板查看 5 小时/每周剩余额度与重置时间。查询不可用或被限流会显示相应状态，不会当作零用量。

## 账号命令

在支持 slash 命令的 DSH 交互界面中，`/anti` 与 `/antigravity-auth` 等价：

```text
/anti status       # 查看登录与能力状态（也是默认动作）
/anti login        # 发起 Google OAuth，并激活登录的账号
/anti cancel       # 取消进行中的登录
/anti accounts     # 列出本地缓存账号
/anti switch <id>  # 按账号序号、id 或邮箱切换
/anti logout       # 本地登出，并删除当前账号的缓存凭据
/anti remove <id>  # 删除缓存账号，使用剩余账号；无剩余账号时登出
```

- 登录成功后，账号缓存保存在 `accounts.json`，当前账号保存在 `auth.json`。其他缓存账号会保留，直到显式删除。不提供自动轮换或额度池。
- 本地登出只删除该账号的本地凭据，不撤销 Google grant。删除活动缓存账号后，可能启用另一个剩余账号；没有剩余账号时才登出。
- 命令可用于未运行 WebServer 的本地 Host，或 WebServer 明确绑定 `127.0.0.1` 的 Host；共享命令接口暴露在其他地址时会被拒绝。
- 终端登录会打开 Host 上的浏览器，不会把授权链接打印到持久保存的会话输出中。没有可用浏览器的无头 Host 无法完成这一步交互。浏览器授权后运行 `/anti status` 查看结果。

## 常见问题

| 现象 | 排查方法 |
| --- | --- |
| 找不到设置区，或出现 `loopback-required` | 确认插件装在当前运行的 profile，重启 Host 并刷新客户端。账号 RPC 要求 WebServer 明确绑定 `127.0.0.1`，仅客户端 URL 看起来是本机地址还不够；非 loopback 连接会隐藏设置区。 |
| 登录没有打开浏览器 | 点击设置中的**打开 Google 授权页面**。若一直没有链接，查看页面错误，并确认安装版本为 `0.1.5` 或更新版本。终端命令没有打印链接的备用方式。 |
| 回调端口被占用，或授权过期 | 确认占用 `127.0.0.1:51121` 的进程，仅在安全时关闭它，再重新登录。过期或已取消的授权链接不能复用。 |
| 已登录，但能力不可用 | 检查项目是否可用、能力状态、启用开关和 Host 设置范围。登录成功不代表后端支持所有能力。 |
| 搜索仍使用其他提供方 | 将 Host 的网页搜索提供方设为 `antigravity`；插件会保留已有选择。 |
| `invalid_grant` / 要求登录、HTTP 403 或 HTTP 429 | 授权失效或撤销后重新登录；403 检查账号权限；429 等待额度或限流恢复。插件不会自动切换账号绕过限制。 |
| `protocol-drift`、视频不受支持或模型异常 | 私有接口可能已变更。查看 [Releases](https://github.com/suntianc/dsh-antigravity-auth/releases) 和 [Issues](https://github.com/suntianc/dsh-antigravity-auth/issues)。反馈时提供插件/DSH 版本、系统及安全的错误码或 HTTP 状态，不要附带凭据或 OAuth 链接。 |

## 安全与边界

- OAuth 使用 PKCE S256 和临时 loopback 回调。Token 留在 Host，不进入浏览器、设置、日志或工具 metadata。
- 本地账号文件含 refresh token，请妥善保护：POSIX 使用属主权限，Windows 使用用户数据目录 ACL。反馈问题时不要分享 `auth.json`、`accounts.json`、授权/回调 URL 或原始媒体数据。
- 刷新、切换、登出和撤销操作绑定发起时的账号，迟到的结果不会覆盖其他活动账号。
- 私有请求仅访问固定允许的端点，并通过 `X-DeepSeek-Harness-Attribution` 保留真实 DSH 身份。这是传输兼容机制，不能消除账号受限风险。
- 插件使用 DSH 公开扩展接口，不替换 DSH core，不提供自动账号轮换或生产支持。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`check` 包含 peer 检查、lint、类型检查、离线测试、Host/client 构建、包冒烟检查和 publint。真实 OAuth 与私有接口检查需要单独显式启用；离线通过不能证明真实账号可用。

[Bundle patch](cordis.patch.yml) 安装四个 Host 行：`antigravity-auth`（共享认证与 LLM）、`antigravity-search`、`antigravity-image` 和 `antigravity-video`。

- [对应 DSH 源码验证](docs/dsh-source-verification.md)
- [设计规范](docs/specs/antigravity-auth-capability-bundle.md)与[研究记录](docs/research/antigravity-auth-plugin.md)
- [发布规范](docs/release-policy.md)与 [Release 模板](docs/release-notes.template.md)
- [更新日志](CHANGELOG.md) · [GitHub Releases](https://github.com/suntianc/dsh-antigravity-auth/releases) · [反馈问题](https://github.com/suntianc/dsh-antigravity-auth/issues)

## 许可与社区

[MIT](LICENSE) · [LINUX DO（L 站）](https://linux.do/)
