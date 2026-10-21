# WorkBuddy 专家包与专家团兼容

## 目录分离与选择入口（2026-10-21 修订，覆盖下文初版的 cwd 约定）

- 专家定义与任务目录分开：注册项增加 `definitionDir`；导入包的 `workdir` 不再表示默认任务目录，新导入项省略它。旧项回退到其 `workdir` 解析定义目录，保留历史文件与记忆。
- 用户通过专家列表或输入框旁的选择器选择专家/专家团。列表支持搜索与类型筛选。选择专家保留当前任务目录；当前目录为空或落在已安装专家定义目录下时，新建 `~/.kalo/workspaces/chat-<n>/`。选择器显示中文专家名，工作目录选择器只表示产出位置。
- 空白对话切换专家保留输入与附件；已有对话选择不同专家时开启同目录的新对话，避免混合身份；运行期间不切换。专家面板按钮为“使用专家”，定义目录只在详情的“专家文件”区域出现。
- 桌面与定时任务传递 `KALO_EXPERT_DIR=<定义目录>`。主进程在此加载入口角色、共享宪章和技能；子会话使用同一来源目录加载成员，cwd 始终是任务目录。专家记忆继续使用定义目录的 `.kalo/memory`，与用户记忆及任务目录隔离。定时任务尊重 task.cwd，不再用专家定义路径覆盖；旧任务误用定义目录时分配独立任务目录。
- 运行提示明确区分两个路径，输出写任务目录，角色/技能从定义目录读取。来源包不再作为默认工作区，也不复制到每个任务目录。
- 专家身份写入会话 custom entry，恢复历史前从持久元数据读出 expertId；已有会话在有池运行时及重启后均保留所选专家。
- 新增 `expert_for_session { path } -> string | null`，只扫描第一条 assistant 消息之前的会话元数据；旧包目录内的历史可按 header.cwd 与注册项匹配，普通任务目录不能凭目录猜测专家身份。
- 拆出 `chat-session.ts` 承担会话视图与 runtime 数据结构，让 `chat-store.ts` 只负责调度；新增选择逻辑不继续堆到超长文件。
- 过程区的消息 margin、容器 gap 和思考行 padding 单独收紧；最终正文与用户消息间距保持可读。

验证：纯逻辑测试覆盖定义目录回退、路径边界、搜索/类型筛选及独立目录选择；Rust 覆盖专家技能与启动环境；引擎覆盖来源目录与 cwd 不同的角色加载和子会话恢复。重建后用独立任务目录做一次最小专家团验收，确认角色从定义目录加载、产出落在任务目录。

2026-10-22 修订验收：根 changed-aware 检查通过，桌面端 717 项测试通过，Rust 专家相关 12 项测试通过，harness 定向 45 项通过、1 项按平台跳过；离线构建通过。真实 sidecar 在 `~/.kalo/workspaces/expert-directory-check-*` 下启动主理人并调用方成，成员在任务目录写出身份与任务路径；定义目录未出现测试产出，会话持久化 `kalo-expert-context` 身份。开发版已重启，UIA 确认默认文件浏览位置为独立 `chat-6`，侧栏“专家市场”和输入区“选择专家”入口均存在。截图接口超时，像素级间距未通过截图复核。harness 全量检查仍受既有模型测试类型不匹配阻塞。

## 包格式与映射

- 包根目录的 `.codebuddy-plugin/plugin.json` 是入口；同时接受 `.claude-plugin/plugin.json`。
- `name/version` 标识包；`displayName/displayDescription` 接受字符串或多语言对象，优先中文、其次英文。
- `agents` 列出带 YAML frontmatter 的角色 Markdown；`agentName` 是单专家入口，专家团由 `teamInfo.leadAgent/memberAgents` 指定主理人与成员。
- 已有精简包省略 `agents`；此时只按入口和成员 ID 定位 `agents/<ID>.md`，仍逐一校验文件，不扫描并执行其他内容。
- `members` 提供成员显示名和职业；角色正文是职责与流程，`skills` 是技能目录，技能相邻脚本、模板、图片随包保留。
- 清单和正文是导入数据，不执行包里的安装脚本、hooks、MCP 配置；工具权限沿用 Kalo 的显式授权，不从包里扩权。

## 安装与持久化

新增 `expert_import { path } -> Expert`，由数字专家面板选择包根目录调用。解析并校验所有入口、成员、技能和路径后，将包复制到 `~/.kalo/agent/experts/<包名>/`，保留 `agents/skills/assets/avatars` 的相对位置。技能另安装到工作区 `.kalo/skills/`，确保已有项目技能发现机制生效。不复制未声明的插件执行入口。

命令行 `kalo --import-expert <专家包根目录>` 调用同一入口后退出；成功输出注册项 JSON，失败返回非零退出码，缺少目录参数返回 2。图形程序打开方式保持原样。

