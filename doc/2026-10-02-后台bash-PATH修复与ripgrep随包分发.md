# 后台 bash 的 PATH 修复与 ripgrep 随包分发

日期：2026-10-02
状态：设计定稿，随代码落地

## 0. 问题

来自《bash 工具耗时分析》（`2026-10-02-bash工具耗时分析.md`）的两个确定性缺陷：

1. **后台 job / 定时任务里 coreutils 找不到**：`tail / rm / ls / stat / tee` 全部 `command not found`，任务 exit 127。会话里实际连废三轮（bash-141/142/144），白耗若干轮与等待。
2. **全仓搜索慢**：system prompt 推荐 `rg`，但环境里没有（`~/.kalo/agent/bin` 只有 `fd.exe`）。搜索退化为 `grep -r` 全树扫描（含 135 个 node_modules、588 个 dist、.git），实测 20.4s（sys 19.3s，全是目录遍历）；`--exclude-dir` 剪枝后 3.4s，ripgrep（默认尊重 .gitignore）可到亚秒级。

## 1. 修复 A：后台 bash 继承可用的 PATH

### 1.1 根因

- gateway 的 `resolveBash()`（`kalo-desktop/gateway/src/scheduler.ts`）优先返回 `C:\Program Files\Git\usr\bin\bash.exe`（真 shell）。这是有意的：`Git\bin\bash.exe` 是 44KB wrapper，会再起真 shell 子进程，detached 任务里 `child.kill()` 杀不干净（见该函数注释）。
- 真 shell 直跑**不会**像 wrapper 那样把 `/usr/bin`、`/mingw64/bin` 注入 PATH。当 gateway 进程的 PATH 没有 Git 目录（应用从资源管理器启动的常见情形）时，coreutils 全部找不到。
- 前台 bash 工具不受影响：harness 的 `getShellConfig()` 优先 wrapper。

### 1.2 方案

在 `scheduler.ts` 新增并导出：

- `prependShellDir(env, shell)`：纯函数。`shell` 是绝对路径时，把它所在的目录前置到 `env` 的 PATH；大小写不敏感地找已有键（Windows 常见 `Path`），没有才用 `PATH`；`shell` 非绝对路径时原样返回。
- `bashSpawnEnv(extra?)`：把 `extra` 合并到 `process.env`（`extra` 优先）**之后**再调 `prependShellDir`，保证作业自带的 PATH（来自引擎的 `getShellEnv()`）不会把修复顶掉。

三处 spawn 统一改用 `bashSpawnEnv`：

| 调用点 | 说明 |
|---|---|
| `jobs/gateway-backend.ts::launch` | 所有 `run_in_background` job；`env: bashSpawnEnv(rec.env)` |
| `jobs/gateway-backend.ts::runProbe` | job 健康探针；`env: bashSpawnEnv()` |
| `scheduler.ts::runWatch` | 定时任务；`env: bashSpawnEnv()` |

### 1.3 边界

- Windows 的 PATH 键可能是 `Path`；按已有键更新，避免同一 env 里出现两个大小写不同的 PATH 键。
- mac / linux：`resolveBash()` 返回 `"bash"`（非绝对路径）→ 不做任何事，行为不变。

## 2. 修复 B：ripgrep 随包分发

### 2.1 目标

发布包在 Windows / macOS 自带 `rg`，安装到 `~/.kalo/agent/bin/rg[.exe]`：离线可用、构建可重复、版本可升级、用户或引擎自己替换过的 `rg` 不被覆盖。

### 2.2 抓取与 staging（构建期）

新脚本 `scripts/fetch-ripgrep.mjs`：

- `--platform` 默认宿主平台，映射与 `scripts/platform.sh` 的六个平台一致：

| 平台 | 资产 | SHA256 |
|---|---|---|
| windows-x64 | `ripgrep-15.2.0-x86_64-pc-windows-msvc.zip` | `71b2fef8…aafc5` |
| windows-arm64 | `ripgrep-15.2.0-aarch64-pc-windows-msvc.zip` | `e4abca10…5360f` |
| darwin-arm64 | `ripgrep-15.2.0-aarch64-apple-darwin.tar.gz` | `3750b2e9…973e4` |
| darwin-x64 | `ripgrep-15.2.0-x86_64-apple-darwin.tar.gz` | `af7825fc…231c1` |
| linux-x64 | `ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz` | `33e15bcf…b149c` |
| linux-arm64 | `ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz` | `800b1e72…40915` |

（表中 SHA256 略写，完整值硬编码在脚本里；版本固定 `15.2.0`。Linux 用 musl 静态构建，兼容老发行版。）

- 产物 staging 到 `kalo-desktop/src-tauri/binaries/rg-<target-triple>[.exe]`（与 sidecar 同一命名体系），并写 `.rg-<target-triple>.stamp`（内容为固定版本）。
- 已有产物且 stamp 版本一致时跳过，离线可重复构建；`--force` 重取。
- 解压：`.tar.gz` 用 `tar xf`；`.zip` Windows 优先 `%SystemRoot%\System32\tar.exe`（bsdtar 支持 zip），失败退 PowerShell `Expand-Archive`；unix 用 `unzip` 再退 `tar xf`。随后递归定位 `rg[.exe]`，写 `chmod 755`（unix）。
- 逃生口：`KALO_RG_FROM=<本地压缩包>` 供离线/内网；`KALO_SKIP_RG=1` 显式跳过并告警；`--check` 只查状态不做网络请求。
- `scripts/ensure-engine.mjs` 在 sidecar staging 之后调用该脚本（dev 与 `bun run build` 都覆盖）。抓取失败且没有本地兜底时构建失败并给出可操作提示。

