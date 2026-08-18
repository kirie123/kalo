# Kalo 仓库约定

## 文档先行

- 所有新功能/重要改动，**先把设计文档写进 `doc/` 再动手实现**；改动涉及既有设计时同步更新对应文档。
- `doc/` 是本地知识沉淀目录，**不提交 git**（已在 .gitignore 中忽略）。
- 文档用中文，文件名格式：`doc/YYYY-MM-DD-<主题>.md`。

## 结构

- `kalo-desktop/`：Tauri 桌面端（React + Rust），引擎通过 sidecar 子进程通信
- `kalo-harness/`：vendored pi 引擎（改动需遵守 `kalo-harness/AGENTS.md`，如 `npm run check`、erasable TS、不擅自跑全量测试）
- `scripts/build-engine.sh`：重建引擎 sidecar exe
- `doc/`：本地设计文档（不入库）

## 引擎定制点

- 内置扩展：`kalo-harness/packages/coding-agent/src/extensions/<name>/`，注册进同目录 `index.ts` 的 `builtInExtensions`
- 重建 exe 后需同步到 `kalo-desktop/src-tauri/binaries/pi-x86_64-pc-windows-msvc.exe`
