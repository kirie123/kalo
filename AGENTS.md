# Kalo 仓库约定

## 文档先行

- 所有新功能/重要改动，**先把设计文档写进 `doc/` 再动手实现**；改动涉及既有设计时同步更新对应文档。
- `doc/` 是本地知识沉淀目录，**不提交 git**（已在 .gitignore 中忽略）。
- 文档用中文，文件名格式：`doc/YYYY-MM-DD-<主题>.md`。

## 结构

- `kalo-desktop/`：Tauri 桌面端（React + Rust），引擎通过 sidecar 子进程通信
- `kalo-harness/`：vendored pi 引擎（改动需遵守 `kalo-harness/AGENTS.md`，如 `npm run check`、erasable TS、不擅自跑全量测试）
- `internal-skills/`：随安装包分发的内置 skill（纯 markdown，入库）
- `scripts/build-engine.sh`：重建引擎 sidecar exe
- `doc/`：本地设计文档（不入库）

## 引擎定制点

- 内置扩展：`kalo-harness/packages/coding-agent/src/extensions/<name>/`，注册进同目录 `index.ts` 的 `builtInExtensions`
- 重建 exe 后需同步到 `kalo-desktop/src-tauri/binaries/pi-x86_64-pc-windows-msvc.exe`

## 内置 skill

- 源码是 `internal-skills/<name>/SKILL.md`，**不要把 skill 正文写进 TS/Rust 常量**（历史上的 `kalo-skills` 扩展与 `include_str!` 已废弃）。
- 由 `kalo-desktop/src-tauri/src/internal_skills.rs` 在 App 启动时装到 `~/.kalo/skills/`：没被用户改过的跟着仓库更新，改过的保留。
- 加新 skill 只需建目录写 markdown，无需改代码或 `tauri.conf.json`。

## 分层路由（读最近的规范再动手）

- `kalo-desktop/src/*` → 先读 `kalo-desktop/AGENTS.md`（桌面端分层与测试边界）
- `kalo-desktop/src-tauri/*` → 先读 `kalo-desktop/AGENTS.md` 的 Rust 侧约定
- `kalo-harness/*` → 先读 `kalo-harness/AGENTS.md`（上游规范，改动受限）
- `internal-skills/*`、`doc/*` → 本文件即可

本文件是仓库级默认值；区域文件（如 `kalo-desktop/AGENTS.md`）优先。

## 硬规则

- **契约先行**：桌面端与引擎（sidecar）之间的通信契约、`internal-skills` 的安装行为，改动前先写/改设计文档再实现。
- **文件行数上限**：业务代码文件建议 ≤800 行（不含空行/注释）；超过是重构信号，先拆分再加逻辑。
- **测试纪律**：写/改/删测试前先看 `kalo-desktop/AGENTS.md` 的测试边界；纯逻辑（折叠/解析/gate 检查）必须可单测，够到 Tauri IPC 的部分要隔离。
- **提交规范**：`{feat,fix,docs,refactor,test,chore}(<scope>): <中文或英文描述>`，一次提交聚焦一件事。
- **Windows 是默认契约**：本产品是 Windows 桌面应用，所有改动默认评估 Windows 行为（路径、进程、可执行文件、权限），不能只按 POSIX 上下文写码。

## Self-Evolution（文档影响检查）

每次代码改动后，检查是否影响：模块职责、数据流、用户可见交互、公共 API/CLI 行为、运行时配置、校验命令、troubleshooting 路径。受影响则同步更新 `doc/` 对应文档。

沉淀经验用四元决策集：
- `discard`：一次性缺陷，不留
- `improve`：改进既有文档条目
- `merge`：合并进相关文档
- `create`：仅当模式可能复发且有真实证据

优先 improve/merge 而非 create 重复项；写文档前清除本地路径、客户名等敏感信息。任务结束时说明更新了哪些文档，或声明无文档影响。

## 常见检查

- 桌面端 TS：`kalo-desktop` 下 `npm run typecheck`（如存在）/ `npx tsc --noEmit`；测试 `npm test`（vitest）
- 桌面端 Rust：`cargo check` / `cargo test`（`src-tauri` 下）
- 引擎侧：一律走 `kalo-harness/AGENTS.md` 的 `npm run check`
- 改动收尾：跑一次受影响区域的检查即可，不重复跑全量

## 调试剧本（troubleshooting）

复现过两次以上的调试陷阱，沉淀到 `doc/troubleshooting/`（symptom → 原因 → 修复 → 验证）。一次性问题留在 git 历史即可。

## 冲突处理

多会话可能同时改此仓库。合并/变基/手工解冲突时：只解决自己改过的文件；`git add` 只加自己本次改动的文件，禁止 `git add -A` / `git add .`；不确定的文件中止并询问。
