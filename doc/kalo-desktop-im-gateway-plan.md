# kalo-desktop 接入飞书 IM 网关方案

> 状态：方案设计（未实施）
> 目标：kalo-desktop 通过飞书扫码完成连接，用户离席后可在手机上实时查看 agent 运行进度，并逐步演进到双向交互。

## 1. 背景与目标

kalo-desktop 目前是**纯单机本地应用**：React 前端 ↔ Tauri Rust 薄后端 ↔ pi 引擎 sidecar（stdio NDJSON）。唯一的"通知"是应用内 toast，没有任何网络出口（Rust 侧无 reqwest/tokio，Tauri 插件仅 dialog，前端无 HTTP/WS 客户端）。

本方案为 kalo-desktop 设计飞书 IM gateway，分阶段交付：

- **P0（MVP）**：飞书扫码一键连接（自动创建 bot 应用），手机上接收 agent 进度推送与完成通知（只读）。
- **P1**：富进度展示（工具调用、流式摘要、状态 reaction）、多会话支持。
- **P2**：双向交互——手机上发指令、审批危险操作（卡片按钮）。

## 2. 飞书接入调研结论（可复用要点）

飞书接入调研的核心结论：

1. **扫码即建应用（最值得复用）**：飞书开放平台提供 device-flow 风格的应用注册接口，无需用户在开发者后台手工建应用：
   - `POST https://accounts.feishu.cn/oauth/v1/app/registration`（`action=init/begin/poll`）。
   - `begin` 传 `archetype=PersonalAgent, auth_method=client_secret, request_user_info=open_id`，返回 `device_code` 和 `verification_uri_complete`（二维码 URL）。
   - 用户用飞书 App 扫码后，飞书**自动创建一个带齐 IM 权限的 bot 应用**，`poll` 轮询返回 `client_id / client_secret / open_id`。
   - 纯 HTTPS POST 实现、无 SDK 依赖；`poll` 处理 `authorization_pending`（继续）/ `access_denied` / `expired_token`（终止）；响应含 `tenant_brand=lark` 时自动切换 `accounts.larksuite.com`（国际版）。
   - 附带红利：`request_user_info=open_id` 使扫码同时拿到**操作者本人的 open_id**，天然完成"绑定本人"的鉴权闭环。
2. **连接模式选 WebSocket 长连接**：官方 SDK 的出站长连接，**无需公网 URL**（桌面应用的关键约束），SDK 自动管理心跳/重连/tenant_access_token。webhook 模式仅适合有公网入口的服务器场景，不适用于 kalo-desktop。
3. **进度表达**：飞书 bot API 无 typing 指示器，用 `Typing`/`CrossMark` **reaction** 表达处理中/失败；流式内容用 `im.v1.message.update`（edit_message）渐进更新同一条消息。
4. **审批闭环**：interactive 卡片按钮（value 携带 action 标识），`card.action.trigger` 回调同步返回替换卡片 + 异步通知等待方——P2 阶段直接落地该交互模式。
5. **健壮性清单**：message_id 去重（24h TTL 持久化）、每 chat 串行锁、突发消息合并、同 app_id 本地互斥。
6. **发送兜底**：markdown 自动转 post 富文本、API 拒绝时降级纯文本、单条 8000 字分片、reply 失败降级 create。

## 3. 总体架构

### 3.1 选型：独立网关 sidecar 进程（推荐）

```
        ┌─────────────┐  飞书开放平台   ┌──────────────────────────┐
        │ 手机飞书 App  │ ⇄ (事件/消息) │  飞书云端 (WS 长连接出口)   │
        └─────────────┘                └───────────▲──────────────┘
                                                    │ 出站长连接(无需公网)
                              ┌─────────────────────┴───────────────┐
                              │ kalo-gateway sidecar (Node/Bun exe)  │
                              │  @larksuiteoapi/node-sdk WS Client   │
                              └───────────▲───────────┬─────────────┘
                            stdin NDJSON  │           │  stdout NDJSON
                              ┌───────────┴───────────▼─────────────┐
                              │ kalo-desktop Rust 后端 (新增 gateway.rs)│
                              │  事件截取点: session.rs stdout reader  │
                              └───────────▲───────────┬─────────────┘
                                          │           │  stdin commands
                                   pi-event│           ▼
                              ┌───────────┴─────────────────────────┐
                              │ pi 引擎 sidecar（每会话一进程, 现状）    │
                              └─────────────────────────────────────┘
```

