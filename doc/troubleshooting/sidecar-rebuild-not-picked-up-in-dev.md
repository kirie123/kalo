# 重建了 sidecar（pi / 网关）但正在运行的 dev 窗口行为没变

## 症状

改了 `kalo-desktop/gateway/`（或引擎）源码，`bash scripts/build-gateway.sh` /
`build-engine.sh` 也成功 staging 到 `kalo-desktop/src-tauri/binaries/`，但**已经开着**的
dev 窗口行为照旧（网关还是老逻辑、引擎还是老行为）。只有重启 dev 窗口才生效。

## 快速排查

对比两份 sidecar 的 mtime，后者更旧就是命中：

```bash
ls -la kalo-desktop/src-tauri/binaries/kalo-gateway-x86_64-pc-windows-msvc.exe
ls -la kalo-desktop/src-tauri/target/debug/binaries/kalo-gateway-x86_64-pc-windows-msvc.exe
```

## 根因

`src-tauri/binaries/` 只是「构建输入 + staging 落点」；**运行时真正执行的是
`target/<profile>/binaries/` 那份拷贝**：

- Tauri 构建时按 `tauri.conf.json` 的 `externalBin` 把 sidecar 拷进 `target/<profile>/binaries/`；
- dev 下 `path().resource_dir()` 就是 `target/<profile>`，`sidecar.rs::resolve_in` 查找顺序的
  第 2 条 `<resource_dir>/binaries/<name>` 因此先命中它，第 4 条 `src-tauri/binaries/`（debug
  专用兜底）轮不到。

拷贝只发生在 cargo/tauri 构建时。只重建 sidecar（Rust 侧无改动）不触发构建，那份拷贝就是旧的。
同理适用于 `pi-*.exe`。

## 修复

手工同步一份（Windows 示例）：

```bash
cp kalo-desktop/src-tauri/binaries/kalo-gateway-x86_64-pc-windows-msvc.exe \
   kalo-desktop/src-tauri/target/debug/binaries/
```

或直接重启 dev 窗口（构建会重新拷贝）。

注意：只会影响 sidecar **下一次被 spawn** 时用的文件；已经在跑的旧副本进程不会被替换
（想让网关立刻换新，就得让桌面端重启它，例如上一条剧本里的重启风暴场景）。

## 验证

1. `target/debug/binaries/` 里的 mtime 等于刚 staging 的那份。
2. 行为跟上新逻辑，或 `tasklist` 里 sidecar 进程的 pid/启动时间变化。

## 本次（2026-10-10）的实际用法

为验证网关保活修复：`build-gateway.sh` 之后把新二进制拷进 `target/debug/binaries/`，
dev 窗口（无 Rust 改动、不重启）在 1 秒内用新网关重试成功，日志随即安静 —— 这条路径也顺带
证明了修复生效。