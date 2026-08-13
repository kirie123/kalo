# Kalo

基于 [pi](../kalo-harness) 引擎（`pi --mode rpc`，NDJSON over stdin/stdout）的 Tauri v2 桌面端。

## 结构

- `src/` — React 18 + TS + Tailwind 前端（Codex 风格 UI，明暗双主题）
- `src-tauri/` — Rust 后端：每会话 spawn 一个 `pi --mode rpc` 子进程，stdout NDJSON 经 Tauri event 转发前端
- `src-tauri/binaries/` — pi 引擎可执行文件与运行时资源（构建产物，不进 git）

## 开发

```bash
npm install
npm run tauri dev
```

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

- commands: `create_session{cwd}` / `send_command{sessionId,command}` / `close_session{sessionId}` / `list_sessions{}` / `read_models_config` / `write_models_config` / `read_auth_config` / `write_auth_config` / `read_session_page{path,before?,limit?}` / `list_skills{cwd?}` / `read_skill` / `write_skill` / `create_skill` / `delete_skill` / `list_dir` / `read_file_text` / `read_attachment`
- events: `pi-event:{sessionId}`（引擎 stdout JSON）、`pi-stderr:{sessionId}`、`pi-exit:{sessionId}`
