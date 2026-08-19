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
