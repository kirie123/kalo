# Kalo

基于 [pi agent](https://github.com/earendil-works/pi) 引擎（`pi --mode rpc`，NDJSON over stdin/stdout）的 Tauri v2 桌面端。

## 结构

- `src/` — React 18 + TS + Tailwind 前端（Codex 风格 UI，明暗双主题）
- `src-tauri/` — Rust 后端：每会话 spawn 一个 `pi --mode rpc` 子进程，stdout NDJSON 经 Tauri event 转发前端
- `gateway/` — IM 网关 sidecar 源码（飞书连接 + 进度推送 + 定时任务调度）
- `src-tauri/binaries/` — pi 引擎与网关的可执行文件、运行时资源（构建产物，不进 git）

## 开发

```bash
npm install
npm run tauri dev
```

## IM 网关（飞书）

设置 →「IM 网关」扫码连接飞书（自动创建自建应用并绑定扫码者），此后每个会话的进度
会以单条持续编辑的消息推送到手机。网关是独立的 `kalo-gateway` sidecar，与 Rust 后端
之间走 NDJSON over stdio（与 pi 引擎同构）。

重新构建网关：

```bash
cd gateway && bun install && bun run build   # 产出 ../src-tauri/binaries/kalo-gateway-x86_64-pc-windows-msvc.exe
```

也可用 `KALO_GATEWAY_PATH=/path/to/kalo-gateway.exe` 指向外部网关。

## 定时任务（Scheduler）

设置 →「任务」管理 cron 任务，任务表存于 `~/.kalo/agent/schedules.json`，由网关进程驱动：

- **watch**：本地执行 bash 片段，输出非空即推送告警。零 token，适合高频巡检。硬超时 60s，
  `cooldownMin` 控制告警后冷却。
- **agent**：到点起一个无头 pi 会话执行 prompt，进度复用飞书推送链路。

示例任务（roadmap §4.5 出厂建议）：

| 场景 | 类型 | cron | 配置要点 |
|---|---|---|---|
| 训练监控 | watch | `*/10 * * * *` | script: `tail -n 50 train.log \| grep -E 'NaN\|CUDA out of memory' ; pgrep -f trainer.py >/dev/null \|\| echo PROCESS_EXITED`，冷却 30min |
| 训练日报 | agent | `0 22 * * *` | prompt: 「盘点 checkpoints/ 目录，总结本周期 loss 趋势，一屏内汇报」 |
| 投资晨报 | agent | `0 9 * * 1-5` | prompt: 拉行情并点评（P1 接 MCP 数据源前先用本地脚本产物） |
| 数学题日推 | agent | `0 20 * * *` | prompt: 「出一道自选主题的探索题并给出提示」 |

注意：watch 脚本在 Windows 上经 Git Bash 执行；网关进程随 App 退出而停止（退出期间不触发）。

## 知识库（Knowledge）

设置 →「知识库」浏览/搜索/编辑 `~/.kalo/knowledge/` 下的 markdown 经验卡
（cards / training-notes / investing / math 四个域）。首次启动会安装 `knowledge`
starter skill（`~/.kalo/skills/knowledge/SKILL.md`）：对话中产生可复用结论时 agent 会
主动建议存卡，用户确认后写入并维护 INDEX.md；任何会话可让其 `search` 检索知识库。

## 重新构建引擎（pi.exe）

```bash
cd ../kalo-harness
npm ci --ignore-scripts
npm run build            # 或 npm run build:offline
bash scripts/build-binaries.sh --platform windows-x64 --skip-install --skip-build --offline-model-data
# 拷贝到 sidecar 目录（exe 需按 Tauri 三元组命名）
SRC=packages/coding-agent/binaries/windows-x64
DST=../kalo-desktop/src-tauri/binaries
mkdir -p "$DST" && cd "$SRC"
cp -r pi.exe photon_rs_bg.wasm package.json theme assets export-html native node_modules "$DST/"
mv "$DST/pi.exe" "$DST/pi-x86_64-pc-windows-msvc.exe"
```

也可用 `KALO_PI_PATH=/path/to/pi.exe` 指向外部引擎（此时引擎自带的资源需与 exe 同目录）。

## 打包

```bash
npm run tauri build   # 产出 src-tauri/target/release/bundle/nsis/ 安装包
```

## IPC 契约

- commands: `create_session{cwd}` / `send_command{sessionId,command}` / `close_session{sessionId}` / `list_sessions{}` / `read_models_config` / `write_models_config` / `read_auth_config` / `write_auth_config` / `read_session_page{path,before?,limit?}` / `list_skills{cwd?}` / `read_skill` / `write_skill` / `create_skill` / `delete_skill` / `list_dir` / `read_file_text` / `read_attachment` / `gateway_pair_start` / `gateway_pair_cancel` / `gateway_status` / `gateway_unbind` / `schedule_upsert{task}` / `schedule_remove{id}` / `schedule_run{id}` / `schedule_list{}` / `list_knowledge_cards{}` / `read_knowledge_card{relPath}` / `write_knowledge_card{relPath?,domain,title,content}` / `delete_knowledge_card{relPath}`
- events: `pi-event:{sessionId}`（引擎 stdout JSON）、`pi-stderr:{sessionId}`、`pi-exit:{sessionId}`、`gateway-status`（网关状态/扫码二维码）、`schedule-status`（任务表快照）、`schedule-error`（任务校验错误）