**决策理由**：

| 候选方案 | 结论 |
|---|---|
| A. 网关嵌入 Rust 后端（reqwest + 手写 WS 协议） | ❌ 飞书 WS 长连接协议无官方 Rust SDK，帧格式/握手需逆向官方实现，工作量与维护成本最高 |
| B. 网关跑在 WebView 前端（浏览器 fetch/WS） | ❌ 飞书 WS 握手依赖自定义头与非浏览器 API，`@larksuiteoapi/node-sdk` 是 Node SDK；且依赖窗口存活，关窗即断 |
| **C. 独立 Node sidecar 网关进程 + stdio NDJSON** | ✅ 官方 SDK 全能力；与现有 pi sidecar **同构**（spawn 子进程 + NDJSON 分帧），Rust 侧无需引入任何网络栈；构建链复用 `scripts/build-engine.sh` 的 bun 编译单 exe 经验 |
| D. 复用 kalo-harness 的 pi-server/pi-client（CBOR over WS） | 长期方向：把引擎本身服务化后，网关作为独立客户端订阅进度，桌面端可完全离线。改动面大，列入 P2 之后再评估 |

进程职责：

- **kalo-gateway sidecar**：飞书 WS 长连接、扫码注册流程的 HTTP 调用、消息收发/编辑/reaction、事件 → 进度消息的渲染策略、入站消息鉴权与去重。对 Rust 暴露一组窄的 NDJSON 命令协议（见 §6）。
- **Rust 后端（新增 `gateway.rs`）**：spawn/守护网关进程（崩溃重启、应用退出时回收）；在 `session.rs` 的 stdout reader（`session.rs:162-215`，即现有 `emit_json_line` 同一位置）把每行引擎事件**同时转发**给网关 stdin；把网关 stdout 的入站消息转 emit 给前端或转成 pi 命令（P2）。
- **前端**：SettingsPage 新增"飞书连接"区块——发起扫码、展示二维码、连接状态、解绑。不承载任何网关逻辑。

为什么截取点放在 Rust 侧而非前端 `chat-store.ts:handlePiPayload`：Rust 的 stdout reader 对所有会话、所有事件天然齐全，且不依赖前端窗口与渲染节流（前端的 50ms 节流 flush 只服务 UI）。

### 3.2 构建与打包

- 新建 `kalo-desktop/gateway/`（TypeScript 源码），依赖 `@larksuiteoapi/node-sdk`（官方 TS SDK，内置 WS Client）+ `qrcode`（生成二维码 data URL）。
- 构建脚本参照 `scripts/build-engine.sh`：bun 编译为单文件 exe → `kalo-desktop/src-tauri/binaries/kalo-gateway-x86_64-pc-windows-msvc.exe`，在 `tauri.conf.json` 的 `bundle.resources`/externalBin 中声明（与 pi sidecar 相同模式）。
- 运行时查找顺序与 `resolve_pi_path()` 对齐：`KALO_GATEWAY_PATH` 环境变量 → 应用 exe 旁 `binaries/` → 开发布局 `src-tauri/binaries/`。

## 4. 扫码连接流程（核心体验）

采用 device-flow 扫码流程，但二维码展示从终端 ASCII 改为桌面 UI：

