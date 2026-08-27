# Kalo Desktop 约定

`kalo-desktop/` 是 Tauri 桌面端：React（`src/`）+ Rust（`src-tauri/`）。引擎通过 sidecar 子进程通信。

## 分层

```
kalo-desktop/
├── src/                # React 前端
│   ├── components/     # 通用展示组件（无业务状态或仅本地 UI 状态）
│   ├── features/       # 业务特性模块（era/notes/onboarding 等）
│   ├── lib/            # 纯逻辑与桥接（pi-bridge、chat-store、schedule-spec...）
│   └── App.tsx / main.tsx
└── src-tauri/          # Rust 后端
    └── src/            # 一文件一职责：files/gateway/git/session/knowledge/memory/skills...
```

- **纯逻辑放 `src/lib/`**：解析、折叠、schedule-spec、file-kind、git 封装等不碰 Tauri IPC 的部分。
- **业务特性放 `src/features/`**：每个特性自包含（逻辑 + 测试）。
- **组件放 `src/components/`**：尽量无状态，只做展示与事件回调。
- **Rust 侧一文件一职责**：不要造大而全的 `utils.rs`/`common.rs`。

## 测试边界（关键）

- `vite.config.ts` 的 vitest 只收集 `src/**/*.test.ts`，环境为 node，**不覆盖 TSX 组件**。
- **可测的是纯逻辑**：折叠（fold）、spec 解析、gate 检查、attachments、schedule-spec、file-kind、docx、feed-view、git。
- **不可测 / 不要硬测**：任何走到 Tauri IPC（`invoke`）、DOM、Electron API 的路径——这不是测试死角，是隔离边界。需要时把 IPC 调用隔离到薄适配层，逻辑留在 lib 可测。
- 写/改/删测试前先确认被测对象属于纯逻辑层；组件行为用人工验证。

## 引擎通信契约

- 前端通过 `src/lib/pi-bridge.ts` 与引擎 sidecar 通信。
- 改动桥接协议（新增命令、改参数/返回结构）前：先写 `doc/YYYY-MM-DD-<主题>.md` 说明契约变化，并同步 `kalo-harness` 侧的扩展实现。
- 引擎 exe 重建后必须同步 `src-tauri/binaries/pi-x86_64-pc-windows-msvc.exe`（见根 AGENTS.md）。

## Rust 侧约定

- 每文件 `#[cfg(test)] mod tests` 就近放单测；`cargo test` 只跑 `src-tauri` 下的测试。
- 错误处理：返回 `Result<T, E>`，用户可见错误带可操作提示。
- 涉及路径/进程/权限的改动，默认按 Windows 行为评估。

## 检查命令

- 前端类型：`npx tsc --noEmit`（`src/` 下）
- 前端测试：`npm test`（vitest run）
- Rust：`cargo check` / `cargo test`（`src-tauri/` 下）
- 收尾：跑一次改动影响的检查即可；改 lib 跑 vitest，改 Rust 跑 cargo test，不要全量重复跑。
- 仓库级机器检查：根目录 `node scripts/check-changed.mjs`（自动按改动面选检查）

## 反模式清单（评审时逐条排除）

- ❌ 组件里硬编码业务逻辑（应放 lib 或 feature service）
- ❌ lib 里 import 了 Tauri IPC / DOM（纯逻辑层必须无副作用）
- ❌ 为“看起来有测试”而测：复述常量、mock 调用图、断言风格而非行为
- ❌ 新增大文件而不拆（>800 行是重构信号，机器检查会拦）
- ❌ 绕过 pi-bridge 直接散落 `invoke()`（契约漂移检查会拦）
- ❌ 写死裸色值/内联样式代替语义 token（如无 token 体系则至少用 CSS 变量）
- ❌ 把临时调试代码（console.log/println）随功能一起提交
- ❌ 错误处理吞掉错误或对用户不可见（用户可见错误需可操作提示）

## 评审问句（改完自查）

1. 这行代码属于它所在的那一层吗？（展示/业务/纯逻辑/桥接）
2. 如果换一个实现，测试能拦住这次回归吗？
3. 这个改动影响了引擎通信契约吗？（是 → 先写 doc）
4. 用户看得见这条错误/状态吗？提示可操作吗？
5. 有没有更小的拆分方式？（文件是不是该拆了）
