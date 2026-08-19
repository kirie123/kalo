# Kalo

AI coding agent 桌面客户端：Tauri v2 + React 界面，Codex 风格 UI（明暗双主题）。

> Kalo 基于 [pi](https://github.com/earendil-works/pi) agent 引擎构建——桌面端通过子进程驱动 `pi --mode rpc`，使用其 NDJSON RPC 协议通信。`kalo-harness/` 是 pi 的 vendored 源码（MIT）。

## 为什么做 Kalo

**构建一个属于你自己的桌面端 Agent。**

市面上的 Agent 客户端层出不穷，但都是别人的产品：界面改不了、数据在别人手里、能力边界由厂商划定。Kalo 想做的是另一件事——一个你可以完全拥有、自由改造的个人 Agent 桌面端：

- **用于个人学习**：随时追问、让 Agent 带你读代码、读文档，把"查资料"变成"对话式探索"
- **用于工作开发**：接入自己的模型或中转服务，跑在你自己的项目目录里，工具调用、diff、上下文占用全都看得见
- **用于沉淀知识**：所有会话以 JSONL 落盘在本地，可回溯、可检索、可二次加工，长期使用下来就是你自己的知识库

引擎与界面解耦（pi 引擎 + NDJSON RPC 协议）：你可以换引擎、改界面、加能力，把它打磨成你想要的样子。这也是 Kalo 开源的原因——欢迎 fork，做出属于你自己的 Agent。

## 仓库结构

- [`kalo-desktop/`](kalo-desktop/) — 桌面端（Tauri v2 + React 18 + Tailwind）
- [`kalo-desktop/gateway/`](kalo-desktop/gateway/) — `kalo-gateway` sidecar：IM 网关 + 定时任务调度 + 长跑任务后端
- [`kalo-harness/`](kalo-harness/) — [pi agent](https://github.com/earendil-works/pi) 引擎源码（含 Kalo 定制内置扩展）
- [`internal-skills/`](internal-skills/) — 随安装包分发的内置技能（纯 markdown，装到 `~/.kalo/skills/`）
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
- Skills：内置工作流 skills（[`internal-skills/`](internal-skills/)，随安装包分发）+ 用户 skills（`~/.kalo/skills/`）可视化管理
- 长期记忆：`memory_save` / `memory_search` / `memory_list`，落盘 `~/.kalo/memory/`

**自动化**

- IM 网关（飞书）：扫码配对，会话进度以单条持续编辑的消息推送到手机，可在 IM 侧 `/status`、`/stop` 等指令回控
- 定时任务：cron 驱动的 `watch`（本地脚本巡检，零 token）与 `agent`（到点起无头会话）两类任务
- 长跑任务（Jobs）：`job_run` / `job_list` / `job_output` / `job_kill` 工具 + Jobs 中心面板；任务进程脱离网关独立存活，状态落盘，网关重启后自动核对
- 知识库：`~/.kalo/knowledge/` 下的 markdown 经验卡，浏览 / 搜索 / 编辑，agent 可主动建议存卡并检索
- 演化实验面板：把 era 这类程序演化搜索器当作一条普通后台任务跑起来，实时看搜索树生长、分数曲线与最优程序

## 快速开始

```bash
# 首次：安装依赖并构建引擎
bun run setup

# 调试启动（vite + tauri dev）
bun run dev

# 构建 Windows 安装包（NSIS，输出在 kalo-desktop/src-tauri/target/release/bundle/）
bun run build

# 仅重新构建引擎 exe（kalo-harness → kalo-desktop/src-tauri/binaries/）
bun run build:engine

# 仅重新构建网关 sidecar（kalo-desktop/gateway → kalo-desktop/src-tauri/binaries/）
bash scripts/build-gateway.sh
```

> 需要 [Bun](https://bun.sh)、Node ≥ 22 与 Rust 工具链（MSVC）。各子目录也可用 npm 单独操作，详见 [kalo-desktop/README.md](kalo-desktop/README.md)。

## 数据落盘

所有数据都在本地 `~/.kalo/` 下，纯文件，可直接编辑与备份：

| 路径 | 内容 |
| --- | --- |
| `~/.kalo/agent/sessions/` | 会话 JSONL |
| `~/.kalo/agent/schedules.json` | 定时任务表 |
| `~/.kalo/skills/` | 用户 skills + 装好的内置 skills |
| `~/.kalo/skills/.internal-skills.json` | 内置 skill 的安装指纹（判断哪些被本地改过） |
| `~/.kalo/memory/` | 长期记忆 |
| `~/.kalo/knowledge/` | 知识卡片 |

## 二次开发

- **内置 skill 在 [`internal-skills/<name>/SKILL.md`](internal-skills/)**，纯 markdown：改一句话就行，不用重建引擎、不用重编 Rust。App 启动时装到 `~/.kalo/skills/`，没被本地改过的会跟着更新，改过的保留（设置页 → Skills 的「重装内置技能」可强制覆盖回来）
- 引擎内置扩展在 `kalo-harness/packages/coding-agent/src/extensions/<name>/`，写好后注册进同目录 `index.ts` 的 `builtInExtensions`；现有扩展可作模板：`memory`、`mcp`、`subagent`、`webfetch`、`kalo-jobs`、`skill`、`llama`
- 改完引擎需重建 exe 并同步到 `kalo-desktop/src-tauri/binaries/`（`bun run build:engine` 已包含这步）
- 仓库约定见 [AGENTS.md](AGENTS.md)：新功能先写设计文档到 `doc/` 再实现

## License

MIT（kalo-harness 沿用其上游 [pi](https://github.com/earendil-works/pi) 的 MIT 许可，见 kalo-harness/LICENSE）