### 2.3 打包（tauri resources）

- `kalo-desktop/src-tauri/tauri.windows.conf.json`：新增 `binaries/rg-x86_64-pc-windows-msvc.exe`（与现有 x64 sidecar 条目一致；Windows arm64 打包本就不支持）。
- `kalo-desktop/src-tauri/tauri.macos.conf.json`：新增 glob `binaries/rg-*-apple-darwin → binaries/`（与 pi 的 glob 同款）。
- Linux：当前没有 `tauri.linux.conf.json`，打包落地时补同款 glob `binaries/rg-*`（抓取/安装/运行链路已按平台中立实现）。

### 2.4 安装（启动期，Rust）

新模块 `kalo-desktop/src-tauri/src/bundled_tools.rs`：

- 源：`binaries/rg-<triple><suffix>`，查找顺序 = `KALO_BUNDLED_RG` 覆盖 → `resources::dir()/binaries` → exe 同级 `binaries/` →（debug）仓库 `src-tauri/binaries/`。
- 目标：`~/.kalo/agent/bin/rg[.exe]`（即引擎的 `getBinDir()`；`USERPROFILE` 回退 `HOME`）。写后 POSIX `chmod 755`。
- 更新语义复用 `internal_skills.rs` 的指纹模式：`~/.kalo/agent/bin/.kalo-bundled-tools.json` 记录「上次由我们写入的内容指纹」（FNV-1a，复用 `internal_skills::fingerprint`）：
  - 目标不存在 → 安装；
  - 目标指纹 == 清单指纹（是我们写的、没被动过）且与 bundle 不同 → 升级；
  - 目标指纹 == bundle 指纹 → 只补清单；
  - 目标指纹不匹配（用户/引擎 `ensureTool` 自己装的）→ 跳过；
  - `force` → 覆盖。
- `main.rs` 的 `setup()` 里紧跟 `internal_skills::install(false)` 调用，成功/失败只打日志，不阻塞启动。
- 效果：`rg` 进入引擎 bash 的 PATH（`getShellEnv()` 前置 `~/.kalo/agent/bin`）与 pi 的 `getToolPath("rg")`（TOOLS_DIR 同目录），prompt 里的 `ls, rg, find` 变成真的。

### 2.5 macOS / Linux 注意点

- 命名与可执行位、home 解析已按双平台实现（`EXE_SUFFIX`、`#[cfg(unix)] chmod`）。
- macOS：二进制落在 `Kalo.app/Contents/Resources/binaries/` 并由启动期复制到用户目录；当前 `.app` 未签名未公证，不引入新问题；未来接签名/公证时需把这枚二进制一并签（见打包文档）。
- Linux：无打包配置，但 fetch 脚本的资产映射、安装器的命名与权限逻辑都已覆盖 linux-x64 / linux-arm64。

## 3. 影响面

- gateway：job / 定时任务 / 探针的 spawn env 变化；不涉及 NDJSON、HTTP 或 UI 契约。
- desktop：新增启动期安装步骤与打包资源；无前端改动。
- 引擎：零改动；`rg` 经 PATH / TOOLS_DIR 被 bash 与工具层使用。
- 文档：本文件；`doc/README.md` 索引新增条目。

## 4. 测试与验证

- gateway（`bun test` + `bun run typecheck`）：`prependShellDir` 的 PATH 前置、键大小写、非绝对 shell 不变；`bashSpawnEnv(extra)` 在合并 `extra` 后 shell 目录仍在最前。
- 脚本：`node scripts/fetch-ripgrep.mjs --platform windows-x64` 抓取并执行 staged 二进制的 `--version`；`KALO_RG_FROM=<tar.gz>` 验证 tar 分支；重复执行与 `--check` 验证跳过逻辑。
- Rust（`cargo test`）：`bundled_tools` 的首次安装、升级、保留用户改动、force、源优先级、命名与权限。
- 端到端（手工）：打包后确认安装包内 `binaries/rg-*`；启动应用后 `~/.kalo/agent/bin/rg --version`；在后台 job 里 `command -v tail && command -v rg` 均有路径。

## 5. 非目标

- 不改「用真 shell」的既有决策（保留 detached 任务的 kill 语义）。
- 不做运行时下载兜底（引擎的 `ensureTool` 仍在；随包分发是离线保证）。
- P2（并行工具结果完成即发）不在本次范围。
## 6. 实现备注（落地后的补充）

- 解压命令一律在临时工作目录内用相对路径调用：Git-for-Windows 的 GNU tar 会把 `C:/...` 误判为 rsh 的 `host:path`（"Cannot connect to C:"），相对路径直接绕开；`.tar.gz` 用 `tar xzf`。
- 二进制命名与查找直接复用 `sidecar::resolve`（`rg-<target-triple>`，triple 来自 build.rs 的 `KALO_TARGET_TRIPLE`），与 sidecar 同源命名，不会漂移；`not_found` 提示已指向 `scripts/fetch-ripgrep.mjs`。
- `ensure-engine.mjs` 对 fetch 失败是硬失败（打印 `KALO_RG_FROM` / `KALO_SKIP_RG` 逃生提示），保证发布包不会静默缺 rg。
- 除上述外无偏差：六平台 pin、stamp 跳过、启动期指纹清单安装、force 覆盖语义均按设计实现。
