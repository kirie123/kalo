# dev 窗口与已安装应用同时开着时，网关每秒重启一次（日志刷屏）

## 症状

`npm run tauri dev` 的窗口能开、UI 正常，但 `cargo run` 的控制台每秒一行：

```
[kalo] gateway exited (code Some(0)), restarting in 1s (attempt 1)
[kalo] gateway exited (code Some(0)), restarting in 1s (attempt 1)
...
```

`attempt` 永远是 1（不递增），`tasklist` 里网关进程 pid 不断变化。此时已安装的 Kalo
应用也开着（它自己的 `kalo-gateway-*.exe` 常驻）。

## 快速排查

1. `tasklist | grep -i kalo-gateway`：两个网关进程 = 已安装版 + dev 版各一个，基本命中本剧本。
2. `cat ~/.kalo/agent/feishu.lock`：里面的 pid 是不是**另一个** Kalo 的网关进程。
3. 手动跑一次网关，直接看它为什么退出：

   ```bash
   cd kalo-desktop/src-tauri/binaries
   sleep 5 | ./kalo-gateway-x86_64-pc-windows-msvc.exe 2>&1
   # → {"type":"error","message":"另一个 Kalo 网关实例正在运行（feishu.lock 被占用）"}
   ```

## 根因

三件事叠加：

1. `kalo-desktop/gateway/src/credentials.ts::acquireLock()` 用
   `~/.kalo/agent/feishu.lock`（内容 = 持锁进程 pid）做单实例互斥，第二个实例拿不到锁。
2. 被锁定的分支只发了一条错误消息就 `return`，而 **bun 在事件循环空时立刻退出**——
   进程以 exit code 0 结束（原注释写「stay alive (no exit loop)」，与实现不符）。
3. 桌面端 `gateway.rs::on_gateway_exit` 把任何退出都当崩溃重启，而 `ensure_spawned`
   每次成功 spawn 都会 `restart_attempts = 0`，于是永远停在「attempt 1」，1 秒一轮无上限。

连带后果：每次重启都把状态重置成 `starting`，那条「另一个实例正在运行」的错误在 UI 上
根本来不及显示 —— 就是诊断文档里那句「第二个窗口的网关功能会静默不可用」。

## 修复

`kalo-desktop/gateway/src/main.ts` 里被锁定的分支改成**保持存活**
（`holdLockedOut()`），三件事：

- 发一次错误消息：Rust 侧 `handle_gateway_line` 会把它缓存成 `error` 状态，UI 能看到原因；
- `stdin` 保持 resume 并排空：桌面端关窗口时仍可用管道 EOF 关掉它（`end` → `exit(0)`）；
- `setInterval` 每 3s 重试 `acquireLock()`，拿到锁就 `start()` 正常启动 —— 另一个实例退出后自动接管。

```ts
const LOCK_RETRY_MS = 3_000;

function main(): void {
  if (!acquireLock()) {
    holdLockedOut();
    return;
  }
  start();
}
```

## 验证

1. 保持已安装应用运行，再 `npm run tauri dev`：日志几秒内**安静**下来，不再刷 restarting。
2. `tasklist | grep -i kalo-gateway`：两个常驻进程（已安装的持锁 + dev 的在等接管），
   pid 不再变化。
3. 手动复现保活行为：

   ```bash
   cd kalo-desktop/gateway && (sleep 12 | bun src/main.ts > /tmp/gw.log 2>&1 &)
   sleep 6 && tasklist | grep -ci bun.exe   # → 1：没秒退
   cat /tmp/gw.log                          # → 那条 error
   ```

4. 「接管」一段未实测（要退出已安装应用才能验，而它正是当时会话所在的进程）；
   代码路径是 `acquireLock()` 成功即 `start()`，与被锁定前的启动完全相同。