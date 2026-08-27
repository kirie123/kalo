# cargo check 报 "另一个程序正在使用此文件"（os error 32）

## 症状

```bash
$ cargo check
...
cargo:rustc-env=TAURI_ENV_TARGET_TRIPLE=x86_64-pc-windows-msvc
另一个程序正在使用此文件，进程无法访问。 (os error 32)
```

exit code 101，但没有任何 `error[E...]` 编译错误。

## 快速排查

```bash
tasklist | grep -iE "kalo|gateway|pi-"   # 看是否有 kalo 相关进程在跑
```

## 根因

kalo 桌面应用正在运行（`kalo.exe` / `kalo-gateway` / 多个 `pi-x86_64-pc-windows-msvc.exe`），锁住了 `src-tauri/binaries/` 下的二进制文件。cargo 的 build script 需要重写这些文件，被 Windows 文件锁拦截。

## 修复

- 关闭正在运行的 kalo 应用（或至少停止 gateway/sidecar 进程）后重新 `cargo check`
- 若只是静态检查，可确认输出里没有 `error[E...]` 即源码无编译错误

## 验证

```bash
cargo check 2>&1 | grep -E "^error"   # 无 error 行
```