1. 用户在 SettingsPage 点击"连接飞书" → 前端 `invoke("gateway_pair_start")`。
2. Rust 转发给网关 sidecar；网关执行：
   - `POST https://accounts.feishu.cn/oauth/v1/app/registration`，body `{"action": "init"}`，确认服务端支持 `client_secret` 授权方式。
   - `{"action": "begin", "archetype": "PersonalAgent", "auth_method": "client_secret", "request_user_info": "open_id"}` → 得 `device_code`、`verification_uri_complete`、`interval`、`expire_in`。
3. 网关用 `qrcode` 把 `verification_uri_complete` 渲染为 PNG data URL，经 Rust → 前端弹窗展示二维码（同时展示"请在飞书 App 中扫码"与倒计时）。
4. 网关后台按 `interval` 轮询 `{"action": "poll", "device_code}`：
   - `authorization_pending` → 继续；`access_denied` / `expired_token` → 终止并提示重试。
   - 响应 `tenant_brand=lark` → 切换 `accounts.larksuite.com` 重试（国际版兼容）。
5. 成功返回 `client_id / client_secret / open_id` → 网关调 `/open-apis/bot/v3/info` 验证连通 → 落盘（见 §7）→ 自动启动 WS 长连接。
6. 前端显示"已连接 @<用户>"；扫码者的 `open_id` 即**默认且唯一的授权用户**（MVP 单用户绑定）。

异常处理：进程重启后若已有凭据则直接起 WS 连接，无需再扫码；凭据失效（API 返回无效 grant）时进入"需重新扫码"状态并在设置页提示。

## 5. 进度推送设计（P0 只读）

### 5.1 事件 → 飞书消息映射

网关从 Rust 收到原始 `PiEvent` NDJSON（与 `src/types.ts:214-242` 同一结构），内部维护"会话 → 飞书消息"的映射：

| 引擎事件 | 飞书侧动作 |
|---|---|
| `agent_start` | 向绑定用户私聊发一条进度消息："🔄 开始处理：<prompt 前 50 字>"，记下 `message_id` |
| `tool_execution_start` | 节流后 `message.update` 追加一行："🔧 正在执行：Bash `npm test`" |
| `message_update`（text_delta） | 节流（≥1s/次）增量更新该消息的"当前输出摘要"段（尾部 N 字符） |
| `auto_retry_start` | 更新："⚠️ 正在重试（第 N/M 次）" |
| `compaction_start/end` | 更新："🗜️ 正在压缩上下文" |
| `agent_end` / `agent_settled` | 最终更新："✅ 完成（用时 Xm，轮次 N）" + 末尾摘要；给用户消息加完成 reaction |
| `tool_execution_end`（isError）/ 引擎退出 | 最终更新："❌ 失败：<错误摘要>" |

要点：

- **单条消息持续编辑**（`im.v1.message.update`），而不是刷多条新消息——手机端体验接近"看一个动态状态卡片"；只有 `agent_start` 和最终态产生新消息（最终态可选 reply 原消息）。
- **全局限流**：所有 update 走节流队列（如每会话 ≥1s、全局 ≥300ms 间隔），飞书 API 有频控，需全局限流处理。
- 进度消息正文用简单模板即可；P1 再升级为 interactive 卡片（带进度分区、取消按钮）。
- MVP 多会话策略：**每个活动会话各发一条进度消息**（开头标注项目目录名区分）；不做会话选择 UI。

### 5.2 Rust 侧改动点

- `session.rs`：stdout reader 在 `emit_json_line`（session.rs:270）之后/之内，把同一行 JSON 写入网关 stdin（网关未连接时直接丢弃，零成本）。另需把 `pi-exit` 也转发给网关（用于"崩溃/重试"提示）。
- 新增 `gateway.rs`：网关进程的 spawn、stdin mpsc writer（与 session.rs 的 stdin writer 同模式）、stdout reader（P2 用）、exit watcher（崩溃自动重启，指数退避）、`Drop` 时 kill。
- `main.rs` 新增 commands：`gateway_pair_start` / `gateway_pair_cancel` / `gateway_status` / `gateway_unbind`；新增 Tauri 事件 `gateway-status`（连接态机：disconnected/pairing/connecting/connected/error）推给设置页。

