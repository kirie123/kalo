# 启动后提示「引擎未响应」（解析到了其他平台的 sidecar 二进制）

## 症状

首次启动（或换平台后启动）应用，引擎完全没有回应：

- 新建对话发消息，没有任何流式输出
- 重命名会话弹出 toast：`引擎未响应，标题将直接写入会话文件`
- 控制台可能出现 `failed to spawn ...: Exec format error`，也可能只是进程秒退后
  什么都没有

**关键迷惑点**：不会报「找不到引擎」。路径解析是成功的。

## 快速排查

1. 看 staging 出来的二进制到底是什么平台的：

   ```bash
   file kalo-desktop/src-tauri/binaries/pi-*
   ```

   期望看到与当前系统匹配的格式。macOS arm64 应是 `Mach-O 64-bit executable arm64`；
   若只看到 `PE32+ executable ... for MS Windows`，说明本平台的引擎压根没构建过。

2. 确认当前平台该找的文件名（三元组由编译期 `TARGET` 决定）：

   ```bash
   bash -c 'source scripts/platform.sh && kalo_platform_init && echo "pi-$KALO_TRIPLE$KALO_EXE_SUFFIX"'
   ```

3. 确认 exec 位没丢：`ls -l kalo-desktop/src-tauri/binaries/pi-*`

## 根因

历史版本把 sidecar 文件名硬编码成 Windows 名字
（`const SIDECAR: &str = "pi-x86_64-pc-windows-msvc.exe"`），而查找逻辑只做
`p.is_file()` 检查。在 macOS/Linux 上那个 `.exe` **确实存在**于 `binaries/`
（Windows 构建 staging 的产物），于是：

- 路径解析成功 → 不会报「找不到引擎」
- `Command::spawn()` 拉起一个异构可执行文件 → `Exec format error` / 秒退
- 前端只观测到「引擎没回应」

症状与根因之间隔了一层，是这个坑难查的原因。

同一类失败还有第二条路径：文件平台正确，但从归档解压／跨文件系统拷贝时**丢了 exec 位**。

## 修复

已在 `kalo-desktop/src-tauri/src/sidecar.rs` 从根上消除：文件名带上编译期 target
triple（`<stem>-<target-triple><EXE_SUFFIX>`），异构二进制不再可能被匹配到；
并额外校验 exec 位，缺失时给出带 `chmod +x` 的可操作错误。

日常遇到时，构建本平台的 sidecar 即可：

```bash
bash scripts/build-engine.sh     # 默认宿主平台
bash scripts/build-gateway.sh
```

需要外部引擎时用 `KALO_PI_PATH` / `KALO_GATEWAY_PATH` 指过去。

**改代码时不要退回去**：`binaries/` 下的文件名必须由 `scripts/platform.sh` 的映射
推导，不要在 Rust 或构建脚本里写死某个平台的名字。CI 的 macOS job 会跑
`sidecar.rs` 的单测拦这类回归。

## 验证

```bash
file kalo-desktop/src-tauri/binaries/pi-aarch64-apple-darwin   # Mach-O，架构与本机一致
cd kalo-desktop/src-tauri && cargo test                        # sidecar.rs 单测
cd kalo-desktop && npm run tauri dev
```

界面上：新建对话能流式回复；重命名会话**不再**弹「引擎未响应」toast。

相关设计：[macOS 平台支持与 sidecar 命名契约](../2026-09-12-macos-平台支持.md)