注册表仍为 `~/.kalo/experts.json`。旧项无需迁移；新增可选 `kind`（`agent/team`）、`entryAgent`、`members`、`packageVersion`。工作区 `.kalo/expert.json` 存相同角色索引供引擎读取。重复包名、已有目标目录直接报错，避免覆盖用户资料。注册失败保留安装目录并提示位置，便于恢复；不自动删除用户文件。

原生专家团也使用此索引：`expert-designer` 创建入口与成员角色 Markdown，把相同注册项写入注册表和工作区 `.kalo/expert.json`；共享工作目录、技能和团队记忆。主理人职责只注入主会话，成员角色以系统提示单独注入，不把主理人全文写入全局 AGENTS.md。

路径统一使用 PathBuf / node:path；拒绝绝对路径、父目录跳转、Windows 驱动器/UNC 路径及符号链接，防止包引用逃出根目录。Windows/macOS 使用同一目录契约与主目录解析。

## 运行契约

- 会话仍传 `expertId`，复用身份、定时任务和 `.kalo/memory` 隔离。专家上下文扩展读取工作区索引与入口角色正文，注入主理人/单专家职责。
- `agent` 新增可选 `subagent_type`，以成员 ID 绑定角色；`name` 兼容 WorkBuddy 调用。仅允许本包声明的成员，不允许主理人派生自己，未知 ID 返回可操作错误。
- 成员正文解析 frontmatter 后注入子会话系统提示，以 custom entry 保存角色快照；恢复子会话时沿用原角色，不能通过 resume 改身份。普通子 agent 行为不变。
- WorkBuddy 的 TeamCreate 在 Kalo 中映射为已加载的团队名单；主理人通过 `agent(subagent_type=成员ID, prompt=完整任务, tools=显式工具)` 派发，工具返回就是成员回传。SendMessage 映射为成员最终回复，后续交接经主理人传递，续写使用返回的 childId。
- 运行适配说明在原角色正文之后明确注入。原文件保持原样；不存在的 WorkBuddy 工具不可调用。产出和运营档案落在专家工作区，不依赖 Windows 桌面路径。缺少图片 API/微信凭证时只完成本地可执行部分，不声称已配图或上传。
- `maxTurns` 保留为来源元数据，不改变 Kalo 的 watchdog/并发/权限机制，不宣称与 WorkBuddy 的轮次预算等价。

## 交互与验证

数字专家面板增加导入入口、专家/专家团标识和成员名单，仍以“开始会话”进入主理人会话。

验证覆盖旧注册表兼容、单专家/团队映射、缺失角色、非法路径与符号链接、重复安装、角色解析、身份恢复和普通子 agent 回归。运行 changed-aware 检查、Rust 定向测试、harness check 与定向 Vitest，重建 sidecar 后启动桌面端。

本地重建可用 `bash scripts/build-engine.sh --offline-model-data` 保留仓库自带模型目录，不在兼容性开发中刷新模型清单；默认构建行为保持自动刷新、失败后离线回退。

公众号运营验收使用合成素材与数据，完成成员撰稿、HTML 排版、数据分析与主理人汇编，检查子会话及磁盘产物；不提供真实凭证，不上传草稿或群发。图片服务和微信上传的真实联调需要已配置服务，验收中明确记录此边界。

## 2026-10-21 实测结果

- 扫描本地 15 个包：10 个单专家、5 个专家团；其中一个团队省略 `agents` 数组，已覆盖角色 ID 定位回退。
- “公众号运营”通过 Kalo 命令行入口真实安装，保留主理人、4 名成员及 9 个技能。开发版窗口已启动，但桌面截图接口连续超时，本轮通过同一 sidecar 的 RPC 执行运营验收，未宣称完成界面点击验收。
- 主理人真实调用 `fang-cheng/chen-lie/su-mingxi/shu-tou`。4 个独立子会话均有 `kalo-expert-member-role` 快照；生成 `article.md/titles.md/article.html/analytics.md/publish-check.md/report.md`，位于专家工作区 `outputs/compat-smoke-20261021/`。
- HTML 为 9460 字节，使用 A 风格、标题与稿件一致、无图片占位。合成数据的阅读率为 20%/30%/15%，分享率为 5%/10%/5%，关注转化率为 4%/5%/3.33%，独立复核通过。专家成功把环境经验保存到工作区 `.kalo/memory/`。
- 默认 Python 缺少 `bs4`，排版成员通过 `KALO_MARKET_PYTHON` 选用已有且包含依赖的解释器，未安装新依赖。真实生图、封面、微信凭证/IP 白名单和上传未验证。
- 根 changed-aware 检查通过（桌面端类型检查、712 项测试、cargo check、行数和桥接检查）；Rust 专家相关 10 项测试通过；harness 定向测试 43 项通过、Windows 下跳过 1 项 Unix 符号链接测试；引擎源码类型检查与离线构建通过。
- harness 全量 `npm run check` 在既有 `packages/ai/test` 的模型目录类型不匹配处失败（旧模型 ID 与当前目录不一致）；本次新增源码和测试无类型错误，不扩大修改模型测试的范围。