### 5.3 网关 ⇄ Rust 协议（NDJSON，每行一个 JSON）

Rust → 网关：

```json
{"cmd":"pair_start"}
{"cmd":"pair_cancel"}
{"cmd":"unbind"}
{"cmd":"event","sessionId":"...","cwd":"...","payload":{ ...原始 PiEvent... }}
{"cmd":"session_exit","sessionId":"...","code":0}
```

网关 → Rust（MVP 仅状态；P2 增入站消息）：

```json
{"type":"pair_qr","qrDataUrl":"data:image/png;base64,...","expiresIn":300}
{"type":"status","state":"connected","user":"ou_xxx"}
{"type":"error","message":"..."}
```

## 6. 安全与健壮性（MVP 即需具备）

- **凭据存储**：`~/.kalo/agent/feishu.json`（与 models.json/auth.json 同目录同权限策略，0600），仅存 `app_id/app_secret/bound_open_id/tenant_brand`；不进 git、不进日志。
- **鉴权闭环**：扫码返回的 `open_id` 即白名单——WS 入站事件只接受该 `open_id` 的私聊，其余直接忽略（P1 再考虑 `allowed_users` 扩展与 pairing 配对码）。
- **去重**：入站 `message_id` 24h TTL 去重（P2 双向时必需，飞书会重投）。
- **互斥**：同机只允许一个网关实例使用同一 app_id（基于作用域锁的锁文件互斥）。
- **数据最小化外发**：MVP 推送内容仅状态与截断摘要，不含完整文件内容/密钥；在文档与设置页明示"开启后 agent 进度摘要将经飞书云端传输"。
- **断线**：SDK 自动重连；重连期间事件在 Rust 侧即丢弃（进度推送允许丢失，终态消息在重连后补发一条"会话仍在运行/已结束"即可，不追求精确回放）。

## 7. 分期实施计划

**P0（MVP，只读进度）**
1. `kalo-desktop/gateway/` 工程脚手架 + 扫码注册（§4）+ WS 连接 + 凭据持久化。
2. Rust `gateway.rs` 进程管理 + `session.rs` 事件转发 + 4 个 commands + `gateway-status` 事件。
3. SettingsPage 飞书区块（扫码弹窗、状态、解绑）。
4. 网关渲染器：§5.1 映射表的最小集（start/end/失败/节流 update）。
5. 打包链路：构建脚本 + tauri.conf.json sidecar 声明。

**P1（体验增强）**：interactive 卡片化进度（分区展示工具调用/当前输出）、reaction 状态指示、多会话消息标注、lark 国际版、断网提示。

**P2（双向）**：手机发消息 → 新 prompt/引导消息注入当前会话（`prompt`/`steer` 命令经 Rust 写 pi stdin）；危险命令卡片审批（`card.action.trigger` 同步替换卡片 + 异步放行模式）；`/status` 等斜杠命令。

## 8. 风险与开放问题

- **飞书注册接口的稳定性**：`/oauth/v1/app/registration` 是开放平台面向第三方工具的 device-flow 接口（已在生产环境验证可用），但属于半公开能力，需在 P0 首日先做一个 spike 脚本验证该接口当前仍可用、`PersonalAgent` archetype 权限范围是否覆盖 `im:message` 等所需 scope。若失效，回退方案为"引导用户在开发者后台手工建应用 + 粘贴 app_id/secret"（同样保留此回退路径）。
- **sidecar 体积**：bun 单 exe 约数十 MB，与 pi.exe 叠加后安装包变大；可评估 gateway 不打包进 NSIS、改为首次使用时按需下载（需权衡离线体验）。
- **企业限制**：部分企业飞书租户禁止自建应用/扫码建 bot，此时扫码会在飞书侧直接报错——前端需展示该错误并给出手工建应用的文档链接。
- **合规**：进度摘要经第三方云端传输，发布时需在设置页提供显式开关与说明。
