# 改完前端行为没变化（跑的是已安装版，不是 dev 窗口）

## 症状

刚提交的前端改动，在用户界面上看不到。实例（2026-10-11）：`ProviderEditModal` 已经改成「点遮罩不关窗」
并推送，用户复验仍是「点空白就消失」——他点的是已安装的发行包，修复根本没进去。

## 快速排查

1. 确认正在跑的是哪个构建：

   ```powershell
   powershell -NoProfile -Command "Get-Process kalo | Select-Object -ExpandProperty Path"
   ```

   - `…\src-tauri\target\debug\kalo.exe` → dev 窗口（vite HMR，改前端即时生效）
   - `C:\Users\<name>\AppData\Local\Kalo\kalo.exe` → 已安装的发行包（不含未发布的改动）
2. dev server 在不在：`netstat -ano | findstr 1420`。只有 `TIME_WAIT` 说明 1420 是历史连接，
   当前没有 dev server 在跑。
3. 如果 dev 窗口里也没变，看另两篇：运行时 sidecar 拷贝没更新
   （`sidecar-rebuild-not-picked-up-in-dev.md`）、旧进程锁住二进制导致重编译没真正替换
   （`cargo-file-locked-os-error-32.md`）。

## 根因

桌面端有两种跑法，改代码只改了仓库：

- **dev**：`cd kalo-desktop && npm run tauri dev`，前端走 vite 1420，Rust 走 `target/debug`；
- **发行包**：`bun run build` 出 NSIS 安装器 → 安装到 `%LOCALAPPDATA%\Kalo\`，前端资源与 exe 都在包里，
  必须重新出包并再装一次才会更新。

## 修复

- 复验 UI 改动优先用 dev 窗口；dev 与已安装版并存已由 `b1d6f66` 修好（网关单实例锁保活 + 轮询接管）。
- 需要在日常使用的已安装版里看到，就跑 `bun run build` 重新出包后手动再装一次。

## 验证

给出修复后，先确认对方点的是哪个窗口（或让他 `Get-Process kalo` 报路径），再让他复验；
别在「逻辑是不是写错了」上绕——先排除构建不对。