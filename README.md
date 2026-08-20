# Kalo

AI coding agent 桌面客户端：Tauri v2 + React 界面，Codex 风格 UI（明暗双主题）。

在「把对话做好」之外，它围绕四个方向做了纵深：**投资分析**、**知识沉淀**（笔记与记忆）、**数据自动定时拉取**、**演化**（程序搜索）——详见下文[「四个特点」](#四个特点)。

> Kalo 基于 [pi](https://github.com/earendil-works/pi) agent 引擎构建——桌面端通过子进程驱动 `pi --mode rpc`，使用其 NDJSON RPC 协议通信。`kalo-harness/` 是 pi 的 vendored 源码（MIT）。

## 跑起来

三步：装工具链 → `bun run setup` → `bun run dev`。

### 1. 工具链

| 需要 | 说明 |
|---|---|
| [Bun](https://bun.sh) | 跑仓库脚本 |
| [Node](https://nodejs.org) ≥ 22 | 构建 pi 引擎（`kalo-harness`） |
| [Rust](https://rustup.rs) | Tauri 后端 |

Windows 还需要 **MSVC 构建工具**（Rust 的 `x86_64-pc-windows-msvc` 目标要用它的链接器）：装
[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) 时勾选
「使用 C++ 的桌面开发」。另外 Windows 上的脚本走 Git Bash，所以需要
[Git for Windows](https://git-scm.com/download/win)。

```powershell
# Windows (PowerShell)
winget install --id Rustlang.Rustup -e
winget install --id OpenJS.NodeJS -e
winget install --id Git.Git -e
powershell -c "irm bun.sh/install.ps1 | iex"
```

```bash
# macOS / Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -fsSL https://bun.sh/install | bash
# Linux 另需 Tauri 的系统依赖（webkit2gtk 等），见 https://tauri.app/start/prerequisites/
```

### 2. 构建与运行

```bash
git clone https://github.com/kirie123/kalo.git
cd kalo

bun run setup     # 装依赖并构建 pi 引擎（首次约几分钟）
bun run dev       # 调试启动（vite + tauri dev）
```

首次启动后，在**设置 → 模型**里填一个 provider 的 API Key 就可以开始对话了。

其余命令：

```bash
bun run build              # 构建 Windows 安装包（NSIS，输出在 kalo-desktop/src-tauri/target/release/bundle/）
bun run build:engine       # 仅重建引擎 exe（kalo-harness → kalo-desktop/src-tauri/binaries/）
bash scripts/build-gateway.sh   # 仅重建网关 sidecar
```

各子目录也可用 npm 单独操作，详见 [kalo-desktop/README.md](kalo-desktop/README.md)。

### 3. 试一下「演化」

演化（程序搜索）是 Kalo 比较特别的一块，可以直接试：

1. 侧边栏 →「演化」
2. 顶部「运行环境」卡片如果说没找到 era，点「安装 era」——它用 [uv](https://docs.astral.sh/uv/) 装
   [era-evolve](https://github.com/kirie123/era-evolve)，uv 会连自己的 Python 一起下载，
   所以这台机器上有没有 Python、是哪个版本都不影响（国内网络可以在旁边填一个 PyPI 镜像）
3. 点「试跑示例」——写出一个完整实验（60 城 TSP），什么都不用填
4. 在实验卡片上点「验证评测」，看基线分数（≈ -32900），然后「开始演化」

预算是 8 次扩展，每次会真的调一次模型。第一次变异通常就把分数从 -32900 推到 -6900 上下，
曲线会明显往上走。

> era 是一个独立仓库、独立开源的 Python 程序，**不随 Kalo 打包**，也不参与 `bun run dev` /
> `bun run build`——没有它，Kalo 的其余功能一切照旧。

## 为什么做 Kalo

**构建一个属于你自己的桌面端 Agent。**

市面上的 Agent 客户端层出不穷，但都是别人的产品：界面改不了、数据在别人手里、能力边界由厂商划定。Kalo 想做的是另一件事——一个你可以完全拥有、自由改造的个人 Agent 桌面端：

- **用于个人学习**：随时追问、让 Agent 带你读代码、读文档，把"查资料"变成"对话式探索"
- **用于工作开发**：接入自己的模型或中转服务，跑在你自己的项目目录里，工具调用、diff、上下文占用全都看得见
- **用于沉淀知识**：所有会话以 JSONL 落盘在本地，可回溯、可检索、可二次加工，长期使用下来就是你自己的知识库

引擎与界面解耦（pi 引擎 + NDJSON RPC 协议）：你可以换引擎、改界面、加能力，把它打磨成你想要的样子。这也是 Kalo 开源的原因——欢迎 fork，做出属于你自己的 Agent。

## 四个特点

大部分 Agent 客户端做的是「把一次对话做好」。Kalo 在对话之外做了四件纵深的事：**投资分析**（数据与判断分离的个人投研）、**知识沉淀**（笔记 + 记忆，把对话的产物留下来）、**数据自动拉取**（零 token 的常驻数据面）、**演化**（把 Agent 当成搜索算子去解一类对话解不了的问题）。

### 投资分析：数据与判断分离的个人投研

Kalo 不是荐股工具，而是一条**能自己攒数据的投研流水线**：数据线零 token、每天自动跑，判断线按需调模型，两边的产物都落在本地文件里，随用随积累。

- **取数层只产出事实，不下结论。** 内置 `market-data` skill 是一个统一 CLI：美元指数、中美国债、黄金、BTC、A 股量能、财报下载、个股体检数据，全部有脚本可跑；「偏紧 / 过热 / 该买」这类判断留给上层 skill 里的模型。这条线同时是 token 边界——线以下每天自动跑、零 token，线以上只在用户开口时才动模型。
- **判断层是三个开箱即用的内置 skill**（取数层 `market-data` 是第四个）：
  - `macro-pulse` 宏观风向——读 market-data 攒下的历史算分位数，回答「现在算高还是低、该不该谨慎」；
  - `stock-checkup` 个股体检——风险排查 / 健康度 / 催化契机三大类，逐项给事实和判断；
  - `filing-digest` 财报下载与分析——年报 / 季报，营收、净利、毛利、ROE、现金流，一问即答；
  - 更重的投研工作流（行业漏斗、财报精读、组合管理、论文追踪……）可以继续叠加新的 skills，Kalo 只提供机制，不写死能力清单。
- **环境一键装，状态看得见。** 市场数据环境卡把「真正将要运行数据脚本的那个 Python 解释器」就绪没有、缺什么，一屏说清楚：设置页一键初始化（自动安装解释器 + 依赖，可指定国内 PyPI 镜像），不靠猜。
- **历史是攒出来的，不是查出来的。** 默认自带一条「宏观快照每日落盘」任务，工作日收盘后自动追加一条宏观快照——分位数判断要的就是这个历史，用一天它深一天。

### 知识沉淀：让 Kalo 自己经营一个知识库

侧边栏「知识笔记」是一个三列工作面（域树 / 列表 / 编辑器），背后就是本地目录里的一堆纯 markdown。特点不在于"能记笔记"，而在于几条刻意的设计取舍：

- **目录就是分类，没有写死的类型表**。域 = 顶层目录，加一个目录就是加一个域；想给它中文名、图标、颜色、排序，就在 `_types/` 下的域描述文件里写 frontmatter（`_label` / `_icon` / `_color` / `_order`）——**分类体系本身也是一篇笔记**，不是代码里的枚举。而归类以目录为准，frontmatter 写歪了也不会错位。
- **markdown 就是唯一真相**。编辑器是源码 textarea + 实时预览（KaTeX / GFM），没有富文本层、没有双向序列化。Kalo 写进去的字节和你编辑的字节是同一份，随时可以用别的编辑器打开、可以直接 git 管起来。
- **Agent 自主写，但写完进「待审阅」**。约定用 frontmatter 表达：Kalo 写的笔记带 `_by: kalo` / `_reviewed: false`，页面左侧有「待审阅」筛选，你逐条通过 / 改 / 删。信任机制不需要额外基础设施，一个字段就够。
- **覆盖和删除前一定留副本**。旧内容进 `.trash/` 兜底目录，**备份失败会直接让写入失败**——在 Agent 无人看管时改笔记的场景里，best-effort 的备份等于没有备份。
- **中文两字就能搜到正文**。全文搜索不分词、不设最小长度，返回命中行而不只是文件名。
- **无头会话走 `rg`，不走 IPC**。定时任务里的 Kalo 是独立进程，检索靠 `rg` 直接扫目录，和界面共用同一批文件——不为 Agent 侧再实现第二套检索。

目录布局（全部可以手工建、手工改）：

```
knowledge/            # 本地知识库根目录
├── AGENTS.md          # 这个库的经营规则，Kalo 每次进来先读
├── INDEX.md           # 生成物，不手工维护
├── _types/<key>.md    # 域的自我描述（label / icon / color / order）
├── inbox/             # 随手扔进来的，待整理
├── review/            # 周度 / 月度回顾产物
├── cards/ …           # 其余每个目录都是一个域
└── .trash/            # 覆盖与删除的兜底副本
```

链接图谱（`[[wikilink]]`、反向链接、孤立笔记、`INDEX.md` 由 Rust 侧派生而非模型手写）与 Kalo 侧的自动维护任务（整理 inbox / 周度回顾 / 月度整合）在后续阶段，设计见 [`doc/`](doc/)。

#### 长期记忆：常驻上下文的「你」

与笔记平行的另一条线是**长期记忆**：`memory_save` / `memory_search` / `memory_list` 三个工具，让模型把用户的偏好、习惯、做过的重要决定沉淀成可检索的记忆卡片，并在后续对话里主动 recall。与知识笔记的分工是一条硬线——**记忆管「用户与当下」，常驻上下文、自动 recall；笔记管「世界与结论」，按需检索、可 git 管理**。会话本身也以 JSONL 落盘，三样合起来，就是「这个 Agent 越用越懂你」的全部机制。

### 数据自动拉取：零 token 的常驻数据面

行情、汇率、仓库 star、CI 队列……这类「每隔一段时间取一段数据、抽出几个字段、显示或提醒」的需求是纯机械的，不该每次烧一次模型。Kalo 为此做了两条机制，都遵循「文件即状态」：

- **Feeds：声明式的周期性拉取**。一个数据源就是一个文件：URL + 秒级周期 + 四种字段抽取（JSON 路径 / 正则 / 分隔符 / 常量）+ 呈现位置（顶栏跑马灯 / 卡片 / 告警 / 落知识库）。刻意**不含求值器**——配置会由模型生成，一个能 `eval` 的字段等于给模型开了任意代码执行入口，而 90% 的真实数据源用这四种就够。失败是常态：指数退避、连续失败转静默并打 stale 标记，顶栏不会因为一个源挂了变红。默认带 A 股大盘（每 20s）和美元人民币（每 120s）。
- **定时任务：cron 驱动的两类活**。`watch`（跑本地脚本，输出非空才告警，零 token）和 `agent`（到点起无头会话）。默认自带的「宏观快照每日落盘」就是 `watch`：工作日 17:12 追加一条快照，多数源失败（stdout 非空）才推飞书。
- **结果谁都能读**。拉到的值写进本地快照文件，顶栏、飞书推送、模型读取共用同一份；网关重启后顶栏立刻有值（带 stale 标记）而不是空白。

### 演化：用 Agent 做程序搜索

「演化」面板要解决的问题很具体：**程序搜索**（program search）—— 你有一个可以打分的任务，但不知道最好的程序长什么样，于是让机器在"程序空间"里搜。

这和平常用 Agent 写代码是两回事。平常是"你说清要什么、它写一版、你验收"，一次对话结束；程序搜索是"你只说清怎么打分，剩下交给几十上百轮的搜索"：

```
FUTS 树搜索选一个节点 → 编码 Agent 在它基础上改程序 → 跑你的评测拿分 → 分数回传更新树 → 再选节点…
```

模型在这里不是"作者"，而是**搜索算子**：树负责决定往哪个方向探，模型负责把这一步真的写出来，评测脚本是唯一裁判。适合的活是那种"跑很久才有结果、人盯不住"的：调 kernel、抠 prompt、优化启发式、刷一个有明确指标的 benchmark。

搜索器本身用的是 [era-evolve](https://github.com/kirie123/era-evolve)，Kalo 这边做的是让它变成一件人能真正用起来的事：

- **前提物料由一次普通会话造出来**，不是让模型去填表单。难点从来不是 `--budget 20` 填几，而是你手上没有能跑的 seed 目录、没有 `eval.py`。所以「新建实验」起的是一次正常的 kalo 会话（由 `era-experiment-designer` 技能驱动），产出是磁盘上真实的文件——`seed/**` 加一份 `era-run.json` 运行规格；你能看见评分脚本是怎么写出来的，不满意就接着聊。规格本身小到可以手写，向导是便利，不是前置条件。
- **不可跳过的验证闸门**。开始演化前，面板亲自把评测在**未改动的 seed** 上跑一遍，把基线分、`eval.py` 全文、保护清单摆给你看。整个演化的价值都建立在这个评分契约可信之上，所以它必须过人眼。
- **它就是一条普通后台任务**。`era serve` 交给已有的 job runtime detached 拉起，于是全是白捡的：关掉 app 实验照跑、gateway 重启不杀进程、`job_list` / `job_kill` 与飞书 `/status` `/stop` 自动生效、跑完自动推手机。
- **实时可视化与调试**。面板增量读 era 自己的 `trace.jsonl`（append-only、逐条 flush），前端折叠成搜索树：看树怎么长、分数曲线怎么走、点开任一节点看它改了什么、诊断为什么某条分支死了。中途被硬杀也不丢数据，标记为「已中断」照样能重建。
- **领域词汇被关在一个目录里**。era 的树、`c_puct`、selection gap 这些概念只出现在 [`kalo-desktop/src/features/era/`](kalo-desktop/src/features/era/)，harness / gateway / Rust 侧零 era 词汇——整个目录删掉不影响任何其他功能。

想直接看效果，见上面的[试一下「演化」](#3-试一下演化)。

## 仓库结构

- [`kalo-desktop/`](kalo-desktop/) — 桌面端（Tauri v2 + React 18 + Tailwind）
- [`kalo-desktop/gateway/`](kalo-desktop/gateway/) — `kalo-gateway` sidecar：IM 网关 + 定时任务调度 + 长跑任务后端
- [`kalo-harness/`](kalo-harness/) — [pi agent](https://github.com/earendil-works/pi) 引擎源码（含 Kalo 定制内置扩展）
- [`internal-skills/`](internal-skills/) — 随安装包分发的内置技能（纯 markdown，装进用户技能目录）
- [`scripts/`](scripts/) — 引擎 / 网关 sidecar 的构建脚本

## 功能

**对话与界面**

- 会话流式输出、工具调用折叠展示、edit 行级 diff 渲染
- 多项目管理 + 历史会话恢复（分段加载）
- 引擎池：多会话并发跑，切走的会话继续在后台执行，侧边栏用 spinner 标出进行中的会话
- 子 Agent 实时进度：步骤徽标 + 活动流，父会话里能看到子任务在干什么
- 一轮结束后的「改动文件」汇总卡片（文件列表 + 增删行数）
- 一键复制用户提问 / 整轮回复；Shift/Ctrl+滚轮缩放聊天区
- 附件：图片 / PDF / Excel / Word / PPT / 文本，支持拖拽与粘贴
- 输入框 `@` 唤起文件补全，LaTeX 公式渲染（KaTeX）
- 文件面板（目录树浏览 + 内容预览）、上下文占用圆环 + 一键压缩

**模型与工具**

- 模型可视化配置（自定义 provider / baseUrl / API Key，写入引擎的 models.json / auth.json），内置 DeepSeek / Anthropic / OpenAI / Gemini / Kimi / MiniMax / ZAI / Qwen / OpenRouter 等预设
- 本地 Ollama 预设（原生 `/api/chat` 适配，按 `num_ctx` 控制上下文，避免溢出）
- MCP 客户端（stdio），设置页管理 server，工具直接进入会话工具集
- `web_fetch` 抓网页、纯 TS 实现的 grep / glob（不依赖 rg / fd，离线可用）
- Skills：内置工作流 skills（[`internal-skills/`](internal-skills/)，随安装包分发）+ 用户自装 skills 可视化管理

**投资分析**

- 数据与判断分离：`market-data` 取数 CLI（宏观 / 财报 / 个股体检）零 token 自动攒历史，`macro-pulse` / `stock-checkup` / `filing-digest` 按需调模型（详见上文）
- 市场数据环境卡：真实将要执行的 Python 一屏看清，一键初始化（支持国内镜像）

**沉淀与演化**

- 知识笔记：本地纯 markdown 的三列工作面，域即目录、markdown 即真相、Agent 写入进待审阅队列、覆盖删除有 `.trash/` 兜底（详见上文）
- 长期记忆：`memory_save` / `memory_search` / `memory_list`，常驻上下文、主动 recall（详见上文）
- 演化实验（程序搜索）：接 [era-evolve](https://github.com/kirie123/era-evolve) 搜索器 —— 自然语言起实验 + 不可跳过的基线验证闸门 + 搜索树 / 分数曲线实时可视化（详见上文）

**数据与自动化**

- Feeds：声明式秒级拉取（一个源一个文件、四种字段抽取、无求值器），顶栏跑马灯，默认 A 股大盘 + 美元人民币（详见上文）
- IM 网关（飞书）：扫码配对，会话进度以单条持续编辑的消息推送到手机，可在 IM 侧 `/status`、`/stop` 等指令回控
- 定时任务：cron 驱动的 `watch`（本地脚本巡检，零 token）与 `agent`（到点起无头会话）两类任务，默认自带「宏观快照每日落盘」
- 长跑任务（Jobs）：`job_run` / `job_list` / `job_output` / `job_kill` 工具 + Jobs 中心面板；任务进程脱离网关独立存活，状态落盘，网关重启后自动核对

## 数据落盘

所有数据都在本地 `~/.kalo/` 下（下文路径均相对此目录），纯文件，可直接编辑与备份：

| 路径 | 内容 |
| --- | --- |
| `agent/sessions/` | 会话 JSONL |
| `agent/schedules.json` | 定时任务表 |
| `skills/` | 用户 skills + 装好的内置 skills |
| `skills/.internal-skills.json` | 内置 skill 的安装指纹（判断哪些被本地改过） |
| `memory/` | 长期记忆 |
| `knowledge/` | 知识笔记：每个目录一个域，`_types/` 描述域本身，`.trash/` 存覆盖与删除的副本 |
| `feeds/` | 声明式数据源：`<id>.json` 规格 + `state/` 最新快照 |
| `market/` | market-data 攒的历史（`daily.jsonl`）与 Python 环境入口 `py` |

没有数据库、没有隐藏格式：想搬走就整个目录拷走，想改就用任何编辑器改。

## 二次开发

- **内置 skill 在 [`internal-skills/<name>/SKILL.md`](internal-skills/)**，纯 markdown：改一句话就行，不用重建引擎、不用重编 Rust。App 启动时自动装好，没被本地改过的会跟着更新，改过的保留（设置页 → Skills 的「重装内置技能」可强制覆盖回来）
- 引擎内置扩展在 `kalo-harness/packages/coding-agent/src/extensions/<name>/`，写好后注册进同目录 `index.ts` 的 `builtInExtensions`；现有扩展可作模板：`memory`、`mcp`、`subagent`、`webfetch`、`kalo-jobs`、`skill`、`llama`
- 改完引擎需重建 exe 并同步到 `kalo-desktop/src-tauri/binaries/`（`bun run build:engine` 已包含这步）
- 前端按功能分目录：一个自成体系的功能放 `kalo-desktop/src/features/<name>/`（如 `era/`、`notes/`），领域词汇不外溢到通用层
- 仓库约定见 [AGENTS.md](AGENTS.md)：新功能先写设计文档到 `doc/` 再实现

## License

MIT（kalo-harness 沿用其上游 [pi](https://github.com/earendil-works/pi) 的 MIT 许可，见 kalo-harness/LICENSE）
